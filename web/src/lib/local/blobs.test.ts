// The order in which offline image bytes are let go of.
//
// There is one bug this file exists to make impossible, and it is not a crash. Drop
// the bytes when the UPLOAD succeeds - which is the obvious moment, and one step too
// early - and a note whose content still says `local-blob:<id>` is left pointing at a
// blob that no longer exists. The image renders as nothing, forever, and no error is
// raised on either side of the wire.
//
// So the failing case gets its own test: upload succeeds, the rewrite does not, and
// the bytes must still be there.
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { localDb } from './db';
import { localApi } from './localApi';
import { blobRef, readBlob, stashBlob, sweepBlobs } from './blobs';
import { drainOrder } from './outbox';

const bytes = () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });

/** A note whose body carries `ref`, in the JSON-text shape the store holds. */
async function noteContaining(ref: string): Promise<string> {
  const { notebook } = await localApi.createNotebook({ name: 'N' });
  const { note } = await localApi.createNote({
    notebookId: notebook.id,
    title: 'With a screenshot',
    contentJson: { type: 'doc', content: [{ type: 'image', attrs: { src: ref } }] },
  });
  return note.id;
}

/** Stand-in for the sync engine's real deps, with each side switchable. */
function deps(over: { upload?: () => Promise<string>; rewrite?: () => Promise<void> } = {}) {
  const calls = { uploads: 0, rewrites: 0 };
  return {
    calls,
    upload: async () => {
      calls.uploads += 1;
      return over.upload ? over.upload() : '/uploads/server-copy.png';
    },
    rewrite: async (noteId: string, from: string, to: string) => {
      calls.rewrites += 1;
      if (over.rewrite) return over.rewrite();
      const row = await localDb.notes.get(noteId);
      if (!row) return;
      await localApi.updateNote(noteId, { contentJson: JSON.parse(row.contentJson.split(from).join(to)) });
    },
  };
}

describe('offline image bytes', () => {
  beforeEach(async () => {
    await localDb.delete();
    await localDb.open();
  });

  it('stashes the bytes and hands back a reference the note can survive a reload with', async () => {
    const form = new FormData();
    form.append('file', bytes(), 'screenshot.png');
    const { url } = await localApi.uploadImage(form);

    // Deliberately NOT an object URL: one of those is dead the moment the tab
    // reloads, and the note would carry a permanently broken image.
    expect(url).toMatch(/^local-blob:[a-z0-9]{14}$/);
    expect(await readBlob(url.slice('local-blob:'.length))).toBeInstanceOf(Blob);
  });

  it('uploads, rewrites through the outbox, and only then drops the bytes', async () => {
    const ref = await stashBlob(bytes(), 'screenshot.png');
    const noteId = await noteContaining(ref);
    // The note's own create has already been pushed, so the only thing that can be in
    // the outbox afterwards is the rewrite.
    await localDb.outbox.clear();
    await localDb.notes.update(noteId, { baseUpdatedAt: '2026-01-01T00:00:00.000Z' });
    const d = deps();

    // Pass one: bytes go up, the note is rewritten, and the rewrite is QUEUED.
    expect(await sweepBlobs(d)).toMatchObject({ uploaded: 1, rewritten: 1, dropped: 0 });
    expect((await localDb.notes.get(noteId))?.contentJson).toContain('/uploads/server-copy.png');
    expect((await drainOrder()).map((e) => `${e.entity}:${e.op}`)).toEqual(['note:update']);
    // Still here. The server has not seen that rewrite yet.
    expect(await localDb.blobs.count()).toBe(1);

    // Pass two, with the rewrite still queued: still not confirmed, still kept.
    expect(await sweepBlobs(d)).toMatchObject({ dropped: 0 });
    expect(await localDb.blobs.count()).toBe(1);

    // The push lands. Now the server holds a note pointing at its own copy.
    await localDb.outbox.clear();
    expect(await sweepBlobs(d)).toMatchObject({ dropped: 1 });
    expect(await localDb.blobs.count()).toBe(0);
    // And nothing was uploaded twice along the way.
    expect(d.calls.uploads).toBe(1);
  });

  it('KEEPS the bytes when the upload succeeded but the rewrite failed', async () => {
    // The whole point of this file. Dropping on upload success leaves the note
    // pointing at nothing, on this device, permanently.
    const ref = await stashBlob(bytes(), 'screenshot.png');
    const noteId = await noteContaining(ref);
    await localDb.outbox.clear();

    const failing = deps({ rewrite: () => Promise.reject(new Error('note write failed')) });
    expect(await sweepBlobs(failing)).toMatchObject({ uploaded: 1, rewritten: 0, dropped: 0 });

    expect(await localDb.blobs.count()).toBe(1);
    // The note still names the reference, so the bytes are still what renders it.
    expect((await localDb.notes.get(noteId))?.contentJson).toContain(ref);
    expect(await readBlob(ref.slice('local-blob:'.length))).toBeInstanceOf(Blob);

    // And the retry picks up where it stopped rather than re-uploading.
    const ok = deps();
    expect(await sweepBlobs(ok)).toMatchObject({ uploaded: 0, rewritten: 1 });
  });

  it('keeps the bytes when the rewrite is queued but its push never lands', async () => {
    const ref = await stashBlob(bytes(), 'screenshot.png');
    const noteId = await noteContaining(ref);
    await localDb.outbox.clear();
    await localDb.notes.update(noteId, { baseUpdatedAt: '2026-01-01T00:00:00.000Z' });

    const d = deps();
    await sweepBlobs(d);
    // A push that keeps failing leaves the entry queued. Ten sweeps later the bytes
    // are still the only copy of that image the server has never received.
    for (let i = 0; i < 10; i++) await sweepBlobs(d);
    expect(await localDb.blobs.count()).toBe(1);
  });

  it('does not upload bytes no note points at yet', async () => {
    // The editor stashes the image before the note has autosaved, so for a moment
    // nothing in the mirror mentions it. That is a reason to wait, not to give up.
    await stashBlob(bytes(), 'screenshot.png');
    const d = deps();
    expect(await sweepBlobs(d)).toEqual({ uploaded: 0, rewritten: 0, dropped: 0 });
    expect(await localDb.blobs.count()).toBe(1);
  });

  it('collects bytes nothing has pointed at for a day', async () => {
    const ref = await stashBlob(bytes(), 'screenshot.png');
    const id = ref.slice('local-blob:'.length);
    await localDb.blobs.update(id, { createdAt: new Date(Date.now() - 48 * 3_600_000).toISOString() });
    expect(await sweepBlobs(deps())).toMatchObject({ dropped: 1 });
  });

  it('finds the note by its content, so an image moved between notes still resolves', async () => {
    // The owning note is not known when the bytes are taken - the editor uploads
    // before the image is placed, exactly as the server's own upload route does.
    const ref = await stashBlob(bytes(), 'screenshot.png');
    const { notebook } = await localApi.createNotebook({ name: 'N' });
    const { note: first } = await localApi.createNote({
      notebookId: notebook.id, title: 'Cut from here',
      contentJson: { type: 'doc', content: [{ type: 'image', attrs: { src: ref } }] },
    });
    const { note: second } = await localApi.createNote({ notebookId: notebook.id, title: 'Pasted to here' });

    // The user cuts the image across before anything syncs.
    await localApi.updateNote(first.id, { contentJson: { type: 'doc', content: [] } });
    await localApi.updateNote(second.id, { contentJson: { type: 'doc', content: [{ type: 'image', attrs: { src: ref } }] } });
    await localDb.outbox.clear();

    await sweepBlobs(deps());
    expect((await localDb.notes.get(second.id))?.contentJson).toContain('/uploads/server-copy.png');
    expect((await localDb.blobs.get(ref.slice('local-blob:'.length)))?.noteId).toBe(second.id);
  });

  it('recognises its own reference and nothing else', () => {
    expect(blobRef('abc')).toBe('local-blob:abc');
  });
});
