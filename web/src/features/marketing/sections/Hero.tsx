// The hero states the thesis: everything a degree generates, in one place.
//
// The signature element is the highlighter swipe under "degree" - a hand-drawn stroke
// rather than a rounded pill, because a highlighter is the actual instrument of the
// audience's world. It sweeps on once at load and then rests; it never loops.
import { useRef } from 'react';
import { Link } from 'react-router-dom';
import ProductShot from './ProductShot';
import useScrollLink from '../useScrollLink';

export default function Hero() {
  const root = useRef<HTMLElement>(null);

  // Parallax, written as ONE custom property that every layer reads at its own amplitude.
  // start and end are both 0, which is the mapping the hero needs and no other section
  // does: p is 0 at the top of the page and 1 once the hero has fully scrolled past, so
  // the effect is over exactly when the hero is.
  //
  // The value goes straight onto the node rather than into state - see useScrollLink on
  // why a scrubbed number never belongs in a re-render.
  const armed = useScrollLink(
    root,
    (p) => root.current?.style.setProperty('--plx', String(p)),
    { start: 0, end: 0 },
  );

  return (
    <section className={`mkt-hero${armed ? ' is-plx' : ''}`} ref={root}>
      {/* Ambient layer. Two very slow, very faint gradients breathing out of phase, so the
          paper reads as lit by something rather than as a flat fill. It is deliberately
          almost subliminal: anything you can consciously watch on a hero becomes a thing
          competing with the headline. */}
      <div className="mkt-hero__ambience" aria-hidden="true">
        <span className="mkt-hero__lamp" />
        <span className="mkt-hero__lamp mkt-hero__lamp--2" />
      </div>

      <div className="mkt-hero__inner">
        <p className="mkt-eyebrow mkt-reveal">Built for university students</p>

        <h1 className="mkt-hero__title mkt-reveal" data-reveal-delay="70">
          Where your whole{' '}
          <span className="mkt-mark">
            <span className="mkt-mark__word">degree</span>
            <Highlighter />
          </span>{' '}
          comes together.
        </h1>

        <p className="mkt-hero__lede mkt-reveal" data-reveal-delay="140">
          Lecture notes, recordings, flashcards and boards in one place, with optional AI that only
          helps when you ask it to.
        </p>

        {/* The primary button goes STRAIGHT INTO THE EDITOR, not to a signup form. Asking
            for an account before anyone has typed a word is asking them to buy the thing
            unseen; the account is worth making once there is something in it worth keeping,
            and guest mode prompts for one then. Signup has not gone anywhere - the nav
            carries it, and every prompt inside the app leads to it. */}
        <div className="mkt-hero__cta mkt-reveal" data-reveal-delay="210">
          <Link className="mkt-btn mkt-btn--primary mkt-btn--lg" to="/try">
            Start writing, it's free
          </Link>
          {/* Points at the week spine, not the feature grid. The button says "see how it
              works" and the spine is the section that actually shows it working; the grid
              is the parts list you read afterwards. */}
          <a className="mkt-btn mkt-btn--quiet mkt-btn--lg" href="#week">
            See how it works
          </a>
        </div>

        {/* States the trade the button above just made, in the same breath as making it.
            No longer a second link to /try - the button IS that door now, and two routes to
            one place a line apart read as two different offers. */}
        <p className="mkt-hero__trust mkt-reveal" data-reveal-delay="260">
          No account needed to start, and no card. Your writing stays in your browser until you
          make one, and then it comes with you.{' '}
          <Link className="mkt-hero__try" to="/login">
            Already have an account?
          </Link>
        </p>
      </div>

      <ProductShot />
    </section>
  );
}

/** The swipe itself. Two overlapping strokes with uneven, non-parallel edges, so it reads
 *  as something dragged across the page by hand rather than a rectangle with rounded
 *  corners. The ink deliberately fills the viewBox top to bottom: the element is then
 *  positioned once in CSS, instead of the offset being split between here and there. */
function Highlighter() {
  return (
    <svg className="mkt-mark__ink" viewBox="0 0 240 56" preserveAspectRatio="none" aria-hidden="true">
      <path d="M4 12 C 46 3, 96 18, 146 8 S 212 3, 236 11 L 234 48 C 196 40, 148 54, 100 46 S 30 50, 6 45 Z" />
      <path
        className="mkt-mark__ink-top"
        d="M8 29 C 52 23, 98 36, 150 27 S 208 23, 232 29 L 231 44 C 198 38, 148 51, 102 42 S 32 46, 7 41 Z"
      />
    </svg>
  );
}
