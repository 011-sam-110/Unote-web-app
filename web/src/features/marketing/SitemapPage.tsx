// The public sitemap at /sitemap - the whole product on one page.
//
// A note app is almost entirely behind a login, which makes it hard to answer "what is
// actually in this thing?" without signing up first. This page answers it: every surface,
// what it does in one line, and whether it needs an account. The parts that are behind the
// login are listed as text rather than links, because a link that bounces a signed-out
// visitor to /login is worse than no link.
//
// It reads from siteMap.ts, which sitemap.test.ts also checks web/public/sitemap.xml
// against, so the page a person reads and the file a crawler reads cannot drift apart.
//
// It reuses .mkt - the landing page's paper palette, committed to light in both themes -
// so arriving here from the footer does not feel like leaving the site.
import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import MarketingNav from './sections/MarketingNav';
import MarketingFooter from './sections/MarketingFooter';
import { SITE_MAP, type SiteEntry } from './siteMap';
import useReveals from './useReveals';
import './marketing.css';
import './sitemap.css';

const ACCESS_LABEL: Record<SiteEntry['access'], string | null> = {
  open: null, // the default; a badge on almost every row would stop meaning anything
  account: 'Needs an account',
  link: 'Link holders only',
};

/** The one access level a branch's entries all share, or null if they differ.
 *
 *  Two of these branches are gated end to end, and badging all eleven of their rows
 *  individually turned the badge into wallpaper - the eye stops reading a mark that is on
 *  everything. Uniform branches state it once, in the heading; only a branch that genuinely
 *  mixes levels (In and out, where a share link is not the same as an account) badges its
 *  rows. */
function uniformAccess(entries: SiteEntry[]): SiteEntry['access'] | null {
  const seen = new Set<SiteEntry['access']>();
  const walk = (list: SiteEntry[]) => {
    for (const e of list) {
      seen.add(e.access);
      if (e.children) walk(e.children);
    }
  };
  walk(entries);
  return seen.size === 1 ? [...seen][0] : null;
}

function Leaf({ entry, depth, showBadge }: { entry: SiteEntry; depth: number; showBadge: boolean }) {
  const badge = showBadge ? ACCESS_LABEL[entry.access] : null;
  // Only 'open' entries get a real link. A path is still SHOWN for the others - knowing a
  // note lives at /note/:id is part of understanding the shape of the app - but it is
  // rendered as the address it is rather than as an invitation to a redirect.
  const linked = entry.access === 'open' && entry.path;

  return (
    <li className={`smap-leaf smap-leaf--d${depth}`}>
      <div className="smap-leaf__row">
        <span className="smap-leaf__tick" aria-hidden="true" />
        <div className="smap-leaf__body">
          <p className="smap-leaf__head">
            {linked ? (
              <Link className="smap-leaf__link" to={entry.path!}>
                {entry.title}
              </Link>
            ) : (
              <span className="smap-leaf__name">{entry.title}</span>
            )}
            {entry.path && !linked && <code className="smap-leaf__path">{entry.path}</code>}
            {badge && <span className={`smap-badge smap-badge--${entry.access}`}>{badge}</span>}
          </p>
          <p className="smap-leaf__blurb">{entry.blurb}</p>
        </div>
      </div>
      {entry.children && (
        <ul className="smap-leaves smap-leaves--nested">
          {entry.children.map((child) => (
            <Leaf key={child.title} entry={child} depth={depth + 1} showBadge={showBadge} />
          ))}
        </ul>
      )}
    </li>
  );
}

export default function SitemapPage() {
  const root = useRef<HTMLDivElement>(null);
  const armed = useReveals(root);

  // The landing page owns the document title for "/", and react-router does not restore
  // one on navigation, so a visitor arriving here from the footer would otherwise keep the
  // home page's title in their tab and their history.
  useEffect(() => {
    const previous = document.title;
    document.title = 'Sitemap · Unote';
    return () => {
      document.title = previous;
    };
  }, []);

  return (
    <div className={`mkt${armed ? ' is-armed' : ''}`} ref={root}>
      <MarketingNav />
      <main id="main" className="smap">
        <header className="smap-head">
          <div className="smap-head__inner">
            <p className="smap-eyebrow mkt-reveal">Sitemap</p>
            <h1 className="smap-title mkt-reveal" data-reveal-delay="60">
              Everything in Unote, <em>on one page</em>.
            </h1>
            <p className="smap-lede mkt-reveal" data-reveal-delay="120">
              Most of a notes app lives behind a login, which makes it hard to know what you are signing
              up for. This is the whole shape of it - what each part does, and what it costs you to reach.
            </p>
            <div className="smap-head__cta mkt-reveal" data-reveal-delay="180">
              <Link className="mkt-btn mkt-btn--primary" to="/try">
                Start writing, it&apos;s free
              </Link>
              <Link className="smap-head__alt" to="/">
                ← Back to the home page
              </Link>
            </div>
          </div>
        </header>

        <div className="smap-branches">
          {SITE_MAP.map((branch, i) => {
            const shared = uniformAccess(branch.entries);
            const sharedLabel = shared ? ACCESS_LABEL[shared] : null;
            return (
              <section
                key={branch.id}
                className="smap-branch mkt-reveal"
                data-reveal-delay={String(Math.min(i, 3) * 60)}
                aria-labelledby={`smap-${branch.id}`}
              >
                <div className="smap-branch__head">
                  <span className="smap-branch__index" aria-hidden="true">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <div>
                    <h2 className="smap-branch__title" id={`smap-${branch.id}`}>
                      {branch.title}
                      {sharedLabel && <span className={`smap-badge smap-badge--${shared}`}>{sharedLabel}</span>}
                    </h2>
                    <p className="smap-branch__blurb">{branch.blurb}</p>
                  </div>
                </div>
                <ul className="smap-leaves">
                  {branch.entries.map((entry) => (
                    <Leaf key={entry.title} entry={entry} depth={0} showBadge={!shared} />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>

        <p className="smap-foot-note">
          Looking for the machine-readable one? It is at{' '}
          <a href="/sitemap.xml">/sitemap.xml</a>.
        </p>
      </main>
      <MarketingFooter />
    </div>
  );
}
