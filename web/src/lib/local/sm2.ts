// The SM-2 scheduling step, ported from server/src/routes/study.ts.
//
// This is a duplicate of server logic, which is normally the wrong answer. It is
// the right one here because the alternative is worse: a runtime import from the
// server workspace into the browser bundle, or from the browser bundle into the
// Vercel serverless build. Both have bitten this project before.
//
// The duplication is made safe by sm2.test.ts, which is a DIFFERENTIAL test - it
// enumerates the whole state space and pins every output against the values
// server/test/study.test.ts asserts. If either implementation moves, that test
// fails rather than a student's due dates quietly disagreeing between devices.
//
// Kept as a PURE function - no clock, no database - so the test can drive it over
// every state without fixtures. The caller supplies `nowMs` and the previous
// rating.

/** Matches MIN_EASE in server/src/routes/study.ts. */
export const MIN_EASE = 1.3;
/** Matches MAX_EASE: an ease ceiling, so a run of 'easy' cannot compound to multi-year intervals. */
export const MAX_EASE = 3.0;

/**
 * Interval ceiling, in days. 100 years, matching Anki's default.
 *
 * This exists because of a real crash, not as tidiness. The ease ceiling alone does
 * NOT bound the interval: 'easy' multiplies by `ease * 1.3` ≈ 3.9 every time, so the
 * interval grows geometrically. After 14 consecutive 'easy' reviews of one card the
 * interval passes 1e8 days, `new Date(now + interval * 86_400_000)` exceeds the
 * ±8.64e15 ms Date range, and `.toISOString()` throws RangeError: Invalid time value.
 *
 * The same arithmetic and the same crash are in server/src/routes/study.ts, where the
 * throw happens BEFORE the UPDATE - so the endpoint 500s and the review is silently
 * lost. Both sides now clamp identically; see sm2.test.ts, which is what keeps them
 * from drifting apart again.
 */
export const MAX_INTERVAL_DAYS = 36500;

export type Rating = 'again' | 'hard' | 'good' | 'easy';
export const RATINGS: readonly Rating[] = ['again', 'hard', 'good', 'easy'];

const MINUTE = 60_000;
const DAY = 86_400_000;

export interface Sm2State {
  ease: number;
  intervalDays: number;
  reps: number;
  lapses: number;
}

export interface Sm2Step extends Sm2State {
  dueAt: string;
}

/**
 * Advance one card by one review.
 *
 * `previousRating` is the most recent rating already recorded for this card, or
 * null if it has never been reviewed. It is not a convenience: the server's 'hard'
 * branch reads it to break out of the 10-minute relearning loop, so a port that
 * ignored it would keep a struggling card in that loop forever on this device and
 * graduate it on every other.
 */
export function sm2Step(
  state: Sm2State,
  rating: Rating,
  previousRating: Rating | null,
  nowMs: number,
): Sm2Step {
  let { ease, intervalDays: interval, reps, lapses } = state;
  const isFresh = reps === 0 && interval === 0;
  let dueAt: string;

  switch (rating) {
    case 'again': {
      reps = 0;
      interval = 0;
      ease = Math.max(MIN_EASE, ease - 0.2);
      lapses += 1;
      dueAt = new Date(nowMs + MINUTE).toISOString();
      break;
    }

    case 'hard': {
      ease = Math.max(MIN_EASE, ease - 0.15);
      if (isFresh) {
        // A brand-new card graded 'hard' gets one short relearning step. But a card
        // that keeps getting 'hard' must not loop in that step forever, so a SECOND
        // consecutive 'hard' from the new state graduates it to a day.
        if (previousRating === 'hard') {
          reps = 1;
          interval = 1;
          dueAt = new Date(nowMs + DAY).toISOString();
        } else {
          interval = 0;
          dueAt = new Date(nowMs + 10 * MINUTE).toISOString();
        }
      } else {
        reps = reps + 1;
        interval = clampInterval(interval * 1.2);
        dueAt = new Date(nowMs + interval * DAY).toISOString();
      }
      break;
    }

    case 'good': {
      reps = reps + 1;
      // reps was incremented first, so `reps === 1` means this is the first rep and
      // the interval is a flat day rather than a multiple of a zero interval.
      interval = clampInterval(reps === 1 ? 1 : interval * ease);
      dueAt = new Date(nowMs + interval * DAY).toISOString();
      break;
    }

    case 'easy': {
      const bumped = Math.min(MAX_EASE, ease + 0.15);
      ease = bumped;
      if (isFresh) {
        reps = 1;
        interval = 4;
      } else {
        reps = reps + 1;
        // The BUMPED ease, not the old one - matching the server.
        interval = clampInterval(interval * bumped * 1.3);
      }
      dueAt = new Date(nowMs + interval * DAY).toISOString();
      break;
    }
  }

  return { ease, intervalDays: interval, reps, lapses, dueAt };
}

/**
 * Clamp an interval to something a Date can represent. Applied by every branch that
 * multiplies, via the wrapper below rather than in six places.
 */
function clampInterval(days: number): number {
  if (!Number.isFinite(days) || days < 0) return 0;
  return Math.min(days, MAX_INTERVAL_DAYS);
}
