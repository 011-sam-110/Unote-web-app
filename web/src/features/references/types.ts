// The shapes /api/references speaks, restated for the client.
//
// Deliberately hand-written rather than imported from server/: web and server are separate
// TypeScript projects with separate tsconfigs, and nothing else in web/ reaches across.
// They are checked against the real server in referencesApi.test.ts, which asserts the
// request shapes, and by the resolver flow being exercised against live registries.
//
// The one thing NOT restated here is the source-type catalogue. That is fetched from
// GET /api/references/types at runtime, on purpose: a bundled copy would let the picker
// and the server disagree about what a "journal article" needs, and the disagreement
// would be invisible until a student's reference list came out short a field.

/** CSL-JSON. Values are unknown because CSL is genuinely polymorphic - `issued` is an
 *  object, `author` an array, `volume` a string OR a number depending on the registry. */
export type Csl = Record<string, unknown>;

export type VerdictState = 'verified' | 'unconfirmed' | 'refuted' | 'unreachable';

export interface Verdict {
  state: VerdictState;
  /** Which registry answered, or null when none was asked. */
  registry: string | null;
  /** Human-readable and falsifiable: the basis for the claim, safe to show verbatim. */
  evidence: string;
  /** ISO timestamp, or '' when nothing has ever been checked. */
  checkedAt: string;
}

export interface SourceRecord {
  id: string;
  /** A SourceType id, e.g. 'journal'. */
  kind: string;
  csl: Csl;
  createdAt: string;
  updatedAt: string;
  verdict: Verdict;
}

export type FieldKind = 'text' | 'date' | 'url' | 'number' | 'contributors';

export interface SourceField {
  /** The CSL variable this field writes to. */
  csl: string;
  label: string;
  kind: FieldKind;
  recommended?: boolean;
}

export interface SourceType {
  id: string;
  label: string;
  cslType: string;
  fields: SourceField[];
}

/** A free-text search hit. Every candidate carries a DOI - the server drops any that
 *  does not, because a candidate that cannot be verified later is exactly the citation
 *  this feature exists to prevent. */
export interface Candidate {
  title: string;
  year?: number;
  authors: string[];
  doi: string;
  containerTitle?: string;
}

export type IdentifiedKind = 'doi' | 'isbn' | 'url' | 'query';

export interface ResolveResponse {
  /** What the server decided the query WAS. 'query' means it was a title, not an identifier. */
  kind: IdentifiedKind;
  found: boolean;
  csl?: Csl | null;
  registry?: string;
  /** CSL variables the registry did not supply. Reported, never filled in. */
  missing: string[];
  /** Present only when found === false. Safe to show. */
  reason?: string | null;
  candidates: Candidate[];
}
