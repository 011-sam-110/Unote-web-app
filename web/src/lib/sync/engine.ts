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

/**
 * Entities this build mirrors. The server's feed covers more than this - canvas
 * items, edges and ink are in the wire contract for Stage 2 - and records for an
 * entity absent here are DELIBERATELY skipped rather than treated as an error.
 *
 * The consequence matters for whoever builds Stage 2: skipping still advances the
 * cursor past those records, so adding the ink and canvas tables must also CLEAR
 * the cursor and re-pull from the beginning. Bumping the Dexie schema version
 * without clearing the cursor would leave every pre-existing stroke unsynced, on
 * every existing install, with nothing in the UI to suggest anything is missing.
 */
const MIRRORED: Partial<Record<SyncEntity, 'notebooks' | 'notes' | 'flashcards'>> = {
  notebook: 'notebooks',
  note: 'notes',
  flashcard: 'flashcards',
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

  await localDb.transaction('rw', localDb.notebooks, localDb.notes, localDb.flashcards, localDb.meta, async () => {
    for (const [entity, records] of Object.entries(response.changes)) {
      const tableName = MIRRORED[entity as SyncEntity];
      if (!tableName || !records) continue; // Stage 2 entity - see MIRRORED
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
  });

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

    case 'review:create':
      // Append-only on both sides, so there is nothing to reconcile: two devices
      // reviewing the same card produce two log rows and both survive. Only the
      // card's derived schedule is last-write-wins, and that rides on
      // flashcard:update.
      await serverOnlyApi.review(p.cardId as unknown as string, p.rating as unknown as 'again' | 'hard' | 'good' | 'easy');
      return { conflicted: false };

    default:
      // An entity this build does not push (Stage 2). Drop it rather than
      // retrying forever - it was never queued by any Stage 1 code path.
      return { conflicted: false };
  }
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
      const pulled = await pull();
      noteRequestOutcome(true);
      return { pulled, pushed: pushResult.pushed, conflicts: pushResult.conflicts };
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
