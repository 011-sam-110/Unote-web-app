// Image bytes inserted while offline, and the strict order in which they are let go of.
//
// An offline note that cannot take a screenshot is not offline, so the bytes go
// somewhere local and the note points at them. The reference written into the note's
// content is `local-blob:<id>` - a stable string, deliberately NOT an object URL,
// because an object URL is dead the moment the tab reloads and the note would then
// carry a permanently broken image.
//
// THE ORDERING IS THE WHOLE POINT OF THIS FILE. On reconnect:
//
//   1. the bytes are uploaded, and the server's URL is recorded on the blob row;
//   2. the note's content JSON is rewritten from `local-blob:<id>` to that URL, and
//      that rewrite goes through the OUTBOX as an ordinary note update - not a
//      side-channel write, because the whole point is that the SERVER ends up holding
//      a note that points at the server's own copy of the image;
//   3. the blob row is dropped, and ONLY once that rewrite has been confirmed.
//
// Dropping on upload success - which is the obvious place, and wrong - leaves a note
// whose content still says `local-blob:<id>` and a store with no such blob. The image
// renders as nothing, on this device, permanently, and no error is raised anywhere.
//
// "Confirmed" has an exact meaning here: the local content no longer mentions the
// reference AND no note update for that note is still sitting in the outbox. The
// outbox empties only on a settled push, so that pair is the same statement as "the
// server has the rewritten note".
import { localDb, type LocalDb } from './db';
import { correctedNow } from './clock';
import { newLocalId } from './records';
import type { LocalBlob } from './records';

const REF_PREFIX = 'local-blob:';

/** The string written into a note's content while the bytes are still only here. */
export function blobRef(id: string): string {
  return `${REF_PREFIX}${id}`;
}

export function isBlobRef(src: string): boolean {
  return src.startsWith(REF_PREFIX);
}

export function blobIdFromRef(src: string): string {
  return src.slice(REF_PREFIX.length);
}

/**
 * Take the bytes. Returns the reference to write into the note.
 *
 * `noteId` is null: the editor uploads an image before it is placed, so the note it
 * lands in is not known yet - the server's own /api/import/image files the attachment
 * with note_id NULL for exactly the same reason. The owning note is worked out at
 * rewrite time by finding whose content carries the reference, which also happens to
 * be correct when the user cuts the image and pastes it into a different note.
 */
export async function stashBlob(file: File | Blob, name: string, db: LocalDb = localDb): Promise<string> {
  const id = newLocalId();
  await db.blobs.add({
    id,
    noteId: null,
    mime: file.type || 'application/octet-stream',
    bytes: file,
    name: name || 'image',
    createdAt: correctedNow(),
    serverUrl: null,
  });
  return blobRef(id);
}

/** The bytes, for rendering. Undefined once the blob has been let go of. */
export async function readBlob(id: string, db: LocalDb = localDb): Promise<Blob | undefined> {
  return (await db.blobs.get(id))?.bytes;
}

export interface BlobSyncDeps {
  /** Upload the bytes; resolves to the URL the server will serve them from. */
  upload: (blob: LocalBlob) => Promise<string>;
  /**
   * Rewrite one note's content, swapping `from` for `to`. This MUST be the ordinary
   * note-update path - it is what puts the rewrite in the outbox.
   */
  rewrite: (noteId: string, from: string, to: string) => Promise<void>;
}

export interface BlobSyncResult {
  uploaded: number;
  rewritten: number;
  dropped: number;
}

/**
 * One sweep of the staging area. Called by the sync engine after a push has drained
 * the outbox, so the "is the rewrite confirmed" question is being asked at the one
 * moment its answer is freshest.
 *
 * Nothing here throws for a blob that cannot be dealt with yet. A blob whose note has
 * not been written back to the mirror, or whose upload failed, simply stays - the next
 * sweep tries again. Losing the bytes is the only outcome that cannot be recovered
 * from, so every branch that is unsure keeps them.
 */
export async function sweepBlobs(deps: BlobSyncDeps, db: LocalDb = localDb): Promise<BlobSyncResult> {
  const result: BlobSyncResult = { uploaded: 0, rewritten: 0, dropped: 0 };
  const blobs = await db.blobs.toArray();
  if (blobs.length === 0) return result;

  for (const blob of blobs) {
    const ref = blobRef(blob.id);
    const owner = await findOwningNote(ref, blob.noteId, db);

    // Nothing in the mirror points at these bytes. That is either an image inserted
    // seconds ago whose note has not autosaved yet, or one the user deleted from the
    // document before any of this ran. Waiting covers both: an orphan is collected
    // only once it is old enough that no autosave is plausibly still coming.
    if (!owner) {
      if (isStale(blob)) {
        await db.blobs.delete(blob.id);
        result.dropped += 1;
      }
      continue;
    }

    if (blob.noteId !== owner.id) await db.blobs.update(blob.id, { noteId: owner.id });

    if (blob.serverUrl === null) {
      // Step 1. A failure here leaves the row exactly as it was, so the next sweep
      // retries the upload with the bytes still in hand.
      let url: string;
      try {
        url = await deps.upload(blob);
      } catch {
        continue;
      }
      if (!url) continue;
      await db.blobs.update(blob.id, { serverUrl: url });
      blob.serverUrl = url;
      result.uploaded += 1;
    }

    if (owner.contentJson.includes(ref)) {
      // Step 2. Through the outbox, as an ordinary note update.
      try {
        await deps.rewrite(owner.id, ref, blob.serverUrl);
        result.rewritten += 1;
      } catch {
        // The rewrite did not happen, so the note still points at the reference and
        // the bytes are still needed. Nothing is dropped.
        continue;
      }
      // Deliberately no drop on this pass. The rewrite has only just been QUEUED;
      // whether it reached the server is a question for after the next push.
      continue;
    }

    // Step 3. The content no longer mentions the reference, so the rewrite has been
    // applied locally. It counts as confirmed only once nothing for this note is
    // still waiting in the outbox - a queued update is a rewrite the server has not
    // seen, and dropping the bytes now would leave the note pointing at nothing if
    // that push never lands.
    const pending = await db.outbox.where('[entity+recordId]').equals(['note', owner.id]).first();
    if (pending) continue;

    await db.blobs.delete(blob.id);
    result.dropped += 1;
  }

  return result;
}

/** How long an uploaded blob nothing points at is kept before it is collected. */
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

function isStale(blob: LocalBlob): boolean {
  const at = Date.parse(blob.createdAt);
  return Number.isFinite(at) && Date.parse(correctedNow()) - at > ORPHAN_GRACE_MS;
}

/**
 * The note whose content carries this reference.
 *
 * The recorded `noteId` is checked first and the scan is the fallback, so the common
 * case is one lookup. The scan exists because the id is not known at insert time, and
 * it stays correct when an image is moved between notes.
 */
async function findOwningNote(
  ref: string,
  known: string | null,
  db: LocalDb,
): Promise<{ id: string; contentJson: string } | null> {
  if (known) {
    const row = await db.notes.get(known);
    if (row && row.deletedAt === null) return { id: row.id, contentJson: row.contentJson };
    // The note was deleted or is gone. Fall through: the image may have been cut and
    // pasted somewhere else before the note went.
  }
  const notes = await db.notes.toArray();
  for (const n of notes) {
    if (n.deletedAt === null && n.contentJson.includes(ref)) return { id: n.id, contentJson: n.contentJson };
  }
  return null;
}
