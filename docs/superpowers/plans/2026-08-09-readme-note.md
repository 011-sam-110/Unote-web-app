# README Note Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seed every guest and every new account with a pinned note called README — short documentation for the whole app, generated from Unote's own registries and built out of the blocks it documents.

**Architecture:** One pure builder (`buildReadme`) reads five data sources and emits a TipTap document. Two write paths call it: `seedGuestWorkspace()` for guests (localStorage) and `ensureReadme()` for accounts (the API). Availability marks are derived from the `BLOCKED` map that already exists in `guestApi.ts`, so no second list is maintained.

**Tech Stack:** TypeScript, React 19, TipTap 3, Vitest 3 (new to `web/`), Playwright.

**Spec:** `docs/superpowers/specs/2026-08-09-readme-note-design.md`

## Global Constraints

- **The note is TipTap JSON, never Markdown.** Callouts, columns, toggles, `chem` and math nodes have no Markdown spelling. Markdown is the export format only.
- **Never fake a render.** Five blocks (`image`, `model3d`, `canvas-snapshot`, `sketch`, `toc`) cannot demonstrate themselves without an uploaded asset or an existing board. They get a described table row and a reason — never a placeholder that looks like output.
- **Availability is derived, never declared.** A feature is marked "needs an account" iff its API method is a key of `BLOCKED` in `web/src/features/guest/guestApi.ts`. Never hand-write a second availability list.
- **Node type names, verified against `buildExtensions.ts`:** `paragraph`, `heading`, `bulletList`, `orderedList`, `listItem`, `taskList`, `taskItem`, `blockquote`, `codeBlock`, `horizontalRule`, `table`, `tableRow`, `tableHeader`, `tableCell`, `callout`, `details`, `detailsSummary`, `detailsContent`, `columnList`, `column`, `chem`, `wikilink`, `inlineMath`, `blockMath`.
- **Note title is exactly `README`.** `ensureReadme()` uses it as the existence check.
- **Tags are `['unote', 'guide']`.**
- **`insertables.ts` keeps its contract:** adding a block is still appending ONE entry to `INSERT_ITEMS`.
- **Run before pushing:** `npm run test -w web`, `npm run test -w server`, `npm run e2e`, `npm run build -w web`. Typecheck alone is not sufficient — renaming one button previously broke 8 e2e specs silently.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `web/vitest.config.ts` | New. Vitest config for the web workspace, `happy-dom` environment. |
| `web/src/features/editor/docBuilders.ts` | New. Pure TipTap node factories. No app knowledge. |
| `web/src/features/editor/shortcutData.ts` | New. The 25 keybindings as data, extracted from `ShortcutsSheet.tsx`. |
| `web/src/components/paletteCatalog.ts` | New. Descriptive half of the palette's context commands. |
| `web/src/features/readme/featureCatalog.ts` | New. Sections 05–09 as data, each naming its gating API method. |
| `web/src/features/readme/buildReadme.ts` | New. The builder. Registries in, `ReadmeDoc` out. |
| `web/src/features/readme/ensureReadme.ts` | New. The guarded create-once, shared by all three entry points. |
| `web/src/features/editor/insertables.ts` | Modified. Optional `example` field per item. |
| `web/src/features/onboarding/ShortcutsSheet.tsx` | Modified. Imports `shortcutData.ts` instead of holding it. |
| `web/src/components/CommandPalette.tsx` | Modified. Maps over `paletteCatalog`, attaching `run` by id. |
| `web/src/features/onboarding/seedExample.ts` | Modified. Imports `docBuilders.ts` instead of holding its own helpers. |
| `web/src/features/guest/guestStore.ts` | Modified. `seedGuestWorkspace()` writes the README first, pinned. |
| `web/src/features/guest/TryRoute.tsx` | Modified. Opens the README on first visit only. |
| `web/src/features/onboarding/OnboardingHost.tsx` | Modified. Calls `ensureReadme()` before the tour. |
| `web/src/lib/commands.ts` | Modified. Adds the "Open the guide" command. |
| `e2e/guest.spec.ts` | Modified. Asserts the guest lands on a rendered README. |

---

### Task 1: Shared doc builders, and a test runner for `web/`

`web/` currently has **no test runner**. Vitest 3 is already in the dependency tree (root `node_modules/.bin/vitest`, declared by `server/`), and `happy-dom` is present transitively — both get declared explicitly here. This task folds that setup in because it is the first task that needs a test.

`seedExample.ts` already has `p()`, `h()` and `bullets()` (lines 31–44). They move to a shared module and gain the node types the README needs.

**Files:**
- Create: `web/vitest.config.ts`
- Create: `web/src/features/editor/docBuilders.ts`
- Create: `web/src/features/editor/docBuilders.test.ts`
- Modify: `web/package.json` (add `test` script + devDeps)
- Modify: `package.json` (root `test` script runs both workspaces)
- Modify: `web/src/features/onboarding/seedExample.ts:31-44` (delete local helpers, import them)

**Interfaces:**
- Consumes: nothing.
- Produces: every factory below. Tasks 5 and 6 build the entire document from these.

```ts
export type Node = Record<string, unknown>;
export type Inline = string | Node;
export type Tone = 'info' | 'warn' | 'ok';

export function text(s: string): Node;
export function codeText(s: string): Node;
export function boldText(s: string): Node;
export function p(...children: Inline[]): Node;
export function h(level: 1 | 2 | 3, content: string): Node;
export function bullets(items: Inline[][]): Node;
export function ordered(items: Inline[][]): Node;
export function todo(items: Array<{ checked: boolean; content: Inline[] }>): Node;
export function quote(content: string): Node;
export function divider(): Node;
export function code(language: string, source: string): Node;
export function callout(emoji: string, tone: Tone, body: Node[]): Node;
export function columns(cols: Node[][]): Node;
export function toggle(summary: string, body: Node[]): Node;
export function table(headers: string[], rows: Inline[][][]): Node;
export function inlineMath(latex: string): Node;
export function blockMath(latex: string): Node;
export function chem(smiles: string, name: string): Node;
export function doc(content: Node[]): Node;
export function toPlainText(node: Node): string;
```

- [ ] **Step 1: Declare the test tooling**

Add to `web/package.json` `scripts`:

```json
"test": "vitest run"
```

Then install the two devDependencies into the web workspace:

```bash
npm i -D vitest@^3.0.0 happy-dom -w web
```

Update the root `package.json` `test` script so one command runs both workspaces:

```json
"test": "npm run test -w server && npm run test -w web"
```

- [ ] **Step 2: Create the vitest config**

Create `web/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // happy-dom rather than node: importing INSERT_ITEMS pulls in the sketch module,
    // which imports react-dom/client and a TipTap ReactNodeViewRenderer. Neither
    // touches the DOM at module scope today, but a plain node environment makes that
    // an accident away from a red suite, and this is a browser app.
    environment: 'happy-dom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
```

- [ ] **Step 3: Write the failing test**

Create `web/src/features/editor/docBuilders.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  blockMath, bullets, callout, chem, code, codeText, columns, divider, doc,
  h, inlineMath, p, quote, table, todo, toPlainText,
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
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm run test -w web`
Expected: FAIL — `Failed to resolve import "./docBuilders"`.

- [ ] **Step 5: Implement the builders**

Create `web/src/features/editor/docBuilders.ts`:

```ts
// Pure TipTap node factories. No app knowledge lives here - these know the shape of a
// ProseMirror node and nothing else, so both the example notebook (seedExample.ts) and
// the generated README (features/readme) build documents the same way.
//
// Every node type below is registered in buildExtensions.ts. Adding a factory for a node
// the editor does not load produces a document that saves cleanly and renders as nothing,
// which is why buildReadme.test.ts checks emitted types against the schema.

export type Node = Record<string, unknown>;
export type Inline = string | Node;
export type Tone = 'info' | 'warn' | 'ok';

export function text(s: string): Node {
  return { type: 'text', text: s };
}

export function codeText(s: string): Node {
  return { type: 'text', text: s, marks: [{ type: 'code' }] };
}

export function boldText(s: string): Node {
  return { type: 'text', text: s, marks: [{ type: 'bold' }] };
}

function inlines(children: Inline[]): Node[] {
  return children.map((c) => (typeof c === 'string' ? text(c) : c));
}

/**
 * A paragraph.
 *
 * Empty strings are dropped and a childless paragraph emits no `content` key at all.
 * Both matter: ProseMirror rejects `content: []` on a node whose schema expects
 * `inline*`, and a text node with `text: ''` throws on load. Callers pass '' freely -
 * buildReadme's table cells are empty whenever a block has nothing to flag - so the
 * filter belongs here rather than at every call site.
 */
export function p(...children: Inline[]): Node {
  const content = inlines(children.filter((c) => c !== ''));
  if (content.length === 0) return { type: 'paragraph' };
  return { type: 'paragraph', content };
}

export function h(level: 1 | 2 | 3, content: string): Node {
  return { type: 'heading', attrs: { level }, content: [text(content)] };
}

function items(list: Inline[][]): Node[] {
  return list.map((c) => ({ type: 'listItem', content: [p(...c)] }));
}

export function bullets(list: Inline[][]): Node {
  return { type: 'bulletList', content: items(list) };
}

export function ordered(list: Inline[][]): Node {
  return { type: 'orderedList', attrs: { start: 1 }, content: items(list) };
}

export function todo(list: Array<{ checked: boolean; content: Inline[] }>): Node {
  return {
    type: 'taskList',
    content: list.map((i) => ({
      type: 'taskItem',
      attrs: { checked: i.checked },
      content: [p(...i.content)],
    })),
  };
}

export function quote(content: string): Node {
  return { type: 'blockquote', content: [p(content)] };
}

export function divider(): Node {
  return { type: 'horizontalRule' };
}

export function code(language: string, source: string): Node {
  return { type: 'codeBlock', attrs: { language }, content: [text(source)] };
}

export function callout(emoji: string, tone: Tone, body: Node[]): Node {
  return { type: 'callout', attrs: { emoji, tone }, content: body };
}

export function columns(cols: Node[][]): Node {
  return {
    type: 'columnList',
    content: cols.map((content) => ({ type: 'column', attrs: { width: null }, content })),
  };
}

export function toggle(summary: string, body: Node[]): Node {
  return {
    type: 'details',
    content: [
      { type: 'detailsSummary', content: [text(summary)] },
      { type: 'detailsContent', content: body },
    ],
  };
}

const CELL_ATTRS = { colspan: 1, rowspan: 1, colwidth: null };

/** A table with a header row. `rows` is row-major: each row is a list of cells, and each
 *  cell is a list of inline children, so a cell can carry a code mark or a badge. */
export function table(headers: string[], rows: Inline[][][]): Node {
  const headerRow = {
    type: 'tableRow',
    content: headers.map((label) => ({
      type: 'tableHeader',
      attrs: CELL_ATTRS,
      content: [p(label)],
    })),
  };
  const bodyRows = rows.map((cells) => ({
    type: 'tableRow',
    content: cells.map((cell) => ({
      type: 'tableCell',
      attrs: CELL_ATTRS,
      content: [p(...cell)],
    })),
  }));
  return { type: 'table', content: [headerRow, ...bodyRows] };
}

export function inlineMath(latex: string): Node {
  return { type: 'inlineMath', attrs: { latex } };
}

export function blockMath(latex: string): Node {
  return { type: 'blockMath', attrs: { latex } };
}

export function chem(smiles: string, name: string): Node {
  return { type: 'chem', attrs: { smiles, name, molfile: null } };
}

export function doc(content: Node[]): Node {
  return { type: 'doc', content };
}

/**
 * Flatten a document to the plain text the server indexes and parses for backlinks.
 *
 * Block boundaries become newlines rather than being run together: `contentText` is what
 * search snippets are cut from, and "Write/ to insert" reads as a typo where
 * "Write\n/ to insert" reads as two blocks.
 */
export function toPlainText(node: Node): string {
  const out: string[] = [];
  walk(node, out);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const INLINE_TYPES = new Set(['text', 'inlineMath', 'wikilink']);

function walk(node: Node, out: string[]): void {
  const type = node.type as string | undefined;
  if (type === 'text') {
    append(out, node.text as string);
    return;
  }
  if (type === 'inlineMath' || type === 'blockMath') {
    append(out, ((node.attrs as Record<string, unknown>)?.latex as string) ?? '');
    return;
  }
  if (type === 'wikilink') {
    // The literal [[Title]] form is what the server parses to build the links table.
    append(out, `[[${(node.attrs as Record<string, unknown>)?.title as string}]]`);
    return;
  }
  if (type === 'chem') {
    append(out, ((node.attrs as Record<string, unknown>)?.name as string) ?? '');
    return;
  }
  const children = node.content as Node[] | undefined;
  if (!children) {
    if (type && !INLINE_TYPES.has(type)) out.push('');
    return;
  }
  const inline = children.every((c) => INLINE_TYPES.has(c.type as string));
  if (!inline) {
    for (const child of children) walk(child, out);
    return;
  }
  out.push('');
  for (const child of children) walk(child, out);
}

function append(out: string[], s: string): void {
  if (out.length === 0) out.push('');
  out[out.length - 1] += s;
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm run test -w web`
Expected: PASS, 11 tests.

- [ ] **Step 7: Point `seedExample.ts` at the shared builders**

In `web/src/features/onboarding/seedExample.ts`, delete the local `p`, `h` and `bullets` functions (lines 31–44) and add the import below the existing `api` import:

```ts
import { bullets as bulletsOf, h, p } from '../editor/docBuilders';
```

`bullets()` there is called as `bullets(['a', 'b'])` (a flat string array) but the shared one takes `Inline[][]`. Add one adapter beneath the import rather than rewriting the four call sites:

```ts
/** seedExample's lists are all plain strings; the shared builder takes inline children. */
function bullets(list: string[]) {
  return bulletsOf(list.map((s) => [s]));
}
```

- [ ] **Step 8: Verify the example notebook is unchanged**

Run: `npm run build -w web`
Expected: build succeeds, no type errors.

Run: `npx playwright test e2e/onboarding.spec.ts`
Expected: PASS — the tour still seeds and navigates the example notebook.

- [ ] **Step 9: Commit**

```bash
git add web/vitest.config.ts web/package.json package.json package-lock.json \
        web/src/features/editor/docBuilders.ts \
        web/src/features/editor/docBuilders.test.ts \
        web/src/features/onboarding/seedExample.ts
git commit -m "feat(editor): shared TipTap doc builders, and a vitest runner for web"
```

---

### Task 2: Extract the keybinding data

`ShortcutsSheet.tsx` holds all 25 bindings inside a private `groups()` function (lines 29–81). The README needs the same data. Only the data moves; the component keeps rendering it.

**Files:**
- Create: `web/src/features/editor/shortcutData.ts`
- Create: `web/src/features/editor/shortcutData.test.ts`
- Modify: `web/src/features/onboarding/ShortcutsSheet.tsx:19-81`

**Interfaces:**
- Consumes: nothing.
- Produces: `shortcutGroups(mod, shift)`, `SHORTCUT_COUNT`, and the `Row` / `Group` types. Task 6 renders these into section 04.

```ts
export interface Row { keys: string[]; label: string }
export interface Group { name: string; rows: Row[] }
export function shortcutGroups(mod: string, shift: string): Group[];
export const SHORTCUT_COUNT: number;
```

- [ ] **Step 1: Write the failing test**

Create `web/src/features/editor/shortcutData.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { SHORTCUT_COUNT, shortcutGroups } from './shortcutData';

describe('shortcutData', () => {
  it('has five groups', () => {
    expect(shortcutGroups('Ctrl', 'Shift').map((g) => g.name)).toEqual([
      'Anywhere', 'Writing', 'On a note', 'Search page', 'Reviewing flashcards',
    ]);
  });

  it('SHORTCUT_COUNT matches the rows actually declared', () => {
    const rows = shortcutGroups('Ctrl', 'Shift').reduce((n, g) => n + g.rows.length, 0);
    expect(SHORTCUT_COUNT).toBe(rows);
    // Guards the number the README prints. If a binding is added and this fails,
    // the fix is to delete the hard-coded 25 below, not to edit the expectation.
    expect(SHORTCUT_COUNT).toBe(25);
  });

  it('substitutes the platform modifier into the keys', () => {
    const anywhere = shortcutGroups('⌘', '⇧')[0];
    expect(anywhere.rows[0].keys).toEqual(['⌘', 'K']);
    expect(anywhere.rows[3].keys).toEqual(['⌘', '⇧', 'F']);
  });

  it('never emits an empty label', () => {
    for (const g of shortcutGroups('Ctrl', 'Shift')) {
      for (const r of g.rows) expect(r.label.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w web -- shortcutData`
Expected: FAIL — `Failed to resolve import "./shortcutData"`.

- [ ] **Step 3: Create the data module**

Create `web/src/features/editor/shortcutData.ts` with the file header and the exact rows currently in `ShortcutsSheet.tsx`:

```ts
// The keyboard bindings, as data.
//
// Every binding here was read off the code that implements it, not off a spec -
// lib/useShortcuts.ts for the global chords, NotePage.tsx for the note-page window
// listener (Ctrl+S/F/H), SearchPage.tsx for "/", ReviewTab.tsx for the review keys, and
// TipTap's StarterKit defaults for the formatting marks. A cheatsheet that lists a
// shortcut which does not fire is worse than no cheatsheet.
//
// Extracted from ShortcutsSheet.tsx so the generated README documents the same list the
// "?" sheet shows, from one definition.

export interface Row {
  keys: string[];
  label: string;
}

export interface Group {
  name: string;
  rows: Row[];
}

/** `mod` and `shift` are passed in because the sheet renders ⌘/⇧ on a Mac and spells the
 *  modifiers out everywhere else - "⌘" on a Windows machine is just noise. */
export function shortcutGroups(mod: string, shift: string): Group[] {
  return [
    {
      name: 'Anywhere',
      rows: [
        { keys: [mod, 'K'], label: 'Jump to a note' },
        { keys: [mod, 'P'], label: 'Command palette: run anything' },
        { keys: [mod, 'N'], label: 'New note in the current notebook' },
        { keys: [mod, shift, 'F'], label: 'Search your notes' },
        { keys: [mod, '\\'], label: 'Show or hide the sidebar' },
        { keys: ['?'], label: 'This cheatsheet' },
        { keys: ['Esc'], label: 'Close whatever is open' },
      ],
    },
    {
      name: 'Writing',
      rows: [
        { keys: ['/'], label: 'Slash menu: headings, lists, tables, callouts' },
        { keys: ['[', '['], label: 'Link another note' },
        { keys: ['#', 'Space'], label: 'Heading (and "- " a bullet, "> " a quote)' },
        { keys: [mod, 'B'], label: 'Bold' },
        { keys: [mod, 'I'], label: 'Italic' },
        { keys: [mod, 'U'], label: 'Underline' },
        { keys: [mod, 'E'], label: 'Inline code' },
        { keys: [mod, 'Z'], label: 'Undo' },
      ],
    },
    {
      name: 'On a note',
      rows: [
        { keys: [mod, 'S'], label: 'Save a named version you can restore' },
        { keys: [mod, 'F'], label: 'Find in this note' },
        { keys: [mod, 'H'], label: 'Find and replace' },
        { keys: ['Tab'], label: 'Move between columns' },
      ],
    },
    {
      name: 'Search page',
      rows: [{ keys: ['/'], label: 'Focus the search box' }],
    },
    {
      name: 'Reviewing flashcards',
      rows: [
        { keys: ['Space'], label: 'Show the answer' },
        { keys: ['1'], label: 'Again' },
        { keys: ['2'], label: 'Hard' },
        { keys: ['3'], label: 'Good' },
        { keys: ['4'], label: 'Easy' },
      ],
    },
  ];
}

/** Derived, never typed by hand - the README prints it. */
export const SHORTCUT_COUNT: number = shortcutGroups('Ctrl', 'Shift').reduce(
  (n, g) => n + g.rows.length,
  0,
);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w web -- shortcutData`
Expected: PASS, 4 tests.

- [ ] **Step 5: Point the sheet at the data module**

In `web/src/features/onboarding/ShortcutsSheet.tsx`: delete the `Row` and `Group` interfaces and the whole `groups()` function (lines 19–81), and add the import:

```ts
import { shortcutGroups } from '../editor/shortcutData';
```

Then in the component body, replace the `groups(mod, shift, alt)` call with `shortcutGroups(mod, shift)`, and delete the now-unused `alt` const and its `void alt;` line.

- [ ] **Step 6: Verify the sheet still renders**

Run: `npm run build -w web`
Expected: build succeeds.

Run: `npx playwright test e2e/onboarding.spec.ts`
Expected: PASS — the `shortcuts-sheet` testid still renders its groups.

- [ ] **Step 7: Commit**

```bash
git add web/src/features/editor/shortcutData.ts \
        web/src/features/editor/shortcutData.test.ts \
        web/src/features/onboarding/ShortcutsSheet.tsx
git commit -m "refactor(onboarding): lift the keybinding list out of ShortcutsSheet"
```

---

### Task 3: Extract the palette's context-command descriptions

`CommandPalette.tsx` declares 11 commands inline (ids at lines 103, 124, 142, 153, 162, 171, 180, 189, 200, 212, 228) because each needs component state to run. Only the words move; every `run` stays.

**Files:**
- Create: `web/src/components/paletteCatalog.ts`
- Create: `web/src/components/paletteCatalog.test.ts`
- Modify: `web/src/components/CommandPalette.tsx`

**Interfaces:**
- Consumes: `Command` from `web/src/lib/commands.ts`.
- Produces: `PALETTE_CATALOG: PaletteDoc[]`, `paletteDoc(id)`. Task 6 renders these into section 04.

```ts
export interface PaletteDoc {
  id: string;
  title: string;
  hint: string;
  section: string;
  shortcut?: string;
  /** API method this command needs, when it needs one. Keyed against BLOCKED. */
  needs?: string;
}
export const PALETTE_CATALOG: PaletteDoc[];
export function paletteDoc(id: string): PaletteDoc;
```

- [ ] **Step 1: Write the failing test**

Create `web/src/components/paletteCatalog.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PALETTE_CATALOG, paletteDoc } from './paletteCatalog';
import { guestBlockedMessage } from '../features/guest/guestApi';

describe('paletteCatalog', () => {
  it('documents all eleven context commands', () => {
    expect(PALETTE_CATALOG).toHaveLength(11);
  });

  it('has no duplicate ids', () => {
    const ids = PALETTE_CATALOG.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every command a title, a hint and a section', () => {
    for (const c of PALETTE_CATALOG) {
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.hint.length).toBeGreaterThan(0);
      expect(c.section.length).toBeGreaterThan(0);
    }
  });

  it('names a real BLOCKED key wherever it claims a command needs an account', () => {
    // guestBlockedMessage falls back to a generic sentence for an unknown method, so a
    // typo would silently produce vague copy. Compare against the specific message.
    const generic = guestBlockedMessage('__definitely_not_a_method__');
    for (const c of PALETTE_CATALOG) {
      if (!c.needs) continue;
      expect(guestBlockedMessage(c.needs), `${c.id} -> ${c.needs}`).not.toBe(generic);
    }
  });

  it('throws on an unknown id rather than returning undefined', () => {
    expect(() => paletteDoc('nope')).toThrow(/nope/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w web -- paletteCatalog`
Expected: FAIL — `Failed to resolve import "./paletteCatalog"`.

- [ ] **Step 3: Create the catalog**

Create `web/src/components/paletteCatalog.ts`:

```ts
// The descriptive half of the palette commands that CommandPalette.tsx assembles itself.
//
// lib/commands.ts holds the commands that are truly global and context-free. The eleven
// below need component state to run (the current notebook, the sidebar toggle, the open
// note), so their `run` stays in CommandPalette.tsx - but their WORDS live here, because
// the generated README documents every command and two copies of a title drift.
//
// `needs` names the api method the command ultimately calls, keyed against the BLOCKED
// map in features/guest/guestApi.ts. That is what marks a command as account-only in the
// README, so nothing is hand-listed twice.

export interface PaletteDoc {
  id: string;
  title: string;
  hint: string;
  section: string;
  shortcut?: string;
  needs?: string;
}

export const PALETTE_CATALOG: PaletteDoc[] = [
  { id: 'create-note', title: 'New note', hint: 'In the current notebook', section: 'Create', shortcut: 'Ctrl+N' },
  { id: 'create-canvas', title: 'New board', hint: 'An infinite canvas for stickies and ink', section: 'Create', needs: 'createCanvasItem' },
  { id: 'create-notebook', title: 'New notebook', hint: 'A place to file notes', section: 'Create' },
  { id: 'create-import-photo', title: 'Import photos', hint: 'Phone photos of written pages', section: 'Create', needs: 'import' },
  { id: 'create-import-slides', title: 'Import slides', hint: 'A PDF or PPTX deck', section: 'Create', needs: 'import' },
  { id: 'create-import-transcript', title: 'Import transcript', hint: 'A lecture recording', section: 'Create', needs: 'import' },
  { id: 'import-old-notes', title: 'Import old notes', hint: 'The bulk import wizard', section: 'Create', needs: 'createImportBatch' },
  { id: 'create-phone-capture', title: 'Phone capture', hint: 'Scan a QR to send notes from your phone', section: 'Create', needs: 'qr' },
  { id: 'note-snapshot', title: 'Snapshot now', hint: 'Save a version you can restore', section: 'Note', shortcut: 'Ctrl+S', needs: 'snapshot' },
  { id: 'view-sidebar', title: 'Toggle sidebar', hint: 'Show or hide it', section: 'View', shortcut: 'Ctrl+\\' },
  { id: 'study-notebook', title: 'Study this notebook', hint: 'Review just these flashcards', section: 'Study', needs: 'review' },
];

const BY_ID = new Map(PALETTE_CATALOG.map((c) => [c.id, c]));

/** Throws rather than returning undefined: a typo'd id in CommandPalette would otherwise
 *  drop a command out of the palette silently, with nothing failing anywhere. */
export function paletteDoc(id: string): PaletteDoc {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`paletteDoc: no catalog entry for "${id}"`);
  return found;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w web -- paletteCatalog`
Expected: PASS, 5 tests.

- [ ] **Step 5: Point CommandPalette at the catalog**

In `web/src/components/CommandPalette.tsx`, import the helper:

```ts
import { paletteDoc } from './paletteCatalog';
```

Then for each of the 11 inline command objects, replace its literal `title`, `hint`, `section` and `shortcut` fields with a spread of the catalog entry, keeping `run`, `icon`, `emoji` and `keywords` exactly as they are. For example, the `create-note` command becomes:

```ts
{
  ...paletteDoc('create-note'),
  icon: 'file-plus',
  run: () => { /* unchanged body */ },
},
```

Apply the same shape to all eleven ids: `create-note`, `create-canvas`, `create-notebook`, `create-import-photo`, `create-import-slides`, `create-import-transcript`, `import-old-notes`, `create-phone-capture`, `note-snapshot`, `view-sidebar`, `study-notebook`. Do not change any `run` body, any `keywords`, or the conditions that decide whether a command is included.

- [ ] **Step 6: Verify the palette is unchanged**

Run: `npm run build -w web`
Expected: build succeeds.

Run: `npm run dev` then open the app and press `Ctrl+P`.
Expected: the same commands appear, in the same sections, with the same titles. `paletteDoc` throwing on an unknown id means a typo fails loudly at first render rather than dropping a row.

- [ ] **Step 7: Commit**

```bash
git add web/src/components/paletteCatalog.ts \
        web/src/components/paletteCatalog.test.ts \
        web/src/components/CommandPalette.tsx
git commit -m "refactor(palette): lift context-command descriptions into a catalog"
```

---

### Task 4: The feature catalog for sections 05–09

Sections 05–09 have no registry behind them. This file is that registry — one entry per feature, each naming the API method that gates it, so the guest marks stay derived.

**Files:**
- Create: `web/src/features/readme/featureCatalog.ts`
- Create: `web/src/features/readme/featureCatalog.test.ts`

**Interfaces:**
- Consumes: `guestBlockedMessage` from `web/src/features/guest/guestApi.ts`.
- Produces: `FEATURE_SECTIONS: FeatureSection[]`. Task 6 renders these as sections 05–09.

```ts
export interface FeatureLine {
  what: string;
  /** API method this line needs, keyed against BLOCKED. Absent = works for guests. */
  needs?: string;
}
export interface FeatureSection {
  number: string;   // '05'
  title: string;    // 'Study'
  blurb: string;
  lines: FeatureLine[];
}
export const FEATURE_SECTIONS: FeatureSection[];
```

- [ ] **Step 1: Write the failing test**

Create `web/src/features/readme/featureCatalog.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { FEATURE_SECTIONS } from './featureCatalog';
import { guestBlockedMessage } from '../guest/guestApi';

describe('featureCatalog', () => {
  it('covers sections 05 through 09', () => {
    expect(FEATURE_SECTIONS.map((s) => s.number)).toEqual(['05', '06', '07', '08', '09']);
  });

  it('gives every section a title, a blurb and at least one line', () => {
    for (const s of FEATURE_SECTIONS) {
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.blurb.length).toBeGreaterThan(0);
      expect(s.lines.length).toBeGreaterThan(0);
    }
  });

  it('names a real BLOCKED key on every gated line', () => {
    const generic = guestBlockedMessage('__definitely_not_a_method__');
    for (const s of FEATURE_SECTIONS) {
      for (const l of s.lines) {
        if (!l.needs) continue;
        expect(guestBlockedMessage(l.needs), `${s.title}: ${l.what}`).not.toBe(generic);
      }
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w web -- featureCatalog`
Expected: FAIL — `Failed to resolve import "./featureCatalog"`.

- [ ] **Step 3: Create the catalog**

Create `web/src/features/readme/featureCatalog.ts`:

```ts
// Sections 05-09 of the README, as data.
//
// Sections 01-04 are emitted from registries that already exist (INSERT_ITEMS, the
// command catalogue, the shortcut groups). Study, Boards, Import, AI and Share have no
// such registry, so their copy lives here - one definition in one place, but written by
// hand rather than derived. A feature added without touching this file will not appear in
// the README. That limit is deliberate and recorded in the design doc.
//
// `needs` names the api method the line depends on, keyed against BLOCKED in
// features/guest/guestApi.ts, so the guest build marks itself.

export interface FeatureLine {
  what: string;
  needs?: string;
}

export interface FeatureSection {
  number: string;
  title: string;
  blurb: string;
  lines: FeatureLine[];
}

export const FEATURE_SECTIONS: FeatureSection[] = [
  {
    number: '05',
    title: 'Study',
    blurb: 'Turn a note into flashcards and let the schedule decide when you see them again.',
    lines: [
      { what: 'Select a passage and make a card from it, or write one by hand', needs: 'createCard' },
      { what: 'Review with Space to reveal, then 1-4 for how well it went', needs: 'review' },
      { what: 'Cards you find hard come back sooner; cards you know drift further out', needs: 'review' },
    ],
  },
  {
    number: '06',
    title: 'Boards',
    blurb: 'An infinite canvas for the thinking that is not paragraphs.',
    lines: [
      { what: 'Stickies, cards that link to real notes, and arrows between them', needs: 'createCanvasItem' },
      { what: 'Draw with a pen, a highlighter or a finger', needs: 'addInk' },
      { what: 'Drop a snapshot of a board into any note', needs: 'createCanvasItem' },
    ],
  },
  {
    number: '07',
    title: 'Bring notes in',
    blurb: 'Most notes start somewhere else. Point Unote at them.',
    lines: [
      { what: 'PDFs and slide decks, split into one note per slide', needs: 'import' },
      { what: 'Photos of handwritten pages, grouped automatically', needs: 'import' },
      { what: 'A lecture recording, transcribed in your browser', needs: 'import' },
      { what: 'A folder of old Markdown, sorted before anything is written', needs: 'createImportBatch' },
      { what: 'Your phone, paired by scanning a QR code', needs: 'qr' },
    ],
  },
  {
    number: '08',
    title: 'Ask AI',
    blurb: 'A conversation about the note you are looking at, or about everything you have written.',
    lines: [
      { what: 'Ask about this note; it can rewrite, summarise or make cards from it', needs: 'aiImprove' },
      { what: 'Ask across every note and get answers with the sources listed', needs: 'aiAsk' },
      { what: 'Every change is shown as a diff you approve before it lands', needs: 'aiSuggest' },
    ],
  },
  {
    number: '09',
    title: 'Share & export',
    blurb: 'Notes you can hand to someone, and notes you can take away.',
    lines: [
      { what: 'A link anyone can open, revocable whenever you like', needs: 'createShare' },
      { what: 'Invite someone to edit with you', needs: 'createShare' },
      { what: 'Export a note, or everything, as Markdown' },
    ],
  },
];
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w web -- featureCatalog`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/features/readme/featureCatalog.ts \
        web/src/features/readme/featureCatalog.test.ts
git commit -m "feat(readme): feature catalog for the non-registry sections"
```

---

### Task 5: Give every insertable its own demo

One optional field on `InsertItem`, populated for the 18 blocks that can demonstrate themselves without an uploaded asset.

**Files:**
- Modify: `web/src/features/editor/insertables.ts`
- Create: `web/src/features/editor/insertables.test.ts`

**Interfaces:**
- Consumes: `docBuilders` from Task 1.
- Produces: `InsertItem.example?: () => Node[]`, and `NO_DEMO: Record<string, string>` mapping each undemonstrable id to its reason. Task 6 reads both.

- [ ] **Step 1: Write the failing test**

Create `web/src/features/editor/insertables.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { INSERT_ITEMS, INSERT_SECTIONS, NO_DEMO } from './insertables';

describe('insertables', () => {
  it('has 23 blocks with unique ids', () => {
    expect(INSERT_ITEMS).toHaveLength(23);
    const ids = INSERT_ITEMS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every item sits in a declared section', () => {
    for (const i of INSERT_ITEMS) expect(INSERT_SECTIONS).toContain(i.section);
  });

  it('exactly the five asset-dependent blocks have no demo', () => {
    const undemonstrated = INSERT_ITEMS.filter((i) => !i.example).map((i) => i.id).sort();
    expect(undemonstrated).toEqual(['canvas-snapshot', 'image', 'model3d', 'sketch', 'toc']);
  });

  it('gives a reason for every block it cannot demonstrate', () => {
    for (const i of INSERT_ITEMS) {
      if (i.example) continue;
      expect(NO_DEMO[i.id], `${i.id} needs a reason`).toBeTruthy();
    }
    // No stale reasons for blocks that CAN demo themselves.
    for (const id of Object.keys(NO_DEMO)) {
      expect(INSERT_ITEMS.find((i) => i.id === id)?.example).toBeUndefined();
    }
  });

  it('every demo returns at least one node, and never an empty array', () => {
    for (const i of INSERT_ITEMS) {
      if (!i.example) continue;
      const nodes = i.example();
      expect(nodes.length, `${i.id} produced no nodes`).toBeGreaterThan(0);
      for (const n of nodes) expect(typeof n.type).toBe('string');
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w web -- insertables`
Expected: FAIL — `NO_DEMO` is not exported.

- [ ] **Step 3: Extend the InsertItem type and document the field**

In `web/src/features/editor/insertables.ts`, add to the header comment block, immediately after the `run` explanation:

```
// Optionally add `example: () => [...]` returning TipTap nodes. The generated README
// renders it as a live demonstration of the block. Omit it when the block needs an
// uploaded asset or an existing board, and add the reason to NO_DEMO below - the README
// then prints the description and the reason rather than faking a render.
```

Add the import beneath the existing ones:

```ts
// `chem` is NOT imported here - the chemistry demo lives in chemInsertable.ts, which
// declares its own InsertItem and imports from '../../docBuilders'.
import {
  blockMath, bullets, callout, code, codeText, columns, divider, h,
  inlineMath, ordered, p, quote, table, todo, toggle, type Node,
} from './docBuilders';
```

Extend the interface:

```ts
export interface InsertItem {
  // ...existing fields unchanged...
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
```

- [ ] **Step 4: Add the 18 demos**

Add an `example` to each item in `INSERT_ITEMS`. The five in `NO_DEMO` get none.

```ts
// text
example: () => [p('A plain paragraph. Most of a note is these.')],

// h1
example: () => [h(1, 'Heading 1')],

// h2
example: () => [h(2, 'Heading 2')],

// h3
example: () => [h(3, 'Heading 3')],

// quote
example: () => [quote('Use a quote for the sentence from the lecture you want to argue with later.')],

// divider
example: () => [divider()],

// bullet
example: () => [bullets([['Points that have no order'], ['Press Tab to nest one under another']])],

// ordered
example: () => [ordered([['Steps that do have an order'], ['Because the second follows the first']])],

// todo
example: () => [
  todo([
    { checked: true, content: ['Read this far'] },
    { checked: false, content: ['Press ', codeText('/'), ' and insert something'] },
    { checked: false, content: ['Tick this box — it is real'] },
  ]),
],

// toggle
example: () => [toggle('A toggle keeps long lists out of the way', [p('Open and shut. Its state is saved with the note.')])],

// inline-math
example: () => [
  p(
    'Maths sits inside a sentence: a comparison sort needs at least ',
    inlineMath('\\Omega(n \\log n)'),
    ' comparisons.',
  ),
],

// math-block
example: () => [blockMath('P(A \\mid B) = \\frac{P(B \\mid A)\\,P(A)}{P(B)}')],

// chem (in chemInsertable.ts)
example: () => [
  p('Type a SMILES string and get a structure. Double-click it to open the draw editor.'),
  chem('CN1C=NC2=C1C(=O)N(C(=O)N2C)C', 'Caffeine'),
],

// table
example: () => [
  table(
    ['Sort', 'Worst case', 'Stable'],
    [
      [['Merge sort'], ['O(n log n)'], ['yes']],
      [['Quicksort'], ['O(n²)'], ['no']],
    ],
  ),
],

// callout
example: () => [callout('💡', 'info', [p('A callout, for the thing you must not forget.')])],

// columns-2
example: () => [columns([[p('Two columns.')], [p('Side by side.')]])],

// columns-3
example: () => [columns([[p('Three columns.')], [p('For comparing.')], [p('Three things.')]])],

// code
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
```

`chemInsertable.ts` declares its `InsertItem` locally (it typechecks standalone). Add the same optional `example?: () => Record<string, unknown>[]` field to that local interface, and import `chem` and `p` from `../../docBuilders` there.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test -w web -- insertables`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add web/src/features/editor/insertables.ts \
        web/src/features/editor/insertables.test.ts \
        web/src/features/editor/nodes/chem/chemInsertable.ts
git commit -m "feat(editor): every insertable carries its own README demo"
```

---

### Task 6: The builder

**Files:**
- Create: `web/src/features/readme/buildReadme.ts`
- Create: `web/src/features/readme/buildReadme.test.ts`

**Interfaces:**
- Consumes: `docBuilders` (Task 1), `shortcutData` (Task 2), `paletteCatalog` (Task 3), `featureCatalog` (Task 4), `INSERT_ITEMS`/`NO_DEMO` (Task 5), `INSERT_SECTIONS`, and `guestBlockedMessage`.
- Produces:

```ts
export interface ReadmeDoc {
  title: string;
  tags: string[];
  contentJson: Record<string, unknown>;
  contentText: string;
}
export const README_TITLE = 'README';
export function buildReadme(opts: { guest: boolean }): ReadmeDoc;
```

- [ ] **Step 1: Write the failing test**

Create `web/src/features/readme/buildReadme.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { README_TITLE, buildReadme } from './buildReadme';
import { INSERT_ITEMS, NO_DEMO } from '../editor/insertables';
import { PALETTE_CATALOG } from '../../components/paletteCatalog';
import { shortcutGroups } from '../editor/shortcutData';
import { FEATURE_SECTIONS } from './featureCatalog';

/** Every node type buildExtensions.ts registers. A type outside this set renders as
 *  nothing in the editor, which is invisible in the JSON and obvious on screen. */
const SCHEMA_TYPES = new Set([
  'doc', 'paragraph', 'text', 'heading', 'bulletList', 'orderedList', 'listItem',
  'taskList', 'taskItem', 'blockquote', 'codeBlock', 'horizontalRule', 'hardBreak',
  'table', 'tableRow', 'tableHeader', 'tableCell', 'image', 'callout', 'details',
  'detailsSummary', 'detailsContent', 'columnList', 'column', 'chem', 'model3d',
  'sketch', 'wikilink', 'inlineMath', 'blockMath',
]);

function typesIn(node: Record<string, unknown>, seen = new Set<string>()): Set<string> {
  if (typeof node?.type === 'string') seen.add(node.type);
  for (const child of (node?.content as Record<string, unknown>[] | undefined) ?? []) {
    typesIn(child, seen);
  }
  return seen;
}

describe('buildReadme', () => {
  const account = buildReadme({ guest: false });
  const guest = buildReadme({ guest: true });

  it('is titled README and tagged', () => {
    expect(account.title).toBe(README_TITLE);
    expect(account.tags).toEqual(['unote', 'guide']);
  });

  it('emits a doc whose every node type the editor can render', () => {
    for (const doc of [account, guest]) {
      for (const type of typesIn(doc.contentJson)) {
        expect(SCHEMA_TYPES.has(type), `unknown node type: ${type}`).toBe(true);
      }
    }
  });

  it('documents every insert block', () => {
    for (const item of INSERT_ITEMS) {
      expect(account.contentText, `missing block: ${item.title}`).toContain(item.title);
    }
  });

  it('gives a reason for each block it does not demonstrate', () => {
    for (const [, reason] of Object.entries(NO_DEMO)) {
      expect(account.contentText).toContain(reason);
    }
  });

  it('documents every palette command', () => {
    for (const cmd of PALETTE_CATALOG) {
      expect(account.contentText, `missing command: ${cmd.title}`).toContain(cmd.title);
    }
  });

  it('documents every keyboard shortcut', () => {
    for (const group of shortcutGroups('Ctrl', 'Shift')) {
      for (const row of group.rows) {
        expect(account.contentText, `missing binding: ${row.label}`).toContain(row.label);
      }
    }
  });

  it('documents every feature section', () => {
    for (const section of FEATURE_SECTIONS) {
      expect(account.contentText).toContain(section.title);
      for (const line of section.lines) expect(account.contentText).toContain(line.what);
    }
  });

  it('actually uses the blocks it documents', () => {
    const types = typesIn(account.contentJson);
    for (const type of ['callout', 'columnList', 'details', 'taskList', 'table',
                        'blockquote', 'codeBlock', 'horizontalRule', 'inlineMath',
                        'blockMath', 'chem']) {
      expect(types.has(type), `README does not contain a ${type}`).toBe(true);
    }
  });

  it('never embeds a demo for a block that needs an upload', () => {
    const types = typesIn(guest.contentJson);
    expect(types.has('image')).toBe(false);
    expect(types.has('model3d')).toBe(false);
    expect(types.has('sketch')).toBe(false);
  });

  it('warns the guest build about the three silent differences', () => {
    expect(guest.contentText).toMatch(/backlink/i);
    expect(guest.contentText).toMatch(/this browser/i);
    // Search operators are account-only; the guest build must not present them as usable.
    expect(guest.contentText).not.toContain('notebook:algorithms');
    expect(account.contentText).toContain('notebook:algorithms');
  });

  it('marks account-only features for a guest and not for an account', () => {
    expect(guest.contentText).toContain('needs an account');
    expect(account.contentText).not.toContain('needs an account');
  });

  it('produces plain text that matches the document', () => {
    expect(account.contentText.length).toBeGreaterThan(500);
    expect(account.contentText).toContain('README');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w web -- buildReadme`
Expected: FAIL — `Failed to resolve import "./buildReadme"`.

- [ ] **Step 3: Implement the builder**

Create `web/src/features/readme/buildReadme.ts`:

```ts
// The README note, generated.
//
// Reads five sources and emits one TipTap document:
//   INSERT_ITEMS + INSERT_SECTIONS  (editor/insertables.ts)   - section 02
//   PALETTE_CATALOG                 (components/paletteCatalog) - section 04
//   shortcutGroups()                (editor/shortcutData.ts)  - section 04
//   FEATURE_SECTIONS                (./featureCatalog.ts)     - sections 05-09
//   BLOCKED                         (guest/guestApi.ts)       - every account-only mark
//
// TipTap JSON rather than Markdown, deliberately: callouts, columns, toggles, chem and
// math have no Markdown spelling, and this note is built out of the blocks it documents.
// Markdown remains the export format.
// Only what this file uses: the demos for math, code and chem come from each block's own
// `example`, not from here.
import {
  bullets, callout, codeText, columns, divider, doc, h,
  p, quote, table, todo, toggle, toPlainText, type Inline, type Node,
} from '../editor/docBuilders';
import { INSERT_ITEMS, INSERT_SECTIONS, NO_DEMO, type InsertItem } from '../editor/insertables';
import { PALETTE_CATALOG } from '../../components/paletteCatalog';
import { SHORTCUT_COUNT, shortcutGroups } from '../editor/shortcutData';
import { FEATURE_SECTIONS } from './featureCatalog';
import { guestBlockedMessage } from '../guest/guestApi';

export const README_TITLE = 'README';
const README_TAGS = ['unote', 'guide'];

export interface ReadmeDoc {
  title: string;
  tags: string[];
  contentJson: Record<string, unknown>;
  contentText: string;
}

const GATE = 'needs an account';

/** The generic fallback guestBlockedMessage returns for a method it does not know. Used
 *  to tell "genuinely blocked" apart from "unrecognised method name". */
const GENERIC_BLOCK = guestBlockedMessage('__unknown__');

function isGated(method: string | undefined): boolean {
  if (!method) return false;
  return guestBlockedMessage(method) !== GENERIC_BLOCK;
}

/** The trailing cell of a reference row: a gate mark for a guest, empty otherwise. */
function gateCell(guest: boolean, method: string | undefined): Inline[] {
  return guest && isGated(method) ? [GATE] : [];
}

/** Which api method an insert block ultimately needs. Only the gated ones appear. */
const BLOCK_NEEDS: Record<string, string> = {
  image: 'uploadImage',
  model3d: 'uploadImportFile',
  'canvas-snapshot': 'createCanvasItem',
};

function insertRows(guest: boolean, items: InsertItem[]): Inline[][][] {
  return items.map((item) => {
    const note = item.example ? '' : (NO_DEMO[item.id] ?? '');
    const gate = gateCell(guest, BLOCK_NEEDS[item.id]);
    const trailing = gate.length > 0 ? gate : [note];
    return [[codeText(`/${item.title.toLowerCase()}`)], [item.description], trailing];
  });
}

function insertSection(guest: boolean): Node[] {
  const out: Node[] = [
    h(2, '02 · Everything you can insert'),
    p('Type ', codeText('/'), ' and the name, or use the ', codeText('+'), ' in the left margin.'),
  ];

  for (const section of INSERT_SECTIONS) {
    const items = INSERT_ITEMS.filter((i) => i.section === section);
    if (items.length === 0) continue;

    out.push(
      toggle(`${section} — ${items.length} block${items.length === 1 ? '' : 's'}`, [
        table(['Command', 'Inserts', ''], insertRows(guest, items)),
      ]),
    );

    // The demos themselves, after the reference table for that group. A block that
    // needs an upload contributes nothing here - its row already carries the reason.
    for (const item of items) {
      if (!item.example) continue;
      if (guest && isGated(BLOCK_NEEDS[item.id])) continue;
      out.push(...item.example());
    }
  }
  return out;
}

function writeSection(): Node[] {
  return [
    h(2, '01 · Write'),
    p('Markdown works as you type. Start a line with any of these and it becomes the thing:'),
    columns([
      [
        p('Type this'),
        p(codeText('# '), ' ', codeText('## '), ' ', codeText('### ')),
        p(codeText('- '), ' then Tab to nest'),
        p(codeText('1. ')),
        p(codeText('> ')),
        p(codeText('```')),
      ],
      [
        p('Get this'),
        p('Headings, three levels'),
        p('A bullet list'),
        p('A numbered list'),
        p('A quote'),
        p('A code block'),
      ],
    ]),
    p('That two-column layout is itself a block. Marks are the usual ones: Ctrl+B bold, Ctrl+I italic, Ctrl+U underline, Ctrl+E inline code.'),
    quote('Use a quote for the sentence from the lecture you want to argue with later.'),
  ];
}

function connectSection(guest: boolean): Node[] {
  const backlinks = guest
    ? 'Backlinks arrive with an account: without one there is no server to work out what points here.'
    : 'Every note lists its backlinks, so you can find the notes pointing at this one.';
  return [
    h(2, '03 · Connect'),
    columns([
      [p('Link'), p('Type ', codeText('[['), ' and pick a note. It becomes a real link, not text.')],
      [p('Tag'), p('Write ', codeText('#revision'), ' anywhere in a sentence and the note files itself under it.')],
      [p('Come back'), p(backlinks)],
    ]),
  ];
}

function findSection(guest: boolean): Node[] {
  const keyCol: Node[] = [p('Keys worth learning')];
  for (const group of shortcutGroups('Ctrl', 'Shift')) {
    keyCol.push(p(group.name));
    for (const row of group.rows) {
      keyCol.push(p(codeText(row.keys.join(' + ')), ' — ', row.label));
    }
  }

  const searchCol: Node[] = [p('Search understands')];
  if (guest) {
    searchCol.push(
      p('Search matches any note containing what you type.'),
      p('Operators like ', codeText('tag:'), ' and ', codeText('-exclude'), ' ', GATE, '.'),
    );
  } else {
    searchCol.push(
      p(codeText('tag:revision'), ' — only that tag'),
      p(codeText('notebook:algorithms'), ' — only that notebook'),
      p(codeText('"decision tree"'), ' — that exact phrase'),
      p(codeText('-quicksort'), ' — everything but'),
    );
  }

  const commandRows: Inline[][][] = PALETTE_CATALOG.map((cmd) => [
    [cmd.title],
    [cmd.hint],
    gateCell(guest, cmd.needs),
  ]);

  return [
    h(2, '04 · Find'),
    p('Press ', codeText('Ctrl+P'), ' to run any command, or ', codeText('?'), ` for all ${SHORTCUT_COUNT} bindings.`),
    columns([keyCol, searchCol]),
    toggle(`Every command in the palette — ${PALETTE_CATALOG.length}`, [
      table(['Command', 'Does', ''], commandRows),
    ]),
  ];
}

function featureSections(guest: boolean): Node[] {
  const out: Node[] = [];
  for (const section of FEATURE_SECTIONS) {
    out.push(h(2, `${section.number} · ${section.title}`), p(section.blurb));
    out.push(
      bullets(
        section.lines.map((line): Inline[] =>
          guest && isGated(line.needs) ? [line.what, ` — ${GATE}`] : [line.what],
        ),
      ),
    );
  }
  return out;
}

function closing(guest: boolean): Node[] {
  if (guest) {
    return [
      callout('🔑', 'warn', [
        p('You are trying Unote without an account. Everything above works and stays in this browser — nothing is sent anywhere, and nothing survives clearing your browser data.'),
        p('Boards, flashcards, images, imports, AI and sharing need a server. Make an account and they turn on, with these notes carried over.'),
      ]),
    ];
  }
  return [
    callout('✓', 'ok', [
      p('That is the whole tool. Press ', codeText('Ctrl+P'), ' and pick "Open the guide" to get this note back at any time.'),
    ]),
  ];
}

export function buildReadme(opts: { guest: boolean }): ReadmeDoc {
  const { guest } = opts;

  const content: Node[] = [
    p('Unote is a place to write, link and revise. This note is the short version of everything it does — and it is built out of the blocks it describes, so you are already looking at most of them. It is an ordinary note: edit it, take it apart, delete it.'),
    callout('💡', 'info', [
      p('Put your cursor on any empty line and press ', codeText('/'), `. That one key reaches all ${INSERT_ITEMS.length} blocks below.`),
    ]),
    divider(),
    ...writeSection(),
    todo([
      { checked: true, content: ['Read this far'] },
      { checked: false, content: ['Press ', codeText('/'), ' on an empty line and insert a callout'] },
      { checked: false, content: ['Type ', codeText('[['), ' and link this note to a new one'] },
      { checked: false, content: ['Press ', codeText('Ctrl+K'), ' and come back here by name'] },
    ]),
    divider(),
    ...insertSection(guest),
    divider(),
    ...connectSection(guest),
    divider(),
    ...findSection(guest),
    divider(),
    ...featureSections(guest),
    divider(),
    ...closing(guest),
  ];

  const contentJson = doc([h(1, README_TITLE), ...content]);
  return {
    title: README_TITLE,
    tags: README_TAGS,
    contentJson,
    contentText: toPlainText(contentJson),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w web -- buildReadme`
Expected: PASS, 12 tests.

If the "documents every insert block" test fails on a block whose title differs from its slash command (for example `Heading 1`), the fix is in `insertRows` — print the title in its own cell rather than only the lower-cased command form. Do not weaken the assertion.

- [ ] **Step 5: Commit**

```bash
git add web/src/features/readme/buildReadme.ts \
        web/src/features/readme/buildReadme.test.ts
git commit -m "feat(readme): generate the README note from the app's own registries"
```

---

### Task 7: Seed it for guests

`seedGuestWorkspace()` (`guestStore.ts:292`) currently creates a notebook and one empty note. It now writes the README first, pinned, and returns its id so `/try` can open it on the first visit only.

**Files:**
- Modify: `web/src/features/guest/guestStore.ts:292-296`
- Modify: `web/src/features/guest/guestMode.ts` (thread the new id through `startGuest`)
- Modify: `web/src/features/guest/TryRoute.tsx:24-25`
- Create: `web/src/features/guest/guestStore.test.ts`

**Interfaces:**
- Consumes: `buildReadme` (Task 6).
- Produces: `seedGuestWorkspace(): { notebook, note, readme }`, and `startGuest()` gains `readmeId: string | null` — non-null only on the call that seeded.

- [ ] **Step 1: Write the failing test**

Create `web/src/features/guest/guestStore.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { clearData, readData, seedGuestWorkspace } from './guestStore';

describe('seedGuestWorkspace', () => {
  beforeEach(() => clearData());

  it('creates one notebook and two notes', () => {
    seedGuestWorkspace();
    const data = readData();
    expect(data.notebooks).toHaveLength(1);
    expect(data.notes).toHaveLength(2);
  });

  it('writes the README first, pinned and tagged', () => {
    const { readme } = seedGuestWorkspace();
    const stored = readData().notes[0];
    expect(stored.id).toBe(readme.id);
    expect(stored.title).toBe('README');
    expect(stored.pinned).toBe(true);
    expect(stored.tags).toEqual(['unote', 'guide']);
  });

  it('leaves a blank note to type into, after the README', () => {
    const { note } = seedGuestWorkspace();
    const stored = readData().notes[1];
    expect(stored.id).toBe(note.id);
    expect(stored.title).toBe('');
  });

  it('seeds the guest build of the README, not the account build', () => {
    seedGuestWorkspace();
    expect(readData().notes[0].contentText).toContain('needs an account');
  });

  it('gives the README searchable body text', () => {
    seedGuestWorkspace();
    expect(readData().notes[0].contentText.length).toBeGreaterThan(500);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w web -- guestStore`
Expected: FAIL — `seedGuestWorkspace` returns no `readme`.

- [ ] **Step 3: Seed the README**

In `web/src/features/guest/guestStore.ts`, add the import at the top:

```ts
import { buildReadme } from '../readme/buildReadme';
```

Replace `seedGuestWorkspace` (lines 292–296) with:

```ts
/**
 * Seed the store so "try it" lands on a page someone can type into rather than an empty
 * shell with a "create a notebook first" error waiting behind every control.
 *
 * The README goes in FIRST and pinned, so it sits at the top of the sidebar and the
 * dashboard - and the blank note is created second, so `latestNoteId()` returns the blank
 * one on every return visit. A guest who has read the guide once should land back on
 * their own work, not on documentation.
 */
export function seedGuestWorkspace(): { notebook: GuestNotebook; note: GuestNote; readme: GuestNote } {
  const notebook = createNotebook({ name: 'My notes', emoji: '📓', color: '#2563eb' });

  const built = buildReadme({ guest: true });
  const readme = createNote({
    notebookId: notebook.id,
    title: built.title,
    contentJson: built.contentJson,
    contentText: built.contentText,
    tags: built.tags,
  });
  updateNote(readme.id, { pinned: true });

  const note = createNote({ notebookId: notebook.id });
  return { notebook, note, readme: { ...readme, pinned: true } };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w web -- guestStore`
Expected: PASS, 5 tests.

- [ ] **Step 5: Open the README on the first visit only**

Replace `startGuest()` in `web/src/features/guest/guestMode.ts` (lines 46–63) with the version below. `readmeId` is non-null only on the call that actually seeded, so a returning guest gets `null` and falls through to their own last note:

```ts
export function startGuest(): { noteId: string | null; readmeId: string | null } {
  try {
    localStorage.setItem(ACTIVE_KEY, '1');
  } catch {
    return { noteId: null, readmeId: null };
  }
  active = true;
  // Non-null only when this call seeded. A visitor who has been here before keeps their
  // own landing note, and does not get shown the guide again.
  let readmeId: string | null = null;
  if (!hasGuestWork()) {
    try {
      readmeId = seedGuestWorkspace().readme.id;
    } catch {
      // Storage filled between the probe and the write. The shell still opens; the
      // dashboard's empty state is a survivable landing.
    }
  }
  emit();
  return { noteId: latestNoteId(), readmeId };
}
```

Then in `web/src/features/guest/TryRoute.tsx`, replace lines 24–25:

```ts
    // First visit lands on the README; every later visit picks up the last note worked on.
    const { noteId, readmeId } = startGuest();
    const target = readmeId ?? noteId;
    setTarget(target ? `/note/${target}` : '/');
```

- [ ] **Step 6: Verify the whole flow builds and the guest suite still passes**

Run: `npm run build -w web`
Expected: build succeeds.

Run: `npx playwright test e2e/guest.spec.ts`
Expected: PASS. The load-bearing network assertion in that spec must still hold — the README is built and stored entirely in the browser, so it adds no request.

- [ ] **Step 7: Commit**

```bash
git add web/src/features/guest/guestStore.ts \
        web/src/features/guest/guestStore.test.ts \
        web/src/features/guest/guestMode.ts \
        web/src/features/guest/TryRoute.tsx
git commit -m "feat(guest): seed the README as a guest's first note"
```

---

### Task 8: Seed it for accounts, and add "Open the guide"

**Files:**
- Create: `web/src/features/readme/ensureReadme.ts`
- Create: `web/src/features/readme/ensureReadme.test.ts`
- Modify: `web/src/features/onboarding/OnboardingHost.tsx:51-57`
- Modify: `web/src/lib/commands.ts:128-208`

**Interfaces:**
- Consumes: `buildReadme` (Task 6), `api` from `web/src/lib/api`.
- Produces: `ensureReadme(): Promise<string | null>` — the note id, or `null` when it could not be created. Idempotent.

- [ ] **Step 1: Write the failing test**

Create `web/src/features/readme/ensureReadme.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const notebooks = vi.fn();
const notes = vi.fn();
const createNote = vi.fn();
const updateNote = vi.fn();

vi.mock('../../lib/api', () => ({
  api: {
    notebooks: () => notebooks(),
    notes: (q: unknown) => notes(q),
    createNote: (b: unknown) => createNote(b),
    updateNote: (id: string, b: unknown) => updateNote(id, b),
  },
}));

const { ensureReadme } = await import('./ensureReadme');

describe('ensureReadme', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    notebooks.mockResolvedValue({ notebooks: [{ id: 'nb1', name: 'My notes' }] });
    notes.mockResolvedValue({ notes: [], total: 0 });
    createNote.mockResolvedValue({ note: { id: 'n1' } });
    updateNote.mockResolvedValue({ note: { id: 'n1' } });
  });

  it('creates the account build of the README, pinned', async () => {
    const id = await ensureReadme();
    expect(id).toBe('n1');
    const body = createNote.mock.calls[0][0];
    expect(body.title).toBe('README');
    expect(body.notebookId).toBe('nb1');
    expect(body.contentText).not.toContain('needs an account');
    expect(updateNote).toHaveBeenCalledWith('n1', { pinned: true });
  });

  it('returns the existing note and writes nothing when one is already there', async () => {
    notes.mockResolvedValue({ notes: [{ id: 'existing', title: 'README' }], total: 1 });
    expect(await ensureReadme()).toBe('existing');
    expect(createNote).not.toHaveBeenCalled();
  });

  it('ignores a note whose title merely contains README', async () => {
    notes.mockResolvedValue({ notes: [{ id: 'x', title: 'README notes from 2024' }], total: 1 });
    await ensureReadme();
    expect(createNote).toHaveBeenCalled();
  });

  it('returns null rather than throwing when there is no notebook', async () => {
    notebooks.mockResolvedValue({ notebooks: [] });
    expect(await ensureReadme()).toBeNull();
    expect(createNote).not.toHaveBeenCalled();
  });

  it('returns null rather than throwing when the API fails', async () => {
    createNote.mockRejectedValue(new Error('offline'));
    expect(await ensureReadme()).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w web -- ensureReadme`
Expected: FAIL — `Failed to resolve import "./ensureReadme"`.

- [ ] **Step 3: Implement it**

Create `web/src/features/readme/ensureReadme.ts`:

```ts
// Create the README note for an account, at most once.
//
// Two guards, because one is not enough. The onboarding record is per-browser
// localStorage, so it would let a second device create a second README; and a title
// search alone would re-create the note for someone who deliberately deleted theirs on
// every page load. OnboardingHost supplies the first guard (status 'unseen'), this
// module supplies the second.
//
// Every failure path returns null rather than throwing. This runs on first login, next
// to the tutorial - a network blip must not take the app down, and a student who never
// sees the guide has lost a convenience, not their notes.
import { api } from '../../lib/api';
import { README_TITLE, buildReadme } from './buildReadme';

export async function ensureReadme(): Promise<string | null> {
  try {
    const { notes } = await api.notes({ limit: 200 });
    const existing = notes.find((n) => n.title === README_TITLE);
    if (existing) return existing.id;

    const { notebooks } = await api.notebooks();
    const target = notebooks.find((n) => !n.archived) ?? notebooks[0];
    if (!target) return null;

    const built = buildReadme({ guest: false });
    const { note } = await api.createNote({
      notebookId: target.id,
      title: built.title,
      contentJson: built.contentJson,
      contentText: built.contentText,
      tags: built.tags,
    });
    await api.updateNote(note.id, { pinned: true });
    return note.id;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w web -- ensureReadme`
Expected: PASS, 5 tests.

- [ ] **Step 5: Call it before the tour**

In `web/src/features/onboarding/OnboardingHost.tsx`, add the import:

```ts
import { ensureReadme } from '../readme/ensureReadme';
```

Then extend the auto-open effect (lines 51–57). It already refuses to run during a guest handover, which is exactly the condition the README needs too — a guest who signs up brings their own migrated README, and creating a second while their work is mid-flight is the ambush that check exists to prevent:

```ts
  useEffect(() => {
    if (!user || autoOpened.current) return;
    if (handoverPending) return;
    if (getOnboarding().status !== 'unseen') return;
    autoOpened.current = true;
    // Fire and forget: the tutorial must not wait on a network round-trip, and
    // ensureReadme swallows its own failures.
    void ensureReadme();
    openTour(-1);
  }, [user, openTour, handoverPending]);
```

- [ ] **Step 6: Add the palette command**

In `web/src/lib/commands.ts`, add the import:

```ts
import { ensureReadme } from '../features/readme/ensureReadme';
```

Then add this command to the `registerCommands([...])` array, immediately before `help-shortcuts`:

```ts
  {
    id: 'help-guide',
    title: 'Open the guide',
    section: 'Help',
    hint: 'The README: every command, in one note',
    keywords: ['readme', 'docs', 'documentation', 'guide', 'help', 'commands', 'manual'],
    icon: 'info',
    run: async (ctx) => {
      const id = await ensureReadme();
      if (id) ctx.navigate(`/note/${id}`);
    },
  },
```

- [ ] **Step 7: Verify**

Run: `npm run test -w web`
Expected: PASS, all suites.

Run: `npm run build -w web`
Expected: build succeeds.

- [ ] **Step 8: Commit**

```bash
git add web/src/features/readme/ensureReadme.ts \
        web/src/features/readme/ensureReadme.test.ts \
        web/src/features/onboarding/OnboardingHost.tsx \
        web/src/lib/commands.ts
git commit -m "feat(readme): seed the guide for new accounts, and add Open the guide"
```

---

### Task 9: Prove it renders

Every check so far asserts on JSON. This repo's standing lesson is that a green count is not evidence — a capture harness once reported "78 screenshots, 0 failed" when all 78 were the login form. This task reads the rendered page.

**Files:**
- Modify: `e2e/guest.spec.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

Append to `e2e/guest.spec.ts`:

```ts
/**
 * A guest's first screen is the README, and it must RENDER - not merely exist as JSON.
 *
 * Asserting the doc contains a `chem` node proves nothing about whether a molecule
 * appears. Each assertion below reads something only a working node view produces: the
 * KaTeX span, the smiles-drawer canvas, an open toggle.
 */
test('a guest lands on a README that renders its own blocks', async ({ page }) => {
  await page.goto('/try');
  await expect(page.getByRole('heading', { name: 'README', level: 1 })).toBeVisible();

  // Live blocks, each read from what its node view actually emits.
  await expect(page.locator('.katex').first()).toBeVisible();
  await expect(page.locator('.folio-details').first()).toBeVisible();
  await expect(page.locator('[data-tone="info"]').first()).toBeVisible();
  await expect(page.locator('table').first()).toBeVisible();
  await expect(page.getByRole('checkbox').first()).toBeVisible();

  // The chemistry block draws to a canvas once smiles-drawer has run.
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15_000 });

  // Every insert block is named somewhere in the note. Toggles are `persist: true`
  // details elements, so their content is in the DOM whether or not they are open.
  const body = await page.locator('.ProseMirror').innerText();
  for (const name of ['Callout', 'Table', 'Code block', 'Chemistry structure', '3D model']) {
    expect(body, `README does not mention ${name}`).toContain(name);
  }

  // The guest build is honest about what it cannot do.
  expect(body).toContain('needs an account');
});

test('a guest returning to /try lands on their own work, not the guide', async ({ page }) => {
  await page.goto('/try');
  await expect(page.getByRole('heading', { name: 'README', level: 1 })).toBeVisible();

  // Type into the blank note so it becomes the most recently updated.
  await page.goto('/');
  await page.getByRole('link', { name: /untitled/i }).first().click();
  await page.locator('.ProseMirror').first().click();
  await page.keyboard.type('my own note');

  await page.goto('/try');
  await expect(page.locator('.ProseMirror').first()).toContainText('my own note');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx playwright test e2e/guest.spec.ts -g "renders its own blocks" --workers=1`
Expected: FAIL before Tasks 6–7 land.

If the run dies with "port already in use" or ECONNREFUSED, a previous Playwright run left ports 4796/5196 occupied. Kill the listeners first, and prefer `--workers=1` locally.

- [ ] **Step 3: Run the full guest suite**

Run: `npx playwright test e2e/guest.spec.ts --workers=1`
Expected: PASS, including the pre-existing network assertion that guest mode writes nothing to the server.

- [ ] **Step 4: Run everything**

```bash
npm run test -w web
npm run test -w server
npm run build -w web
npm run e2e
```

Expected: all pass. `npm run e2e` needs the one-off `folio_e2e` Postgres database (see `playwright.config.ts`).

- [ ] **Step 5: Commit**

```bash
git add e2e/guest.spec.ts
git commit -m "test(e2e): assert the guest README renders its own blocks"
```

---

## Manual verification

After Task 9, check the two things no test can judge:

1. **Open `/try` in a real browser.** Read the note top to bottom. It should read as documentation someone would keep, not as a generated dump. The equation should be typeset, the molecule drawn, the toggles shut by default.
2. **Sign up from that guest session.** Confirm the migrated README comes across and a second one is *not* created — the handover guard is the one path with no automated coverage, because it depends on migration timing.
