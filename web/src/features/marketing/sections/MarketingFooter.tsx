// The site footer, shared by the landing page and the sitemap.
//
// The section links are the only thing that differs between the two. On the landing page
// they are bare hash fragments, which the browser scrolls to without a navigation. On any
// other page there is no #features to scroll to, so they have to be real links back to
// "/" - and deliberately plain <a> rather than react-router <Link>, because a client-side
// navigation to "/#features" changes the URL and then scrolls nowhere: the router has no
// hash handling, and the target section does not exist until the landing page has mounted.
import { Link } from 'react-router-dom';
import Wordmark from '../Wordmark';

interface MarketingFooterProps {
  /** True on the landing page, where the sections being linked to are on this page. */
  sectionsOnPage?: boolean;
}

const SECTIONS = [
  { hash: '#features', label: 'Features' },
  { hash: '#ai', label: 'AI' },
  { hash: '#maker', label: 'Who made it' },
];

export default function MarketingFooter({ sectionsOnPage = false }: MarketingFooterProps) {
  return (
    <footer className="mkt-foot">
      <div className="mkt-foot__inner">
        <div className="mkt-foot__top">
          <div className="mkt-foot__brand">
            <Wordmark size={20} />
            <strong>Unote</strong>
          </div>
          <nav className="mkt-foot__links" aria-label="Footer">
            {SECTIONS.map((s) => (
              <a key={s.hash} href={sectionsOnPage ? s.hash : `/${s.hash}`}>
                {s.label}
              </a>
            ))}
            <Link to="/sitemap">Sitemap</Link>
            <Link to="/login">Log in</Link>
            <Link to="/signup">Start free</Link>
          </nav>
        </div>
        <div className="mkt-foot__bottom">
          <span>© 2026 Unote</span>
          <span>A calmer home for your coursework.</span>
          <p className="mkt-foot__note">Built by a student, in the open.</p>
        </div>
      </div>
    </footer>
  );
}
