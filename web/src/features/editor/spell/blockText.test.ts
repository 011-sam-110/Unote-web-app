import { describe, it, expect } from 'vitest';
import { Schema } from '@tiptap/pm/model';
import { sliceTextblock, lintableBlocks } from './blockText';

// A miniature stand-in for the real editor schema: enough to exercise the three things that
// make the offset map non-linear - an inline atom, a skipped mark, and a code block.
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', attrs: { id: { default: null } }, toDOM: () => ['p', 0] },
    codeBlock: { group: 'block', content: 'text*', code: true, toDOM: () => ['pre', 0] },
    text: { group: 'inline' },
    chem: { group: 'inline', inline: true, atom: true, toDOM: () => ['span'] },
  },
  marks: {
    code: { toDOM: () => ['code', 0] },
  },
});

const p = (...content: unknown[]) => schema.nodes.paragraph.create(null, content as never);
const t = (s: string) => schema.text(s);
const codeText = (s: string) => schema.text(s, [schema.marks.code.create()]);

describe('sliceTextblock', () => {
  it('maps every character back to its own document position', () => {
    const doc = schema.nodes.doc.create(null, [p(t('hello world'))]);
    const block = doc.child(0);
    const slice = sliceTextblock(block, 0);
    expect(slice.text).toBe('hello world');
    // Paragraph starts at 0, its first character sits at 1.
    expect(slice.toDocPos(0)).toBe(1);
    expect(slice.toDocPos(6)).toBe(7);
    expect(doc.textBetween(slice.toDocPos(6), slice.toDocPos(11))).toBe('world');
  });

  it('drops code-marked runs, so identifiers are never offered a correction', () => {
    const doc = schema.nodes.doc.create(null, [p(t('call '), codeText('useState'), t(' twice'))]);
    const slice = sliceTextblock(doc.child(0), 0);
    expect(slice.text).not.toContain('useState');
  });

  // The reason skipped runs become a space rather than vanishing: gluing the neighbours
  // together would invent a misspelling ("callwice") that is not in the document.
  it('does not glue the words either side of a skipped run together', () => {
    const doc = schema.nodes.doc.create(null, [p(t('call '), codeText('useState'), t(' twice'))]);
    const slice = sliceTextblock(doc.child(0), 0);
    expect(slice.text).toBe('call  twice');
    expect(slice.text).not.toContain('calltwice');
  });

  // The bug this whole file exists to prevent: after a skipped run the relationship between
  // text offset and document position is no longer "add a constant".
  it('still points at the right characters AFTER a skipped run', () => {
    const doc = schema.nodes.doc.create(null, [p(t('call '), codeText('useState'), t(' twice'))]);
    const block = doc.child(0);
    const slice = sliceTextblock(block, 0);
    const idx = slice.text.indexOf('twice');
    const from = slice.toDocPos(idx);
    const to = slice.toDocPos(idx + 'twice'.length);
    expect(doc.textBetween(from, to)).toBe('twice');
  });

  it('skips inline atoms, which is what keeps citation text out of the checker', () => {
    const doc = schema.nodes.doc.create(null, [
      p(t('see '), schema.nodes.chem.create(), t(' here')),
    ]);
    const slice = sliceTextblock(doc.child(0), 0);
    const idx = slice.text.indexOf('here');
    expect(doc.textBetween(slice.toDocPos(idx), slice.toDocPos(idx + 4))).toBe('here');
  });

  it('maps correctly for a block that does not start at position 0', () => {
    const doc = schema.nodes.doc.create(null, [p(t('first')), p(t('second word'))]);
    let target = -1;
    doc.descendants((node, pos) => {
      if (node.isTextblock && node.textContent === 'second word') target = pos;
      return true;
    });
    const slice = sliceTextblock(doc.nodeAt(target)!, target);
    const idx = slice.text.indexOf('word');
    expect(doc.textBetween(slice.toDocPos(idx), slice.toDocPos(idx + 4))).toBe('word');
  });
});

describe('lintableBlocks', () => {
  it('excludes code blocks entirely', () => {
    const doc = schema.nodes.doc.create(null, [
      p(t('prose here')),
      schema.nodes.codeBlock.create(null, [t('const x = 1')]),
    ]);
    const blocks = lintableBlocks(doc);
    expect(blocks.map((b) => b.node.textContent)).toEqual(['prose here']);
  });

  it('skips empty blocks', () => {
    const doc = schema.nodes.doc.create(null, [p(), p(t('real'))]);
    expect(lintableBlocks(doc)).toHaveLength(1);
  });
});
