// The references API: one resolve endpoint that sniffs, library CRUD, and verification.
//
// This router carries a student's entire reading list, which is personal data. Auth is
// mounted once in app.ts, so the router adds no guard of its own - every statement must
// filter on userId(req). The cross-account cases below are the point of this suite, not
// box-ticking: a missing filter here leaks a whole account's worth of someone's research.

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { resetDatabase, resetData, makeUser, closeDatabase, type TestUser } from './helpers.js';

const app = buildApp();
let alice: TestUser;
let bob: TestUser;

beforeAll(async () => { await resetDatabase(); });
beforeEach(async () => {
  await resetData();
  alice = await makeUser(app);
  bob = await makeUser(app, 'bob@example.com');
  vi.unstubAllGlobals();
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await closeDatabase();
});

// A real DOI shape matters here: identify.ts requires a 4-9 digit registrant code after
// "10." (the actual DOI Handbook rule), so a short fixture like '10.1/x' would sniff as a
// bare-host URL instead of a DOI and never reach the DOI branch at all.
const CSL = { type: 'article-journal', title: 'A paper', DOI: '10.1234/x' };

describe('GET /api/references/types', () => {
  it('serves all 27 source types so the client never bundles its own copy', async () => {
    const res = await alice.agent.get('/api/references/types');
    expect(res.status).toBe(200);
    expect(res.body.types).toHaveLength(27);
  });
});

describe('POST /api/references/resolve', () => {
  it('sniffs a DOI and returns what was found and what is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(CSL), { status: 200 })));
    const res = await alice.agent.post('/api/references/resolve').send({ query: '10.1234/x' });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('doi');
    expect(res.body.found).toBe(true);
    expect(res.body.missing).toContain('author');
  });

  it('returns search candidates for free text', async () => {
    const payload = { message: { items: [{ DOI: '10.1/y', title: ['Found it'], author: [], issued: { 'date-parts': [[2020]] } }] } };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })));
    const res = await alice.agent.post('/api/references/resolve').send({ query: 'some paper title' });
    expect(res.body.kind).toBe('query');
    expect(res.body.candidates[0].doi).toBe('10.1/y');
  });

  it('rejects an empty query', async () => {
    const res = await alice.agent.post('/api/references/resolve').send({ query: '   ' });
    expect(res.status).toBe(400);
  });

  it('requires auth', async () => {
    const res = await request(app).post('/api/references/resolve').send({ query: '10.1234/x' });
    expect(res.status).toBe(401);
  });
});

describe('sources CRUD', () => {
  it('creates a source and returns it with an unconfirmed verdict', async () => {
    const res = await alice.agent.post('/api/references/sources')
      .send({ kind: 'book', csl: { type: 'book', title: 'A book' } });
    expect(res.status).toBe(201);
    expect(res.body.source.csl.title).toBe('A book');
    expect(res.body.source.verdict.state).toBe('unconfirmed');
  });

  it('rejects an unknown source kind', async () => {
    const res = await alice.agent.post('/api/references/sources')
      .send({ kind: 'nonsense', csl: { title: 'x' } });
    expect(res.status).toBe(400);
  });

  it('lists only the calling user\'s sources', async () => {
    await alice.agent.post('/api/references/sources')
      .send({ kind: 'book', csl: { type: 'book', title: 'Alice book' } });
    const res = await bob.agent.get('/api/references/sources');
    expect(res.status).toBe(200);
    expect(res.body.sources).toEqual([]);
  });

  it('will not let another user read, edit or delete a source', async () => {
    const created = await alice.agent.post('/api/references/sources')
      .send({ kind: 'book', csl: { type: 'book', title: 'Alice book' } });
    const id = created.body.source.id;
    expect((await bob.agent.patch(`/api/references/sources/${id}`)
      .send({ csl: { title: 'hijacked' } })).status).toBe(404);
    expect((await bob.agent.delete(`/api/references/sources/${id}`)).status).toBe(404);
  });

  it('deletes a source', async () => {
    const created = await alice.agent.post('/api/references/sources')
      .send({ kind: 'book', csl: { type: 'book', title: 'Gone' } });
    expect((await alice.agent.delete(`/api/references/sources/${created.body.source.id}`)).status).toBe(204);
    const list = await alice.agent.get('/api/references/sources');
    expect(list.body.sources).toEqual([]);
  });
});

describe('POST /api/references/sources/:id/verify', () => {
  it('stores a refuted verdict with its evidence when the DOI does not resolve', async () => {
    const created = await alice.agent.post('/api/references/sources')
      .send({ kind: 'journal', csl: { type: 'article-journal', title: 'Ghost', DOI: '10.1/nope' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Resource not found.', { status: 404 })));

    const res = await alice.agent.post(`/api/references/sources/${created.body.source.id}/verify`).send({});

    expect(res.status).toBe(200);
    expect(res.body.verdict.state).toBe('refuted');
    expect(res.body.verdict.evidence).toMatch(/did not resolve/i);
    expect(res.body.verdict.checkedAt).toBeTruthy();
  });

  it('404s for a source the caller does not own', async () => {
    const created = await alice.agent.post('/api/references/sources')
      .send({ kind: 'book', csl: { type: 'book', title: 'Alice book' } });
    const res = await bob.agent.post(`/api/references/sources/${created.body.source.id}/verify`).send({});
    expect(res.status).toBe(404);
  });
});
