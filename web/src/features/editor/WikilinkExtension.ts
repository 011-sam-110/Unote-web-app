// Custom atomic inline node for [[Wikilinks]]. Triggered by typing '[[' (Suggestion),
// autocompletes from api.searchTitles, offers "Create note: X", renders as an accent
// link with a hover preview (WikilinkView), and serializes back to plain-text
// `[[Title]]` via renderText so contentText feeds server-side link extraction
// (see docs/API.md PATCH /api/notes/:id).
import { InputRule, Node, mergeAttributes, type Editor } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import Suggestion, { findSuggestionMatch, type SuggestionOptions } from '@tiptap/suggestion';
import { PluginKey } from '@tiptap/pm/state';
import { api } from '../../lib/api';
import { toast } from '../../components/Toast';
import WikilinkView from './WikilinkView';
import WikilinkList from './WikilinkList';
import { createSuggestionRenderer } from './suggestionRenderer';
import type { NotebookLite } from '../../lib/types';

export interface WikilinkSuggestionItem {
  __create?: boolean;
  id: string;
  title: string;
  notebook?: NotebookLite;
  updatedAt?: string;
}

export interface WikilinkOptions {
  HTMLAttributes: Record<string, unknown>;
  getNotebookId: () => string;
}

export const WikilinkPluginKey = new PluginKey('folio-wikilink');

/**
 * A typed `[[Title]]` or `[[Title|shown text]]`, closed by the `]]` just typed. Titles
 * never contain [ or ] - the server's link extractor (lib/links.ts) relies on that.
 */
export const CLOSED_WIKILINK_RE = /\[\[([^[\]|]+)(?:\|([^[\]]*))?\]\]$/;

/**
 * The title a suggestion query stands for. With allowSpaces the query runs from `[[` to
 * the caret, so a half-typed close (`Foo]`) arrives here too - and a create row built
 * from it named the new note "Foo]]", which is also a title no link can ever resolve.
 */
export function titleFromQuery(query: string): string {
  return query.replace(/\]+\s*$/, '').trim();
}

/** Every unresolved (noteId-less) wikilink in the doc whose title matches, case-insensitively. */
function unresolvedLinkPositions(editor: Editor, title: string): number[] {
  const want = title.toLowerCase();
  const found: number[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'wikilink' && !node.attrs.noteId && String(node.attrs.title).toLowerCase() === want) {
      found.push(pos);
    }
  });
  return found;
}

/**
 * Point a link closed by typing `]]` at a real note: the one with exactly that title, or a
 * new one - the same outcome as choosing "Create note" in the list. The link is already
 * in the doc, unresolved, so a failure here (offline, a refused create) leaves a link the
 * reader can still click to create later rather than losing what they typed.
 */
async function resolveTypedLink(editor: Editor, title: string, getNotebookId: () => string): Promise<void> {
  let target: { id: string; title: string } | undefined;
  try {
    const { results } = await api.searchTitles(title, 8);
    target = results.find((r) => r.title.trim().toLowerCase() === title.toLowerCase());
  } catch {
    return;
  }
  // Undone (Backspace right after `]]` gives back the text) or deleted while we waited:
  // nothing left to point anywhere, so no note gets made for it either.
  if (editor.isDestroyed || !unresolvedLinkPositions(editor, title).length) return;
  if (!target) {
    const notebookId = getNotebookId();
    if (!notebookId) return;
    try {
      const { note } = await api.createNote({ notebookId, title });
      target = note;
      toast(`Created "${note.title}"`, 'ok');
    } catch {
      return;
    }
  }
  if (editor.isDestroyed) return;
  const positions = unresolvedLinkPositions(editor, title);
  if (!positions.length) return;
  const { tr } = editor.state;
  for (const pos of positions) {
    const node = tr.doc.nodeAt(pos);
    if (node) tr.setNodeMarkup(pos, undefined, { ...node.attrs, noteId: target.id, title: target.title });
  }
  // Filling in the id is bookkeeping, not an edit: it must not become an undo step.
  tr.setMeta('addToHistory', false);
  editor.view.dispatch(tr);
}

const Wikilink = Node.create<WikilinkOptions>({
  name: 'wikilink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addOptions() {
    return {
      HTMLAttributes: {},
      getNotebookId: () => '',
    };
  },

  addAttributes() {
    return {
      noteId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-note-id'),
        renderHTML: (attrs) => ({ 'data-note-id': attrs.noteId }),
      },
      title: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-title') || el.textContent || '',
        renderHTML: (attrs) => ({ 'data-title': attrs.title }),
      },
      alias: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-alias'),
        renderHTML: (attrs) => (attrs.alias ? { 'data-alias': attrs.alias } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'a[data-wikilink]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'a',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        'data-wikilink': '',
        class: 'folio-wikilink',
        href: `/note/${node.attrs.noteId}`,
      }),
      (node.attrs.alias || node.attrs.title || 'Untitled') as string,
    ];
  },

  renderText({ node }) {
    // Always serialize the plain [[Title]] form into editor.getText() (no alias
    // pipe) so the server's link extractor (lib/links.ts) resolves the target by
    // its canonical title. The alias only affects on-screen rendering.
    return `[[${node.attrs.title}]]`;
  },

  addNodeView() {
    return ReactNodeViewRenderer(WikilinkView);
  },

  addInputRules() {
    // Typing the closing `]]` finishes the link, as it does in Obsidian. Without this the
    // suggestion stayed open past the brackets and Enter made a note named "Title]]".
    return [
      new InputRule({
        find: CLOSED_WIKILINK_RE,
        handler: ({ state, range, match }) => {
          const title = match[1].trim();
          if (!title) return null;
          const alias = match[2]?.trim() || null;
          state.tr.replaceWith(range.from, range.to, this.type.create({ noteId: null, title, alias }));
          void resolveTypedLink(this.editor, title, this.options.getNotebookId);
        },
      }),
    ];
  },

  addProseMirrorPlugins() {
    const suggestion: Partial<SuggestionOptions<WikilinkSuggestionItem>> = {
      char: '[[',
      pluginKey: WikilinkPluginKey,
      allowSpaces: true,
      startOfLine: false,
      debounce: 150,
      // allowSpaces lets the query run to the caret, so text typed after a closing `]]`
      // (one the input rule did not turn into a link, e.g. a paste) would join the title.
      // A closed link is not a suggestion any more.
      findSuggestionMatch: (config) => {
        const match = findSuggestionMatch(config);
        return match && match.query.includes(']]') ? null : match;
      },
      items: async ({ query }) => {
        const q = titleFromQuery(query);
        let results: WikilinkSuggestionItem[] = [];
        try {
          const res = await api.searchTitles(q, 8);
          results = res.results;
        } catch {
          // network hiccup - fall through to just the create-row below
        }
        if (q) {
          const exact = results.findIndex((r) => r.title.toLowerCase() === q.toLowerCase());
          // The exact title first, so Enter on a fully typed title links that note rather
          // than whichever fuzzy match the search ranked above it.
          if (exact > 0) results = [results[exact], ...results.filter((_, i) => i !== exact)];
          if (exact < 0) results = [...results, { __create: true, id: '', title: q }];
        }
        return results;
      },
      render: createSuggestionRenderer(WikilinkList),
      command: ({ editor, range, props }) => {
        const item = props as WikilinkSuggestionItem;
        if (item.__create) {
          const notebookId = this.options.getNotebookId();
          if (!notebookId) {
            toast('Could not determine which notebook to create the note in', 'error');
            editor.chain().focus().deleteRange(range).run();
            return;
          }
          api
            .createNote({ notebookId, title: item.title })
            .then(({ note }) => {
              editor
                .chain()
                .focus()
                .insertContentAt(range, { type: 'wikilink', attrs: { noteId: note.id, title: note.title } })
                .run();
              toast(`Created "${note.title}"`, 'ok');
            })
            .catch((e) => {
              toast(e instanceof Error ? e.message : 'Could not create note', 'error');
              editor.chain().focus().deleteRange(range).run();
            });
        } else {
          editor
            .chain()
            .focus()
            .insertContentAt(range, { type: 'wikilink', attrs: { noteId: item.id, title: item.title } })
            .run();
        }
      },
    };
    return [Suggestion({ editor: this.editor, ...suggestion })];
  },
});

export default Wikilink;
