/**
 * Title search, so "I only know what it's called" still ends in a verifiable source.
 *
 * Every candidate MUST carry a DOI. A candidate without one cannot be verified later, and
 * offering it would produce exactly the citation this feature exists to prevent: one that
 * looks confirmed because it came out of a search box. Dropping them is the honest choice.
 */
import { registryFetch } from '../registryFetch.js';

export interface Candidate {
  title: string;
  year?: number;
  authors: string[];
  doi: string;
  containerTitle?: string;
}

interface CrossrefItem {
  DOI?: string;
  title?: string[];
  author?: { given?: string; family?: string }[];
  issued?: { 'date-parts'?: number[][] };
  'container-title'?: string[];
}

export async function searchWorks(query: string, rows = 5): Promise<Candidate[]> {
  const url = new URL('https://api.crossref.org/works');
  url.searchParams.set('query.bibliographic', query);
  url.searchParams.set('rows', String(Math.min(Math.max(rows, 1), 20)));
  url.searchParams.set('select', 'DOI,title,author,issued,container-title');

  let payload: { message?: { items?: CrossrefItem[] } };
  try {
    const res = await registryFetch(url.toString(), { accept: 'application/json' });
    if (!res.ok) return [];
    payload = (await res.json()) as typeof payload;
  } catch {
    return [];
  }

  return (payload.message?.items ?? [])
    .filter((it): it is CrossrefItem & { DOI: string } => Boolean(it.DOI))
    .map((it) => ({
      title: it.title?.[0] ?? '(untitled)',
      year: it.issued?.['date-parts']?.[0]?.[0],
      authors: (it.author ?? []).map((a) => [a.given, a.family].filter(Boolean).join(' ')).filter(Boolean),
      doi: it.DOI,
      containerTitle: it['container-title']?.[0],
    }));
}
