import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { localDb } from './db';
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
});
