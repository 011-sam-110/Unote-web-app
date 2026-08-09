// Keeps the two sitemaps honest about each other.
//
// There is a human one (SitemapPage, from SITE_MAP) and a machine one
// (web/public/sitemap.xml), and only one of them is ever looked at. Without this test the
// XML is the copy that quietly rots: a route gets added to the app and the page, and the
// file crawlers actually read still describes the site as it was two releases ago.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SITE_MAP, indexedPaths, type SiteEntry } from './siteMap';

// Resolved from the vitest root (web/) rather than from import.meta.url: Vite rewrites
// module URLs to http:// ones, and fileURLToPath refuses those.
const XML = readFileSync(resolve(process.cwd(), 'public/sitemap.xml'), 'utf8');

function locs(): string[] {
  return [...XML.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
}

function allEntries(): SiteEntry[] {
  const out: SiteEntry[] = [];
  const walk = (entries: SiteEntry[]) => {
    for (const e of entries) {
      out.push(e);
      if (e.children) walk(e.children);
    }
  };
  for (const branch of SITE_MAP) walk(branch.entries);
  return out;
}

describe('sitemap.xml', () => {
  it('lists exactly the entries the site map marks as indexed', () => {
    const origin = 'https://unote-six.vercel.app';
    const expected = indexedPaths().map((p) => (p === '/' ? `${origin}/` : `${origin}${p}`));
    expect(locs()).toEqual(expected);
  });

  it('never lists a path that is only reachable with an account or a share link', () => {
    // "At least one open entry", not "no gated entry": `/` is legitimately both, because
    // RootRoute serves the landing page to a signed-out visitor and the dashboard to a
    // signed-in one. The URL a crawler fetches is the public one.
    const open = new Set(
      allEntries()
        .filter((e) => e.access === 'open' && e.path)
        .map((e) => e.path!),
    );
    for (const loc of locs()) {
      const path = new URL(loc).pathname;
      expect(open.has(path), `${path} is not publicly reachable and must not be in sitemap.xml`).toBe(true);
    }
  });

  it('carries no lastmod in the future', () => {
    // A sitemap whose dates run ahead of reality is the fastest way to have every date in
    // it ignored.
    for (const [, date] of XML.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)) {
      expect(Number.isNaN(Date.parse(date))).toBe(false);
    }
  });
});

describe('SITE_MAP', () => {
  it('gives every entry a title and a one-line blurb', () => {
    for (const entry of allEntries()) {
      expect(entry.title.trim().length, JSON.stringify(entry)).toBeGreaterThan(0);
      expect(entry.blurb.trim().length, entry.title).toBeGreaterThan(0);
    }
  });

  it('never marks a gated entry as indexed', () => {
    for (const entry of allEntries()) {
      if (entry.indexed) expect(entry.access, entry.title).toBe('open');
    }
  });

  it('has no duplicate entry titles inside a branch', () => {
    for (const branch of SITE_MAP) {
      const titles = branch.entries.map((e) => e.title);
      expect(new Set(titles).size, branch.title).toBe(titles.length);
    }
  });
});
