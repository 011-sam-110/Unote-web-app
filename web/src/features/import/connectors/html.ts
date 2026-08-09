// HTML -> Markdown, for the one source that has no better format on offer.
//
// "Download as HTML" and Google Takeout both hand back Google Docs as HTML, and a Doc's
// structure (headings, lists, tables) is real markup, so it survives the trip. Its
// EMPHASIS does not: Google emits `<span class="c3">` and puts `font-weight:700` in a
// stylesheet at the top of the file, so a converter that only looks for <strong> and <em>
// silently flattens every bold word in the document. Hence the small stylesheet pass
// below - it is about twenty lines and it is the difference between an imported essay
// keeping its emphasis and losing it.
//
// Deliberately not a general-purpose HTML-to-markdown library: this only has to be right
// for exported word-processor documents, and a dependency that handles arbitrary web
// pages would be far more code for output nobody would notice.

interface StyleFlags {
  bold: Set<string>;
  italic: Set<string>;
}

/** Class names a document's own <style> block declares bold or italic. */
export function classStyleFlags(doc: Document): StyleFlags {
  const bold = new Set<string>();
  const italic = new Set<string>();
  for (const style of Array.from(doc.querySelectorAll('style'))) {
    const css = style.textContent ?? '';
    // One rule at a time: `.c3{font-weight:700;color:#000}`. Selectors with more than a
    // single class are skipped rather than guessed at.
    for (const match of css.matchAll(/\.([A-Za-z0-9_-]+)\s*\{([^}]*)\}/g)) {
      const [, name, body] = match;
      const weight = body.match(/font-weight\s*:\s*([a-z0-9]+)/i)?.[1];
      if (weight && (weight === 'bold' || Number(weight) >= 600)) bold.add(name);
      if (/font-style\s*:\s*italic/i.test(body)) italic.add(name);
    }
  }
  return { bold, italic };
}

function classesOf(el: Element): string[] {
  return (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
}

function escapeInline(text: string): string {
  // Only the characters that would otherwise turn body text into markdown syntax. Escaping
  // more (parentheses, dots, hyphens) makes clean prose look like it has been through a
  // machine, which is exactly the impression an import should not leave.
  return text.replace(/([\\`*_[\]])/g, '\\$1');
}

function collapse(text: string): string {
  return text.replace(/ /g, ' ').replace(/\s+/g, ' ');
}

/** Inline content of one block element, with emphasis and links preserved. */
function inlineOf(node: Node, flags: StyleFlags, active = { bold: false, italic: false }): string {
  if (node.nodeType === 3 /* text */) return escapeInline(collapse(node.nodeValue ?? ''));
  if (node.nodeType !== 1 /* element */) return '';

  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (tag === 'br') return '\n';
  if (tag === 'script' || tag === 'style') return '';
  if (tag === 'img') {
    const alt = el.getAttribute('alt')?.trim();
    // The bytes are not imported, so a src would point at a file that never arrives. The
    // placeholder is honest about there having been an image here.
    return alt ? `![${escapeInline(alt)}]()` : '![image]()';
  }

  const classes = classesOf(el);
  const bold = active.bold || tag === 'strong' || tag === 'b' || classes.some((c) => flags.bold.has(c));
  const italic = active.italic || tag === 'em' || tag === 'i' || classes.some((c) => flags.italic.has(c));

  let inner = '';
  for (const child of Array.from(el.childNodes)) inner += inlineOf(child, flags, { bold, italic });

  if (tag === 'code') return inner.trim() ? `\`${inner.replace(/\\([\\`*_[\]])/g, '$1')}\`` : '';
  if (tag === 'a') {
    const href = el.getAttribute('href') ?? '';
    // Google routes every external link through google.com/url?q=… - unwrap it, or every
    // link in the imported note points at a redirector.
    const target = href.match(/^https?:\/\/(?:www\.)?google\.com\/url\?q=([^&]+)/)?.[1];
    const url = target ? decodeURIComponent(target) : href;
    return url && inner.trim() ? `[${inner}](${url})` : inner;
  }

  // Emphasis is applied at the outermost element that carries it, so nested spans with the
  // same class do not produce `****word****`.
  if (bold && !active.bold && inner.trim()) inner = `**${inner}**`;
  if (italic && !active.italic && inner.trim()) inner = `_${inner}_`;
  return inner;
}

function listToMarkdown(el: Element, flags: StyleFlags, depth: number, ordered: boolean): string[] {
  const lines: string[] = [];
  let index = 1;
  for (const li of Array.from(el.children)) {
    if (li.tagName.toLowerCase() !== 'li') continue;
    const nested: string[] = [];
    let text = '';
    for (const child of Array.from(li.childNodes)) {
      const tag = child.nodeType === 1 ? (child as Element).tagName.toLowerCase() : '';
      if (tag === 'ul' || tag === 'ol') {
        nested.push(...listToMarkdown(child as Element, flags, depth + 1, tag === 'ol'));
      } else {
        text += inlineOf(child, flags);
      }
    }
    const marker = ordered ? `${index++}.` : '-';
    lines.push(`${'  '.repeat(depth)}${marker} ${text.trim()}`);
    lines.push(...nested);
  }
  return lines;
}

function tableToMarkdown(el: Element, flags: StyleFlags): string[] {
  const rows = Array.from(el.querySelectorAll('tr'));
  if (!rows.length) return [];
  const cells = rows.map((tr) =>
    Array.from(tr.children)
      .filter((c) => /^t[dh]$/i.test(c.tagName))
      // A pipe inside a cell would end the column early.
      .map((c) => inlineOf(c, flags).trim().replace(/\|/g, '\\|') || ' '),
  );
  const width = Math.max(...cells.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill(' ')];
  const out = [`| ${pad(cells[0]).join(' | ')} |`, `| ${Array(width).fill('---').join(' | ')} |`];
  for (const r of cells.slice(1)) out.push(`| ${pad(r).join(' | ')} |`);
  return out;
}

const SKIP_TAGS = new Set(['script', 'style', 'head', 'meta', 'link', 'title', 'noscript']);

function blockToMarkdown(el: Element, flags: StyleFlags, out: string[]): void {
  const tag = el.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag)) return;

  const heading = tag.match(/^h([1-6])$/);
  if (heading) {
    const text = inlineOf(el, flags).trim();
    // Google marks emphasis on the heading's own span too; a heading that is entirely bold
    // would otherwise import as `## **Title**`.
    if (text) out.push(`${'#'.repeat(Number(heading[1]))} ${text.replace(/^\*\*(.*)\*\*$/s, '$1')}`, '');
    return;
  }
  if (tag === 'ul' || tag === 'ol') {
    out.push(...listToMarkdown(el, flags, 0, tag === 'ol'), '');
    return;
  }
  if (tag === 'table') {
    out.push(...tableToMarkdown(el, flags), '');
    return;
  }
  if (tag === 'blockquote') {
    const inner: string[] = [];
    for (const child of Array.from(el.children)) blockToMarkdown(child, flags, inner);
    const text = inner.length ? inner : [inlineOf(el, flags).trim()];
    out.push(...text.filter(Boolean).map((l) => `> ${l}`), '');
    return;
  }
  if (tag === 'pre') {
    out.push('```', (el.textContent ?? '').replace(/\s+$/, ''), '```', '');
    return;
  }
  if (tag === 'hr') {
    out.push('---', '');
    return;
  }

  // A container (div, body, section) recurses; a leaf block (p, and anything else holding
  // only inline content) emits its text.
  const hasBlockChildren = Array.from(el.children).some((c) =>
    /^(p|div|h[1-6]|ul|ol|table|blockquote|pre|hr|section|article|main|body)$/i.test(c.tagName),
  );
  if (hasBlockChildren) {
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 1) blockToMarkdown(child as Element, flags, out);
      else if (child.nodeType === 3) {
        const stray = collapse(child.nodeValue ?? '').trim();
        if (stray) out.push(escapeInline(stray), '');
      }
    }
    return;
  }

  const text = inlineOf(el, flags).trim();
  if (text) out.push(text, '');
}

/** The document title an exported file declares, if it has one worth using. */
export function htmlTitle(doc: Document): string | undefined {
  const explicit = doc.querySelector('title')?.textContent?.trim();
  if (explicit) return explicit;
  const styled = doc.querySelector('.title, p.title, h1')?.textContent?.trim();
  return styled || undefined;
}

export interface HtmlConversion {
  markdown: string;
  title?: string;
}

/** Convert an exported HTML document to markdown. Returns empty markdown, not a throw,
 *  for input that parses to nothing - one unreadable file should not fail a batch. */
export function htmlToMarkdown(html: string): HtmlConversion {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const flags = classStyleFlags(doc);
  const out: string[] = [];
  const root = doc.body ?? doc.documentElement;
  if (root) blockToMarkdown(root, flags, out);
  const markdown = out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { markdown, title: htmlTitle(doc) };
}
