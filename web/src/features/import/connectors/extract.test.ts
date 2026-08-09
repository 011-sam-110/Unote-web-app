// What actually reaches the note, once a file has been read.
//
// The case worth pinning is the Unote export round trip: export.ts writes a `---` block of
// title/notebook/updated at the top of every note, and this layer is what decides whether
// re-importing that file gives you your note back or your note with four lines of metadata
// stapled to the front of it.
import { describe, it, expect } from 'vitest';
import { processFile, parseSourceTags, classify } from './extract';
import type { RawDoc } from './types';

function md(name: string, body: string): File {
  return new File([body], name, { type: 'text/markdown' });
}

describe('classify', () => {
  it('reads html by extension, since a zip entry arrives with no useful mime type', () => {
    expect(classify(new File([''], 'Doc.html', { type: 'application/octet-stream' }))).toBe('html');
    expect(classify(new File([''], 'Doc.htm', { type: '' }))).toBe('html');
    expect(classify(new File([''], 'notes.md', { type: '' }))).toBe('text');
    expect(classify(new File([''], 'essay.docx', { type: '' }))).toBe('office');
  });
});

describe('processFile', () => {
  it('strips the frontmatter block out of the body it stages', async () => {
    // Exactly what `npm run export` produces (server/src/routes/export.ts).
    // The exact shape server/src/routes/export.ts writes, down to the bracketed tag list.
    const file = md(
      'Indexing.md',
      ['---', 'title: Indexing', 'notebook: Databases', 'tags: [databases, revision]', 'updated: 2026-08-01T00:00:00Z', '---', '', 'A B-tree index turns a scan into a seek.'].join('\n'),
    );
    const out = await processFile(file, { file, sourcePath: 'Databases/Indexing.md' }, null);

    expect(out.ok).toBe(true);
    expect(out.text).toBe('A B-tree index turns a scan into a seek.');
    expect(out.text).not.toContain('---');
    expect(out.text).not.toContain('notebook:');
    // The metadata is not discarded - it becomes the title and the tags.
    expect(out.title).toBe('Indexing');
    expect(out.sourceTags).toEqual(expect.arrayContaining(['databases', 'revision']));
  });

  it('leaves a file with no frontmatter exactly as it was', async () => {
    const file = md('Loose.md', '# Heading\n\nJust prose, with a #tag in it.');
    const out = await processFile(file, { file }, null);
    expect(out.text).toBe('# Heading\n\nJust prose, with a #tag in it.');
    expect(out.sourceTags).toContain('tag');
  });

  it('applies a source-specific transform and folds its tags in', async () => {
    const file = md('Page.md', '# Page\n\nTags: alpha\n\nBody.');
    const doc: RawDoc = {
      file,
      transformText: (text) => ({ text: text.replace(/^# Page\n\nTags: alpha\n\n/, ''), tags: ['alpha'] }),
    };
    const out = await processFile(file, doc, null);
    expect(out.text).toBe('Body.');
    expect(out.sourceTags).toContain('alpha');
  });

  it('survives a transform that throws, losing the cleanup rather than the file', async () => {
    const file = md('Page.md', 'Body that must still arrive.');
    const doc: RawDoc = {
      file,
      transformText: () => {
        throw new Error('bad page');
      },
    };
    const out = await processFile(file, doc, null);
    expect(out.ok).toBe(true);
    expect(out.text).toBe('Body that must still arrive.');
  });

  it('converts an html document to markdown and takes its title', async () => {
    const html = new File(
      ['<html><head><title>Chapter 1</title><style>.b{font-weight:700}</style></head><body><h1>Method</h1><p>Drawn <span class="b">at random</span>.</p></body></html>'],
      'Chapter 1.html',
      { type: 'text/html' },
    );
    const out = await processFile(html, { file: html }, null);
    expect(out.mode).toBe('json');
    expect(out.text).toBe('# Method\n\nDrawn **at random**.');
    expect(out.title).toBe('Chapter 1');
  });
});

describe('parseSourceTags', () => {
  it('reads both YAML tag syntaxes and inline hashtags, and returns a clean body', () => {
    const inline = parseSourceTags('---\ntags: [a, b]\n---\nBody with #recall.');
    expect(inline.tags).toEqual(['a', 'b', 'recall']);
    expect(inline.body).toBe('Body with #recall.');

    const block = parseSourceTags('---\ntags:\n  - a\n  - b\n---\nBody.');
    expect(block.tags).toEqual(['a', 'b']);
  });

  it('reads the bare scalar form hand-written Obsidian vaults use', () => {
    expect(parseSourceTags('---\ntags: databases, revision\n---\nBody.').tags).toEqual(['databases', 'revision']);
    expect(parseSourceTags('---\ntags: databases revision\n---\nBody.').tags).toEqual(['databases', 'revision']);
    expect(parseSourceTags('---\ntag: databases\n---\nBody.').tags).toEqual(['databases']);
    expect(parseSourceTags('---\ntags: #databases\n---\nBody.').tags).toEqual(['databases']);
  });

  it('does not let the bare form swallow the bracketed or block forms', () => {
    expect(parseSourceTags('---\ntags: [a, b]\n---\nBody.').tags).toEqual(['a', 'b']);
    expect(parseSourceTags('---\ntags:\n  - a\n  - b\n---\nBody.').tags).toEqual(['a', 'b']);
  });

  it('needs at least two characters after the hash, so "#c" is not a tag', () => {
    // Documenting the existing rule rather than changing it: the pattern requires a letter
    // plus 1-31 more characters, which is what keeps "C# is a language" from tagging.
    expect(parseSourceTags('A single #c here.').tags).toEqual([]);
    expect(parseSourceTags('A real #cs tag here.').tags).toEqual(['cs']);
  });

  it('eats the blank line after the closing fence, not just the fence', () => {
    expect(parseSourceTags('---\ntitle: A\n---\n\nFirst line.').body).toBe('First line.');
  });

  it('does not read a markdown heading as a hashtag', () => {
    expect(parseSourceTags('# Heading\n\n## Sub').tags).toEqual([]);
  });
});
