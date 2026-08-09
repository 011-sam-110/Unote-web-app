import { Router } from 'express';
import { db, tx, nowIso } from '../db.js';
import { userId } from '../auth/middleware.js';
import { resolveId } from '../lib/clientId.js';

const router = Router();

interface NotebookRow {
  id: string;
  user_id: string;
  name: string;
  emoji: string;
  color: string;
  position: number;
  archived: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

// Ownership is folded into the lookup itself rather than checked afterwards, so a
// notebook belonging to someone else is indistinguishable from one that does not
// exist (404) - and no handler can forget the check.
//
// `deleted_at IS NULL` is folded in for the same reason. DELETE is a tombstone now, so
// without it a trashed notebook would still be fetchable, patchable and re-deletable,
// and a soft-deleted notebook left in the sidebar is a worse bug than the unreplicable
// hard delete this replaced.
const getRowStmt = () => db.prepare('SELECT * FROM notebooks WHERE id = ? AND user_id = ? AND deleted_at IS NULL');
// notes.user_id is redundant with the already-owner-checked notebook_id, but keeping
// it means a mis-filed row could never inflate another user's counts.
const statsStmt = () => db.prepare('SELECT COUNT(*) as c, MAX(updated_at) as last FROM notes WHERE notebook_id = ? AND user_id = ? AND archived = 0 AND deleted_at IS NULL');

async function notebookOut(row: NotebookRow, uid: string) {
  const stats = (await statsStmt().get(row.id, uid)) as { c: number; last: string | null };
  return {
    id: row.id,
    name: row.name,
    emoji: row.emoji,
    color: row.color,
    position: row.position,
    archived: Boolean(row.archived),
    noteCount: stats.c,
    lastNoteAt: stats.last,
  };
}

router.get('/', async (req, res) => {
  const uid = userId(req);
  const rows = (await db
    .prepare('SELECT * FROM notebooks WHERE user_id = ? AND deleted_at IS NULL ORDER BY position ASC, created_at ASC')
    .all(uid)) as NotebookRow[];
  res.json({ notebooks: await Promise.all(rows.map((row) => notebookOut(row, uid))) });
});

router.post('/', async (req, res) => {
  const uid = userId(req);
  const b = req.body ?? {};
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  // A notebook created offline keeps the id the client gave it, so the notes filed
  // into it offline still point somewhere after their first push.
  const id = resolveId(b.id);
  const now = nowIso();

  // A collision means this client already created the notebook and is retrying a push
  // whose response it never saw. 409 so the outbox reads it as "this already landed"
  // rather than a 500 from a PK violation it would retry forever. Not owner-scoped:
  // the id is unique table-wide, and the response reveals nothing but that fact.
  //
  // Deliberately NOT filtered on deleted_at either, unlike every read path below: a
  // tombstone still occupies the primary key, so treating it as absent would send the
  // INSERT straight into the PK violation this check exists to avoid.
  const clash = await db.prepare('SELECT id FROM notebooks WHERE id = ?').get<{ id: string }>(id);
  if (clash) {
    res.status(409).json({ error: 'id already exists', id });
    return;
  }

  // Positions are per-user, so the next slot is the max within this user's own list.
  // Tombstones are counted here on purpose: skipping them would hand a new notebook the
  // position a trashed one still holds, and an undelete would then collide.
  const maxPos = ((await db
    .prepare('SELECT COALESCE(MAX(position), -1) as m FROM notebooks WHERE user_id = ?')
    .get(uid)) as { m: number }).m;

  // The owner comes from the session only - never from the request body.
  // updated_at is written explicitly rather than left to the column default: the default
  // is the DATABASE clock, every mutation below stamps the APP clock, and the two are not
  // the same instant. Mixing them can make a later edit carry an EARLIER updated_at than
  // the insert, which is exactly the non-monotonic cursor the sync feed cannot tolerate.
  await db.prepare(
    'INSERT INTO notebooks (id, user_id, name, emoji, color, position, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)',
  ).run(id, uid, name, typeof b.emoji === 'string' && b.emoji ? b.emoji : '📓', typeof b.color === 'string' && b.color ? b.color : '#6366f1', maxPos + 1, now, now);

  const row = (await getRowStmt().get(id, uid)) as NotebookRow;
  res.status(201).json({ notebook: await notebookOut(row, uid) });
});

router.patch('/:id', async (req, res) => {
  const uid = userId(req);
  const row = (await getRowStmt().get(req.params.id, uid)) as NotebookRow | undefined;
  if (!row) {
    res.status(404).json({ error: 'notebook not found' });
    return;
  }

  const b = req.body ?? {};
  if (b.name !== undefined && !String(b.name).trim()) {
    res.status(400).json({ error: 'name cannot be empty' });
    return;
  }

  // user_id is repeated in the WHERE clause even though the row was just fetched by
  // owner: it keeps the ownership guarantee on the statement that actually writes.
  //
  // updated_at advances on every field this touches - renames and re-orders included.
  // GET /api/sync/changes pages by (updated_at, id), so an edit that left the timestamp
  // alone would never reach a client whose cursor is already past the old value.
  await db.prepare('UPDATE notebooks SET name = ?, emoji = ?, color = ?, position = ?, archived = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(
    b.name !== undefined ? String(b.name).trim() : row.name,
    b.emoji !== undefined ? String(b.emoji) : row.emoji,
    b.color !== undefined ? String(b.color) : row.color,
    b.position !== undefined ? Number(b.position) : row.position,
    // archived is INTEGER 0/1 in Postgres, which rejects a JS boolean - coerce here.
    b.archived !== undefined ? (b.archived ? 1 : 0) : row.archived,
    nowIso(),
    row.id,
    uid,
  );

  const updated = (await getRowStmt().get(row.id, uid)) as NotebookRow;
  res.json({ notebook: await notebookOut(updated, uid) });
});

/**
 * Soft-delete: tombstone the notebook AND its notes.
 *
 * This was a hard `DELETE FROM notebooks`, which cannot be replicated - a row that is
 * simply gone leaves nothing for GET /api/sync/changes to hand a client, so the delete
 * never propagates and the client re-uploads from its outbox. A tombstone (deleted_at
 * set, updated_at advanced so it lands after the client's cursor) is the replicable form.
 *
 * The cascade has to be done by hand. The hard delete relied on `ON DELETE CASCADE` from
 * notes.notebook_id to remove the notebook's notes; a soft delete cascades nothing, so
 * without this the notes would stay live - reachable by URL and listed by search - with
 * no notebook to sit in. Soft-deleting them here preserves the behaviour the old cascade
 * produced (see data.test.ts 'deletes a notebook and cascades its notes') and, unlike the
 * cascade, is something the sync feed can carry.
 *
 * One transaction: a notebook tombstoned without its notes, or the reverse, is a state no
 * client could reconcile.
 */
router.delete('/:id', async (req, res) => {
  const uid = userId(req);
  const row = (await getRowStmt().get(req.params.id, uid)) as NotebookRow | undefined;
  if (!row) {
    res.status(404).json({ error: 'notebook not found' });
    return;
  }

  const now = nowIso();
  await tx(async t => {
    // `t`, not the module-level `db`: `db` draws a different pooled connection and would
    // run outside this transaction.
    //
    // Already-trashed notes are left alone (`deleted_at IS NULL`): re-stamping them would
    // move a tombstone the client has already seen and reset its own deletion time.
    await t
      .prepare('UPDATE notes SET deleted_at = ?, updated_at = ? WHERE notebook_id = ? AND user_id = ? AND deleted_at IS NULL')
      .run(now, now, row.id, uid);
    // Same reason DELETE /api/notes/:id drops links: a trashed note must stop showing up
    // as a backlink on the notes that survive. `links` has no user_id of its own, so the
    // owner filter rides on the notes sub-select.
    await t
      .prepare(
        `DELETE FROM links
          WHERE from_note_id IN (SELECT id FROM notes WHERE notebook_id = ? AND user_id = ?)
             OR to_note_id   IN (SELECT id FROM notes WHERE notebook_id = ? AND user_id = ?)`,
      )
      .run(row.id, uid, row.id, uid);
    await t
      .prepare('UPDATE notebooks SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ?')
      .run(now, now, row.id, uid);
  });

  res.json({ ok: true });
});

export default router;
