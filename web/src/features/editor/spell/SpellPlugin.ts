// Spelling decorations for the note body.
//
// Linting is async and the document keeps moving while it runs, so the ONE rule here is that
// a result computed against an old document must never be applied to the new one. Every
// result carries the exact text it was computed from, and is discarded unless the block still
// reads that way. Same discipline as AiReviewPlugin: a result that has to prove itself cannot
// underline the wrong words.
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { lintableBlocks, sliceTextblock } from './blockText';
import type { LintFn, SpellIssue } from './types';

export const SpellPluginKey = new PluginKey<SpellState>('folioSpell');

export const SPELL_DECORATION_CLASS = 'folio-spell-error';

interface BlockResult {
  /** The text the issues were computed from. The staleness guard. */
  text: string;
  issues: SpellIssue[];
}

interface SpellState {
  decorations: DecorationSet;
  /** Keyed by the block's UniqueID attr where it has one, else by its text. */
  results: Map<string, BlockResult>;
}

interface SetMeta {
  type: 'set';
  key: string;
  result: BlockResult;
}

interface ClearMeta {
  type: 'clear';
}

type Meta = SetMeta | ClearMeta;

/** Blocks already carry a stable id (UniqueID is configured for paragraphs, headings and
 *  the rest in buildExtensions), which survives edits to their text. Falling back to the
 *  text itself is correct but weaker: two identical paragraphs then share a cache entry,
 *  which is harmless because the entry only ever holds results for that exact text. */
function blockKey(node: PMNode): string {
  const id = node.attrs?.id;
  return typeof id === 'string' && id ? id : `text:${node.textContent}`;
}

function buildDecorations(doc: PMNode, results: Map<string, BlockResult>): DecorationSet {
  const decos: Decoration[] = [];
  for (const { node, pos } of lintableBlocks(doc)) {
    const result = results.get(blockKey(node));
    if (!result) continue;
    const slice = sliceTextblock(node, pos);
    // The guard. The cached result describes text this block no longer contains, so its
    // offsets mean nothing here - drop it rather than map it onto whatever is there now.
    if (slice.text !== result.text) continue;
    for (const issue of result.issues) {
      const from = slice.toDocPos(issue.start);
      const to = slice.toDocPos(issue.end);
      if (to <= from) continue;
      decos.push(
        Decoration.inline(from, to, { class: SPELL_DECORATION_CLASS }, { issue: issue as unknown as string }),
      );
    }
  }
  return DecorationSet.create(doc, decos);
}

/** Find the issue under a document position, for the context menu. */
export function issueAt(view: EditorView, pos: number): { issue: SpellIssue; from: number; to: number } | null {
  const state = SpellPluginKey.getState(view.state);
  if (!state) return null;
  const found = state.decorations.find(pos, pos);
  if (!found.length) return null;
  const d = found[0];
  const issue = (d.spec as { issue?: SpellIssue }).issue;
  return issue ? { issue, from: d.from, to: d.to } : null;
}

const DEBOUNCE_MS = 400;

/**
 * @param lint  the engine. Injected so the plugin can be tested without loading WASM.
 */
export function createSpellPlugin(lint: LintFn): Plugin<SpellState> {
  return new Plugin<SpellState>({
    key: SpellPluginKey,
    state: {
      init: () => ({ decorations: DecorationSet.empty, results: new Map() }),
      apply(tr, prev, _old, newState): SpellState {
        const meta = tr.getMeta(SpellPluginKey) as Meta | undefined;

        if (meta?.type === 'clear') {
          return { decorations: DecorationSet.empty, results: new Map() };
        }

        if (meta?.type === 'set') {
          const results = new Map(prev.results);
          results.set(meta.key, meta.result);
          return { results, decorations: buildDecorations(newState.doc, results) };
        }

        // Nothing that could have moved a character: stay off the keystroke path entirely.
        if (!tr.docChanged) return prev;

        // Map what we have so squiggles follow the text while the re-lint is in flight,
        // rather than flickering off and back on with every keystroke.
        return { results: prev.results, decorations: prev.decorations.map(tr.mapping, tr.doc) };
      },
    },
    props: {
      decorations(state) {
        return this.getState(state)?.decorations ?? null;
      },
    },
    view(view) {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let disposed = false;
      // Only ever one lint pass in flight; the trailing edge of the debounce catches up.
      let running = false;

      async function run() {
        if (disposed || running) return;
        running = true;
        try {
          const blocks = lintableBlocks(view.state.doc);
          const state = SpellPluginKey.getState(view.state);
          for (const { node, pos } of blocks) {
            if (disposed) return;
            const key = blockKey(node);
            const slice = sliceTextblock(node, pos);
            if (!slice.text.trim()) continue;
            // Unchanged since the last pass - the cached result is still exactly right.
            if (state?.results.get(key)?.text === slice.text) continue;
            const issues = await lint(slice.text);
            if (disposed) return;
            const meta: SetMeta = { type: 'set', key, result: { text: slice.text, issues } };
            view.dispatch(view.state.tr.setMeta(SpellPluginKey, meta));
          }
        } finally {
          running = false;
        }
      }

      function schedule() {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          void run();
        }, DEBOUNCE_MS);
      }

      schedule(); // lint what is already on screen

      return {
        update(_view, prevState) {
          if (!prevState.doc.eq(view.state.doc)) schedule();
        },
        destroy() {
          disposed = true;
          if (timer) clearTimeout(timer);
        },
      };
    },
  });
}
