import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveIsbn } from '../src/lib/references/resolvers/isbn.js';

const BOOK = {
  title: 'Crime and punishment',
  publishers: ['Penguin'],
  publish_date: '2003',
  number_of_pages: 671,
  authors: [{ key: '/authors/OL22242A' }],
};
const AUTHOR = { name: 'Фёдор Достоевский', personal_name: 'Fyodor Mikhaylovich Dostoyevsky' };

function stub(map: Record<string, unknown>, status = 200) {
  return vi.fn(async (url: string) => {
    const body = map[url as string];
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('resolveIsbn', () => {
  it('resolves the author key to a name rather than shipping a bibliography with none', async () => {
    vi.stubGlobal('fetch', stub({
      'https://openlibrary.org/isbn/9780140449136.json': BOOK,
      'https://openlibrary.org/authors/OL22242A.json': AUTHOR,
    }));

    const out = await resolveIsbn('9780140449136');

    expect(out.found).toBe(true);
    expect(out.csl?.author).toEqual([{ literal: 'Fyodor Mikhaylovich Dostoyevsky' }]);
  });

  it('prefers personal_name so an English reference list does not get another script', async () => {
    vi.stubGlobal('fetch', stub({
      'https://openlibrary.org/isbn/9780140449136.json': BOOK,
      'https://openlibrary.org/authors/OL22242A.json': AUTHOR,
    }));
    const out = await resolveIsbn('9780140449136');
    expect(JSON.stringify(out.csl?.author)).not.toContain('Достоевский');
  });

  it('falls back to name when personal_name is absent', async () => {
    vi.stubGlobal('fetch', stub({
      'https://openlibrary.org/isbn/9780140449136.json': BOOK,
      'https://openlibrary.org/authors/OL22242A.json': { name: 'Ursula K. Le Guin' },
    }));
    const out = await resolveIsbn('9780140449136');
    expect(out.csl?.author).toEqual([{ literal: 'Ursula K. Le Guin' }]);
  });

  it('still returns the book when an author lookup fails, and reports author missing', async () => {
    vi.stubGlobal('fetch', stub({ 'https://openlibrary.org/isbn/9780140449136.json': BOOK }));
    const out = await resolveIsbn('9780140449136');
    expect(out.found).toBe(true);
    expect(out.csl?.title).toBe('Crime and punishment');
    expect(out.missing).toContain('author');
  });

  it('reports a fabricated ISBN as not found', async () => {
    vi.stubGlobal('fetch', stub({}));
    const out = await resolveIsbn('9780000000001');
    expect(out.found).toBe(false);
    expect(out.reason).toMatch(/no book/i);
    expect(out.reason).not.toMatch(/could not reach/i);
  });

  it('reports a thrown network error as unreachable, not as a nonexistent book', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed');
    }));
    const out = await resolveIsbn('9780140449136');
    expect(out.found).toBe(false);
    expect(out.reason).toMatch(/could not reach/i);
  });

  it('reports a registry 500 as unreachable, not as a nonexistent book', async () => {
    vi.stubGlobal('fetch', stub({ 'https://openlibrary.org/isbn/9780140449136.json': BOOK }, 500));
    const out = await resolveIsbn('9780140449136');
    expect(out.found).toBe(false);
    expect(out.reason).toMatch(/could not reach/i);
  });

  it('maps publish_date to a CSL issued date-part', async () => {
    vi.stubGlobal('fetch', stub({
      'https://openlibrary.org/isbn/9780140449136.json': BOOK,
      'https://openlibrary.org/authors/OL22242A.json': AUTHOR,
    }));
    const out = await resolveIsbn('9780140449136');
    expect(out.csl?.issued).toEqual({ 'date-parts': [[2003]] });
  });
});
