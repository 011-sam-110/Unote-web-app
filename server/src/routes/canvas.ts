import { Router } from 'express';
import { db, nowIso, tx } from '../db.js';
import { userId } from '../auth/middleware.js';
import { resolveId } from '../lib/clientId.js';
import { recordNoteEvent } from '../lib/events.js';

const router = Router();

/**
 * Canvas boards: a canvas is a note with kind='canvas', and its spatial children
 * live in canvas_items / canvas_edges rather than inside the note's content_json.
 *
 * Keeping items as rows (not a blob) means dragging one sticky writes one row
 * instead of rewriting the whole document, which matters because the editor
 * autosaves continuously while a drag is in flight.
 *
 * Two properties here exist for the offline client rather than for the website,
 * and both are the same properties notes and notebooks already have:
 *
 *   * CREATES ACCEPT A CLIENT-SUPPLIED ID. A board built on a train is a set of
 *     items and the connectors between them. Re-minting the item ids on first push
 *     would leave every one of those connectors pointing at an id that no longer
 *     exists, and the client's own mirror holding a second copy of every item
 *     under the id it invented.
 *   * DELETES ARE TOMBSTONES, NOT HARD DELETES. A row that is simply gone cannot
 *     be replicated: the delta feed has nothing to send, so a client that was
 *     offline when it happened keeps the item forever and re-uploads it from its
 *     outbox. `deleted_at` is on all three tables and the 30-day purge in db.ts
 *     already covers them; these routes were the missing half.
 */

interface ItemRow {
  id: string;
  note_id: string;
  kind: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  z: number;
  data: string;
  created_at: string;
  updated_at: string;
}

interface EdgeRow {
  id: string;
  note_id: string;
  from_item_id: string;
  to_item_id: string;
  label: string;
  style: string;
}

function serializeItem(r: ItemRow) {
  return {
    id: r.id,
    kind: r.kind,
    x: r.x,
    y: r.y,
    width: r.width,
    height: r.height,
    rotation: r.rotation,
    z: r.z,
    // Stored as text so any malformed row degrades to an empty payload rather
    // than throwing and taking the whole board's GET down with it.
    data: safeParse(r.data),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function serializeEdge(r: EdgeRow) {
  return {
    id: r.id,
    from: r.from_item_id,
    to: r.to_item_id,
    label: r.label,
    style: r.style,
  };
}

function safeParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Confirm the note exists, belongs to the caller, and is a canvas.
 *
 * canvas_items has no user_id of its own, so every route below funnels through
 * this first - a bare `WHERE note_id = ?` would let any signed-in user read or
 * mutate another user's board by guessing its id.
 */
async function assertOwnedCanvas(noteId: string, uid: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT id FROM notes WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .get<{ id: string }>(noteId, uid);
  return Boolean(row);
}

const num = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

router.get('/:noteId', async (req, res) => {
  const uid = userId(req);
  const { noteId } = req.params;
  if (!(await assertOwnedCanvas(noteId, uid))) {
    res.status(404).json({ error: 'Canvas not found' });
    return;
  }
  const items = await db
    .prepare('SELECT * FROM canvas_items WHERE note_id = ? AND deleted_at IS NULL ORDER BY z ASC, created_at ASC')
    .all<ItemRow>(noteId);
  const edges = await db
    .prepare('SELECT * FROM canvas_edges WHERE note_id = ? AND deleted_at IS NULL')
    .all<EdgeRow>(noteId);
  res.json({ items: items.map(serializeItem), edges: edges.map(serializeEdge) });
});

router.post('/:noteId/items', async (req, res) => {
  const uid = userId(req);
  const { noteId } = req.params;
  if (!(await assertOwnedCanvas(noteId, uid))) {
    res.status(404).json({ error: 'Canvas not found' });
    return;
  }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const kind = String(b.kind ?? 'sticky');
  const id = resolveId(b.id);
  const now = nowIso();

  // A collision means this client already created the item and is retrying a push
  // whose response it never saw. 409 rather than a 500 from the PK violation, so the
  // outbox reads it as "this already landed" and settles instead of retrying forever.
  // Tombstones count: a soft-deleted row still occupies the primary key.
  const clash = await db.prepare('SELECT id FROM canvas_items WHERE id = ?').get<{ id: string }>(id);
  if (clash) {
    res.status(409).json({ error: 'id already exists', id });
    return;
  }

  // New items land on top. Computing this server-side avoids the client having to
  // know the current max, which it may not if another device just added one.
  const top = await db
    .prepare('SELECT COALESCE(MAX(z), 0) + 1 AS z FROM canvas_items WHERE note_id = ?')
    .get<{ z: number }>(noteId);

  await db
    .prepare(
      `INSERT INTO canvas_items (id, note_id, kind, x, y, width, height, rotation, z, data, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      noteId,
      kind,
      num(b.x, 0),
      num(b.y, 0),
      num(b.width, 220),
      num(b.height, 160),
      num(b.rotation, 0),
      num(b.z, top?.z ?? 1),
      JSON.stringify(b.data ?? {}),
      now,
      now,
    );

  const row = await db.prepare('SELECT * FROM canvas_items WHERE id = ?').get<ItemRow>(id);
  res.status(201).json({ item: serializeItem(row!) });
});

/**
 * Bulk item update. Dragging a multi-selection emits one request per frame-batch
 * rather than one per item, so this takes an array and applies it atomically.
 */
router.patch('/:noteId/items', async (req, res) => {
  const uid = userId(req);
  const { noteId } = req.params;
  if (!(await assertOwnedCanvas(noteId, uid))) {
    res.status(404).json({ error: 'Canvas not found' });
    return;
  }
  const updates = Array.isArray((req.body as Record<string, unknown>)?.items)
    ? ((req.body as Record<string, unknown>).items as Array<Record<string, unknown>>)
    : [];
  if (updates.length === 0) {
    res.status(400).json({ error: 'No items supplied' });
    return;
  }
  const now = nowIso();

  await tx(async (t) => {
    for (const u of updates) {
      const id = String(u.id ?? '');
      if (!id) continue;
      // note_id is part of the predicate so an id from another board cannot be
      // smuggled in alongside legitimate ones. `deleted_at IS NULL` is there for the
      // offline client: a device that dragged an item while another device was
      // deleting it must not be able to move a tombstone back to life.
      await t
        .prepare(
          `UPDATE canvas_items
              SET x = COALESCE(?, x), y = COALESCE(?, y),
                  width = COALESCE(?, width), height = COALESCE(?, height),
                  rotation = COALESCE(?, rotation), z = COALESCE(?, z),
                  data = COALESCE(?, data), updated_at = ?
            WHERE id = ? AND note_id = ? AND deleted_at IS NULL`,
        )
        .run(
          u.x === undefined ? null : num(u.x, 0),
          u.y === undefined ? null : num(u.y, 0),
          u.width === undefined ? null : num(u.width, 220),
          u.height === undefined ? null : num(u.height, 160),
          u.rotation === undefined ? null : num(u.rotation, 0),
          u.z === undefined ? null : num(u.z, 0),
          u.data === undefined ? null : JSON.stringify(u.data),
          now,
          id,
          noteId,
        );
    }
  });

  const items = await db
    .prepare('SELECT * FROM canvas_items WHERE note_id = ? AND deleted_at IS NULL ORDER BY z ASC, created_at ASC')
    .all<ItemRow>(noteId);
  res.json({ items: items.map(serializeItem) });
});

router.delete('/:noteId/items/:itemId', async (req, res) => {
  const uid = userId(req);
  const { noteId, itemId } = req.params;
  if (!(await assertOwnedCanvas(noteId, uid))) {
    res.status(404).json({ error: 'Canvas not found' });
    return;
  }
  // updated_at moves with deleted_at. The delta feed orders by (updated_at, id) and
  // clients pull with a cursor, so a tombstone whose updated_at stayed put is
  // invisible to any client already synced past it - the delete never arrives and
  // that client re-uploads the item from its outbox.
  const deletedAt = nowIso();
  await tx(async (t) => {
    await t
      .prepare('UPDATE canvas_items SET deleted_at = ?, updated_at = ? WHERE id = ? AND note_id = ? AND deleted_at IS NULL')
      .run(deletedAt, deletedAt, itemId, noteId);
    // The ON DELETE CASCADE that used to take the connectors with the item no longer
    // fires, because nothing is being deleted. Tombstoning them here is what keeps a
    // connector from outliving the card it was drawn to.
    await t
      .prepare(
        `UPDATE canvas_edges SET deleted_at = ?, updated_at = ?
          WHERE note_id = ? AND deleted_at IS NULL AND (from_item_id = ? OR to_item_id = ?)`,
      )
      .run(deletedAt, deletedAt, noteId, itemId, itemId);
  });
  // Deliberately not a 404 when nothing changed. A delete is idempotent, and an
  // offline client's outbox retries an entry until it succeeds - so answering 404 for
  // an item this device has already deleted would wedge that entry on every sync,
  // forever, behind a request that can never succeed.
  res.json({ ok: true });
});

router.post('/:noteId/edges', async (req, res) => {
  const uid = userId(req);
  const { noteId } = req.params;
  if (!(await assertOwnedCanvas(noteId, uid))) {
    res.status(404).json({ error: 'Canvas not found' });
    return;
  }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const from = String(b.from ?? '');
  const to = String(b.to ?? '');

  // Both endpoints must already live on this board; otherwise a connector could
  // be used to probe whether an item id exists on someone else's canvas. Tombstoned
  // items do not count as endpoints - a connector to a deleted card is a stub.
  const ends = await db
    .prepare('SELECT COUNT(*) AS n FROM canvas_items WHERE note_id = ? AND deleted_at IS NULL AND id IN (?, ?)')
    .get<{ n: number }>(noteId, from, to);
  if (!ends || Number(ends.n) < 2 || from === to) {
    res.status(400).json({ error: 'Connector endpoints must be two distinct items on this canvas' });
    return;
  }

  const id = resolveId(b.id);
  const clash = await db.prepare('SELECT id FROM canvas_edges WHERE id = ?').get<{ id: string }>(id);
  if (clash) {
    res.status(409).json({ error: 'id already exists', id });
    return;
  }

  // updated_at written explicitly rather than left to the column default. The default
  // is the DATABASE clock and every other mutation here stamps the APP clock; mixing
  // them can hand a later edit an earlier updated_at than the insert, which is exactly
  // the non-monotonic cursor the sync feed cannot tolerate.
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO canvas_edges (id, note_id, from_item_id, to_item_id, label, style, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, noteId, from, to, String(b.label ?? ''), String(b.style ?? 'arrow'), now, now);

  const row = await db.prepare('SELECT * FROM canvas_edges WHERE id = ?').get<EdgeRow>(id);
  res.status(201).json({ edge: serializeEdge(row!) });
});

router.delete('/:noteId/edges/:edgeId', async (req, res) => {
  const uid = userId(req);
  const { noteId, edgeId } = req.params;
  if (!(await assertOwnedCanvas(noteId, uid))) {
    res.status(404).json({ error: 'Canvas not found' });
    return;
  }
  const deletedAt = nowIso();
  await db
    .prepare('UPDATE canvas_edges SET deleted_at = ?, updated_at = ? WHERE id = ? AND note_id = ? AND deleted_at IS NULL')
    .run(deletedAt, deletedAt, edgeId, noteId);
  // Idempotent, for the same reason the item delete is.
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Pencil/stylus ink layered over an ordinary document note.
// ---------------------------------------------------------------------------

router.get('/:noteId/ink', async (req, res) => {
  const uid = userId(req);
  const { noteId } = req.params;
  if (!(await assertOwnedCanvas(noteId, uid))) {
    res.status(404).json({ error: 'Note not found' });
    return;
  }
  const rows = await db
    .prepare('SELECT id, stroke FROM note_ink WHERE note_id = ? AND deleted_at IS NULL ORDER BY created_at ASC')
    .all<{ id: string; stroke: string }>(noteId);
  res.json({ strokes: rows.map((r) => ({ id: r.id, ...safeParse(r.stroke) })) });
});

/**
 * Append strokes. Ink is append-only per stroke (rather than a whole-layer PUT)
 * so a dropped request loses at most the strokes in flight, not the page.
 *
 * A stroke may carry its own `id`, for one drawn while offline. It is stripped out
 * of the stored JSON rather than left in it: the GET above spreads the parsed blob
 * over `{ id: r.id }`, so an id inside the payload would silently override the
 * column and the layer would then try to erase a stroke by an id no row has.
 */
router.post('/:noteId/ink', async (req, res) => {
  const uid = userId(req);
  const { noteId } = req.params;
  if (!(await assertOwnedCanvas(noteId, uid))) {
    res.status(404).json({ error: 'Note not found' });
    return;
  }
  const strokes = Array.isArray((req.body as Record<string, unknown>)?.strokes)
    ? ((req.body as Record<string, unknown>).strokes as unknown[])
    : [];
  const created: string[] = [];
  const now = nowIso();
  await tx(async (t) => {
    for (const s of strokes) {
      const { id: supplied, ...body } = (s ?? {}) as Record<string, unknown>;
      const id = resolveId(supplied);
      // ON CONFLICT DO NOTHING rather than the 409 the item and edge creates
      // answer with. This is a BATCH, so one already-landed stroke must not fail
      // the other nineteen - and a stroke is immutable, so re-sending one is
      // provably a no-op rather than a lost edit.
      await t
        .prepare(
          `INSERT INTO note_ink (id, note_id, stroke, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
        )
        .run(id, noteId, JSON.stringify(body), now, now);
      created.push(id);
    }
  });
  // Mirror of the /share ink route: publish so a guest on the link sees the
  // owner's strokes. No-ops when the note isn't shared.
  if (created.length) await recordNoteEvent(noteId, 'ink', { ids: created }, uid);

  res.status(201).json({ ids: created });
});

router.delete('/:noteId/ink/:inkId', async (req, res) => {
  const uid = userId(req);
  const { noteId, inkId } = req.params;
  if (!(await assertOwnedCanvas(noteId, uid))) {
    res.status(404).json({ error: 'Note not found' });
    return;
  }
  const deletedAt = nowIso();
  await db
    .prepare('UPDATE note_ink SET deleted_at = ?, updated_at = ? WHERE id = ? AND note_id = ? AND deleted_at IS NULL')
    .run(deletedAt, deletedAt, inkId, noteId);
  res.json({ ok: true });
});

/** Clear an entire ink layer (the eraser's "clear all" affordance). */
router.delete('/:noteId/ink', async (req, res) => {
  const uid = userId(req);
  const { noteId } = req.params;
  if (!(await assertOwnedCanvas(noteId, uid))) {
    res.status(404).json({ error: 'Note not found' });
    return;
  }
  const deletedAt = nowIso();
  const r = await db
    .prepare('UPDATE note_ink SET deleted_at = ?, updated_at = ? WHERE note_id = ? AND deleted_at IS NULL')
    .run(deletedAt, deletedAt, noteId);
  res.json({ ok: true, removed: r.changes });
});

export default router;
