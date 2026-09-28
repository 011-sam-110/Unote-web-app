import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import LocalImage from './LocalImage';

const editors: Editor[] = [];
function make(content: string | object) {
  const editor = new Editor({
    extensions: [StarterKit, LocalImage],
    content,
  });
  editors.push(editor);
  return editor;
}
afterEach(() => {
  while (editors.length) editors.pop()!.destroy();
});

function firstImage(editor: Editor) {
  let attrs: Record<string, unknown> | null = null;
  editor.state.doc.descendants((node) => {
    if (!attrs && node.type.name === 'image') attrs = node.attrs;
  });
  return attrs as Record<string, unknown> | null;
}

describe('LocalImage size and wrap', () => {
  it('keeps the dragged size and the wrap side through the saved JSON', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'image', attrs: { src: 'https://example.test/a.png', width: 240, height: 150, align: 'left' } },
        { type: 'paragraph', content: [{ type: 'text', text: 'beside it' }] },
      ],
    };
    const reloaded = make(make(doc).getJSON());
    expect(firstImage(reloaded)).toMatchObject({ width: 240, height: 150, align: 'left' });
  });

  it('reads the size and wrap side back from pasted HTML', () => {
    const editor = make('<img src="https://example.test/a.png" width="300" height="200" data-align="right">');
    expect(firstImage(editor)).toMatchObject({ width: 300, height: 200, align: 'right' });
    expect(editor.getHTML()).toContain('data-align="right"');
  });

  it('treats an unknown wrap value and a junk width as the default layout', () => {
    const editor = make('<img src="https://example.test/a.png" width="wide" data-align="diagonal">');
    expect(firstImage(editor)).toMatchObject({ width: null, align: null });
  });

  it('leaves an image that was never resized exactly as it was', () => {
    const editor = make({ type: 'doc', content: [{ type: 'image', attrs: { src: 'https://example.test/a.png' } }] });
    expect(firstImage(editor)).toMatchObject({ width: null, height: null, align: null });
    expect(editor.getHTML()).not.toMatch(/width=|data-align/);
  });
});
