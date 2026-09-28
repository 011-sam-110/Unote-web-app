import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TextStyleKit } from '@tiptap/extension-text-style';
import { TextSelection } from '@tiptap/pm/state';
import {
  familyKey,
  familyLabelFor,
  familyLabelForMark,
  selectionIsUniform,
  sizeKey,
  sizeNumber,
} from './caretStyle';

describe('sizeNumber', () => {
  it('writes a computed size the way the size menu lists it', () => {
    expect(sizeNumber('19px')).toBe('19');
    expect(sizeNumber('16px')).toBe('16');
  });

  it('rounds the fractional sizes the heading scale produces', () => {
    // h1 is 1.72em of 19px, which the browser reports as 32.68px.
    expect(sizeNumber('32.68px')).toBe('33');
    expect(sizeNumber('30.4px')).toBe('30');
    expect(sizeNumber(14.44)).toBe('14');
  });

  it('is empty rather than "NaN" or "0" when there is nothing to read', () => {
    expect(sizeNumber('')).toBe('');
    expect(sizeNumber(undefined)).toBe('');
    expect(sizeNumber('normal')).toBe('');
    expect(sizeNumber('0px')).toBe('');
  });
});

describe('familyLabelFor', () => {
  it('names the note face by its menu label, not as "Default"', () => {
    // Chrome's serialisation of --font-display, as getComputedStyle returns it.
    const display = '"Newsreader Variable", Newsreader, Georgia, "Iowan Old Style", "Times New Roman", serif';
    expect(familyLabelFor(display)).toBe('Newsreader');
  });

  it('names code by the mono face it is set in', () => {
    const code = '"JetBrains Mono", "IBM Plex Mono", ui-monospace, Consolas, Menlo, monospace';
    expect(familyLabelFor(code)).toBe('JetBrains Mono');
  });

  it('matches every entry from its own value', () => {
    expect(familyLabelFor('"IBM Plex Sans", system-ui, sans-serif')).toBe('IBM Plex Sans');
    expect(familyLabelFor('Arial, Helvetica, sans-serif')).toBe('Arial');
    expect(familyLabelFor('"Times New Roman", Times, serif')).toBe('Times New Roman');
  });

  it('finds an entry from a face further down its stack', () => {
    expect(familyLabelFor('Newsreader, serif')).toBe('Newsreader');
    expect(familyLabelFor("'Inter', sans-serif")).toBe('Inter');
  });

  it('does not claim a generic family belongs to an entry', () => {
    // system-ui is in both the Plex and Inter stacks, and is neither.
    expect(familyLabelFor('system-ui, sans-serif')).toBeNull();
    expect(familyLabelFor('serif')).toBeNull();
  });

  it('is null for a face the menu does not list', () => {
    expect(familyLabelFor('"Comic Sans MS", cursive')).toBeNull();
    expect(familyLabelFor('')).toBeNull();
  });
});

describe('familyLabelForMark', () => {
  it('uses the menu label for a mark the menu set', () => {
    expect(familyLabelForMark('Georgia, serif')).toBe('Georgia');
  });

  it('falls back to the first family of a pasted-in stack', () => {
    expect(familyLabelForMark('"Source Serif 4", serif')).toBe('Source Serif 4');
  });
});

describe('selectionIsUniform', () => {
  const editors: Editor[] = [];
  afterEach(() => {
    while (editors.length) editors.pop()!.destroy();
  });

  function make(content: object) {
    const editor = new Editor({ extensions: [StarterKit, TextStyleKit], content });
    editors.push(editor);
    return editor;
  }

  function select(editor: Editor, from: number, to: number) {
    const { state } = editor;
    editor.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
    return editor.state;
  }

  const sized = (text: string, fontSize: string) => ({
    type: 'text',
    text,
    marks: [{ type: 'textStyle', attrs: { fontSize } }],
  });

  it('treats a caret as uniform - there is only one place to read', () => {
    const editor = make({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }] });
    const state = select(editor, 2, 2);
    expect(selectionIsUniform(state, sizeKey)).toBe(true);
  });

  it('is uniform across two paragraphs of body text', () => {
    const editor = make({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'one' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'two' }] },
      ],
    });
    const state = select(editor, 1, editor.state.doc.content.size - 1);
    expect(selectionIsUniform(state, sizeKey)).toBe(true);
    expect(selectionIsUniform(state, familyKey)).toBe(true);
  });

  it('is mixed from a heading into a paragraph', () => {
    const editor = make({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'body' }] },
      ],
    });
    const state = select(editor, 1, editor.state.doc.content.size - 1);
    expect(selectionIsUniform(state, sizeKey)).toBe(false);
    // Headings are set in the same face as the body.
    expect(selectionIsUniform(state, familyKey)).toBe(true);
  });

  it('is mixed across two different size marks, and uniform across two equal ones', () => {
    const editor = make({
      type: 'doc',
      content: [{ type: 'paragraph', content: [sized('small ', '12px'), sized('big', '24px')] }],
    });
    expect(selectionIsUniform(select(editor, 1, 10), sizeKey)).toBe(false);
    // Inside the first run only.
    expect(selectionIsUniform(select(editor, 1, 5), sizeKey)).toBe(true);
  });

  it('is mixed when inline code sits in the selection, for both size and face', () => {
    const editor = make({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'run ' },
            { type: 'text', text: 'npm', marks: [{ type: 'code' }] },
          ],
        },
      ],
    });
    const state = select(editor, 1, 8);
    expect(selectionIsUniform(state, sizeKey)).toBe(false);
    expect(selectionIsUniform(state, familyKey)).toBe(false);
  });
});
