// What each export tool actually hands over, and what the connector has to make of it.
//
// The fixtures below are real shapes: a Notion "Markdown & CSV" archive, a Google Takeout
// Drive archive, an Obsidian vault with its config directory. The assertions are mostly
// about paths, because the path is what becomes the notebook and the title - get it wrong
// and every note lands in a notebook called "Export-1f2a…".
import { describe, it, expect } from 'vitest';
import { ingestVault, keepVaultFile, isVaultInternal, isDrawing } from './obsidian';
import { ingestNotion, keepNotionFile, notionProperties, isExportWrapper } from './notion';
import { ingestDrive, keepDriveFile, isTakeoutWrapper, isTakeoutSidecar } from './gdocs';
import { sharedRootDepth, stripExportId, stripSharedRoot, decodeSegment, titleFromPath } from '../paths';

/** A File whose `name` is a full archive path, exactly as zipEntries.ts produces. */
function entry(path: string, body = '# note\n'): File {
  return new File([body], path, { type: 'text/markdown' });
}

describe('path helpers', () => {
  it('strips a Notion page id from a file and a folder, in both shapes', () => {
    expect(stripExportId('Lecture 4 a1b2c3d4e5f67890a1b2c3d4e5f67890.md')).toBe('Lecture 4.md');
    expect(stripExportId('Databases a1b2c3d4e5f67890a1b2c3d4e5f67890')).toBe('Databases');
    expect(stripExportId('Notes 1f2a3b4c-5d6e-7f80-9a1b-2c3d4e5f6070.md')).toBe('Notes.md');
  });

  it('leaves a name that merely contains hex alone', () => {
    expect(stripExportId('Debugging deadbeef.md')).toBe('Debugging deadbeef.md');
    expect(stripExportId('Notes on a1b2c3d4e5f67890a1b2c3d4e5f67890 itself.md')).toBe(
      'Notes on a1b2c3d4e5f67890a1b2c3d4e5f67890 itself.md',
    );
  });

  it('never strips a name down to nothing', () => {
    expect(stripExportId('a1b2c3d4e5f67890a1b2c3d4e5f67890.md')).toBe('a1b2c3d4e5f67890a1b2c3d4e5f67890.md');
  });

  it('decodes percent-escapes and survives a malformed one', () => {
    expect(decodeSegment('Week%201.md')).toBe('Week 1.md');
    expect(decodeSegment('100%.md')).toBe('100%.md');
  });

  it('drops a shared root only while some path keeps a folder of its own', () => {
    // Mixed depth: the vault name goes, "School" survives as a notebook.
    expect(stripSharedRoot([['Vault', 'School', 'a.md'], ['Vault', 'b.md']])).toEqual([['School', 'a.md'], ['b.md']]);
    // Flat vault: stripping would leave every note with no notebook at all, so it doesn't.
    expect(sharedRootDepth([['Vault', 'a.md'], ['Vault', 'b.md']])).toBe(0);
    // Nothing shared.
    expect(sharedRootDepth([['a.md'], ['b.md']])).toBe(0);
  });

  it('reads a title off the last segment', () => {
    expect(titleFromPath(['School', 'Indexing.md'])).toBe('Indexing');
    expect(titleFromPath([])).toBeUndefined();
  });
});

describe('Obsidian vault', () => {
  it('recognises vault plumbing at any depth', () => {
    expect(isVaultInternal(['Vault', '.obsidian', 'appearance.json'])).toBe(true);
    expect(isVaultInternal(['Vault', '.trash', 'old.md'])).toBe(true);
    expect(isVaultInternal(['Vault', 'Notes', 'a.md'])).toBe(false);
  });

  it('treats Excalidraw and canvas files as drawings, not notes', () => {
    // A .excalidraw.md is markdown by extension and a megabyte of JSON by content.
    expect(isDrawing('Diagram.excalidraw.md')).toBe(true);
    expect(isDrawing('Board.canvas')).toBe(true);
    expect(isDrawing('Lecture.md')).toBe(false);
  });

  it('imports the notes and nothing else', () => {
    expect(keepVaultFile('Vault/Databases/Indexing.md')).toBe(true);
    expect(keepVaultFile('Vault/.obsidian/workspace.json')).toBe(false);
    expect(keepVaultFile('Vault/attachments/diagram.png')).toBe(false);
    expect(keepVaultFile('Vault/Diagram.excalidraw.md')).toBe(false);
  });

  it('turns folders into notebooks and filenames into titles', () => {
    const docs = ingestVault([
      entry('MyVault/Databases/Indexing.md'),
      entry('MyVault/Databases/Joins.md'),
      entry('MyVault/Inbox.md'),
      entry('MyVault/.obsidian/appearance.json'),
    ]);
    expect(docs).toHaveLength(3);
    expect(docs.map((d) => d.sourcePath)).toEqual(['Databases/Indexing.md', 'Databases/Joins.md', 'Inbox.md']);
    expect(docs.map((d) => d.folderPath)).toEqual([['Databases'], ['Databases'], []]);
    expect(docs[0].title).toBe('Indexing');
  });

  it('keeps a flat vault’s own name as the notebook', () => {
    const docs = ingestVault([entry('Second brain/a.md'), entry('Second brain/b.md')]);
    expect(docs.map((d) => d.folderPath)).toEqual([['Second brain'], ['Second brain']]);
  });
});

describe('Notion export', () => {
  it('knows the export wrapper folder by name', () => {
    expect(isExportWrapper('Export-1f2a3b4c-5d6e-7f80-9a1b-2c3d4e5f6070')).toBe(true);
    expect(isExportWrapper('Private & Shared')).toBe(true);
    expect(isExportWrapper('Databases')).toBe(false);
  });

  it('skips the database CSV that duplicates the row pages beside it', () => {
    expect(keepNotionFile('Export-1f2a/Reading list a1b2c3d4e5f67890a1b2c3d4e5f67890.csv')).toBe(false);
    expect(keepNotionFile('Export-1f2a/Reading list a1b2c3d4e5f67890a1b2c3d4e5f67890/Row 1 b2c3.md')).toBe(true);
  });

  it('strips the wrapper and the page ids from every level', () => {
    const docs = ingestNotion([
      entry('Export-1f2a3b4c-5d6e-7f80-9a1b-2c3d4e5f6070/Uni a1b2c3d4e5f67890a1b2c3d4e5f67890/Lecture 4 0123456789abcdef0123456789abcdef.md'),
      entry('Export-1f2a3b4c-5d6e-7f80-9a1b-2c3d4e5f6070/Inbox fedcba9876543210fedcba9876543210.md'),
    ]);
    expect(docs.map((d) => d.sourcePath)).toEqual(['Uni/Lecture 4.md', 'Inbox.md']);
    expect(docs[0].title).toBe('Lecture 4');
    expect(docs[0].folderPath).toEqual(['Uni']);
  });

  it('reads the property block into tags and takes it out of the body', () => {
    const md = ['# Lecture 4', '', 'Tags: databases, revision', 'Status: Done', '', 'Real content starts here.'].join('\n');
    const { tags, body } = notionProperties(md);
    expect(tags).toEqual(['databases', 'revision']);
    expect(body).toBe('Real content starts here.');
  });

  it('leaves a page with no property block exactly as it was', () => {
    const md = '# Lecture 4\n\nStraight into the content.';
    const { tags, body } = notionProperties(md);
    expect(tags).toEqual([]);
    expect(body).toBe(md);
  });

  it('does not mistake a colon halfway down the page for a property', () => {
    const md = '# Title\n\nSome prose.\n\nNote: this is a sentence, not a property.';
    expect(notionProperties(md).body).toBe(md);
  });

  it('hands the pipeline a transform that applies the property parse', () => {
    const [doc] = ingestNotion([entry('Export-1f2a/Page a1b2c3d4e5f67890a1b2c3d4e5f67890.md')]);
    const out = doc.transformText!('# Page\n\nTags: alpha\n\nBody.');
    expect(out.tags).toEqual(['alpha']);
    expect(out.text).toBe('Body.');
  });
});

describe('Google Docs', () => {
  it('knows Takeout’s wrapper directories and its sidecar files', () => {
    expect(isTakeoutWrapper('Takeout')).toBe(true);
    expect(isTakeoutWrapper('Drive')).toBe(true);
    expect(isTakeoutWrapper('Dissertation')).toBe(false);
    expect(isTakeoutSidecar('archive_browser.html')).toBe(true);
    expect(isTakeoutSidecar('Budget.gsheet')).toBe(true);
    expect(isTakeoutSidecar('Essay.docx')).toBe(false);
  });

  it('keeps documents and drops the archive’s furniture', () => {
    expect(keepDriveFile('Takeout/Drive/Uni/Essay.docx')).toBe(true);
    expect(keepDriveFile('Takeout/Drive/Uni/Essay.html')).toBe(true);
    expect(keepDriveFile('Takeout/archive_browser.html')).toBe(false);
    expect(keepDriveFile('Takeout/Drive/Uni/Essay-info.json')).toBe(false);
    expect(keepDriveFile('Essay/images/image1.png')).toBe(false);
  });

  it('unwraps Takeout/Drive so the user’s own folders become the notebooks', () => {
    const docs = ingestDrive([
      new File(['<html></html>'], 'Takeout/Drive/Dissertation/Chapter 1.docx'),
      new File(['<html></html>'], 'Takeout/Drive/Notes.docx'),
      new File(['x'], 'Takeout/archive_browser.html'),
    ]);
    expect(docs.map((d) => d.sourcePath)).toEqual(['Dissertation/Chapter 1.docx', 'Notes.docx']);
    expect(docs[0].folderPath).toEqual(['Dissertation']);
    expect(docs[0].title).toBe('Chapter 1');
  });

  it('unwraps a flat Takeout archive too, where a shared-root rule alone would not', () => {
    // Both files sit at the same depth, so the generic "keep the last shared level" rule
    // would leave every note in a notebook called "Drive".
    const docs = ingestDrive([
      new File(['x'], 'Takeout/Drive/A.docx'),
      new File(['x'], 'Takeout/Drive/B.docx'),
    ]);
    expect(docs.map((d) => d.folderPath)).toEqual([[], []]);
  });
});
