// Generates web/public/sitemap.xml from the route table below.
//
//   npm run sitemap        (or: node scripts/build-sitemap.mjs)
//
// The old sitemap was hand-maintained and said so, with the condition attached: "if a /learn
// section is ever built, generate this file instead - and make lastmod reflect real edit
// dates, because a sitemap that claims everything changed today is a sitemap Google stops
// trusting." A second indexable page is that moment. So this is the generator, and it keeps
// the other half of the promise too: every lastmod is a git committer date for the files
// that actually render the page. Nothing here reads the clock, so re-running it on an
// unchanged checkout writes the same bytes back.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The one place this side of the app spells out the hostname, so the move to a custom domain
// is a one-line change here. It is not the ONLY place in the repo: web/index.html hard-codes
// it in rel=canonical, og:url, the og/twitter image URLs and the JSON-LD block, and
// web/public/robots.txt repeats it on its absolute Sitemap: line. Change all three together
// or the canonical and the sitemap will disagree about which host is real, which is the one
// mistake in this area that actively costs rankings.
// No trailing slash - every path in the table below supplies its own leading one.
const BASE_URL = 'https://unote-six.vercel.app';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const OUT_FILE = path.join(REPO_ROOT, 'web', 'public', 'sitemap.xml');

// Indexable pages, and the files whose git history dates them.
//
// `sources` is the honest part of this file. lastmod is the newest committer date across
// those paths, so it moves when the page moves and stays put when it does not.
//
// Two paths are deliberately NOT sources for anything:
//   web/src/main.tsx  - routing wiring. It changes when an authenticated route is added,
//                       which is not a change to the landing page.
//   web/index.html    - the shared shell. Listing it would drag every route to the same
//                       date on any head edit, which tells a crawler nothing about which
//                       page actually changed.
const ROUTES = [
  {
    path: '/',
    // The whole feature directory: LandingPage.tsx, its sections, its visuals and its CSS
    // all render this page, and a copy change in sections/Hero.tsx is as real an edit as a
    // change to the page component itself.
    sources: ['web/src/features/marketing'],
  },
  {
    path: '/sitemap',
    // The human-readable map of the app. Its own page component, its stylesheet, and
    // siteMap.ts - the data both this generator's companion test and the page render from.
    // Listing siteMap.ts matters: adding a surface to the map IS an edit to this page, even
    // though SitemapPage.tsx never changes when it happens.
    //
    // Unlike /download this route has no second HTML entry, so a crawler that runs no
    // JavaScript sees index.html's head. It is listed anyway because Google renders, and
    // because a public page absent from the sitemap is the more confusing signal.
    sources: [
      'web/src/features/marketing/SitemapPage.tsx',
      'web/src/features/marketing/siteMap.ts',
      'web/src/features/marketing/sitemap.css',
    ],
  },
  {
    path: '/download',
    // The public download page for the desktop build. It is being written in parallel and
    // has no committed source yet, so both conventional homes are listed - features/<name>/
    // like the marketing page, pages/<Name>Page.tsx like the dashboard. `git log` on a path
    // that has never existed is simply silent, so the wrong guess costs nothing and the
    // right one starts dating this route the moment it is committed. Until one of them
    // lands, the HEAD fallback below applies and announces itself.
    sources: ['web/src/features/download', 'web/src/pages/DownloadPage.tsx'],
  },
];

// Everything public that is NOT in the sitemap, with the reason, because "why is /login
// missing" is the question someone will put to this file in six months. These lines are
// copied into the generated XML rather than kept here, so the answer travels with the
// artefact.
const EXCLUDED = [
  ['/login, /signup, /recover', 'account forms, sent as X-Robots-Tag: noindex from vercel.json'],
  ['/try', 'not a page but an action - loading it starts a guest session, so a crawler that renders JS creates data'],
  ['/capture', 'single-use QR phone-pairing surface, noindex'],
  ['/join/:token', 'unguessable share links, noindex nofollow - listing them defeats the point'],
  [
    '/notebook/:id, /note/:id, /study, /ask, /search, /tags',
    'behind RequireAuth, so a crawler only ever sees the redirect to /login',
  ],
];

const git = (...args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();

// %cs is the committer date as YYYY-MM-DD, which is already the W3C date format sitemaps.org
// asks for. Committer dates and not file mtimes: a fresh clone stamps today on every file,
// and what is deployed is the committed version anyway. The flip side is that uncommitted
// edits do not move a lastmod, which is correct - they are not live yet.
const lastCommitDate = (source) => git('log', '-1', '--format=%cs', '--', source);

// Used only for a route with no committed source. It is a real date - it is when this
// checkout last changed - but it is NOT that page's date, so it is announced on stdout and
// again in the XML rather than quietly substituted. Silence here is how a sitemap ends up
// claiming every page changed today.
const HEAD_DATE = git('log', '-1', '--format=%cs', 'HEAD');

const rows = ROUTES.map((route) => {
  const dated = route.sources
    .map((source) => ({ source, date: lastCommitDate(source) }))
    .filter((hit) => hit.date)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  const newest = dated[0];
  return {
    path: route.path,
    lastmod: newest ? newest.date : HEAD_DATE,
    // How the date was reached, for the console line. A route that fell back says so.
    from: newest ? newest.source : null,
  };
});

const xmlEscape = (value) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const urlBlock = (row) => {
  const caveat = row.from
    ? ''
    : '    <!-- lastmod is the repo HEAD date, not this page\'s: nothing that renders it is committed yet. -->\n';
  return [
    '  <url>',
    caveat + `    <loc>${xmlEscape(BASE_URL + row.path)}</loc>`,
    `    <lastmod>${row.lastmod}</lastmod>`,
    '  </url>',
  ].join('\n');
};

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!--
  GENERATED FILE - do not hand-edit. Run \`npm run sitemap\` after changing which pages are
  public; the route table lives in scripts/build-sitemap.mjs.

  Every lastmod below is the git committer date of the files that render that page, never the
  day this file was written. A sitemap that claims everything changed today is a sitemap
  Google stops trusting.

  No changefreq and no priority. Google has said plainly that it ignores both, and priority
  is meaningless anyway on a site with two indexable pages - it only ever expressed a
  ranking BETWEEN your own URLs. Emitting them would be decoration pretending to be a signal.

  Not listed, on purpose:
${EXCLUDED.map(([routes, reason]) => `    ${routes}\n      ${reason}`).join('\n')}
-->
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${rows.map(urlBlock).join('\n')}
</urlset>
`;

// A well-formedness check, not schema validation: Node ships no XML parser and this script is
// not worth a dependency for one. It catches the failure that actually matters - a malformed
// file that a crawler rejects whole, losing both URLs rather than one - by walking the tags
// and then asserting the shape sitemaps.org 0.9 requires. For a second opinion from a real
// parser, on Windows: powershell -c "[xml](Get-Content web/public/sitemap.xml -Raw)".
function checkSitemap(source) {
  const problems = [];

  if (!source.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')) {
    problems.push('missing or malformed XML declaration on line 1');
  }

  // Drop the declaration and comments before walking, so the "not listed, on purpose" prose
  // is not mistaken for markup.
  const body = source.replace(/<\?xml[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const stack = [];
  let roots = 0;
  let cursor = 0;
  const tagPattern = /<(\/?)([A-Za-z_][\w.:-]*)([^>]*?)(\/?)>/g;
  let match;
  while ((match = tagPattern.exec(body))) {
    const between = body.slice(cursor, match.index);
    cursor = tagPattern.lastIndex;
    if (stack.length === 0 && between.trim()) {
      problems.push(`stray text outside the root element: ${JSON.stringify(between.trim().slice(0, 40))}`);
    }
    const [, closing, name, , selfClosing] = match;
    if (closing) {
      const open = stack.pop();
      if (open !== name) problems.push(`</${name}> closes <${open ?? 'nothing'}>`);
      if (stack.length === 0) roots += 1;
    } else if (selfClosing) {
      if (stack.length === 0) roots += 1;
    } else {
      stack.push(name);
    }
  }
  if (stack.length) problems.push(`unclosed elements: ${stack.join(' > ')}`);
  if (body.slice(cursor).trim()) problems.push('stray text after the root element');
  if (roots !== 1) problems.push(`expected exactly one root element, found ${roots}`);

  // The namespace is not decoration: without it the file is well-formed XML that no crawler
  // recognises as a sitemap.
  if (!/<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/.test(body)) {
    problems.push('urlset is missing the sitemaps.org 0.9 namespace');
  }

  const urls = body.match(/<url>[\s\S]*?<\/url>/g) ?? [];
  if (!urls.length) problems.push('no <url> entries');
  const seen = new Set();
  for (const entry of urls) {
    const loc = /<loc>([^<]*)<\/loc>/.exec(entry)?.[1];
    const lastmod = /<lastmod>([^<]*)<\/lastmod>/.exec(entry)?.[1];
    if (!loc) {
      problems.push('a <url> has no <loc>');
    } else {
      // Cross-host entries are ignored by every crawler and a duplicate is a wasted signal.
      if (!loc.startsWith(`${BASE_URL}/`)) problems.push(`<loc> is not under ${BASE_URL}: ${loc}`);
      if (seen.has(loc)) problems.push(`duplicate <loc>: ${loc}`);
      seen.add(loc);
      try {
        new URL(loc);
      } catch {
        problems.push(`<loc> is not a valid absolute URL: ${loc}`);
      }
    }
    if (!lastmod) problems.push('a <url> has no <lastmod>');
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(lastmod)) problems.push(`<lastmod> is not a W3C date: ${lastmod}`);
  }

  return problems;
}

const problems = checkSitemap(xml);
if (problems.length) {
  console.error('build-sitemap: refusing to write, the generated XML is not valid:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

// LF, deliberately. core.autocrlf normalises on commit anyway, and writing LF means this
// script emits identical bytes on Windows and on CI instead of a line-ending-only diff.
fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
const previous = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, 'utf8') : null;
fs.writeFileSync(OUT_FILE, xml, 'utf8');

for (const row of rows) {
  const provenance = row.from ? `from ${row.from}` : 'FALLBACK: repo HEAD, no committed source yet';
  console.log(`  ${row.path.padEnd(12)} ${row.lastmod}  (${provenance})`);
}
console.log(
  `build-sitemap: ${rows.length} URLs, XML checks passed, ${
    previous === xml ? 'output unchanged' : 'wrote'
  } ${path.relative(REPO_ROOT, OUT_FILE).replace(/\\/g, '/')}`,
);
