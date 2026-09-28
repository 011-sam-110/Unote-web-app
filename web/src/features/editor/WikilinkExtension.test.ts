import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

const searchTitles = vi.fn();
const createNote = vi.fn();
vi.mock('../../lib/api', () => ({
  api: {
    searchTitles: (...args: unknown[]) => searchTitles(...args),
    createNote: (...args: unknown[]) => createNote(...args),
  },
}));
vi.mock('../../components/Toast', () => ({ toast: vi.fn() }));

const { default: Wikilink, CLOSED_WIKILINK_RE, titleFromQuery } = await import('./WikilinkExtension');

// The React node view needs a mounted React tree; the rule under test is plain ProseMirror.
const TestWikilink = Wikilink.extend({ addNodeView: () => null as never });

const editors: Editor[] = [];
function make(notebookId = 'nb1') {
  const editor = new Editor({
    extensions: [StarterKit, TestWikilink.configure({ getNotebookId: () => notebookId })],
    content: '<p></p>',
  });
  editors.push(editor);
  return editor;
}

/** Types like a keyboard does: through handleTextInput, which is where input rules live. */
function type(editor: Editor, text: string) {
  for (const ch of text) {
    const { from, to } = editor.state.selection;
    const view = editor.view;
    const handled = view.someProp('handleTextInput', (f) =>
      f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)),
    );
    if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to));
  }
}

function links(editor: Editor) {
  const out: Record<string, unknown>[] = [];
  editor.state.doc.descendants((n) => {
    if (n.type.name === 'wikilink') out.push(n.attrs);
  });
  return out;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  searchTitles.mockReset().mockResolvedValue({ results: [] });
  createNote.mockReset().mockImplementation(async ({ title }: { title: string }) => ({ note: { id: 'new-1', title } }));
});
afterEach(() => {
  while (editors.length) editors.pop()!.destroy();
});

describe('titleFromQuery', () => {
  it('drops a closing bracket typed onto the end of the title', () => {
    expect(titleFromQuery('ANSI / SPARC]]')).toBe('ANSI / SPARC');
    expect(titleFromQuery('ANSI / SPARC]')).toBe('ANSI / SPARC');
    expect(titleFromQuery('  Databases  ')).toBe('Databases');
  });
});

describe('CLOSED_WIKILINK_RE', () => {
  it('matches a closed link with and without shown text, and nothing half-typed', () => {
    expect('see [[Databases]]'.match(CLOSED_WIKILINK_RE)?.[1]).toBe('Databases');
    expect('[[Databases|the DB note]]'.match(CLOSED_WIKILINK_RE)?.slice(1, 3)).toEqual(['Databases', 'the DB note']);
    expect('[[Databases]'.match(CLOSED_WIKILINK_RE)).toBeNull();
    expect('[[]]'.match(CLOSED_WIKILINK_RE)).toBeNull();
  });
});

describe('typing ]] closes a wikilink', () => {
  it('turns [[Title]] into a link with no brackets left over, and creates the missing note', async () => {
    const editor = make();
    type(editor, '[[ANSI / SPARC]]');
    expect(editor.getText()).toBe('[[ANSI / SPARC]]'); // renderText of the one link node
    expect(links(editor)).toEqual([expect.objectContaining({ title: 'ANSI / SPARC' })]);
    expect(editor.state.doc.textContent).not.toContain(']');

    await settle();
    expect(createNote).toHaveBeenCalledWith({ notebookId: 'nb1', title: 'ANSI / SPARC' });
    expect(links(editor)[0]).toMatchObject({ noteId: 'new-1', title: 'ANSI / SPARC' });
  });

  it('links an existing note with that exact title instead of making a duplicate', async () => {
    searchTitles.mockResolvedValue({
      results: [
        { id: 'fuzzy', title: 'Databases 2' },
        { id: 'db', title: 'databases' },
      ],
    });
    const editor = make();
    type(editor, '[[Databases]]');
    await settle();
    expect(createNote).not.toHaveBeenCalled();
    expect(links(editor)[0]).toMatchObject({ noteId: 'db', title: 'databases' });
  });

  it('closes the link where ]] is typed, so text after it stays text', async () => {
    const editor = make();
    editor.commands.setContent('<p>ANSI / SPARC Architecture</p>');
    editor.commands.setTextSelection(1);
    type(editor, '[[');
    editor.commands.setTextSelection(1 + '[[ANSI / SPARC'.length);
    type(editor, ']]');
    await settle();
    expect(links(editor)[0]).toMatchObject({ title: 'ANSI / SPARC' });
    expect(editor.state.doc.textContent).toBe(' Architecture');
  });

  it('keeps shown text written after a pipe', () => {
    const editor = make();
    type(editor, '[[Databases|the DB note]]');
    expect(links(editor)[0]).toMatchObject({ title: 'Databases', alias: 'the DB note' });
  });

  it('leaves the link unresolved, not deleted, when the note cannot be made', async () => {
    createNote.mockRejectedValue(new Error('offline'));
    const editor = make();
    type(editor, '[[Offline idea]]');
    await settle();
    expect(links(editor)[0]).toMatchObject({ noteId: null, title: 'Offline idea' });
  });

  it('makes no note when the link was undone before the lookup came back', async () => {
    let finishSearch: (v: unknown) => void = () => {};
    searchTitles.mockReturnValue(new Promise((r) => (finishSearch = r)));
    const editor = make();
    type(editor, '[[Oops]]');
    editor.commands.undoInputRule();
    expect(links(editor)).toEqual([]);
    finishSearch({ results: [] });
    await settle();
    expect(createNote).not.toHaveBeenCalled();
  });
});
