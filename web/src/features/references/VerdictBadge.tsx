// The badge that says what is known about a source.
//
// GLYPH FIRST. The four glyphs are drawn as paths at the same weight and the same size, and
// each is a different SHAPE - not a different colour of the same dot. Print the page, or
// view it with the hue stripped, and a tick is still a tick and a dash is still a dash.
// The hue is the second channel, never the only one, because `verified` and `refuted`
// differ on the red-green axis and that is the most common colour vision deficiency there
// is - on the two states where being wrong costs the most.
//
// The border is a THIRD channel: `unreachable` is dashed, because "we could not ask" is the
// one state that is about the connection rather than about the source, and it must never
// read as an accusation.
import type { VerdictState } from './types';
import { presentationFor, type GlyphName } from './verdicts';

/** All four in one 16x16 box at one stroke weight, so nothing reads as louder by accident. */
function Glyph({ name }: { name: GlyphName }) {
  return (
    <svg
      className="rf-verdict__glyph"
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {name === 'tick' && <polyline points="3.6 8.4 6.5 11.3 12.4 4.5" />}
      {name === 'question' && (
        <>
          <path d="M5.6 6.0 A 2.4 2.4 0 1 1 8 8.4 L 8 10.1" />
          <path d="M8 12.6 h0.01" />
        </>
      )}
      {name === 'exclamation' && (
        <>
          <path d="M8 3.4 V 9.4" />
          <path d="M8 12.6 h0.01" />
        </>
      )}
      {name === 'dash' && <path d="M3.8 8 H 12.2" />}
    </svg>
  );
}

export default function VerdictBadge({
  state,
  size = 'md',
}: {
  state: VerdictState | string;
  size?: 'sm' | 'md';
}) {
  const p = presentationFor(state);
  return (
    // role="img" + aria-label rather than a bare title: the glyph is decorative to a screen
    // reader and the word alone ("Unconfirmed") does not carry that it is not a problem.
    <span
      className="rf-verdict"
      data-state={state}
      data-glyph={p.glyph}
      data-size={size}
      role="img"
      aria-label={p.announce}
      title={p.announce}
    >
      <Glyph name={p.glyph} />
      <span className="rf-verdict__label" aria-hidden="true">
        {p.label}
      </span>
    </span>
  );
}
