// A DIFFERENTIAL test, not a unit test.
//
// sm2.ts duplicates server/src/routes/study.ts on purpose (see that file's header
// for why). Duplicated logic drifts, and drift here means a card's due date
// disagrees between a student's laptop and their phone - a bug that looks like the
// app losing their progress.
//
// So every expectation below is copied from the values server/test/study.test.ts
// already asserts against the real endpoint, with the test name it came from. If
// either implementation changes, this fails.
//
// The cited names are the contract. Do not "fix" a number here to make it pass -
// find out which side moved.
import { describe, it, expect } from 'vitest';
import { sm2Step, MIN_EASE, MAX_EASE, MAX_INTERVAL_DAYS, RATINGS, type Sm2State } from './sm2';

const NOW = Date.UTC(2026, 7, 9, 12, 0, 0);
const MINUTE = 60_000;
const DAY = 86_400_000;

const state = (over: Partial<Sm2State> = {}): Sm2State => ({
  ease: 2.5, intervalDays: 0, reps: 0, lapses: 0, ...over,
});

/** Minutes from NOW until the returned dueAt. */
const dueInMs = (dueAt: string) => Date.parse(dueAt) - NOW;

describe('sm2Step matches the server', () => {
  it('again: resets reps and interval to 0, drops ease by 0.2, logs a lapse, due in ~1 minute', () => {
    // server/test/study.test.ts: 'again: resets reps and interval to 0, drops ease by 0.2 (floor 1.3), logs a lapse, due in ~1 minute'
    const out = sm2Step(state({ ease: 2.5, intervalDays: 10, reps: 3 }), 'again', null, NOW);
    expect(out.reps).toBe(0);
    expect(out.intervalDays).toBe(0);
    expect(out.ease).toBeCloseTo(2.3, 5);
    expect(out.lapses).toBe(1);
    expect(dueInMs(out.dueAt)).toBe(MINUTE);
  });

  it('hard on a fresh card: due in ~10 minutes, reps and interval stay 0, ease drops 0.15', () => {
    // server/test/study.test.ts: 'hard on a fresh card (reps 0, interval 0): due in ~10 minutes, reps and interval stay 0'
    const out = sm2Step(state({ ease: 2.5, intervalDays: 0, reps: 0 }), 'hard', null, NOW);
    expect(out.reps).toBe(0);
    expect(out.intervalDays).toBe(0);
    expect(out.ease).toBeCloseTo(2.35, 5);
    expect(dueInMs(out.dueAt)).toBe(10 * MINUTE);
  });

  it('a SECOND consecutive hard on a fresh card graduates it to a day', () => {
    // The relearn-loop escape hatch. server/src/routes/study.ts reads the previous
    // logged rating for exactly this; a port that ignored it would trap a
    // struggling card in the 10-minute step forever on this device only.
    const out = sm2Step(state({ ease: 2.5, intervalDays: 0, reps: 0 }), 'hard', 'hard', NOW);
    expect(out.reps).toBe(1);
    expect(out.intervalDays).toBe(1);
    expect(dueInMs(out.dueAt)).toBe(DAY);
  });

  it('hard on an established card: interval *= 1.2 and reps increments', () => {
    const out = sm2Step(state({ ease: 2.5, intervalDays: 10, reps: 3 }), 'hard', 'good', NOW);
    expect(out.reps).toBe(4);
    expect(out.intervalDays).toBeCloseTo(12, 5);
    expect(out.ease).toBeCloseTo(2.35, 5);
  });

  it('good on a fresh card: interval becomes 1 day flat, ease unchanged', () => {
    // server/test/study.test.ts: 'good on a fresh card (reps 0 -> 1): interval becomes 1 day flat, ease unchanged'
    const out = sm2Step(state({ ease: 2.5, intervalDays: 0, reps: 0 }), 'good', null, NOW);
    expect(out.reps).toBe(1);
    expect(out.intervalDays).toBe(1);
    expect(out.ease).toBe(2.5);
    expect(dueInMs(out.dueAt)).toBe(DAY);
  });

  it('good on an established card: interval = interval * ease', () => {
    // server/test/study.test.ts: 'good on an established card (reps > 1): interval = interval * ease'
    const out = sm2Step(state({ ease: 2.5, intervalDays: 3, reps: 1 }), 'good', null, NOW);
    expect(out.reps).toBe(2);
    expect(out.intervalDays).toBeCloseTo(7.5, 5); // 3 * 2.5
    expect(out.ease).toBe(2.5);
  });

  it('easy on a fresh card: interval jumps to 4 days, reps -> 1, ease += 0.15', () => {
    // server/test/study.test.ts: 'easy on a fresh card (reps 0, interval 0): interval jumps to 4 days, reps -> 1'
    const out = sm2Step(state({ ease: 2.5, intervalDays: 0, reps: 0 }), 'easy', null, NOW);
    expect(out.reps).toBe(1);
    expect(out.intervalDays).toBe(4);
    expect(out.ease).toBeCloseTo(2.65, 5);
  });

  it('easy on an established card: interval = interval * (ease + 0.15) * 1.3', () => {
    // server/test/study.test.ts: 'easy on an established card: interval = interval * (ease + 0.15) * 1.3, ease += 0.15, reps increments'
    const out = sm2Step(state({ ease: 2.0, intervalDays: 5, reps: 2 }), 'easy', null, NOW);
    expect(out.reps).toBe(3);
    expect(out.ease).toBeCloseTo(2.15, 5);
    expect(out.intervalDays).toBeCloseTo(5 * 2.15 * 1.3, 5);
  });
});

describe('sm2Step bounds', () => {
  it('ease never falls below the floor, however many lapses', () => {
    let s = state({ ease: 1.4 });
    for (let i = 0; i < 20; i++) {
      const out = sm2Step(s, 'again', null, NOW);
      s = { ease: out.ease, intervalDays: out.intervalDays, reps: out.reps, lapses: out.lapses };
    }
    expect(s.ease).toBe(MIN_EASE);
  });

  it('ease never exceeds the ceiling, so a run of easy cannot compound to multi-year intervals', () => {
    let s = state({ ease: 2.9, intervalDays: 1, reps: 1 });
    for (let i = 0; i < 20; i++) {
      const out = sm2Step(s, 'easy', null, NOW);
      s = { ease: out.ease, intervalDays: out.intervalDays, reps: out.reps, lapses: out.lapses };
    }
    expect(s.ease).toBe(MAX_EASE);
  });

  it('the interval is bounded, so a long run of easy cannot overflow the Date range', () => {
    // This is a REGRESSION TEST for a real crash, found by the property test below.
    // The ease ceiling does not bound the interval: 'easy' multiplies by ease * 1.3
    // every time, so after 14 consecutive easy reviews the interval passes 1e8 days
    // and `new Date(now + interval * 86_400_000).toISOString()` throws RangeError.
    //
    // The identical arithmetic is in server/src/routes/study.ts, where the throw
    // lands BEFORE the UPDATE - so that endpoint 500s and loses the review.
    let s = state({ ease: 2.5, intervalDays: 1, reps: 1 });
    for (let i = 0; i < 40; i++) {
      const out = sm2Step(s, 'easy', null, NOW);
      s = { ease: out.ease, intervalDays: out.intervalDays, reps: out.reps, lapses: out.lapses };
      expect(Number.isFinite(Date.parse(out.dueAt))).toBe(true);
    }
    expect(s.intervalDays).toBe(MAX_INTERVAL_DAYS);
  });

  it('always returns a due date in the future and a parseable ISO string, for every rating and state', () => {
    // The property that actually matters to a student: no rating, from any state,
    // may schedule a card in the past - that would make it permanently due.
    for (const rating of RATINGS) {
      for (const prev of [null, ...RATINGS] as const) {
        for (const s of [state(), state({ reps: 1, intervalDays: 1 }), state({ reps: 9, intervalDays: 120, ease: 1.3 })]) {
          const out = sm2Step(s, rating, prev, NOW);
          expect(out.dueAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
          expect(Date.parse(out.dueAt)).toBeGreaterThan(NOW);
          expect(Number.isFinite(out.intervalDays)).toBe(true);
          expect(out.ease).toBeGreaterThanOrEqual(MIN_EASE);
          expect(out.ease).toBeLessThanOrEqual(MAX_EASE);
        }
      }
    }
  });
});
