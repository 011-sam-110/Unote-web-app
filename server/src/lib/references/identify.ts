/**
 * Decide what the student pasted.
 *
 * The alternative - making them pick "Website / Book / Journal" first - is what every
 * mainstream citation tool does, and it is the step students get wrong: a PDF of a
 * government report is filed as a website about as often as not. Sniffing removes the
 * question. Where the guess is wrong the resolver still returns something editable, and
 * `query` is the honest fallback rather than a failure.
 */

export type IdentifiedKind = 'doi' | 'isbn' | 'url' | 'query';
export interface Identified {
  kind: IdentifiedKind;
  value: string;
}

/** A DOI is "10." then a registrant code, a slash, and a suffix. Deliberately permissive
 *  on the suffix - DOIs legitimately contain almost anything. */
const DOI_RE = /\b(10\.\d{4,9}\/[-._;()/:a-z0-9]+)\b/i;

/** ISBN-10 check: weighted 10..1 mod 11, where 'X' is 10. */
function isbn10Valid(s: string): boolean {
  if (!/^\d{9}[\dX]$/i.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (10 - i) * Number(s[i]);
  const last = s[9].toUpperCase();
  sum += last === 'X' ? 10 : Number(last);
  return sum % 11 === 0;
}

/** ISBN-13 check: alternating 1/3 weights mod 10. */
function isbn13Valid(s: string): boolean {
  if (!/^\d{13}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += Number(s[i]) * (i % 2 === 0 ? 1 : 3);
  return sum % 10 === 0;
}

export function identify(raw: string): Identified {
  const s = raw.trim();
  if (!s) return { kind: 'query', value: '' };

  // DOI first: a doi.org URL is a DOI, not a webpage, and resolving it as a DOI gets us
  // CSL-JSON directly instead of scraping a landing page.
  const doi = DOI_RE.exec(s);
  if (doi) return { kind: 'doi', value: doi[1].replace(/[.,;]+$/, '') };

  // ISBN: only when the check digit actually validates. A 13-digit number that fails the
  // checksum is far more likely to be a phone number or an ID than a mistyped ISBN, and
  // treating it as a query gets the student a search rather than a confusing 404.
  const digits = s.replace(/[-\s]/g, '');
  if (isbn13Valid(digits) || isbn10Valid(digits)) {
    return { kind: 'isbn', value: digits.toUpperCase() };
  }

  if (/^https?:\/\//i.test(s)) return { kind: 'url', value: s };
  // A bare host with a path or a dotted TLD, no scheme. Must not swallow "Smith, J. 2020".
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/i.test(s) && !/\s/.test(s)) {
    return { kind: 'url', value: `https://${s}` };
  }

  return { kind: 'query', value: s };
}
