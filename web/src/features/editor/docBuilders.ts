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
