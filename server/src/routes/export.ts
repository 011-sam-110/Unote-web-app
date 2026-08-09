import { Router } from 'express';
import { zipSync, strToU8 } from 'fflate';
import { db } from '../db.js';
import { userId } from '../auth/middleware.js';
import { tiptapToMarkdown, type TTNode } from '../lib/export.js';

const router = Router();

// Auth is mounted once, in app.ts (`app.use('/api/export', requireAuth, ...)`), so this
// router does not add its own guard. Every statement below still filters on
// `userId(req)` - an export is the single request that would leak an entire account.

/**
 * Bounds on one export.
 *
 * A Vercel function has 60 seconds and a fixed memory ceiling, and this route builds the
 * whole archive in memory before it can send a byte. Both limits are deliberately visible
 * rather than silent: GET /api/export/summary reports them alongside the account's real
 * counts, so the UI can say "this will include 1,340 of your 1,340 notes" (or say what it
 * will leave out) BEFORE anyone clicks download.
 *
 * MAX_BYTES is measured over rendered Markdown, which is the thing that actually has to
 * fit; the zip that comes out is several times smaller since it is all text.
 */
export const MAX_NOTES = 2_000;
export const MAX_BYTES = 25 * 1024 * 1024;

interface ExportRow {
  id: string;
  title: string;
  kind: string;
  content_json: string;
  created_at: string;
  updated_at: string;
  notebook_name: string;
  notebook_position: number;
}

/** Newest notebooks last, newest notes first, so a truncated export keeps recent work. */
const ROWS_SQL = `
  SELECT n.id, n.title, n.kind, n.content_json, n.created_at, n.updated_at,
         nb.name AS notebook_name, nb.position AS notebook_position
  FROM notes n
  JOIN notebooks nb ON nb.id = n.notebook_id AND nb.deleted_at IS NULL
  WHERE n.user_id = ? AND n.deleted_at IS NULL
  ORDER BY nb.position ASC, n.updated_at DESC
`;

/** Anything a filesystem or a zip reader would object to, path separators included. */
export function safeName(raw: string, fallback: string): string {
  const cleaned = raw
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

/**
 * The header block on every exported note.
 *
 * Written in the exact shape the import wizard's `parseSourceTags` reads (a `title:` line
 * and an inline `tags: [...]` list), so an exported archive comes back in with its titles
 * and tags intact instead of arriving as a pile of untitled files.
 */
export function frontmatter(note: { title: string; updatedAt: string; tags: string[] }, notebookName: string): string {
  const lines = ['---', `title: ${note.title || 'Untitled'}`, `notebook: ${notebookName}`];
  if (note.tags.length) lines.push(`tags: [${note.tags.join(', ')}]`);
  lines.push(`updated: ${note.updatedAt}`, '---', '');
  return lines.join('\n');
}

/**
 * A board rendered as Markdown.
 *
 * A canvas keeps its content in canvas_items, not content_json, so `tiptapToMarkdown`
 * would return an empty file for one. Its text is worth exporting even though its layout
 * is not, and the file says which half it is giving you rather than looking like a note
 * that lost most of itself.
 */
export function canvasMarkdown(items: Array<{ kind: string; data: string }>): string {
  const texts: string[] = [];
  for (const item of items) {
    let parsed: { text?: unknown; title?: unknown };
    try {
      parsed = JSON.parse(item.data) as { text?: unknown; title?: unknown };
    } catch {
      continue;
    }
    const value = typeof parsed.text === 'string' ? parsed.text : typeof parsed.title === 'string' ? parsed.title : '';
    if (value.trim()) texts.push(value.trim());
  }
  const head = 'This note is a board. Its text is below; the positions, arrows and drawings are not part of a Markdown export.\n';
  if (!texts.length) return `${head}\n(The board has no text on it.)\n`;
  return `${head}\n${texts.map(t => `- ${t.replace(/\n+/g, ' ')}`).join('\n')}\n`;
}

async function loadRows(uid: string): Promise<ExportRow[]> {
  return db.prepare(ROWS_SQL).all<ExportRow>(uid);
}

/** Tags per note, owner-scoped through `notes` since note_tags carries no user_id. */
async function loadTags(uid: string): Promise<Map<string, string[]>> {
  const rows = await db
    .prepare('SELECT t.note_id, t.tag FROM note_tags t JOIN notes n ON n.id = t.note_id WHERE n.user_id = ?')
    .all<{ note_id: string; tag: string }>(uid);
  const map = new Map<string, string[]>();
  for (const r of rows) map.set(r.note_id, [...(map.get(r.note_id) ?? []), r.tag]);
  return map;
}

/** Board items for the caller's own boards only - the join through `notes` is the check. */
async function loadCanvasItems(uid: string): Promise<Map<string, Array<{ kind: string; data: string }>>> {
  const rows = await db
    .prepare(
      `SELECT c.note_id, c.kind, c.data FROM canvas_items c
       JOIN notes n ON n.id = c.note_id
       WHERE n.user_id = ? AND n.kind = 'canvas' AND n.deleted_at IS NULL
       ORDER BY c.z ASC`,
    )
    .all<{ note_id: string; kind: string; data: string }>(uid);
  const map = new Map<string, Array<{ kind: string; data: string }>>();
  for (const r of rows) map.set(r.note_id, [...(map.get(r.note_id) ?? []), { kind: r.kind, data: r.data }]);
  return map;
}

// GET /api/export/summary - what an export would contain, and what it would leave out.
router.get('/summary', async (req, res) => {
  const uid = userId(req);
  const counts = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM notes WHERE user_id = ? AND deleted_at IS NULL) AS notes,
         (SELECT COUNT(*) FROM notebooks WHERE user_id = ? AND deleted_at IS NULL) AS notebooks`,
    )
    .get<{ notes: number | string; notebooks: number | string }>(uid, uid);
  const notes = Number(counts?.notes ?? 0);
  res.json({
    notes,
    notebooks: Number(counts?.notebooks ?? 0),
    maxNotes: MAX_NOTES,
    included: Math.min(notes, MAX_NOTES),
    truncated: notes > MAX_NOTES,
  });
});

// GET /api/export/all - every note the caller owns, as a zip of Markdown by notebook.
router.get('/all', async (req, res) => {
  const uid = userId(req);
  const format = typeof req.query.format === 'string' ? req.query.format : 'markdown';
  if (format !== 'markdown') {
    res.status(400).json({ error: 'unsupported export format' });
    return;
  }

  const [rows, tagsByNote, canvasByNote] = await Promise.all([loadRows(uid), loadTags(uid), loadCanvasItems(uid)]);

  const files: Record<string, Uint8Array> = {};
  const used = new Set<string>();
  let bytes = 0;
  let written = 0;
  let omitted = 0;

  for (const row of rows) {
    if (written >= MAX_NOTES || bytes >= MAX_BYTES) {
      omitted = rows.length - written;
      break;
    }
    const notebookName = row.notebook_name || 'Notes';
    const body =
      row.kind === 'canvas'
        ? canvasMarkdown(canvasByNote.get(row.id) ?? [])
        : tiptapToMarkdown(JSON.parse(row.content_json) as TTNode);
    const markdown =
      frontmatter({ title: row.title, updatedAt: row.updated_at, tags: tagsByNote.get(row.id) ?? [] }, notebookName) + body;

    const folder = safeName(notebookName, 'Notes');
    const base = safeName(row.title, 'untitled');
    let path = `${folder}/${base}.md`;
    // Two notes may share a title; one zip entry may not share a path.
    for (let n = 2; used.has(path.toLowerCase()); n++) path = `${folder}/${base}-${n}.md`;
    used.add(path.toLowerCase());

    const encoded = strToU8(markdown);
    files[path] = encoded;
    bytes += encoded.length;
    written++;
  }

  const readme = [
    '# Your Unote export',
    '',
    `Exported ${new Date().toISOString()}.`,
    '',
    `${written} note${written === 1 ? '' : 's'}, one folder per notebook, one Markdown file per note.`,
    'The block at the top of each file keeps its title and tags.',
    '',
    omitted > 0
      ? `NOT EVERYTHING IS HERE. ${omitted} note${omitted === 1 ? ' was' : 's were'} left out: one export is capped at ` +
        `${MAX_NOTES} notes and ${Math.round(MAX_BYTES / (1024 * 1024))}MB of text so it finishes inside the time the ` +
        'server is allowed. The oldest notes are the ones missing.'
      : 'Everything in your account is here.',
    '',
    'Attachments, drawings, flashcards and note history are not part of a Markdown export.',
    '',
    'To bring these back in: Import in the sidebar, and choose this .zip.',
    '',
  ].join('\n');
  files['README.md'] = strToU8(readme);

  // zipSync rather than fflate's async API: the async one spawns a worker thread per call,
  // which is the wrong trade on a serverless instance sized for one request. The bounds
  // above are what keep the synchronous pass short.
  const archive = zipSync(files, { level: 6 });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="unote-notes-${new Date().toISOString().slice(0, 10)}.zip"`);
  // Read by the UI so a capped export can say so after the fact as well as before it.
  res.setHeader('X-Unote-Export-Notes', String(written));
  res.setHeader('X-Unote-Export-Omitted', String(omitted));
  res.send(Buffer.from(archive));
});

export default router;
