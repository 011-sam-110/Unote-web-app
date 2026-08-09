import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import Dexie from 'dexie';
import { LocalDb, localDb } from './db';
import { newLocalId } from './records';

describe('local store', () => {
  beforeEach(async () => {
    await localDb.delete();
    await localDb.open();
  });

  it('generates ids the server will accept unchanged', () => {
    for (let i = 0; i < 50; i++) expect(newLocalId()).toMatch(/^[a-z0-9]{14}$/);
  });

  it('round-trips a note', async () => {
    const id = newLocalId();
    await localDb.notes.put({
      id, notebookId: 'nb', title: 'Hello', contentJson: '{}', contentText: 'Hello',
      kind: 'doc', pinned: 0, archived: 0, tags: [], createdAt: '2026-08-09T10:00:00.000Z',
      updatedAt: '2026-08-09T10:00:00.000Z', deletedAt: null, baseUpdatedAt: null,
    });
    expect((await localDb.notes.get(id))?.title).toBe('Hello');
  });

  it('indexes notes by notebook and excludes tombstones by hand', async () => {
    // Dexie cannot index "deletedAt IS NULL", so every read path has to filter it.
    // Asserting it here is what stops a deleted note reappearing in a list.
    const live = newLocalId();
    const dead = newLocalId();
    const common = {
      notebookId: 'nb', contentJson: '{}', contentText: '', kind: 'doc', pinned: 0,
      archived: 0, tags: [], createdAt: '2026-08-09T10:00:00.000Z',
      updatedAt: '2026-08-09T10:00:00.000Z', baseUpdatedAt: null,
    };
    await localDb.notes.bulkPut([
      { ...common, id: live, title: 'Live', deletedAt: null },
      { ...common, id: dead, title: 'Dead', deletedAt: '2026-08-09T11:00:00.000Z' },
    ]);
    const rows = await localDb.notes.where('notebookId').equals('nb').toArray();
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.deletedAt === null).map((r) => r.title)).toEqual(['Live']);
  });

  it('indexes canvas items and ink by note', async () => {
    const noteId = newLocalId();
    const at = '2026-08-09T10:00:00.000Z';
    await localDb.canvasItems.put({
      id: newLocalId(), noteId, kind: 'sticky', x: 0, y: 0, width: 220, height: 160,
      rotation: 0, z: 1, data: '{"text":"hi"}', createdAt: at, updatedAt: at,
      deletedAt: null, baseUpdatedAt: null,
    });
    await localDb.ink.put({
      id: newLocalId(), noteId, stroke: '{"points":[[0,0,0.5]]}', createdAt: at,
      updatedAt: at, deletedAt: null, baseUpdatedAt: null,
    });
    expect(await localDb.canvasItems.where('noteId').equals(noteId).count()).toBe(1);
    expect(await localDb.ink.where('noteId').equals(noteId).count()).toBe(1);
  });
});

describe('the version 2 upgrade', () => {
  // THE test for the Stage 2 trap, and the reason it is written as an upgrade rather
  // than a schema assertion.
  //
  // Until version 2 the sync engine mirrored three tables and skipped canvas and ink
  // records - but skipping still advanced the cursor past them. Adding the tables
  // without clearing that cursor would leave every board and every stroke this
  // account already owns permanently behind it: the delta feed only ever answers
  // "what changed after here", and those rows did not change, they were passed over.
  //
  // The failure is silent. The boards simply never arrive, on every existing install.
  const NAME = 'unote-v1-with-a-cursor';

  /** A database exactly as an install that has already synced under Stage 1 holds it. */
  async function seedVersion1(): Promise<void> {
    const v1 = new Dexie(NAME);
    v1.version(1).stores({
      notebooks: 'id, position, updatedAt',
      notes: 'id, notebookId, updatedAt, title, *tags',
      flashcards: 'id, noteId, dueAt, updatedAt',
      reviews: 'id, cardId, reviewedAt',
      outbox: '++seq, [entity+recordId], entity',
      meta: 'key',
    });
    await v1.open();
    await v1.table('meta').put({ key: 'cursor', value: 'a-cursor-past-every-stroke' });
    await v1.table('meta').put({ key: 'initialSyncDone', value: '1' });
    await v1.table('meta').put({ key: 'clockOffsetMs', value: '0' });
    v1.close();
  }

  beforeEach(async () => {
    await Dexie.delete(NAME);
    await seedVersion1();
  });

  it('drops the cursor and initialSyncDone, forcing a full re-pull', async () => {
    const db = new LocalDb(NAME);
    await db.open();
    expect(db.verno).toBe(2);
    expect(await db.meta.get('cursor')).toBeUndefined();
    expect(await db.meta.get('initialSyncDone')).toBeUndefined();
    db.close();
  });

  it('leaves the rest of the meta table alone', async () => {
    // A blunt meta.clear() would also throw away the clock offset, and a client that
    // has forgotten how wrong its clock is loses conflicts it should win until the
    // next sync response arrives to recalibrate it.
    const db = new LocalDb(NAME);
    await db.open();
    expect((await db.meta.get('clockOffsetMs'))?.value).toBe('0');
    db.close();
  });

  it('gives the upgraded database the new tables', async () => {
    const db = new LocalDb(NAME);
    await db.open();
    expect(db.tables.map((t) => t.name).sort()).toContain('canvasItems');
    expect(await db.blobs.count()).toBe(0);
    db.close();
  });
});
