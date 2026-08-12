import { describe, expect, it } from 'vitest';
import { bulkCounts, MAX_BULK_LINES, parseBulkInput, rowFromResponse, type BulkRow } from './bulk';
import type { ResolveResponse } from './types';

const row = (query: string): BulkRow => ({ id: 0, query, status: 'pending', missing: [], selected: false });

describe('parseBulkInput', () => {
  it('takes one source per line and drops blanks', () => {
    expect(parseBulkInput('10.1/a\n\n  \n10.1/b')).toEqual(['10.1/a', '10.1/b']);
  });

  it('strips the numbering a reading list is pasted with', () => {
    expect(parseBulkInput('1. 10.1/a\n2) 10.1/b\n[3] 10.1/c\n- 10.1/d\n• 10.1/e')).toEqual([
      '10.1/a',
      '10.1/b',
      '10.1/c',
      '10.1/d',
      '10.1/e',
    ]);
  });

  it('does NOT mistake the start of a DOI for a list marker', () => {
    // A DOI begins "10." - stripping that as numbering would silently corrupt every DOI in
    // a pasted list into a lookup for its own suffix.
    expect(parseBulkInput('10.1038/nature12373')).toEqual(['10.1038/nature12373']);
    expect(parseBulkInput('10.1016/j.cell.2019.05.031')).toEqual(['10.1016/j.cell.2019.05.031']);
  });

  it('looks a repeated line up only once', () => {
    expect(parseBulkInput('10.1/a\n10.1/A\n10.1/a')).toEqual(['10.1/a']);
  });

  it('caps the paste, because each line is an outbound request', () => {
    const many = Array.from({ length: 60 }, (_, i) => `10.1/${i}`).join('\n');
    expect(parseBulkInput(many)).toHaveLength(MAX_BULK_LINES);
  });

  it('keeps a free-text title intact', () => {
    expect(parseBulkInput('Attention is all you need')).toEqual(['Attention is all you need']);
  });
});

describe('rowFromResponse', () => {
  it('marks a found identifier as savable and selects it', () => {
    const res: ResolveResponse = {
      kind: 'doi',
      found: true,
      csl: { title: 'A paper' },
      registry: 'doi.org',
      missing: ['publisher'],
      candidates: [],
    };
    const out = rowFromResponse(row('10.1/a'), res);
    expect(out.status).toBe('found');
    expect(out.selected).toBe(true);
    expect(out.missing).toEqual(['publisher']);
  });

  it('NEVER auto-picks a candidate for a title, however confident the search looks', () => {
    // Taking candidates[0] because it is first would manufacture a registry-blessed-looking
    // citation for a paper nobody read, at the rate of a whole pasted list at a time.
    const res: ResolveResponse = {
      kind: 'query',
      found: false,
      missing: [],
      candidates: [
        { title: 'Nearly right', authors: [], doi: '10.1/x' },
        { title: 'Also nearly right', authors: [], doi: '10.1/y' },
      ],
    };
    const out = rowFromResponse(row('some title'), res);
    expect(out.status).toBe('choose');
    expect(out.selected).toBe(false);
    expect(out.csl).toBeUndefined();
  });

  it('reports a title search with no candidates as nothing found', () => {
    const out = rowFromResponse(row('x'), { kind: 'query', found: false, missing: [], candidates: [] });
    expect(out.status).toBe('nothing');
    expect(out.selected).toBe(false);
  });

  it("keeps the server's own reason rather than re-classifying the failure", () => {
    const out = rowFromResponse(row('10.1/a'), {
      kind: 'doi',
      found: false,
      missing: [],
      reason: 'this DOI did not resolve',
      candidates: [],
    });
    expect(out.status).toBe('nothing');
    expect(out.reason).toBe('this DOI did not resolve');
  });

  it('does not treat a found response with no CSL as savable', () => {
    const out = rowFromResponse(row('10.1/a'), { kind: 'doi', found: true, csl: null, missing: [], candidates: [] });
    expect(out.status).toBe('nothing');
    expect(out.selected).toBe(false);
  });
});

describe('bulkCounts', () => {
  it('counts each outcome and what is actually going to be saved', () => {
    const rows: BulkRow[] = [
      { id: 0, query: 'a', status: 'found', missing: [], selected: true },
      { id: 1, query: 'b', status: 'found', missing: [], selected: false },
      { id: 2, query: 'c', status: 'choose', missing: [], selected: false },
      { id: 3, query: 'd', status: 'nothing', missing: [], selected: false },
      { id: 4, query: 'e', status: 'error', missing: [], selected: false },
      { id: 5, query: 'f', status: 'pending', missing: [], selected: false },
    ];
    expect(bulkCounts(rows)).toEqual({ found: 2, choose: 1, nothing: 2, selected: 1, done: 5 });
  });
});
