// The desktop app, on the landing page.
//
// It lives here rather than only behind the nav link because a download nobody is told about
// is a download nobody takes. But it sits AFTER the product has argued for itself: somebody
// who has not decided they want the notebook does not care which window it opens in.
//
// The band deliberately does not repeat the whole /download page. Its job is to say the app
// exists, name the three things it actually adds, and get out of the way - the install notes,
// the Intel build and the unsigned-build warnings all live on the page it links to, because
// they are answers to questions a visitor only has once they have decided.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { PLATFORMS, detectPlatform, type PlatformId } from '../../download/downloads';

// Three, and no more. The honest list is short, and padding it out with things the browser
// also does is how a download page starts lying - see the note below about offline.
const ADDS = [
  {
    title: 'Its own window',
    body: 'A taskbar icon and a Dock entry, so switching to your notes is one gesture rather than hunting a tab among nineteen.',
  },
  {
    title: 'Opens without a browser',
    body: 'Click the icon and you are in the notebook. No new tab, no address bar.',
  },
  {
    title: 'Updates itself',
    body: 'It checks on launch and installs quietly in the background. You download an installer once.',
  },
];

export default function DesktopBand() {
  // Detection runs in an effect, not during render. The landing page is one of two documents
  // Vite builds, and reading `navigator` while rendering would be a hydration hazard the day
  // this page is ever prerendered - which is exactly the trick /download already uses.
  const [platform, setPlatform] = useState<PlatformId | null>(null);
  useEffect(() => setPlatform(detectPlatform()), []);

  const primary = platform ? PLATFORMS[platform] : null;

  return (
    <section className="mkt-desk" id="desktop">
      <div className="mkt-desk__inner">
        <div className="mkt-desk__copy">
          <p className="mkt-eyebrow mkt-reveal">Also a desktop app</p>
          <h2 className="mkt-desk__title mkt-reveal" data-reveal-delay="70">
            Or keep it out of the browser entirely.
          </h2>
          <p className="mkt-desk__lede mkt-reveal" data-reveal-delay="120">
            Unote installs on Windows and macOS. Same account, same notes, same everything - it is
            a preference about where the app lives, not a different product.
          </p>

          <div className="mkt-desk__cta mkt-reveal" data-reveal-delay="180">
            {/* The detected platform leads. Before the effect settles, and on anything we cannot
                identify, the neutral link to /download is the whole call to action - which is
                also the correct answer for a phone, where neither installer is any use. */}
            {primary && (
              <a className="mkt-btn mkt-btn--primary mkt-btn--lg" href={primary.url}>
                Download for {primary.name}
              </a>
            )}
            <Link
              className={primary ? 'mkt-btn mkt-btn--quiet mkt-btn--lg' : 'mkt-btn mkt-btn--primary mkt-btn--lg'}
              to="/download"
            >
              {primary ? 'All downloads' : 'See the downloads'}
            </Link>
          </div>

          {/* Said here, not only on /download. The service worker means the browser version works
              offline too, so selling offline as the reason to install would be a claim the product
              disproves the first time somebody shuts a laptop on a train. */}
          <p className="mkt-desk__note mkt-reveal" data-reveal-delay="220">
            Both work offline. Free, and it stays free.
          </p>
        </div>

        <ul className="mkt-desk__list">
          {ADDS.map((a, i) => (
            <li className="mkt-desk__item mkt-reveal" data-reveal-delay={140 + i * 70} key={a.title}>
              <h3 className="mkt-desk__item-title">{a.title}</h3>
              <p className="mkt-desk__item-body">{a.body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
