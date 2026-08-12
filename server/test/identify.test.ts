import { describe, it, expect } from 'vitest';
import { identify } from '../src/lib/references/identify.js';

describe('identify', () => {
  it('recognises a bare DOI', () => {
    expect(identify('10.1038/nature12373')).toEqual({ kind: 'doi', value: '10.1038/nature12373' });
  });

  it('strips a doi.org prefix and the doi: scheme', () => {
    expect(identify('https://doi.org/10.1038/nature12373').value).toBe('10.1038/nature12373');
    expect(identify('doi:10.1038/nature12373').value).toBe('10.1038/nature12373');
  });

  it('recognises ISBN-13 and ISBN-10 with or without hyphens', () => {
    expect(identify('978-0-14-044913-6')).toEqual({ kind: 'isbn', value: '9780140449136' });
    expect(identify('9780140449136').kind).toBe('isbn');
    expect(identify('0140449132').kind).toBe('isbn');
  });

  it('rejects an ISBN whose check digit is wrong, treating it as a query', () => {
    expect(identify('9780140449137').kind).toBe('query');
  });

  it('recognises a URL and normalises a bare host', () => {
    expect(identify('https://www.bbc.co.uk/news/abc').kind).toBe('url');
    expect(identify('www.bbc.co.uk/news/abc')).toEqual({ kind: 'url', value: 'https://www.bbc.co.uk/news/abc' });
  });

  it('falls back to a search query for a title', () => {
    expect(identify('working memory capacity executive attention'))
      .toEqual({ kind: 'query', value: 'working memory capacity executive attention' });
  });

  it('trims surrounding whitespace before deciding', () => {
    expect(identify('   10.1038/nature12373  ').kind).toBe('doi');
  });

  it('keeps a DOI whose own suffix ends in a balanced parenthesis (regression)', () => {
    expect(identify('10.1000/abc(1)')).toEqual({ kind: 'doi', value: '10.1000/abc(1)' });
  });

  it('strips a trailing full stop from a DOI mentioned in prose', () => {
    expect(identify('see 10.1038/nature12373.')).toEqual({ kind: 'doi', value: '10.1038/nature12373' });
  });

  it('strips an unbalanced trailing parenthesis picked up from surrounding prose', () => {
    expect(identify('(see 10.1038/nature12373)')).toEqual({ kind: 'doi', value: '10.1038/nature12373' });
  });

  it('does not classify an author-date citation as a URL', () => {
    expect(identify('Smith, J. 2020').kind).not.toBe('url');
  });

  it('does not classify a bare full-stop-terminated sentence as a URL', () => {
    expect(identify('This is not a website.').kind).not.toBe('url');
  });

  it('treats empty and whitespace-only input as an empty query', () => {
    expect(identify('')).toEqual({ kind: 'query', value: '' });
    expect(identify('   ')).toEqual({ kind: 'query', value: '' });
  });
});
