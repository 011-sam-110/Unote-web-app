import { describe, expect, it } from 'vitest';
import { bibliographyText, buildBibliography, isNumericStyle } from './bibliography';
import type { SourceRecord } from './types';

function source(id: string, csl: Record<string, unknown>): SourceRecord {
  return {
    id,
    kind: 'journal',
    csl,
    createdAt: '',
    updatedAt: '',
    verdict: { state: 'unconfirmed', registry: null, evidence: '', checkedAt: '' },
  };
}

const WATSON = source('w', {
  type: 'journal-article',
  title: 'Molecular structure of nucleic acids',
  author: [{ family: 'Watson', given: 'James D.' }],
  'container-title': 'Nature',
  issued: { 'date-parts': [[1953]] },
});
const ANON_WEBPAGE = source('a', {
  type: 'webpage',
  title: 'Climate change: the evidence',
  URL: 'https://example.org/climate',
  issued: { 'date-parts': [[2021]] },
});
const DOSTOYEVSKY = source('d', {
  type: 'book',
  title: 'Crime and punishment',
  author: [{ family: 'Dostoyevsky', given: 'Fyodor' }],
  publisher: 'Penguin',
  issued: { 'date-parts': [[2003]] },
});

describe('buildBibliography', () => {
  it('files an unattributed source under its TITLE, in among the authors', () => {
    // "Climate change" (no author) must land between nothing and Dostoyevsky - filed under
    // C, not blocked at the top under the "(" or the year its rendering starts with.
    const entries = buildBibliography([WATSON, ANON_WEBPAGE, DOSTOYEVSKY], 'harvard');
    expect(entries.map((e) => e.source.id)).toEqual(['a', 'd', 'w']);
  });

  it('really files by title rather than by year - the case that caught the first version', () => {
    // Both unattributed. A key that kept the leading year would order these by year; a
    // reference list orders them by title.
    const later = source('later', { type: 'book', title: 'Aardvarks', publisher: 'X', issued: { 'date-parts': [[2020]] } });
    const earlier = source('earlier', { type: 'book', title: 'Zebras', publisher: 'X', issued: { 'date-parts': [[1990]] } });
    expect(buildBibliography([earlier, later], 'harvard').map((e) => e.source.id)).toEqual(['later', 'earlier']);
  });

  it('breaks a tie between one author’s works by year', () => {
    const newer = source('n', { type: 'book', title: 'B side', author: [{ family: 'Smith' }], publisher: 'X', issued: { 'date-parts': [[2020]] } });
    const older = source('o', { type: 'book', title: 'A side', author: [{ family: 'Smith' }], publisher: 'X', issued: { 'date-parts': [[1999]] } });
    expect(buildBibliography([newer, older], 'harvard').map((e) => e.source.id)).toEqual(['o', 'n']);
  });

  it('files an organisation under its own name', () => {
    const who = source('w2', { type: 'report', title: 'Air quality', author: [{ literal: 'World Health Organization' }], publisher: 'WHO', issued: { 'date-parts': [[2021]] } });
    const abc = source('abc', { type: 'book', title: 'Anything', author: [{ family: 'Abbott' }], publisher: 'X', issued: { 'date-parts': [[2021]] } });
    expect(buildBibliography([who, abc], 'harvard').map((e) => e.source.id)).toEqual(['abc', 'w2']);
  });

  it('ignores a leading article when filing', () => {
    const theThing = source('t', { type: 'book', title: 'The aardvark question', publisher: 'X', issued: { 'date-parts': [[2000]] } });
    const bee = source('b', { type: 'book', title: 'Bee keeping', publisher: 'X', issued: { 'date-parts': [[2000]] } });
    expect(buildBibliography([bee, theThing], 'harvard').map((e) => e.source.id)).toEqual(['t', 'b']);
  });

  it('numbers entries from one', () => {
    const entries = buildBibliography([WATSON, DOSTOYEVSKY], 'harvard');
    expect(entries.map((e) => e.number)).toEqual([1, 2]);
  });

  it('KEEPS list order for Vancouver, because the number is the citation', () => {
    // Sorting a numeric style alphabetically would renumber every citation in the document.
    const entries = buildBibliography([WATSON, ANON_WEBPAGE, DOSTOYEVSKY], 'vancouver');
    expect(entries.map((e) => e.source.id)).toEqual(['w', 'a', 'd']);
    expect(entries.map((e) => e.number)).toEqual([1, 2, 3]);
  });

  it('knows which styles are numeric', () => {
    expect(isNumericStyle('vancouver')).toBe(true);
    for (const s of ['harvard', 'apa', 'mla', 'chicago'] as const) expect(isNumericStyle(s)).toBe(false);
  });

  it('handles an empty library', () => {
    expect(buildBibliography([], 'harvard')).toEqual([]);
    expect(bibliographyText([], 'harvard')).toBe('');
  });
});

describe('bibliographyText', () => {
  it('is one entry per line for an author-date style', () => {
    const text = bibliographyText(buildBibliography([WATSON, DOSTOYEVSKY], 'harvard'), 'harvard');
    expect(text.split('\n')).toHaveLength(2);
    expect(text).not.toMatch(/^\d+\./);
  });

  it('numbers the lines for a numeric style', () => {
    const text = bibliographyText(buildBibliography([WATSON, DOSTOYEVSKY], 'vancouver'), 'vancouver');
    expect(text.split('\n')[0].startsWith('1. ')).toBe(true);
    expect(text.split('\n')[1].startsWith('2. ')).toBe(true);
  });
});
