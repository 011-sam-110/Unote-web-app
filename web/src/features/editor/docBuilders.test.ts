import { describe, expect, it } from 'vitest';
import {
  blockMath, boldText, bullets, callout, chem, code, codeText, columns, divider, doc,
  h, inlineMath, ordered, p, quote, table, text, toggle, todo, toPlainText,
} from './docBuilders';

describe('docBuilders', () => {
  it('builds a paragraph from mixed inline children', () => {
    expect(p('press ', codeText('/'), ' to insert')).toEqual({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'press ' },
        { type: 'text', text: '/', marks: [{ type: 'code' }] },
        { type: 'text', text: ' to insert' },
      ],
    });
  });

  it('omits content for an empty paragraph rather than emitting an empty array', () => {
    // ProseMirror rejects `content: []` on a node whose schema expects inline*.
    expect(p()).toEqual({ type: 'paragraph' });
  });

  it('drops empty strings rather than emitting an empty text node', () => {
    // A text node with text: '' is invalid ProseMirror and throws on load. Callers pass
    // '' freely - buildReadme's table cells do - so the filter belongs here.
    expect(p('')).toEqual({ type: 'paragraph' });
    expect(p('a', '', 'b')).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
    });
  });

  it('drops an explicitly-built empty text node, not just raw empty strings', () => {
    // p(codeText('')) and p(text('')) each build { type: 'text', text: '' } directly,
    // which is just as invalid as the raw '' case above - later tasks call codeText()
    // on values that could be empty, so the guard has to catch both forms.
    expect(p(codeText(''))).toEqual({ type: 'paragraph' });
    expect(p(text(''))).toEqual({ type: 'paragraph' });
  });

  it('builds a heading', () => {
    expect(h(2, 'Write')).toEqual({
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Write' }],
    });
  });

  it('builds a task list with per-item checked state', () => {
    expect(todo([{ checked: true, content: ['done'] }])).toEqual({
      type: 'taskList',
      content: [
        {
          type: 'taskItem',
          attrs: { checked: true },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'done' }] }],
        },
      ],
    });
  });

  it('builds a callout with emoji and tone', () => {
    expect(callout('💡', 'info', [p('tip')])).toEqual({
      type: 'callout',
      attrs: { emoji: '💡', tone: 'info' },
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'tip' }] }],
    });
  });

  it('builds a column list, one column per array', () => {
    const node = columns([[p('left')], [p('right')]]) as { content: unknown[] };
    expect(node.content).toHaveLength(2);
    expect(node).toMatchObject({ type: 'columnList' });
    expect(node.content[0]).toMatchObject({ type: 'column', attrs: { width: null } });
  });

  it('builds a details toggle with a summary and a body', () => {
    expect(toggle('More', [p('hidden')])).toEqual({
      type: 'details',
      content: [
        { type: 'detailsSummary', content: [{ type: 'text', text: 'More' }] },
        {
          type: 'detailsContent',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hidden' }] }],
        },
      ],
    });
  });

  it('builds a table with a header row and the cell attrs ProseMirror expects', () => {
    const node = table(['Command'], [[['/text']]]) as { content: Array<{ content: Array<{ type: string; attrs: unknown }> }> };
    expect(node.content[0].content[0].type).toBe('tableHeader');
    expect(node.content[1].content[0].type).toBe('tableCell');
    expect(node.content[0].content[0].attrs).toEqual({ colspan: 1, rowspan: 1, colwidth: null });
  });

  it('builds math and chem nodes with their real attrs', () => {
    expect(inlineMath('x^2')).toEqual({ type: 'inlineMath', attrs: { latex: 'x^2' } });
    expect(blockMath('a=b')).toEqual({ type: 'blockMath', attrs: { latex: 'a=b' } });
    expect(chem('C', 'Methane')).toEqual({
      type: 'chem',
      attrs: { smiles: 'C', name: 'Methane', molfile: null },
    });
  });

  it('builds a code block carrying its language', () => {
    expect(code('python', 'x = 1')).toEqual({
      type: 'codeBlock',
      attrs: { language: 'python' },
      content: [{ type: 'text', text: 'x = 1' }],
    });
  });

  it('builds bullets, quote and divider', () => {
    expect(bullets([['one']])).toMatchObject({ type: 'bulletList' });
    expect(quote('said')).toMatchObject({ type: 'blockquote' });
    expect(divider()).toEqual({ type: 'horizontalRule' });
  });

  it('builds an ordered list (with its start attr), bold text, and a bare text node', () => {
    // ordered() differs from bullets() only by attrs: { start: 1 } - assert it explicitly
    // rather than via toMatchObject so a dropped attrs block would actually fail this.
    expect(ordered([['one'], ['two']])).toEqual({
      type: 'orderedList',
      attrs: { start: 1 },
      content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] },
      ],
    });
    expect(boldText('strong')).toEqual({ type: 'text', text: 'strong', marks: [{ type: 'bold' }] });
    expect(text('plain')).toEqual({ type: 'text', text: 'plain' });
  });

  it('flattens a document to plain text for the search index', () => {
    const d = doc([h(1, 'Title'), p('body ', codeText('/x')), table(['H'], [[['cell']]])]);
    const flat = toPlainText(d);
    expect(flat).toContain('Title');
    expect(flat).toContain('body /x');
    expect(flat).toContain('cell');
  });

  describe('toPlainText block boundaries', () => {
    // blockMath and chem are block-level nodes - siblings of paragraph/heading, not
    // inline children - so their text must start a new line, never fuse onto whatever
    // block preceded them.

    it('does not fuse a block math node onto the preceding paragraph', () => {
      const d = doc([p('Given O(n),'), blockMath('T(n) = O(n log n)'), p('the sort is optimal.')]);
      expect(toPlainText(d)).toBe('Given O(n),\nT(n) = O(n log n)\nthe sort is optimal.');
    });

    it('does not fuse consecutive chem nodes onto each other', () => {
      const d = doc([chem('C', 'Methane'), chem('O', 'Water')]);
      expect(toPlainText(d)).toBe('Methane\nWater');
    });

    it('does not fuse a block math node onto a preceding heading', () => {
      const d = doc([h(1, 'Title'), blockMath('x=1')]);
      expect(toPlainText(d)).toBe('Title\nx=1');
    });

    it('keeps the block boundary for chem and blockMath nested inside a callout', () => {
      // callout is a block container that is not doc - verify the fix holds in a
      // parent context other than the top-level document.
      const d = doc([callout('🧪', 'info', [chem('C', 'Methane'), blockMath('x=1')])]);
      expect(toPlainText(d)).toBe('Methane\nx=1');
    });
  });
});
