// A replica of the real Unote editor, built in DOM rather than shipped as a screenshot:
// it stays sharp at any density, reflows on a phone, weighs nothing, and can act out the
// product's core loop instead of describing it.
//
// That loop is the point. A line is typed, a passage is highlighted, the selection
// toolbar offers "Make flashcard", and the card appears - write, then study, which is the
// whole argument for the product.
//
// Two rules the first draft got wrong and a design review caught:
//  1. The FINISHED state is the default. Everything here renders complete with no CSS
//     applied; the animation is an enhancement layered on top for wide screens with
//     motion allowed. A visitor who arrives mid-sequence, resizes, or scrolls past in
//     three seconds still sees the whole argument.
//  2. The selection toolbar does not animate away. It is the frame that explains where
//     the flashcard came from, so removing it after a beat deleted the thesis. It now
//     appears and stays.
//
// TWO MODES, and rule 1 above governs both.
//
//  • No `step` prop - the hero's mode, unchanged. Everything renders complete and the
//    timed CSS sequence in marketing.css plays it out once on load.
//  • A `step` number - the week spine's mode. The SAME replica, with each part gated on
//    the step it belongs to, so scroll position can walk one frame through the week
//    instead of seven cards arriving. Nothing is unmounted at any step: parts that have
//    not arrived yet are transparent, so the frame never resizes under the pin and the
//    text stays in the DOM for find-in-page and the accessibility tree.
import Wordmark from '../Wordmark';

const NAV = [
  { key: 'home', label: 'Home' },
  { key: 'study', label: 'Study' },
  { key: 'ask', label: 'Ask AI' },
  { key: 'search', label: 'Search' },
];

const NOTEBOOKS = [
  { name: 'Algorithms', count: 12, tone: 'a', active: true },
  { name: 'Operating Systems', count: 9, tone: 'b' },
  { name: 'Discrete Maths', count: 7, tone: 'c' },
];

/** Which step each part of the replica belongs to. Read alongside STEPS in WeekSpine.tsx:
 *  these numbers and that copy describe the same five moments and have to agree. */
const AT = {
  imported: 0,
  notes: 1,
  links: 2,
  card: 3,
  review: 4,
} as const;

export interface ProductShotProps {
  /** Omit for the finished state. Supply 0-4 to drive the replica through the week. */
  step?: number;
}

export default function ProductShot({ step }: ProductShotProps) {
  const stepped = step !== undefined;
  /** Gate a part on the step it belongs to. In hero mode this adds nothing at all, so
   *  every selector that hides a part is scoped to .mkt-shot--stepped and cannot reach
   *  the hero. */
  const on = (at: number) => (stepped && step >= at ? ' is-on' : '');

  // The rail is the one thing whose ORDER differs between the modes. The hero argues
  // three claims at once and leads with the one a student cares about most; the spine
  // fills the rail in the order the week actually happens, top to bottom, so a block
  // arriving is legible as time passing rather than as a gap being filled in.
  const rail = {
    imported: (
      <div key="imported" className={`mkt-shot__rail-block${on(AT.imported)}`}>
        <div className="mkt-shot__label mkt-shot__label--rail">Imported</div>
        <div className="mkt-shot__import">
          <span className="mkt-shot__kind">MP4</span>
          Lecture 04 · 18 slides
        </div>
      </div>
    ),
    links: (
      <div key="links" className={`mkt-shot__rail-block${on(AT.links)}`}>
        <div className="mkt-shot__label mkt-shot__label--rail">Linked from 3 notes</div>
        <ul className="mkt-shot__backlinks">
          <li>Dijkstra</li>
          <li>Graph Traversal</li>
          <li>Shortest Paths · week 5</li>
        </ul>
      </div>
    ),
    study: (
      <div key="study" className={`mkt-shot__rail-block${on(AT.review)}`}>
        <div className="mkt-shot__label mkt-shot__label--rail">Study today</div>
        <div className="mkt-shot__due-row">
          <span>Algorithms</span>
          <strong>3 due</strong>
        </div>
        <div className="mkt-shot__due-row">
          <span>Operating Systems</span>
          <strong>1 due</strong>
        </div>
        <div className="mkt-shot__rail-btn">Review 4 cards</div>
      </div>
    ),
  };

  return (
    <div
      className={`mkt-shot${stepped ? ' mkt-shot--stepped' : ''}`}
      role="img"
      aria-label="The Unote editor: a note titled Breadth-First Search, tagged algorithms and week 4, with a highlighted passage being turned into a flashcard."
    >
      <div className="mkt-shot__frame">
        <div className="mkt-shot__chrome" aria-hidden="true">
          <span className="mkt-shot__dot" />
          <span className="mkt-shot__dot" />
          <span className="mkt-shot__dot" />
          <span className="mkt-shot__url">unote.app/note/breadth-first-search</span>
        </div>

        <div className="mkt-shot__body" aria-hidden="true">
          <aside className="mkt-shot__sidebar">
            <div className="mkt-shot__brand">
              <Wordmark size={15} />
              <strong>Unote</strong>
            </div>
            <div className="mkt-shot__search">
              <ShotIcon name="search" />
              Search
            </div>
            {NAV.map((item) => (
              <div key={item.key} className="mkt-shot__nav">
                <ShotIcon name={item.key} />
                {item.label}
              </div>
            ))}
            <div className="mkt-shot__label">Notebooks</div>
            {NOTEBOOKS.map((nb) => (
              <div key={nb.name} className={`mkt-shot__nav${nb.active ? ' is-active' : ''}`}>
                <span className={`mkt-shot__swatch mkt-shot__swatch--${nb.tone}`} />
                {nb.name}
                <span className="mkt-shot__count">{nb.count}</span>
              </div>
            ))}
          </aside>

          <div className="mkt-shot__doc">
            <div className="mkt-shot__crumbs">Algorithms › Breadth-First Search</div>
            <h3 className="mkt-shot__title">Breadth-First Search</h3>
            <div className="mkt-shot__tags">
              <span className="mkt-shot__tag">#algorithms</span>
              <span className="mkt-shot__tag">#week4</span>
            </div>

            {/* Monday, and Monday only. The caption promises slides and a timestamped
                transcript, and without this the frame answered that with an empty note -
                the one moment where the words and the picture disagreed.

                ABSOLUTELY POSITIONED, which is the whole reason it is safe: it fills the
                space the notes will later occupy without taking any space of its own, so
                the frame's height is identical at all five steps. Laid out in flow it
                added ~110px to every step and pushed the week rail off the bottom of the
                pin. It is also stepped-only - the hero tells a shorter story and does not
                need the lecture landing first. */}
            {stepped && (
              <div className={`mkt-shot__lecture${step === AT.imported ? ' is-on' : ''}`}>
                <div className="mkt-shot__lecture-head">
                  <span className="mkt-shot__kind">MP4</span>
                  Lecture 04 · 18 slides
                </div>
                <div className="mkt-shot__slides">
                  <span />
                  <span />
                  <span />
                  <span />
                </div>
                <p className="mkt-shot__transcript">
                  <span className="mkt-shot__stamp">04:12</span>
                  so the queue is what guarantees we finish a level before we start the next
                </p>
                <p className="mkt-shot__transcript">
                  <span className="mkt-shot__stamp">07:58</span>
                  every node at depth d, before any node at depth d plus one
                </p>
              </div>
            )}

            {/* The wrapper is not decoration: it shrink-wraps to the sentence, which is what
                gives the typing animation's `width: 100%` something correct to mean. Without
                it that 100% resolved against the PARAGRAPH, so the caret finished its travel
                98px past the full stop and sat there. See marketing.css. */}
            <p className={`mkt-shot__para${on(AT.notes)}`}>
              <span className="mkt-shot__type-wrap">
                <span className="mkt-shot__typed">
                  BFS explores a graph one level at a time, using a queue.
                </span>
              </span>
            </p>

            <p className={`mkt-shot__para mkt-shot__para--2${on(AT.notes)}`}>
              It visits every node at depth <em>d</em> before any node at depth <em>d</em>+1, which
              is why it finds the{' '}
              <span className={`mkt-shot__hl${on(AT.card)}`}>
                shortest path in an unweighted graph
              </span>
              . Compare with{' '}
              <span className={`mkt-shot__wikilink${on(AT.links)}`}>[[Dijkstra]]</span>.
              {/* Anchored to the paragraph it belongs to, not to the frame - the passage
                  moves with the text at every width, and so must the toolbar. */}
              <span className={`mkt-shot__toolbar${on(AT.card)}`}>
                <span className="mkt-shot__toolbar-b">B</span>
                <span className="mkt-shot__toolbar-i">I</span>
                <span className="mkt-shot__toolbar-pen">
                  <ShotIcon name="pen" />
                </span>
                <span className="mkt-shot__toolbar-sep" />
                <span className="mkt-shot__toolbar-cta">
                  <ShotIcon name="spark" />
                  Make flashcard
                </span>
              </span>
            </p>

            <div className={`mkt-shot__card${on(AT.card)}`}>
              <div className="mkt-shot__card-head">
                <span className="mkt-shot__card-badge">New flashcard</span>
                <span className="mkt-shot__card-due">Due today</span>
              </div>
              <p className="mkt-shot__card-q">
                Why does BFS find the shortest path in an unweighted graph?
              </p>
              <p className="mkt-shot__card-a">
                It visits every node at depth d before any node at depth d+1.
              </p>
            </div>
          </div>

          {/* The right rail is what makes the replica an argument rather than a picture of
              an editor: it shows the same note owing revision, carrying backlinks, and
              holding an imported lecture, which is the three-way claim the page makes.
              First to go when the frame narrows - see the 1080px rule in marketing.css. */}
          <aside className="mkt-shot__rail">
            {stepped
              ? [rail.imported, rail.links, rail.study]
              : [rail.study, rail.links, rail.imported]}
          </aside>
        </div>
      </div>

      <div className="mkt-shot__glow" aria-hidden="true" />
    </div>
  );
}

/** Stroke icons at a single weight, replacing the Unicode glyphs the first draft used -
 *  those fell out of the mono stack and rendered from a fallback at a different size and
 *  baseline, which was visible as mismatched sidebar icons. */
function ShotIcon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    search: (
      <>
        <circle cx="7" cy="7" r="4.5" />
        <path d="M10.4 10.4 14 14" />
      </>
    ),
    home: <path d="M2.5 7 8 2.5 13.5 7v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V7Z" />,
    study: <path d="M8 2.5 13.5 8 8 13.5 2.5 8 8 2.5Z" />,
    ask: <path d="M8 2.2 9.5 6.5 13.8 8 9.5 9.5 8 13.8 6.5 9.5 2.2 8 6.5 6.5 8 2.2Z" />,
    pen: <path d="M11.5 2.5 13.5 4.5 5 13H3v-2l8.5-8.5Z" />,
    spark: <path d="M8 2.2 9.5 6.5 13.8 8 9.5 9.5 8 13.8 6.5 9.5 2.2 8 6.5 6.5 8 2.2Z" />,
  };
  return (
    <svg className="mkt-shot__icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      {paths[name] ?? paths.home}
    </svg>
  );
}
