// The feature grid. Each card is labelled in the margin with a mono tag rather than
// numbered: these are seven independent capabilities, not seven steps, and numbering
// them would claim an order that isn't there.
import {
  CanvasVisual,
  CaptureVisual,
  FindVisual,
  LinkVisual,
  NotationVisual,
  StudyVisual,
  WriteVisual,
} from '../visuals/FeatureVisuals';

interface Feature {
  tag: string;
  title: string;
  body: string;
  visual: React.ReactNode;
  wide?: boolean;
}

const FEATURES: Feature[] = [
  {
    tag: 'write',
    title: 'A block editor that keeps up with a lecture',
    body: 'Type / to drop in callouts, tables, columns, code blocks and equations without leaving the keyboard. Everything autosaves, and every note keeps a version history you can restore from.',
    visual: <WriteVisual />,
    wide: true,
  },
  {
    tag: 'link',
    title: 'Notes that know about each other',
    body: 'Write [[Dijkstra]] and it resolves. Each note lists what links to it, plus the notes that mention it without linking yet.',
    visual: <LinkVisual />,
  },
  {
    tag: 'capture',
    title: 'Drop in a lecture, get the notes back',
    body: 'An MP4 becomes slides plus a timestamped transcript, processed in your browser. The video never leaves your machine. PDFs, slide decks and photos import too, with OCR on the ones that are only pictures of words.',
    visual: <CaptureVisual />,
  },
  {
    tag: 'study',
    title: 'Revision that comes out of your own notes',
    body: 'Highlight a passage and make it a flashcard without breaking your flow. Reviews run on an SM-2 spaced-repetition schedule, so the cards you keep getting wrong come back sooner.',
    visual: <StudyVisual />,
    wide: true,
  },
  {
    tag: 'canvas',
    title: 'Boards and handwriting',
    body: 'Any note can be an infinite canvas: sticky notes, shapes, connectors. Draw over it with a stylus - pressure-sensitive, with palm rejection so a resting hand does nothing.',
    visual: <CanvasVisual />,
  },
  {
    tag: 'find',
    title: 'Search that takes instructions',
    body: 'Full-text search across everything, narrowed with operators: filter by tag or notebook, demand an exact phrase, exclude a word.',
    visual: <FindVisual />,
  },
  {
    tag: 'notation',
    title: 'Built for science degrees',
    body: 'LaTeX equations, syntax-highlighted code and chemical structures live as blocks in the note, next to the working.',
    visual: <NotationVisual />,
  },
];

export default function FeatureBento() {
  return (
    <section className="mkt-features" id="features">
      {/* COPY CHANGE, needs Sam's sign-off. This heading used to read "The whole week, from
          the lecture hall to the exam." - which is now the week spine's job, and the spine
          demonstrates it rather than claiming it. Two adjacent sections making the same
          argument meant the second one read as a repeat. This grid is now explicitly the
          reference list for the loop the reader has just been walked through. */}
      <header className="mkt-section-head mkt-reveal">
        <p className="mkt-eyebrow">Everything in one place</p>
        <h2 className="mkt-section-title">Every part of it, on its own terms.</h2>
        <p className="mkt-section-lede">
          The week above is the loop. These are the seven things it is built out of, and each one
          is worth having on its own.
        </p>
      </header>

      <div className="mkt-bento">
        {FEATURES.map((f, i) => (
          <article
            key={f.tag}
            className={`mkt-card mkt-reveal${f.wide ? ' mkt-card--wide' : ''}${i === FEATURES.length - 1 ? ' mkt-card--last' : ''}`}
            /* Cards in the same row arrive one after the other rather than together, which
               is what stops a row of three reading as a single block dropping in. */
            data-reveal-delay={(i % 3) * 90}
          >
            <span className="mkt-card__tag">{f.tag}</span>
            <div className="mkt-card__text">
              <h3 className="mkt-card__title">{f.title}</h3>
              <p className="mkt-card__body">{f.body}</p>
            </div>
            <div className="mkt-card__viz">{f.visual}</div>
          </article>
        ))}
      </div>

      <div className="mkt-also-head mkt-reveal">
        <p className="mkt-eyebrow">And also</p>
      </div>
      <ul className="mkt-also mkt-reveal" data-reveal-delay="80">
        {[
          'Share a note or board behind a link, view-only or editable',
          'Guests join a shared note without making an account',
          'Send a photo straight from your phone by scanning a QR code',
          'Margin comments on any paragraph',
          'Find and replace across a note',
          'Export any note as Markdown',
          'Tags that cut across notebooks, renameable everywhere at once',
          'A one-time recovery key, so a lost password never means lost notes',
        ].map((item) => (
          <li key={item} className="mkt-also__item">
            {item}
          </li>
        ))}
      </ul>
    </section>
  );
}
