// Google Docs -> RawDocs, from exported files.
//
// This is the file-based path, and it is deliberately the one that shipped first: a Drive
// OAuth integration needs a Google Cloud project, a verified consent screen and secrets in
// the deployment before a single document can move, none of which a user can supply, while
// "File > Download" and Google Takeout are available to everyone right now and produce the
// same documents. `setup: 'oauth'` on a Drive connector can be added alongside this later
// without changing anything downstream.
//
// Three shapes arrive here:
//   Takeout .zip     - Takeout/Drive/<real folders>/<Doc>.docx|.html|.pdf
//   "Download all"   - a flat .zip of documents
//   single documents - one .docx or .html straight out of File > Download
//
// The `.docx` route is the highest fidelity (the server extracts it); `.html` keeps
// headings, lists, tables and - via the stylesheet pass in html.ts - bold and italics.
import type { RawDoc } from '../types';
import {
  extensionOf,
  joinSegments,
  splitSegments,
  stripLeadingSegments,
  stripSharedRoot,
  titleFromPath,
} from '../paths';

const DOC_EXT = new Set(['docx', 'html', 'htm', 'md', 'markdown', 'txt', 'rtf', 'pdf', 'odt']);

/** Takeout's own two wrapper directories. Not a notebook anyone chose - Google chose them. */
export function isTakeoutWrapper(segment: string): boolean {
  return /^Takeout$/i.test(segment) || /^Drive$/i.test(segment);
}

/**
 * Files Takeout adds that are not documents.
 *
 * `archive_browser.html` is the index page Google ships with every archive; the `.gdoc`
 * family are one-line JSON pointers at a document that lives in the cloud, not the
 * document; `.json` and `.desktop` are metadata sidecars. All of them would import as
 * notes full of nothing.
 */
export function isTakeoutSidecar(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === 'archive_browser.html' ||
    /\.(gdoc|gsheet|gslides|gdraw|gform|gjam|desktop|url|json)$/.test(lower)
  );
}

export function keepDriveFile(path: string): boolean {
  const segments = splitSegments(path);
  const name = segments[segments.length - 1] ?? '';
  if (!name || name.startsWith('.')) return false;
  if (isTakeoutSidecar(name)) return false;
  // A Docs HTML export ships its pictures in a sibling `images/` folder. They are
  // referenced by the HTML, never imported on their own.
  if (segments.some((seg) => seg.toLowerCase() === 'images')) return false;
  return DOC_EXT.has(extensionOf(name));
}

export function ingestDrive(files: File[]): RawDoc[] {
  const kept = files.filter((f) => keepDriveFile(f.webkitRelativePath || f.name));
  const unwrapped = kept.map((f) => stripLeadingSegments(splitSegments(f.webkitRelativePath || f.name), isTakeoutWrapper));
  const paths = stripSharedRoot(unwrapped);

  return kept.map((file, i) => {
    const segments = paths[i];
    return {
      file,
      sourcePath: joinSegments(segments),
      folderPath: segments.slice(0, -1),
      // Google names the exported file after the document, so the path is the title. The
      // document's own <title> is extract.ts's fallback for anything that arrives without
      // one - a loose .html with a meaningless filename, say.
      title: titleFromPath(segments),
      updatedAt: new Date(file.lastModified).toISOString(),
    };
  });
}
