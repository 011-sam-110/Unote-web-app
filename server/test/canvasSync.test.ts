// What the canvas and ink routes had to gain before a board could be built offline.
//
// Two properties, and both of them are invisible from the website - which is why they
// went untested until an offline client depended on them:
//
//   * A create keeps the id the client gave it. A board is items plus the connectors
//     between them, so a server-minted replacement orphans every connector on the
//     board and leaves the client's mirror holding a second copy of every item.
//   * A delete is a tombstone. A row that is simply gone cannot be replicated: the
//     delta feed has nothing to send, so a client that was offline when it happened
//     keeps the item and re-uploads it from its outbox.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { db } from '../src/db.js';
import { resetDatabase, resetData, makeUser, closeDatabase, type TestUser } from './helpers.js';

const app = buildApp();

let api: TestUser['agent'];
let noteId: string;

beforeAll(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetData();
  const user = await makeUser(app);
  api = user.agent;
  const nb = await api.post('/api/notebooks').send({ name: 'Boards' });
  const note = await api.post('/api/notes').send({ notebookId: nb.body.notebook.id, kind: 'canvas' });
  noteId = note.body.note.id;
});

afterAll(async () => {
  await closeDatabase();
});

/** Everything the delta feed would hand a client, for one entity. */
async function feed(entity: 'canvasItem' | 'canvasEdge' | 'ink'): Promise<Array<Record<string, unknown>>> {
  const res = await api.get('/api/sync/changes?limit=500');
  return (res.body.changes[entity] ?? []) as Array<Record<string, unknown>>;
}

describe('canvas creates with a client id', () => {
  it('keeps the ids of an item, a connector and a stroke', async () => {
    const a = await api.post(`/api/canvas/${noteId}/items`).send({ id: 'aaaaaaaaaaaaaa', kind: 'sticky' });
    const b = await api.post(`/api/canvas/${noteId}/items`).send({ id: 'bbbbbbbbbbbbbb', kind: 'sticky' });
    expect(a.body.item.id).toBe('aaaaaaaaaaaaaa');
    expect(b.body.item.id).toBe('bbbbbbbbbbbbbb');

    const edge = await api.post(`/api/canvas/${noteId}/edges`)
      .send({ id: 'cccccccccccccc', from: 'aaaaaaaaaaaaaa', to: 'bbbbbbbbbbbbbb' });
    expect(edge.status).toBe(201);
    // The connector still names the two cards the client drew it between.
    expect(edge.body.edge).toMatchObject({ id: 'cccccccccccccc', from: 'aaaaaaaaaaaaaa', to: 'bbbbbbbbbbbbbb' });

    const ink = await api.post(`/api/canvas/${noteId}/ink`)
      .send({ strokes: [{ id: 'dddddddddddddd', points: [[0, 0, 1]], color: '#111', width: 3, tool: 'pen' }] });
    expect(ink.body.ids).toEqual(['dddddddddddddd']);
  });

  it('does not let a supplied id override the column when the stroke is read back', async () => {
    // The GET spreads the parsed stroke over { id: row.id }, so an id left inside the
    // JSON would win - and the eraser would then address a row that does not exist.
    await api.post(`/api/canvas/${noteId}/ink`)
      .send({ strokes: [{ id: 'eeeeeeeeeeeeee', points: [[1, 1, 1]], color: '#111', width: 3, tool: 'pen' }] });
    const got = await api.get(`/api/canvas/${noteId}/ink`);
    expect(got.body.strokes).toHaveLength(1);
    expect(got.body.strokes[0].id).toBe('eeeeeeeeeeeeee');

    const row = await db.prepare('SELECT stroke FROM note_ink WHERE id = ?').get<{ stroke: string }>('eeeeeeeeeeeeee');
    expect(JSON.parse(row!.stroke).id).toBeUndefined();
  });

  it('409s a duplicate item or connector rather than 500ing on the primary key', async () => {
    await api.post(`/api/canvas/${noteId}/items`).send({ id: 'ffffffffffffff', kind: 'sticky' });
    const again = await api.post(`/api/canvas/${noteId}/items`).send({ id: 'ffffffffffffff', kind: 'sticky' });
    // The outbox reads 409-on-create as "this already landed" and settles the entry;
    // anything else and it retries a push that can never succeed.
    expect(again.status).toBe(409);
  });

  it('re-sending a stroke is a no-op rather than a failure', async () => {
    // Ink arrives in batches, so one already-landed stroke must not fail the other
    // nineteen - and a stroke is immutable, so re-sending one changes nothing.
    const body = { strokes: [{ id: 'gggggggggggggg', points: [[2, 2, 1]], color: '#111', width: 3, tool: 'pen' }] };
    await api.post(`/api/canvas/${noteId}/ink`).send(body);
    const again = await api.post(`/api/canvas/${noteId}/ink`).send(body);
    expect(again.status).toBe(201);
    expect((await api.get(`/api/canvas/${noteId}/ink`)).body.strokes).toHaveLength(1);
  });

  it('still mints its own id for the website, which sends none', async () => {
    const item = await api.post(`/api/canvas/${noteId}/items`).send({ kind: 'sticky' });
    expect(item.body.item.id).toMatch(/^[a-z0-9]{14}$/);
  });
});

describe('canvas deletes are tombstones', () => {
  it('an item leaves the board, and its tombstone reaches the feed', async () => {
    const item = await api.post(`/api/canvas/${noteId}/items`).send({ kind: 'sticky', data: { text: 'Doomed' } });
    const id = item.body.item.id as string;

    expect((await api.delete(`/api/canvas/${noteId}/items/${id}`)).status).toBe(200);
    expect((await api.get(`/api/canvas/${noteId}`)).body.items).toHaveLength(0);

    // The row is still there, saying it was deleted - which is the only way a client
    // that was offline at the time ever finds out.
    const tombstone = (await feed('canvasItem')).find((r) => r.id === id);
    expect(tombstone?.deletedAt).not.toBeNull();
    // updated_at moved with it, or the tombstone sits behind the cursor of every
    // client that has already synced and the delete never arrives.
    expect(tombstone?.updatedAt).toBe(tombstone?.deletedAt);
  });

  it('deleting a card tombstones the connectors drawn to it', async () => {
    // The ON DELETE CASCADE that used to take them no longer fires: nothing is being
    // deleted. Without this a connector outlives the card it pointed at.
    const a = await api.post(`/api/canvas/${noteId}/items`).send({ kind: 'sticky' });
    const b = await api.post(`/api/canvas/${noteId}/items`).send({ kind: 'sticky' });
    const edge = await api.post(`/api/canvas/${noteId}/edges`).send({ from: a.body.item.id, to: b.body.item.id });

    await api.delete(`/api/canvas/${noteId}/items/${a.body.item.id}`);

    expect((await api.get(`/api/canvas/${noteId}`)).body.edges).toHaveLength(0);
    const tombstone = (await feed('canvasEdge')).find((r) => r.id === edge.body.edge.id);
    expect(tombstone?.deletedAt).not.toBeNull();
  });

  it('a cleared ink layer arrives as tombstones, not as silence', async () => {
    await api.post(`/api/canvas/${noteId}/ink`).send({
      strokes: [
        { points: [[0, 0, 1]], color: '#111', width: 3, tool: 'pen' },
        { points: [[1, 1, 1]], color: '#111', width: 3, tool: 'pen' },
      ],
    });
    const cleared = await api.delete(`/api/canvas/${noteId}/ink`);
    expect(cleared.body).toMatchObject({ ok: true, removed: 2 });
    expect((await api.get(`/api/canvas/${noteId}/ink`)).body.strokes).toHaveLength(0);
    expect((await feed('ink')).every((r) => r.deletedAt !== null)).toBe(true);
  });

  it('answers a repeated delete with ok rather than 404', async () => {
    // A delete is idempotent, and the outbox retries an entry until it succeeds. A
    // 404 for something this device has already deleted would wedge that entry on
    // every sync, forever, behind a request that can never be satisfied.
    const item = await api.post(`/api/canvas/${noteId}/items`).send({ kind: 'sticky' });
    await api.delete(`/api/canvas/${noteId}/items/${item.body.item.id}`);
    expect((await api.delete(`/api/canvas/${noteId}/items/${item.body.item.id}`)).status).toBe(200);
    expect((await api.delete(`/api/canvas/${noteId}/items/hhhhhhhhhhhhhh`)).status).toBe(200);
  });

  it('a bulk update cannot bring a tombstoned card back', async () => {
    const item = await api.post(`/api/canvas/${noteId}/items`).send({ kind: 'sticky', x: 0 });
    const id = item.body.item.id as string;
    await api.delete(`/api/canvas/${noteId}/items/${id}`);

    // A device that was mid-drag when another deleted the card pushes this on
    // reconnect. The delete has to win.
    const patched = await api.patch(`/api/canvas/${noteId}/items`).send({ items: [{ id, x: 999 }] });
    expect(patched.status).toBe(200);
    expect(patched.body.items).toHaveLength(0);
    const row = await db.prepare('SELECT x, deleted_at FROM canvas_items WHERE id = ?').get<{ x: number; deleted_at: string | null }>(id);
    expect(Number(row!.x)).toBe(0);
    expect(row!.deleted_at).not.toBeNull();
  });

  it('will not draw a connector to a card that is gone', async () => {
    const a = await api.post(`/api/canvas/${noteId}/items`).send({ kind: 'sticky' });
    const b = await api.post(`/api/canvas/${noteId}/items`).send({ kind: 'sticky' });
    await api.delete(`/api/canvas/${noteId}/items/${b.body.item.id}`);
    const edge = await api.post(`/api/canvas/${noteId}/edges`).send({ from: a.body.item.id, to: b.body.item.id });
    expect(edge.status).toBe(400);
  });
});
