// The /download page: the desktop app, and an honest account of why you might not want it.
//
// Served from web/download.html rather than as a plain client route, so a crawler that runs
// no JavaScript still gets a real title, description, canonical and JSON-LD. Read the comment
// at the top of that file before moving anything. Everything here is the layer React renders
// on top of it.
//
// It borrows the marketing palette, the nav and the mark deliberately. Somebody arriving from
// the landing page should not be able to tell they have left it, and a download page that
// looks like a different site is a download page people close.
//
// The copy has one rule, and it is the whole reason this page reads the way it does: the
// desktop app is NOT "the offline one". This branch ships a service worker, so the browser
// version works offline as well, and any pitch built on offline is one the product disproves
// the first time somebody tries it. What the app genuinely adds is a window, an icon, a launch
// that does not go through a browser, and an updater. That is the list, so that is the pitch.
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import MarketingNav from '../marketing/sections/MarketingNav';
import Wordmark from '../marketing/Wordmark';
import '../marketing/marketing.css';
import './download.css';

/**
 * Where the installers live. ONE place, so a rename is one edit.
 *
 * GitHub serves a permanent redirect at `/releases/latest/download/<asset>`, but only while
 * the asset name is stable from release to release - which is exactly why electron-builder.yml
 * drops `${version}` from `artifactName`. These strings are pinned to that config: rename an
 * artifact there without renaming it here and the buttons 404. The same URLs appear once more,
 * in the JSON-LD in web/download.html, because a static head cannot import a constant.
 *
 * THREE assets, not two. `Unote-${arch}.${ext}` puts the architecture in the macOS filename,
 * and the release workflow builds both: macos-latest is an Apple silicon runner, so left to
 * itself it would emit the arm64 build alone and every Intel Mac would download something that
 * cannot open. Which of the two a visitor needs is a question the browser cannot answer - the
 * user-agent string says "Intel Mac OS X" on both - so the page asks them rather than guessing.
 */
export const DOWNLOAD_URLS = {
  windows: 'https://github.com/011-sam-110/Folio/releases/latest/download/Unote-Setup.exe',
  macAppleSilicon: 'https://github.com/011-sam-110/Folio/releases/latest/download/Unote-arm64.dmg',
  macIntel: 'https://github.com/011-sam-110/Folio/releases/latest/download/Unote-x64.dmg',
} as const;

/** The two operating systems, which is the choice a visitor can actually be offered. */
type PlatformId = 'windows' | 'mac';

const PLATFORMS: Record<PlatformId, { name: string; url: string; file: string; detail: string }> =
  {
    windows: {
      name: 'Windows',
      url: DOWNLOAD_URLS.windows,
      file: 'Unote-Setup.exe',
      detail: 'Windows 10 and later, 64-bit',
    },
    mac: {
      // The headline macOS button is the Apple silicon build, because that is what almost every
      // Mac sold since 2020 is. Intel is a labelled link beside it rather than a fourth button:
      // it is a smaller question than "which operating system", and it should read that way.
      name: 'macOS',
      url: DOWNLOAD_URLS.macAppleSilicon,
      file: 'Unote-arm64.dmg',
      detail: 'Apple silicon (M1 and later)',
    },
  };

/** Filenames for the meta line, Intel included - everything on the release, named once. */
const ASSETS = [
  { file: 'Unote-Setup.exe', detail: 'Windows' },
  { file: 'Unote-arm64.dmg', detail: 'macOS, Apple silicon' },
  { file: 'Unote-x64.dmg', detail: 'macOS, Intel' },
];

/**
 * Which installer to put first.
 *
 * A convenience and nothing more. Every download stays on the page whatever this returns, and
 * nothing is ever hidden behind it, because every user-agent guess is wrong for somebody - a Mac
 * told to pretend it is Windows, a Chromebook, a phone, a browser that froze its UA string years
 * ago. Getting it wrong should cost a reader one glance at the next button, not the download.
 *
 * Returns null when it genuinely cannot tell, and null renders both platforms as equals rather
 * than guessing on a coin toss.
 */
function detectPlatform(): PlatformId | null {
  if (typeof navigator === 'undefined') return null;

  // userAgentData.platform is the modern signal and is not frozen the way the UA string is.
  // Safari and Firefox do not implement it, so the string stays as the fallback.
  const hint = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
    ?.platform;
  const source = `${hint ?? ''} ${navigator.userAgent}`.toLowerCase();

  if (source.includes('win')) return 'windows';
  if (source.includes('mac')) {
    // An iPad reports itself as a Macintosh and has done since iPadOS 13. It cannot run a .dmg,
    // so offering it one is worse than offering it nothing; maxTouchPoints is the only reliable
    // way to tell the two apart.
    if (navigator.maxTouchPoints > 1) return null;
    return 'mac';
  }
  return null;
}

/** What each OS does to an unsigned build, and precisely how to get past it. */
const WARNINGS: Record<PlatformId, { title: string; body: ReactNode }> = {
  windows: {
    title: 'What Windows will do',
    body: (
      <>
        A blue box saying <strong>Windows protected your PC</strong> the first time you run the
        installer. Click <strong>More info</strong>, then <strong>Run anyway</strong>. It is
        SmartScreen telling you it does not recognise the publisher, not telling you it found
        anything - the installer is not signed with a code-signing certificate, which costs
        around £200 a year.
      </>
    ),
  },
  // UNVERIFIED ON REAL HARDWARE - nobody on this project owns a Mac. This is reasoned from
  // electron-builder 25.x, which skips code signing ENTIRELY when no signing identity is
  // configured rather than signing ad-hoc, plus Apple's documented Gatekeeper behaviour for an
  // unsigned app on Apple silicon. It is deliberately NOT the "right-click, choose Open" advice
  // that every other download page carries: that clears the prompt for an app that is validly
  // signed but not notarised, which this is not, and following it on an unsigned build leaves
  // the user staring at "Unote is damaged" with the page's instructions exhausted. First person
  // with a Mac: run the installer and correct this from what actually happens.
  mac: {
    title: 'What macOS will do',
    body: (
      <>
        Refuse to open it, most likely with{' '}
        <strong>&ldquo;Unote is damaged and can&apos;t be opened&rdquo;</strong>. It is not
        damaged - the build carries no signature at all, and that is what macOS says about an
        unsigned app. Open <strong>System Settings</strong> →{' '}
        <strong>Privacy &amp; Security</strong>, scroll to the security section and choose{' '}
        <strong>Open Anyway</strong>. If that button is not offered, run{' '}
        <code>xattr -cr /Applications/Unote.app</code> in Terminal and open it again. Signing and
        notarising properly needs a paid Apple Developer account.
      </>
    ),
  },
};

/** The three things the desktop app actually gives you that a browser tab does not. */
const ADDITIONS = [
  {
    title: 'Its own window and icon',
    body: 'Unote sits in the taskbar or the Dock under its own name, so switching to your notes is the same gesture as switching to anything else - not hunting for one tab among nineteen.',
  },
  {
    title: 'Opens without a browser',
    body: 'Click the icon and you are in the notebook. No new tab, no address bar, no other seventeen things one keystroke away.',
  },
  {
    title: 'Updates itself',
    body: 'It checks for a new version on launch and installs it quietly in the background, so you download an installer once and never think about it again.',
  },
];

export default function DownloadPage() {
  // Lazily, once. The answer cannot change while the page is open, and reading navigator in a
  // state initialiser keeps it out of module scope where a test importing this file would run
  // it in Node.
  const [detected] = useState(detectPlatform);
  const order: PlatformId[] = detected === 'mac' ? ['mac', 'windows'] : ['windows', 'mac'];

  return (
    // .mkt carries the marketing palette. Same commitment as the landing page: this is the
    // light, paper-and-ink look in both themes, declared locally so the app's tokens neither
    // reach it nor are disturbed by it.
    <div className="mkt">
      <MarketingNav />
      <main id="main">
        <section className="dl-get">
          <div className="dl-get__inner">
            <p className="mkt-eyebrow">Unote for desktop</p>
            <h1 className="dl-get__title">Your notes in a window of their own.</h1>
            <p className="dl-get__lede">
              The same notebook and the same account, opened from the taskbar instead of a
              browser tab. Free, and genuinely optional - the web version below does everything
              this does.
            </p>

            <div className="dl-get__actions">
              {order.map((id, i) => (
                <a
                  key={id}
                  className={`mkt-btn mkt-btn--lg ${
                    detected && i === 0 ? 'mkt-btn--primary' : 'mkt-btn--quiet'
                  }`}
                  href={PLATFORMS[id].url}
                >
                  Download for {PLATFORMS[id].name}
                </a>
              ))}
            </div>

            {/* The Intel build. It is here on every platform, not only when macOS is detected,
                because a Mac owner reading this on a library PC is a real person and the whole
                point of the detection is that it never gates anything. */}
            <p className="dl-get__intel">
              The macOS build is for <strong>Apple silicon (M1 and later)</strong>. On an Intel
              Mac,{' '}
              <a className="dl-get__intel-link" href={DOWNLOAD_URLS.macIntel}>
                download the Intel build
              </a>{' '}
              instead. No browser can tell the two apart, so this is the one question the page
              has to leave with you.
            </p>

            <p className="dl-get__detected">
              {detected ? (
                <>
                  Looks like {PLATFORMS[detected].name} from here. If that is wrong, the other
                  button works just as well - nothing on this page checks what you are running.
                </>
              ) : (
                <>
                  We cannot tell what you are on, so both are here. There is no Linux build yet;
                  the browser version runs anywhere.
                </>
              )}
            </p>
            <p className="dl-get__meta">
              {ASSETS.map((a) => `${a.file} (${a.detail})`).join(' · ')} · always the newest
              release, hosted on GitHub
            </p>

            {/* Before the click, not after it, and for both platforms rather than only the
                detected one - both buttons above are live, so both warnings have to be. A
                student who meets an unexplained "Windows protected your PC" concludes the
                thing is malware and leaves; one who was told to expect it carries on. */}
            <div className="dl-warn">
              <h2 className="dl-warn__title">Neither build is signed yet</h2>
              <p className="dl-warn__lede">
                So your computer will stop you once, in a way that looks alarming and is not.
                Here is what it says and how to get past it. Worth reading before you download,
                rather than after.
              </p>
              <ul className="dl-warn__list">
                {order.map((id) => (
                  <li key={id} className="dl-warn__item">
                    <h3 className="dl-warn__item-title">{WARNINGS[id].title}</h3>
                    <p className="dl-warn__item-body">{WARNINGS[id].body}</p>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section className="dl-adds">
          <div className="mkt-section-head">
            <h2 className="mkt-section-title">What the app actually adds</h2>
            <p className="mkt-section-lede">
              Three things. It is a shorter list than most download pages admit to, and it is
              the whole of the difference.
            </p>
          </div>

          <ul className="dl-adds__list">
            {ADDITIONS.map((a) => (
              <li key={a.title} className="dl-add">
                <h3 className="dl-add__title">{a.title}</h3>
                <p className="dl-add__body">{a.body}</p>
              </li>
            ))}
          </ul>

          {/* The line the rest of the page is built around. Say it here and the reader trusts
              the three claims above; leave it out and the first tunnel they go through on the
              train tells them the page was selling. */}
          <p className="dl-adds__note">
            Not on that list: working offline. Unote in a browser installs a service worker and
            keeps your notes on the device, so a train tunnel, dead campus wifi or a flight costs
            you nothing either way. The desktop app is a different window, not a different set of
            features.
          </p>
        </section>

        <section className="dl-web">
          <div className="dl-web__inner">
            <h2 className="dl-web__title">Or stay in the browser.</h2>
            <p className="dl-web__lede">
              Not the fallback. It is the same product through a different door, and the better
              door if you move between machines or write on a library PC you cannot install
              anything on.
            </p>

            <ul className="dl-web__points">
              <li className="dl-web__point">Nothing to install and nothing to keep updated.</li>
              <li className="dl-web__point">The same account and the same notes as the app.</li>
              <li className="dl-web__point">Works offline, exactly as the desktop app does.</li>
              <li className="dl-web__point">Opens on any machine you happen to be sitting at.</li>
            </ul>

            <div className="dl-web__cta">
              <Link className="mkt-btn mkt-btn--primary mkt-btn--lg" to="/try">
                Start writing, it&apos;s free
              </Link>
              <p className="mkt-close__alt">
                Already have an account? <Link to="/login">Log in</Link>
              </p>
            </div>
          </div>
        </section>
      </main>

      <footer className="mkt-foot">
        <div className="mkt-foot__inner">
          <div className="mkt-foot__top">
            <div className="mkt-foot__brand">
              <Wordmark size={20} />
              <strong>Unote</strong>
            </div>
            <nav className="mkt-foot__links" aria-label="Footer">
              <Link to="/">Home</Link>
              <Link to="/login">Log in</Link>
              <Link to="/try">Start free</Link>
            </nav>
          </div>
          <div className="mkt-foot__bottom">
            <span>© 2026 Unote</span>
            <span>A calmer home for your coursework.</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
