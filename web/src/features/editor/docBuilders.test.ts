import { describe, expect, it } from 'vitest';
import {
  blockMath, bullets, callout, chem, code, codeText, columns, divider, doc,
  h, inlineMath, p, quote, table, toggle, todo, toPlainText,
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

  it('flattens a document to plain text for the search index', () => {
    const d = doc([h(1, 'Title'), p('body ', codeText('/x')), table(['H'], [[['cell']]])]);
    const flat = toPlainText(d);
    expect(flat).toContain('Title');
    expect(flat).toContain('body /x');
    expect(flat).toContain('cell');
  });
});
