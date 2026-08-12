import { describe, it, expect, vi, beforeEach } from 'vitest';

const resolveDoi = vi.fn();
const resolveIsbn = vi.fn();
const resolveWebpage = vi.fn();
vi.mock('../src/lib/references/resolvers/doi.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/references/resolvers/doi.js')>(
    '../src/lib/references/resolvers/doi.js',
  );
  return { ...actual, resolveDoi };
});
vi.mock('../src/lib/references/resolvers/isbn.js', () => ({ resolveIsbn }));
vi.mock('../src/lib/references/resolvers/webpage.js', () => ({ resolveWebpage }));

const { verifySource } = await import('../src/lib/references/verify.js');

beforeEach(() => vi.clearAllMocks());

describe('verifySource', () => {
  it('is UNCONFIRMED when there is no identifier to resolve against', async () => {
    const v = await verifySource({ type: 'book', title: 'Some lecture handout' });
    expect(v.state).toBe('unconfirmed');
    expect(v.registry).toBeNull();
    expect(v.evidence).toMatch(/nothing to check against/i);
    expect(resolveDoi).not.toHaveBeenCalled();
  });

  it('is VERIFIED when the DOI resolves and the title agrees', async () => {
    resolveDoi.mockResolvedValue({ found: true, registry: 'doi.org', missing: [],
      csl: { title: 'Nanometre-scale thermometry in a living cell', issued: { 'date-parts': [[2013]] } } });
    const v = await verifySource({ DOI: '10.1038/nature12373', title: 'Nanometre-scale thermometry in a living cell' });
    expect(v.state).toBe('verified');
    expect(v.registry).toBe('doi.org');
  });

  it('is REFUTED when the DOI does not resolve', async () => {
    resolveDoi.mockResolvedValue({ found: false, registry: 'doi.org', missing: [], reason: 'this DOI did not resolve' });
    const v = await verifySource({ DOI: '10.1016/j.cell.2019.99999', title: 'Anything' });
    expect(v.state).toBe('refuted');
    expect(v.evidence).toMatch(/did not resolve/i);
  });

  it('is REFUTED when the registry record contradicts the title', async () => {
    resolveDoi.mockResolvedValue({ found: true, registry: 'doi.org', missing: [],
      csl: { title: 'A completely different paper about geology' } });
    const v = await verifySource({ DOI: '10.1/x', title: 'Working memory capacity as executive attention' });
    expect(v.state).toBe('refuted');
    expect(v.evidence).toMatch(/different title/i);
  });

  it('is UNREACHABLE, never REFUTED, when the registry could not be reached', async () => {
    resolveDoi.mockResolvedValue({ found: false, registry: 'doi.org', missing: [], reason: 'could not reach doi.org' });
    const v = await verifySource({ DOI: '10.1/x', title: 'Anything' });
    expect(v.state).toBe('unreachable');
    expect(v.state).not.toBe('refuted');
  });

  it('tolerates punctuation, case and subtitle differences in the title', async () => {
    resolveDoi.mockResolvedValue({ found: true, registry: 'doi.org', missing: [],
      csl: { title: 'Working Memory Capacity as Executive Attention' } });
    const v = await verifySource({ DOI: '10.1/x', title: 'working memory capacity as executive attention.' });
    expect(v.state).toBe('verified');
  });

  it('stamps checkedAt as an ISO instant so a stored verdict states its own age', async () => {
    const v = await verifySource({ title: 'no identifier' }, new Date('2026-08-12T09:30:00Z'));
    expect(v.checkedAt).toBe('2026-08-12T09:30:00.000Z');
  });

  it('is UNREACHABLE, never REFUTED, when a URL-only source returns 403 (Cloudflare/bot protection, not a contradiction)', async () => {
    resolveWebpage.mockResolvedValue({ found: false, registry: 'webpage', missing: [], reason: 'could not reach: the page returned 403' });
    const v = await verifySource({ URL: 'https://example.com/article', title: 'Anything' });
    expect(v.state).toBe('unreachable');
    expect(v.state).not.toBe('refuted');
  });

  it('is REFUTED when a URL-only source returns 404 (nothing is at this URL)', async () => {
    resolveWebpage.mockResolvedValue({ found: false, registry: 'webpage', missing: [], reason: 'the page returned 404' });
    const v = await verifySource({ URL: 'https://example.com/gone', title: 'Anything' });
    expect(v.state).toBe('refuted');
  });

  it('is REFUTED when a URL-only source returns 410 (gone)', async () => {
    resolveWebpage.mockResolvedValue({ found: false, registry: 'webpage', missing: [], reason: 'the page returned 410' });
    const v = await verifySource({ URL: 'https://example.com/gone', title: 'Anything' });
    expect(v.state).toBe('refuted');
  });

  it('is UNCONFIRMED, never REFUTED, when a fetched webpage title does not match the claimed title, and names the page title found', async () => {
    resolveWebpage.mockResolvedValue({ found: true, registry: 'webpage', missing: [],
      csl: { title: 'Section | Site Name', URL: 'https://example.com/article' } });
    const v = await verifySource({ URL: 'https://example.com/article', title: 'How Glaciers Form' });
    expect(v.state).toBe('unconfirmed');
    expect(v.state).not.toBe('refuted');
    expect(v.evidence).toContain('Section | Site Name');
  });

  it('is UNCONFIRMED, not VERIFIED, when a webpage is reachable but has no comparable title', async () => {
    resolveWebpage.mockResolvedValue({ found: true, registry: 'webpage', missing: ['title'],
      csl: { URL: 'https://example.com/article' } });
    const v = await verifySource({ URL: 'https://example.com/article', title: 'How Glaciers Form' });
    expect(v.state).toBe('unconfirmed');
    expect(v.state).not.toBe('verified');
  });

  it('is VERIFIED when a fetched webpage title agrees with the claimed title', async () => {
    resolveWebpage.mockResolvedValue({ found: true, registry: 'webpage', missing: [],
      csl: { title: 'How Glaciers Form', URL: 'https://example.com/article' } });
    const v = await verifySource({ URL: 'https://example.com/article', title: 'How Glaciers Form' });
    expect(v.state).toBe('verified');
    expect(v.registry).toBe('webpage');
  });

  it('is VERIFIED when an ISBN-only source resolves successfully', async () => {
    resolveIsbn.mockResolvedValue({ found: true, registry: 'openlibrary.org', missing: [],
      csl: { title: 'Category Theory for Programmers' } });
    const v = await verifySource({ ISBN: '9780134757599', title: 'Category Theory for Programmers' });
    expect(v.state).toBe('verified');
    expect(v.registry).toBe('openlibrary.org');
  });

  it('is REFUTED when a fabricated subtitle is substituted onto a real DOI', async () => {
    resolveDoi.mockResolvedValue({ found: true, registry: 'doi.org', missing: [],
      csl: { title: 'Attention: A Cognitive Perspective' } });
    const v = await verifySource({ DOI: '10.1/x', title: 'Attention: A Fabricated Subtitle' });
    expect(v.state).toBe('refuted');
  });

  it('is REFUTED when the claimed title is a short unrelated word, not a genuine prefix', async () => {
    resolveDoi.mockResolvedValue({ found: true, registry: 'doi.org', missing: [],
      csl: { title: 'Category Theory for Programmers' } });
    const v = await verifySource({ DOI: '10.1/x', title: 'Cat' });
    expect(v.state).toBe('refuted');
  });

  it('is VERIFIED when an ampersand in the registry title matches "and" in the claimed title', async () => {
    resolveDoi.mockResolvedValue({ found: true, registry: 'doi.org', missing: [],
      csl: { title: 'Research & Development' } });
    const v = await verifySource({ DOI: '10.1/x', title: 'Research and Development' });
    expect(v.state).toBe('verified');
  });
});
