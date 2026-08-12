// Adding a reading list in one go.
//
// A student gets given sources a list at a time - a module reading list, the bibliography
// of a paper they are working from - and adding twelve of them one dialog at a time is the
// reason people give up on reference managers. This resolves a pasted list line by line.
//
// WHAT IT DELIBERATELY WILL NOT DO IS PICK FOR YOU. A line that is a title rather than an
// identifier comes back from the server as a set of candidates, and choosing the first one
// because it is first is precisely the failure this feature exists to prevent: it would
// produce a confident, registry-blessed-looking citation for a paper the student never
// read, at twelve times the rate the single-source flow could. Those lines are marked as
// needing a decision and are excluded from the bulk save, and the student opens them one at
// a time. Slower, and the only honest option.
import type { Csl, ResolveResponse } from './types';

/** No more than this per paste. The endpoints behind it are authenticated outbound-fetch
 *  primitives with no rate limiting of their own, and a pasted 300-line bibliography would
 *  be a request flood with a student's name on it. */
export const MAX_BULK_LINES = 25;

export type BulkStatus = 'pending' | 'resolving' | 'found' | 'nothing' | 'choose' | 'error';

export interface BulkRow {
  id: number;
  query: string;
  status: BulkStatus;
  /** Set once resolved and found. */
  kind?: string;
  csl?: Csl;
  registry?: string;
  missing: string[];
  /** Why nothing came back - the server's own words, never re-classified here. */
  reason?: string;
  /** Whether this row will be saved. Only a `found` row can be. */
  selected: boolean;
}

/**
 * Split a pasted block into lines worth looking up.
 *
 * Blank lines go, duplicates go (pasting a list twice is common and saving a source twice
 * is never what was meant), and numeric list markers go - a reading list pasted out of a
 * PDF arrives as "1. 10.1038/nature12373", and the leading "1." would be read as part of
 * the identifier.
 */
export function parseBulkInput(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw
      .trim()
      // A list marker: "1.", "1)", "[1]", "-", "*", "•". Not a bare "10." - that could be
      // the start of a DOI, so a digit run followed by a full stop only counts as a marker
      // when what follows is not another digit.
      .replace(/^(?:[-*•]|\[\d{1,3}\]|\(\d{1,3}\)|\d{1,3}[.)](?!\d))\s+/, '')
      .trim();
    if (!line) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length >= MAX_BULK_LINES) break;
  }
  return out;
}

/** Turn one server answer into a row's outcome. The `query` kind is NEVER auto-resolved
 *  to its first candidate - see the header. */
export function rowFromResponse(row: BulkRow, res: ResolveResponse): BulkRow {
  if (res.kind === 'query') {
    return {
      ...row,
      status: res.candidates.length ? 'choose' : 'nothing',
      reason: res.candidates.length
        ? `${res.candidates.length} possible ${res.candidates.length === 1 ? 'match' : 'matches'} - this one needs you to pick`
        : 'no match for that title',
      selected: false,
    };
  }
  if (!res.found || !res.csl) {
    return { ...row, status: 'nothing', reason: res.reason ?? 'nothing came back', selected: false };
  }
  return {
    ...row,
    status: 'found',
    csl: res.csl,
    registry: res.registry,
    missing: res.missing ?? [],
    selected: true,
  };
}

export function bulkCounts(rows: BulkRow[]) {
  return {
    found: rows.filter((r) => r.status === 'found').length,
    choose: rows.filter((r) => r.status === 'choose').length,
    nothing: rows.filter((r) => r.status === 'nothing' || r.status === 'error').length,
    selected: rows.filter((r) => r.selected && r.status === 'found').length,
    done: rows.filter((r) => r.status !== 'pending' && r.status !== 'resolving').length,
  };
}
