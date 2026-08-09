// Does every write path maintain the columns the delta feed depends on?
//
// The schema columns (`updated_at`, `deleted_at`) and GET /api/sync/changes existed before
// these tests; the write paths did not maintain them, which made the whole mechanism inert
// in a way no status-code assertion could see. So the assertions here are deliberately not
// about HTTP status. They are about the two properties the design rests on:
//
//   1. Any change to a row advances its `updated_at`.
//   2. Any delete is a tombstone, not a missing row.
//
// Both matter for the same reason: the feed is ordered by (updated_at, id) and clients pull
// with a cursor, so a change that leaves `updated_at` where it was is invisible forever to
// any client already past that position - and a hard-deleted row leaves nothing to send at
// all, so the client re-uploads it from its outbox and the record comes back from the dead.
//
// The last test in each block is the round trip that ties the two together: delete, then
// pull with a cursor from BEFORE the delete, and require the tombstone in the answer.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { db } from '../src/db.js';
import {
  resetDatabase,
  resetData,
  makeUser,
  closeDatabase,
  insertNotebook,
  insertNote,
  insertCard,
  type TestUser,
} from './helpers.js';

const app = buildApp();

let user: TestUser;
let api: TestUser['agent'];

/**
 * Fixture rows are backdated to this before the mutation under test, and the assertion is
 * that the handler moved `updated_at` past it.
 *
 * Not just tidiness: the app stamps `nowIso()` from the node process while some columns
 * default to Postgres's `now()`, and the two clocks are measurably apart (the local Docker
 * Postgres reads several hundred ms ahead of node). Comparing a post-mutation app-clock
 * value against a pre-mutation database-clock value would be a coin flip. Comparing both
 * against a fixed instant years in the past tests the actual property - "the handler
 * advanced the timestamp" - and cannot flake on skew. `isRecent` below then confirms the
 * new value really is a fresh stamp rather than any old larger number.
 */
const ANCIENT = '2020-01-01T00:00:00.000Z';

type SyncTable = 'notebooks' | 'notes' | 'flashcards';

interface SyncCols {
  updated_at: string;
  deleted_at: string | null;
}

/** Read the two sync columns straight from the row, bypassing every API filter - the point
 *  of a tombstone is that the row is still THERE, which no endpoint will tell you. */
async function syncCols(table: SyncTable, id: string): Promise<SyncCols | undefined> {
  return db.prepare(`SELECT updated_at, deleted_at FROM ${table} WHERE id = ?`).get<SyncCols>(id);
}

async function backdate(table: SyncTable, id: string): Promise<void> {
  await db.prepare(`UPDATE ${table} SET updated_at = ? WHERE id = ?`).run(ANCIENT, id);
}

/** Within a couple of minutes of now, in either direction (the DB clock runs ahead). */
function isRecent(iso: string): boolean {
  const skew = Math.abs(Date.now() - new Date(iso).getTime());
  return Number.isFinite(skew) && skew < 120_000;
}

/** Assert `table`.`id` is a tombstone whose timestamp moved: exactly what the feed needs. */
async function expectTombstoned(table: SyncTable, id: string): Promise<void> {
  const row = await syncCols(table, id);
  expect(row, `${table} row should still exist as a tombstone, not be deleted`).toBeTruthy();
  expect(row!.deleted_at).toBeTruthy();
  expect(row!.updated_at > ANCIENT).toBe(true);
  expect(isRecent(row!.updated_at)).toBe(true);
}

async function expectStampAdvanced(table: SyncTable, id: string): Promise<void> {
  const row = await syncCols(table, id);
  expect(row).toBeTruthy();
  expect(row!.updated_at > ANCIENT).toBe(true);
  expect(isRecent(row!.updated_at)).toBe(true);
}

/**
 * The cursor a fully-synced client would be holding: drain the feed to its end.
 *
 * Taken from the real endpoint rather than hand-built, because "a cursor from before the
 * delete" is only a meaningful premise if it is the cursor the client would actually have.
 */
async function drainCursor(): Promise<string | null> {
  let cursor: string | null = null;
  for (let page = 0; page < 50; page++) {
    const res = await api.get(`/api/sync/changes${cursor ? `?since=${encodeURIComponent(cursor)}` : ''}`);
    expect(res.status).toBe(200);
    if (res.body.cursor) cursor = res.body.cursor as string;
    if (!res.body.hasMore) return cursor;
  }
  throw new Error('feed did not terminate');
}

interface FeedRow {
  id: string;
  deletedAt: string | null;
}

/** Every row of `entity` the feed hands back for a client sitting on `cursor`. */
async function pullSince(cursor: string | null, entity: 'notebook' | 'note' | 'flashcard'): Promise<FeedRow[]> {
  const out: FeedRow[] = [];
  let c = cursor;
  for (let page = 0; page < 50; page++) {
    const res = await api.get(`/api/sync/changes${c ? `?since=${encodeURIComponent(c)}` : ''}`);
    expect(res.status).toBe(200);
    out.push(...((res.body.changes[entity] ?? []) as FeedRow[]));
    if (!res.body.hasMore) return out;
    c = res.body.cursor as string;
  }
  throw new Error('feed did not terminate');
}

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

// ---------------------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------------------

describe('notes maintain the sync columns', () => {
  it('advances updated_at when a note is soft-deleted', async () => {
    const nb = await insertNotebook(user.id);
    const noteId = await insertNote(user.id, nb);
    await backdate('notes', noteId);

    expect((await api.delete(`/api/notes/${noteId}`)).status).toBe(200);

    // A tombstone whose updated_at never moved is not in a cursor-ordered feed for any
    // client already past it, so that client re-uploads the note and resurrects it.
    await expectTombstoned('notes', noteId);
  });

  it('advances updated_at when a note is undeleted', async () => {
    const nb = await insertNotebook(user.id);
    const noteId = await insertNote(user.id, nb);
    expect((await api.delete(`/api/notes/${noteId}`)).status).toBe(200);
    await backdate('notes', noteId);

    expect((await api.post(`/api/notes/${noteId}/undelete`)).status).toBe(200);

    const row = await syncCols('notes', noteId);
    expect(row!.deleted_at).toBeNull();
    expect(row!.updated_at > ANCIENT).toBe(true);
    expect(isRecent(row!.updated_at)).toBe(true);
  });

  it('advances updated_at on an edit', async () => {
    const nb = await insertNotebook(user.id);
    const noteId = await insertNote(user.id, nb);
    await backdate('notes', noteId);

    expect((await api.patch(`/api/notes/${noteId}`).send({ title: 'Edited' })).status).toBe(200);
    await expectStampAdvanced('notes', noteId);
  });

  it('puts the tombstone in the feed for a client whose cursor predates the delete', async () => {
    const nb = await insertNotebook(user.id);
    const noteId = await insertNote(user.id, nb);
    await backdate('notebooks', nb);
    await backdate('notes', noteId);

    const cursor = await drainCursor();
    expect(cursor).toBeTruthy();
    // Nothing new for a caught-up client, by definition.
    expect(await pullSince(cursor, 'note')).toHaveLength(0);

    expect((await api.delete(`/api/notes/${noteId}`)).status).toBe(200);

    const rows = await pullSince(cursor, 'note');
    const tombstone = rows.find(r => r.id === noteId);
    expect(tombstone, 'the delete must reach a client on a pre-delete cursor').toBeTruthy();
    expect(tombstone!.deletedAt).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------------------
// Notebooks
// ---------------------------------------------------------------------------------------

describe('notebooks maintain the sync columns', () => {
  it('advances updated_at on a rename', async () => {
    const nb = await insertNotebook(user.id);
    await backdate('notebooks', nb);

    expect((await api.patch(`/api/notebooks/${nb}`).send({ name: 'Renamed' })).status).toBe(200);
    await expectStampAdvanced('notebooks', nb);
  });

  it('tombstones the notebook instead of hard-deleting it, and cascades to its notes', async () => {
    const nb = await insertNotebook(user.id);
    const a = await insertNote(user.id, nb, { title: 'A' });
    const b = await insertNote(user.id, nb, { title: 'B' });
    await backdate('notebooks', nb);
    await backdate('notes', a);
    await backdate('notes', b);

    expect((await api.delete(`/api/notebooks/${nb}`)).status).toBe(200);

    await expectTombstoned('notebooks', nb);
    // ON DELETE CASCADE removed these before; a soft delete cascades nothing, so the
    // handler has to tombstone them itself or they stay live with no notebook to sit in.
    await expectTombstoned('notes', a);
    await expectTombstoned('notes', b);
  });

  it('disappears from every notebook read path once tombstoned', async () => {
    const nb = await insertNotebook(user.id, { name: 'Doomed' });
    const noteId = await insertNote(user.id, nb);
    expect((await api.delete(`/api/notebooks/${nb}`)).status).toBe(200);

    // The list endpoint - a soft-deleted notebook still in the sidebar is a worse bug
    // than the unreplicable hard delete this replaced.
    const list = await api.get('/api/notebooks');
    expect(list.status).toBe(200);
    expect(list.body.notebooks.map((n: { id: string }) => n.id)).not.toContain(nb);

    // The single-notebook lookup behind PATCH and DELETE.
    expect((await api.patch(`/api/notebooks/${nb}`).send({ name: 'zombie' })).status).toBe(404);
    expect((await api.delete(`/api/notebooks/${nb}`)).status).toBe(404);

    // The existence check other routes make before filing a note into it.
    expect((await api.post('/api/notes').send({ notebookId: nb, title: 'orphan' })).status).toBe(400);

    // The dashboard's count and its notebook strip.
    const dash = await api.get('/api/dashboard');
    expect(dash.status).toBe(200);
    expect(dash.body.stats.notebooks).toBe(0);
    expect(dash.body.notebooks.map((n: { id: string }) => n.id)).not.toContain(nb);

    // And the cascade is visible where it counts: the notes are gone from the API.
    expect((await api.get(`/api/notes/${noteId}`)).status).toBe(404);
    const notes = await api.get('/api/notes');
    expect(notes.body.notes.map((n: { id: string }) => n.id)).not.toContain(noteId);
  });

  it('puts the notebook AND its notes in the feed for a pre-delete cursor', async () => {
    const nb = await insertNotebook(user.id);
    const noteId = await insertNote(user.id, nb);
    await backdate('notebooks', nb);
    await backdate('notes', noteId);

    const cursor = await drainCursor();
    expect(await pullSince(cursor, 'notebook')).toHaveLength(0);

    expect((await api.delete(`/api/notebooks/${nb}`)).status).toBe(200);

    const notebookRows = await pullSince(cursor, 'notebook');
    const nbRow = notebookRows.find(r => r.id === nb);
    expect(nbRow, 'the notebook tombstone must reach a pre-delete cursor').toBeTruthy();
    expect(nbRow!.deletedAt).toBeTruthy();

    // The cascade has to be replicable too, or the client keeps the orphaned notes.
    const noteRows = await pullSince(cursor, 'note');
    const noteRow = noteRows.find(r => r.id === noteId);
    expect(noteRow, 'the cascaded note tombstone must reach a pre-delete cursor').toBeTruthy();
    expect(noteRow!.deletedAt).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------------------
// Flashcards
// ---------------------------------------------------------------------------------------

describe('flashcards maintain the sync columns', () => {
  it('advances updated_at on a review', async () => {
    const nb = await insertNotebook(user.id);
    const noteId = await insertNote(user.id, nb);
    const cardId = await insertCard(user.id, noteId);
    await backdate('flashcards', cardId);

    const res = await api.post('/api/study/review').send({ cardId, rating: 'good' });
    expect(res.status).toBe(200);
    // A review moves due_at. If updated_at stays put, the new schedule never reaches the
    // other device, which keeps showing the card as due and reviews it again.
    await expectStampAdvanced('flashcards', cardId);
  });

  it('advances updated_at on a card edit', async () => {
    const cardId = await insertCard(user.id, null);
    await backdate('flashcards', cardId);

    expect((await api.patch(`/api/study/cards/${cardId}`).send({ suspended: true })).status).toBe(200);
    await expectStampAdvanced('flashcards', cardId);
  });

  it('tombstones a card instead of deleting the row', async () => {
    const cardId = await insertCard(user.id, null);
    await backdate('flashcards', cardId);

    expect((await api.delete(`/api/study/cards/${cardId}`)).status).toBe(200);
    await expectTombstoned('flashcards', cardId);
    // Still a 404 the second time, as before - the tombstone filter in the WHERE clause is
    // what keeps a repeat delete from silently re-stamping a tombstone the client has seen.
    expect((await api.delete(`/api/study/cards/${cardId}`)).status).toBe(404);
  });

  it('disappears from every card read path once tombstoned', async () => {
    const nb = await insertNotebook(user.id);
    const noteId = await insertNote(user.id, nb);
    const kept = await insertCard(user.id, noteId, { question: 'Kept?' });
    const doomed = await insertCard(user.id, noteId, { question: 'Doomed?' });

    expect((await api.delete(`/api/study/cards/${doomed}`)).status).toBe(200);

    const queue = await api.get('/api/study/queue');
    expect(queue.status).toBe(200);
    expect(queue.body.cards.map((c: { id: string }) => c.id)).toEqual([kept]);
    expect(queue.body.due).toBe(1);
    expect(queue.body.total).toBe(1);

    const cards = await api.get('/api/study/cards');
    expect(cards.body.cards.map((c: { id: string }) => c.id)).toEqual([kept]);

    const stats = await api.get('/api/study/stats');
    expect(stats.body.due).toBe(1);
    expect(stats.body.total).toBe(1);
    expect(stats.body.byNote).toHaveLength(1);
    expect(stats.body.byNote[0]).toMatchObject({ noteId, total: 1, due: 1 });

    // The dashboard reads the same deck.
    const dash = await api.get('/api/dashboard');
    expect(dash.body.stats.flashcardsDue).toBe(1);

    // Nothing may write to it either: reviewing a tombstone would move its due_at and
    // reviewing/patching it back into life is exactly what a 404 here prevents.
    expect((await api.post('/api/study/review').send({ cardId: doomed, rating: 'good' })).status).toBe(404);
    expect((await api.patch(`/api/study/cards/${doomed}`).send({ question: 'zombie' })).status).toBe(404);
  });

  it('puts the tombstone in the feed for a client whose cursor predates the delete', async () => {
    const cardId = await insertCard(user.id, null);
    await backdate('flashcards', cardId);

    const cursor = await drainCursor();
    expect(await pullSince(cursor, 'flashcard')).toHaveLength(0);

    expect((await api.delete(`/api/study/cards/${cardId}`)).status).toBe(200);

    const rows = await pullSince(cursor, 'flashcard');
    const tombstone = rows.find(r => r.id === cardId);
    expect(tombstone, 'the delete must reach a client on a pre-delete cursor').toBeTruthy();
    expect(tombstone!.deletedAt).toBeTruthy();
  });
});

describe('POST /api/notes accepts pinned and archived', () => {
  // The outbox coalesces "create this note" and "pin it" into ONE create, so a
  // column this INSERT ignores is silently lost on an offline client's first sync.
  it('honours pinned on create', async () => {
    const user = await makeUser(app);
    const nb = await insertNotebook(user.id);
    const res = await user.agent.post('/api/notes').send({ notebookId: nb, title: 'Pinned offline', pinned: true });
    expect(res.status).toBe(201);
    expect(res.body.note.pinned).toBe(true);
  });

  it('defaults to unpinned and unarchived when the fields are absent', async () => {
    const user = await makeUser(app);
    const nb = await insertNotebook(user.id);
    const res = await user.agent.post('/api/notes').send({ notebookId: nb });
    expect(res.body.note.pinned).toBe(false);
    expect(res.body.note.archived).toBe(false);
  });
});
