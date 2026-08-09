// Bulk "Import old notes" staging + commit.
//
// The single-file /api/import path (routes/imports.ts) creates one note per upload and
// always calls the AI gateway. This module backs the bulk wizard, which is the opposite in
// every way that matters: it stages a whole pile of documents/photos into import_batches /
// import_items, an auto-sort is proposed with ZERO AI, and NOTHING lands in a real notebook
// until the user commits. The gateway can be completely offline and a student can still drop
// a folder of notes, review the proposed sort, and file it.
//
// Nothing in here calls a model. Commit reuses the app's no-AI note-create path
// (markdownToTipTap + a plain INSERT into notes), exactly as the lecture flow does.
//
// Ownership convention mirrors the rest of the route layer: the owner id ALWAYS comes from
// the session (`uid`), never from a request body, and every statement is scoped by user_id
// so a batch/item id named in a request can only ever reach the caller's own rows.
import path from 'node:path';
import { db, tx, newId, nowIso } from '../db.js';
import { markdownToTipTap, markdownToPlainText, stripLeadingTitleHeading } from './markdown.js';
import { createTitleResolver, syncLinksForNote } from './links.js';
import { insertAttachment, withTempFile, attachmentUrl, claimAttachmentsForNote } from './attachments.js';
import { extractFromUpload } from './extract.js';
import type { NoteRow } from './serialize.js';

/** A single import cannot grow without bound: it protects Neon storage and keeps the review
 *  screen usable. The client also chunks commit, so this is the staging ceiling, not a commit
 *  one. */
export const MAX_ITEMS_PER_BATCH = 200;
/** Commit is client-orchestrated in small resumable slices; this bounds one slice so a chunk
 *  can never approach the 60s function timeout. */
export const MAX_COMMIT_CHUNK = 100;

// --- shared text helpers (tokeniser mirrored client-side in features/import/categorise) -----

// A small, deliberately boring stopword list. It must match the client tokeniser
// (web/src/features/import/categorise/heuristic.ts) so an item's TF vector and a notebook's
// profile are built the same way and cosine similarity is meaningful across the wire.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'her', 'was', 'one',
  'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how', 'man', 'new', 'now', 'old', 'see',
  'two', 'way', 'who', 'boy', 'did', 'its', 'let', 'put', 'say', 'she', 'too', 'use', 'that',
  'this', 'with', 'have', 'from', 'they', 'will', 'your', 'what', 'when', 'were', 'there',
  'their', 'which', 'would', 'about', 'into', 'them', 'then', 'than', 'some', 'such', 'only',
  'also', 'been', 'more', 'most', 'other', 'these', 'those', 'here', 'each', 'because',
]);

function tokenize(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return words.filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

function wordCount(text: string): number {
  const m = text.trim().match(/\S+/g);
  return m ? m.length : 0;
}

const MAX_TAG_LENGTH = 32;
/** Canonical tag spelling - mirrors routes/tags.ts and web/src/lib/tags.ts. Tags are matched
 *  by plain equality everywhere, so a divergent spelling would create a tag half the app can
 *  no longer find. */
function normalizeTag(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_/-]+/gu, '')
    .replace(/^[-_/]+|[-_/]+$/g, '');
  if (!cleaned) return null;
  return cleaned.slice(0, MAX_TAG_LENGTH).replace(/^[-_/]+|[-_/]+$/g, '') || null;
}

function normalizeTags(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const t of list) {
    const n = normalizeTag(t);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

function parseJsonArray(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function firstHeading(markdown: string): string {
  const m = markdown.match(/^#{1,6}\s+(.+)$/m);
  return m ? m[1].trim().slice(0, 200) : '';
}

function titleFromFilename(name: string): string {
  const base = name.replace(/\.[^./]+$/, '');
  const cleaned = base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || 'Imported note';
}

/** Title precedence: an explicit (user/derived) title, then a leading H1, then the filename. */
function deriveTitle(explicit: string | null | undefined, markdown: string, originalName: string): string {
  const e = (explicit ?? '').trim();
  if (e) return e.slice(0, 200);
  return (firstHeading(markdown) || titleFromFilename(originalName)).slice(0, 200);
}

const PHOTO_MIME_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
};
function photoExt(mime: string, name: string): string {
  return PHOTO_MIME_EXT[mime] || path.extname(name).toLowerCase() || '.jpg';
}

// --- row + DTO shapes ------------------------------------------------------------------------

interface BatchRow {
  id: string;
  user_id: string;
  source: string;
  status: string;
  categoriser: string | null;
  item_count: number;
  created_at: string;
  updated_at: string;
}

interface ItemRow {
  id: string;
  batch_id: string;
  user_id: string;
  attachment_id: string | null;
  source_path: string | null;
  original_name: string;
  kind: string;
  title: string;
  source_text: string;
  content_text: string;
  word_count: number;
  source_tags: string;
  suggested_notebook_id: string | null;
  suggested_notebook_name: string | null;
  suggested_tags: string;
  confidence: number;
  rationale: string | null;
  decided_notebook_id: string | null;
  decided_notebook_name: string | null;
  decided_tags: string | null;
  decided_mode: string;
  decided_target_note_id: string | null;
  group_key: string | null;
  group_index: number;
  captured_at: string | null;
  status: string;
  note_id: string | null;
  error: string | null;
  created_at: string;
  attachment_stored_name?: string | null;
}

export interface ImportBatchDto {
  id: string;
  source: string;
  status: string;
  categoriser: string | null;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ImportItemDto {
  id: string;
  batchId: string;
  attachmentId: string | null;
  sourcePath: string | null;
  originalName: string;
  kind: string;
  title: string;
  /** First 2KB of the plain-text mirror, for the read-only review preview. */
  preview: string;
  wordCount: number;
  sourceTags: string[];
  suggestedNotebookId: string | null;
  suggestedNotebookName: string | null;
  suggestedTags: string[];
  confidence: number;
  rationale: string | null;
  decidedNotebookId: string | null;
  decidedNotebookName: string | null;
  decidedTags: string[] | null;
  decidedMode: string;
  decidedTargetNoteId: string | null;
  /** Items sharing a groupKey become ONE note, ordered by groupIndex. Null = its own note. */
  groupKey: string | null;
  groupIndex: number;
  /** When the photo was taken (ISO). Drives grouping, and the "why" line in review. */
  capturedAt: string | null;
  status: string;
  noteId: string | null;
  error: string | null;
  imageUrl: string | null;
  createdAt: string;
}

function batchDto(b: BatchRow): ImportBatchDto {
  return {
    id: b.id,
    source: b.source,
    status: b.status,
    categoriser: b.categoriser,
    itemCount: b.item_count,
    createdAt: b.created_at,
    updatedAt: b.updated_at,
  };
}

function itemDto(r: ItemRow): ImportItemDto {
  return {
    id: r.id,
    batchId: r.batch_id,
    attachmentId: r.attachment_id,
    sourcePath: r.source_path,
    originalName: r.original_name,
    kind: r.kind,
    title: r.title,
    preview: (r.content_text || '').slice(0, 2000),
    wordCount: r.word_count,
    sourceTags: parseJsonArray(r.source_tags),
    suggestedNotebookId: r.suggested_notebook_id,
    suggestedNotebookName: r.suggested_notebook_name,
    suggestedTags: parseJsonArray(r.suggested_tags),
    confidence: r.confidence,
    rationale: r.rationale,
    decidedNotebookId: r.decided_notebook_id,
    decidedNotebookName: r.decided_notebook_name,
    decidedTags: r.decided_tags != null ? parseJsonArray(r.decided_tags) : null,
    decidedMode: r.decided_mode,
    decidedTargetNoteId: r.decided_target_note_id,
    groupKey: r.group_key,
    groupIndex: r.group_index,
    capturedAt: r.captured_at,
    status: r.status,
    noteId: r.note_id,
    error: r.error,
    imageUrl: r.attachment_stored_name ? attachmentUrl(r.attachment_stored_name) : null,
    createdAt: r.created_at,
  };
}

// --- ownership-scoped reads ------------------------------------------------------------------

const ITEM_SELECT =
  'SELECT i.*, a.stored_name as attachment_stored_name FROM import_items i ' +
  'LEFT JOIN attachments a ON a.id = i.attachment_id';

async function ownedBatch(uid: string, batchId: string): Promise<BatchRow | undefined> {
  return db.prepare('SELECT * FROM import_batches WHERE id = ? AND user_id = ?').get<BatchRow>(batchId, uid);
}

async function getItemRow(uid: string, batchId: string, itemId: string): Promise<ItemRow | undefined> {
  return db
    .prepare(`${ITEM_SELECT} WHERE i.id = ? AND i.batch_id = ? AND i.user_id = ?`)
    .get<ItemRow>(itemId, batchId, uid);
}

async function enforceCap(batchId: string, adding: number): Promise<void> {
  const row = await db
    .prepare('SELECT COUNT(*) as c FROM import_items WHERE batch_id = ?')
    .get<{ c: number }>(batchId);
  const existing = Number(row?.c ?? 0);
  if (existing + adding > MAX_ITEMS_PER_BATCH) {
    throw new Error(`This import already holds ${existing} items (max ${MAX_ITEMS_PER_BATCH}). Start another import for the rest.`);
  }
}

async function syncBatchCount(uid: string, batchId: string): Promise<void> {
  await db
    .prepare(
      'UPDATE import_batches SET item_count = (SELECT COUNT(*) FROM import_items WHERE batch_id = ?), updated_at = ? WHERE id = ? AND user_id = ?',
    )
    .run(batchId, nowIso(), batchId, uid);
}

// --- batch lifecycle -------------------------------------------------------------------------

export async function createBatch(uid: string, source: unknown): Promise<string> {
  const src = String(source ?? 'files').slice(0, 40);
  const id = newId();
  const now = nowIso();
  await db
    .prepare('INSERT INTO import_batches (id, user_id, source, status, item_count, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)')
    .run(id, uid, src, 'open', now, now);
  return id;
}

export async function getBatch(uid: string, batchId: string): Promise<{ batch: ImportBatchDto; items: ImportItemDto[] } | null> {
  const b = await ownedBatch(uid, batchId);
  if (!b) return null;
  const rows = await db
    .prepare(`${ITEM_SELECT} WHERE i.batch_id = ? AND i.user_id = ? ORDER BY i.created_at ASC, i.id ASC`)
    .all<ItemRow>(batchId, uid);
  return { batch: batchDto(b), items: rows.map(itemDto) };
}

export async function discardBatch(uid: string, batchId: string): Promise<boolean> {
  const b = await ownedBatch(uid, batchId);
  if (!b) return false;
  // Staged photo/office attachments are referenced FROM import_items (attachment_id, ON DELETE
  // SET NULL), so the cascade from the batch does not remove them. Delete the never-committed
  // ones (note_id still NULL) explicitly, owner-scoped, so a discarded batch leaves no orphan
  // bytes in Neon. A committed item's attachment (note_id set) is left alone - it belongs to a
  // real note now.
  await db
    .prepare(
      `DELETE FROM attachments WHERE user_id = ? AND note_id IS NULL AND id IN (
         SELECT attachment_id FROM import_items WHERE batch_id = ? AND attachment_id IS NOT NULL)`,
    )
    .run(uid, batchId);
  await db.prepare('DELETE FROM import_batches WHERE id = ? AND user_id = ?').run(batchId, uid);
  return true;
}

// --- staging ---------------------------------------------------------------------------------

export interface RawStageItem {
  originalName?: unknown;
  sourcePath?: unknown;
  title?: unknown;
  text?: unknown;
  sourceTags?: unknown;
}

/** Stage already-extracted text docs (md/txt/pdf extracted client-side). No upload of the raw
 *  file - only its text crosses the wire. The note body is kept as raw markdown in source_text
 *  and turned into TipTap at commit. */
export async function stageJsonItems(uid: string, batchId: string, items: RawStageItem[]): Promise<ImportItemDto[]> {
  const b = await ownedBatch(uid, batchId);
  if (!b) return [];
  await enforceCap(batchId, items.length);
  const out: ImportItemDto[] = [];
  for (const raw of items) {
    const originalName = String(raw.originalName ?? 'note.md').slice(0, 300);
    const sourcePath = raw.sourcePath != null ? String(raw.sourcePath).slice(0, 400) : null;
    const text = String(raw.text ?? '');
    const title = deriveTitle(raw.title != null ? String(raw.title) : null, text, originalName);
    const contentText = markdownToPlainText(text);
    const sourceTags = normalizeTags(raw.sourceTags);
    const id = newId();
    await db
      .prepare(
        `INSERT INTO import_items
           (id, batch_id, user_id, source_path, original_name, kind, title, source_text, content_text, word_count, source_tags, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'doc', ?, ?, ?, ?, ?, 'ready', ?)`,
      )
      .run(id, batchId, uid, sourcePath, originalName, title, text, contentText, wordCount(contentText), JSON.stringify(sourceTags), nowIso());
    const row = await getItemRow(uid, batchId, id);
    if (row) out.push(itemDto(row));
  }
  await syncBatchCount(uid, batchId);
  return out;
}

export interface UploadFile {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
}

/** Stage a docx/pptx that has no browser extractor: extract server-side (officeparser) and
 *  keep only the text. The raw file is NOT stored. */
export async function stageUploadedFile(
  uid: string,
  batchId: string,
  file: UploadFile,
  meta: { sourcePath?: string | null; title?: string | null },
): Promise<ImportItemDto | null> {
  const b = await ownedBatch(uid, batchId);
  if (!b) return null;
  await enforceCap(batchId, 1);
  const ext = path.extname(file.originalname).toLowerCase();
  let text = '';
  let status = 'ready';
  let error: string | null = null;
  try {
    const res = await withTempFile(file.buffer, ext, (fp) => extractFromUpload(fp, file.mimetype, file.originalname));
    text = res.text;
  } catch (err) {
    status = 'failed';
    error = err instanceof Error ? err.message : 'could not read this file';
  }
  const title = deriveTitle(meta.title ?? null, text, file.originalname);
  const contentText = markdownToPlainText(text);
  const id = newId();
  await db
    .prepare(
      `INSERT INTO import_items
         (id, batch_id, user_id, source_path, original_name, kind, title, source_text, content_text, word_count, source_tags, status, error, created_at)
       VALUES (?, ?, ?, ?, ?, 'doc', ?, ?, ?, ?, '[]', ?, ?, ?)`,
    )
    .run(id, batchId, uid, meta.sourcePath ?? null, file.originalname.slice(0, 300), title, text, contentText, wordCount(contentText), status, error, nowIso());
  await syncBatchCount(uid, batchId);
  const row = await getItemRow(uid, batchId, id);
  return row ? itemDto(row) : null;
}

/** Stage a photo: its (downscaled) bytes ARE stored as an attachment, because the note shows
 *  the image. OCR text is supplied by the client (tesseract.js, best-effort) and used for the
 *  note body + the categoriser; when OCR yielded nothing the photo still imports as an image
 *  note, sorted by filename/path. */
export async function stagePhoto(
  uid: string,
  batchId: string,
  file: UploadFile,
  meta: { sourcePath?: string | null; title?: string | null; ocrText?: string | null; capturedAt?: string | null },
): Promise<ImportItemDto | null> {
  const b = await ownedBatch(uid, batchId);
  if (!b) return null;
  await enforceCap(batchId, 1);
  const storedName = `${newId()}${photoExt(file.mimetype, file.originalname)}`;
  const attachmentId = await insertAttachment({
    uid,
    noteId: null,
    kind: 'photo',
    originalName: file.originalname,
    storedName,
    mime: file.mimetype || 'image/jpeg',
    bytes: file.buffer,
    status: 'ready',
  });
  const url = attachmentUrl(storedName);
  const ocr = (meta.ocrText ?? '').trim();
  const alt = (meta.title || file.originalname || 'Imported photo').replace(/[[\]]/g, '');
  // The image node is what makes the committed note show the picture; claimAttachmentsForNote
  // files the attachment against the note at commit because this /uploads URL is in the body.
  const sourceText = `![${alt}](${url})` + (ocr ? `\n\n${ocr}` : '');
  const contentText = ocr;
  const title = deriveTitle(meta.title ?? null, ocr, file.originalname);
  const id = newId();
  await db
    .prepare(
      `INSERT INTO import_items
         (id, batch_id, user_id, attachment_id, source_path, original_name, kind, title, source_text, content_text, word_count, source_tags, captured_at, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'photo', ?, ?, ?, ?, '[]', ?, 'ready', ?)`,
    )
    .run(id, batchId, uid, attachmentId, meta.sourcePath ?? null, file.originalname.slice(0, 300), title, sourceText, contentText, wordCount(contentText), isoOrNull(meta.capturedAt), nowIso());
  await syncBatchCount(uid, batchId);
  const row = await getItemRow(uid, batchId, id);
  return row ? itemDto(row) : null;
}

/** Accept only a real ISO timestamp for captured_at - a camera with an unset clock, or a bogus
 *  client value, is worse than no signal because grouping would trust it. */
function isoOrNull(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  const year = new Date(ms).getUTCFullYear();
  if (year < 1990 || year > 2100) return null;
  return new Date(ms).toISOString();
}

// --- grouping (which staged photos become pages of one note) ---------------------------------

export interface RawGroup {
  /** Stable key for the group. Items carrying the same key commit into a single note. */
  key?: unknown;
  /** Item ids IN PAGE ORDER. Position in this array becomes group_index. */
  itemIds?: unknown;
  /** Title for the resulting note; applied to the first page, which commit uses as the note title. */
  title?: unknown;
  /** Why the grouper drew this boundary ("28 min gap before") - shown in review, stored so a
   *  refresh does not lose the explanation. */
  rationale?: unknown;
  /** Notebook chosen for the whole group. Written to every page's decision, because commit
   *  resolves the notebook from the leader and a later re-lead must not change the answer. */
  notebookId?: unknown;
}

/**
 * Replace the grouping for a batch.
 *
 * Wholesale rather than incremental: both groupers (capture-time clustering and the single AI
 * call) produce a complete partition of the batch, and the review screen edits a complete
 * partition too, so a partial update has no meaning. Any item not named in `groups` is reset to
 * ungrouped, which is the correct reading of "the new grouping does not mention it".
 *
 * Already-committed items are left alone: re-grouping after a partial commit must not move a
 * page that is already inside a real note.
 */
export async function setGroups(
  uid: string,
  batchId: string,
  groups: RawGroup[],
  grouper: unknown,
): Promise<{ items: ImportItemDto[]; grouper: string } | null> {
  const b = await ownedBatch(uid, batchId);
  if (!b) return null;

  await db
    .prepare("UPDATE import_items SET group_key = NULL, group_index = 0 WHERE batch_id = ? AND user_id = ? AND status <> 'committed'")
    .run(batchId, uid);

  const seen = new Set<string>();
  for (const g of Array.isArray(groups) ? groups : []) {
    const key = String(g.key ?? newId()).slice(0, 64);
    const ids = Array.isArray(g.itemIds) ? g.itemIds.map((x) => String(x)) : [];
    const title = g.title != null && String(g.title).trim() ? String(g.title).trim().slice(0, 200) : null;
    const rationale = g.rationale != null ? String(g.rationale).slice(0, 200) : null;
    // Validate the notebook against the caller's OWN notebooks: a group is user input, and an id
    // from a request body must never be trusted to name a row.
    let notebookId: string | null = null;
    if (g.notebookId) {
      const owned = await db.prepare('SELECT id FROM notebooks WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get<{ id: string }>(String(g.notebookId), uid);
      notebookId = owned?.id ?? null;
    }
    let index = 0;
    for (const itemId of ids) {
      if (seen.has(itemId)) continue; // an item can only be a page of one note
      const item = await getItemRow(uid, batchId, itemId);
      if (!item || item.status === 'committed') continue;
      seen.add(itemId);
      // Only the first page carries the group's title, because commit derives the note title
      // from the leader. Later pages keep their own titles for the review list.
      const applyTitle = index === 0 && title ? title : item.title;
      await db
        .prepare(
          `UPDATE import_items SET group_key = ?, group_index = ?, title = ?,
             rationale = COALESCE(?, rationale),
             decided_notebook_id = COALESCE(?, decided_notebook_id),
             decided_notebook_name = CASE WHEN ?::text IS NULL THEN decided_notebook_name ELSE NULL END
           WHERE id = ? AND user_id = ?`,
        )
        .run(key, index, applyTitle, index === 0 ? rationale : null, notebookId, notebookId, itemId, uid);
      index++;
    }
  }

  const name = String(grouper ?? 'capture-time').slice(0, 40);
  await db.prepare('UPDATE import_batches SET updated_at = ? WHERE id = ? AND user_id = ?').run(nowIso(), batchId, uid);
  const rows = await db.prepare(`${ITEM_SELECT} WHERE i.batch_id = ? AND i.user_id = ? ORDER BY i.group_key NULLS LAST, i.group_index, i.created_at`).all<ItemRow>(batchId, uid);
  return { items: rows.map(itemDto), grouper: name };
}

// --- suggestions (categoriser output persisted) ----------------------------------------------

export interface RawSuggestion {
  itemId?: unknown;
  notebook?: { kind?: unknown; id?: unknown; name?: unknown } | null;
  tags?: unknown;
  title?: unknown;
  confidence?: unknown;
  rationale?: unknown;
}

/** Persist the categoriser's proposed sort onto the staged items. The heuristic runs
 *  client-side (locked decision), so the client posts the suggestions here and this records
 *  them so review survives a refresh. Decision fields default to the suggestion the first time
 *  round (COALESCE keeps any edit the user already made). */
export async function saveSuggestions(
  uid: string,
  batchId: string,
  categoriser: unknown,
  suggestions: RawSuggestion[],
): Promise<{ categoriser: string; items: ImportItemDto[] } | null> {
  const b = await ownedBatch(uid, batchId);
  if (!b) return null;
  const updated: ImportItemDto[] = [];
  for (const s of suggestions) {
    const itemId = String(s.itemId ?? '');
    const item = await getItemRow(uid, batchId, itemId);
    if (!item) continue; // ignore unknown/foreign item ids silently
    const nb = s.notebook ?? {};
    let sugId: string | null = null;
    let sugName: string | null = null;
    if (nb.kind === 'existing' && nb.id) {
      const owned = await db.prepare('SELECT id FROM notebooks WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get<{ id: string }>(String(nb.id), uid);
      if (owned) sugId = owned.id;
    } else if (nb.kind === 'new' && nb.name) {
      sugName = String(nb.name).trim().slice(0, 80) || null;
    }
    const tags = JSON.stringify(normalizeTags(s.tags));
    const confidence = clamp01(Number(s.confidence ?? 0));
    const rationale = s.rationale != null ? String(s.rationale).slice(0, 200) : null;
    const title = s.title != null && String(s.title).trim() ? String(s.title).slice(0, 200) : item.title;
    await db
      .prepare(
        `UPDATE import_items SET
           suggested_notebook_id = ?, suggested_notebook_name = ?, suggested_tags = ?,
           confidence = ?, rationale = ?, title = ?,
           decided_notebook_id = COALESCE(decided_notebook_id, ?),
           decided_notebook_name = COALESCE(decided_notebook_name, ?),
           decided_tags = COALESCE(decided_tags, ?),
           status = CASE WHEN status IN ('pending','ready','categorised') THEN 'categorised' ELSE status END
         WHERE id = ? AND user_id = ?`,
      )
      .run(sugId, sugName, tags, confidence, rationale, title, sugId, sugName, tags, itemId, uid);
    const fresh = await getItemRow(uid, batchId, itemId);
    if (fresh) updated.push(itemDto(fresh));
  }
  const cat = String(categoriser ?? 'heuristic').slice(0, 40);
  await db
    .prepare("UPDATE import_batches SET categoriser = ?, status = CASE WHEN status = 'open' THEN 'categorised' ELSE status END, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(cat, nowIso(), batchId, uid);
  return { categoriser: cat, items: updated };
}

// --- per-item decisions ----------------------------------------------------------------------

export interface DecisionPatch {
  decidedNotebookId?: unknown;
  decidedNotebookName?: unknown;
  decidedTags?: unknown;
  title?: unknown;
  status?: unknown;
  decidedMode?: unknown;
  decidedTargetNoteId?: unknown;
}

export async function decideItem(uid: string, batchId: string, itemId: string, patch: DecisionPatch): Promise<ImportItemDto | null> {
  const item = await getItemRow(uid, batchId, itemId);
  if (!item) return null;

  let decidedNotebookId = item.decided_notebook_id;
  let decidedNotebookName = item.decided_notebook_name;
  if ('decidedNotebookId' in patch) {
    if (patch.decidedNotebookId) {
      const owned = await db.prepare('SELECT id FROM notebooks WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get<{ id: string }>(String(patch.decidedNotebookId), uid);
      if (!owned) throw new Error('unknown notebook');
      decidedNotebookId = owned.id;
      decidedNotebookName = null; // choosing an existing notebook clears any proposed new-notebook name
    } else {
      decidedNotebookId = null;
    }
  }
  if ('decidedNotebookName' in patch) {
    const nm = patch.decidedNotebookName ? String(patch.decidedNotebookName).trim().slice(0, 80) : '';
    if (nm) {
      decidedNotebookName = nm;
      decidedNotebookId = null; // proposing a new notebook clears any existing-notebook choice
    } else {
      decidedNotebookName = null;
    }
  }

  let decidedTags = item.decided_tags;
  if ('decidedTags' in patch) decidedTags = JSON.stringify(normalizeTags(patch.decidedTags));

  let title = item.title;
  if ('title' in patch && patch.title != null && String(patch.title).trim()) title = String(patch.title).slice(0, 200);

  let status = item.status;
  if (patch.status === 'accepted' || patch.status === 'rejected') status = patch.status;

  let decidedMode = item.decided_mode;
  if (patch.decidedMode === 'new' || patch.decidedMode === 'append') decidedMode = patch.decidedMode;

  let decidedTarget = item.decided_target_note_id;
  if ('decidedTargetNoteId' in patch) {
    if (patch.decidedTargetNoteId) {
      const owned = await db.prepare('SELECT id FROM notes WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get<{ id: string }>(String(patch.decidedTargetNoteId), uid);
      if (!owned) throw new Error('unknown note');
      decidedTarget = owned.id;
    } else {
      decidedTarget = null;
    }
  }

  await db
    .prepare(
      `UPDATE import_items SET decided_notebook_id = ?, decided_notebook_name = ?, decided_tags = ?, title = ?, status = ?, decided_mode = ?, decided_target_note_id = ?
       WHERE id = ? AND user_id = ?`,
    )
    .run(decidedNotebookId, decidedNotebookName, decidedTags, title, status, decidedMode, decidedTarget, itemId, uid);
  const fresh = await getItemRow(uid, batchId, itemId);
  return fresh ? itemDto(fresh) : null;
}

// --- commit (the no-AI note-create path) -----------------------------------------------------

// Every notebook lookup in this file carries `deleted_at IS NULL`. Notebooks are
// tombstoned rather than hard-deleted (a hard delete cannot replicate to an offline
// client), so without it an import would resolve to, and file notes into, a notebook the
// student has trashed - invisible in every list. The MAX(position) query below is the one
// exception: it is a write-side slot allocation, and skipping tombstones there would hand
// a new notebook a position a trashed one still holds.
async function findNotebookByName(uid: string, name: string): Promise<string | undefined> {
  const row = await db
    .prepare('SELECT id FROM notebooks WHERE user_id = ? AND deleted_at IS NULL AND lower(name) = lower(?) ORDER BY created_at ASC LIMIT 1')
    .get<{ id: string }>(uid, name);
  return row?.id;
}

async function createNotebook(uid: string, name: string): Promise<string> {
  const id = newId();
  const now = nowIso();
  const maxPos = ((await db.prepare('SELECT COALESCE(MAX(position), -1) as m FROM notebooks WHERE user_id = ?').get<{ m: number }>(uid)) as { m: number }).m;
  await db
    // updated_at explicitly, not via the column default: the default is the DATABASE clock
    // while every notebook mutation stamps the APP clock, and mixing the two can leave a
    // later edit carrying an EARLIER updated_at than the insert - a sync cursor that goes
    // backwards.
    .prepare('INSERT INTO notebooks (id, user_id, name, emoji, color, position, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)')
    .run(id, uid, name.slice(0, 80), '📓', '#6366f1', maxPos + 1, now, now);
  return id;
}

async function setNoteTags(uid: string, noteId: string, tags: string[]): Promise<void> {
  await tx(async (t) => {
    await t.prepare('DELETE FROM note_tags WHERE note_id IN (SELECT id FROM notes WHERE id = ? AND user_id = ?)').run(noteId, uid);
    const stmt = t.prepare(
      `INSERT INTO note_tags (note_id, tag) SELECT id, ? FROM notes WHERE id = ? AND user_id = ? ON CONFLICT DO NOTHING`,
    );
    for (const tag of tags) await stmt.run(tag, noteId, uid);
  });
}

/** Add tags without clearing existing ones - a grouped note collects tags from every page it
 *  absorbs, and a group split across two commit chunks must not have the first chunk's tags
 *  wiped by the second. */
async function addNoteTags(uid: string, noteId: string, tags: string[]): Promise<void> {
  if (!tags.length) return;
  const stmt = db.prepare(
    `INSERT INTO note_tags (note_id, tag) SELECT id, ? FROM notes WHERE id = ? AND user_id = ? ON CONFLICT DO NOTHING`,
  );
  for (const tag of tags) await stmt.run(tag, noteId, uid);
}

/** Create a real note from staged markdown, with NO AI. Mirrors the lecture flow's plain
 *  POST /api/notes path: markdown -> TipTap (wikilinks resolved against the user's notes),
 *  plain-text mirror, links synced, embedded /uploads images filed. */
async function createNoteNoAi(uid: string, notebookId: string, title: string, sourceText: string): Promise<string> {
  const body = stripLeadingTitleHeading(sourceText, title);
  const resolver = await createTitleResolver(uid, body);
  const contentJson = JSON.stringify(markdownToTipTap(body, resolver));
  const contentText = markdownToPlainText(body);
  const id = newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO notes (id, user_id, notebook_id, title, content_json, content_text, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, uid, notebookId, title, contentJson, contentText, now, now);
  await syncLinksForNote(uid, id, contentText);
  await claimAttachmentsForNote(uid, id, contentJson);
  return id;
}

/** Append staged markdown into an existing note (merge mode), re-reading fresh content under
 *  FOR UPDATE so a concurrent write cannot be clobbered. No AI - a plain structural append. */
async function appendNoAi(uid: string, noteId: string, sourceText: string): Promise<void> {
  const resolver = await createTitleResolver(uid, sourceText);
  const newJson = markdownToTipTap(sourceText, resolver) as { type: 'doc'; content?: unknown[] };
  const appendText = markdownToPlainText(sourceText);
  const mergedText = await tx(async (t) => {
    const row = await t.prepare('SELECT * FROM notes WHERE id = ? AND user_id = ? FOR UPDATE').get<NoteRow>(noteId, uid);
    if (!row) throw new Error('merge target no longer exists');
    const existing = JSON.parse(row.content_json) as { type: 'doc'; content?: unknown[] };
    const content = [...(existing.content ?? []), ...(newJson.content ?? [])];
    const mergedJson = { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
    const merged = [row.content_text, appendText].filter(Boolean).join('\n\n');
    await t.prepare('UPDATE notes SET content_json = ?, content_text = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(
      JSON.stringify(mergedJson),
      merged,
      nowIso(),
      noteId,
      uid,
    );
    return merged;
  });
  await syncLinksForNote(uid, noteId, mergedText);
}

export interface CommitResult {
  created: number;
  skipped: number;
  failed: number;
  createdNotebooks: Array<{ id: string; name: string }>;
  items: ImportItemDto[];
  batchStatus: string;
}

/**
 * Commit a slice of the batch into real notebooks. Client sends the item ids it wants filed,
 * in small resumable chunks. Idempotent: an already-committed item is skipped, a rejected one
 * is skipped, so re-sending a chunk after a dropped connection is safe.
 *
 * New notebooks are resolved-or-created ONCE per name and only ever for an item actually being
 * committed here - so a proposed notebook the user never accepted is never created, which is
 * the "conservative new-notebook creation" rule enforced at the write.
 */
export async function commitBatch(uid: string, batchId: string, itemIds: string[]): Promise<CommitResult | null> {
  const b = await ownedBatch(uid, batchId);
  if (!b) return null;
  await db.prepare("UPDATE import_batches SET status = 'committing', updated_at = ? WHERE id = ? AND user_id = ?").run(nowIso(), batchId, uid);

  const ids = itemIds.slice(0, MAX_COMMIT_CHUNK);
  const nbCache = new Map<string, string>(); // lower(name) -> notebook id resolved/created this call
  const createdNotebooks: Array<{ id: string; name: string }> = [];
  const committedItems: ImportItemDto[] = [];
  let created = 0;
  let skipped = 0;
  let failed = 0;

  /** Resolve the target notebook: an explicitly-chosen existing one (validated), else a
   *  proposed new one (resolve-or-create by name), else the single "Unsorted" bucket. */
  async function resolveNotebook(item: ItemRow): Promise<string> {
    if (item.decided_notebook_id ?? item.suggested_notebook_id) {
      const chosen = (item.decided_notebook_id ?? item.suggested_notebook_id)!;
      const owned = await db.prepare('SELECT id FROM notebooks WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get<{ id: string }>(chosen, uid);
      if (!owned) throw new Error('chosen notebook not found');
      return owned.id;
    }
    const name = (item.decided_notebook_name ?? item.suggested_notebook_name ?? '').trim() || 'Unsorted';
    const key = name.toLowerCase();
    let nb = nbCache.get(key);
    if (!nb) {
      nb = await findNotebookByName(uid, name);
      if (!nb) {
        nb = await createNotebook(uid, name);
        createdNotebooks.push({ id: nb, name });
      }
      nbCache.set(key, nb);
    }
    return nb;
  }

  function itemTags(item: ItemRow): string[] {
    return normalizeTags(item.decided_tags != null ? parseJsonArray(item.decided_tags) : parseJsonArray(item.suggested_tags));
  }

  async function fileAttachment(item: ItemRow, noteId: string): Promise<void> {
    if (!item.attachment_id) return;
    await db
      .prepare('UPDATE attachments SET note_id = ? WHERE id = ? AND user_id = ? AND note_id IS NULL')
      .run(noteId, item.attachment_id, uid);
  }

  async function markCommitted(item: ItemRow, noteId: string, title: string): Promise<void> {
    await db
      .prepare("UPDATE import_items SET status = 'committed', note_id = ?, title = ?, error = NULL WHERE id = ? AND user_id = ?")
      .run(noteId, title, item.id, uid);
    const fresh = await getItemRow(uid, batchId, item.id);
    if (fresh) committedItems.push(itemDto(fresh));
  }

  // --- partition the requested ids into commit UNITS -------------------------------------------
  //
  // A unit is everything that ends up in ONE note: a lone ungrouped item (every document import,
  // and the original behaviour), or all the requested items sharing a group_key (photos that are
  // pages of the same handout). Order within the unit is group_index, which is what makes page 2
  // land after page 1 rather than in upload-completion order.
  interface Unit { groupKey: string | null; items: ItemRow[] }
  const units: Unit[] = [];
  const byGroup = new Map<string, Unit>();

  for (const rawId of ids) {
    const item = await getItemRow(uid, batchId, String(rawId));
    if (!item) {
      skipped++;
      continue;
    }
    if (item.status === 'committed' || item.note_id) {
      skipped++;
      committedItems.push(itemDto(item));
      continue;
    }
    if (item.status === 'rejected') {
      skipped++;
      continue;
    }
    if (item.group_key) {
      let unit = byGroup.get(item.group_key);
      if (!unit) {
        unit = { groupKey: item.group_key, items: [] };
        byGroup.set(item.group_key, unit);
        units.push(unit);
      }
      unit.items.push(item);
    } else {
      units.push({ groupKey: null, items: [item] });
    }
  }

  for (const unit of units) {
    const pages = unit.items.slice().sort((a, b) => a.group_index - b.group_index || a.created_at.localeCompare(b.created_at));
    const lead = pages[0];
    try {
      // The note this unit's pages belong in. Three ways to find it, in order:
      let noteId: string | null = null;

      // 1. A sibling from the same group committed in an EARLIER chunk. This is what makes a
      //    group survive being split across commit slices, or a retry after a dropped connection,
      //    without producing a second half-note.
      if (unit.groupKey) {
        const sibling = await db
          .prepare(
            `SELECT note_id FROM import_items
             WHERE batch_id = ? AND user_id = ? AND group_key = ? AND note_id IS NOT NULL
             ORDER BY group_index ASC LIMIT 1`,
          )
          .get<{ note_id: string }>(batchId, uid, unit.groupKey);
        if (sibling?.note_id) {
          const alive = await db
            .prepare('SELECT id FROM notes WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
            .get<{ id: string }>(sibling.note_id, uid);
          if (alive) noteId = alive.id;
        }
      }

      // 2. The user chose to merge this unit into a note that already exists.
      if (!noteId && lead.decided_mode === 'append' && lead.decided_target_note_id) {
        const owned = await db
          .prepare('SELECT id FROM notes WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
          .get<{ id: string }>(lead.decided_target_note_id, uid);
        if (!owned) throw new Error('merge target not found');
        noteId = owned.id;
      }

      // 3. Otherwise the first page creates the note and the rest append to it.
      let leadConsumed = false;
      if (!noteId) {
        const notebookId = await resolveNotebook(lead);
        const leadTitle = deriveTitle(lead.title, lead.source_text, lead.original_name);
        noteId = await createNoteNoAi(uid, notebookId, leadTitle, lead.source_text);
        const tags = itemTags(lead);
        if (tags.length) await setNoteTags(uid, noteId, tags);
        await fileAttachment(lead, noteId);
        await markCommitted(lead, noteId, leadTitle);
        leadConsumed = true;
      }

      for (const page of pages) {
        if (leadConsumed && page.id === lead.id) continue;
        await appendNoAi(uid, noteId, page.source_text);
        await addNoteTags(uid, noteId, itemTags(page));
        await fileAttachment(page, noteId);
        await markCommitted(page, noteId, deriveTitle(page.title, page.source_text, page.original_name));
      }

      created++; // one unit filed = one note, which is the number the review screen promised
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'could not import this item';
      // A group fails together: half a handout is worse than none, and the user can retry the
      // whole group after fixing whatever went wrong.
      for (const page of pages) {
        const fresh = await getItemRow(uid, batchId, page.id);
        if (fresh?.status === 'committed') continue; // already filed earlier in this unit
        failed++;
        await db.prepare("UPDATE import_items SET status = 'failed', error = ? WHERE id = ? AND user_id = ?").run(msg, page.id, uid);
      }
    }
  }

  // The batch is "committed" only when nothing is left to file; otherwise it drops back to
  // "categorised" so the client can resume the remaining slices.
  const remaining = await db
    .prepare("SELECT COUNT(*) as c FROM import_items WHERE batch_id = ? AND status NOT IN ('committed','rejected','failed')")
    .get<{ c: number }>(batchId);
  const batchStatus = Number(remaining?.c ?? 0) === 0 ? 'committed' : 'categorised';
  await db.prepare('UPDATE import_batches SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(batchStatus, nowIso(), batchId, uid);

  return { created, skipped, failed, createdNotebooks, items: committedItems, batchStatus };
}

// --- label space for the client heuristic ----------------------------------------------------

export interface LabelSpaceDto {
  notebooks: Array<{ id: string; name: string; emoji: string }>;
  tags: string[];
  /** notebookId -> term -> tf weight (0..1, normalised by the notebook's top term). */
  profiles: Record<string, Record<string, number>>;
  /** term -> number of notebooks whose profile contains it (for IDF weighting client-side). */
  docFreq: Record<string, number>;
  notebookCount: number;
}

/** Everything the client heuristic needs to sort into the user's existing label space: the
 *  notebooks, the tag vocabulary, and a cheap bag-of-words term profile per notebook built
 *  from its notes' content_text. Computed server-side because the server already holds every
 *  note; the client would otherwise have to download them all. */
export async function labelSpace(uid: string): Promise<LabelSpaceDto> {
  const notebooks = await db
    .prepare('SELECT id, name, emoji FROM notebooks WHERE user_id = ? AND deleted_at IS NULL AND archived = 0 ORDER BY position ASC, created_at ASC')
    .all<{ id: string; name: string; emoji: string }>(uid);

  const tagRows = await db
    .prepare(
      `SELECT nt.tag as tag, COUNT(*) as c FROM note_tags nt JOIN notes n ON n.id = nt.note_id
       WHERE n.user_id = ? AND n.archived = 0 AND n.deleted_at IS NULL
       GROUP BY nt.tag ORDER BY c DESC, nt.tag ASC LIMIT 200`,
    )
    .all<{ tag: string; c: number }>(uid);
  const tags = tagRows.map((r) => r.tag);

  const noteRows = await db
    .prepare('SELECT notebook_id, content_text FROM notes WHERE user_id = ? AND archived = 0 AND deleted_at IS NULL LIMIT 4000')
    .all<{ notebook_id: string; content_text: string }>(uid);

  const perNb = new Map<string, Map<string, number>>();
  for (const r of noteRows) {
    let counts = perNb.get(r.notebook_id);
    if (!counts) {
      counts = new Map();
      perNb.set(r.notebook_id, counts);
    }
    for (const tok of tokenize(String(r.content_text ?? '').slice(0, 8000))) counts.set(tok, (counts.get(tok) ?? 0) + 1);
  }

  const profiles: Record<string, Record<string, number>> = {};
  const docFreq: Record<string, number> = {};
  for (const [nb, counts] of perNb) {
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50);
    const max = sorted.length ? sorted[0][1] : 1;
    const prof: Record<string, number> = {};
    for (const [term, freq] of sorted) {
      prof[term] = freq / max;
      docFreq[term] = (docFreq[term] ?? 0) + 1;
    }
    profiles[nb] = prof;
  }

  return {
    notebooks: notebooks.map((n) => ({ id: n.id, name: n.name, emoji: n.emoji })),
    tags,
    profiles,
    docFreq,
    notebookCount: perNb.size,
  };
}

// --- connector registry (server advertises setup/availability) -------------------------------

export interface ImportSourceDto {
  id: string;
  label: string;
  setup: 'none' | 'oauth' | 'coming-soon';
  available: boolean;
}

/** Advertised so the Stage-1 grid can grey out sources that are not ready (OAuth, coming-soon)
 *  without a client change when one is enabled. The client registry owns presentation
 *  (icon/accept); this owns availability. */
export function sourcesRegistry(): ImportSourceDto[] {
  return [
    { id: 'files', label: 'Documents', setup: 'none', available: true },
    { id: 'photos', label: 'Photos', setup: 'none', available: true },
    { id: 'markdown', label: 'Markdown / folder', setup: 'none', available: true },
    { id: 'obsidian', label: 'Obsidian vault', setup: 'coming-soon', available: false },
    { id: 'notion', label: 'Notion export', setup: 'coming-soon', available: false },
    { id: 'gdocs', label: 'Google Docs', setup: 'oauth', available: false },
  ];
}
