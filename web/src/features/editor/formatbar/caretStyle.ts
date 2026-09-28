// What the text at the caret actually looks like, for the font and size boxes.
//
// The boxes used to read only the textStyle mark, and almost no text carries one: body text
// takes its 19px serif from editor.css, and a heading its size from the heading rule. So
// the size box said "Size" and the font box said "Default" nearly everywhere, which told
// the reader nothing about the text they were about to change.
//
// An explicit mark still wins, because it is what the user chose. Without one, the answer
// comes from the browser: one getComputedStyle on the element the caret is in. That is the
// only source that knows every rule in the cascade - heading scale, inline code, a callout
// - without a second copy of editor.css in TypeScript to drift out of step with it.
//
// Computed font-size is in CSS pixels BEFORE transforms, so the page zoom (a scale()
// transform on .folio-paged) does not change the reading. That is the number we want: it
// is the same unit the size menu lists and the same value the size mark stores.

import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection, type EditorState } from '@tiptap/pm/state';
import { FONT_FAMILIES } from './formatOptions';

/** '19px', '32.68px' or 32.68 as the menu writes it: '19', '33'. Empty when unreadable. */
export function sizeNumber(px: string | number | null | undefined): string {
  const n = typeof px === 'number' ? px : parseFloat(String(px ?? ''));
  if (!Number.isFinite(n) || n <= 0) return '';
  return String(Math.round(n));
}

/** CSS generic families. They name a fallback, never a face, so they identify nothing. */
const GENERIC_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'math', 'emoji', 'fangsong',
  'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', '-apple-system',
]);

function familyNames(stack: string): string[] {
  return stack
    .split(',')
    .map(name => name.trim().replace(/^["']|["']$/g, '').trim().toLowerCase())
    .filter(Boolean);
}

/**
 * The font menu's label for a CSS font-family stack, or null when no entry matches.
 *
 * Matched on the stack's FIRST family, which is the face the stylesheet asked for. First
 * against each entry's own first family (the editor's `--font-display` begins with
 * "Newsreader Variable", as the Newsreader entry does), then against any named face in an
 * entry's stack, so a bare `Newsreader` or `Inter` still finds its entry. Generic families
 * never match: `system-ui` sits in two entries' stacks and belongs to neither.
 */
export function familyLabelFor(stack: string | null | undefined): string | null {
  const first = familyNames(stack ?? '')[0];
  if (!first || GENERIC_FAMILIES.has(first)) return null;
  const named = FONT_FAMILIES.filter(font => font.value);
  const exact = named.find(font => familyNames(font.value)[0] === first);
  if (exact) return exact.label;
  const loose = named.find(font => familyNames(font.value).includes(first));
  return loose?.label ?? null;
}

/**
 * True when every character in the selection would read the same in a box keyed by `key`.
 *
 * Word leaves the size box empty over a selection that mixes sizes, and that is the
 * honest answer: any single number would be wrong for part of it. Decided on the document
 * tree rather than the DOM, so it costs no style recalculation, and it stops at the first
 * difference - a select-all over a long note walks only as far as its first heading.
 */
export function selectionIsUniform(
  state: EditorState,
  key: (text: PMNode, parent: PMNode | null) => string,
): boolean {
  const { from, to, empty } = state.selection;
  if (empty) return true;
  let first: string | null = null;
  let mixed = false;
  state.doc.nodesBetween(from, to, (node, _pos, parent) => {
    if (mixed) return false;
    if (!node.isText) return true;
    const k = key(node, parent);
    if (first === null) first = k;
    else if (k !== first) mixed = true;
    return false;
  });
  return !mixed;
}

function explicitAttr(text: PMNode, attr: 'fontSize' | 'fontFamily'): string {
  const mark = text.marks.find(m => m.type.name === 'textStyle' && m.attrs[attr]);
  return mark ? String(mark.attrs[attr]) : '';
}

function hasCode(text: PMNode): boolean {
  return text.marks.some(m => m.type.name === 'code');
}

/** What decides a run's size: its own size mark, else its block (and heading level), else inline code. */
export function sizeKey(text: PMNode, parent: PMNode | null): string {
  const explicit = explicitAttr(text, 'fontSize');
  if (explicit) return `=${sizeNumber(explicit)}`;
  const level = parent?.attrs.level ?? '';
  return `${parent?.type.name ?? ''}${level}${hasCode(text) ? ':code' : ''}`;
}

/** What decides a run's face: its own font mark, else whether it is code. */
export function familyKey(text: PMNode, parent: PMNode | null): string {
  const explicit = explicitAttr(text, 'fontFamily');
  if (explicit) return `=${explicit}`;
  return hasCode(text) || parent?.type.name === 'codeBlock' ? 'mono' : 'text';
}

/**
 * The element the text at `pos` is set in.
 *
 * Climbs out of <sub> and <sup>: those shrink the glyphs to draw a script, and Word
 * reports the size of the line they sit in (11 for a subscript in 11pt text), not the
 * rendered size of the little figure.
 */
function elementAt(editor: Editor, pos: number): Element | null {
  let found: { node: Node; offset: number };
  try {
    found = editor.view.domAtPos(pos);
  } catch {
    return null;
  }
  let el: Element | null =
    found.node.nodeType === Node.ELEMENT_NODE ? (found.node as Element) : found.node.parentElement;
  while (el && (el.tagName === 'SUB' || el.tagName === 'SUP')) el = el.parentElement;
  return el;
}

/** The trigger's short name for text that follows the note's own face. */
export const DEFAULT_FAMILY_LABEL = 'Default';

/** A font mark's value as the menu names it; an unlisted face (pasted in) by its first family. */
export function familyLabelForMark(value: string): string {
  if (!value) return DEFAULT_FAMILY_LABEL;
  return (
    FONT_FAMILIES.find(f => f.value === value)?.label ??
    value.split(',')[0].replace(/["']/g, '').trim()
  );
}

export interface CaretStyle {
  /** The number for the size box ('19'), or '' when the selection mixes sizes or no text is selected. */
  size: string;
  /** The font menu label for the face in use, or '' when the selection mixes faces. */
  family: string;
}

/**
 * The size and face the formatting bar should show for the current selection.
 *
 * One getComputedStyle per call, on one element, and no document walk beyond the
 * selection itself: this runs on every transaction, which means on every keystroke.
 */
export function readCaretStyle(editor: Editor): CaretStyle {
  const { state } = editor;
  const textStyle = editor.getAttributes('textStyle');
  const markSize = sizeNumber(textStyle.fontSize as string | undefined);
  const markFamily = (textStyle.fontFamily as string | undefined) ?? '';

  // An image or a board block is selected as a whole: there is no text for the boxes to
  // describe, and the body size would be a guess about text that is not there.
  if (state.selection instanceof NodeSelection) return { size: '', family: '' };

  const sizeUniform = selectionIsUniform(state, sizeKey);
  const familyUniform = selectionIsUniform(state, familyKey);

  // Only touch the DOM for what the marks cannot answer. `from` rather than the head, so
  // a selection made backwards reads the same as the same selection made forwards.
  let computed: CSSStyleDeclaration | null = null;
  if ((sizeUniform && !markSize) || (familyUniform && !markFamily)) {
    const el = elementAt(editor, state.selection.from);
    if (el && el.isConnected) computed = getComputedStyle(el);
  }

  const size = !sizeUniform ? '' : markSize || sizeNumber(computed?.fontSize);
  const family = !familyUniform
    ? ''
    : markFamily
      ? familyLabelForMark(markFamily)
      : familyLabelFor(computed?.fontFamily) ?? DEFAULT_FAMILY_LABEL;
  return { size, family };
}
