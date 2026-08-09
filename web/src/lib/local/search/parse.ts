// The query grammar, offline.
//
// A PORT of parseSearchQuery in server/src/routes/search.ts, not an import: that
// module pulls in express and the pg pool the moment it loads, so the browser cannot
// have it. What follows is deliberately step-for-step with the original, including
// the order of the two replace() passes - operators are consumed BEFORE phrases there
// because notebook:"Machine Learning" would otherwise have its quotes eaten by the
// phrase pass and fall through as a plain text phrase, silently answering a different
// question. A tidier rewrite on this side is how the two ends start disagreeing about
// what the user typed.
//
// parse.test.ts pins this against the documented grammar. If the server's parser
// moves, that test is what should fail.
import type { SearchParsed } from '../../types';

/**
 * Keeps only letters/digits/underscore/apostrophe/hyphen, then drops the result
 * entirely unless at least one letter or digit survived - this is what stops a
 * stray "-", "'", or punctuation soup from turning into an empty token.
 */
export function cleanToken(raw: string): string {
  const cleaned = raw.normalize('NFKC').replace(/[^\p{L}\p{N}_'-]+/gu, '');
  return /[\p{L}\p{N}]/u.test(cleaned) ? cleaned : '';
}

/**
 * Operator grammar (docs/API.md "Search operators"). Operators are consumed FIRST so a
 * quoted operator value is not mistaken for a phrase, then:
 *   1. "exact phrase"        -> phrase query (adjacent words only)
 *   2. -word                 -> excluded term
 *   3. tag:name / -tag:name  -> every tag: must match, no -tag: may. Case-sensitive.
 *   4. notebook:name         -> notebook name filter, case-insensitive prefix. Quoting
 *      is the only way to express a name containing a space, and Unote's own default
 *      notebook is called "My notes".
 *   5. everything left over  -> barewords, AND'd, with a prefix match on the last
 * Never throws: worst case everything sanitises away to empty, which the caller turns
 * into an empty result set.
 */
export function parseSearchQuery(raw: string): SearchParsed {
  let rest = typeof raw === 'string' ? raw : '';

  const tags: string[] = [];
  const excludedTags: string[] = [];
  let notebook: string | null = null;

  rest = rest.replace(
    /(-?)(tag|notebook):(?:"([^"]*)"|(\S*))/gi,
    (_m, neg: string, key: string, quoted: string | undefined, bare: string | undefined) => {
      const rawValue = (quoted ?? bare ?? '').trim();
      if (!rawValue) return ' ';
      if (key.toLowerCase() === 'tag') {
        const v = cleanToken(rawValue);
        if (v) (neg ? excludedTags : tags).push(v);
      } else if (!neg && notebook === null) {
        // Notebook names carry spaces and punctuation that the alnum-only cleanToken
        // would destroy, so the raw value goes through and the filter is a prefix
        // comparison rather than a token match.
        notebook = rawValue;
      }
      return ' ';
    },
  );

  const phrases: string[] = [];
  rest = rest.replace(/"([^"]*)"/g, (_m, inner: string) => {
    const words = inner.split(/\s+/).map(cleanToken).filter(Boolean);
    if (words.length) phrases.push(words.join(' '));
    return ' ';
  });

  const terms: string[] = [];
  const excluded: string[] = [];

  for (const tok of rest.split(/\s+/).filter(Boolean)) {
    if (tok.startsWith('-') && tok.length > 1) {
      const v = cleanToken(tok.slice(1));
      if (v) excluded.push(v);
      continue;
    }
    const v = cleanToken(tok);
    if (v) terms.push(v);
  }

  return { terms, phrases, excluded, tags, excludedTags, notebook };
}

/**
 * One tokeniser for documents and for queries.
 *
 * It splits on exactly the characters cleanToken strips, so a token the parser
 * produced can always be compared with a token this produced. Two tokenisers - one
 * for indexing, one for querying - is the classic way to build a search box that
 * finds nothing for words that are plainly on the page.
 *
 * It is NOT Postgres's parser. Postgres reads "foo.bar" as a host and keeps it whole;
 * here it becomes two tokens. That divergence is already present on the query side
 * (cleanToken turns "foo.bar" into "foobar"), so neither end matches it today.
 */
export function tokenise(text: string): string[] {
  return text
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}_'-]+/u)
    .filter((t) => /[\p{L}\p{N}]/u.test(t));
}

/**
 * Postgres's english.stop list, which to_tsvector and to_tsquery both apply.
 *
 * Without it the two ends answer differently for any query containing an ordinary
 * English word: the server drops "the" from both the document vector and the query,
 * so `the mitochondria` matches on "mitochondria" alone, while a local index that
 * required every typed word would find nothing. Reproducing the list is cheaper and
 * far more predictable than reproducing the stemmer (see the note in query.ts about
 * what is NOT reproduced).
 */
const STOPWORDS = new Set([
  'i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'ourselves', 'you', 'your', 'yours',
  'yourself', 'yourselves', 'he', 'him', 'his', 'himself', 'she', 'her', 'hers',
  'herself', 'it', 'its', 'itself', 'they', 'them', 'their', 'theirs', 'themselves',
  'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those', 'am', 'is', 'are',
  'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'having', 'do', 'does',
  'did', 'doing', 'a', 'an', 'the', 'and', 'but', 'if', 'or', 'because', 'as', 'until',
  'while', 'of', 'at', 'by', 'for', 'with', 'about', 'against', 'between', 'into',
  'through', 'during', 'before', 'after', 'above', 'below', 'to', 'from', 'up', 'down',
  'in', 'out', 'on', 'off', 'over', 'under', 'again', 'further', 'then', 'once', 'here',
  'there', 'when', 'where', 'why', 'how', 'all', 'any', 'both', 'each', 'few', 'more',
  'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so',
  'than', 'too', 'very', 's', 't', 'can', 'will', 'just', 'don', 'should', 'now',
]);

/**
 * A token as the index stores it, or null when Postgres would have thrown it away.
 *
 * Used for BOTH sides - MiniSearch's processTerm and the query's own term list - so a
 * word that is dropped from a document is dropped from the query that would have
 * needed it.
 */
export function indexTerm(token: string): string | null {
  const lower = token.toLowerCase();
  return STOPWORDS.has(lower) ? null : lower;
}
