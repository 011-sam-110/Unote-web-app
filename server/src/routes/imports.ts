import { Router, type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import multer from 'multer';
import path from 'node:path';
import { IS_SERVERLESS } from '../config.js';
import { db, tx, newId, nowIso } from '../db.js';
import { userId } from '../auth/middleware.js';
import { AiError, capForAi, extractJson } from '../ai/client.js';
import { aiQuotaGate, aiCtx, complete, type AiContext } from '../ai/gate.js';
import { ocrPhotoPrompt, slidesRestructurePrompt, transcriptNotesPrompt, improvePrompt, titlePrompt, cleanTitle, groupPhotosPrompt, type PhotoForGrouping } from '../ai/prompts.js';
import { extractFromUpload } from '../lib/extract.js';
import { extractPptxImages, type SlideImage } from '../lib/slideImages.js';
import { pagesProvenance, timelineProvenance, serialiseProvenance, type Provenance } from '../lib/provenance.js';
import { insertAttachment, withTempFile, attachmentUrl } from '../lib/attachments.js';
import { markdownToTipTap, markdownToPlainText, stripLeadingTitleHeading } from '../lib/markdown.js';
import { syncLinksForNote, createTitleResolver } from '../lib/links.js';
import { createJob, updateJob, getJob } from '../lib/jobs.js';
import type { NoteRow } from '../lib/serialize.js';
import * as bulk from '../lib/importBatch.js';

const router = Router();

// Auth is mounted once, in app.ts (`app.use('/api/import', requireAuth, ...)`), so this
// router does not add its own guard - one layer means one place to audit and one session
// lookup per request. `userId(req)` throws if that mount ever loses the guard, so the
// failure mode is a loud 500, never an unscoped query.

/**
 * Upload ceiling.
 *
 * Vercel rejects a request whose body exceeds ~4.5MB before it ever reaches this handler,
 * so advertising the old 25MB in production was a promise the platform overrules - the
 * user got an opaque platform error instead of our message. Cap below that ourselves and
 * multipart framing overhead still fits, so anything we accept genuinely uploads.
 *
 * Local/self-hosted runs have no such ceiling, so they keep the larger limit.
 */
const MAX_SIZE = IS_SERVERLESS ? 4 * 1024 * 1024 : 25 * 1024 * 1024;
const MAX_SIZE_LABEL = IS_SERVERLESS ? '4MB' : '25MB';

const MIME_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
};
const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.pdf', '.txt', '.md', '.pptx', '.docx']);

function safeExt(originalName: string, mime: string): string {
  const fromMime = MIME_EXT[mime];
  if (fromMime) return fromMime;
  const ext = path.extname(originalName).toLowerCase();
  return ALLOWED_EXT.has(ext) ? ext : '';
}

function fileFilter(_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (MIME_EXT[file.mimetype] || ALLOWED_EXT.has(ext)) return cb(null, true);
  cb(new Error(`Unsupported file type: ${file.mimetype || ext || 'unknown'}`));
}

// Uploads are held in memory and persisted into attachments.bytes; nothing touches the
// local filesystem. diskStorage used to write into data/uploads/, which is read-only on
// a serverless host - every import in production died with EROFS. Memory storage is the
// one path that behaves identically in both places.
//
// Bounded by MAX_SIZE above, so "in memory" is at most a few MB per in-flight request.
const storage = multer.memoryStorage();

const upload = multer({ storage, limits: { fileSize: MAX_SIZE }, fileFilter });
const uploadImage = multer({ storage, limits: { fileSize: MAX_SIZE } });

/** The name an upload is stored and served under. Also the key /uploads/:name looks up. */
function storedNameFor(originalName: string, mime: string): string {
  return `${newId()}${safeExt(originalName, mime)}`;
}

/** Wraps a multer single-file middleware so upload errors become clean JSON, not a 500. */
function handleUpload(mw: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    mw(req, res, (err: unknown) => {
      if (!err) return next();
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ error: `File is too large (max ${MAX_SIZE_LABEL})` });
        return;
      }
      const message = err instanceof Error ? err.message : 'upload failed';
      res.status(400).json({ error: message });
    });
  };
}

type ImportKind = 'photo' | 'slides' | 'transcript';
type ImportMode = 'new' | 'append' | 'improve';
const KINDS: ImportKind[] = ['photo', 'slides', 'transcript'];
const MODES: ImportMode[] = ['new', 'append', 'improve'];

// PPTX/DOCX are handled by officeparser (see lib/extract.ts) - the slides/transcript
// kinds accept them too, matching the client's advertised accept lists (import/kinds.ts).
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export function kindAccepts(kind: ImportKind, mime: string, name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  if (kind === 'photo') return /^image\/(jpeg|png|webp|heic|heif)$/.test(mime) || ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif'].includes(ext);
  if (kind === 'slides') return mime === 'application/pdf' || mime === PPTX_MIME || ext === '.pdf' || ext === '.pptx';
  return (
    mime === 'application/pdf' ||
    mime === 'text/plain' ||
    mime === 'text/markdown' ||
    mime === DOCX_MIME ||
    ['.pdf', '.txt', '.md', '.docx'].includes(ext)
  );
}

async function markAttachment(id: string, status: string, uid: string): Promise<void> {
  await db.prepare('UPDATE attachments SET status = ? WHERE id = ? AND user_id = ?').run(status, id, uid);
}

function firstHeading(markdown: string): string {
  const m = markdown.match(/^#{1,6}\s+(.+)$/m);
  return m ? m[1].trim().slice(0, 200) : '';
}

// Re-exported for the unit tests; lives in lib/markdown.ts so seed.ts shares it.
export { stripLeadingTitleHeading };


// --- Per-note write serialization (fix: concurrent import writes to the same note) -------
// Import jobs run async (extraction + AI awaits before the write), and every DB call is now
// async too. Two jobs (or an import racing a live PATCH) targeting one note could otherwise
// interleave read → await → write and clobber each other. A per-note promise chain forces
// them through one at a time. It only covers this process, so it is a fast path rather than
// the guarantee: each write also re-reads fresh content under SELECT ... FOR UPDATE, which
// holds across connections (and across serverless instances).
const noteLocks = new Map<string, Promise<unknown>>();
export function withNoteLock<T>(noteId: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = noteLocks.get(noteId) ?? Promise.resolve();
  const result = prev.then(() => fn(), () => fn());
  const settled = result.then(() => {}, () => {});
  noteLocks.set(noteId, settled);
  void settled.then(() => {
    if (noteLocks.get(noteId) === settled) noteLocks.delete(noteId);
  });
  return result;
}

function titleFromFilename(name: string): string {
  const base = name.replace(/\.[^./]+$/, '');
  const cleaned = base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || 'Imported note';
}

async function resolveTitle(ctx: AiContext, markdown: string, contentText: string, originalName: string): Promise<string> {
  try {
    const { text } = await complete(ctx, titlePrompt(capForAi(contentText || markdown, 8_000)));
    const cleaned = cleanTitle(text);
    if (cleaned) return cleaned;
  } catch {
    // AI title generation failing shouldn't fail the whole import - fall back below.
  }
  return firstHeading(markdown) || titleFromFilename(originalName);
}

async function createNoteFromMarkdown(ctx: AiContext, markdown: string, notebookId: string, originalName: string, uid: string): Promise<string> {
  const title = await resolveTitle(ctx, markdown, markdownToPlainText(markdown), originalName);
  // Don't duplicate the title as the first body heading (fix: imported notes showed it twice).
  const body = stripLeadingTitleHeading(markdown, title);
  const contentJson = markdownToTipTap(body, await createTitleResolver(uid, body));
  const contentText = markdownToPlainText(body);

  const id = newId();
  const now = nowIso();
  // The owner is the session user, never anything from the request body; `notebookId` was
  // checked against that same user before the job was queued.
  await db.prepare(
    `INSERT INTO notes (id, user_id, notebook_id, title, content_json, content_text, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, uid, notebookId, title, JSON.stringify(contentJson), contentText, now, now);
  await syncLinksForNote(uid, id, contentText);
  return id;
}

/** Append extracted markdown to a note, re-reading its FRESH content inside a transaction so
 *  a concurrent write can't be clobbered. Serialized per note via withNoteLock. */
export async function appendMarkdownToNote(noteId: string, markdown: string, uid: string): Promise<string> {
  const newJson = markdownToTipTap(markdown, await createTitleResolver(uid, markdown)) as { type: 'doc'; content?: unknown[] };
  const appendText = markdownToPlainText(markdown);
  const mergedText = await tx(async (t) => {
    // FOR UPDATE is what makes the re-read meaningful under Postgres: at READ COMMITTED a plain
    // SELECT takes no lock, so another writer could commit between this read and the UPDATE -
    // exactly the clobber this transaction exists to prevent.
    // `user_id = ?` is the ownership check: noteId arrives from the request, so without it any
    // signed-in user could append into someone else's note.
    const row = await t
      .prepare('SELECT * FROM notes WHERE id = ? AND user_id = ? FOR UPDATE')
      .get<NoteRow>(noteId, uid);
    if (!row) throw new Error('target note no longer exists');
    const existingJson = JSON.parse(row.content_json) as { type: 'doc'; content?: unknown[] };
    const mergedContent = [...(existingJson.content ?? []), ...(newJson.content ?? [])];
    const mergedJson = { type: 'doc', content: mergedContent.length ? mergedContent : [{ type: 'paragraph' }] };
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
  // Runs after the commit: syncLinksForNote opens its own transaction on the pool, so calling
  // it inside the block above would execute outside this transaction anyway.
  await syncLinksForNote(uid, noteId, mergedText);
  return noteId;
}

async function mergeMarkdownIntoNote(ctx: AiContext, noteId: string, markdown: string, uid: string): Promise<string> {
  // Read a snapshot for the AI prompt (this is the only async step - it happens BEFORE the
  // write transaction re-reads, so the transaction can detect a concurrent change).
  const snapshot = await db
    .prepare('SELECT * FROM notes WHERE id = ? AND user_id = ?')
    .get<NoteRow>(noteId, uid);
  if (!snapshot) throw new Error('target note no longer exists');

  const combined = capForAi(
    `EXISTING NOTES:\n\n${snapshot.content_text || '(empty)'}\n\n---\n\nNEW MATERIAL TO INTEGRATE:\n\n${markdown}`,
  );
  const instruction =
    'Merge the NEW MATERIAL into the EXISTING NOTES into one coherent, deduplicated set of notes. Preserve every fact from both - do not drop anything. ' +
    'Where they overlap, keep the clearer/more complete version. Add new sections for genuinely new topics. Keep the existing structure where it still fits.';
  const { text } = await complete(ctx, improvePrompt(combined, instruction));
  const mergedMarkdown = text.trim();

  // Both branches below convert markdown to TipTap, and the resolver has to be built before the
  // transaction opens (its lookups are async and belong on the pool, not the transaction's
  // connection) - so resolve the titles of both candidate bodies in one pass.
  const resolve = await createTitleResolver(uid, `${mergedMarkdown}\n${markdown}`);

  const mergedText = await tx(async (t) => {
    // Owner-scoped and FOR UPDATE for the same reasons as appendMarkdownToNote.
    const fresh = await t
      .prepare('SELECT * FROM notes WHERE id = ? AND user_id = ? FOR UPDATE')
      .get<NoteRow>(noteId, uid);
    if (!fresh) throw new Error('target note no longer exists');
    // Snapshot the note as it was BEFORE this merge, per contract (cause 'import').
    // note_versions has no user_id; ownership comes from `fresh` having been read under the
    // user_id predicate above, so this can only ever version a note the caller owns.
    await t.prepare("INSERT INTO note_versions (note_id, title, content_json, cause) VALUES (?, ?, ?, 'import')").run(
      noteId,
      fresh.title,
      fresh.content_json,
    );

    let merged: string;
    let mergedJsonStr: string;
    if (fresh.content_text === snapshot.content_text) {
      // No concurrent change: the AI's blended result is authoritative.
      merged = markdownToPlainText(mergedMarkdown);
      mergedJsonStr = JSON.stringify(markdownToTipTap(mergedMarkdown, resolve));
    } else {
      // The note changed during the AI call - the blended result is stale. Degrade to a
      // non-destructive append of the extracted material so nothing the other writer added
      // is lost (better a slightly-less-tidy merge than silent data loss).
      const existingJson = JSON.parse(fresh.content_json) as { type: 'doc'; content?: unknown[] };
      const addJson = markdownToTipTap(markdown, resolve) as { type: 'doc'; content?: unknown[] };
      const content = [...(existingJson.content ?? []), ...(addJson.content ?? [])];
      mergedJsonStr = JSON.stringify({ type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] });
      merged = [fresh.content_text, markdownToPlainText(markdown)].filter(Boolean).join('\n\n');
    }

    await t.prepare('UPDATE notes SET content_json = ?, content_text = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(
      mergedJsonStr,
      merged,
      nowIso(),
      noteId,
      uid,
    );
    return merged;
  });
  await syncLinksForNote(uid, noteId, mergedText);
  return noteId;
}

/**
 * Only .pptx carries an unpackable media folder, so it is the only format the figure pass
 * runs against. A PDF import skips it entirely rather than trying and reporting nothing -
 * embedded-image extraction from PDF is a different problem and is not implemented.
 */
export function isPptx(mime: string, originalName: string): boolean {
  return mime === PPTX_MIME || path.extname(originalName).toLowerCase() === '.pptx';
}

// Bounds on the figure pass. A pathological deck should not be able to turn one import
// into hundreds of rows or tens of megabytes of writes.
const MAX_FIGURES = 40;
const MAX_FIGURE_TOTAL_BYTES = 24 * 1024 * 1024;

/**
 * A labelled gallery of the deck's figures, tagged by the slide each came from.
 *
 * Deliberately appended as its own section rather than interleaved with the prose. The
 * slide text is restructured by the model before the note is written, so nothing reliable
 * survives linking a finished paragraph back to the slide a picture sat on. Guessing at
 * placement would drop diagrams beside text they do not illustrate - confidently wrong,
 * and harder to spot than an honest gallery the reader can match up by slide number.
 */
export function figuresMarkdown(figures: Array<{ slide: number; url: string }>): string {
  if (!figures.length) return '';
  const out = ['## Figures from the slides', ''];
  for (const f of figures) {
    out.push(`**Slide ${f.slide}**`, '', `![Figure from slide ${f.slide}](${f.url})`, '');
  }
  return out.join('\n').trimEnd();
}

/** Persist extracted figures as attachments owned by `uid` and filed against `noteId`. */
async function storeFigures(
  figures: SlideImage[],
  uid: string,
  noteId: string,
): Promise<Array<{ slide: number; url: string }>> {
  const stored: Array<{ slide: number; url: string }> = [];
  let total = 0;
  for (const fig of figures.slice(0, MAX_FIGURES)) {
    if (total + fig.bytes.byteLength > MAX_FIGURE_TOTAL_BYTES) break;
    total += fig.bytes.byteLength;
    const storedName = `${newId()}${path.extname(fig.name).toLowerCase() || '.png'}`;
    await insertAttachment({
      uid,
      noteId,
      kind: 'image',
      originalName: path.basename(fig.name),
      storedName,
      mime: fig.mime,
      bytes: fig.bytes,
      status: 'ready',
    });
    stored.push({ slide: fig.slide, url: attachmentUrl(storedName) });
  }
  return stored;
}

interface ProcessArgs {
  jobId: string;
  attachmentId: string;
  /** The upload itself. Held in memory - there is no durable disk on a serverless host. */
  bytes: Buffer;
  mime: string;
  originalName: string;
  kind: ImportKind;
  mode: ImportMode;
  /** Owner of the import - taken from the session, never from the request body. */
  uid: string;
  /**
   * Whose AI budget this job spends, resolved from the request before it was queued.
   *
   * Carried on the args rather than re-resolved in here because the job outlives its
   * request: by the time the model is called there is no `req` to read a key or a quota
   * verdict from. Threading it explicitly also keeps the charge attached to the user who
   * actually asked for the import, not to whoever the process happens to be serving next.
   */
  aiCtx: AiContext;
  notebookId?: string;
  noteId?: string;
}

async function processImport(args: ProcessArgs): Promise<void> {
  // Renamed on the way out of the args: `aiCtx` is also the imported request-narrowing
  // helper, and shadowing it here would read as if the context could still be re-derived.
  const { jobId, attachmentId, bytes, mime, originalName, kind, mode, uid, aiCtx: ctx, notebookId, noteId } = args;
  await updateJob(jobId, { status: 'running', step: 'Extracting text…' });
  await markAttachment(attachmentId, 'extracting', uid);

  try {
    let extractedMarkdown: string;
    let figures: SlideImage[] = [];
    /**
     * Where this upload's material sits inside the file, captured from the RAW extraction.
     *
     * It has to be taken here, before the AI pass below: `slidesRestructurePrompt` is told to
     * drop slide numbers and footers, so by the time `extracted_text` is written the position
     * every citation needs has already been thrown away. See lib/provenance.ts.
     */
    let provenance: Provenance;
    const ext = safeExt(originalName, mime) || path.extname(originalName).toLowerCase();

    if (kind === 'photo') {
      const dataUrl = `data:${mime};base64,${bytes.toString('base64')}`;
      const messages = ocrPhotoPrompt();
      const userMsg = messages[1];
      if (Array.isArray(userMsg.content)) userMsg.content.push({ type: 'image_url', image_url: { url: dataUrl } });
      const { text } = await complete(ctx, messages, { vision: true });
      extractedMarkdown = text.trim();
      // One photographed page has no sub-position to point at, and recording that is not the
      // same as recording nothing: it is what tells the gaps route to cite the file name
      // rather than treat the source as unexamined.
      provenance = { kind: 'none', reason: 'photo' };
    } else if (kind === 'slides') {
      // One temp file serves both passes: the extractors take a path, not a buffer.
      const pptx = isPptx(mime, originalName);
      const extracted = await withTempFile(bytes, ext, async (filePath) => {
        const result = await extractFromUpload(filePath, mime, originalName);
        if (pptx) {
          // A failed figure pass must never take down an import whose text extracted
          // fine - the pictures are a bonus, the notes are the point.
          try {
            figures = await extractPptxImages(filePath);
          } catch (err) {
            console.error('[folio] slide figure extraction failed', err);
          }
        }
        return result;
      });
      // The extractor now reports the file's own page/slide breaks, so the deck is no longer
      // re-split out of its own text: a .pptx carries no `--- Page N ---` markers at all, and
      // the old split therefore handed the whole deck over as a single slide.
      // The unit follows what the student uploaded, not what the file format is called: a
      // deck exported to PDF is still slides to the person reading "slide 14 of 31".
      const pages = extracted.pages ?? [];
      provenance = pagesProvenance('slide', pages);
      await updateJob(jobId, { step: 'Improving with AI…' });
      const { text } = await complete(ctx, slidesRestructurePrompt(pages.length ? pages : [extracted.text]));
      extractedMarkdown = text.trim();
    } else {
      const extracted = await withTempFile(bytes, ext, async (filePath) => {
        return await extractFromUpload(filePath, mime, originalName);
      });
      // Timestamps first, since they are the more precise pointer, and pages only as the
      // fallback for a transcript that arrived as a PDF. A transcript with neither records
      // exactly that, so nothing downstream has to guess whether it was even looked at.
      // Scanned over the pages joined back together rather than over `text`, so this
      // extractor's own `--- Page N ---` markers cannot end up inside a timed segment.
      const pages = extracted.pages ?? [];
      provenance =
        timelineProvenance(pages.length ? pages.join('\n\n') : extracted.text) ??
        (pages.length ? pagesProvenance('page', pages) : { kind: 'none', reason: 'no-timestamps' });
      await updateJob(jobId, { step: 'Improving with AI…' });
      const { text } = await complete(ctx, transcriptNotesPrompt(extracted.text));
      extractedMarkdown = text.trim();
    }

    await updateJob(jobId, { step: 'Saving note…' });

    let resultNoteId: string;
    if (mode === 'new') {
      resultNoteId = await createNoteFromMarkdown(ctx, extractedMarkdown, notebookId!, originalName, uid);
    } else if (mode === 'append') {
      // Serialize per note so concurrent imports (or an import racing another append) can't
      // read-modify-write over each other.
      resultNoteId = await withNoteLock(noteId!, () => appendMarkdownToNote(noteId!, extractedMarkdown, uid));
    } else {
      resultNoteId = await withNoteLock(noteId!, () => mergeMarkdownIntoNote(ctx, noteId!, extractedMarkdown, uid));
    }

    // Figures go in after the note exists, so they can be filed against it - that note_id
    // is what lets a share-link guest load them. Same non-fatal treatment as extraction:
    // the note is already saved, and losing the gallery is not worth failing the import.
    if (figures.length) {
      try {
        await updateJob(jobId, { step: 'Saving figures…' });
        const stored = await storeFigures(figures, uid, resultNoteId);
        const section = figuresMarkdown(stored);
        if (section) await withNoteLock(resultNoteId, () => appendMarkdownToNote(resultNoteId, section, uid));
      } catch (err) {
        console.error('[folio] storing slide figures failed', err);
      }
    }

    await db.prepare('UPDATE attachments SET extracted_text = ?, provenance = ?, status = ?, note_id = ? WHERE id = ? AND user_id = ?').run(
      extractedMarkdown,
      serialiseProvenance(provenance),
      'ready',
      resultNoteId,
      attachmentId,
      uid,
    );
    await updateJob(jobId, { status: 'done', step: 'Done', noteId: resultNoteId });
  } catch (err) {
    // AiError's own message already lists which models were tried; other errors just
    // get their plain message (falling back to a generic one for non-Error throws).
    const message = err instanceof Error ? err.message : 'Import failed';
    await markAttachment(attachmentId, 'failed', uid);
    await updateJob(jobId, { status: 'failed', error: message });
  }
}

// POST /api/import - multipart: file, kind, notebookId?, noteId?, mode?
//
// The quota gate runs BEFORE multer deliberately. Every import kind ends in at least one
// model call, so a caller who is out of allowance is going to be refused either way - and
// checking first means we answer the 429 without first buffering their upload (up to
// MAX_SIZE) into this process's memory.
router.post('/', aiQuotaGate, handleUpload(upload.single('file')), async (req, res) => {
  const uid = userId(req);
  const file = req.file;
  const body = (req.body ?? {}) as { kind?: string; notebookId?: string; noteId?: string; mode?: string };
  const kind = body.kind as ImportKind | undefined;
  const mode = (body.mode as ImportMode | undefined) ?? 'new';
  const notebookId = body.notebookId?.trim() || undefined;
  const noteId = body.noteId?.trim() || undefined;

  // Nothing to unlink any more - a rejected upload is just a buffer that goes out of scope.
  const fail = (status: number, error: string) => {
    res.status(status).json({ error });
  };

  if (!file) return fail(400, 'file is required');
  if (!kind || !KINDS.includes(kind)) return fail(400, `kind must be one of: ${KINDS.join(', ')}`);
  if (!MODES.includes(mode)) return fail(400, `mode must be one of: ${MODES.join(', ')}`);
  if (!kindAccepts(kind, file.mimetype, file.originalname)) return fail(400, `file does not look like a ${kind} (got ${file.mimetype || 'unknown type'})`);
  if (mode === 'new' && !notebookId) return fail(400, 'notebookId is required for mode "new"');
  if ((mode === 'append' || mode === 'improve') && !noteId) return fail(400, `noteId is required for mode "${mode}"`);

  if (notebookId) {
    // Ownership: without `user_id = ?` an import could file a note into another user's notebook
    // (and the 400-vs-success difference would leak which notebook ids exist).
    const nb = await db.prepare('SELECT id FROM notebooks WHERE id = ? AND user_id = ?').get(notebookId, uid);
    if (!nb) return fail(400, 'unknown notebookId');
  }
  let targetNote: NoteRow | undefined;
  if (noteId) {
    // Same for the append/improve target: this is the check that stops a signed-in user from
    // pushing AI-generated text into a stranger's note by guessing its id.
    targetNote = await db
      .prepare('SELECT * FROM notes WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
      .get<NoteRow>(noteId, uid);
    if (!targetNote) return fail(400, 'unknown noteId');
  }

  // The payload goes into the row, not onto disk. attachments.bytes was always the
  // serverless plan in schema.sql; this is the write that finally uses it.
  const attachmentId = await insertAttachment({
    uid,
    noteId: targetNote?.id ?? null,
    kind,
    originalName: file.originalname,
    storedName: storedNameFor(file.originalname, file.mimetype),
    mime: file.mimetype,
    bytes: file.buffer,
  });

  const jobId = newId();
  await createJob(jobId, uid, { status: 'queued', attachmentId });

  // Read the context while the request is still alive - the job below runs after the
  // response has been sent, and `req` is not something to reach into from there.
  const ctx = aiCtx(req);

  res.json({ jobId });

  setImmediate(() => {
    processImport({
      jobId,
      attachmentId,
      bytes: file.buffer,
      mime: file.mimetype,
      originalName: file.originalname,
      kind,
      mode,
      uid,
      aiCtx: ctx,
      notebookId,
      noteId,
    }).catch(async err => {
      console.error('[folio] import job crashed', jobId, err);
      // Recording the failure is itself a DB write now, and it must not throw out of
      // a catch handler - a job stuck at "running" forever is worse than a lost log.
      await updateJob(jobId, {
        status: 'failed',
        error: err instanceof Error ? err.message : 'Import failed',
      }).catch(e => console.error('[folio] could not record job failure', jobId, e));
    });
  });
});

// GET /api/import/jobs/:id
router.get('/jobs/:id', async (req, res) => {
  const uid = userId(req);
  // Scoped to the caller: job ids are short, and an unscoped read would expose
  // another user's import progress and the note id it produced.
  const job = await getJob(String(req.params.id), userId(req));
  // Jobs live in memory and carry no user_id, so ownership is checked through the attachment
  // the job was created for - otherwise any signed-in user could poll a stranger's import and
  // read its resulting noteId and error text. Every job this router creates has an
  // attachmentId; one without is not answerable and is treated as not found.
  if (!job || !job.attachmentId) {
    res.status(404).json({ error: 'job not found' });
    return;
  }
  const owned = await db
    .prepare('SELECT id FROM attachments WHERE id = ? AND user_id = ?')
    .get<{ id: string }>(job.attachmentId, uid);
  if (!owned) {
    res.status(404).json({ error: 'job not found' });
    return;
  }

  // The title of the note this job produced, so a caller that only holds a capture-scoped
  // session (a QR-paired phone) can show "Note ready: <title>" without being granted read
  // access to notes. It previously fetched GET /api/notes/:id purely for this string,
  // which would have meant handing a scanned QR the ability to read note content.
  // Owner-scoped, and only once the job has actually produced a note.
  if (job.noteId) {
    const note = await db
      .prepare('SELECT title FROM notes WHERE id = ? AND user_id = ?')
      .get<{ title: string }>(job.noteId, uid);
    if (note) return res.json({ ...job, noteTitle: note.title });
  }
  res.json(job);
});

// POST /api/import/image - plain image upload for embedding in the editor.
//
// This now writes an attachments row, because the row IS the storage - the returned URL is
// only resolvable if the bytes are in the database. The row also carries the owner, which
// is what /uploads/:name scopes reads against. note_id stays null: the editor uploads
// before the image is placed, so the note it lands in is not known yet, and reads fall back
// to matching the URL inside note content.
router.post('/image', handleUpload(uploadImage.single('file')), async (req, res) => {
  const uid = userId(req);
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'file is required' });
  if (!file.mimetype.startsWith('image/')) {
    return res.status(400).json({ error: 'file must be an image' });
  }
  const storedName = storedNameFor(file.originalname, file.mimetype);
  await insertAttachment({
    uid,
    noteId: null,
    kind: 'image',
    originalName: file.originalname,
    storedName,
    mime: file.mimetype,
    bytes: file.buffer,
    status: 'ready',
  });
  res.json({ url: attachmentUrl(storedName) });
});

// POST /api/import/file - plain binary upload for non-image files embedded in the editor
// (e.g. 3D models: .glb/.gltf/.stl/.obj). Same storage model as /image (bytes live in the
// attachments row, served via /uploads/:name), but with no image-mimetype gate and kind='file'.
// Returns the attachmentId too, so the embedding node can reference the row directly.
router.post('/file', handleUpload(uploadImage.single('file')), async (req, res) => {
  const uid = userId(req);
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'file is required' });
  const storedName = storedNameFor(file.originalname, file.mimetype);
  const attachmentId = await insertAttachment({
    uid,
    noteId: null,
    kind: 'file',
    originalName: file.originalname,
    storedName,
    mime: file.mimetype || 'application/octet-stream',
    bytes: file.buffer,
    status: 'ready',
  });
  res.json({ url: attachmentUrl(storedName), attachmentId });
});


// --- Bulk "Import old notes" wizard --------------------------------------------------------
//
// Staging + client-orchestrated commit for the multi-file import wizard. Deliberately NOT
// behind aiQuotaGate (unlike POST / above): the default path uses no AI at all, so a student
// with no allowance - or one importing while the gateway is offline - can still bring their
// notes in. The categoriser runs client-side; these endpoints stage, persist its suggestions,
// record the user's review decisions, and commit into real notebooks. All logic lives in
// lib/importBatch.ts; these handlers are the thin HTTP surface. Auth is the /api/import mount.

// One docx/pptx or one downscaled photo per request (both < MAX_SIZE). Text docs arrive as
// JSON and never reach multer, which is a no-op on a non-multipart body.
const bulkUpload = multer({ storage, limits: { fileSize: MAX_SIZE } });
const DOC_EXT = new Set(['.docx', '.pptx']);
const IMG_MIME = /^image\//;

router.post('/batches', async (req, res) => {
  const uid = userId(req);
  const source = ((req.body ?? {}) as { source?: unknown }).source;
  const batchId = await bulk.createBatch(uid, source);
  res.status(201).json({ batchId });
});

router.get('/sources', (_req, res) => {
  res.json({ sources: bulk.sourcesRegistry() });
});

router.get('/label-space', async (req, res) => {
  res.json(await bulk.labelSpace(userId(req)));
});

router.get('/batches/:id', async (req, res) => {
  const result = await bulk.getBatch(userId(req), String(req.params.id));
  if (!result) return res.status(404).json({ error: 'import not found' });
  res.json(result);
});

router.delete('/batches/:id', async (req, res) => {
  const ok = await bulk.discardBatch(userId(req), String(req.params.id));
  if (!ok) return res.status(404).json({ error: 'import not found' });
  res.json({ ok: true });
});

// Add staged items. JSON body {items:[...]} for pre-extracted docs, OR multipart (field
// `file`) for a docx/pptx that needs server extraction or a photo whose bytes are stored.
router.post('/batches/:id/items', handleUpload(bulkUpload.single('file')), async (req, res) => {
  const uid = userId(req);
  const batchId = String(req.params.id);
  try {
    if (req.file) {
      const body = (req.body ?? {}) as { sourcePath?: string; title?: string; ocrText?: string; kind?: string; capturedAt?: string };
      const file = { buffer: req.file.buffer, mimetype: req.file.mimetype, originalname: req.file.originalname };
      const ext = path.extname(file.originalname).toLowerCase();
      const isPhoto = body.kind === 'photo' || (IMG_MIME.test(file.mimetype) && !DOC_EXT.has(ext));
      const item = isPhoto
        ? await bulk.stagePhoto(uid, batchId, file, { sourcePath: body.sourcePath ?? null, title: body.title ?? null, ocrText: body.ocrText ?? null, capturedAt: body.capturedAt ?? null })
        : await bulk.stageUploadedFile(uid, batchId, file, { sourcePath: body.sourcePath ?? null, title: body.title ?? null });
      if (!item) return res.status(404).json({ error: 'import not found' });
      return res.status(201).json({ item });
    }
    const items = Array.isArray((req.body ?? {}).items) ? ((req.body as { items: bulk.RawStageItem[] }).items) : null;
    if (!items) return res.status(400).json({ error: 'an items array or a file is required' });
    const owned = await bulk.getBatch(uid, batchId);
    if (!owned) return res.status(404).json({ error: 'import not found' });
    const staged = await bulk.stageJsonItems(uid, batchId, items);
    return res.status(201).json({ items: staged });
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : 'could not stage items' });
  }
});

router.post('/batches/:id/categorise', async (req, res) => {
  const uid = userId(req);
  const body = (req.body ?? {}) as { categoriser?: unknown; suggestions?: unknown };
  const suggestions = Array.isArray(body.suggestions) ? (body.suggestions as bulk.RawSuggestion[]) : [];
  const result = await bulk.saveSuggestions(uid, String(req.params.id), body.categoriser, suggestions);
  if (!result) return res.status(404).json({ error: 'import not found' });
  res.json(result);
});

router.patch('/batches/:id/items/:itemId', async (req, res) => {
  const uid = userId(req);
  try {
    const item = await bulk.decideItem(uid, String(req.params.id), String(req.params.itemId), (req.body ?? {}) as bulk.DecisionPatch);
    if (!item) return res.status(404).json({ error: 'item not found' });
    return res.json({ item });
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : 'could not update item' });
  }
});

// --- grouping: which staged photos are pages of the same note --------------------------------

/** Format a capture timestamp the way the grouping prompt wants it: a weekday and a clock time,
 *  which is all the model needs to see "these two are a minute apart, that one is the next day". */
function takenLabel(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toUTCString().slice(0, 3) + ' ' + d.toISOString().slice(5, 16).replace('T', ' ');
}

/**
 * Save a grouping the client worked out for itself (capture-time clustering, or the user's own
 * edits in the review screen). No AI, no quota, always available.
 */
router.put('/batches/:id/groups', async (req, res) => {
  const uid = userId(req);
  const body = (req.body ?? {}) as { groups?: unknown; grouper?: unknown };
  const groups = Array.isArray(body.groups) ? (body.groups as bulk.RawGroup[]) : [];
  const result = await bulk.setGroups(uid, String(req.params.id), groups, body.grouper ?? 'capture-time');
  if (!result) return res.status(404).json({ error: 'import not found' });
  res.json(result);
});

/**
 * Regroup with AI - ONE model call for the whole batch, over OCR text only.
 *
 * Cost is why this is shaped the way it is: per-photo vision OCR runs ~2 calls each, so twenty
 * photos would be 40 of a user's 100 monthly shared-pool calls. Sorting already-extracted text
 * is one call regardless of batch size, and no image leaves the browser on this path.
 *
 * Nothing is destroyed if the model misbehaves: any id it fails to mention simply stays
 * ungrouped, which means "its own note" - the same outcome as not having asked.
 */
router.post('/batches/:id/group-ai', aiQuotaGate, async (req, res) => {
  const uid = userId(req);
  const batchId = String(req.params.id);
  const owned = await bulk.getBatch(uid, batchId);
  if (!owned) return res.status(404).json({ error: 'import not found' });

  const pending = owned.items.filter((i) => i.status !== 'committed' && i.status !== 'rejected');
  if (pending.length < 2) {
    return res.status(400).json({ error: 'AI grouping needs at least two photos to sort' });
  }

  const manifest: PhotoForGrouping[] = pending.map((i) => ({
    id: i.id,
    name: i.originalName,
    takenAt: takenLabel(i.capturedAt),
    textHead: i.preview,
  }));

  try {
    const { text } = await complete(aiCtx(req), groupPhotosPrompt(manifest), {
      json: true,
      maxTokens: 2000,
      temperature: 0.2,
    });
    const parsed = extractJson<{ groups?: Array<{ title?: unknown; reason?: unknown; itemIds?: unknown }> }>(text);

    // Trust nothing about the shape: keep only ids that are really in this batch, drop repeats,
    // and give anything the model forgot a group of its own so no photo is silently lost.
    const known = new Set(pending.map((i) => i.id));
    const used = new Set<string>();
    const groups: bulk.RawGroup[] = [];
    for (const g of Array.isArray(parsed.groups) ? parsed.groups : []) {
      const ids = (Array.isArray(g.itemIds) ? g.itemIds.map((x) => String(x)) : []).filter((id) => {
        if (!known.has(id) || used.has(id)) return false;
        used.add(id);
        return true;
      });
      if (!ids.length) continue;
      groups.push({ key: newId(), itemIds: ids, title: g.title, rationale: g.reason });
    }
    for (const item of pending) {
      if (used.has(item.id)) continue;
      groups.push({ key: newId(), itemIds: [item.id], title: item.title, rationale: 'not grouped by AI' });
    }

    const result = await bulk.setGroups(uid, batchId, groups, 'ai');
    if (!result) return res.status(404).json({ error: 'import not found' });
    return res.json(result);
  } catch (err) {
    if (err instanceof AiError) {
      return res.status(503).json({ error: 'AI grouping is unavailable right now. Your photos are still here - group them by time instead.' });
    }
    return res.status(400).json({ error: err instanceof Error ? err.message : 'could not group these photos' });
  }
});

router.post('/batches/:id/commit', async (req, res) => {
  const uid = userId(req);
  const body = (req.body ?? {}) as { itemIds?: unknown };
  const itemIds = Array.isArray(body.itemIds) ? body.itemIds.map((x) => String(x)) : [];
  if (!itemIds.length) return res.status(400).json({ error: 'itemIds is required' });
  const result = await bulk.commitBatch(uid, String(req.params.id), itemIds);
  if (!result) return res.status(404).json({ error: 'import not found' });
  res.json(result);
});


export default router;
