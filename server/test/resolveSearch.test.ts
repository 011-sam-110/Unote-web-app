import { describe, it, expect, vi, afterEach } from 'vitest';
import { searchWorks } from '../src/lib/references/resolvers/search.js';

const PAYLOAD = {
  message: {
    'total-results': 1431102,
    items: [
      { DOI: '10.1111/1467-8721.00160', title: ['Working Memory Capacity as Executive Attention'],
        author: [{ given: 'Randall W.', family: 'Engle' }], issued: { 'date-parts': [[2002, 2]] },
        'container-title': ['Current Directions in Psychological Science'] },
      { DOI: '10.21236/ada422215', title: ['Individual Differences in Working Memory Capacity'],
        author: [{ family: 'Engle' }], issued: { 'date-parts': [[2004, 2, 18]] } },
    ],
  },
};

afterEach(() => vi.unstubAllGlobals());

describe('searchWorks', () => {
  it('returns candidates with a DOI so a title becomes verifiable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(PAYLOAD), { status: 200 })));
    const out = await searchWorks('working memory capacity executive attention');
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      title: 'Working Memory Capacity as Executive Attention',
      year: 2002,
      doi: '10.1111/1467-8721.00160',
      containerTitle: 'Current Directions in Psychological Science',
    });
    expect(out[0].authors).toEqual(['Randall W. Engle']);
  });

  it('sends the query as query.bibliographic and caps rows', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(PAYLOAD), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await searchWorks('some title', 5);
    const url = String((fetchMock.mock.calls[0] as [string])[0]);
    expect(url).toContain('query.bibliographic=some+title');
    expect(url).toContain('rows=5');
  });

  it('returns an empty list rather than throwing when the registry is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await searchWorks('anything')).toEqual([]);
  });

  it('drops a candidate with no DOI, since it could never be verified', async () => {
    const noDoi = { message: { items: [{ title: ['Untraceable'], author: [] }] } };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(noDoi), { status: 200 })));
    expect(await searchWorks('x')).toEqual([]);
  });
});
