/**
 * A DOI resolves to CSL-JSON directly, by content negotiation at doi.org.
 *
 * This was measured before it was designed around: `Accept: application/vnd.citationstyles.csl+json`
 * against https://doi.org/<doi> answers 200 with that content type and a complete CSL item.
 * Two consequences worth stating, because both remove work:
 *   - there is NO mapping layer for any DOI-bearing source; the registry speaks the format
 *     citeproc-js consumes
 *   - it is not Crossref-specific. doi.org fronts DataCite and mEDRA too, so datasets and
 *     theses with DOIs resolve through the same path
 *
 * The payload carries no `id`, which citeproc requires - the caller assigns one.
 */
import { userAgent } from '../safeFetch.js';
import { missingFrom, type ResolveResult } from '../resolveResult.js';

export async function resolveDoi(doi: string): Promise<ResolveResult> {
  const url = `https://doi.org/${doi}`;
  let res: Response;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      headers: { Accept: 'application/vnd.citationstyles.csl+json', 'User-Agent': userAgent() },
    });
  } catch {
    return { found: false, registry: 'doi.org', missing: [], reason: 'could not reach doi.org' };
  }

  if (res.status === 404) {
    return { found: false, registry: 'doi.org', missing: [], reason: 'this DOI did not resolve' };
  }
  if (!res.ok) {
    return { found: false, registry: 'doi.org', missing: [], reason: `could not reach doi.org (${res.status})` };
  }

  let csl: Record<string, unknown>;
  try {
    csl = (await res.json()) as Record<string, unknown>;
  } catch {
    return { found: false, registry: 'doi.org', missing: [], reason: 'doi.org returned something unreadable' };
  }

  return { found: true, csl, registry: 'doi.org', missing: missingFrom(csl) };
}
