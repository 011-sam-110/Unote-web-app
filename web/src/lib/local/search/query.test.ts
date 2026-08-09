// Parity with the server's search, one operator at a time.
//
// Every assertion here is on the SET of note ids, never the order. Order is the one
// thing offline search is allowed to get different - ts_rank and BM25 do not agree and
// were never going to - and pinning it would turn a documented difference into a test
// that fails for the wrong reason. What must not differ is which notes come back, and
// that is what each case checks.
//
// The expectations come from reading server/src/routes/search.ts against this corpus,
// not from running it. Where a case turns on something subtle in Postgres - a query
// that is nothing but stopwords, a trashed notebook's name - the reasoning is written
// out above the assertion so a reviewer can check the claim rather than the output.
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { localDb } from '../db';
import type { LocalNote, LocalNotebook } from '../records';
import { resetSearchIndex } from './index';
import { searchLocal } from './query';

function nb(id: string, name: string, deletedAt: string | null = null): LocalNotebook {
  return {
    id,
    name,
    emoji: '📓',
    color: '#78716c',
    position: 0,
    archived: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    deletedAt,
    baseUpdatedAt: null,
  };
}

interface NoteSeed {
  id: string;
  title: string;
  body: string;
  at: string;
  notebookId?: string;
  tags?: string[];
  archived?: number;
  deletedAt?: string | null;
}

function note(s: NoteSeed): LocalNote {
  return {
    id: s.id,
    notebookId: s.notebookId ?? 'nb-algo',
    title: s.title,
    contentJson: '{}',
    contentText: s.body,
    kind: 'doc',
    pinned: 0,
    archived: s.archived ?? 0,
    tags: s.tags ?? [],
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: s.at,
    deletedAt: s.deletedAt ?? null,
    baseUpdatedAt: null,
  };
}

/** The corpus every case below is read against. */
const NOTES: NoteSeed[] = [
  { id: 'n6', title: 'Deleted search', body: 'binary search tree', at: '2026-08-02T01:00:00.000Z', deletedAt: '2026-08-02T02:00:00.000Z' },
  { id: 'n5', title: 'Old search notes', body: 'binary search tree', at: '2026-08-02T02:00:00.000Z', archived: 1 },
  { id: 'n3', title: 'Mitochondria', body: 'The mitochondria is the powerhouse of the cell.', at: '2026-08-02T03:00:00.000Z', notebookId: 'nb-bio', tags: ['biology'] },
  { id: 'n2', title: 'Bubble sort', body: 'Bubble sort compares adjacent pairs and swaps them.', at: '2026-08-02T04:00:00.000Z', tags: ['week3'] },
  { id: 'n1', title: 'Binary search trees', body: 'A binary search tree keeps keys in order. Lookup is logarithmic.', at: '2026-08-02T05:00:00.000Z', tags: ['week3', 'algorithms'] },
  { id: 'n4', title: 'Search strategies', body: 'Depth first search and breadth first search.', at: '2026-08-02T06:00:00.000Z', tags: ['algorithms'] },
  { id: 'n7', title: 'Heapsort', body: '', at: '2026-08-02T07:00:00.000Z' },
  { id: 'n8', title: 'Scattered', body: 'A tree. Binary numbers. Search later.', at: '2026-08-02T08:00:00.000Z', notebookId: 'nb-bio' },
  { id: 'n9', title: 'Gradient descent', body: 'Backpropagation is the chain rule.', at: '2026-08-02T09:00:00.000Z', notebookId: 'nb-ml', tags: ['week3'] },
  { id: 'n10', title: 'Blocks', body: 'the loop terminates\nafterwards the buffer flushes', at: '2026-08-02T10:00:00.000Z', notebookId: 'nb-bio' },
  { id: 'n11', title: 'Filed away', body: 'archived notebook body', at: '2026-08-02T11:00:00.000Z', notebookId: 'nb-old' },
  { id: 'n12', title: 'Quicksort', body: 'stable in practice', at: '2026-08-02T12:00:00.000Z' },
  { id: 'n13', title: 'Pivots', body: 'quicksort partitions around a pivot', at: '2026-08-02T13:00:00.000Z' },
];

async function ids(q: string, limit?: number): Promise<string[]> {
  const hits = await searchLocal(q, limit);
  return hits.map((h) => h.note.id).sort();
}

describe('offline search', () => {
  beforeEach(async () => {
    await localDb.delete();
    await localDb.open();
    resetSearchIndex();
    await localDb.notebooks.bulkPut([
      nb('nb-algo', 'Algorithms'),
      nb('nb-bio', 'Biology'),
      nb('nb-ml', 'Machine Learning'),
      nb('nb-old', 'Archive', '2026-08-03T00:00:00.000Z'),
    ]);
    await localDb.notes.bulkPut(NOTES.map(note));
  });

  afterEach(() => resetSearchIndex());

  describe('the six operators', () => {
    it('bare terms', async () => {
      expect(await ids('search')).toEqual(['n1', 'n4', 'n8']);
    });

    it('bare terms are AND-ed', async () => {
      expect(await ids('binary search')).toEqual(['n1', 'n8']);
    });

    it('a phrase needs the words adjacent, not merely present', async () => {
      // n8 holds all three words - "A tree. Binary numbers. Search later." - and is the
      // whole reason MiniSearch alone is not enough here.
      expect(await ids('"binary search tree"')).toEqual(['n1']);
      expect(await ids('binary search tree')).toEqual(['n1', 'n8']);
    });

    it('-word removes a note that would otherwise match', async () => {
      expect(await ids('search -tree')).toEqual(['n4']);
    });

    it('tag: filters, and every tag: must match', async () => {
      expect(await ids('tag:week3')).toEqual(['n1', 'n2', 'n9']);
      expect(await ids('tag:week3 tag:algorithms')).toEqual(['n1']);
    });

    it('-tag: excludes', async () => {
      expect(await ids('search -tag:week3')).toEqual(['n4', 'n8']);
      expect(await ids('-tag:week3 notebook:Biology')).toEqual(['n10', 'n3', 'n8']);
    });

    it('notebook: is a case-insensitive prefix', async () => {
      expect(await ids('search notebook:Algorithms')).toEqual(['n1', 'n4']);
      expect(await ids('search notebook:alg')).toEqual(['n1', 'n4']);
    });

    it('notebook: takes a quoted name with a space in it', async () => {
      expect(await ids('notebook:"Machine Learning"')).toEqual(['n9']);
    });

    it('a trashed notebook is not a live filter', async () => {
      // The join is `nb.deleted_at IS NULL AND lower(nb.name) LIKE ...`, so the name of
      // a notebook in the bin matches nothing at all - not even the notes still in it.
      expect(await ids('notebook:Archive')).toEqual([]);
    });
  });

  describe('operators combined', () => {
    it('text, both tag forms and a notebook at once', async () => {
      expect(await ids('tree tag:week3 -tag:done notebook:Algorithms -bubble')).toEqual(['n1']);
    });

    it('a phrase with a tag filter', async () => {
      expect(await ids('"binary search tree" tag:algorithms')).toEqual(['n1']);
      expect(await ids('"binary search tree" tag:biology')).toEqual([]);
    });
  });

  describe('what must never come back', () => {
    it('a note tombstoned locally', async () => {
      expect(await ids('deleted')).toEqual([]);
    });

    it('an archived note', async () => {
      expect(await ids('old')).toEqual([]);
    });
  });

  describe('edges', () => {
    it('an empty query asks nothing', async () => {
      expect(await ids('')).toEqual([]);
      expect(await ids('   ')).toEqual([]);
    });

    it('a query of nothing but punctuation asks nothing', async () => {
      expect(await ids('--- !!!')).toEqual([]);
    });

    it('an operator on its own is a browse, not an error', async () => {
      expect(await ids('tag:biology')).toEqual(['n3']);
    });

    it('finds a word that appears only in the title', async () => {
      expect(await ids('heapsort')).toEqual(['n7']);
    });

    it('a phrase spans a block boundary, as it does server-side', async () => {
      // content_text joins blocks with a newline and to_tsvector numbers positions
      // straight through it, so 'terminates' <-> 'afterwards' matches on the server
      // too. Tokenising drops the newline here for the same reason.
      expect(await ids('"terminates afterwards"')).toEqual(['n10']);
    });

    it('a query of nothing but stopwords finds nothing, rather than everything', async () => {
      // to_tsquery('english', 'the:*') compiles to an empty tsquery, and `fts @@ ''`
      // is false - so the server answers this with no rows, not with the library.
      expect(await ids('the')).toEqual([]);
      expect(await ids('tag:week3 the')).toEqual([]);
    });

    it('a stopword alongside a real word is simply dropped', async () => {
      expect(await ids('the mitochondria')).toEqual(['n3']);
    });

    it('a phrase nothing matches', async () => {
      expect(await ids('"powerhouse of the fridge"')).toEqual([]);
    });

    it('respects the limit', async () => {
      expect(await ids('search', 1)).toHaveLength(1);
    });
  });

  describe('ranking', () => {
    it('a title hit outranks a body hit', async () => {
      // Not a parity assertion - the server's own order is ts_rank's and will differ.
      // This only pins that the title boost is actually wired up, which is what keeps
      // the two orders from diverging wildly.
      const hits = await searchLocal('quicksort');
      expect(hits.map((h) => h.note.id)).toEqual(['n12', 'n13']);
    });

    it('marks the match in the snippet', async () => {
      const hits = await searchLocal('mitochondria');
      expect(hits[0].snippetHtml).toContain('<mark>mitochondria</mark>');
    });
  });
});
