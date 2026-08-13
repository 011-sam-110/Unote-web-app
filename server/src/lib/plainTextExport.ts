// TipTap JSON -> readable plain text, for GET /api/notes/:id/export?format=text
//
// NOT "the Markdown with the syntax stripped". That approach loses the information the
// syntax was carrying: `- ` becomes nothing, so a list turns into a run of sentences, and
// `| a | b |` becomes "a b" with no column left. A .txt file is often the one someone
// pastes into an email or a form, so the shape has to survive even though the notation
// does not.
//
// Shares the TTNode shape with export.ts (the Markdown renderer) rather than redefining it.

import type { TTNode } from './export.js';

const BULLET = '•';

function inlineText(nodes: TTNode[] = []): string {
  return nodes.map(inlineNode).join('');
}

function inlineNode(n: TTNode): string {
  if (n.type === 'text') return n.text ?? '';
  if (n.type === 'wikilink' || n.type === 'wikiLink') {
    return String(n.attrs?.title ?? n.attrs?.label ?? n.attrs?.id ?? '');
  }
  if (n.type === 'hardBreak') return '\n';
  if (n.type === 'mention') return `@${String(n.attrs?.label ?? n.attrs?.id ?? '')}`;
  if (n.content) return inlineText(n.content);
  return '';
}

function indent(text: string, depth: number): string {
  if (!text) return text;
  const pad = '    '.repeat(depth);
  return text
    .split('\n')
    .map(line => (line ? pad + line : line))
    .join('\n');
}

function renderList(node: TTNode, depth: number, ordered: boolean, task: boolean): string {
  const items = node.content ?? [];
  const start = typeof node.attrs?.start === 'number' ? (node.attrs.start as number) : 1;
  const lines: string[] = [];

  items.forEach((item, i) => {
    const checked = Boolean(item.attrs?.checked);
    // A task keeps its box: "did I do this" is the whole content of a checklist, and it is
    // the one piece of structure that cannot be inferred from the text.
    const marker = task ? `[${checked ? 'x' : ' '}]` : ordered ? `${start + i}.` : BULLET;
    const [first, ...rest] = item.content ?? [];
    lines.push(indent(`${marker} ${first ? inlineText(first.content) : ''}`.trimEnd(), depth));

    for (const child of rest) {
      const rendered = renderBlock(child, depth + 1);
      if (rendered) lines.push(rendered);
    }
  });

  return lines.join('\n');
}

/**
 * A table as aligned columns.
 *
 * Padded to the widest cell per column, because the alternative - cells separated by a
 * space or a pipe - is unreadable the moment any cell is longer than a word, and a table
 * is the structure most likely to be the reason someone exported at all.
 */
function renderTable(node: TTNode): string {
  const rows = (node.content ?? []).map(row =>
    (row.content ?? []).map(cell =>
      (cell.content ?? [])
        .map(b => inlineText(b.content))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    ),
  );
  if (!rows.length) return '';

  const columns = Math.max(...rows.map(r => r.length));
  for (const row of rows) while (row.length < columns) row.push('');

  const widths: number[] = [];
  for (let c = 0; c < columns; c++) {
    widths.push(Math.max(...rows.map(r => r[c].length)));
  }

  return rows
    .map(row => row.map((cell, c) => (c === columns - 1 ? cell : cell.padEnd(widths[c]))).join('  ').trimEnd())
    .join('\n');
}

function renderBlock(node: TTNode, depth: number): string {
  switch (node.type) {
    case 'paragraph':
      return indent(inlineText(node.content), depth);

    case 'heading': {
      // Underlined rather than prefixed with hashes: in a plain text file an underline IS
      // how a heading is conventionally written, and it survives being pasted anywhere.
      const text = inlineText(node.content);
      if (!text) return '';
      const level = Math.min(Math.max(Number(node.attrs?.level) || 1, 1), 6);
      const rule = (level === 1 ? '=' : '-').repeat(Math.min(text.length, 72));
      return indent(level <= 2 ? `${text}\n${rule}` : text.toUpperCase(), depth);
    }

    case 'bulletList':
      return renderList(node, depth, false, false);
    case 'orderedList':
      return renderList(node, depth, true, false);
    case 'taskList':
      return renderList(node, depth, false, true);

    case 'blockquote': {
      const inner = (node.content ?? []).map(c => renderBlock(c, 0)).join('\n\n');
      return indent(
        inner
          .split('\n')
          .map(l => (l ? `| ${l}` : '|'))
          .join('\n'),
        depth,
      );
    }

    case 'codeBlock':
      return indent((node.content ?? []).map(c => c.text ?? '').join(''), depth + 1);

    case 'horizontalRule':
      return indent('-'.repeat(48), depth);

    case 'image': {
      const alt = String(node.attrs?.alt ?? '').trim();
      return indent(alt ? `[image: ${alt}]` : '[image]', depth);
    }

    case 'table':
      return indent(renderTable(node), depth);

    case 'callout': {
      const kind = String(node.attrs?.kind ?? node.attrs?.type ?? 'note').toUpperCase();
      const inner = (node.content ?? []).map(c => renderBlock(c, 0)).join('\n\n');
      return indent(`${kind}: ${inner}`, depth);
    }

    case 'details': {
      const children = node.content ?? [];
      const summary = children.find(c => c.type === 'detailsSummary');
      const body = children.find(c => c.type === 'detailsContent');
      const head = summary ? inlineText(summary.content) : 'Details';
      const inner = body ? (body.content ?? []).map(c => renderBlock(c, 0)).join('\n\n') : '';
      return indent(`${head}\n${indent(inner, 1)}`, depth);
    }

    // The four that plain text genuinely cannot hold. Named individually rather than
    // dropped, so a reader can tell something was there - see docx.ts for the same rule.
    case 'chem':
      return indent('[chemical structure - open the note to view]', depth);
    case 'model3d':
      return indent('[3D model - open the note to view]', depth);
    case 'sketch':
      return indent('[drawing - open the note to view]', depth);

    default:
      if (node.content) return node.content.map(c => renderBlock(c, depth)).join('\n\n');
      return '';
  }
}

export function tiptapToPlainText(doc: TTNode | null | undefined): string {
  if (!doc || !Array.isArray(doc.content)) return '';
  const body = doc.content
    .map(n => renderBlock(n, 0))
    .filter(block => block.trim() !== '')
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // An empty note is an empty file. Appending the trailing newline unconditionally gave a
  // one-byte .txt containing nothing but a line break, which looks like a failed export.
  return body ? body + '\n' : '';
}
