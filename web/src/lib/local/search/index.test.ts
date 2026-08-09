// The index's lifecycle: build, catch up, serialise, rehydrate, rebuild.
//
// The property worth defending is that a search can never be answered from an index
// older than the mirror. Everything else here - the cursor, the row count, the version
// stamp - exists only to make that true without rebuilding the whole thing per
// keystroke, so each is tested by the failure it is there to prevent.
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { localDb, readMeta, writeMeta } from '../db';
import type { LocalNote, SyncMetaRow } from '../records';
import { INDEX_VERSION, ensureSearchIndex, persistSearchIndex, resetSearchIndex } from './index';

const META_INDEX = 'searchIndex' as unknown as SyncMetaRow['key'];

function note(id: string, title: string, body: string, updatedAt: string): LocalNote {
  return {
    id,
    notebookId: 'nb',
    title,
    contentJson: '{}',
    contentText: body,
    kind: 'doc',
    pinned: 0,
    archived: 0,
    tags: [],
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt,
    deletedAt: null,
    baseUpdatedAt: null,
  };
}

async function found(term: string): Promise<string[]> {
  const mini = await ensureSearchIndex();
  return mini.search(term).map((r) => r.id as string).sort();
}

describe('the offline search index', () => {
  beforeEach(async () => {
    await localDb.delete();
    await localDb.open();
    resetSearchIndex();
  });

  it('builds from the mirror on first use', async () => {
    await localDb.notes.put(note('a', 'Mitochondria', 'the powerhouse', '2026-08-02T10:00:00.000Z'));
    expect(await found('mitochondria')).toEqual(['a']);
  });

  it('leaves out notes search cannot return', async () => {
    // GET /api/search filters archived = 0 AND deleted_at IS NULL, so these must never
    // reach the index - filtering them afterwards would still let them eat the limit.
    const archived = { ...note('arch', 'Kelvin', '', '2026-08-02T10:00:00.000Z'), archived: 1 };
    const gone = { ...note('dead', 'Kelvin', '', '2026-08-02T10:00:00.000Z'), deletedAt: '2026-08-03T00:00:00.000Z' };
    await localDb.notes.bulkPut([archived, gone, note('live', 'Kelvin', '', '2026-08-02T10:00:00.000Z')]);
    expect(await found('kelvin')).toEqual(['live']);
  });

  it('picks up a note written after the index was built', async () => {
    await localDb.notes.put(note('a', 'Mitochondria', '', '2026-08-02T10:00:00.000Z'));
    expect(await found('mitochondria')).toEqual(['a']);

    await localDb.notes.put(note('b', 'Ribosome', '', '2026-08-02T11:00:00.000Z'));
    expect(await found('ribosome')).toEqual(['b']);
  });

  it('picks up an edit to a note already indexed', async () => {
    await localDb.notes.put(note('a', 'Mitochondria', '', '2026-08-02T10:00:00.000Z'));
    expect(await found('mitochondria')).toEqual(['a']);

    await localDb.notes.put(note('a', 'Ribosome', '', '2026-08-02T11:00:00.000Z'));
    expect(await found('mitochondria')).toEqual([]);
    expect(await found('ribosome')).toEqual(['a']);
  });

  it('drops a note the moment it is tombstoned', async () => {
    await localDb.notes.put(note('a', 'Mitochondria', '', '2026-08-02T10:00:00.000Z'));
    expect(await found('mitochondria')).toEqual(['a']);

    await localDb.notes.put({
      ...note('a', 'Mitochondria', '', '2026-08-02T11:00:00.000Z'),
      deletedAt: '2026-08-02T11:00:00.000Z',
    });
    expect(await found('mitochondria')).toEqual([]);
  });

  it('picks up a note saved in the same millisecond as the newest one', async () => {
    // A high-water mark over updatedAt would have had to decide whether to re-read the
    // boundary; comparing per row does not have the question.
    const at = '2026-08-02T10:00:00.000Z';
    await localDb.notes.put(note('a', 'Mitochondria', '', at));
    expect(await found('mitochondria')).toEqual(['a']);

    await localDb.notes.put(note('b', 'Ribosome', '', at));
    expect(await found('ribosome')).toEqual(['b']);
  });

  it('picks up a note that arrives older than everything already indexed', async () => {
    // The case that rules out a high-water mark. A pull applies a record whose
    // updatedAt beats the LOCAL copy's, which says nothing about the newest note on
    // this device: anything another machine edited last week lands underneath the mark
    // and, with one, would never be indexed at all.
    await localDb.notes.put(note('recent', 'Mitochondria', '', '2026-08-09T10:00:00.000Z'));
    expect(await found('mitochondria')).toEqual(['recent']);

    await localDb.notes.put(note('older', 'Ribosome', '', '2026-06-01T09:00:00.000Z'));
    expect(await found('ribosome')).toEqual(['older']);
  });

  it('serialises into meta and reuses it instead of rebuilding', async () => {
    await localDb.notes.bulkPut([
      note('a', 'Mitochondria', '', '2026-08-02T10:00:00.000Z'),
      note('b', 'Ribosome', '', '2026-08-02T11:00:00.000Z'),
    ]);
    await ensureSearchIndex();
    await persistSearchIndex();
    expect(await readMeta(META_INDEX)).toContain(`"v":${INDEX_VERSION}`);

    resetSearchIndex();

    // Rewriting a row WITHOUT moving its updatedAt is not something the app can do -
    // every write goes through correctedNow() - and it is done here only to make the
    // difference visible: a rebuilt index would see the new title, a rehydrated one
    // reads the row as unchanged and still shows the old.
    await localDb.notes.put(note('a', 'Chloroplast', '', '2026-08-02T10:00:00.000Z'));
    expect(await found('mitochondria')).toEqual(['a']);
    expect(await found('chloroplast')).toEqual([]);
  });

  it('rebuilds rather than trusting a blob from another index version', async () => {
    await localDb.notes.put(note('a', 'Mitochondria', '', '2026-08-02T10:00:00.000Z'));
    await writeMeta(META_INDEX, JSON.stringify({ v: INDEX_VERSION + 1, cursor: 'zzz', rows: 99, mini: {} }));
    resetSearchIndex();

    expect(await found('mitochondria')).toEqual(['a']);
  });

  it('rebuilds rather than trusting a blob it cannot read', async () => {
    await localDb.notes.put(note('a', 'Mitochondria', '', '2026-08-02T10:00:00.000Z'));
    await writeMeta(META_INDEX, 'not json');
    resetSearchIndex();

    expect(await found('mitochondria')).toEqual(['a']);
  });

  it('empties itself when rows vanish without a tombstone', async () => {
    // A hard clear leaves nothing behind to announce itself - no tombstone, no bumped
    // timestamp. clearLocalStore() does exactly this after the guest handover.
    await localDb.notes.bulkPut([
      note('a', 'Mitochondria', '', '2026-08-02T10:00:00.000Z'),
      note('b', 'Ribosome', '', '2026-08-02T11:00:00.000Z'),
    ]);
    expect(await found('mitochondria')).toEqual(['a']);

    await localDb.notes.clear();
    expect(await found('mitochondria')).toEqual([]);
  });
});
