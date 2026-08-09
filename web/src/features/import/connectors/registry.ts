// The Phase-1 connector registry. All three are client-side and file-based; a dropped folder
// keeps its structure via webkitRelativePath, which becomes the folder signal the categoriser
// leans on hardest. Adding a source later is: write one connector, push it here.
import type { RawDoc, SourceConnector } from './types';
import { classify, folderPathOf } from './extract';

function toRawDocs(files: File[], keep: (f: File) => boolean): RawDoc[] {
  const out: RawDoc[] = [];
  for (const f of files) {
    if (!keep(f)) continue;
    // webkitRelativePath is set when a directory was picked; otherwise just the name.
    const sourcePath = f.webkitRelativePath || f.name;
    out.push({ file: f, sourcePath, folderPath: folderPathOf(sourcePath), updatedAt: new Date(f.lastModified).toISOString() });
  }
  return out;
}

const files: SourceConnector = {
  id: 'files',
  label: 'Documents',
  description: 'PDF, Word, PowerPoint, text',
  icon: 'file-text',
  accept: '.pdf,.docx,.pptx,.txt,.md,.markdown',
  supportsFolder: true,
  setup: 'none',
  ingest: (fs) => toRawDocs(fs, (f) => { const c = classify(f); return c === 'text' || c === 'pdf' || c === 'office'; }),
};

const photos: SourceConnector = {
  id: 'photos',
  label: 'Photos',
  description: 'Phone photos - grouped into notes by when they were taken',
  icon: 'camera',
  accept: 'image/*',
  supportsFolder: true,
  setup: 'none',
  ingest: (fs) => toRawDocs(fs, (f) => classify(f) === 'photo'),
};

// Also the way a Unote export comes back in: ImportWizard unpacks any .zip before this
// runs, and each entry keeps its archive path as its name, so the folders inside the
// export are read as notebooks exactly like a picked folder would be.
const markdown: SourceConnector = {
  id: 'markdown',
  label: 'Markdown, folder or Unote export',
  description: 'A folder or .zip of .md/.txt - folders become notebooks',
  icon: 'folder-plus',
  accept: '.md,.markdown,.txt,.text,.zip',
  supportsFolder: true,
  setup: 'none',
  ingest: (fs) => toRawDocs(fs, (f) => classify(f) === 'text'),
};

// Advertised but not yet built - rendered greyed in the grid.
const obsidian: SourceConnector = { id: 'obsidian', label: 'Obsidian vault', description: 'A vault folder or .zip', icon: 'layers', setup: 'coming-soon', ingest: () => [] };
const notion: SourceConnector = { id: 'notion', label: 'Notion export', description: 'A .zip export', icon: 'layers', setup: 'coming-soon', ingest: () => [] };
const gdocs: SourceConnector = { id: 'gdocs', label: 'Google Docs', description: 'Connect Drive', icon: 'link', setup: 'coming-soon', ingest: () => [] };

export const CONNECTORS: SourceConnector[] = [files, photos, markdown, obsidian, notion, gdocs];

export function getConnector(id: string): SourceConnector | undefined {
  return CONNECTORS.find((c) => c.id === id);
}
