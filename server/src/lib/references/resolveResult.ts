/**
 * What every resolver returns.
 *
 * Its own module rather than a re-export from one of the resolvers: the ISBN and webpage
 * resolvers need this shape too, and importing it from `resolvers/doi.ts` would make them
 * depend on the DOI resolver for a type they otherwise have nothing to do with.
 *
 * `missing` is the honest half of the contract. A registry that does not supply a publisher
 * gets that field LISTED here, never guessed - which is the whole premise of the feature,
 * expressed as a return type rather than as a convention someone has to remember.
 */
export interface ResolveResult {
  found: boolean;
  /** CSL-JSON. Carries no `id` - registries generally don't supply one, and citeproc needs it set. */
  csl?: Record<string, unknown>;
  registry: string;
  /** CSL variables the registry did not supply. Reported, never filled in. */
  missing: string[];
  /** Present only when found === false. Safe to show; never contains a response body. */
  reason?: string;
}

/** What a usable reference generally needs. Absent fields are REPORTED, never filled in. */
const WANTED = ['title', 'author', 'issued', 'container-title', 'publisher'];

export function missingFrom(csl: Record<string, unknown>): string[] {
  return WANTED.filter((k) => {
    const v = csl[k];
    return v === undefined || v === null || (Array.isArray(v) && v.length === 0) || v === '';
  });
}
