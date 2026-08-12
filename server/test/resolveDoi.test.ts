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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

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

  it('sends a User-Agent identifying the app, not the bare runtime default', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(CSL), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await resolveDoi('10.1038/nature12373');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const ua = (init.headers as Record<string, string>)['User-Agent'];
    expect(ua).toBeTruthy();
    expect(ua).toMatch(/Unote-Referencing/);
  });

  it('reports a fabricated DOI as not found, with a reason', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Resource not found.', { status: 404 })));
    const out = await resolveDoi('10.1016/j.cell.2019.99999');
    expect(out.found).toBe(false);
    expect(out.reason).toMatch(/did not resolve/i);
    expect(out.reason).not.toMatch(/could not reach|cannot be fetched|unreadable/i);
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

  it('treats a registry 500 as unreachable, not as a refuted DOI', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Internal Server Error', { status: 500 })));
    const out = await resolveDoi('10.1/x');
    expect(out.found).toBe(false);
    expect(out.reason).toMatch(/could not reach|cannot be fetched|unreadable/i);
    expect(out.reason).not.toMatch(/did not resolve/i);
  });

  it('treats a malformed JSON body as unreachable, not as a refuted DOI', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{not json', { status: 200 })));
    const out = await resolveDoi('10.1/x');
    expect(out.found).toBe(false);
    expect(out.reason).toMatch(/could not reach|cannot be fetched|unreadable/i);
    expect(out.reason).not.toMatch(/did not resolve/i);
  });

  it('gives up on a hanging registry instead of blocking the function forever', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
    }));
    vi.stubGlobal('fetch', fetchMock);

    const resultPromise = resolveDoi('10.1/x');
    await vi.advanceTimersByTimeAsync(8_000);
    const out = await resultPromise;

    expect(out.found).toBe(false);
    expect(out.reason).toMatch(/could not reach/i);
  });

  it('encodes characters that would otherwise break URL parsing, without escaping the DOI slash', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(CSL), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await resolveDoi('10.1000/abc#frag?query%stray');

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://doi.org/10.1000/abc%23frag%3Fquery%25stray');
  });
});
