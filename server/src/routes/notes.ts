import { Router } from 'express';
import { db, tx, nowIso } from '../db.js';
import { userId } from '../auth/middleware.js';
import { resolveId } from '../lib/clientId.js';
import { clampEditTime, resolve, demoteToVersion } from '../lib/conflict.js';
import { noteLite, noteFull, wordCountOf, type NoteRow } from '../lib/serialize.js';
import { syncLinksForNote, renameWikilinksToTitle, resyncNotesReferencingTitle } from '../lib/links.js';
import { tiptapToMarkdown, type TTNode } from '../lib/export.js';
import { recordNoteEvent } from '../lib/events.js';
import { plainTextFromDoc } from '../lib/plainText.js';
import { claimAttachmentsForNote } from '../lib/attachments.js';

const router = Router();

// Auth is mounted once, in app.ts (`app.use('/api/notes', requireAuth, ...)`), so this
// router does not add its own guard - one layer means one place to audit and one session
// lookup per request. `userId(req)` throws if that mount ever loses the guard, so the
// failure mode is a loud 500, never an unscoped query.

/**
 * Ownership convention in this file:
 *  - The owner id ALWAYS comes from `userId(req)`, never from the body or params.
 *  - `notes` carries user_id, so note lookups filter on it directly.
 *  - Child tables (note_versions, note_tags, links) have no user_id, so their
 *    statements reach through to `notes` - either by joining on the read side or
 *    by an INSERT…SELECT over an owner-filtered `notes` row on the write side.
 *    A bare `WHERE note_id = ?` would let any signed-in user name any note id.
 *  - Where a bare note id IS used below, it is `row.id` from an already
 *    owner-scoped lookup, not the raw path parameter; those spots say so.
 */

/** Live (not soft-deleted) note belonging to `uid`. */
async function getNoteRow(uid: string, id: string): Promise<NoteRow | undefined> {
  return db
    .prepare('SELECT * FROM notes WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .get<NoteRow>(id, uid);
}

/** Any note belonging to `uid`, including one in the trash (for undelete). */
async function getNoteRowAny(
  uid: string,
  id: string,
): Promise<(NoteRow & { deleted_at: string | null }) | undefined> {
  return db
    .prepare('SELECT * FROM notes WHERE id = ? AND user_id = ?')
    .get<NoteRow & { deleted_at: string | null }>(id, uid);
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, c => `\\${c}`);
}

/** Version ids are BIGINT. Postgres errors on a non-numeric literal where SQLite simply
 *  failed to match, so parse the path segment and let the caller answer 404 for garbage. */
function parseVersionId(raw: string): number | null {
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

/** Reject anything that isn't a minimally-valid TipTap doc so a bricked note is impossible.
 *  Returns an error string, or null if the value is acceptable (or absent). */
function validateContentJson(value: unknown): string | null {
  if (value === undefined) return null; // not being changed
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return 'contentJson must be a TipTap document object';
  }
  const doc = value as { type?: unknown; content?: unknown };
  if (doc.type !== 'doc') return "contentJson must have type: 'doc'";
  if (!Array.isArray(doc.content)) return 'contentJson.content must be an array';
  return null;
}

async function setTags(uid: string, noteId: string, tags: unknown): Promise<void> {
  const list = Array.isArray(tags) ? [...new Set(tags.map(t => String(t).trim()).filter(Boolean))] : [];
  // Both statements must run on the transaction's connection (`t`), not the module
  // `db`, which would draw a different pooled connection and land outside the tx.
  await tx(async t => {
    await t
      .prepare('DELETE FROM note_tags WHERE note_id IN (SELECT id FROM notes WHERE id = ? AND user_id = ?)')
      .run(noteId, uid);
    const stmt = t.prepare(
      `INSERT INTO note_tags (note_id, tag)
       SELECT id, ? FROM notes WHERE id = ? AND user_id = ?
       ON CONFLICT DO NOTHING`,
    );
    for (const tag of list) await stmt.run(tag, noteId, uid);
  });
}

/**
 * Append a history entry, returning the row it wrote (Postgres has no lastInsertRowid,
 * and RETURNING is race-free where re-reading `ORDER BY id DESC LIMIT 1` would not be).
 * INSERT…SELECT over an owner-filtered `notes` row re-checks ownership at write time,
 * so this cannot graft history onto another user's note; it writes nothing instead.
 */
async function insertVersion(
  uid: string,
  noteId: string,
  title: string,
  contentJson: string,
  cause: string,
  label: string | null = null,
): Promise<VersionRow | undefined> {
  return db
    .prepare(
      `INSERT INTO note_versions (note_id, title, content_json, cause, label, created_at)
       SELECT id, ?, ?, ?, ?, ? FROM notes WHERE id = ? AND user_id = ?
       RETURNING id, title, content_json, cause, label, created_at`,
    )
    .get<VersionRow>(title, contentJson, cause, label, nowIso(), noteId, uid);
}

async function shouldAutosaveSnapshot(uid: string, noteId: string): Promise<boolean> {
  const latest = await db
    .prepare(
      `SELECT v.cause, v.created_at FROM note_versions v
       JOIN notes n ON n.id = v.note_id
       WHERE v.note_id = ? AND n.user_id = ?
       ORDER BY v.created_at DESC, v.id DESC LIMIT 1`,
    )
    .get<{ cause: string; created_at: string }>(noteId, uid);
  if (!latest) return true;
  if (latest.cause !== 'autosave') return true;
  const age = Date.now() - new Date(latest.created_at).getTime();
  return age > 10 * 60 * 1000;
}

interface VersionRow {
  id: number;
  title: string;
  content_json: string;
  cause: string;
  label: string | null;
  created_at: string;
}

function versionMeta(v: VersionRow) {
  return {
    id: v.id,
    cause: v.cause,
    label: v.label,
    createdAt: v.created_at,
    title: v.title,
    wordCount: wordCountOf(plainTextFromDoc(JSON.parse(v.content_json))),
  };
}

// --- Collection routes (must come before /:id) ---------------------------------

router.get('/recent', async (req, res) => {
  const uid = userId(req);
  const limit = Math.min(Math.max(Number(req.query.limit) || 12, 1), 100);
  const rows = await db
    .prepare('SELECT * FROM notes WHERE user_id = ? AND archived = 0 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?')
    .all<NoteRow>(uid, limit);
  res.json({ notes: await Promise.all(rows.map(r => noteLite(r))) });
});

router.get('/', async (req, res) => {
  const uid = userId(req);
  const notebookId = typeof req.query.notebookId === 'string' ? req.query.notebookId : undefined;
  const tag = typeof req.query.tag === 'string' ? req.query.tag : undefined;
  const archived = req.query.archived !== undefined ? String(req.query.archived) === '1' : false;
  const sort = typeof req.query.sort === 'string' ? req.query.sort : 'updated';
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  // The owner predicate leads so it applies to the tag-join variant too; a notebookId
  // from the query string narrows within the caller's own notes, it never widens.
  const conditions = ['n.user_id = ?', 'n.archived = ?', 'n.deleted_at IS NULL'];
  const conditionParams: unknown[] = [uid, archived ? 1 : 0];
  if (notebookId) {
    conditions.push('n.notebook_id = ?');
    conditionParams.push(notebookId);
  }
  const join = tag ? 'JOIN note_tags nt ON nt.note_id = n.id AND nt.tag = ?' : '';
  const params = tag ? [tag, ...conditionParams] : conditionParams;

  // SQLite's COLLATE NOCASE has no Postgres equivalent; lower() gives the same
  // case-insensitive title ordering.
  const orderBy = sort === 'created' ? 'n.created_at DESC' : sort === 'title' ? 'lower(n.title) ASC' : 'n.updated_at DESC';
  const whereSql = conditions.join(' AND ');

  const rows = await db
    .prepare(`SELECT n.* FROM notes n ${join} WHERE ${whereSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .all<NoteRow>(...params, limit, offset);
  // COUNT(*) is BIGINT; db.ts registers a type parser that hands it back as a JS number.
  const totalRow = await db
    .prepare(`SELECT COUNT(*) as c FROM notes n ${join} WHERE ${whereSql}`)
    .get<{ c: number }>(...params);
  const total = Number(totalRow?.c ?? 0);

  res.json({ notes: await Promise.all(rows.map(r => noteLite(r))), total });
});

router.post('/', async (req, res) => {
  const uid = userId(req);
  const b = req.body ?? {};
  if (typeof b.notebookId !== 'string' || !b.notebookId) {
    res.status(400).json({ error: 'notebookId is required' });
    return;
  }
  // Owner-scoped: another user's notebook must read as unknown rather than accept the
  // note, otherwise any caller could file notes into an account they cannot see.
  // `deleted_at IS NULL` too: notebooks are tombstoned rather than hard-deleted now, so
  // without it a trashed notebook would still accept new notes - which would then be
  // filed somewhere the sidebar cannot show.
  const notebook = await db
    .prepare('SELECT id FROM notebooks WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .get<{ id: string }>(b.notebookId, uid);
  if (!notebook) {
    res.status(400).json({ error: 'unknown notebookId' });
    return;
  }
  const contentJsonError = validateContentJson(b.contentJson);
  if (contentJsonError) {
    res.status(400).json({ error: contentJsonError });
    return;
  }

  // A canvas is a note whose spatial children live in canvas_items/canvas_edges
  // rather than content_json. Whitelist rather than pass-through: an unrecognised
  // kind would make NotePage render neither the editor nor the board.
  const kind = b.kind === 'canvas' ? 'canvas' : 'doc';

  // A note created offline keeps the id the client gave it. Re-minting here would
  // break every wikilink and backlink aimed at it: links resolve by title, but the id
  // stored in `links` does not survive the change.
  const id = resolveId(b.id);
  const now = nowIso();
  const title = b.title !== undefined ? String(b.title) : '';
  const contentJsonObj = b.contentJson !== undefined ? b.contentJson : { type: 'doc', content: [{ type: 'paragraph' }] };
  const contentJson = JSON.stringify(contentJsonObj);
  const contentText = b.contentText !== undefined ? String(b.contentText) : b.contentJson !== undefined ? plainTextFromDoc(contentJsonObj) : '';

  // A collision means this client already created the record and is retrying a push
  // whose response it never saw. Report it so the outbox can treat it as success
  // rather than retrying forever - and so it is never a 500 from a PK violation.
  // Deliberately not owner-scoped: ids are unique across the whole table, so an id
  // already held by another account is taken too. The response says only that, which
  // is why it cannot be used to read anything about the row that holds it.
  const clash = await db.prepare('SELECT id FROM notes WHERE id = ?').get<{ id: string }>(id);
  if (clash) {
    res.status(409).json({ error: 'id already exists', id });
    return;
  }

  // pinned/archived are accepted on create, not forced to 0.
  //
  // An offline client's outbox coalesces "create this note" and "pin it" into ONE
  // create - that is what stops a long offline session queueing thousands of
  // writes - so whatever this INSERT ignores is silently lost on first sync. The
  // note arrived; the pin did not, and nothing reported it.
  const pinned = b.pinned === true ? 1 : 0;
  const archived = b.archived === true ? 1 : 0;

  await db
    .prepare(
      `INSERT INTO notes (id, user_id, notebook_id, title, content_json, content_text, kind, pinned, archived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, uid, b.notebookId, title, contentJson, contentText, kind, pinned, archived, now, now);

  if (b.tags !== undefined) await setTags(uid, id, b.tags);
  if (contentText) await syncLinksForNote(uid, id, contentText);
  // Images the client uploaded before this note existed (the lecture import posts every
  // slide, then creates the note around the returned URLs) are only reachable by a share
  // guest once they are filed against it. See claimAttachmentsForNote.
  if (b.contentJson !== undefined) await claimAttachmentsForNote(uid, id, contentJson);

  const row = (await getNoteRow(uid, id))!;
  res.status(201).json({ note: await noteFull(row) });
});

// --- Single-note routes ----------------------------------------------------------

router.get('/:id', async (req, res) => {
  const uid = userId(req);
  const row = await getNoteRow(uid, req.params.id);
  if (!row) {
    res.status(404).json({ error: 'note not found' });
    return;
  }

  // `links` has no user_id of its own, so the owner filter goes on the joined note.
  const backlinkRows = await db
    .prepare(
      `SELECT n.* FROM links l JOIN notes n ON n.id = l.from_note_id
       WHERE l.to_note_id = ? AND n.user_id = ? ORDER BY n.updated_at DESC`,
    )
    .all<NoteRow>(row.id, uid);
  const outgoingRows = await db
    .prepare(
      `SELECT n.* FROM links l JOIN notes n ON n.id = l.to_note_id
       WHERE l.from_note_id = ? AND n.user_id = ? ORDER BY n.updated_at DESC`,
    )
    .all<NoteRow>(row.id, uid);

  res.json({
    note: await noteFull(row),
    backlinks: await Promise.all(backlinkRows.map(r => noteLite(r))),
    outgoingLinks: await Promise.all(outgoingRows.map(r => noteLite(r))),
  });
});

router.patch('/:id', async (req, res) => {
  const uid = userId(req);
  const row = await getNoteRow(uid, req.params.id);
  if (!row) {
    res.status(404).json({ error: 'note not found' });
    return;
  }

  const b = req.body ?? {};
  if (b.notebookId !== undefined) {
    // Moving a note into a notebook the caller does not own would hand it to them, and
    // moving one into a tombstoned notebook would hide it from every list.
    const notebook = await db
      .prepare('SELECT id FROM notebooks WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
      .get<{ id: string }>(b.notebookId, uid);
    if (!notebook) {
      res.status(400).json({ error: 'unknown notebookId' });
      return;
    }
  }
  const contentJsonError = validateContentJson(b.contentJson);
  if (contentJsonError) {
    res.status(400).json({ error: contentJsonError });
    return;
  }

  const newTitle = b.title !== undefined ? String(b.title) : row.title;
  const newContentJson = b.contentJson !== undefined ? JSON.stringify(b.contentJson) : row.content_json;
  const newContentText =
    b.contentText !== undefined
      ? String(b.contentText)
      : b.contentJson !== undefined
        ? plainTextFromDoc(b.contentJson)
        : row.content_text;
  const newPinned = b.pinned !== undefined ? (b.pinned ? 1 : 0) : row.pinned;
  const newArchived = b.archived !== undefined ? (b.archived ? 1 : 0) : row.archived;
  const newNotebookId = b.notebookId !== undefined ? b.notebookId : row.notebook_id;

  // Conflict adjudication, for a write that arrived from an offline client.
  //
  // `baseUpdatedAt` absent means "no opinion, do not check", which is every write the
  // website itself makes - so this whole block is a no-op on the existing path and no
  // existing caller sees any difference.
  const editedAt = clampEditTime(
    typeof b.clientUpdatedAt === 'string' ? b.clientUpdatedAt : undefined,
    row.created_at,
    nowIso(),
  );
  const decision = resolve({
    currentUpdatedAt: row.updated_at,
    baseUpdatedAt: typeof b.baseUpdatedAt === 'string' ? b.baseUpdatedAt : null,
    clientUpdatedAt: editedAt,
  });

  let versionId: number | undefined;
  if (decision.conflicted) {
    // Whichever side loses is preserved before anything is overwritten. Doing this
    // BEFORE the update is what makes the guarantee true if the update then fails.
    // `row.id` came from the owner-scoped lookup at the top of the handler, so these
    // history rows are provably the caller's.
    versionId =
      decision.winner === 'client'
        ? await demoteToVersion(row.id, row.title, row.content_json)
        : await demoteToVersion(row.id, newTitle, newContentJson);
  }

  if (decision.winner === 'server') {
    // The client's edit lost. Hand back the server's record so the client can apply it
    // and stop retrying; its own copy is safe in history, above.
    res.json({ note: await noteFull(row), conflicted: true, versionId });
    return;
  }

  const contentChanging = b.title !== undefined || b.contentJson !== undefined || b.contentText !== undefined;
  // A conflict already filed the outgoing body as a version, so the autosave would be
  // a second snapshot of identical content.
  if (contentChanging && versionId === undefined && (await shouldAutosaveSnapshot(uid, row.id))) {
    await insertVersion(uid, row.id, row.title, row.content_json, 'autosave');
  }

  await db
    .prepare(
      `UPDATE notes SET title = ?, content_json = ?, content_text = ?, pinned = ?, archived = ?, notebook_id = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
    )
    .run(newTitle, newContentJson, newContentText, newPinned, newArchived, newNotebookId, nowIso(), row.id, uid);

  if (b.tags !== undefined) await setTags(uid, row.id, b.tags);
  if (b.contentText !== undefined || b.contentJson !== undefined) await syncLinksForNote(uid, row.id, newContentText);
  // The editor uploads an image before it knows which note it lands in, so this autosave is
  // the first owner-authenticated moment the pairing is knowable. Recording it here is what
  // lets a share guest load the picture without the read path having to trust note body text.
  if (b.contentJson !== undefined) await claimAttachmentsForNote(uid, row.id, newContentJson);
  // Renaming a note is link-preserving: fix up the [[oldTitle]] references in every note
  // that links here so backlinks (and the on-screen wikilink text) follow the new title.
  // Confined to this user's notes - a shared title must not rewrite anyone else's text.
  if (b.title !== undefined && newTitle !== row.title) {
    await renameWikilinksToTitle(uid, row.id, row.title, newTitle);
  }

  const updated = (await getNoteRow(uid, row.id))!;

  // Publish to the note's change feed so anyone on a share link sees the owner's
  // edit. No-ops for unshared notes - see lib/events.ts.
  await recordNoteEvent(
    row.id,
    'doc',
    { title: b.title !== undefined ? newTitle : null },
    uid,
  );

  res.json({ note: await noteFull(updated), conflicted: decision.conflicted, versionId });
});

// Soft-delete: move to trash. Version history survives; a boot-time sweep hard-purges
// notes deleted >30 days ago (see db.ts purgeExpiredDeletedNotes).
router.delete('/:id', async (req, res) => {
  const uid = userId(req);
  const row = await getNoteRow(uid, req.params.id);
  if (!row) {
    res.status(404).json({ error: 'note not found' });
    return;
  }
  // updated_at moves with deleted_at, and that is not cosmetic. GET /api/sync/changes
  // serves rows ordered by (updated_at, id) and clients pull with a cursor, so a
  // tombstone whose updated_at stayed put is invisible to any client already synced
  // past it: the delete never arrives, and that client re-uploads the note from its
  // outbox - resurrecting it. Same reasoning in the undelete below.
  const deletedAt = nowIso();
  await db
    .prepare('UPDATE notes SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(deletedAt, deletedAt, row.id, uid);
  // Drop outgoing links so a trashed note stops appearing as a backlink elsewhere.
  // `row.id` came from the owner-scoped lookup above, so these link rows are provably
  // the caller's; `links` has no user_id column of its own to filter on.
  await db.prepare('DELETE FROM links WHERE from_note_id = ? OR to_note_id = ?').run(row.id, row.id);
  res.json({ ok: true });
});

// Undo a soft-delete within the retention window.
router.post('/:id/undelete', async (req, res) => {
  const uid = userId(req);
  const row = await getNoteRowAny(uid, req.params.id);
  if (!row) {
    res.status(404).json({ error: 'note not found' });
    return;
  }
  if (!row.deleted_at) {
    res.json({ note: await noteFull(row) }); // already live - no-op
    return;
  }
  // Clearing the tombstone is itself a change a client must see, so updated_at advances
  // here too - otherwise the restore is invisible to anyone past the old cursor and the
  // note stays deleted on every other device.
  await db
    .prepare('UPDATE notes SET deleted_at = NULL, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(nowIso(), row.id, uid);
  // Rebuild this note's outgoing links and any incoming links from live notes.
  await syncLinksForNote(uid, row.id, row.content_text);
  await resyncNotesReferencingTitle(uid, row.title, row.id);
  const restored = (await getNoteRow(uid, row.id))!;
  res.json({ note: await noteFull(restored) });
});

router.get('/:id/versions', async (req, res) => {
  const uid = userId(req);
  const note = await getNoteRow(uid, req.params.id);
  if (!note) {
    res.status(404).json({ error: 'note not found' });
    return;
  }
  // note_versions has no user_id; the join to notes carries the ownership filter.
  const rows = await db
    .prepare(
      `SELECT v.id, v.title, v.content_json, v.cause, v.label, v.created_at
       FROM note_versions v JOIN notes n ON n.id = v.note_id
       WHERE v.note_id = ? AND n.user_id = ?
       ORDER BY v.created_at DESC, v.id DESC`,
    )
    .all<VersionRow>(note.id, uid);
  res.json({ versions: rows.map(versionMeta) });
});

router.get('/:id/versions/:vid', async (req, res) => {
  const uid = userId(req);
  const note = await getNoteRow(uid, req.params.id);
  if (!note) {
    res.status(404).json({ error: 'note not found' });
    return;
  }
  const vid = parseVersionId(req.params.vid);
  const v =
    vid === null
      ? undefined
      : await db
          .prepare(
            `SELECT v.id, v.title, v.content_json, v.cause, v.label, v.created_at
             FROM note_versions v JOIN notes n ON n.id = v.note_id
             WHERE v.id = ? AND v.note_id = ? AND n.user_id = ?`,
          )
          .get<VersionRow>(vid, note.id, uid);
  if (!v) {
    res.status(404).json({ error: 'version not found' });
    return;
  }
  res.json({ version: { id: v.id, title: v.title, contentJson: JSON.parse(v.content_json), cause: v.cause, label: v.label, createdAt: v.created_at } });
});

router.post('/:id/versions', async (req, res) => {
  const uid = userId(req);
  const note = await getNoteRow(uid, req.params.id);
  if (!note) {
    res.status(404).json({ error: 'note not found' });
    return;
  }
  const label = typeof req.body?.label === 'string' && req.body.label.trim() ? req.body.label.trim() : null;
  const v = await insertVersion(uid, note.id, note.title, note.content_json, 'manual', label);
  if (!v) {
    // Only reachable if the note vanished between the lookup and the insert.
    res.status(404).json({ error: 'note not found' });
    return;
  }
  res.status(201).json({ version: versionMeta(v) });
});

router.post('/:id/restore/:vid', async (req, res) => {
  const uid = userId(req);
  const note = await getNoteRow(uid, req.params.id);
  if (!note) {
    res.status(404).json({ error: 'note not found' });
    return;
  }
  const vid = parseVersionId(req.params.vid);
  const v =
    vid === null
      ? undefined
      : await db
          .prepare(
            `SELECT v.id, v.title, v.content_json
             FROM note_versions v JOIN notes n ON n.id = v.note_id
             WHERE v.id = ? AND v.note_id = ? AND n.user_id = ?`,
          )
          .get<{ id: number; title: string; content_json: string }>(vid, note.id, uid);
  if (!v) {
    res.status(404).json({ error: 'version not found' });
    return;
  }

  await insertVersion(uid, note.id, note.title, note.content_json, 'restore');

  const restoredContentText = plainTextFromDoc(JSON.parse(v.content_json));
  await db
    .prepare('UPDATE notes SET title = ?, content_json = ?, content_text = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(v.title, v.content_json, restoredContentText, nowIso(), note.id, uid);
  await syncLinksForNote(uid, note.id, restoredContentText);

  const updated = (await getNoteRow(uid, note.id))!;
  res.json({ note: await noteFull(updated) });
});

router.get('/:id/export', async (req, res) => {
  const uid = userId(req);
  const note = await getNoteRow(uid, req.params.id);
  if (!note) {
    res.status(404).json({ error: 'note not found' });
    return;
  }
  const format = typeof req.query.format === 'string' ? req.query.format : 'markdown';
  if (format !== 'markdown') {
    res.status(400).json({ error: 'unsupported export format' });
    return;
  }

  const markdown = tiptapToMarkdown(JSON.parse(note.content_json) as TTNode);
  const safeName = (note.title || 'untitled').replace(/[^a-z0-9\-_ ]/gi, '').trim().replace(/\s+/g, '-').slice(0, 80) || 'untitled';

  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}.md"`);
  res.send(markdown);
});

router.get('/:id/unlinked-mentions', async (req, res) => {
  const uid = userId(req);
  const note = await getNoteRow(uid, req.params.id);
  if (!note) {
    res.status(404).json({ error: 'note not found' });
    return;
  }
  if (!note.title.trim()) {
    res.json({ notes: [] });
    return;
  }

  const linkedIds = new Set(
    (
      await db
        .prepare(
          `SELECT l.from_note_id FROM links l JOIN notes n ON n.id = l.from_note_id
           WHERE l.to_note_id = ? AND n.user_id = ?`,
        )
        .all<{ from_note_id: string }>(note.id, uid)
    ).map(r => r.from_note_id),
  );

  // The candidate scan is a full-text LIKE over note bodies, so the owner filter here
  // is load-bearing: without it this endpoint would report (and snippet) other users'
  // notes that happen to mention this title.
  const candidates = await db
    .prepare(
      `SELECT * FROM notes
       WHERE user_id = ? AND id != ? AND archived = 0 AND deleted_at IS NULL
         AND lower(content_text) LIKE lower(?) ESCAPE '\\'`,
    )
    .all<NoteRow>(uid, note.id, `%${escapeLike(note.title)}%`);

  const filtered = candidates.filter(c => !linkedIds.has(c.id));
  res.json({ notes: await Promise.all(filtered.map(r => noteLite(r))) });
});

export default router;
