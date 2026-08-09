// Bringing Markdown into the browser-local store.
//
// The account import wizard stages every file in Postgres before anything is filed, which
// a guest has no session to reach. This is the same idea with the server taken out: read
// the text in the browser, read folder names as notebooks, and write straight into the
// local store. It reuses the wizard's own frontmatter/hashtag parser and its zip expander
// rather than growing a second dialect of either.
//
// Writing through localApi rather than the store directly is what gets these notes an
// outbox entry each, so a folder of Markdown imported offline reaches the account on the
// next sync instead of staying on this one device.
import { markdownToDoc } from '../ask/mdToTiptap';
import { parseSourceTags } from '../import/connectors/extract';
import { expandArchives } from '../import/zipEntries';
import { localApi } from '../../lib/local/localApi';

const TEXT_EXT = /\.(md|markdown|mdx|txt|text)$/i;

export interface GuestImportResult {
  notes: number;
  notebooks: number;
  skipped: number;
}

/** Notebook name from the archive/folder path: "Databases/indexing.md" -> "Databases". */
function notebookNameFor(path: string): string | null {
  const segments = path.split(/[\\/]+/).filter(Boolean);
  segments.pop(); // the file itself
  return segments.length ? segments[segments.length - 1] : null;
}

interface DocNode {
  type?: string;
  text?: string;
  content?: DocNode[];
}

/** Plain text for search and snippets, taken from the converted doc so it matches what
 *  the editor would produce rather than being the raw markdown with its syntax in it. */
function docToPlainText(node: DocNode): string {
  if (node.text) return node.text;
  if (!node.content) return '';
  const joiner = node.type === 'doc' || node.type === 'paragraph' || node.type === 'heading' ? '\n' : ' ';
  return node.content.map(docToPlainText).join(joiner);
}

function titleFrom(path: string, frontmatterTitle: string | undefined, markdown: string): string {
  if (frontmatterTitle?.trim()) return frontmatterTitle.trim();
  const heading = markdown.match(/^#{1,6}\s+(.+)$/m);
  if (heading) return heading[1].trim().slice(0, 200);
  const base = path.split(/[\\/]+/).pop() ?? 'Imported note';
  return base.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'Imported note';
}

export async function importIntoGuestStore(input: File[] | FileList): Promise<GuestImportResult> {
  const { files, ignored, truncated } = await expandArchives(Array.from(input));
  const skippedInArchive = ignored + truncated;
  const usable = files.filter((f) => TEXT_EXT.test(f.name));
  let skipped = skippedInArchive + (files.length - usable.length);
  if (usable.length === 0) {
    throw new Error('No .md or .txt files in there. A Unote export .zip or a folder of Markdown both work.');
  }

  // Existing notebooks are reused by name so importing twice does not double them up.
  const existingNotebooks = (await localApi.notebooks()).notebooks;
  const byName = new Map(existingNotebooks.map((nb) => [nb.name.trim().toLowerCase(), nb.id]));
  let notebooksCreated = 0;
  let notes = 0;

  const fallbackId = async () => {
    const existing = existingNotebooks[0];
    if (existing) return existing.id;
    const { notebook } = await localApi.createNotebook({ name: 'Imported', emoji: '📥' });
    notebooksCreated++;
    byName.set('imported', notebook.id);
    existingNotebooks.push(notebook);
    return notebook.id;
  };

  for (const file of usable) {
    let raw: string;
    try {
      raw = await file.text();
    } catch {
      skipped++;
      continue;
    }
    const { tags, title, body } = parseSourceTags(raw);
    // README.md is the export's own cover note, not one of the user's notes.
    if (/(^|\/)readme\.md$/i.test(file.name)) {
      skipped++;
      continue;
    }

    const folder = notebookNameFor(file.name);
    let notebookId: string;
    if (folder) {
      const key = folder.trim().toLowerCase();
      const found = byName.get(key);
      if (found) {
        notebookId = found;
      } else {
        const { notebook } = await localApi.createNotebook({ name: folder.trim() });
        byName.set(key, notebook.id);
        notebooksCreated++;
        notebookId = notebook.id;
      }
    } else {
      notebookId = await fallbackId();
    }

    const doc = markdownToDoc(body) as unknown as DocNode;
    await localApi.createNote({
      notebookId,
      title: titleFrom(file.name, title, body),
      contentJson: doc as unknown as Record<string, unknown>,
      contentText: docToPlainText(doc).trim(),
      tags,
    });
    notes++;
  }

  return { notes, notebooks: notebooksCreated, skipped };
}
