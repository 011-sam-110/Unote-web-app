// Clock skew decides conflicts unless it is contained. An offline edit carries
// only the client's CLAIM about when it happened, so a machine an hour fast wins
// every conflict and one an hour slow loses every one.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { clampEditTime, resolve } from '../src/lib/conflict.js';
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

const CREATED = '2026-08-09T10:00:00.000Z';
const NOW = '2026-08-09T12:00:00.000Z';

describe('clampEditTime', () => {
  it('passes a plausible time through', () => {
    expect(clampEditTime('2026-08-09T11:00:00.000Z', CREATED, NOW)).toBe('2026-08-09T11:00:00.000Z');
  });

  it('clamps a future claim to the server now', () => {
    expect(clampEditTime('2026-08-09T18:00:00.000Z', CREATED, NOW)).toBe(NOW);
  });

  it('clamps a claim older than the row itself to created_at', () => {
    expect(clampEditTime('2020-01-01T00:00:00.000Z', CREATED, NOW)).toBe(CREATED);
  });

  it('falls back to the server now when the claim is absent or unparseable', () => {
    expect(clampEditTime(undefined, CREATED, NOW)).toBe(NOW);
    expect(clampEditTime('yesterday', CREATED, NOW)).toBe(NOW);
  });
});

describe('resolve', () => {
  const base = { currentUpdatedAt: '2026-08-09T11:00:00.000Z' };

  it('does not check when the caller gave no base - the website\'s path', () => {
    expect(resolve({ ...base, baseUpdatedAt: undefined, clientUpdatedAt: '2026-08-09T10:00:00.000Z' }))
      .toEqual({ conflicted: false, winner: 'client' });
  });

  it('is not a conflict when the base still matches', () => {
    expect(resolve({ ...base, baseUpdatedAt: base.currentUpdatedAt, clientUpdatedAt: '2026-08-09T11:30:00.000Z' }))
      .toEqual({ conflicted: false, winner: 'client' });
  });

  it('newer client edit wins', () => {
    expect(resolve({ ...base, baseUpdatedAt: '2026-08-09T09:00:00.000Z', clientUpdatedAt: '2026-08-09T11:30:00.000Z' }))
      .toEqual({ conflicted: true, winner: 'client' });
  });

  it('newer server edit wins', () => {
    expect(resolve({ ...base, baseUpdatedAt: '2026-08-09T09:00:00.000Z', clientUpdatedAt: '2026-08-09T10:30:00.000Z' }))
      .toEqual({ conflicted: true, winner: 'server' });
  });

  it('a tie goes to the server, whose copy others have already pulled', () => {
    expect(resolve({ ...base, baseUpdatedAt: '2026-08-09T09:00:00.000Z', clientUpdatedAt: base.currentUpdatedAt }))
      .toEqual({ conflicted: true, winner: 'server' });
  });
});

describe('PATCH /api/notes/:id with a stale base', () => {
  it('keeps the newer edit and files the loser in history', async () => {
    const nb = await api.post('/api/notebooks').send({ name: 'C' });
    const created = await api.post('/api/notes').send({ notebookId: nb.body.notebook.id, title: 'Start' });
    const id = created.body.note.id;
    const base = created.body.note.updatedAt;

    // Another device edits first.
    await api.patch(`/api/notes/${id}`).send({ title: 'From the browser' });

    // Our offline edit arrives with the now-stale base, claiming a LATER time.
    const later = new Date(Date.now() + 60_000).toISOString();
    const res = await api.patch(`/api/notes/${id}`)
      .send({ title: 'From offline', baseUpdatedAt: base, clientUpdatedAt: later });

    expect(res.status).toBe(200);
    expect(res.body.conflicted).toBe(true);
    expect(res.body.note.title).toBe('From offline');

    const history = await api.get(`/api/notes/${id}/versions`);
    const causes = history.body.versions.map((v: { cause: string }) => v.cause);
    expect(causes).toContain('conflict');
    // The version filed is the copy that LOST, not the one that won.
    const conflictVersion = history.body.versions.find((v: { cause: string }) => v.cause === 'conflict');
    expect(conflictVersion.title).toBe('From the browser');
  });

  it('hands back the server copy when the client edit is the older one', async () => {
    const nb = await api.post('/api/notebooks').send({ name: 'C3' });
    const created = await api.post('/api/notes').send({ notebookId: nb.body.notebook.id, title: 'Start' });
    const id = created.body.note.id;
    const base = created.body.note.updatedAt;

    await api.patch(`/api/notes/${id}`).send({ title: 'Server wins' });

    // A claim from before the note even existed clamps to created_at, which is older
    // than the server's current updated_at - so the server's copy holds.
    const res = await api.patch(`/api/notes/${id}`)
      .send({ title: 'Stale offline edit', baseUpdatedAt: base, clientUpdatedAt: '2020-01-01T00:00:00.000Z' });

    expect(res.status).toBe(200);
    expect(res.body.conflicted).toBe(true);
    expect(res.body.note.title).toBe('Server wins');
    expect(typeof res.body.versionId).toBe('number');

    // The losing side is the client's edit, and it is preserved rather than dropped.
    const history = await api.get(`/api/notes/${id}/versions`);
    const conflictVersion = history.body.versions.find((v: { cause: string }) => v.cause === 'conflict');
    expect(conflictVersion.title).toBe('Stale offline edit');
  });

  it('a matching base is not a conflict', async () => {
    const nb = await api.post('/api/notebooks').send({ name: 'C4' });
    const created = await api.post('/api/notes').send({ notebookId: nb.body.notebook.id, title: 'Start' });
    const res = await api.patch(`/api/notes/${created.body.note.id}`)
      .send({ title: 'Only writer', baseUpdatedAt: created.body.note.updatedAt });

    expect(res.status).toBe(200);
    expect(res.body.conflicted).toBe(false);
    expect(res.body.note.title).toBe('Only writer');
  });

  it('an unqualified PATCH is unaffected - the website\'s own path', async () => {
    const nb = await api.post('/api/notebooks').send({ name: 'C2' });
    const created = await api.post('/api/notes').send({ notebookId: nb.body.notebook.id });
    const res = await api.patch(`/api/notes/${created.body.note.id}`).send({ title: 'Plain' });
    expect(res.status).toBe(200);
    expect(res.body.conflicted).toBeFalsy();
    expect(res.body.note.title).toBe('Plain');

    // And it files no conflict version, which is the half that would go unnoticed.
    const history = await api.get(`/api/notes/${created.body.note.id}/versions`);
    expect(history.body.versions.map((v: { cause: string }) => v.cause)).not.toContain('conflict');
  });
});
