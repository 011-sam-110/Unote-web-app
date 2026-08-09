// Expanding a dropped .zip into the Files the rest of the import pipeline already handles.
//
// This exists so a Unote export goes straight back in. The export is a zip of Markdown in
// one folder per notebook, and the import wizard reads folder structure as the notebook
// signal - but only from a folder PICKED in the file dialog, which meant the round trip
// asked the user to unzip first and hope their unzipper kept the folders.
//
// Each entry becomes a File whose `name` is the full path inside the archive. That is
// deliberate: `webkitRelativePath` is read-only and cannot be forged, and connectors/
// registry.ts falls back to `file.name` for the source path, so a name of
// "Databases/indexing.md" lands in the pipeline identically to a real picked folder.
import { unzipSync } from 'fflate';

/** A malicious or merely enormous archive should not be able to fill a tab's memory. */
const MAX_ENTRIES = 3_000;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  text: 'text/plain',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};

export function isZip(file: File): boolean {
  return /\.zip$/i.test(file.name) || file.type === 'application/zip' || file.type === 'application/x-zip-compressed';
}

function mimeFor(path: string): string {
  const ext = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/** Junk the OS and the archiver add, which would otherwise import as empty notes. */
function isNoise(path: string): boolean {
  return (
    path.endsWith('/') ||
    path.startsWith('__MACOSX/') ||
    path.split('/').some((seg) => seg === '.DS_Store' || seg === 'Thumbs.db' || seg.startsWith('._'))
  );
}

export interface ZipExpansion {
  files: File[];
  /** Entries dropped for being noise, or for not being wanted by this source. */
  ignored: number;
  /** Entries dropped because the archive ran past the bounds above. Counted separately
   *  because it is the one the user needs telling about: it means their import is
   *  INCOMPLETE, and silently returning a partial vault would look like a successful one. */
  truncated: number;
}

/** Which entries this source can use, if it knows. Applied BEFORE the size and count caps,
 *  so an Obsidian vault's `attachments/` folder cannot eat the budget its notes needed -
 *  entries are read in archive order, and a filter that ran afterwards would be filtering
 *  a list the images had already truncated. */
export type KeepEntry = (path: string) => boolean;

/**
 * Read one archive fully in memory.
 *
 * unzipSync rather than fflate's worker-backed async API: the bounds above keep this to
 * tens of megabytes of text, and the sync call has no worker spawn, no CSP surface and no
 * partial-failure states to reason about.
 */
export async function expandZip(file: File, keep?: KeepEntry): Promise<ZipExpansion> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new Error(`${file.name} could not be opened as a .zip.`);
  }

  const files: File[] = [];
  let ignored = 0;
  let truncated = 0;
  let total = 0;

  for (const [path, data] of Object.entries(entries)) {
    if (isNoise(path) || data.length === 0 || (keep && !keep(path))) {
      ignored++;
      continue;
    }
    if (files.length >= MAX_ENTRIES || total + data.length > MAX_TOTAL_BYTES) {
      truncated++;
      continue;
    }
    total += data.length;
    files.push(new File([data as BlobPart], path, { type: mimeFor(path) }));
  }

  return { files, ignored, truncated };
}

/** Replace every archive in a selection with its contents, leaving loose files alone. */
export async function expandArchives(input: File[], keep?: KeepEntry): Promise<ZipExpansion> {
  const out: File[] = [];
  let ignored = 0;
  let truncated = 0;
  for (const file of input) {
    if (!isZip(file)) {
      out.push(file);
      continue;
    }
    const expanded = await expandZip(file, keep);
    out.push(...expanded.files);
    ignored += expanded.ignored;
    truncated += expanded.truncated;
  }
  return { files: out, ignored, truncated };
}
