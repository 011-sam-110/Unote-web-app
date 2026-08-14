// The page's one authored moment: a week of the product, demonstrated rather than listed.
//
// Everywhere else on this landing page, motion is scroll-TRIGGERED - a section crosses a
// threshold and plays its own short sequence. That is the right register for a feature
// card. It is the wrong register for the product's central claim, which is not "here are
// seven capabilities" but "these seven things are one loop, and the loop is a week".
//
// So this section is scroll-LINKED. One editor frame stays pinned while the page keeps
// scrolling, and the scroll drives the frame through five states: the lecture goes in on
// Monday, the notes get written, the links resolve, a passage becomes a flashcard, and on
// Friday the card comes back. Scroll up and it runs backwards, because the reader is
// dragging a playhead, not tripping a switch.
//
// It reuses ProductShot rather than drawing a second replica. That is deliberate: the
// thing being walked through must be recognisably the SAME editor the hero showed, or the
// walkthrough is illustrating something the visitor has not been shown.
//
// WHAT HAPPENS WHEN IT CANNOT RUN, which is most of the design work here.
//
// Below 861px, under prefers-reduced-motion, and on any render before the hook has armed,
// useScrollProgress reports nothing. The section then renders as an ordinary stacked list
// of the five moments with the finished editor beneath it - every word readable, nothing
// pinned, nothing blank. A pinned section that degrades to four empty screens is the
// standard way this technique fails; the `is-pinned` gate makes that unreachable here
// rather than merely unlikely, because the pinned styles do not exist until the hook says
// it is driving.
//
// Note on the no-JavaScript case, which useReveals.ts also claims and which is worth
// stating accurately: this is a client-rendered SPA with an empty #root, so without
// JavaScript there is no page at all, not a degraded one. The gate here is not protection
// against that - it is protection against the hook arming and then not running, which is
// the case that would otherwise leave real copy invisible.
import { useRef } from 'react';
import ProductShot from './ProductShot';
import useScrollProgress from '../useScrollProgress';

/** The five moments. These pair with AT in ProductShot.tsx - index here is the step there,
 *  and the two have to be changed together or the caption will describe a frame that is
 *  not on screen. */
const STEPS = [
  {
    day: 'Monday',
    title: 'The lecture goes in',
    body: 'Drop in the recording. It comes back as slides and a timestamped transcript, processed in your browser - the video never leaves your machine.',
  },
  {
    day: 'Tuesday',
    title: 'You write the notes',
    body: 'Type into the same note the lecture landed in. Callouts, tables, equations and code blocks, without leaving the keyboard.',
  },
  {
    day: 'Wednesday',
    title: 'The notes find each other',
    body: 'Write [[Dijkstra]] and it resolves. This note now knows which other notes point at it, and says so in the margin.',
  },
  {
    day: 'Thursday',
    title: 'A flashcard, in your own words',
    body: 'Highlight the passage that actually matters and make it a card there and then, without breaking out of the note to do it.',
  },
  {
    day: 'Friday',
    title: 'Revision you already wrote',
    body: 'The card comes back on an SM-2 schedule. The ones you keep getting wrong come back sooner, and none of it was written twice.',
  },
];

export default function WeekSpine() {
  const track = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const { armed, progress } = useScrollProgress(track, stage);

  // Equal bands, which is the arithmetic the reader can feel: five moments, five fifths of
  // the pin. progress hits exactly 1 at the release, so the floor is clamped rather than
  // allowed to reach a sixth step that does not exist.
  const step = Math.min(STEPS.length - 1, Math.floor(progress * STEPS.length));

  return (
    <section className={`mkt-spine${armed ? ' is-pinned' : ''}`} id="week">
      <header className="mkt-spine__head mkt-reveal">
        <h2 className="mkt-section-title">The whole week, from the lecture hall to the exam.</h2>
        <p className="mkt-section-lede">
          Not seven separate tools that happen to share a login. One note, five days, and the
          revision falls out of the writing you already did.
        </p>
      </header>

      <div className="mkt-spine__track" ref={track}>
        <div className="mkt-spine__stage" ref={stage}>
          <div className="mkt-spine__grid">
            {/* Real text, always in the DOM. While pinned the inactive moments are
                transparent rather than removed, so find-in-page still finds them and a
                screen reader still narrates the whole week in order. */}
            <ol className="mkt-spine__steps">
              {STEPS.map((s, i) => (
                <li
                  key={s.day}
                  className={`mkt-spine__step${armed && i === step ? ' is-on' : ''}`}
                  aria-current={armed && i === step ? 'step' : undefined}
                >
                  <span className="mkt-spine__day">{s.day}</span>
                  <h3 className="mkt-spine__step-title">{s.title}</h3>
                  <p className="mkt-spine__step-body">{s.body}</p>
                </li>
              ))}
            </ol>

            <div className="mkt-spine__frame">
              {/* Un-armed, no step is passed at all and the replica renders its finished
                  state - the same thing the hero shows. */}
              <ProductShot step={armed ? step : undefined} />
            </div>
          </div>

          {/* The continuously scrubbed element, and the one that makes the section legible
              as linked rather than merely stepped: the fill tracks the playhead every
              frame, while the ticks snap to their band. */}
          <div className="mkt-spine__progress" aria-hidden="true">
            <div className="mkt-spine__progress-track">
              <div
                className="mkt-spine__progress-fill"
                style={{ transform: `scaleX(${armed ? progress : 1})` }}
              />
            </div>
            <div className="mkt-spine__ticks">
              {STEPS.map((s, i) => (
                <span
                  key={s.day}
                  className={`mkt-spine__tick${!armed || i <= step ? ' is-on' : ''}`}
                >
                  {s.day.slice(0, 3)}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
