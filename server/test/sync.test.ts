import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { encodeCursor, decodeCursor } from '../src/lib/syncCursor.js';
import { DEFAULT_SYNC_LIMIT, MAX_SYNC_LIMIT } from '../src/lib/syncLimits.js';
import { resetDatabase, resetData, makeUser, closeDatabase, type TestUser } from './helpers.js';

const app = buildApp();

let user: TestUser;
let api: TestUser['agent'];

beforeAll(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetData();
  user = await makeUser(app);
  api = user.agent;
});

afterAll(async () => {
  await closeDatabase();
});

describe('sync cursor', () => {
  it('round-trips', () => {
    const c = { updatedAt: '2026-08-09T10:00:00.000Z', id: 'abc123def456gh' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it('rejects malformed input rather than throwing', () => {
    expect(decodeCursor('not-a-cursor')).toBeNull();
    expect(decodeCursor('')).toBeNull();
    // A cursor whose timestamp is not ISO-8601 would silently order wrongly.
    expect(decodeCursor(Buffer.from('nope|abc123def456gh').toString('base64url'))).toBeNull();
  });

  it('survives an id containing the separator', () => {
    // Defensive: ids are [a-z0-9] today, but a cursor that can be forged into a
    // different (updatedAt, id) pair is a sync-skipping bug waiting to happen.
    const c = { updatedAt: '2026-08-09T10:00:00.000Z', id: 'a|b|c' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });
});

/**
 * The server declares the sync limits locally instead of importing them, because a
 * runtime import from server/src into web/ would be bundled into api/index.ts by the
 * Vercel build - a deployment hazard this project has already been bitten by. Only
 * `import type` (fully erased) crosses that boundary in the shipped code.
 *
 * A test is free to import the real thing, and this is the check that stops the two
 * copies drifting: it fails the moment either side changes a number alone.
 */
describe('local sync limits match the shared contract', () => {
  it('equals the values in web/src/lib/sync/contract.ts', async () => {
    const contract = await import('../../web/src/lib/sync/contract.js');
    expect(DEFAULT_SYNC_LIMIT).toBe(contract.DEFAULT_SYNC_LIMIT);
    expect(MAX_SYNC_LIMIT).toBe(contract.MAX_SYNC_LIMIT);
  });
});

describe('GET /api/sync/changes', () => {
  it('returns a notebook and note the caller owns, and a usable cursor', async () => {
    const nb = await api.post('/api/notebooks').send({ name: 'Sync' });
    await api.post('/api/notes').send({ notebookId: nb.body.notebook.id, title: 'One' });

    const first = await api.get('/api/sync/changes?limit=1');
    expect(first.status).toBe(200);
    expect(first.body.hasMore).toBe(true);
    expect(first.body.cursor).toBeTruthy();
    expect(typeof first.body.serverNow).toBe('string');

    const second = await api.get(`/api/sync/changes?since=${encodeURIComponent(first.body.cursor)}`);
    expect(second.status).toBe(200);

    const ids = [
      ...(first.body.changes.notebook ?? []), ...(first.body.changes.note ?? []),
      ...(second.body.changes.notebook ?? []), ...(second.body.changes.note ?? []),
    ].map((r: { id: string }) => r.id);
    // Paging must not duplicate or drop.
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(2);
  });

  it('never returns another account\'s rows', async () => {
    const other = await makeUser(app);
    const nb = await api.post('/api/notebooks').send({ name: 'Private' });
    await api.post('/api/notes').send({ notebookId: nb.body.notebook.id, title: 'Secret' });

    const res = await other.agent.get('/api/sync/changes');
    expect(res.status).toBe(200);
    const titles = (res.body.changes.note ?? []).map((n: { title: string }) => n.title);
    expect(titles).not.toContain('Secret');
    expect(res.body.changes.notebook ?? []).toHaveLength(0);
  });

  it('a malformed cursor starts from the beginning rather than erroring', async () => {
    const nb = await api.post('/api/notebooks').send({ name: 'Restart' });
    expect(nb.status).toBe(201);

    const res = await api.get('/api/sync/changes?since=garbage');
    expect(res.status).toBe(200);
    // "From the beginning" is the load-bearing half: a client wedged on a cursor it
    // cannot fix would otherwise sync nothing, forever, with a 200 to show for it.
    expect((res.body.changes.notebook ?? []).map((n: { id: string }) => n.id)).toContain(nb.body.notebook.id);
  });

  it('carries the canvas and ink tables, which are scoped through notes', async () => {
    const nb = await api.post('/api/notebooks').send({ name: 'Board' });
    const note = await api.post('/api/notes').send({ notebookId: nb.body.notebook.id, kind: 'canvas' });
    const noteId = note.body.note.id;

    const a = await api.post(`/api/canvas/${noteId}/items`).send({ kind: 'sticky', data: { text: 'A' } });
    const b = await api.post(`/api/canvas/${noteId}/items`).send({ kind: 'sticky', data: { text: 'B' } });
    expect(a.status).toBe(201);
    const edge = await api.post(`/api/canvas/${noteId}/edges`).send({ from: a.body.item.id, to: b.body.item.id });
    expect(edge.status).toBe(201);
    await api.post(`/api/canvas/${noteId}/ink`).send({ strokes: [{ points: [[0, 0, 1]], color: '#000', width: 2, tool: 'pen' }] });

    const res = await api.get('/api/sync/changes');
    expect(res.status).toBe(200);
    expect((res.body.changes.canvasItem ?? []).length).toBe(2);
    expect((res.body.changes.canvasEdge ?? []).length).toBe(1);
    expect((res.body.changes.ink ?? []).length).toBe(1);
    // Joined queries reference notes, which has its own updated_at and id - the reason
    // every predicate in those sources is table-qualified.
    for (const item of res.body.changes.canvasItem) {
      expect(item.noteId).toBe(noteId);
      expect(typeof item.updatedAt).toBe('string');
    }
  });

  it('reports a tombstoned note as a delete notice rather than omitting it', async () => {
    const nb = await api.post('/api/notebooks').send({ name: 'Trash' });
    const note = await api.post('/api/notes').send({ notebookId: nb.body.notebook.id, title: 'Doomed' });
    await api.delete(`/api/notes/${note.body.note.id}`);

    const res = await api.get('/api/sync/changes');
    const row = (res.body.changes.note ?? []).find((n: { id: string }) => n.id === note.body.note.id);
    expect(row).toBeTruthy();
    expect(row.deletedAt).toBeTruthy();
  });

  it('clamps an absurd limit instead of honouring it', async () => {
    const res = await api.get(`/api/sync/changes?limit=${MAX_SYNC_LIMIT * 100}`);
    expect(res.status).toBe(200);
    const bad = await api.get('/api/sync/changes?limit=not-a-number');
    expect(bad.status).toBe(200);
  });

  it('401s without a session', async () => {
    const res = await request(app).get('/api/sync/changes');
    expect(res.status).toBe(401);
  });
});
