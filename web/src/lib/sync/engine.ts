// The sync engine: pull the server's changes down, push the outbox up.
//
// Ordering is the first thing to understand here. syncNow() PUSHES BEFORE IT PULLS,
// so our own queued writes reach the server before we ask what changed. Pulling
// first would fetch the server's older copy of a record we are about to update,
// apply it over our newer local edit, and then push the record we just clobbered.
//
// The second thing is that each pulled page commits its records AND its cursor in
// one transaction. That is what makes an interrupted first sync resume instead of
// restart - and a first sync over a large library is exactly when a laptop lid gets
// closed.
import { localDb, readMeta, writeMeta } from '../local/db';
import { setClockOffset } from '../local/clock';
import { sweepBlobs, type BlobSyncResult } from '../local/blobs';
import { localApi } from '../local/localApi';
import { drainOrder, settle, fail } from '../local/outbox';
import { noteRequestOutcome, isOnline, subscribeConnectivity } from './connectivity';
import { setMirrorWarm } from './mirrorState';
import { serverOnlyApi } from '../api';
import {
  DEFAULT_SYNC_LIMIT,
  type SyncChangesResponse,
  type SyncEntity,
  type SyncedRecord,
} from './contract';

export interface SyncOutcome {
  pulled: number;
  pushed: number;
  conflicts: number;
  error?: string;
}

const CURSOR_KEY = 'cursor';
const INITIAL_DONE_KEY = 'initialSyncDone';

type MirroredTable = 'notebooks' | 'notes' | 'flashcards' | 'canvasItems' | 'canvasEdges' | 'ink';

/**
 * Entities this build mirrors, and the table each one lands in.
 *
 * Records for an entity absent here are DELIBERATELY skipped rather than treated as
 * an error. `review` is the only one left out: the server's review log is an
 * identity-keyed append-only table with nothing for a client to reconcile.
 *
 * SKIPPING STILL ADVANCES THE CURSOR PAST THOSE RECORDS, and that is why adding the
 * canvas and ink tables here had to come with a Dexie upgrade that CLEARS the cursor
 * (db.ts, version 2). Without it every board and every stroke an account already
 * owned would sit behind the cursor this browser holds, permanently, with nothing in
 * the UI to suggest anything was missing. Anyone adding a seventh entity here
 * inherits the same obligation.
 */
const MIRRORED: Partial<Record<SyncEntity, MirroredTable>> = {
  notebook: 'notebooks',
  note: 'notes',
  flashcard: 'flashcards',
  canvasItem: 'canvasItems',
  canvasEdge: 'canvasEdges',
  ink: 'ink',
};

/** Has this browser finished its first full pull? Decides whether reads may trust the mirror. */
export async function isMirrorWarm(): Promise<boolean> {
  return (await readMeta(INITIAL_DONE_KEY)) === '1';
}

// --- pull -------------------------------------------------------------------

/**
 * Apply one page.
 *
 * The comparison is `>=` against the local `updatedAt`, i.e. an equal timestamp is
 * NOT applied. A server record we already hold is the common case on every sync
 * after the first, and rewriting it would churn every row on every poll.
 */
async function applyPage(response: SyncChangesResponse): Promise<number> {
  let applied = 0;

  // The table list is an array rather than Dexie's varargs form: the overloads stop
  // at five tables and this page can touch seven.
  await localDb.transaction(
    'rw',
    [
      localDb.notebooks, localDb.notes, localDb.flashcards,
      localDb.canvasItems, localDb.canvasEdges, localDb.ink, localDb.meta,
    ],
    async () => {
      for (const [entity, records] of Object.entries(response.changes)) {
        const tableName = MIRRORED[entity as SyncEntity];
        if (!tableName || !records) continue; // an entity this build does not hold - see MIRRORED
        const table = localDb[tableName];

        for (const incoming of records as Array<SyncedRecord & Record<string, unknown>>) {
          const local = await table.get(incoming.id);
          if (local && String(local.updatedAt) >= incoming.updatedAt) continue;

          // Merge onto the local row rather than replacing it: the server's feed
          // carries the synced columns, while client-side fields live only here. A
          // blind put would drop them.
          //
          // `tags` is defaulted explicitly because a server that predates the tags
          // column in this feed sends notes without one, and the note read paths call
          // .some()/.map() on it - so the FIRST arrival of any note would throw for
          // every signed-in user on a fresh install.
          await table.put({
            ...(local ?? {}),
            ...(tableName === 'notes' ? { tags: (local as { tags?: string[] } | undefined)?.tags ?? [] } : {}),
            ...incoming,
            // The base is what the SERVER just showed us. Setting it from anything
            // else makes the next push claim a version this client never saw, and
            // every subsequent write then reads as a conflict.
            baseUpdatedAt: incoming.updatedAt,
          } as never);
          applied += 1;
        }
      }

      if (response.cursor) await localDb.meta.put({ key: CURSOR_KEY, value: response.cursor });
    },
  );

  return applied;
}

async function pull(): Promise<number> {
  let pulled = 0;

  for (;;) {
    const cursor = await readMeta(CURSOR_KEY);
    const response = await serverOnlyApi.syncChanges({ since: cursor ?? undefined, limit: DEFAULT_SYNC_LIMIT });

    // Refresh the clock offset from every page. Positive means this machine is
    // ahead of the server.
    setClockOffset(Date.now() - Date.parse(response.serverNow));

    pulled += await applyPage(response);
    if (!response.hasMore) break;
    // A page with more to come but no cursor would loop forever. The server always
    // sends one when it has rows; treat its absence as "stop" rather than trusting
    // hasMore, because an infinite pull loop is worse than a delayed record.
    if (!response.cursor) break;
  }

  await writeMeta(INITIAL_DONE_KEY, '1');
  // Reads may now be served from the mirror. Set only AFTER a full pull completed:
  // an empty mirror and an empty account are indistinguishable, so flipping this
  // early would show a signed-in user zero notes on a fresh install.
  setMirrorWarm(true);
  return pulled;
}

// --- push -------------------------------------------------------------------

/** Maps an outbox entry onto the server call that performs it. */
async function sendEntry(entry: Awaited<ReturnType<typeof drainOrder>>[number]): Promise<{ conflicted: boolean }> {
  const p = entry.payload as Record<string, never>;
  const sync = { baseUpdatedAt: entry.baseUpdatedAt, clientUpdatedAt: entry.clientUpdatedAt };

  switch (`${entry.entity}:${entry.op}`) {
    case 'notebook:create':
      await serverOnlyApi.createNotebook({ ...p, id: entry.recordId } as never);
      return { conflicted: false };
    case 'notebook:update': {
      const r = await serverOnlyApi.updateNotebook(entry.recordId, { ...p, ...sync } as never);
      return { conflicted: Boolean((r as { conflicted?: boolean }).conflicted) };
    }
    case 'notebook:delete':
      await serverOnlyApi.deleteNotebook(entry.recordId);
      return { conflicted: false };

    case 'note:create':
      await serverOnlyApi.createNote({ ...p, id: entry.recordId } as never);
      return { conflicted: false };
    case 'note:update': {
      const r = await serverOnlyApi.updateNote(entry.recordId, { ...p, ...sync } as never);
      return { conflicted: Boolean((r as { conflicted?: boolean }).conflicted) };
    }
    case 'note:delete':
      await serverOnlyApi.deleteNote(entry.recordId);
      return { conflicted: false };

    case 'flashcard:create':
      await serverOnlyApi.createCard({ ...p, id: entry.recordId } as never);
      return { conflicted: false };
    case 'flashcard:update':
      await serverOnlyApi.updateCard(entry.recordId, { ...p, ...sync } as never);
      return { conflicted: false };
    case 'flashcard:delete':
      await serverOnlyApi.deleteCard(entry.recordId);
      return { conflicted: false };

    // Boards. The note id rides in the PAYLOAD rather than being derivable from the
    // entry, because every canvas route is addressed as /api/canvas/:noteId/... and
    // the outbox only knows the record's own id.
    case 'canvasItem:create':
      // `id` is sent so the item keeps the identity the board's connectors already
      // use. A server-minted replacement would orphan every connector drawn to it.
      await serverOnlyApi.createCanvasItem(noteOf(entry), { ...p, id: entry.recordId } as never);
      return { conflicted: false };
    case 'canvasItem:update':
      // The bulk route, with one item in it. Per-item last-write-wins and no
      // history, so there is no conflict for the server to report.
      await serverOnlyApi.updateCanvasItems(noteOf(entry), [{ ...p, id: entry.recordId }] as never);
      return { conflicted: false };
    case 'canvasItem:delete':
      await serverOnlyApi.deleteCanvasItem(noteOf(entry), entry.recordId);
      return { conflicted: false };

    case 'canvasEdge:create':
      await serverOnlyApi.createCanvasEdge(noteOf(entry), { ...p, id: entry.recordId } as never);
      return { conflicted: false };
    case 'canvasEdge:delete':
      await serverOnlyApi.deleteCanvasEdge(noteOf(entry), entry.recordId);
      return { conflicted: false };

    case 'ink:create': {
      // One stroke per entry, sent as a batch of one. Strokes are immutable, so the
      // server treats a re-sent id as a no-op and there is nothing to reconcile -
      // the same property that makes review:create free.
      const stroke = entry.payload.stroke as Record<string, unknown>;
      await serverOnlyApi.addInk(noteOf(entry), [{ ...stroke, id: entry.recordId }] as never);
      return { conflicted: false };
    }
    case 'ink:delete':
      // `layer:<noteId>` is localApi.clearInk's whole-layer erase, queued as ONE
      // entry rather than one per stroke: a page of handwriting is thousands of rows
      // and reproducing a request the API expresses in one call would turn a single
      // tap into minutes of reconnect traffic.
      if (entry.recordId.startsWith('layer:')) {
        await serverOnlyApi.clearInk(noteOf(entry));
        return { conflicted: false };
      }
      await serverOnlyApi.deleteInk(noteOf(entry), entry.recordId);
      return { conflicted: false };

    case 'review:create':
      // Append-only on both sides, so there is nothing to reconcile: two devices
      // reviewing the same card produce two log rows and both survive. Only the
      // card's derived schedule is last-write-wins, and that rides on
      // flashcard:update.
      await serverOnlyApi.review(p.cardId as unknown as string, p.rating as unknown as 'again' | 'hard' | 'good' | 'easy');
      return { conflicted: false };

    default:
      // An entity/op pair nothing in this build queues. Dropped rather than retried
      // forever - there is no request that would satisfy it.
      return { conflicted: false };
  }
}

/**
 * The board or note a canvas/ink entry belongs to.
 *
 * Every one of those routes is scoped by a note the caller owns, so a payload that
 * lost its noteId cannot be sent anywhere. Returning the empty string makes the URL
 * obviously wrong and the request a 404 the entry records, rather than a plausible
 * request against whatever id happened to be nearby.
 */
function noteOf(entry: { payload: Record<string, unknown> }): string {
  const id = entry.payload.noteId;
  return typeof id === 'string' ? id : '';
}

interface PushResult {
  pushed: number;
  conflicts: number;
  error?: string;
}

async function push(): Promise<PushResult> {
  let pushed = 0;
  let conflicts = 0;

  for (const entry of await drainOrder()) {
    try {
      const { conflicted } = await sendEntry(entry);
      await settle(entry.seq!);
      pushed += 1;
      if (conflicted) conflicts += 1;
    } catch (err) {
      const status = (err as { status?: number }).status;

      // 409 on a create means this push already landed and we never saw the
      // response. Settling it is correct; retrying it forever would wedge the
      // queue behind a record that already exists.
      if (status === 409 && entry.op === 'create') {
        await settle(entry.seq!);
        pushed += 1;
        continue;
      }

      // 404 on a delete is the same shape of problem from the other end: the row is
      // already gone, which is exactly what this entry was asking for. It is
      // reachable whenever a delete cascades - a note taken away takes its board and
      // its ink with it, and every canvas route then answers 404 for a note that is
      // a tombstone. Retrying that would wedge the queue on a request no server can
      // ever satisfy.
      if (status === 404 && entry.op === 'delete') {
        await settle(entry.seq!);
        pushed += 1;
        continue;
      }

      const message = err instanceof Error ? err.message : 'push failed';
      await fail(entry.seq!, message);

      // No status means the request never reached a server - a transport failure.
      // Stop the whole push: the rest will fail identically, and hammering a dead
      // connection burns battery for nothing.
      if (status === undefined) {
        noteRequestOutcome(false);
        return { pushed, conflicts, error: message };
      }

      // A 4xx is this entry's own problem and must not block the entries behind
      // it. It stays queued with its error recorded, and the next sync retries it.
    }
  }

  return { pushed, conflicts };
}

// --- staged image bytes ------------------------------------------------------

/**
 * Get the images inserted offline onto the server, and only then let go of the bytes.
 *
 * Run between the push and the pull, which is not arbitrary. The push has just
 * emptied the outbox of everything it could send, so "is there still a note update
 * queued for this note" - the question that decides whether a rewrite has actually
 * reached the server - is being asked at the one moment its answer is freshest.
 *
 * The rewrite itself goes back INTO the outbox, so the note reaches the server on the
 * NEXT cycle rather than this one. That is deliberate: it is an ordinary note update
 * and gets the same conflict handling, clamping and coalescing as any other, instead
 * of a second write path that would need all of it reimplemented.
 */
async function pushBlobs(): Promise<BlobSyncResult> {
  return sweepBlobs({
    upload: async (blob) => {
      const form = new FormData();
      form.append('file', blob.bytes, blob.name);
      const { url } = await serverOnlyApi.uploadImage(form);
      return url;
    },
    rewrite: async (noteId, from, to) => {
      const row = await localDb.notes.get(noteId);
      if (!row) return;
      const contentJson = JSON.parse(row.contentJson.split(from).join(to)) as unknown;
      // Through localApi, so this is indistinguishable from the user having edited
      // the note: one Dexie transaction covering the row and its outbox entry, the
      // corrected clock, and baseUpdatedAt left alone.
      await localApi.updateNote(noteId, { contentJson });
    },
  });
}

// --- the loop ---------------------------------------------------------------

let running: Promise<SyncOutcome> | null = null;

/**
 * One full cycle. Concurrent callers share the in-flight run rather than starting a
 * second: two pushes draining one outbox would send every entry twice.
 */
export function syncNow(): Promise<SyncOutcome> {
  if (running) return running;

  running = (async (): Promise<SyncOutcome> => {
    try {
      const pushResult = await push();
      if (pushResult.error) {
        return { pulled: 0, pushed: pushResult.pushed, conflicts: pushResult.conflicts, error: pushResult.error };
      }

      // Image bytes go up here, and any note rewrite they produce lands back in the
      // outbox - so the queue has to be drained a SECOND time. Without it the server
      // keeps a note pointing at `local-blob:<id>` until the next poll a minute
      // later, and anyone reading that note on another device sees nothing where the
      // image should be.
      let pushed = pushResult.pushed;
      let conflicts = pushResult.conflicts;
      if ((await pushBlobs()).rewritten > 0) {
        const again = await push();
        pushed += again.pushed;
        conflicts += again.conflicts;
        if (again.error) return { pulled: 0, pushed, conflicts, error: again.error };
      }

      const pulled = await pull();
      noteRequestOutcome(true);
      return { pulled, pushed, conflicts };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'sync failed';
      if ((err as { status?: number }).status === undefined) noteRequestOutcome(false);
      return { pulled: 0, pushed: 0, conflicts: 0, error: message };
    } finally {
      running = null;
    }
  })();

  return running;
}

const POLL_MS = 60_000;

/**
 * Start syncing: once on boot, again whenever connectivity returns, and on a slow
 * poll while online.
 *
 * The poll exists because this client has no push channel - without it, a note
 * written on a phone would not appear here until something else triggered a sync.
 * 60s is a deliberate compromise: fast enough that switching devices feels
 * current, slow enough to be invisible on a battery.
 */
export function startSync(): () => void {
  let stopped = false;

  const tick = () => {
    if (stopped || !isOnline()) return;
    void syncNow();
  };

  tick();
  const interval = window.setInterval(tick, POLL_MS);
  const unsubscribe = subscribeConnectivity(() => {
    // Only a transition INTO reachable is worth a sync; going offline has nothing
    // to send anywhere.
    if (isOnline()) tick();
  });

  return () => {
    stopped = true;
    window.clearInterval(interval);
    unsubscribe();
  };
}
