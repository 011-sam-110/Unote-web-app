// Obsidian vault -> RawDocs.
//
// A vault is already a folder of markdown, so most of the work is deciding what NOT to
// import. A real vault contains a `.obsidian/` directory of JSON config, a `.trash/` of
// deleted notes, plugin caches, and Excalidraw drawings stored as megabytes of JSON inside
// a `.md` file. Import those and the user's first impression of Unote is forty notes
// called "appearance.json" - so this filters hard and says how many it dropped.
//
// What survives keeps its structure: folders become notebooks, `[[wikilinks]]` pass
// through untouched (Unote has wikilinks of its own, so they resolve on the other side),
// and frontmatter tags are read downstream by extract.ts's parseSourceTags.
import type { RawDoc } from '../types';
import { extensionOf, splitSegments, stripSharedRoot, titleFromPath, joinSegments } from '../paths';

const NOTE_EXT = new Set(['md', 'markdown', 'txt']);

/** Vault plumbing, not notes. Matched on any segment, since a picked folder and a zipped
 *  one nest them at different depths. */
export function isVaultInternal(segments: string[]): boolean {
  return segments.some(
    (seg) =>
      seg === '.obsidian' ||
      seg === '.trash' ||
      seg === '.git' ||
      seg === '.smart-env' ||
      seg === '.makemd' ||
      seg === '.space',
  );
}

/** Drawings and canvases: `.md` by extension, but a JSON blob by content. */
export function isDrawing(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.excalidraw.md') || lower.endsWith('.excalidraw') || lower.endsWith('.canvas');
}

export function keepVaultFile(path: string): boolean {
  const segments = splitSegments(path);
  const name = segments[segments.length - 1] ?? '';
  if (!name || name.startsWith('.')) return false;
  if (isVaultInternal(segments)) return false;
  if (isDrawing(name)) return false;
  return NOTE_EXT.has(extensionOf(name));
}

export function ingestVault(files: File[]): RawDoc[] {
  const kept = files.filter((f) => keepVaultFile(f.webkitRelativePath || f.name));
  // Stripped across the whole batch, so the vault's own folder stops presenting itself as
  // a notebook when there are subject folders inside it to use instead.
  const paths = stripSharedRoot(kept.map((f) => splitSegments(f.webkitRelativePath || f.name)));

  return kept.map((file, i) => {
    const segments = paths[i];
    return {
      file,
      sourcePath: joinSegments(segments),
      folderPath: segments.slice(0, -1),
      // In Obsidian the filename IS the note title - there is no separate title field, and
      // a `# Heading` inside the file is often absent or a duplicate of it.
      title: titleFromPath(segments),
      updatedAt: new Date(file.lastModified).toISOString(),
    };
  });
}
