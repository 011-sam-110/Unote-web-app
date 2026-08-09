// insertables.ts - the single catalog behind Folio's Insert experience.
//
// Three surfaces share this one registry:
//   - the "/" slash menu            (SlashCommand -> SlashMenu)
//   - the gutter "+" button         (FolioEditor  -> InsertMenuPopover)
//   - the toolbar "Insert" button   (NotePage     -> InsertMenuPopover)
// All of them render InsertMenuList over these items, so adding an entry here lights
// it up in all three places at once with identical keyboard nav and ARIA.
//
// -- Registering a new insertable ---------------------------------------------
// Append ONE InsertItem to INSERT_ITEMS. Nothing else needs to change:
//
//   {
//     id: 'chemistry',
//     title: 'Chemical formula',
//     description: 'Inline SMILES or formula',
//     icon: 'flask',                 // an Icon name (preferred), else a short glyph like the sum sign
//     section: 'Notation',           // Basic | Lists | Notation | Media | Layout | Advanced
//     keywords: ['smiles', 'molecule'],
//     run: (editor, range) => at(editor, range).insertContent('...').run(),
//   }
//
// `run` MUST handle BOTH call shapes:
//   - range === undefined  -> insert at the current caret   (the "+"/toolbar path)
//   - range === {from,to}  -> delete that range first        (the "/" query text)
// Build every command off the shared `at(editor, range)` helper below and both are
// handled for you. Prefer an Icon name for `icon` so the row matches the design
// system; a literal glyph is the fallback when no vector icon fits.
//
// Optionally add `example: () => [...]` returning TipTap nodes. The generated README
// renders it as a live demonstration of the block. Omit it when the block needs an
// uploaded asset or an existing board, and add the reason to NO_DEMO below - the README
// then prints the description and the reason rather than faking a render.
import type { Editor } from '@tiptap/core';
import { pickAndInsertImage } from './imageUpload';
import { buildColumnsContent } from './Columns';
import { toast } from '../../components/Toast';
import { chemInsertable } from './nodes/chem/chemInsertable';
import { model3dInsertable } from './nodes/model3d/model3dInsertable';
import { sketchInsertables } from './nodes/sketch';
// `chem` is NOT imported here - the chemistry demo lives in chemInsertable.ts, which
// declares its own InsertItem and imports from '../../docBuilders'.
import {
  blockMath, bullets, callout, code, codeText, columns, divider, h,
  inlineMath, ordered, p, quote, table, todo, toggle, type Node,
} from './docBuilders';

export type InsertSection = 'Basic' | 'Lists' | 'Notation' | 'Media' | 'Layout' | 'Advanced';

/** The order sections are rendered in. Sections with no matching items are skipped. */
export const INSERT_SECTIONS: InsertSection[] = ['Basic', 'Lists', 'Notation', 'Media', 'Layout', 'Advanced'];

export interface InsertItem {
  id: string;
  title: string;
  description: string;
  /** An Icon name (rendered as a vector) when it matches one, otherwise a short text glyph. */
  icon: string;
  section: InsertSection;
  keywords?: string[];
  /** Insert at the caret when `range` is omitted; delete `range` (the "/" query) first when given. */
  run: (editor: Editor, range?: { from: number; to: number }) => void;
  /** Live demonstration for the generated README. Omit when the block needs an
   *  uploaded asset; add the reason to NO_DEMO instead. */
  example?: () => Node[];
}

/** Why a block cannot demonstrate itself in a seeded note. Keyed by InsertItem id. */
export const NO_DEMO: Record<string, string> = {
  image: 'needs a file you upload',
  model3d: 'needs a model file you upload',
  'canvas-snapshot': 'needs a board of your own',
  sketch: 'needs strokes you draw',
  toc: 'not a block — it jumps to the outline panel',
};

type Range = { from: number; to: number };

/** Shared chain head for every item: focus the editor, and when a "/"-query range is
 *  supplied, delete it first so the inserted node replaces the typed command. */
function at(editor: Editor, range?: Range) {
  const chain = editor.chain().focus();
  return range ? chain.deleteRange(range) : chain;
}

export const INSERT_ITEMS: InsertItem[] = [
  // -- Basic ------------------------------------------------------------------
  {
    id: 'text',
    title: 'Text',
    description: 'Plain paragraph',
    icon: 'type',
    section: 'Basic',
    keywords: ['paragraph', 'body'],
    run: (e, r) => at(e, r).setParagraph().run(),
    example: () => [p('A plain paragraph. Most of a note is these.')],
  },
  {
    id: 'h1',
    title: 'Heading 1',
    description: 'Big section heading',
    icon: 'H1',
    section: 'Basic',
    keywords: ['title'],
    run: (e, r) => at(e, r).setNode('heading', { level: 1 }).run(),
    example: () => [h(1, 'Heading 1')],
  },
  {
    id: 'h2',
    title: 'Heading 2',
    description: 'Medium section heading',
    icon: 'H2',
    section: 'Basic',
    run: (e, r) => at(e, r).setNode('heading', { level: 2 }).run(),
    example: () => [h(2, 'Heading 2')],
  },
  {
    id: 'h3',
    title: 'Heading 3',
    description: 'Small section heading',
    icon: 'H3',
    section: 'Basic',
    run: (e, r) => at(e, r).setNode('heading', { level: 3 }).run(),
    example: () => [h(3, 'Heading 3')],
  },
  {
    id: 'quote',
    title: 'Quote',
    description: 'Capture a citation',
    icon: '❝',
    section: 'Basic',
    keywords: ['blockquote', 'citation'],
    run: (e, r) => at(e, r).setBlockquote().run(),
    example: () => [quote('Use a quote for the sentence from the lecture you want to argue with later.')],
  },
  {
    id: 'divider',
    title: 'Divider',
    description: 'Visually divide sections',
    icon: '-',
    section: 'Basic',
    keywords: ['hr', 'line', 'rule', 'separator'],
    run: (e, r) => at(e, r).setHorizontalRule().run(),
    example: () => [divider()],
  },

  // -- Lists ------------------------------------------------------------------
  {
    id: 'bullet',
    title: 'Bullet list',
    description: 'Simple unordered list',
    icon: '•',
    section: 'Lists',
    keywords: ['ul', 'unordered'],
    run: (e, r) => at(e, r).toggleBulletList().run(),
    example: () => [bullets([['Points that have no order'], ['Press Tab to nest one under another']])],
  },
  {
    id: 'ordered',
    title: 'Numbered list',
    description: 'List with numbering',
    icon: '1.',
    section: 'Lists',
    keywords: ['ol', 'ordered'],
    run: (e, r) => at(e, r).toggleOrderedList().run(),
    example: () => [ordered([['Steps that do have an order'], ['Because the second follows the first']])],
  },
  {
    id: 'todo',
    title: 'To-do list',
    description: 'Track tasks with checkboxes',
    icon: 'check',
    section: 'Lists',
    keywords: ['task', 'checkbox'],
    run: (e, r) => at(e, r).toggleTaskList().run(),
    example: () => [
      todo([
        { checked: true, content: ['Read this far'] },
        { checked: false, content: ['Press ', codeText('/'), ' and insert something'] },
        { checked: false, content: ['Tick this box — it is real'] },
      ]),
    ],
  },
  {
    id: 'toggle',
    title: 'Toggle',
    description: 'Collapsible content block',
    icon: 'chevron-right',
    section: 'Lists',
    keywords: ['details', 'collapse', 'accordion'],
    run: (e, r) => at(e, r).setDetails().run(),
    example: () => [toggle('A toggle keeps long lists out of the way', [p('Open and shut. Its state is saved with the note.')])],
  },

  // -- Notation ---------------------------------------------------------------
  // Extension point: Chemistry, 3D and Sketch items land here alongside math.
  {
    id: 'inline-math',
    title: 'Inline math',
    description: 'LaTeX inside a line of text',
    icon: 'x²',
    section: 'Notation',
    keywords: ['latex', 'equation', 'katex', 'formula', 'inline', 'math'],
    run: (e, r) => at(e, r).insertInlineMath({ latex: 'x^2' }).run(),
    example: () => [
      p(
        'Maths sits inside a sentence: a comparison sort needs at least ',
        inlineMath('\\Omega(n \\log n)'),
        ' comparisons.',
      ),
    ],
  },
  {
    id: 'math-block',
    title: 'Math block',
    description: 'Standalone LaTeX equation',
    icon: '∑',
    section: 'Notation',
    keywords: ['latex', 'equation', 'katex', 'formula', 'block', 'display'],
    run: (e, r) => at(e, r).insertBlockMath({ latex: 'a^2 + b^2 = c^2' }).run(),
    example: () => [blockMath('P(A \\mid B) = \\frac{P(B \\mid A)\\,P(A)}{P(B)}')],
  },
  chemInsertable,
  model3dInsertable,
  ...sketchInsertables,

  // -- Media ------------------------------------------------------------------
  {
    id: 'image',
    title: 'Image',
    description: 'Upload and embed an image',
    icon: 'image',
    section: 'Media',
    keywords: ['picture', 'photo', 'upload'],
    run: (e, r) => {
      at(e, r).run();
      pickAndInsertImage(e);
    },
  },
  {
    id: 'table',
    title: 'Table',
    description: '3x3 table with a header row',
    icon: '▦',
    section: 'Media',
    keywords: ['grid', 'rows', 'columns'],
    run: (e, r) => at(e, r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
    example: () => [
      table(
        ['Sort', 'Worst case', 'Stable'],
        [
          [['Merge sort'], ['O(n log n)'], ['yes']],
          [['Quicksort'], ['O(n²)'], ['no']],
        ],
      ),
    ],
  },
  {
    id: 'callout',
    title: 'Callout',
    description: 'Highlighted block for notes',
    icon: 'info',
    section: 'Media',
    keywords: ['info', 'box', 'note', 'warning', 'tip'],
    run: (e, r) =>
      at(e, r)
        .insertContent({ type: 'callout', attrs: { emoji: '💡', tone: 'info' }, content: [{ type: 'paragraph' }] })
        .run(),
    example: () => [callout('💡', 'info', [p('A callout, for the thing you must not forget.')])],
  },

  // -- Layout -----------------------------------------------------------------
  {
    id: 'columns-2',
    title: '2 columns',
    description: 'Side-by-side layout',
    icon: '❘❘',
    section: 'Layout',
    keywords: ['column', 'columns', 'layout', 'side by side'],
    run: (e, r) => at(e, r).insertContent(buildColumnsContent(2)).run(),
    example: () => [columns([[p('Two columns.')], [p('Side by side.')]])],
  },
  {
    id: 'columns-3',
    title: '3 columns',
    description: 'Three-way side-by-side layout',
    icon: '❘❘❘',
    section: 'Layout',
    keywords: ['column', 'columns', 'layout', 'side by side'],
    run: (e, r) => at(e, r).insertContent(buildColumnsContent(3)).run(),
    example: () => [columns([[p('Three columns.')], [p('For comparing.')], [p('Three things.')]])],
  },

  // -- Advanced ---------------------------------------------------------------
  {
    id: 'code',
    title: 'Code block',
    description: 'Syntax-highlighted code',
    icon: '{ }',
    section: 'Advanced',
    keywords: ['snippet', 'pre'],
    run: (e, r) => at(e, r).toggleCodeBlock().run(),
    example: () => [
      code(
        'python',
        'def binary_search(a, target):\n' +
          '    lo, hi = 0, len(a) - 1\n' +
          '    while lo <= hi:\n' +
          '        mid = (lo + hi) // 2\n' +
          '        if a[mid] == target:\n' +
          '            return mid\n' +
          '        lo, hi = (mid + 1, hi) if a[mid] < target else (lo, mid - 1)\n' +
          '    return -1',
      ),
    ],
  },
  {
    id: 'toc',
    title: 'Table of contents',
    description: 'Jump to the outline panel',
    icon: 'menu',
    section: 'Advanced',
    keywords: ['outline', 'headings', 'contents'],
    run: (e, r) => {
      at(e, r).run();
      // The outline panel is a DOM affordance owned by NotePage, so this steers to it
      // (rather than inserting a node). It only mounts on wide viewports.
      const el = document.querySelector('.folio-outline');
      // Mounted is not the same as visible: the rail also stands down when a right-hand
      // drawer is wide enough to squeeze the note (drawerInset.ts). Flashing an element with
      // display:none would look like the command had simply done nothing.
      const visible = el instanceof HTMLElement && el.offsetParent !== null;
      if (el && visible) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('folio-flash');
        window.setTimeout(() => el.classList.remove('folio-flash'), 1200);
      } else if (el) {
        toast('Close the side panel to see the outline', 'info');
      } else {
        toast('The outline panel needs a wider window (min 1200px)', 'info');
      }
    },
  },
];

/** Subsequence match: every char of `query` appears in order within `target`. */
function fuzzy(query: string, target: string): boolean {
  let qi = 0;
  for (let i = 0; i < target.length && qi < query.length; i++) {
    if (target[i] === query[qi]) qi++;
  }
  return qi === query.length;
}

/**
 * How well an item answers `q`, lower being better, or null for no match at all.
 *
 * Matching on one flattened haystack made every hit equal, and the menu then showed them in
 * catalog order - so typing "table" put "3D model" (description: "Embed a ROTATABLE GLB")
 * at the top with Enter bound to it, and the reader who typed the name of the block they
 * wanted got an operating-system file dialog instead of a table. Same shape in the "/" menu:
 * "/h" led with "Text - Plain paragraph", matched through "paragraP-H".
 *
 * The ranking says what a reader means by typing: a title they are part-way through spelling
 * beats a word buried in someone else's description.
 */
function rank(q: string, item: InsertItem): number | null {
  const title = item.title.toLowerCase();
  if (title === q) return 0;
  if (title.startsWith(q)) return 1;
  // A later word of the title: "block math" should be reachable by typing "math".
  if (title.split(/\s+/).some((w) => w.startsWith(q))) return 2;
  const keywords = (item.keywords ?? []).map((k) => k.toLowerCase());
  if (keywords.some((k) => k.startsWith(q))) return 3;
  if (title.includes(q)) return 4;
  if (keywords.some((k) => k.includes(q))) return 5;
  if (item.description.toLowerCase().includes(q)) return 6;
  // Last resort so acronym-ish typing still finds things ("bq" -> "Blockquote").
  if (fuzzy(q, title)) return 7;
  return null;
}

/** Filter the catalog for a menu query (case-insensitive, title + description + keywords). */
export function getInsertItems(query: string): InsertItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return INSERT_ITEMS;
  return INSERT_ITEMS.map((item) => ({ item, score: rank(q, item) }))
    .filter((r): r is { item: InsertItem; score: number } => r.score !== null)
    // Sort is stable, so items that score the same keep their catalog order.
    .sort((a, b) => a.score - b.score)
    .map((r) => r.item);
}
