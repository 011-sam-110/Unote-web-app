// Path and filename normalisation shared by the export-file connectors.
//
// Every one of these sources hands us paths that are not the paths the user recognises:
// Notion staples a 32-character page id onto every name, Google Takeout buries everything
// two directories deep, and a picked Obsidian vault carries its own folder name at the
// front of all of it. The pipeline downstream reads folder structure as the notebook
// signal (see pipeline.ts, which re-derives it from `sourcePath`), so a path cleaned here
// is the difference between notebooks called "Databases" and notebooks called
// "Export-1f2a…" - and between a note titled "Indexing" and one titled
// "Indexing a1b2c3d4e5f67890a1b2c3d4e5f67890".

export function splitSegments(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean);
}

export function joinSegments(segments: string[]): string {
  return segments.join('/');
}

export function extensionOf(name: string): string {
  return name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
}

export function stripExtension(name: string): string {
  return name.replace(/\.[A-Za-z0-9]+$/, '');
}

/** Percent-decoding that never throws. A malformed `%` sequence is data, not a crash. */
export function decodeSegment(segment: string): string {
  if (!segment.includes('%')) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

const NOTION_HEX_ID = /[ _-][0-9a-f]{32}$/i;
const NOTION_UUID = /[ _-][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Drop the page id Notion appends to every file and folder name.
 *
 * Anchored to the END and required to be preceded by a separator, so a legitimate name
 * that merely contains hex ("Note on deadbeef") keeps it. Both shapes are handled: older
 * exports use a bare 32-hex id, newer ones a dashed UUID.
 */
export function stripExportId(segment: string): string {
  const ext = segment.match(/\.[A-Za-z0-9]+$/)?.[0] ?? '';
  const base = ext ? segment.slice(0, -ext.length) : segment;
  const cleaned = base.replace(NOTION_UUID, '').replace(NOTION_HEX_ID, '');
  // Never return an empty name: a file called exactly "<id>.md" has nothing else to go on,
  // so the id is the only title it can have.
  return (cleaned.trim() || base) + ext;
}

/**
 * How many leading segments every path shares.
 *
 * Bounded so that at least one path keeps a folder of its own: without that bound, a
 * vault whose files all sit in `Vault/Subject/` would be stripped down to bare filenames
 * and every note would import to the root with no notebook at all. The bound means the
 * LAST shared level survives whenever nothing deeper distinguishes the paths.
 */
export function sharedRootDepth(paths: string[][]): number {
  if (paths.length === 0) return 0;
  const shortest = Math.min(...paths.map((p) => p.length));
  let shared = 0;
  while (shared < shortest - 1) {
    const seg = paths[0][shared];
    if (!paths.every((p) => p[shared] === seg)) break;
    shared++;
  }
  const longest = Math.max(...paths.map((p) => p.length));
  return Math.max(0, Math.min(shared, longest - 2));
}

/** Apply `sharedRootDepth` to a batch, so the container folder stops posing as a notebook. */
export function stripSharedRoot(paths: string[][]): string[][] {
  const depth = sharedRootDepth(paths);
  return depth === 0 ? paths : paths.map((p) => p.slice(depth));
}

/**
 * Drop leading segments the source is known to wrap everything in.
 *
 * Name-matched rather than left to `stripSharedRoot`, because that helper deliberately
 * preserves the last shared level - correct for a vault folder the user named, wrong for
 * "Takeout/Drive", which is Google's word and not a notebook anyone chose.
 */
export function stripLeadingSegments(segments: string[], isWrapper: (segment: string) => boolean): string[] {
  let i = 0;
  // Never consume the filename itself.
  while (i < segments.length - 1 && isWrapper(segments[i])) i++;
  return segments.slice(i);
}

/** The note title a path implies: last segment, id stripped, extension dropped. */
export function titleFromPath(segments: string[]): string | undefined {
  const last = segments[segments.length - 1];
  if (!last) return undefined;
  const title = stripExtension(last).trim();
  return title || undefined;
}
