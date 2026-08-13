/**
 * Books, via OpenLibrary.
 *
 * Two things here were found by calling the API rather than reading about it, and both are
 * the kind of bug that ships silently:
 *
 * 1. OpenLibrary DOES NOT RETURN AUTHOR NAMES. `/isbn/<isbn>.json` gives
 *    `authors: [{ key: '/authors/OL22242A' }]`. Skip the second request and every book in
 *    the bibliography has no author at all - and nothing errors, so nobody notices until a
 *    reference list is handed in.
 * 2. THE AUTHOR RECORD HAS TWO NAMES. `name` is in the author's own script (Cyrillic, for
 *    the record this was found on) and `personal_name` is the Latin form. Taking `name`
 *    puts another script into an English Harvard reference list - silently wrong output
 *    rather than a crash, which is the harder failure to catch.
 *
 * Unlike a DOI this is NOT CSL-JSON, so there is a mapping. It is deliberately small: only
 * fields OpenLibrary actually supplies are written, and anything absent is reported through
 * `missing` rather than filled in.
 */
import { registryFetch } from '../registryFetch.js';
import { missingFrom, type ResolveResult } from '../resolveResult.js';

interface OlBook {
  title?: string;
  subtitle?: string;
  publishers?: string[];
  publish_date?: string;
  publish_places?: string[];
  number_of_pages?: number;
  authors?: { key: string }[];
}

/** Forgiving lookup for the author round trip: any failure - network, non-2xx, unparseable
 *  body - collapses to `undefined` so a bad author record only costs `author`, never the book. */
async function getJson<T>(url: string): Promise<T | undefined> {
  try {
    const res = await registryFetch(url, { accept: 'application/json' });
    if (!res.ok) return undefined;
    return (await res.json()) as T;
  } catch {
    return undefined;
  }
}

/** OpenLibrary is a user-editable wiki, so `ref.key` on an author reference is third-party
 *  data an attacker can influence, not a value we can trust to still be a same-host path.
 *  This is concatenated onto `https://openlibrary.org` below, and concatenation means a key
 *  that does not begin with `/` relocates the host entirely: `.evil.com/x` produces the host
 *  `openlibrary.org.evil.com`, and `@evil.com/x` produces the host `evil.com` (with
 *  `openlibrary.org` demoted to userinfo). Only a key matching OpenLibrary's documented
 *  `/authors/<id>` shape is used for the lookup; anything else is treated exactly like a
 *  failed lookup - `continue` - so the book is still returned with `author` in `missing`. */
const AUTHOR_KEY_RE = /^\/authors\/[A-Za-z0-9_.-]+$/;

/** OpenLibrary dates are free text ("2003", "March 2003", "2003-03-01"). Only the year is
 *  reliable across the corpus, and a year is what every style needs, so that is all we take. */
function issuedFrom(raw?: string): { 'date-parts': number[][] } | undefined {
  if (!raw) return undefined;
  const year = /(\d{4})/.exec(raw);
  return year ? { 'date-parts': [[Number(year[1])]] } : undefined;
}

export async function resolveIsbn(isbn: string): Promise<ResolveResult> {
  const registry = 'openlibrary.org';

  // Book lookup, unlike the author lookup below, distinguishes WHY it failed: a thrown
  // network/timeout error and a non-404 status both mean the registry could not be reached
  // and say nothing about whether the book exists. Only a genuine 404 means the ISBN is
  // unknown to OpenLibrary. Mirrors doi.ts's shape for the same reason doi.ts has it.
  let res: Response;
  try {
    res = await registryFetch(`https://openlibrary.org/isbn/${isbn}.json`, { accept: 'application/json' });
  } catch {
    return { found: false, registry, missing: [], reason: 'could not reach openlibrary.org' };
  }

  if (res.status === 404) {
    return { found: false, registry, missing: [], reason: 'no book with this ISBN' };
  }
  if (!res.ok) {
    return { found: false, registry, missing: [], reason: `could not reach openlibrary.org (${res.status})` };
  }

  let book: OlBook;
  try {
    book = (await res.json()) as OlBook;
  } catch {
    return { found: false, registry, missing: [], reason: 'openlibrary.org returned something unreadable' };
  }

  // One request per author. Sequential would be N round trips on a multi-author book.
  const authors: { literal: string }[] = [];
  for (const ref of book.authors ?? []) {
    if (!AUTHOR_KEY_RE.test(ref.key)) continue;
    const rec = await getJson<{ name?: string; personal_name?: string }>(`https://openlibrary.org${ref.key}.json`);
    const name = rec?.personal_name ?? rec?.name;
    if (name) authors.push({ literal: name });
  }

  const csl: Record<string, unknown> = { type: 'book', ISBN: isbn };
  const title = [book.title, book.subtitle].filter(Boolean).join(': ');
  if (title) csl.title = title;
  if (authors.length) csl.author = authors;
  const issued = issuedFrom(book.publish_date);
  if (issued) csl.issued = issued;
  if (book.publishers?.length) csl.publisher = book.publishers[0];
  if (book.publish_places?.length) csl['publisher-place'] = book.publish_places[0];
  if (book.number_of_pages) csl['number-of-pages'] = String(book.number_of_pages);

  return { found: true, csl, registry, missing: missingFrom(csl) };
}
