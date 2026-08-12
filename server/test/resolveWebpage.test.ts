import { describe, it, expect, vi, afterEach } from 'vitest';

const safeFetchMock = vi.fn();
vi.mock('../src/lib/references/safeFetch.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/references/safeFetch.js')>(
    '../src/lib/references/safeFetch.js',
  );
  return { ...actual, safeFetch: safeFetchMock };
});

const { resolveWebpage } = await import('../src/lib/references/resolvers/webpage.js');
const { SsrfBlocked } = await import('../src/lib/references/safeFetch.js');

const HTML = `<!doctype html><html><head>
  <title>Fallback title</title>
  <meta property="og:title" content="Climate change: the evidence">
  <meta property="og:site_name" content="BBC News">
  <meta property="article:published_time" content="2021-04-22T10:00:00Z">
  <meta name="author" content="Matt McGrath">
</head><body></body></html>`;

afterEach(() => vi.clearAllMocks());

describe('resolveWebpage', () => {
  it('prefers og:title over the document title', async () => {
    safeFetchMock.mockResolvedValue({ ok: true, status: 200, finalUrl: 'https://bbc.co.uk/n', body: HTML, contentType: 'text/html' });
    const out = await resolveWebpage('https://bbc.co.uk/n', new Date('2026-08-12T00:00:00Z'));
    expect(out.found).toBe(true);
    expect(out.csl?.title).toBe('Climate change: the evidence');
    expect(out.csl?.['container-title']).toBe('BBC News');
    expect(out.csl?.author).toEqual([{ literal: 'Matt McGrath' }]);
    expect(out.csl?.issued).toEqual({ 'date-parts': [[2021, 4, 22]] });
  });

  it('always stamps date accessed, because that is a fact about us not the page', async () => {
    safeFetchMock.mockResolvedValue({ ok: true, status: 200, finalUrl: 'https://x.com/', body: '<html></html>', contentType: 'text/html' });
    const out = await resolveWebpage('https://x.com/', new Date('2026-08-12T00:00:00Z'));
    expect(out.csl?.accessed).toEqual({ 'date-parts': [[2026, 8, 12]] });
  });

  it('reports the fields it could not find instead of inventing them', async () => {
    safeFetchMock.mockResolvedValue({ ok: true, status: 200, finalUrl: 'https://x.com/', body: '<html><head><title>Just a title</title></head></html>', contentType: 'text/html' });
    const out = await resolveWebpage('https://x.com/');
    expect(out.csl?.title).toBe('Just a title');
    expect(out.missing).toEqual(expect.arrayContaining(['author', 'issued']));
    expect(out.csl?.author).toBeUndefined();
  });

  it('surfaces an SSRF block as not-found with a safe reason', async () => {
    safeFetchMock.mockRejectedValue(new SsrfBlocked('resolves to a blocked address'));
    const out = await resolveWebpage('http://169.254.169.254/');
    expect(out.found).toBe(false);
    expect(out.reason).toMatch(/cannot be fetched/i);
    expect(out.reason).not.toMatch(/169\.254/);
  });

  it('treats a 404 page as not found', async () => {
    safeFetchMock.mockResolvedValue({ ok: false, status: 404, finalUrl: 'https://x.com/', body: '', contentType: 'text/html' });
    const out = await resolveWebpage('https://x.com/');
    expect(out.found).toBe(false);
    expect(out.reason).toMatch(/404/);
  });
});
