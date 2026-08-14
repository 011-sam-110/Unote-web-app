// Where a reference site would run a customer-logo bar, Unote runs the six things it
// replaces. Unote has no customer logos to show, and inventing them is the one thing a
// landing page must never do - so this states the breadth claim honestly instead.
//
// The strike is drawn rather than set as text-decoration, because it is struck ON as the
// row scrolls in: six lines crossing out six apps is the argument, and a decoration
// cannot be animated. The section's own label carries the meaning for anyone who never
// sees the marks.
//
// The strikes used to be scroll-TRIGGERED: entering the viewport started a 500ms keyframe
// with a per-item delay, which ran once and finished whether or not the reader was still
// looking. They are now scroll-LINKED, so the six crossings-out draw under the reader's
// own scrolling and undraw if they scroll back up. The argument is "these get replaced",
// and letting the reader perform the replacing at their own pace is the better version of
// it than showing them a cartoon of it happening.
import { useEffect, useRef } from 'react';
import useScrollLink from '../useScrollLink';

const REPLACES = [
  'Lecture notes',
  'Flashcard decks',
  'Whiteboards',
  'Recordings',
  'PDF scribbles',
  'Revision folders',
];

export default function CapabilityStrip() {
  const root = useRef<HTMLDivElement>(null);
  const strikes = useRef<HTMLElement[]>([]);

  // Collected once. The list is static, and re-querying six nodes on every frame of every
  // scroll is work for nothing.
  useEffect(() => {
    strikes.current = Array.from(
      root.current?.querySelectorAll<HTMLElement>('.mkt-strip__strike') ?? [],
    );
  }, []);

  const armed = useScrollLink(
    root,
    (p) => {
      const list = strikes.current;
      // Each strike gets its own slice of the sweep, and the slices OVERLAP: multiplying
      // by list.length + 1 rather than list.length means a strike starts before its
      // predecessor has finished, so the row reads as one gesture crossing six words
      // rather than as six separate events.
      for (let i = 0; i < list.length; i++) {
        const local = Math.min(1, Math.max(0, p * (list.length + 1) - i));
        list[i].style.transform = `scaleX(${local})`;
      }
    },
    { start: 0.9, end: 0.55 },
  );

  return (
    <section className="mkt-strip" aria-label="What Unote replaces">
      <div className={`mkt-strip__inner mkt-reveal${armed ? ' is-linked' : ''}`} ref={root}>
        <p className="mkt-strip__lead">One app instead of</p>
        <ul className="mkt-strip__list">
          {REPLACES.map((item) => (
            <li key={item} className="mkt-strip__item">
              {item}
              <span className="mkt-strip__strike" aria-hidden="true" />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
