// Notion "Markdown & CSV" export -> RawDocs.
//
// Two things make a Notion export unusable as-is. Every file and folder carries a 32-hex
// page id ("Lecture 4 a1b2c3d4e5f67890a1b2c3d4e5f67890.md"), which becomes the note title
// and the notebook name unless it is stripped; and every database is exported TWICE - once
// as a `.csv` of all its rows, and once as a folder holding one markdown file per row. Both
// are handled here rather than downstream, because a wizard that shows the user 200 items
// where they have 100 pages has already lost their trust.
import type { RawDoc } from '../types';
import {
  decodeSegment,
  extensionOf,
  joinSegments,
  splitSegments,
  stripExportId,
  stripLeadingSegments,
  stripSharedRoot,
  titleFromPath,
} from '../paths';

const PAGE_EXT = new Set(['md', 'markdown', 'txt', 'html']);

/** The folder Notion wraps an export in - "Export-<uuid>", or the older "Private & Shared".
 *  Recognised by name so it can be removed even when it is the only shared level. */
export function isExportWrapper(segment: string): boolean {
  return /^Export-[0-9a-f-]+$/i.test(segment) || /^(Private|Private & Shared|Workspace)$/i.test(segment);
}

export function keepNotionFile(path: string): boolean {
  const name = splitSegments(path).pop() ?? '';
  if (!name || name.startsWith('.')) return false;
  const ext = extensionOf(name);
  // The database CSV duplicates the per-row markdown pages sitting next to it. Importing
  // both means every database row arrives twice - once as a note, once as a line in a
  // comma-separated wall of text.
  if (ext === 'csv') return false;
  return PAGE_EXT.has(ext);
}

/**
 * Notion writes a page's properties as `Key: value` lines directly under the `# Title`,
 * with no frontmatter fence, so parseSourceTags cannot see them. Pulling the multi-select
 * ones out here is what makes an import land with the tags the user already curated.
 *
 * Only the block at the very top is considered - a "Status: done" line halfway down a page
 * is prose, not a property.
 */
export function notionProperties(markdown: string): { tags: string[]; body: string } {
  const lines = markdown.split(/\r?\n/);
  let i = 0;
  // Skip the H1 Notion repeats from the filename, and any blank lines after it.
  if (lines[i]?.startsWith('# ')) i++;
  while (lines[i] !== undefined && lines[i].trim() === '') i++;

  const tags: string[] = [];
  const propertyStart = i;
  while (lines[i] !== undefined) {
    const match = lines[i].match(/^([A-Za-z][A-Za-z0-9 _/-]{0,40}):\s*(.*)$/);
    if (!match) break;
    const [, key, value] = match;
    if (/^(tags?|categor(y|ies)|topics?|labels?|subjects?)$/i.test(key)) {
      for (const part of value.split(',')) {
        const tag = part.trim();
        if (tag) tags.push(tag);
      }
    }
    i++;
  }
  // Nothing matched: leave the document exactly as it was rather than guessing.
  if (i === propertyStart) return { tags, body: markdown };
  while (lines[i] !== undefined && lines[i].trim() === '') i++;
  return { tags, body: lines.slice(i).join('\n') };
}

export function ingestNotion(files: File[]): RawDoc[] {
  const kept = files.filter((f) => keepNotionFile(f.webkitRelativePath || f.name));
  const cleaned = kept.map((f) =>
    stripLeadingSegments(
      splitSegments(f.webkitRelativePath || f.name).map((seg) => stripExportId(decodeSegment(seg))),
      isExportWrapper,
    ),
  );
  const paths = stripSharedRoot(cleaned);

  return kept.map((file, i) => {
    const segments = paths[i];
    return {
      file,
      sourcePath: joinSegments(segments),
      folderPath: segments.slice(0, -1),
      title: titleFromPath(segments),
      updatedAt: new Date(file.lastModified).toISOString(),
      transformText: (text) => {
        const { tags, body } = notionProperties(text);
        return { text: body, tags };
      },
    };
  });
}
