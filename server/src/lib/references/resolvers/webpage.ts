/**
 * Websites: the type students cite most and the only one with no registry behind it.
 *
 * Metadata comes from the page's own head. That makes the quality variable, which is
 * exactly why the "what we found / what we still need" split matters more here than
 * anywhere else - a page that publishes no author gets `author` in `missing`, not a
 * plausible guess.
 *
 * All fetching goes through safeFetch. This module must never call `fetch` directly: the
 * URL is user-supplied by definition, and this is the one resolver where that is true.
 */
import { safeFetch, SsrfBlocked } from '../safeFetch.js';
import { missingFrom, type ResolveResult } from '../resolveResult.js';

function meta(html: string, attr: 'property' | 'name', key: string): string | undefined {
  const re = new RegExp(`<meta[^>]+${attr}=["']${key}["'][^>]*content=["']([^"']+)["']`, 'i');
  const alt = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*${attr}=["']${key}["']`, 'i');
  return re.exec(html)?.[1] ?? alt.exec(html)?.[1];
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .trim();
}

function dateParts(d: Date): { 'date-parts': number[][] } {
  return { 'date-parts': [[d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]] };
}

export async function resolveWebpage(url: string, now: Date = new Date()): Promise<ResolveResult> {
  const registry = 'webpage';
  let res;
  try {
    res = await safeFetch(url);
  } catch (err) {
    // Deliberately does NOT include the message: an SSRF reason can name an internal
    // address, and the verdict text is what an attacker reads back.
    if (err instanceof SsrfBlocked) {
      return { found: false, registry, missing: [], reason: 'that link cannot be fetched' };
    }
    return { found: false, registry, missing: [], reason: 'that link cannot be fetched' };
  }

  if (!res.ok) {
    return { found: false, registry, missing: [], reason: `the page returned ${res.status}` };
  }

  const html = res.body;
  const title =
    meta(html, 'property', 'og:title') ??
    meta(html, 'name', 'twitter:title') ??
    /<title[^>]*>([^<]+)<\/title>/i.exec(html)?.[1];
  const site = meta(html, 'property', 'og:site_name');
  const author = meta(html, 'name', 'author') ?? meta(html, 'property', 'article:author');
  const published =
    meta(html, 'property', 'article:published_time') ??
    meta(html, 'name', 'date') ??
    meta(html, 'property', 'og:published_time');

  const csl: Record<string, unknown> = { type: 'webpage', URL: res.finalUrl };
  if (title) csl.title = decodeEntities(title);
  if (site) csl['container-title'] = decodeEntities(site);
  if (author) csl.author = [{ literal: decodeEntities(author) }];
  if (published) {
    const d = new Date(published);
    if (!Number.isNaN(d.getTime())) csl.issued = dateParts(d);
  }
  // Accessed is a fact about US, not about the page, so it is always known and always set.
  csl.accessed = dateParts(now);

  return { found: true, csl, registry, missing: missingFrom(csl) };
}
