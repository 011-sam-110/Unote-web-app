// Two-client convergence harness.
//
// This is the test that matters. Everything else in this project checks that a
// piece behaves; this checks the property the whole design exists to provide: two
// devices that edited the same account while disconnected end up agreeing, and
// nobody's work vanishes.
//
// It asserts final CONTENT on both clients and the server - not call counts, not
// "sync completed". A capture harness on this project once reported "78 screenshots
// captured, 0 failed" when all 78 were pictures of the login form. A green count is
// not evidence.
//
// The fake server applies the SAME resolution rule as server/src/lib/conflict.ts -
// newest wins, a tie goes to the server, the loser is preserved - so the two
// implementations drifting apart shows up here as a failure rather than as a
// support ticket.
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { LocalDb } from '../local/db';
import { enqueue, drainOrder, settle } from '../local/outbox';
import { newLocalId } from '../local/records';
import type { SyncEntity } from './contract';

// --- the fake server --------------------------------------------------------

interface ServerRow {
  entity: SyncEntity;
  id: string;
  updatedAt: string;
  deletedAt: string | null;
  data: Record<string, unknown>;
}

/**
 * The single source of real time for the whole harness, advancing a second per read.
 *
 * It has to advance. An earlier version of this file calibrated each client to the
 * server and then returned that frozen instant as "now", which made every corrected
 * timestamp constant - so "the client that edited last wins" was not being tested at
 * all, and the clock-skew tests passed or failed on pull ORDER instead.
 */
let wall = Date.UTC(2026, 7, 9, 12, 0, 0);
const wallNow = (): number => (wall += 1000);

class FakeServer {
  rows = new Map<string, ServerRow>();
  /** Conflict-demoted copies, standing in for note_versions. */
  history: Array<{ id: string; cause: 'conflict'; data: Record<string, unknown> }> = [];
  /** Set a page number here to make changesSince throw once, simulating a drop. */
  failPageOnce: number | null = null;
  private pagesServed = 0;

  /** The server reads the same wall clock the clients do - it is simply never wrong. */
  now(): string {
    return new Date(wallNow()).toISOString();
  }

  private key(entity: SyncEntity, id: string): string {
    return `${entity}:${id}`;
  }

  seed(entity: SyncEntity, id: string, data: Record<string, unknown>): ServerRow {
    const row: ServerRow = { entity, id, updatedAt: this.now(), deletedAt: null, data };
    this.rows.set(this.key(entity, id), row);
    return row;
  }

  changesSince(cursor: { updatedAt: string; id: string } | null, limit = 500) {
    this.pagesServed += 1;
    if (this.failPageOnce === this.pagesServed) {
      this.failPageOnce = null;
      throw new Error('network dropped mid-sync');
    }

    const since = cursor ?? { updatedAt: '', id: '' };
    const ordered = [...this.rows.values()]
      .filter((r) => r.updatedAt > since.updatedAt || (r.updatedAt === since.updatedAt && r.id > since.id))
      .sort((a, b) => (a.updatedAt === b.updatedAt ? a.id.localeCompare(b.id) : a.updatedAt.localeCompare(b.updatedAt)));

    const page = ordered.slice(0, limit);
    const last = page.at(-1);
    return {
      cursor: last ? { updatedAt: last.updatedAt, id: last.id } : null,
      hasMore: ordered.length > limit,
      serverNow: this.now(),
      page,
    };
  }

  /** Mirrors server/src/lib/conflict.ts: clamp, then newest-wins with ties to the server. */
  write(args: {
    entity: SyncEntity;
    op: 'create' | 'update' | 'delete';
    id: string;
    data: Record<string, unknown>;
    baseUpdatedAt: string | null;
    clientUpdatedAt: string;
  }): { conflicted: boolean; row: ServerRow } {
    const k = this.key(args.entity, args.id);
    const existing = this.rows.get(k);
    const serverNow = this.now();

    const createdAt = String(existing?.data.createdAt ?? args.data.createdAt ?? serverNow);
    let edited = args.clientUpdatedAt;
    if (edited > serverNow) edited = serverNow;
    if (edited < createdAt) edited = createdAt;

    if (!existing) {
      const row: ServerRow = {
        entity: args.entity,
        id: args.id,
        updatedAt: edited,
        deletedAt: args.op === 'delete' ? edited : null,
        data: args.data,
      };
      this.rows.set(k, row);
      return { conflicted: false, row };
    }

    const conflicted = args.baseUpdatedAt != null && args.baseUpdatedAt !== existing.updatedAt;
    const clientWins = !conflicted || edited > existing.updatedAt;

    if (conflicted) {
      this.history.push({ id: args.id, cause: 'conflict', data: clientWins ? existing.data : args.data });
    }
    if (!clientWins) return { conflicted: true, row: existing };

    const row: ServerRow = {
      ...existing,
      updatedAt: edited,
      deletedAt: args.op === 'delete' ? edited : existing.deletedAt,
      data: { ...existing.data, ...args.data },
    };
    this.rows.set(k, row);
    return { conflicted, row };
  }
}

// --- a client ---------------------------------------------------------------

const TABLE_OF: Record<string, 'notebooks' | 'notes' | 'flashcards'> = {
  notebook: 'notebooks', note: 'notes', flashcard: 'flashcards',
};

/**
 * `skewMs` is how wrong this machine's clock is. It is the point of several tests
 * below: a laptop an hour fast must not win every conflict simply for being wrong.
 */
async function makeClient(name: string, server: FakeServer, skewMs = 0, pageLimit = 500) {
  const db = new LocalDb(`unote-${name}`);
  await db.delete();
  await db.open();

  let cursor: { updatedAt: string; id: string } | null = null;
  let offsetMs = 0;

  /** What this machine's own clock reads: real time plus however wrong it is. */
  const rawNow = () => wallNow() + skewMs;

  /**
   * Corrected toward the server exactly as clock.ts does. Because rawNow advances,
   * a client that edits later produces a later timestamp - and the correction
   * cancels the skew, so being wrong buys no priority.
   */
  const now = () => new Date(rawNow() - offsetMs).toISOString();

  const client = {
    name,
    db,

    async edit(entity: SyncEntity, id: string, patch: Record<string, unknown>) {
      const table = db[TABLE_OF[entity]];
      const at = now();
      await db.transaction('rw', table, db.outbox, async () => {
        const existing = await table.get(id);
        const next = { ...(existing ?? { id }), ...patch, updatedAt: at, deletedAt: null };
        await table.put(next as never);
        await enqueue({
          entity,
          op: existing ? 'update' : 'create',
          recordId: id,
          payload: patch,
          baseUpdatedAt: (existing as { baseUpdatedAt?: string | null } | undefined)?.baseUpdatedAt ?? null,
          clientUpdatedAt: at,
        }, db);
      });
    },

    async remove(entity: SyncEntity, id: string) {
      const table = db[TABLE_OF[entity]];
      const at = now();
      await db.transaction('rw', table, db.outbox, async () => {
        const existing = await table.get(id);
        if (existing) await table.put({ ...existing, deletedAt: at, updatedAt: at } as never);
        await enqueue({
          entity, op: 'delete', recordId: id, payload: {},
          baseUpdatedAt: (existing as { baseUpdatedAt?: string | null } | undefined)?.baseUpdatedAt ?? null,
          clientUpdatedAt: at,
        }, db);
      });
    },

    async push() {
      for (const entry of await drainOrder(db)) {
        const res = server.write({
          entity: entry.entity, op: entry.op, id: entry.recordId,
          data: entry.payload, baseUpdatedAt: entry.baseUpdatedAt,
          clientUpdatedAt: entry.clientUpdatedAt,
        });
        const table = db[TABLE_OF[entry.entity]];
        await table.put({
          ...res.row.data, id: res.row.id, updatedAt: res.row.updatedAt,
          deletedAt: res.row.deletedAt, baseUpdatedAt: res.row.updatedAt,
        } as never);
        await settle(entry.seq!, db);
      }
    },

    async pull() {
      for (;;) {
        const res = server.changesSince(cursor, pageLimit);
        offsetMs = rawNow() - Date.parse(res.serverNow);
        for (const row of res.page) {
          const table = db[TABLE_OF[row.entity]];
          const local = await table.get(row.id);
          if (local && String(local.updatedAt) >= row.updatedAt) continue;
          await table.put({
            ...(local ?? {}), ...row.data, id: row.id, updatedAt: row.updatedAt,
            deletedAt: row.deletedAt, baseUpdatedAt: row.updatedAt,
          } as never);
        }
        cursor = res.cursor;
        if (!res.hasMore || !res.cursor) break;
      }
    },

    /** Push before pull, matching engine.ts. */
    async sync() {
      await client.push();
      await client.pull();
    },

    async get(entity: SyncEntity, id: string) {
      const row = await db[TABLE_OF[entity]].get(id);
      // Via unknown: the three record types are structurally distinct and none has
      // an index signature, so TS refuses the direct assertion.
      return row as unknown as Record<string, unknown> | undefined;
    },

    /** Live rows only, which is what any list in the UI shows. */
    async live(entity: SyncEntity) {
      const all = await db[TABLE_OF[entity]].toArray();
      return all.filter((r) => (r as { deletedAt: string | null }).deletedAt === null);
    },
  };

  return client;
}

// --- the tests --------------------------------------------------------------

describe('two-client convergence', () => {
  let server: FakeServer;

  beforeEach(() => {
    server = new FakeServer();
  });

  it('edits to different notes from both clients all survive', async () => {
    const a = await makeClient('a', server);
    const b = await makeClient('b', server);
    const nb = newLocalId();
    server.seed('notebook', nb, { name: 'Shared', createdAt: server.now() });

    const n1 = newLocalId();
    const n2 = newLocalId();
    await a.edit('note', n1, { notebookId: nb, title: 'From A', createdAt: server.now() });
    await b.edit('note', n2, { notebookId: nb, title: 'From B', createdAt: server.now() });

    await a.sync();
    await b.sync();
    await a.sync();

    for (const client of [a, b]) {
      const titles = (await client.live('note')).map((n) => (n as { title: string }).title).sort();
      expect(titles).toEqual(['From A', 'From B']);
    }
    expect(server.rows.size).toBe(3); // the notebook and both notes
  });

  it('the same note edited on both clients: newer wins and the loser is kept in history', async () => {
    const a = await makeClient('a', server);
    const b = await makeClient('b', server);
    const id = newLocalId();
    server.seed('note', id, { title: 'Original', createdAt: server.now() });

    // Both clients learn the note, so both hold the same baseUpdatedAt.
    await a.pull();
    await b.pull();

    // Both edit while disconnected. A edits first, B second, so B is newer.
    await a.edit('note', id, { title: 'A wrote this' });
    await b.edit('note', id, { title: 'B wrote this' });

    await a.sync(); // lands cleanly
    await b.sync(); // arrives with a now-stale base -> conflict

    expect(server.history).toHaveLength(1);
    expect(server.history[0].cause).toBe('conflict');
    // Nothing was destroyed: the losing text is in history.
    expect(JSON.stringify(server.history[0].data)).toContain('A wrote this');

    // And both clients agree on the winner.
    await a.sync();
    expect((await a.get('note', id))?.title).toBe('B wrote this');
    expect((await b.get('note', id))?.title).toBe('B wrote this');
  });

  // The exact bug the missing tombstones would have caused, run per table.
  for (const entity of ['notebook', 'note', 'flashcard'] as const) {
    it(`a ${entity} deleted on one client stays deleted after the other pushes an offline edit`, async () => {
      const a = await makeClient('a', server);
      const b = await makeClient('b', server);
      const id = newLocalId();
      server.seed(entity, id, { title: 'Doomed', question: 'Doomed', name: 'Doomed', createdAt: server.now() });

      await a.pull();
      await b.pull();

      await a.edit(entity, id, { title: 'A still editing', name: 'A still editing', question: 'A still editing' });
      await b.remove(entity, id);

      await b.sync(); // the delete lands first
      await a.sync(); // A's edit arrives for a record that is now a tombstone
      await a.pull();
      await b.pull();

      // A hard delete would have let A's outbox re-INSERT this row. The tombstone
      // is what makes the delete win, on every client and on the server.
      expect(server.rows.get(`${entity}:${id}`)?.deletedAt).not.toBeNull();
      expect(await a.live(entity)).toHaveLength(0);
      expect(await b.live(entity)).toHaveLength(0);
    });
  }

  it('a notebook and a note created inside it while offline both arrive, correctly linked', async () => {
    // Proves dependency ordering. The real server 400s a note whose notebookId it
    // has never seen, so pushing the note first would drop it.
    const a = await makeClient('a', server);
    const nbId = newLocalId();
    const noteId = newLocalId();

    await a.edit('note', noteId, { notebookId: nbId, title: 'Inside', createdAt: server.now() });
    await a.edit('notebook', nbId, { name: 'New offline notebook', createdAt: server.now() });

    // Ordering comes from OUTBOX_ORDER, not from the order they were written.
    const order = (await drainOrder(a.db)).map((e) => e.entity);
    expect(order).toEqual(['notebook', 'note']);

    await a.sync();
    expect(server.rows.get(`notebook:${nbId}`)).toBeDefined();
    expect(server.rows.get(`note:${noteId}`)?.data.notebookId).toBe(nbId);
  });

  it('a client an hour fast does not win a conflict it should lose', async () => {
    // Without clock correction this is exactly backwards: the fast client stamps a
    // later time and wins every race regardless of who actually edited last.
    const fast = await makeClient('fast', server, 60 * 60 * 1000);
    const normal = await makeClient('normal', server, 0);
    const id = newLocalId();
    server.seed('note', id, { title: 'Original', createdAt: server.now() });

    await fast.pull();   // both pulls also calibrate the offset
    await normal.pull();

    await fast.edit('note', id, { title: 'Fast edited FIRST' });
    await normal.edit('note', id, { title: 'Normal edited SECOND' });

    await fast.sync();
    await normal.sync();

    // The genuinely later edit wins, and the fast clock does not buy priority.
    expect(server.rows.get(`note:${id}`)?.data.title).toBe('Normal edited SECOND');
  });

  it('a client an hour slow still wins when it genuinely edited last', async () => {
    const slow = await makeClient('slow', server, -60 * 60 * 1000);
    const normal = await makeClient('normal2', server, 0);
    const id = newLocalId();
    server.seed('note', id, { title: 'Original', createdAt: server.now() });

    await slow.pull();
    await normal.pull();

    await normal.edit('note', id, { title: 'Normal edited FIRST' });
    await slow.edit('note', id, { title: 'Slow edited SECOND' });

    await normal.sync();
    await slow.sync();

    expect(server.rows.get(`note:${id}`)?.data.title).toBe('Slow edited SECOND');
  });

  it('an interrupted first sync resumes without duplicating or dropping records', async () => {
    // A page limit of 5 over 12 records means three pages, so an interruption
    // partway through is reachable at all - which is the whole point. With the
    // default 500 the entire library arrives in one page and this tests nothing.
    const a = await makeClient('a', server, 0, 5);
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const id = newLocalId();
      ids.push(id);
      server.seed('note', id, { title: `Note ${i}`, createdAt: server.now() });
    }

    // Drop the second page mid-pull.
    server.failPageOnce = 2;
    await expect(a.pull()).rejects.toThrow('network dropped mid-sync');

    // Resume. The cursor persisted with the records it came with, so this picks up
    // where it stopped rather than starting over.
    await a.pull();

    const live = await a.live('note');
    expect(live).toHaveLength(12);
    expect(new Set(live.map((n) => (n as { id: string }).id)).size).toBe(12);
    expect(live.map((n) => (n as { title: string }).title).sort()).toEqual(
      ids.map((_, i) => `Note ${i}`).sort(),
    );
  });
});
