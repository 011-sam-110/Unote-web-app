/**
 * Is this source real?
 *
 * DELIBERATELY NOT A LANGUAGE-MODEL CHECK. `server/src/lib/checks.ts` runs one model request
 * per family, so putting a citation check in that catalogue would ask a language model
 * whether a reference exists - asking the fabrication engine to audit its own output, and
 * rendering the answer in a rail students already trust. It would clear invented papers and
 * flag real ones, confidently, in both directions. This resolves against registries instead,
 * following server/src/lib/provenance.ts, which already validates citations deterministically.
 *
 * Four states, and the distinctions between them are the feature:
 *   VERIFIED    a registry answered and its record agrees
 *   UNCONFIRMED nothing to check against, or nothing to compare. NOT an error, and the most
 *               common state by far - most student sources carry no DOI or ISBN
 *   REFUTED     the registry actively contradicts it. The only state that asserts a problem
 *   UNREACHABLE we could not ask. NEVER downgrade this to REFUTED: "your source is fake" and
 *               "I have no signal" are different claims, and conflating them tells a student
 *               their real source is invented because a train went into a tunnel
 */
import { resolveDoi } from './resolvers/doi.js';
import { resolveIsbn } from './resolvers/isbn.js';
import { resolveWebpage } from './resolvers/webpage.js';

export type VerdictState = 'verified' | 'unconfirmed' | 'refuted' | 'unreachable';

export interface Verdict {
  state: VerdictState;
  /** Which registry answered, or null when none was asked. */
  registry: string | null;
  /** Human-readable, falsifiable, and safe to show. Never contains a response body. */
  evidence: string;
  checkedAt: string;
}

/** A reason that means "we could not ask", as opposed to "the answer was no". */
function isUnreachableReason(reason?: string): boolean {
  return Boolean(reason && /could not reach|cannot be fetched|unreadable/i.test(reason));
}

/**
 * Compare titles the way a human would: ignore case, punctuation, and a trailing subtitle -
 * but word-wise, not character-wise. Character-level prefix matching (`x.startsWith(y)`) has
 * no word boundary, so "Cat" would match "Category Theory for Programmers", and stripping the
 * subtitle with `.split(':')[0]` on BOTH titles before comparing hides a substituted subtitle
 * entirely - "Attention: A Cognitive Perspective" and "Attention: A Fabricated Subtitle" both
 * reduce to "attention" and would agree. Comparing word arrays fixes both: the shorter array
 * must be a prefix of the longer ONE WORD AT A TIME, so "attention" alone still matches
 * "attention a cognitive perspective" (legitimate subtitle omission) but "cat" no longer
 * matches "category ..." (differs at word 0) and a substituted subtitle diverges at the word
 * after the shared stem instead of being silently discarded.
 */
function titlesAgree(a: string, b: string): boolean {
  const words = (s: string) =>
    s
      .toLowerCase()
      .replace(/&/g, ' and ') // "Research & Development" vs "Research and Development" is the same title
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
  const x = words(a);
  const y = words(b);
  if (!x.length || !y.length) return true; // nothing to disagree about
  const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x];
  return shorter.every((word, i) => word === longer[i]);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

export async function verifySource(csl: Record<string, unknown>, now: Date = new Date()): Promise<Verdict> {
  const checkedAt = now.toISOString();
  const doi = str(csl.DOI);
  const isbn = str(csl.ISBN);
  const url = str(csl.URL);
  const claimedTitle = str(csl.title);

  if (!doi && !isbn && !url) {
    return {
      state: 'unconfirmed',
      registry: null,
      evidence: 'No DOI, ISBN or link on this source, so there is nothing to check against.',
      checkedAt,
    };
  }

  const result = doi
    ? await resolveDoi(doi)
    : isbn
      ? await resolveIsbn(isbn)
      : await resolveWebpage(url!, now);

  if (!result.found) {
    if (isUnreachableReason(result.reason)) {
      return {
        state: 'unreachable',
        registry: result.registry,
        evidence: `Could not check this source: ${result.reason}.`,
        checkedAt,
      };
    }
    return {
      state: 'refuted',
      registry: result.registry,
      evidence: `${result.registry}: ${result.reason ?? 'no record found'}.`,
      checkedAt,
    };
  }

  const foundTitle = str(result.csl?.title);
  if (claimedTitle && foundTitle && !titlesAgree(claimedTitle, foundTitle)) {
    return {
      state: 'refuted',
      registry: result.registry,
      evidence: `${result.registry} has this identifier under a different title: "${foundTitle}".`,
      checkedAt,
    };
  }

  // Found, and nothing contradicts it. If there was no title to compare we still only got
  // here because an identifier resolved, which is a real check.
  return {
    state: 'verified',
    registry: result.registry,
    evidence: foundTitle
      ? `${result.registry} confirms this record: "${foundTitle}".`
      : `${result.registry} has a record for this identifier.`,
    checkedAt,
  };
}
