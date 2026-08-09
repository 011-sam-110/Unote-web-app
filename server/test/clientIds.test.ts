// An offline-created note must keep the id the client gave it. If the server
// re-mints, every [[wikilink]] and backlink pointing at that note breaks on first
// sync - the link resolves by title, but the id stored in `links` does not.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { resolveId } from '../src/lib/clientId.js';
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

describe('resolveId', () => {
  it('accepts an id of exactly newId shape', () => {
    expect(resolveId('abc123def456gh')).toBe('abc123def456gh');
  });

  it('mints when absent', () => {
    expect(resolveId(undefined)).toMatch(/^[a-z0-9]{14}$/);
    expect(resolveId(null)).toMatch(/^[a-z0-9]{14}$/);
  });

  it('mints rather than trusting a malformed id', () => {
    // Wrong length, wrong alphabet, and the two that would matter most:
    // path traversal and SQL-ish payloads must never reach a query as an id.
    for (const bad of ['short', 'ABC123DEF456GH', 'abc-123-def456', '../../etc/passwd', "a' OR 1=1--", 'a'.repeat(64), 42, {}]) {
      expect(resolveId(bad)).toMatch(/^[a-z0-9]{14}$/);
      expect(resolveId(bad)).not.toBe(bad);
    }
  });
});

describe('create with a client id', () => {
  it('keeps the id the client supplied', async () => {
    const nb = await api.post('/api/notebooks').send({ name: 'N', id: 'aaaaaaaaaaaaaa' });
    expect(nb.status).toBe(201);
    expect(nb.body.notebook.id).toBe('aaaaaaaaaaaaaa');

    const note = await api.post('/api/notes').send({ notebookId: 'aaaaaaaaaaaaaa', id: 'bbbbbbbbbbbbbb' });
    expect(note.status).toBe(201);
    expect(note.body.note.id).toBe('bbbbbbbbbbbbbb');
  });

  it('mints its own id when the client supplies a malformed one', async () => {
    const nb = await api.post('/api/notebooks').send({ name: 'N', id: '../../etc/passwd' });
    expect(nb.status).toBe(201);
    expect(nb.body.notebook.id).toMatch(/^[a-z0-9]{14}$/);
  });

  it('409s a duplicate rather than 500ing', async () => {
    await api.post('/api/notebooks').send({ name: 'N', id: 'cccccccccccccc' });
    const again = await api.post('/api/notebooks').send({ name: 'N', id: 'cccccccccccccc' });
    expect(again.status).toBe(409);

    const nb = await api.post('/api/notebooks').send({ name: 'Notes', id: 'eeeeeeeeeeeeee' });
    expect(nb.status).toBe(201);
    await api.post('/api/notes').send({ notebookId: 'eeeeeeeeeeeeee', id: 'ffffffffffffff' });
    const noteAgain = await api.post('/api/notes').send({ notebookId: 'eeeeeeeeeeeeee', id: 'ffffffffffffff' });
    expect(noteAgain.status).toBe(409);
  });

  it('cannot address another account\'s row', async () => {
    const other = await makeUser(app);
    await api.post('/api/notebooks').send({ name: 'Mine', id: 'dddddddddddddd' });
    const attempt = await other.agent.post('/api/notebooks').send({ name: 'Theirs', id: 'dddddddddddddd' });
    // The id is taken globally, so this is a 409 - crucially NOT a success that
    // overwrites, and NOT a leak of what the other row contains.
    expect(attempt.status).toBe(409);
    expect(JSON.stringify(attempt.body)).not.toContain('Mine');
  });

  it('leaves the website\'s own create untouched, which sends no id', async () => {
    const nb = await api.post('/api/notebooks').send({ name: 'Plain' });
    expect(nb.status).toBe(201);
    expect(nb.body.notebook.id).toMatch(/^[a-z0-9]{14}$/);
    const note = await api.post('/api/notes').send({ notebookId: nb.body.notebook.id });
    expect(note.status).toBe(201);
    expect(note.body.note.id).toMatch(/^[a-z0-9]{14}$/);
  });
});
