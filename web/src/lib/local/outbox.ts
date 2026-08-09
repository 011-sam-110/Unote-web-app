// The write queue for edits made offline.
//
// Two coalescing rules carry real weight, and both exist because the naive queue
// breaks in production rather than in theory:
//
//   * Repeated updates to one record collapse. Without this a long offline
//     session queues one PATCH per debounce tick and the reconnect storms the
//     server with thousands of writes that all lose to the last one anyway.
//   * A delete supersedes pending updates, and CANCELS a pending create outright.
//     Pushing a create the user has since deleted resurrects it; pushing an
//     update for a record the server never saw 404s and wedges the queue.
import { localDb, type LocalDb } from './db';
import type { OutboxEntry } from './records';
import { OUTBOX_ORDER } from '../sync/contract';

export type NewEntry = Omit<OutboxEntry, 'seq' | 'attempts' | 'lastError'>;

// Every function here takes the database as an optional trailing argument,
// defaulting to the singleton. That is not generality for its own sake: the
// two-client convergence harness runs two independent stores in ONE process, and
// functions bound to the singleton would have given both clients the SAME outbox -
// making every convergence assertion pass for the wrong reason. Injecting the db
// lets the harness exercise this real code instead of reimplementing it.

export async function enqueue(next: NewEntry, db: LocalDb = localDb): Promise<void> {
  await db.transaction('rw', db.outbox, async () => {
    const existing = await db.outbox
      .where('[entity+recordId]')
      .equals([next.entity, next.recordId])
      .first();

    if (!existing) {
      await db.outbox.add({ ...next, attempts: 0, lastError: null });
      return;
    }

    if (next.op === 'delete') {
      // Never created server-side, so there is nothing to delete there either.
      if (existing.op === 'create') {
        await db.outbox.delete(existing.seq!);
        return;
      }
      await db.outbox.update(existing.seq!, {
        op: 'delete',
        payload: next.payload,
        clientUpdatedAt: next.clientUpdatedAt,
        attempts: 0,
        lastError: null,
      });
      return;
    }

    // A create still pending stays a create - the server has never seen this row.
    // Only the payload advances.
    await db.outbox.update(existing.seq!, {
      op: existing.op === 'create' ? 'create' : next.op,
      payload: next.payload,
      clientUpdatedAt: next.clientUpdatedAt,
      // baseUpdatedAt must NOT advance here. It records what the server last
      // showed us, and a local edit has not changed that.
      attempts: 0,
      lastError: null,
    });
  });
}

/**
 * Everything pending, in the order it is safe to push: entity by entity per
 * OUTBOX_ORDER, and insertion order within each entity.
 */
export async function drainOrder(db: LocalDb = localDb): Promise<OutboxEntry[]> {
  const all = await db.outbox.toArray();
  const rank = new Map(OUTBOX_ORDER.map((e, i) => [e, i]));
  return all.sort((a, b) => {
    const ra = rank.get(a.entity) ?? 99;
    const rb = rank.get(b.entity) ?? 99;
    return ra !== rb ? ra - rb : (a.seq ?? 0) - (b.seq ?? 0);
  });
}

/** A push landed. */
export async function settle(seq: number, db: LocalDb = localDb): Promise<void> {
  await db.outbox.delete(seq);
}

/**
 * A push failed. The entry stays queued; `attempts` drives the caller's backoff.
 * Nothing is ever dropped for failing - a dropped entry is a lost edit.
 */
export async function fail(seq: number, error: string, db: LocalDb = localDb): Promise<void> {
  const row = await db.outbox.get(seq);
  if (!row) return;
  await db.outbox.update(seq, { attempts: row.attempts + 1, lastError: error });
}

export async function pendingCount(db: LocalDb = localDb): Promise<number> {
  return db.outbox.count();
}
