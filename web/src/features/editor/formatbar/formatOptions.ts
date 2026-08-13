// The lists behind the formatting bar's four dropdowns.
//
// Separate from FormatBar.tsx because these are data, and because the paragraph styles
// need to know how to both apply themselves and recognise themselves - keeping that pair
// together is what stops the dropdown label and the button that sets it drifting apart.

import type { Editor } from '@tiptap/core';

export interface ParagraphStyle {
  id: string;
  label: string;
  apply: (editor: Editor) => void;
  isActive: (editor: Editor) => boolean;
}

/**
 * Ordered most-used first rather than by heading level: "Normal" is what you return to
 * after every heading, so it belongs at the top where the pointer already is.
 */
export const PARAGRAPH_STYLES: ParagraphStyle[] = [
  {
    id: 'p',
    label: 'Normal',
    apply: e => e.chain().focus().setParagraph().run(),
    isActive: e => e.isActive('paragraph'),
  },
  {
    id: 'h1',
    label: 'Heading 1',
    apply: e => e.chain().focus().toggleHeading({ level: 1 }).run(),
    isActive: e => e.isActive('heading', { level: 1 }),
  },
  {
    id: 'h2',
    label: 'Heading 2',
    apply: e => e.chain().focus().toggleHeading({ level: 2 }).run(),
    isActive: e => e.isActive('heading', { level: 2 }),
  },
  {
    id: 'h3',
    label: 'Heading 3',
    apply: e => e.chain().focus().toggleHeading({ level: 3 }).run(),
    isActive: e => e.isActive('heading', { level: 3 }),
  },
  {
    id: 'quote',
    label: 'Quote',
    apply: e => e.chain().focus().toggleBlockquote().run(),
    isActive: e => e.isActive('blockquote'),
  },
  {
    id: 'code',
    label: 'Code block',
    apply: e => e.chain().focus().toggleCodeBlock().run(),
    isActive: e => e.isActive('codeBlock'),
  },
];

/**
 * Faces the app already loads, plus the web-safe stacks.
 *
 * No webfont is fetched for a font-family choice: everything here is either bundled with
 * the app (@fontsource, see main.tsx) or present on the machine. A dropdown that silently
 * falls back to Times because the CDN was blocked is worse than a shorter list.
 */
export const FONT_FAMILIES: Array<{ label: string; value: string }> = [
  { label: 'Default (note serif)', value: '' },
  { label: 'Newsreader', value: '"Newsreader Variable", Newsreader, Georgia, serif' },
  { label: 'IBM Plex Sans', value: '"IBM Plex Sans", system-ui, sans-serif' },
  { label: 'Inter', value: '"Inter Variable", Inter, system-ui, sans-serif' },
  { label: 'IBM Plex Mono', value: '"IBM Plex Mono", ui-monospace, monospace' },
  { label: 'JetBrains Mono', value: '"JetBrains Mono", ui-monospace, monospace' },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Times New Roman', value: '"Times New Roman", Times, serif' },
  { label: 'Arial', value: 'Arial, Helvetica, sans-serif' },
  { label: 'Calibri', value: 'Calibri, Candara, Segoe, sans-serif' },
];

/** Word's own ladder, trimmed at both ends. Below 8px text is unreadable on paper and
 *  above 72px a single word fills an A4 line, so neither end earns its place. */
export const FONT_SIZES = [
  '8px', '9px', '10px', '11px', '12px', '14px', '16px', '18px',
  '19px', '20px', '24px', '28px', '32px', '40px', '48px', '60px', '72px',
];

export const LINE_HEIGHTS = ['1', '1.15', '1.5', '1.75', '2', '2.5', '3'];
