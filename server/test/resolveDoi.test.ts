import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveDoi } from '../src/lib/references/resolvers/doi.js';

const CSL = {
  type: 'article-journal',
  title: 'Nanometre-scale thermometry in a living cell',
  'container-title': 'Nature',
  issued: { 'date-parts': [[2013, 7, 31]] },
  author: [{ given: 'G.', family: 'Kucsko' }],
  volume: '500',
  page: '54-58',
  DOI: '10.1038/nature12373',
};

afterEach(() => vi.unstubAllGlobals());

describe('resolveDoi', () => {
  it('asks doi.org for CSL-JSON and returns it unchanged', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(CSL), {
      status: 200, headers: { 'content-type': 'application/vnd.citationstyles.csl+json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const out = await resolveDoi('10.1038/nature12373');

    expect(out.found).toBe(true);
    expect(out.registry).toBe('doi.org');
    expect(out.csl?.title).toBe('Nanometre-scale thermometry in a living cell');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://doi.org/10.1038/nature12373');
    expect((init.headers as Record<string, string>).Accept).toContain('vnd.citationstyles.csl+json');
  });

  it('reports a fabricated DOI as not found, with a reason', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Resource not found.', { status: 404 })));
    const out = await resolveDoi('10.1016/j.cell.2019.99999');
    expect(out.found).toBe(false);
    expect(out.reason).toMatch(/did not resolve/i);
  });

  it('lists fields the registry did not supply rather than inventing them', async () => {
    const partial = { type: 'article-journal', title: 'A paper', DOI: '10.1/x' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(partial), { status: 200 })));
    const out = await resolveDoi('10.1/x');
    expect(out.missing).toContain('author');
    expect(out.missing).toContain('issued');
    expect(out.csl?.author).toBeUndefined();
  });

  it('treats a network failure as unreachable, not as not-found', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ENOTFOUND'); }));
    const out = await resolveDoi('10.1/x');
    expect(out.found).toBe(false);
    expect(out.reason).toMatch(/could not reach/i);
  });
});
