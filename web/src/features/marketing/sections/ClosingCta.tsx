// Closing ask, then the footer (which the sitemap page shares - see MarketingFooter).
//
// The four lines under the button are the objections a student actually has at this point
// - cost, lock-in, who can read their work, and whether they have to hand over an email -
// so they are answered here rather than left to a pricing page that does not exist.
//
// The button says the same thing as the hero's. It previously said "Create your account",
// which describes the chore rather than the reward and dropped the price, at the highest-
// intent moment on the page.
import { Link } from 'react-router-dom';
import MarketingFooter from './MarketingFooter';

const ASSURANCES = [
  { title: 'Free to use', body: 'No card, no trial clock, and no feature held back behind a plan.' },
  { title: 'Yours to take', body: 'Export any note as Markdown, whenever you want, with no export fee.' },
  { title: 'Private by default', body: 'Notes are visible to you until you create a share link yourself.' },
  { title: 'Recoverable', body: 'A one-time key at signup means a forgotten password never costs you your notes.' },
];

export default function ClosingCta() {
  return (
    <>
      <section className="mkt-close">
        <div className="mkt-close__inner">
          <h2 className="mkt-close__title mkt-reveal">Start with this week&apos;s lectures.</h2>
          {/* The copy had to move with the button. It used to open with "Make an account",
              which is now the one thing this button does not ask for. */}
          <p className="mkt-close__lede mkt-reveal" data-reveal-delay="70">
            Open a notebook and see whether it holds up against the way you already work. No account
            until you want one, and your writing comes with you when you make it.
          </p>
          <div className="mkt-reveal" data-reveal-delay="140">
            <Link className="mkt-btn mkt-btn--primary mkt-btn--lg" to="/try">
              Start writing, it&apos;s free
            </Link>
            <p className="mkt-close__alt">
              Already have an account? <Link to="/login">Log in</Link>
            </p>
            {/* Second line, below the log-in one, because it is a smaller ask than either.
                Deliberately not a third button: the desktop app is a preference about where
                the notebook opens, and putting it next to the primary would turn the one
                decision this section asks for into two. */}
            <p className="mkt-close__alt">
              Rather have it in its own window? <Link to="/download">Unote for desktop</Link>
            </p>
          </div>

          <ul className="mkt-close__assurances mkt-reveal" data-reveal-delay="200">
            {ASSURANCES.map((a) => (
              <li key={a.title} className="mkt-close__assurance">
                <h3 className="mkt-close__assurance-title">{a.title}</h3>
                <p className="mkt-close__assurance-body">{a.body}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <MarketingFooter sectionsOnPage />
    </>
  );
}
