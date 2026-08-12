// Referencing styles: what a saved source looks like in a reference list.
//
// WHAT THIS IS, AND WHAT IT IS NOT. The finished design formats through citeproc-js with
// CSL styles AND locales compiled in, and that is a slice of its own - it brings a
// dependency, a pile of compiled XML, and the offline story that goes with them. This is a
// direct renderer for the five styles UK students are actually set, covering the source
// types they actually cite. It is deliberately narrow, it is tested against worked examples
// from each style's own rules, and it is the thing citeproc-js replaces rather than
// something citeproc-js has to be reconciled with: both read the same CSL-JSON, so nothing
// stored has to change when it does.
//
// THE RULE IT SHARES WITH THE REST OF THE FEATURE: it never invents a field to make a
// reference look finished. Where a style has its own convention for an absent value the
// convention is used - Harvard's "(no date)", APA's "(n.d.)" - and `missingFor` reports
// what a style needs and has not got, so an incomplete reference says so instead of quietly
// rendering short. A reference list that looks complete and is not is the exact failure
// this whole feature exists to prevent, and formatting is the last place it can happen.
import { formatDate, yearOf } from './csl';
import type { Csl } from './types';

export type StyleId = 'harvard' | 'apa' | 'mla' | 'vancouver' | 'chicago';

export interface CitationStyle {
  id: StyleId;
  label: string;
  /** Which convention this is, so a student can tell it is the one their department set. */
  note: string;
}

export const STYLES: CitationStyle[] = [
  { id: 'harvard', label: 'Harvard', note: 'Cite Them Right, 12th edition - the UK default' },
  { id: 'apa', label: 'APA', note: '7th edition' },
  { id: 'mla', label: 'MLA', note: '9th edition' },
  { id: 'vancouver', label: 'Vancouver', note: 'numeric, used across medicine and the sciences' },
  { id: 'chicago', label: 'Chicago', note: 'author-date (17th edition)' },
];

export const DEFAULT_STYLE: StyleId = 'harvard';

// ---------------------------------------------------------------------------
// names
// ---------------------------------------------------------------------------

interface Name {
  family?: string;
  given?: string;
  literal?: string;
}

function names(value: unknown): Name[] {
  if (!Array.isArray(value)) return [];
  return value.filter((n): n is Name => Boolean(n) && typeof n === 'object');
}

/** "James D." -> "J.D." (Harvard), "J. D." (APA), "JD" (Vancouver). */
function initials(given: string | undefined, opts: { dots: boolean; spaced: boolean }): string {
  if (!given) return '';
  const letters = given
    .split(/[\s.]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase());
  const each = letters.map((l) => (opts.dots ? `${l}.` : l));
  return each.join(opts.spaced ? ' ' : '');
}

/** One name, in the shape a given style wants it. `inverted` is for the first author in
 *  the styles that only invert the first (MLA, Chicago). */
function renderName(n: Name, style: StyleId, inverted: boolean): string {
  // An organisation is written as it is written. "World Health Organization" must never
  // come out as "Organization, W. H."
  if (n.literal) return n.literal;
  const family = n.family ?? '';
  const given = n.given ?? '';
  if (!family) return given;
  if (!given) return family;

  switch (style) {
    case 'harvard':
      return `${family}, ${initials(given, { dots: true, spaced: false })}`;
    case 'apa':
      return `${family}, ${initials(given, { dots: true, spaced: true })}`;
    case 'vancouver':
      return `${family} ${initials(given, { dots: false, spaced: false })}`;
    case 'mla':
    case 'chicago':
      return inverted ? `${family}, ${given}` : `${given} ${family}`;
  }
}

/** The author list, joined the way the style joins it - including when to give up and
 *  say "et al.", which differs per style and is the part people get wrong. */
export function renderNames(value: unknown, style: StyleId): string {
  const list = names(value);
  if (list.length === 0) return '';
  const at = (i: number) => renderName(list[i], style, i === 0);

  switch (style) {
    case 'harvard': {
      // Cite Them Right: up to three named, four or more is the first plus et al.
      if (list.length >= 4) return `${at(0)} et al.`;
      if (list.length === 1) return at(0);
      const all = list.map((_, i) => at(i));
      return `${all.slice(0, -1).join(', ')} and ${all[all.length - 1]}`;
    }
    case 'apa': {
      // APA 7 lists up to 20, with an ampersand before the last.
      if (list.length > 20) return `${list.slice(0, 19).map((_, i) => at(i)).join(', ')}, ... ${at(list.length - 1)}`;
      if (list.length === 1) return at(0);
      const all = list.map((_, i) => at(i));
      if (all.length === 2) return `${all[0]}, & ${all[1]}`;
      return `${all.slice(0, -1).join(', ')}, & ${all[all.length - 1]}`;
    }
    case 'mla': {
      // MLA 9 names two, then goes to et al. at three.
      if (list.length >= 3) return `${at(0)}, et al.`;
      if (list.length === 1) return at(0);
      return `${at(0)}, and ${at(1)}`;
    }
    case 'vancouver': {
      // Vancouver lists six, then et al.
      const all = list.map((_, i) => at(i));
      if (all.length > 6) return `${all.slice(0, 6).join(', ')}, et al.`;
      return all.join(', ');
    }
    case 'chicago': {
      if (list.length >= 4) return `${at(0)} et al.`;
      if (list.length === 1) return at(0);
      const all = list.map((_, i) => at(i));
      if (all.length === 2) return `${all[0]}, and ${all[1]}`;
      return `${all.slice(0, -1).join(', ')}, and ${all[all.length - 1]}`;
    }
  }
}

/** Surnames only, for the in-text citation. */
function surnames(value: unknown, style: StyleId): string {
  const list = names(value);
  if (list.length === 0) return '';
  const one = (n: Name) => n.literal ?? n.family ?? n.given ?? '';
  const joiner = style === 'apa' ? ' & ' : ' and ';
  if (list.length === 1) return one(list[0]);
  if (list.length === 2) return `${one(list[0])}${joiner}${one(list[1])}`;
  return `${one(list[0])} et al.`;
}

// ---------------------------------------------------------------------------
// dates
// ---------------------------------------------------------------------------

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function dateParts(value: unknown): { year?: number; month?: number; day?: number } {
  const text = formatDate(value);
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(text);
  if (!m) return {};
  return { year: Number(m[1]), month: m[2] ? Number(m[2]) : undefined, day: m[3] ? Number(m[3]) : undefined };
}

/** "12 August 2026" - the form Harvard and MLA use for an accessed date. */
function longDate(value: unknown): string {
  const { year, month, day } = dateParts(value);
  if (!year) return '';
  if (!month) return String(year);
  const name = MONTHS[month - 1] ?? '';
  return day ? `${day} ${name} ${year}` : `${name} ${year}`;
}

/** What each style writes where the year goes when there ISN'T one. Every style has a
 *  convention for this, which is the whole reason nothing has to be invented. */
function yearOrNone(csl: Csl, style: StyleId): string {
  const y = yearOf(csl);
  if (y) return y;
  return style === 'harvard' ? 'no date' : style === 'mla' ? 'n.d.' : 'n.d.';
}

// ---------------------------------------------------------------------------
// shape
// ---------------------------------------------------------------------------

type Shape = 'journal' | 'chapter' | 'book' | 'webpage';

/** Which of four formatting shapes a source takes. Registry vocabularies included, for
 *  the same reason csl.ts carries them: `journal-article` is what actually arrives. */
export function shapeOf(csl: Csl): Shape {
  const t = typeof csl.type === 'string' ? csl.type : '';
  if (/article-journal|journal-article|article-magazine|article-newspaper|paper-conference|proceedings-article|posted-content/.test(t)) return 'journal';
  if (/chapter|book-chapter|book-section|entry-/.test(t)) return 'chapter';
  if (/^book$|monograph|reference-book|thesis|dissertation|report|manuscript/.test(t)) return 'book';
  if (/webpage|web-page|post-weblog/.test(t)) return 'webpage';
  // Anything else is decided by what it HAS: a container and a volume behave like a
  // journal, a publisher behaves like a book, a bare link behaves like a webpage.
  if (csl['container-title'] && csl.volume) return 'journal';
  if (csl.publisher) return 'book';
  if (csl.URL) return 'webpage';
  return 'book';
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
}

/** Joins the pieces of a reference, dropping empties and never leaving a stray separator
 *  or a doubled full stop behind. */
function join(parts: (string | false | undefined)[], sep = ' '): string {
  return parts.filter((p): p is string => Boolean(p && p.trim())).join(sep);
}

function endStop(s: string): string {
  const t = s.trim();
  if (!t) return '';
  return /[.?!]$/.test(t) ? t : `${t}.`;
}

// ---------------------------------------------------------------------------
// the reference-list entry
// ---------------------------------------------------------------------------

export function formatReference(csl: Csl, style: StyleId): string {
  const shape = shapeOf(csl);
  const author = renderNames(csl.author, style) || renderNames(csl.editor, style);
  const year = yearOrNone(csl, style);
  const title = str(csl.title);
  const container = str(csl['container-title']);
  const publisher = str(csl.publisher);
  const place = str(csl['publisher-place']);
  const volume = str(csl.volume);
  const issue = str(csl.issue);
  const page = str(csl.page);
  const edition = str(csl.edition);
  const doi = str(csl.DOI);
  const url = str(csl.URL);
  const accessed = longDate(csl.accessed);

  switch (style) {
    // Cite Them Right Harvard. Article titles in quotes, containers plain (this renders
    // plain text, so nothing is italicised - the copy goes into a document that will
    // italicise it, and a fake italic in a text box helps nobody).
    case 'harvard': {
      // NO full stop after the year. Cite Them Right runs "Surname, I. (Year) 'Title'..."
      // straight on - the bracket closes and the title follows. An added stop there is one
      // of the tells that a reference list came out of a generator nobody checked.
      const head = join([author, `(${year})`]);
      if (shape === 'journal') {
        const vol = volume ? `${volume}${issue ? `(${issue})` : ''}` : '';
        return join([
          head,
          endStop(join([title && `'${title}'`, container, vol, page && `pp. ${page}`].filter(Boolean), ', ')),
          doi && `doi: ${doi}.`,
        ]);
      }
      if (shape === 'chapter') {
        return join([
          head,
          endStop(`'${title}'`),
          endStop(join([container && `in ${container}`, edition, join([place, publisher], ': ')].filter(Boolean), '. ')),
          page && `pp. ${page}.`,
        ]);
      }
      if (shape === 'webpage') {
        return join([
          head,
          endStop(title),
          container && endStop(container),
          url && `Available at: ${url}`,
          accessed && `(Accessed: ${accessed}).`,
        ]);
      }
      return join([head, endStop(title), edition && endStop(edition), endStop(join([place, publisher], ': '))]);
    }

    case 'apa': {
      const head = join([author, `(${year === 'no date' ? 'n.d.' : year}).`]);
      if (shape === 'journal') {
        const vol = volume ? `${volume}${issue ? `(${issue})` : ''}` : '';
        return join([
          head,
          endStop(title),
          endStop(join([container, vol, page].filter(Boolean), ', ')),
          doi && `https://doi.org/${doi}`,
        ]);
      }
      if (shape === 'chapter') {
        return join([head, endStop(title), endStop(join([container && `In ${container}`, page && `(pp. ${page})`])), endStop(publisher)]);
      }
      if (shape === 'webpage') {
        return join([head, endStop(title), container && endStop(container), url]);
      }
      return join([head, endStop(join([title, edition && `(${edition} ed.)`])), endStop(publisher)]);
    }

    case 'mla': {
      const y = year === 'no date' ? 'n.d.' : year;
      if (shape === 'journal') {
        return join([
          endStop(author),
          title && `"${endStop(title)}"`,
          endStop(join([container, volume && `vol. ${volume}`, issue && `no. ${issue}`, y, page && `pp. ${page}`].filter(Boolean), ', ')),
        ]);
      }
      if (shape === 'chapter') {
        return join([endStop(author), title && `"${endStop(title)}"`, endStop(join([container, publisher, y, page && `pp. ${page}`].filter(Boolean), ', '))]);
      }
      if (shape === 'webpage') {
        return join([
          endStop(author),
          title && `"${endStop(title)}"`,
          endStop(join([container, longDate(csl.issued) || y, url].filter(Boolean), ', ')),
        ]);
      }
      return join([endStop(author), endStop(title), endStop(join([publisher, y].filter(Boolean), ', '))]);
    }

    // Vancouver: no brackets round the year, minimal punctuation, journal after the title.
    case 'vancouver': {
      const y = year === 'no date' ? '' : year;
      if (shape === 'journal') {
        // ICMJE puts a full stop after the journal title, then the year runs straight into
        // the volume: "Nature. 2013;500(7460):54-58."
        const tail = join([y && `${y};`, volume, issue && `(${issue})`, page && `:${page}`], '');
        return join([endStop(author), endStop(title), join([endStop(container), tail && endStop(tail)], ' ')]);
      }
      if (shape === 'webpage') {
        return join([endStop(author), endStop(title), container && endStop(container), y && endStop(y), url && `Available from: ${url}`]);
      }
      return join([endStop(author), endStop(title), endStop(join([place, publisher], ': ')), y && `${y}.`]);
    }

    case 'chicago': {
      const y = year === 'no date' ? 'n.d.' : year;
      if (shape === 'journal') {
        return join([
          endStop(author),
          `${y}.`,
          title && `"${endStop(title)}"`,
          endStop(join([container, volume, issue && `(${issue})`, page && `: ${page}`].filter(Boolean), ' ').replace(' : ', ': ')),
        ]);
      }
      if (shape === 'chapter') {
        return join([endStop(author), `${y}.`, title && `"${endStop(title)}"`, endStop(join([container && `In ${container}`, page && `, ${page}`], '')), endStop(join([place, publisher], ': '))]);
      }
      if (shape === 'webpage') {
        return join([endStop(author), `${y}.`, endStop(title), container && endStop(container), url && `${url}.`]);
      }
      return join([endStop(author), `${y}.`, endStop(title), endStop(join([place, publisher], ': '))]);
    }
  }
}

// ---------------------------------------------------------------------------
// the in-text citation
// ---------------------------------------------------------------------------

/**
 * What goes in the sentence. Vancouver is numeric and therefore depends on the source's
 * POSITION in the reference list, which a single source cannot know - so the caller passes
 * its number, and without one it renders as `[?]` rather than as a confident wrong number.
 */
export function formatInText(csl: Csl, style: StyleId, number?: number): string {
  if (style === 'vancouver') return number ? `[${number}]` : '[?]';
  const who = surnames(csl.author, style) || surnames(csl.editor, style) || str(csl.title) || 'Anon.';
  const year = yearOrNone(csl, style);
  const y = style === 'harvard' ? year : year === 'no date' ? 'n.d.' : year;
  if (style === 'mla') return `(${who})`;
  if (style === 'chicago') return `(${who} ${y})`;
  return `(${who}, ${y})`;
}

// ---------------------------------------------------------------------------
// honesty
// ---------------------------------------------------------------------------

/** CSL variables each shape needs before its reference is complete in any style. */
const REQUIRED: Record<Shape, { csl: string; label: string }[]> = {
  journal: [
    { csl: 'author', label: 'author' },
    { csl: 'title', label: 'title' },
    { csl: 'container-title', label: 'journal' },
    { csl: 'issued', label: 'year' },
  ],
  chapter: [
    { csl: 'author', label: 'author' },
    { csl: 'title', label: 'chapter title' },
    { csl: 'container-title', label: 'book title' },
    { csl: 'issued', label: 'year' },
    { csl: 'publisher', label: 'publisher' },
  ],
  book: [
    { csl: 'author', label: 'author' },
    { csl: 'title', label: 'title' },
    { csl: 'issued', label: 'year' },
    { csl: 'publisher', label: 'publisher' },
  ],
  webpage: [
    { csl: 'title', label: 'title' },
    { csl: 'URL', label: 'link' },
    { csl: 'issued', label: 'year' },
  ],
};

/**
 * What this reference is still short of.
 *
 * The formatter above renders whatever it has, which is right - a partial reference is
 * more use than none. But it must not LOOK finished when it is not, and a student reading
 * a tidy-looking line has no way to tell. This is what the UI says next to it.
 */
/**
 * Names stored as ONE string, which no style can invert.
 *
 * OpenLibrary has no split name to give: an ISBN lookup returns "Fyodor Mikhaylovich
 * Dostoyevsky" as a single value, so it is stored as a CSL `literal`. A literal is written
 * out exactly as it is - which is correct and required for "World Health Organization", and
 * wrong for a person, who every style here wants filed as "Dostoyevsky, F.M.".
 *
 * The tempting fix is to guess: split on the last space when it looks like a person. That
 * guess is confidently wrong on "Penguin Random House" and on every mononym and every name
 * whose family part comes first, and a citation tool being confidently wrong about an
 * author's name is the exact failure mode this feature exists to refuse. So it is REPORTED
 * instead, next to the reference, where the student - who knows whether their source was
 * written by a person - can fix it in one edit.
 */
export function unsplitNames(csl: Csl): string[] {
  const from = (v: unknown) =>
    (Array.isArray(v) ? v : [])
      .map((n) => (n && typeof n === 'object' ? (n as { literal?: string }).literal : undefined))
      // A single word cannot be inverted anyway, so there is nothing to report.
      .filter((s): s is string => Boolean(s && s.trim().includes(' ')));
  return [...from(csl.author), ...from(csl.editor)];
}

export function missingFor(csl: Csl): string[] {
  const shape = shapeOf(csl);
  return REQUIRED[shape]
    .filter(({ csl: key }) => {
      const v = csl[key];
      return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
    })
    .map((f) => f.label);
}
