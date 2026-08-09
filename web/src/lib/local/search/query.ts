// Running a parsed query against the local mirror.
//
// All six operators the server supports are here - bare terms, "phrases", -excluded,
// tag:, -tag: and notebook: - because a search box that quietly drops an operator when
// the network goes is worse than one that says it cannot search at all: the user gets
// an answer to a question they did not ask and no sign that anything happened.
//
// WHAT IS FAITHFUL
//   * Which notes come back for each operator, and for any combination of them.
//   * archived and tombstoned notes are excluded, as GET /api/search excludes them.
//   * Bare terms match title and content only. NOT tags - the server's tsvector is
//     title + content_text (schema.sql:87-90) and tags live in their own table, so
//     `tag:week3` finds them and a bare `week3` does not. The old local search matched
//     tags too, which was a divergence, not a feature.
//   * A prefix match on the last bareword, which is what lets the quick switcher find
//     something while the user is still mid-word.
//   * Postgres's english stopword list, so `the mitochondria` is not an empty result.
//
// WHAT IS NOT
//   * Ranking order. The server ranks with ts_rank over a weighted tsvector; MiniSearch
//     ranks with BM25. Title is boosted here by the same ratio ts_rank gives weight A
//     over weight B, so the two orders stay close, but they are not the same order and
//     the search page says so.
//   * Stemming. Postgres's english dictionary folds "running" onto "run"; nothing here
//     does, so a query that relies on a suffix change matches on the server and not on
//     this device. Reproducing Snowball would mean another dependency and a second
//     place for the two ends to drift apart. The prefix match on the last term covers
//     the common plural case; the rest is a known gap.
//   * Postgres's stopword DISTANCE inside a phrase. `"cat and dog"` becomes
//     'cat' <2> 'dog' server-side, which also matches "cat or dog"; here the phrase is
//     literal, so it matches "cat and dog" and nothing else. Stricter, and closer to
//     what someone typing quotes around three words is asking for.
import { localDb } from '../db';
import type { LocalNote, LocalNotebook } from '../records';
import type { SearchParsed } from '../../types';
import { ensureSearchIndex } from './index';
import { indexTerm, parseSearchQuery, tokenise } from './parse';

/**
 * ts_rank's default weights are {D,C,B,A} = {0.1, 0.2, 0.4, 1.0}, so a hit in the title
 * counts 2.5x a hit in the body. Matching the ratio is the cheap way to keep the two
 * orderings close without pretending to reimplement ts_rank.
 */
const TITLE_BOOST = 2.5;

/** Characters a token can be made of - the same set cleanToken keeps. */
const WORD_CHAR = "[\\p{L}\\p{N}_'-]";

export interface LocalSearchHit {
  note: LocalNote;
  snippetHtml: string;
  score: number;
}

/** A term the query needs, and whether it may match a longer word starting with it. */
interface Needle {
  text: string;
  prefix: boolean;
}

/**
 * `tags` is a client-side column the sync feed does not carry, so a note pulled from
 * the server for the first time has none. Every read path normalises it; this is that
 * path's copy, and without it the search page throws on `note.tags.slice`.
 */
function withTags(n: LocalNote): LocalNote {
  return Array.isArray(n.tags) ? n : { ...n, tags: [] };
}

/** Strip anything the snippet renderer would treat as markup - it expects plain text
 *  plus the <mark> spans added below. */
function plain(s: string): string {
  return s.replace(/[<>]/g, ' ');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Title and body as one token sequence.
 *
 * Concatenated, and that is deliberate: the server's fts column is
 * `setweight(title) || setweight(content_text)`, and `||` renumbers the second
 * operand's positions to continue the first's. So a phrase entirely inside the title
 * matches, and - as an artefact both ends share - so does one whose first word ends
 * the title and whose second opens the body.
 */
function sequenceOf(n: LocalNote): string[] {
  return tokenise(`${n.title ?? ''}\n${n.contentText ?? ''}`).map((t) => t.toLowerCase());
}

/** Does `words` appear as consecutive tokens in `seq`? */
function hasAdjacent(seq: string[], words: string[]): boolean {
  if (!words.length) return false;
  for (let i = 0; i + words.length <= seq.length; i++) {
    if (words.every((w, j) => seq[i + j] === w)) return true;
  }
  return false;
}

/**
 * A ~12-word window of the note with every match wrapped, mirroring the server's
 * ts_headline options. With nothing to highlight it degrades to the plain opening of
 * the note, which is what the tag:-only branch returns server-side.
 */
function headline(text: string, needles: Needle[]): string {
  const clean = plain(text).replace(/\s+/g, ' ').trim();
  if (!needles.length) return clean.slice(0, 180);

  const sources = needles.map((n) => {
    const words = n.text.split(' ').map(escapeRe);
    // Words inside a phrase are separated by whatever the note has between them.
    return words.join(`[^\\p{L}\\p{N}_'-]+`) + (n.prefix ? `${WORD_CHAR}*` : '');
  });
  const re = new RegExp(`(?<!${WORD_CHAR})(?:${sources.join('|')})(?!${WORD_CHAR})`, 'giu');

  const first = re.exec(clean);
  if (!first) return clean.slice(0, 180);

  const from = Math.max(0, first.index - 60);
  const frame = clean.slice(from, first.index + 120);
  return `${from > 0 ? '…' : ''}${frame.replace(re, (m) => `<mark>${m}</mark>`)}`;
}

/** Notebook ids whose name matches `notebook:`: case-insensitive prefix, live only. */
function notebooksMatching(all: LocalNotebook[], name: string): Set<string> {
  const needle = name.toLowerCase();
  return new Set(
    all
      .filter((nb) => nb.deletedAt === null && nb.name.toLowerCase().startsWith(needle))
      .map((nb) => nb.id),
  );
}

/**
 * Everything the local index can answer, ranked.
 *
 * Returns rows rather than DTOs: the caller already owns the row -> DTO conversion the
 * rest of the app consumes, and a second copy of it here would be a second thing to
 * keep in step with the server's shape.
 */
export async function searchLocal(raw: string, limit = 20): Promise<LocalSearchHit[]> {
  return runParsed(parseSearchQuery(raw), limit);
}

async function runParsed(parsed: SearchParsed, limit: number): Promise<LocalSearchHit[]> {
  const hadText = parsed.terms.length > 0 || parsed.phrases.length > 0;

  // Stopwords are removed by the dictionary on the server, on both the document and
  // the query side. A phrase made of nothing else compiles to an empty tsquery there
  // and drops out of the conjunction, so it drops out here too.
  const terms = parsed.terms.map(indexTerm).filter((t): t is string => t !== null);
  const excluded = parsed.excluded.map(indexTerm).filter((t): t is string => t !== null);
  const phrases = parsed.phrases
    .map((p) => p.split(' ').map((w) => w.toLowerCase()))
    .filter((words) => words.some((w) => indexTerm(w) !== null));

  const hasText = terms.length > 0 || phrases.length > 0;
  const hasFilters = parsed.tags.length > 0 || parsed.excludedTags.length > 0 || parsed.notebook !== null;

  // Two ways to end up with nothing to ask: an empty query, and a query whose only
  // positive criteria dissolved. The server answers both the same way - `fts @@ ''`
  // is false, so a query of nothing but stopwords returns no rows rather than all of
  // them - and returning the whole library here would be a nasty surprise.
  if (!hasText && (hadText || !hasFilters)) return [];

  const notebooks = parsed.notebook !== null
    ? notebooksMatching(await localDb.notebooks.toArray(), parsed.notebook)
    : null;

  let candidates: LocalNote[];
  let scores: Map<string, number> | null = null;

  if (hasText) {
    const mini = await ensureSearchIndex();
    // Phrase words are required as ordinary terms first - MiniSearch has no adjacency,
    // so it narrows the field and the sequence check below decides.
    const phraseWords = phrases.flatMap((p) => p.filter((w) => indexTerm(w) !== null));
    const queryTerms = [...phraseWords, ...terms];
    // Only the final bareword is a prefix, matching the trailing `*` documented in
    // docs/API.md. Terms are pre-filtered above, so the index MiniSearch reports lines
    // up with this array.
    const prefixAt = terms.length ? queryTerms.length - 1 : -1;

    const found = mini.search(queryTerms.join(' '), {
      combineWith: 'AND',
      prefix: (_term, i) => i === prefixAt,
      boost: { title: TITLE_BOOST },
    });
    scores = new Map(found.map((r) => [r.id as string, r.score]));
    // Every match is read, not just the first `limit`, because the tag, notebook and
    // phrase filters below can reject any of them and the limit applies to what
    // survives. The server does the same thing in SQL. It is still far less work than
    // the implementation this replaces, which read every note in the store for every
    // keystroke.
    const rows = await localDb.notes.bulkGet(found.map((r) => r.id as string));
    candidates = rows.filter((n): n is LocalNote => n !== undefined);
  } else {
    // Pure tag:/notebook: browsing, e.g. the Tags page's "search notes ->" link. There
    // is no relevance to rank by, so this is a plain recency listing, as the server's
    // second branch is.
    candidates = await localDb.notes.toArray();
  }

  const needles: Needle[] = [
    ...phrases.map((words) => ({ text: words.join(' '), prefix: false })),
    ...terms.map((t, i) => ({ text: t, prefix: i === terms.length - 1 })),
  ];

  const hits: LocalSearchHit[] = [];
  for (const row of candidates) {
    const note = withTags(row);
    if (note.deletedAt !== null || note.archived === 1) continue;
    if (notebooks && !notebooks.has(note.notebookId)) continue;
    // Every tag: must match and no -tag: may - what the Tags page promises, and what
    // the server's one-JOIN-per-tag does.
    if (parsed.tags.some((t) => !note.tags.includes(t))) continue;
    if (parsed.excludedTags.some((t) => note.tags.includes(t))) continue;

    if (phrases.length || excluded.length) {
      const seq = sequenceOf(note);
      if (phrases.some((words) => !hasAdjacent(seq, words))) continue;
      if (excluded.length) {
        const present = new Set(seq);
        if (excluded.some((e) => present.has(e))) continue;
      }
    }

    hits.push({
      note,
      snippetHtml: headline(note.contentText || note.title, needles),
      score: scores?.get(note.id) ?? 0,
    });
  }

  // ORDER BY rank DESC, updated_at DESC, and recency alone when there is no rank.
  hits.sort((a, b) => b.score - a.score || (a.note.updatedAt < b.note.updatedAt ? 1 : -1));
  return hits.slice(0, limit);
}
