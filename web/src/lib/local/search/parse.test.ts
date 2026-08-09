// The grammar, pinned.
//
// This is the half of offline search that has to be IDENTICAL to the server rather
// than merely close: two parsers reading the same string differently means the two
// ends answer different questions and neither says so. Every case below is taken from
// the behaviour of parseSearchQuery in server/src/routes/search.ts.
import { describe, it, expect } from 'vitest';
import { cleanToken, indexTerm, parseSearchQuery, tokenise } from './parse';

const EMPTY = { terms: [], phrases: [], excluded: [], tags: [], excludedTags: [], notebook: null };

describe('parseSearchQuery', () => {
  it('reads barewords as AND-ed terms', () => {
    expect(parseSearchQuery('binary search')).toEqual({ ...EMPTY, terms: ['binary', 'search'] });
  });

  it('reads a quoted run as one phrase', () => {
    expect(parseSearchQuery('"binary search tree"')).toEqual({ ...EMPTY, phrases: ['binary search tree'] });
  });

  it('reads -word as an exclusion', () => {
    expect(parseSearchQuery('sort -bubble')).toEqual({ ...EMPTY, terms: ['sort'], excluded: ['bubble'] });
  });

  it('collects every tag: and every -tag:', () => {
    expect(parseSearchQuery('tag:week3 tag:algorithms -tag:done')).toEqual({
      ...EMPTY,
      tags: ['week3', 'algorithms'],
      excludedTags: ['done'],
    });
  });

  it('takes the first notebook: and ignores the rest', () => {
    expect(parseSearchQuery('notebook:Algorithms notebook:Biology')).toEqual({ ...EMPTY, notebook: 'Algorithms' });
  });

  it('keeps a quoted notebook name whole instead of reading it as a phrase', () => {
    // The regression the operator-before-phrase ordering exists to prevent: with the
    // phrase pass first, the quotes are stripped and "Machine Learning" falls through
    // as text, so the query silently answers a different question.
    expect(parseSearchQuery('notebook:"Machine Learning" gradient')).toEqual({
      ...EMPTY,
      notebook: 'Machine Learning',
      terms: ['gradient'],
    });
  });

  it('cleans a quoted tag value down to one token', () => {
    expect(parseSearchQuery('tag:"week 3"')).toEqual({ ...EMPTY, tags: ['week3'] });
  });

  it('drops an operator with an empty value rather than inventing one', () => {
    expect(parseSearchQuery('tag: notebook:')).toEqual(EMPTY);
  });

  it('survives punctuation soup with nothing to show for it', () => {
    expect(parseSearchQuery('--- !!! ""')).toEqual(EMPTY);
    expect(parseSearchQuery('')).toEqual(EMPTY);
  });

  it('mixes all six operators in one query', () => {
    expect(parseSearchQuery('tree "binary search" -bubble tag:week3 -tag:done notebook:Algo')).toEqual({
      terms: ['tree'],
      phrases: ['binary search'],
      excluded: ['bubble'],
      tags: ['week3'],
      excludedTags: ['done'],
      notebook: 'Algo',
    });
  });
});

describe('cleanToken', () => {
  it('keeps hyphens and apostrophes, which are part of the word', () => {
    expect(cleanToken('e-mail')).toBe('e-mail');
    expect(cleanToken("o'brien")).toBe("o'brien");
  });

  it('strips everything else and refuses a token with no letters or digits', () => {
    expect(cleanToken('hello!')).toBe('hello');
    expect(cleanToken('---')).toBe('');
    expect(cleanToken("'")).toBe('');
  });
});

describe('tokenise', () => {
  it('splits on exactly what cleanToken strips, so query and document agree', () => {
    expect(tokenise('A binary search tree; keys in order.')).toEqual(
      ['A', 'binary', 'search', 'tree', 'keys', 'in', 'order'],
    );
    expect(tokenise("e-mail o'brien")).toEqual(['e-mail', "o'brien"]);
  });
});

describe('indexTerm', () => {
  it('drops the stopwords Postgres drops, and lowercases the rest', () => {
    expect(indexTerm('The')).toBeNull();
    expect(indexTerm('of')).toBeNull();
    expect(indexTerm('Mitochondria')).toBe('mitochondria');
  });
});
