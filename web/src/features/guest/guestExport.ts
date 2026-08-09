// Getting guest work out of the browser, as the same zip-of-Markdown an account exports.
//
// A guest with unsaved notes is exactly who needs an export button, so this is not a
// reduced version of the account export: same folder-per-notebook layout, same YAML
// frontmatter, same README. That matters beyond tidiness - the import wizard's markdown
// connector reads folders as notebooks and frontmatter as title/tags, so a zip built here
// goes back in without anything being retyped.
//
// tiptapToMarkdown is imported from the server rather than reimplemented. It is a pure
// function over TipTap JSON with no Node dependencies, and a second copy would drift from
// the one that writes the account export - which is the copy the round trip is tested
// against.
//
// The store this reads is lib/local (Dexie), not the localStorage blob it was written
// against - hence the async entry points. `GuestData` survives only as the shape
// localSnapshot() hands back: one value holding the whole store, which is what a zip
// builder wants and what a table-per-entity API does not give.
import { zipSync, strToU8 } from 'fflate';
import { tiptapToMarkdown, type TTNode } from '../../../../server/src/lib/export';
import { localSnapshot } from '../../lib/local/localApi';
import type { GuestData, GuestNote } from './guestStore';

/** Everything a filesystem or a zip reader could object to, plus path separators. */
function safeName(raw: string, fallback: string): string {
  const cleaned = raw
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

/** YAML the import wizard's parseSourceTags can read back: title and tags survive a round
 *  trip, which is what stops a re-import turning every note into "untitled, no tags". */
function frontmatter(note: GuestNote, notebookName: string): string {
  const lines = ['---', `title: ${note.title || 'Untitled'}`, `notebook: ${notebookName}`];
  if (note.tags.length) lines.push(`tags: [${note.tags.join(', ')}]`);
  lines.push(`updated: ${note.updatedAt}`, '---', '');
  return lines.join('\n');
}

export interface GuestExportSummary {
  notes: number;
  notebooks: number;
}

export async function guestExportSummary(): Promise<GuestExportSummary> {
  const data = await localSnapshot();
  return { notes: data.notes.length, notebooks: data.notebooks.length };
}

/** One note as the Markdown file it would occupy in the zip. */
export function guestNoteMarkdown(note: GuestNote, notebookName: string): string {
  const body = tiptapToMarkdown(note.contentJson as unknown as TTNode);
  return `${frontmatter(note, notebookName)}${body}`;
}

export function buildGuestZip(data: GuestData): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const used = new Set<string>();
  const notebookNames = new Map(data.notebooks.map((nb) => [nb.id, nb.name]));

  for (const note of data.notes) {
    const notebookName = notebookNames.get(note.notebookId) ?? 'Notes';
    const folder = safeName(notebookName, 'Notes');
    const base = safeName(note.title, 'untitled');
    let path = `${folder}/${base}.md`;
    // Two notes can share a title, and a zip entry cannot share a path.
    for (let n = 2; used.has(path.toLowerCase()); n++) path = `${folder}/${base}-${n}.md`;
    used.add(path.toLowerCase());
    files[path] = strToU8(guestNoteMarkdown(note, notebookName));
  }

  files['README.md'] = strToU8(
    [
      '# Your Unote export',
      '',
      `Exported ${new Date().toLocaleString()} from a browser session with no account, so this file is the`,
      'only copy of these notes that exists.',
      '',
      'One folder per notebook, one Markdown file per note. The block at the top of each file keeps the',
      'title and tags.',
      '',
      'To bring them back in: make an account, then use Import in the sidebar and choose this .zip.',
      '',
    ].join('\n'),
  );

  // zipSync rather than the async worker API. This was safe when the store was capped by
  // the localStorage quota; on IndexedDB it is a judgement call, kept because the content
  // is still plain text only - every path that produces a large attachment needs a server.
  return zipSync(files, { level: 6 });
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next tick: revoking synchronously can cancel the download in some
  // browsers before it has read the blob.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function stamp(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function downloadGuestExport(): Promise<void> {
  const data = await localSnapshot();
  if (data.notes.length === 0) throw new Error('There is nothing to export yet.');
  const bytes = buildGuestZip(data);
  triggerDownload(new Blob([bytes as BlobPart], { type: 'application/zip' }), `unote-notes-${stamp()}.zip`);
}

/** The single-note export, so the note page's Export control works for a guest too. */
export async function downloadGuestNote(noteId: string): Promise<void> {
  const data = await localSnapshot();
  const note = data.notes.find((n) => n.id === noteId);
  if (!note) throw new Error('That note is not on this device any more.');
  const notebookName = data.notebooks.find((nb) => nb.id === note.notebookId)?.name ?? 'Notes';
  const markdown = guestNoteMarkdown(note, notebookName);
  triggerDownload(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }), `${safeName(note.title, 'untitled')}.md`);
}
