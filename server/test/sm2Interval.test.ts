// The SM-2 interval ceiling, driven through the real review endpoint.
//
// The bug this pins: MAX_EASE bounds the ease but nothing bounded the interval, and 'easy'
// multiplies by `ease * 1.3` ~ 3.9 every time. From a fresh card, review 14 pushes the
// interval to 1.7727e+8 days; `new Date(now + interval * 86_400_000)` then leaves the
// +/-8.64e15 ms Date range and `.toISOString()` throws `RangeError: Invalid time value`.
// The throw lands BEFORE the UPDATE, so the endpoint 500s and the review is lost with it -
// which is why a status assertion is the right one here.
//
// Both multiply-and-schedule branches ('good' and non-fresh 'hard') have the same hole, so
// they are exercised too, from a card already parked on an absurd interval.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { db } from '../src/db.js';
import { resetDatabase, resetData, makeUser, closeDatabase, insertCard, type TestUser } from './helpers.js';
// The browser-side port of this same step. Imported so the ceiling is asserted against the
// other implementation rather than against a literal copied twice: if either side moves,
// a card's due date disagrees between a student's devices.
import { MAX_INTERVAL_DAYS, sm2Step, type Sm2State } from '../../web/src/lib/local/sm2.js';

const app = buildApp();

let user: TestUser;
let api: TestUser['agent'];

interface CardMath {
  ease: number;
  interval_days: number;
  reps: number;
  due_at: string;
}

async function cardMath(id: string): Promise<CardMath> {
  return (await db
    .prepare('SELECT ease, interval_days, reps, due_at FROM flashcards WHERE id = ?')
    .get<CardMath>(id))!;
}

beforeAll(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetData();
  user = await makeUser(app);
  api = user.agent;
});

afterAll(async () => {
  await closeDatabase();
});

describe('POST /api/study/review interval ceiling', () => {
  it('survives 40 consecutive easy reviews of one card', async () => {
    const cardId = await insertCard(user.id, null);

    for (let i = 1; i <= 40; i++) {
      const res = await api.post('/api/study/review').send({ cardId, rating: 'easy' });
      // Review 14 was a 500 before the clamp, and every one after it too - the card became
      // permanently un-reviewable.
      expect(res.status, `review ${i} should not 500`).toBe(200);
      expect(typeof res.body.nextDueAt).toBe('string');
      expect(Number.isFinite(Date.parse(res.body.nextDueAt)), `review ${i} due date must parse`).toBe(true);
    }

    const row = await cardMath(cardId);
    expect(row.reps).toBe(40);
    expect(row.interval_days).toBe(MAX_INTERVAL_DAYS);
    // The stored due date has to be a real one, not just the response's.
    expect(Number.isFinite(Date.parse(row.due_at))).toBe(true);
  });

  it('clamps at 100 years, the same ceiling as the browser port', async () => {
    expect(MAX_INTERVAL_DAYS).toBe(36500);

    const cardId = await insertCard(user.id, null);
    for (let i = 0; i < 20; i++) {
      expect((await api.post('/api/study/review').send({ cardId, rating: 'easy' })).status).toBe(200);
    }

    const row = await cardMath(cardId);
    expect(row.interval_days).toBe(MAX_INTERVAL_DAYS);
    const dueInDays = (Date.parse(row.due_at) - Date.now()) / 86_400_000;
    expect(dueInDays).toBeGreaterThan(MAX_INTERVAL_DAYS - 1);
    expect(dueInDays).toBeLessThan(MAX_INTERVAL_DAYS + 1);
  });

  it('agrees with the browser port at every step of the run', async () => {
    const cardId = await insertCard(user.id, null);
    // insertCard's defaults, which are also a fresh card's: ease 2.5, interval 0, reps 0.
    let state: Sm2State = { ease: 2.5, intervalDays: 0, reps: 0, lapses: 0 };

    for (let i = 1; i <= 40; i++) {
      const res = await api.post('/api/study/review').send({ cardId, rating: 'easy' });
      expect(res.status).toBe(200);
      // dueAt is clock-dependent and so deliberately not compared; the scheduler state is
      // what has to match, and it is what the next interval is computed from.
      state = sm2Step(state, 'easy', i === 1 ? null : 'easy', Date.now());

      const row = await cardMath(cardId);
      expect(row.reps, `reps at review ${i}`).toBe(state.reps);
      expect(row.ease, `ease at review ${i}`).toBeCloseTo(state.ease, 5);
      // Compared RELATIVELY, not absolutely. `interval_days` is REAL (float4, ~7
      // significant digits), so the server rounds the interval on every store and reads
      // the rounded value back in for the next multiply, while the port keeps full float64
      // the whole way. That drift is storage precision, not a difference in the two
      // implementations - an absolute tolerance would fail at four figures of interval and
      // say nothing about whether the logic agrees. Once the clamp bites, both sides are
      // exactly MAX_INTERVAL_DAYS and the match is exact.
      const relative = Math.abs(row.interval_days - state.intervalDays) / Math.max(1, state.intervalDays);
      expect(relative, `interval at review ${i} (${row.interval_days} vs ${state.intervalDays})`).toBeLessThan(1e-5);
    }

    // The tail of a run this long is entirely clamped, and there the agreement is exact.
    expect((await cardMath(cardId)).interval_days).toBe(state.intervalDays);
    expect(state.intervalDays).toBe(MAX_INTERVAL_DAYS);
  });

  it("clamps the 'good' branch, which multiplies by ease", async () => {
    // A card already parked past the Date range - reachable by the 'easy' run above on any
    // deployment that ran before the clamp, so this is a real stored state, not a hypothetical.
    const cardId = await insertCard(user.id, null, { interval_days: 1e9, reps: 5 });

    const res = await api.post('/api/study/review').send({ cardId, rating: 'good' });
    expect(res.status).toBe(200);
    expect(Number.isFinite(Date.parse(res.body.nextDueAt))).toBe(true);
    expect((await cardMath(cardId)).interval_days).toBe(MAX_INTERVAL_DAYS);
  });

  it("clamps the 'hard' branch, which multiplies by 1.2", async () => {
    const cardId = await insertCard(user.id, null, { interval_days: 1e9, reps: 5 });

    const res = await api.post('/api/study/review').send({ cardId, rating: 'hard' });
    expect(res.status).toBe(200);
    expect(Number.isFinite(Date.parse(res.body.nextDueAt))).toBe(true);
    expect((await cardMath(cardId)).interval_days).toBe(MAX_INTERVAL_DAYS);
  });

  it('leaves the short relearning steps alone', async () => {
    // The clamp must not disturb the branches that do not multiply: 'again' goes to a
    // minute and a fresh 'hard' to ten, and both are what stop a lapsed card vanishing.
    const cardId = await insertCard(user.id, null, { interval_days: 40, reps: 4 });

    const again = await api.post('/api/study/review').send({ cardId, rating: 'again' });
    expect(again.status).toBe(200);
    const afterAgain = await cardMath(cardId);
    expect(afterAgain.interval_days).toBe(0);
    expect(afterAgain.reps).toBe(0);
    const minutes = (Date.parse(again.body.nextDueAt) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(0);
    expect(minutes).toBeLessThan(2);

    const hard = await api.post('/api/study/review').send({ cardId, rating: 'hard' });
    expect(hard.status).toBe(200);
    const hardMinutes = (Date.parse(hard.body.nextDueAt) - Date.now()) / 60_000;
    expect(hardMinutes).toBeGreaterThan(9);
    expect(hardMinutes).toBeLessThan(11);
  });
});
