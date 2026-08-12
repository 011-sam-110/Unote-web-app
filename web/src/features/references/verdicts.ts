// What each of the four verdict states MEANS, in one place.
//
// The four states are the feature, not decoration on it, so the words and the glyph that
// carry them are data rather than JSX scattered through three components:
//
//   VERIFIED    a registry answered and its record agrees
//   UNCONFIRMED nothing to check against, or nothing to compare. NOT an error, and the
//               single most common state - most student sources carry no DOI or ISBN. If
//               this reads as a defect the whole feature is worse than useless, because a
//               student who sees six warnings on six honest sources learns to ignore all six
//   REFUTED     the registry actively contradicts it. The ONLY state that accuses
//   UNREACHABLE we could not ask. Neutral, and deliberately not red-adjacent: "your source
//               is fake" and "I have no signal" are different claims
//
// STATE IS CARRIED BY GLYPH FIRST, HUE SECOND. `verified` and `refuted` differ on the
// red-green axis - the most common colour vision deficiency - on the two states that matter
// most, so each state also has a glyph of its own shape (tick / question mark / exclamation
// / dash) and the badge draws that glyph at full size. Strip the colour and all four are
// still distinguishable. That matters twice over: a bibliography is the part of a document
// most likely to be printed.
import type { VerdictState } from './types';

export type GlyphName = 'tick' | 'question' | 'exclamation' | 'dash';

export interface VerdictPresentation {
  /** The one-word badge label. */
  label: string;
  glyph: GlyphName;
  /** Read by screen readers in place of the glyph, and used as the badge's title. */
  announce: string;
  /** What the state means, in a sentence, shown under the evidence. */
  meaning: string;
}

export const VERDICTS: Record<VerdictState, VerdictPresentation> = {
  verified: {
    label: 'Verified',
    glyph: 'tick',
    announce: 'Verified: a registry confirmed this source',
    meaning: 'A registry was asked about this source and its record agrees.',
  },
  unconfirmed: {
    // NOT "unverified". "Un-verified" describes a source that failed something; nothing
    // here has failed. Most sources a student cites - a lecture, a book with no ISBN, a
    // page with no registry behind it - live in this state permanently and correctly.
    label: 'Unconfirmed',
    glyph: 'question',
    announce: 'Unconfirmed: nothing has been checked, which is normal',
    meaning: 'Nothing to check this against, or nothing has been checked yet. This is normal and is not a problem with the source.',
  },
  refuted: {
    label: 'Refuted',
    glyph: 'exclamation',
    announce: 'Refuted: a registry contradicts this source',
    meaning: 'A registry was asked and its record contradicts this. Worth looking at before you cite it.',
  },
  unreachable: {
    label: 'Unreachable',
    glyph: 'dash',
    announce: 'Unreachable: the check could not be made',
    meaning: 'The check could not be made. That says nothing about the source itself - only that nobody answered.',
  },
};

export function presentationFor(state: string): VerdictPresentation {
  return VERDICTS[state as VerdictState] ?? VERDICTS.unconfirmed;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How old the verdict is, in words.
 *
 * A verdict that does not state its own age is just an assertion. A tick from eight months
 * ago and a tick from this morning are not the same claim - the DOI could have been
 * retracted since - and the UI must not present them as though they were.
 *
 * Returns null when nothing was ever checked, which the caller renders as "never checked"
 * rather than as a suspiciously fresh-looking blank.
 */
export function relativeAge(iso: string, now: Date = new Date()): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const delta = now.getTime() - then;
  if (delta < 0) return 'just now'; // clock skew - never say "in 3 hours"
  if (delta < MINUTE) return 'just now';
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)} min ago`;
  if (delta < DAY) {
    const h = Math.floor(delta / HOUR);
    return `${h} ${h === 1 ? 'hour' : 'hours'} ago`;
  }
  const days = Math.floor(delta / DAY);
  if (days < 30) return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  if (days < 365) {
    const months = Math.floor(days / 30);
    return `${months} ${months === 1 ? 'month' : 'months'} ago`;
  }
  const years = Math.floor(days / 365);
  return `${years} ${years === 1 ? 'year' : 'years'} ago`;
}

/** Past this, a verdict is shown as ageing and the re-check button stops being subtle. */
export const STALE_AFTER_DAYS = 90;

export function isStale(iso: string, now: Date = new Date()): boolean {
  if (!iso) return false;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return false;
  return now.getTime() - then > STALE_AFTER_DAYS * DAY;
}
