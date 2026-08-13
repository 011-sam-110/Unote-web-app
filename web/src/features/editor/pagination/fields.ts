// Header and footer field tokens.
//
// A header is a line of text with two or three substitutions in it. That is genuinely all
// it is, so it is stored as a string with `{{page}}`-style tokens rather than as a document
// model - a rich structure here would be a lot of machinery to express "Page 2 of 7".
//
// The token set is CLOSED. An unknown token renders as itself, unchanged, so a user who
// types `{{foo}}` sees `{{foo}}` rather than an empty gap they cannot explain.

export const FIELDS = {
  page: 'Page number',
  pages: 'Total pages',
  title: 'Note title',
  date: "Today's date",
  notebook: 'Notebook name',
} as const;

export type FieldId = keyof typeof FIELDS;

export const FIELD_IDS = Object.keys(FIELDS) as FieldId[];

export interface FieldValues {
  page: number;
  pages: number;
  title: string;
  date: string;
  notebook: string;
}

/** Matches `{{name}}` with optional inner whitespace, so `{{ page }}` works too. */
const TOKEN_RE = /\{\{\s*([a-zA-Z]+)\s*\}\}/g;

export function isFieldId(name: string): name is FieldId {
  return Object.prototype.hasOwnProperty.call(FIELDS, name);
}

/**
 * Substitute field values into one zone's text.
 *
 * Called once per zone per sheet, so a 200-page note runs this 1,200 times per render.
 * The early return on a token-free string is what keeps that free: most headers are a
 * fixed word or empty, and a regex pass over every one of them on every repaint is waste.
 */
export function resolveFields(text: string, values: FieldValues): string {
  if (!text || text.indexOf('{{') === -1) return text;
  return text.replace(TOKEN_RE, (whole, rawName: string) => {
    const name = rawName.toLowerCase();
    if (!isFieldId(name)) return whole;
    const value = values[name];
    return typeof value === 'number' ? String(value) : value;
  });
}

/** Split a zone into literal text and field tokens, for rendering the editable band where
 *  fields appear as chips rather than as braces the user has to type correctly. */
export interface ZoneSegment {
  kind: 'text' | 'field';
  value: string;
  field?: FieldId;
}

export function splitZone(text: string): ZoneSegment[] {
  const segments: ZoneSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN_RE)) {
    const name = match[1].toLowerCase();
    if (!isFieldId(name)) continue;
    const start = match.index ?? 0;
    if (start > last) segments.push({ kind: 'text', value: text.slice(last, start) });
    segments.push({ kind: 'field', value: match[0], field: name });
    last = start + match[0].length;
  }
  if (last < text.length) segments.push({ kind: 'text', value: text.slice(last) });
  return segments;
}
