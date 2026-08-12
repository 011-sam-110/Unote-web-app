// CSL-JSON <-> the boxes a student types into.
//
// Sources are stored as CSL-JSON because that is what citeproc-js consumes, so there is no
// intermediate citation format anywhere in this feature. The cost of that decision lands
// here: CSL is polymorphic, and every conversion in this file is where the polymorphism is
// absorbed. All of it is pure, and all of it is tested in csl.test.ts, because the failure
// mode is silent - a date that round-trips into the wrong shape produces a plausible-looking
// reference with the wrong year rather than an error anybody would notice.
//
// THE RULE THIS FILE ENFORCES: nothing here invents a value. A field with no value comes
// back as '' and stays out of the CSL object entirely, so "we don't know" is never stored
// as an empty string that later reads as a known-blank.
import type { Csl, SourceField, SourceType } from './types';

// ---------------------------------------------------------------------------
// contributors
// ---------------------------------------------------------------------------

/** A CSL name: a split personal name, or a literal for an organisation. */
export type CslName = { family?: string; given?: string; literal?: string };

/**
 * One contributor per line, "Surname, First names".
 *
 * A line with no comma becomes a `literal` rather than a bare `family`, which is the
 * difference between "World Health Organization" citing as itself and citing as
 * "Organization, W. H." under an author-date style. The comma is the student's signal
 * that this is a person, and it is the only signal available without guessing.
 */
export function parseContributors(text: string): CslName[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const comma = line.indexOf(',');
      if (comma < 0) return { literal: line };
      const family = line.slice(0, comma).trim();
      const given = line.slice(comma + 1).trim();
      if (!family) return { literal: line };
      return given ? { family, given } : { family };
    });
}

/** The inverse, exactly - a value parsed from this string re-formats to this string. */
export function formatContributors(value: unknown): string {
  if (!Array.isArray(value)) return typeof value === 'string' ? value : '';
  return value
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (!entry || typeof entry !== 'object') return '';
      const n = entry as CslName;
      if (n.literal) return n.literal;
      if (n.family && n.given) return `${n.family}, ${n.given}`;
      return n.family ?? n.given ?? '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Surnames only, for a one-line summary. "Watson and Crick", "Smith et al." */
export function bylineFrom(value: unknown): string {
  if (!Array.isArray(value)) return '';
  const names = value
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (!entry || typeof entry !== 'object') return '';
      const n = entry as CslName;
      return n.family ?? n.literal ?? n.given ?? '';
    })
    .filter(Boolean);
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} et al.`;
}

// ---------------------------------------------------------------------------
// dates
// ---------------------------------------------------------------------------

/** `2013`, `2013-07` or `2013-07-25`. Anything else is kept verbatim as `raw`. */
export function parseDate(text: string): unknown | undefined {
  const s = text.trim();
  if (!s) return undefined;
  const m = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/.exec(s);
  if (!m) return { raw: s };
  const parts = [Number(m[1])];
  if (m[2]) parts.push(Number(m[2]));
  if (m[3]) parts.push(Number(m[3]));
  return { 'date-parts': [parts] };
}

export function formatDate(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return String(value);
  const d = value as { 'date-parts'?: unknown; raw?: unknown; literal?: unknown };
  const dp = d['date-parts'];
  if (Array.isArray(dp) && Array.isArray(dp[0])) {
    const nums = (dp[0] as unknown[]).map((n) => Number(n)).filter((n) => Number.isFinite(n));
    if (nums.length === 0) return '';
    const [y, m, day] = nums;
    // Padded so the string round-trips through parseDate to the same date-parts.
    return [String(y), m ? String(m).padStart(2, '0') : null, day ? String(day).padStart(2, '0') : null]
      .filter(Boolean)
      .join('-');
  }
  if (typeof d.raw === 'string') return d.raw;
  if (typeof d.literal === 'string') return d.literal;
  return '';
}

/** Just the year, for the library list. */
export function yearOf(csl: Csl): string {
  const formatted = formatDate(csl.issued);
  const m = /(\d{4})/.exec(formatted);
  return m ? m[1] : '';
}

// ---------------------------------------------------------------------------
// fields
// ---------------------------------------------------------------------------

/** A CSL value as the string its input box should show. '' means "we do not know". */
export function readField(csl: Csl, field: SourceField): string {
  const raw = csl[field.csl];
  if (raw === undefined || raw === null) return '';
  if (field.kind === 'contributors') return formatContributors(raw);
  if (field.kind === 'date') return formatDate(raw);
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number') return String(raw);
  // A registry sent a shape this field did not expect. Showing it is better than
  // dropping it: the student can see what is there and correct it.
  return typeof raw === 'object' ? formatDate(raw) || '' : String(raw);
}

/**
 * Write a typed box back into CSL. An empty box DELETES the key rather than storing '',
 * so an unknown field stays unknown - `verify.ts` treats a present-but-empty DOI
 * differently from an absent one, and an empty-string title would defeat the title
 * comparison that produces `refuted`.
 */
export function writeField(csl: Csl, field: SourceField, text: string): Csl {
  const next = { ...csl };
  const trimmed = text.trim();
  if (!trimmed) {
    delete next[field.csl];
    return next;
  }
  if (field.kind === 'contributors') {
    const names = parseContributors(text);
    if (names.length === 0) delete next[field.csl];
    else next[field.csl] = names;
    return next;
  }
  if (field.kind === 'date') {
    const parsed = parseDate(text);
    if (parsed === undefined) delete next[field.csl];
    else next[field.csl] = parsed;
    return next;
  }
  next[field.csl] = trimmed;
  return next;
}

export function hasValue(csl: Csl, field: SourceField): boolean {
  return readField(csl, field).trim() !== '';
}

/**
 * The split the whole feature exists for: what a registry actually supplied, and what it
 * did not and therefore has to be ASKED for.
 *
 * Driven by the chosen type's own field list rather than by the server's flat `missing`
 * array. The server checks one fixed list of five variables for every type, so a journal
 * article always reports `publisher` missing - and a student asked for a journal's
 * publisher has been asked a question with no right answer, which teaches them to ignore
 * the panel. Only fields this TYPE actually cites can be missing from it.
 *
 * `missing` is still used: any field the server named is marked, so "the registry told us
 * it had nothing here" is distinguishable from "nobody has filled this in yet".
 */
export interface FieldSplit {
  found: SourceField[];
  needed: SourceField[];
  /** Fields the SERVER explicitly reported absent, intersected with this type's fields. */
  reportedMissing: Set<string>;
}

export function splitFields(type: SourceType, csl: Csl, missing: string[] = []): FieldSplit {
  const found: SourceField[] = [];
  const needed: SourceField[] = [];
  for (const field of type.fields) {
    (hasValue(csl, field) ? found : needed).push(field);
  }
  // Recommended first: a student filling in two of six boxes should fill the two that
  // change whether the reference is usable.
  needed.sort((a, b) => Number(Boolean(b.recommended)) - Number(Boolean(a.recommended)));
  const own = new Set(type.fields.map((f) => f.csl));
  return { found, needed, reportedMissing: new Set(missing.filter((m) => own.has(m))) };
}

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

/**
 * What registries actually put in `type`, mapped to what CSL calls it.
 *
 * FOUND BY RUNNING IT, not by reading the CSL spec. doi.org content-negotiates through
 * Crossref's own transform, and that transform emits Crossref's vocabulary - a real Nature
 * article comes back as `"type": "journal-article"`, which is NOT a CSL item type; CSL calls
 * it `article-journal`. Without this table every DOI-resolved journal article fell through
 * to "Other", whose field list is title/author/date/URL - so `Nature`, the volume, the issue,
 * the pages and the DOI itself were all still stored but named nowhere on screen. It looked
 * like a working lookup. That is the shape of failure this whole feature exists to refuse,
 * so the mapping is a table with the wrong strings written down rather than a guess.
 */
const REGISTRY_TYPE_ALIASES: Record<string, string> = {
  'journal-article': 'article-journal',
  'book-chapter': 'chapter',
  'proceedings-article': 'paper-conference',
  'magazine-article': 'article-magazine',
  'newspaper-article': 'article-newspaper',
  dissertation: 'thesis',
  monograph: 'book',
  'reference-book': 'book',
  'edited-book': 'book',
  'book-section': 'chapter',
  'book-part': 'chapter',
  'report-component': 'report',
  'web-page': 'webpage',
  // A preprint. Cited like the article it is a version of, which is the closest honest
  // answer available from a type string alone.
  'posted-content': 'article-journal',
};

/**
 * Which of the 27 source types a registry's CSL item is.
 *
 * Several types share a CSL type (book / edited-book / e-book are all `book`), so this
 * takes the first match - the plainest of the group - and the student can change it. A
 * wrong guess costs one dropdown; refusing to guess costs a question before every lookup.
 */
export function typeForCsl(csl: Csl, types: SourceType[], fallback = 'other'): string {
  const raw = typeof csl.type === 'string' ? csl.type : '';
  const cslType = REGISTRY_TYPE_ALIASES[raw] ?? raw;
  const match = cslType ? types.find((t) => t.cslType === cslType) : undefined;
  return match?.id ?? types.find((t) => t.id === fallback)?.id ?? types[0]?.id ?? fallback;
}

/**
 * Citation-relevant CSL variables a registry might supply that the CHOSEN TYPE does not
 * list. Whitelisted rather than "everything else in the object": Crossref's CSL carries the
 * article's whole reference list, its licence array, deposit timestamps and a citation
 * count, none of which belong on screen.
 *
 * These are shown anyway, under "found", because they ARE saved. A field that is stored and
 * never displayed is the quiet half of a reference the student cannot check - and if the
 * type guess is wrong, this is the only thing that shows them it is wrong.
 */
const EXTRA_LABELS: Record<string, string> = {
  'container-title': 'Published in',
  publisher: 'Publisher',
  'publisher-place': 'Place of publication',
  volume: 'Volume',
  issue: 'Issue',
  page: 'Pages',
  edition: 'Edition',
  DOI: 'DOI',
  ISBN: 'ISBN',
  ISSN: 'ISSN',
  URL: 'URL',
  genre: 'Type',
  medium: 'Medium',
  number: 'Number',
  event: 'Event',
  'event-place': 'Location',
  archive: 'Archive',
  archive_location: 'Collection',
  authority: 'Authority',
  version: 'Version',
  'collection-title': 'Series',
  'number-of-pages': 'Pages in total',
  editor: 'Editors',
  translator: 'Translators',
  director: 'Director',
};

export interface ExtraFact {
  key: string;
  label: string;
  value: string;
}

/** Everything the registry supplied that this type has no box for. Never editable here -
 *  changing the type is what gives a value a box, and that picker is right above. */
export function extraFacts(type: SourceType, csl: Csl): ExtraFact[] {
  const own = new Set(type.fields.map((f) => f.csl));
  const out: ExtraFact[] = [];
  for (const [key, label] of Object.entries(EXTRA_LABELS)) {
    if (own.has(key)) continue;
    const raw = csl[key];
    if (raw === undefined || raw === null || raw === '') continue;
    let value = '';
    if (typeof raw === 'string') value = raw;
    else if (typeof raw === 'number') value = String(raw);
    else if (Array.isArray(raw)) {
      if (raw.length === 0) continue;
      value = raw.every((v) => typeof v === 'string') ? (raw as string[]).join(', ') : formatContributors(raw);
    } else if (typeof raw === 'object') value = formatDate(raw);
    if (value.trim()) out.push({ key, label, value });
  }
  return out;
}

export function typeById(types: SourceType[], id: string): SourceType | undefined {
  return types.find((t) => t.id === id);
}

/** The line under a source's title in the library: who, where, when. */
export function summaryLine(csl: Csl): string {
  const parts = [
    bylineFrom(csl.author) || bylineFrom(csl.editor),
    typeof csl['container-title'] === 'string' ? csl['container-title'] : '',
    typeof csl.publisher === 'string' ? csl.publisher : '',
    yearOf(csl),
  ];
  return parts.filter(Boolean).join(' · ');
}

export function titleOf(csl: Csl): string {
  return typeof csl.title === 'string' && csl.title.trim() ? csl.title : 'Untitled source';
}
