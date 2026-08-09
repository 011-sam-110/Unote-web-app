import { db } from '../db.js';

export interface NotebookLiteRow { id: string; name: string; emoji: string; color: string }

// Every lookup below is owner-scoped. These helpers are exported and are called
// with ids that ultimately trace back to the request (`/notes/:id`, a notebook id
// off a narrow SELECT), so a bare `WHERE id = ?` here would let any signed-in user
// read another user's tags, attachments or notebook chrome by guessing an id.
// `deleted_at IS NULL`: notebooks are tombstoned rather than hard-deleted (so the delete
// can replicate to an offline client), and this is the notebook chrome every note
// projection carries. Without it a note restored from the trash would still be labelled
// with a notebook the sidebar no longer lists; `notebook: null` is the honest answer.
const notebookLiteStmt = () =>
  db.prepare('SELECT id, name, emoji, color FROM notebooks WHERE id = ? AND user_id = ? AND deleted_at IS NULL');
// note_tags carries no user_id, so ownership is proven by joining up to the parent note.
const tagsStmt = () =>
  db.prepare(
    `SELECT t.tag FROM note_tags t
     JOIN notes n ON n.id = t.note_id
     WHERE t.note_id = ? AND n.user_id = ?
     ORDER BY t.tag`,
  );
// attachments carry their own user_id, so the owner check is a direct indexed
// predicate rather than a join - note_id is nullable here (ON DELETE SET NULL),
// so the attachment's own user_id is the authoritative owner, not the note's.
const attachmentsStmt = () =>
  db.prepare(
    `SELECT id, kind, original_name, stored_name, mime, size, status, created_at
     FROM attachments WHERE note_id = ? AND user_id = ? AND status != 'failed' ORDER BY created_at ASC`,
  );

export interface AttachmentDto {
  id: string;
  kind: string;
  originalName: string;
  url: string;
  mime: string;
  size: number;
  status: string;
  createdAt: string;
}

/** Attachments (photo/pdf/office originals) kept next to a note so an OCR'd source is
 *  always one click away - "never destructive OCR". */
export async function attachmentsOf(noteId: string, uid: string): Promise<AttachmentDto[]> {
  const rows = await attachmentsStmt().all<{
    id: string; kind: string; original_name: string; stored_name: string; mime: string; size: number; status: string; created_at: string;
  }>(noteId, uid);
  return rows.map(r => ({
    id: r.id,
    kind: r.kind,
    originalName: r.original_name,
    url: `/uploads/${r.stored_name}`,
    mime: r.mime,
    size: r.size,
    status: r.status,
    createdAt: r.created_at,
  }));
}

export function snippetOf(text: string, len = 160): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, len);
}

export function wordCountOf(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

export async function notebookLite(id: string, uid: string): Promise<NotebookLiteRow | null> {
  return (await notebookLiteStmt().get<NotebookLiteRow>(id, uid)) ?? null;
}

export async function tagsOf(noteId: string, uid: string): Promise<string[]> {
  return (await tagsStmt().all<{ tag: string }>(noteId, uid)).map(r => r.tag);
}

// Raw notes table row (snake_case as stored). `user_id` is required: the two
// serialisers below read it to scope their child lookups, so a caller that
// projects a narrower column set must not be typed as a NoteRow.
export interface NoteRow {
  id: string; user_id: string; notebook_id: string; title: string; content_json: string; content_text: string;
  // 'doc' (TipTap document) | 'canvas' (infinite board; its children live in
  // canvas_items/canvas_edges). Optional here because a handful of older callers
  // predate the column - they fall back to 'doc' in the serialisers below.
  kind?: string;
  pinned: number; archived: number; created_at: string; updated_at: string;
}

/**
 * The owner of a note row, as recorded by the database.
 *
 * Children are scoped to the note's *stored* owner rather than to the caller's
 * session id. That is the correct key: `notes.user_id` is written by the server
 * and never taken from user input, and scoping to it means the tags/notebook
 * attached to a note always belong to that same note. Gating *whether* the
 * caller may see this row at all remains the fetching query's job - every
 * `SELECT ... FROM notes` must still carry its own `user_id = ?` predicate.
 */
function ownerOf(row: NoteRow): string {
  // Fail loudly rather than silently serialising a note with no tags/notebook,
  // which is what a `SELECT id, title, ...` projection cast to NoteRow would do.
  if (!row.user_id) throw new Error('note row is missing user_id - SELECT it (or use SELECT *)');
  return row.user_id;
}

export async function noteLite(row: NoteRow) {
  const uid = ownerOf(row);
  // Two independent round-trips to Postgres: issue them together rather than
  // serially, since each is now a network hop rather than a local file read.
  const [tags, notebook] = await Promise.all([tagsOf(row.id, uid), notebookLite(row.notebook_id, uid)]);
  return {
    id: row.id,
    notebookId: row.notebook_id,
    title: row.title,
    // Lists branch their icon on this, and NotePage branches its whole editor on
    // it, so every note projection carries it rather than forcing a second fetch.
    kind: row.kind === 'canvas' ? 'canvas' : 'doc',
    snippet: snippetOf(row.content_text),
    pinned: Boolean(row.pinned),
    archived: Boolean(row.archived),
    updatedAt: row.updated_at,
    createdAt: row.created_at,
    tags,
    notebook,
    wordCount: wordCountOf(row.content_text),
  };
}

export async function noteFull(row: NoteRow) {
  const uid = ownerOf(row);
  const [tags, notebook, attachments] = await Promise.all([
    tagsOf(row.id, uid),
    notebookLite(row.notebook_id, uid),
    attachmentsOf(row.id, uid),
  ]);
  return {
    id: row.id,
    notebookId: row.notebook_id,
    title: row.title,
    kind: row.kind === 'canvas' ? 'canvas' : 'doc',
    contentJson: JSON.parse(row.content_json),
    contentText: row.content_text,
    pinned: Boolean(row.pinned),
    archived: Boolean(row.archived),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tags,
    notebook,
    attachments,
  };
}
