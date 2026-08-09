import { Router } from 'express';
import { db, newId, nowIso } from '../db.js';
import { userId } from '../auth/middleware.js';

const router = Router();

interface FlashcardRow {
  id: string;
  user_id: string;
  note_id: string | null;
  question: string;
  answer: string;
  ease: number;
  interval_days: number;
  reps: number;
  lapses: number;
  due_at: string;
  suspended: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  note_title?: string | null;
  notebook_id?: string | null;
  notebook_name?: string | null;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function flashcardDto(row: FlashcardRow) {
  return {
    id: row.id,
    noteId: row.note_id,
    noteTitle: row.note_title ?? undefined,
    notebookId: row.notebook_id ?? undefined,
    notebookName: row.notebook_name ?? undefined,
    question: row.question,
    answer: row.answer,
    dueAt: row.due_at,
    reps: row.reps,
    suspended: Boolean(row.suspended),
  };
}

// Every caller of this fragment MUST add `f.user_id = ?` AND `f.deleted_at IS NULL` to
// the WHERE clause - the joins carry no scoping of their own, and cards are tombstoned
// rather than hard-deleted now, so a missing tombstone filter puts deleted cards back in
// the queue. The `n.user_id = f.user_id` condition on the notes join is belt-and-braces:
// a card should never point at another user's note, but if one ever did, this keeps the
// foreign title/notebook name out of the DTO (the join just yields NULLs) instead of
// leaking it. `nb.deleted_at IS NULL` on the notebooks join does the same for a notebook
// that has since been trashed - the name goes NULL rather than naming a dead notebook.
const withNoteTitleSql = `
  SELECT f.*, n.title as note_title, n.notebook_id as notebook_id, nb.name as notebook_name
  FROM flashcards f
  LEFT JOIN notes n ON n.id = f.note_id AND n.user_id = f.user_id
  LEFT JOIN notebooks nb ON nb.id = n.notebook_id AND nb.deleted_at IS NULL
`;

function getCardWithTitle(id: string, uid: string): Promise<FlashcardRow | undefined> {
  return db
    .prepare(`${withNoteTitleSql} WHERE f.id = ? AND f.user_id = ? AND f.deleted_at IS NULL`)
    .get<FlashcardRow>(id, uid);
}

// GET /api/study/queue?limit=20&notebookId=
router.get('/queue', async (req, res) => {
  const uid = userId(req);
  const limit = clampInt(req.query.limit, 20, 1, 100);
  const notebookId = typeof req.query.notebookId === 'string' && req.query.notebookId ? req.query.notebookId : undefined;
  const now = nowIso();

  // Cram-one-module filter: scope the queue (and its due/total counts) to a single notebook.
  // notebookId comes from the caller, but it only ever narrows a set already restricted to
  // f.user_id = uid, so passing another user's notebook id can only match zero rows.
  const nbJoin = 'LEFT JOIN notes n2 ON n2.id = f.note_id';
  const nbWhere = notebookId ? ' AND n2.notebook_id = ?' : '';
  const nbParams = notebookId ? [notebookId] : [];

  // `f.deleted_at IS NULL` on all three: a tombstoned card must leave the queue and stop
  // being counted, or DELETE would appear to do nothing.
  const cards = await db
    .prepare(
      `${withNoteTitleSql} WHERE f.user_id = ? AND f.deleted_at IS NULL AND f.suspended = 0 AND f.due_at <= ?${notebookId ? ' AND n.notebook_id = ?' : ''} ORDER BY f.due_at ASC LIMIT ?`,
    )
    .all<FlashcardRow>(...[uid, now, ...(notebookId ? [notebookId] : []), limit]);

  const due = (
    await db
      .prepare(`SELECT COUNT(*) as c FROM flashcards f ${nbJoin} WHERE f.user_id = ? AND f.deleted_at IS NULL AND f.suspended = 0 AND f.due_at <= ?${nbWhere}`)
      .get<{ c: number }>(uid, now, ...nbParams)
  )!.c;
  const total = (
    await db
      .prepare(`SELECT COUNT(*) as c FROM flashcards f ${nbJoin} WHERE f.user_id = ? AND f.deleted_at IS NULL${nbWhere}`)
      .get<{ c: number }>(uid, ...nbParams)
  )!.c;

  res.json({ cards: cards.map(flashcardDto), due, total });
});

// GET /api/study/cards - ALL cards (incl. suspended and not-yet-due), newest first.
// Distinct from /queue (which is the due, non-suspended review set) so the Browse
// tab can manage the whole deck.
router.get('/cards', async (req, res) => {
  const uid = userId(req);
  const cards = await db
    .prepare(`${withNoteTitleSql} WHERE f.user_id = ? AND f.deleted_at IS NULL ORDER BY f.created_at DESC`)
    .all<FlashcardRow>(uid);
  res.json({ cards: cards.map(flashcardDto) });
});

// POST /api/study/cards { noteId?, question, answer } - manual card creation (iteration 2).
// New card starts fresh (ease 2.5, interval 0, reps 0) with due_at = now, so it shows up
// in the review queue immediately alongside any other due card.
router.post('/cards', async (req, res) => {
  const uid = userId(req);
  const body = (req.body ?? {}) as { noteId?: unknown; question?: unknown; answer?: unknown };

  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (!question) return res.status(400).json({ error: 'question is required' });

  const answer = typeof body.answer === 'string' ? body.answer.trim() : '';
  if (!answer) return res.status(400).json({ error: 'answer is required' });

  let noteId: string | null = null;
  if (body.noteId !== undefined && body.noteId !== null && body.noteId !== '') {
    if (typeof body.noteId !== 'string') return res.status(400).json({ error: 'noteId must be a string' });
    // Scoped to the caller: attaching a card to someone else's note would leak that
    // note's title and notebook name back through the card DTO. Another user's id
    // reads as 'unknown noteId', which also avoids confirming that the note exists.
    const note = await db.prepare('SELECT id FROM notes WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(body.noteId, uid);
    if (!note) return res.status(400).json({ error: 'unknown noteId' });
    noteId = body.noteId;
  }

  const id = newId();
  const now = nowIso();
  // updated_at is written explicitly rather than left to the column default: the default
  // is the DATABASE clock while every mutation below stamps the APP clock, and the two are
  // not the same instant. Mixing them can leave a later review carrying an EARLIER
  // updated_at than the insert - a cursor that goes backwards, which the delta feed
  // cannot page over.
  await db
    .prepare(
      `INSERT INTO flashcards (id, user_id, note_id, question, answer, ease, interval_days, reps, lapses, due_at, suspended, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 2.5, 0, 0, 0, ?, 0, ?, ?)`,
    )
    .run(id, uid, noteId, question, answer, now, now, now);

  res.status(201).json({ card: flashcardDto((await getCardWithTitle(id, uid))!) });
});

type Rating = 'again' | 'hard' | 'good' | 'easy';
const RATINGS: Rating[] = ['again', 'hard', 'good', 'easy'];
const MIN_EASE = 1.3;
const MAX_EASE = 3.0; // ease ceiling so a run of 'easy' can't compound to multi-year intervals

/**
 * Interval ceiling, in days. 100 years, matching Anki's default.
 *
 * This exists because of a real crash, not as tidiness. The ease ceiling above does NOT
 * bound the interval: 'easy' multiplies by `ease * 1.3` ~ 3.9 every time, so the interval
 * grows geometrically. From a fresh card, 14 consecutive 'easy' reviews take it past 1e8
 * days (measured: 1.7727e+8), at which point `new Date(now + interval * 86_400_000)`
 * exceeds the +/-8.64e15 ms Date range and `.toISOString()` throws
 * `RangeError: Invalid time value`. The throw lands BEFORE the UPDATE below, so the
 * endpoint 500s and the review is silently lost.
 *
 * Must stay equal to MAX_INTERVAL_DAYS in web/src/lib/local/sm2.ts, the browser-side port
 * of this same step. web/src/lib/local/sm2.test.ts pins the two against each other; if
 * they drift, one card's due date disagrees between a student's devices.
 */
const MAX_INTERVAL_DAYS = 36500;

/**
 * Clamp an interval to something a Date can represent. Applied by every branch that
 * multiplies, via this wrapper rather than in three places. Identical to clampInterval in
 * web/src/lib/local/sm2.ts, negative/non-finite guard included.
 */
function clampInterval(days: number): number {
  if (!Number.isFinite(days) || days < 0) return 0;
  return Math.min(days, MAX_INTERVAL_DAYS);
}

// POST /api/study/review { cardId, rating }
router.post('/review', async (req, res) => {
  const uid = userId(req);
  const { cardId, rating } = (req.body ?? {}) as { cardId?: unknown; rating?: unknown };
  if (typeof cardId !== 'string' || !cardId) return res.status(400).json({ error: 'cardId is required' });
  if (typeof rating !== 'string' || !RATINGS.includes(rating as Rating)) {
    return res.status(400).json({ error: `rating must be one of: ${RATINGS.join(', ')}` });
  }

  // Owner check and existence check are the same query: another user's card is a 404,
  // so the endpoint never reveals that the id exists. A tombstoned card is a 404 too -
  // reviewing one would resurrect it into the queue by moving its due_at.
  const row = await db
    .prepare('SELECT * FROM flashcards WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .get<FlashcardRow>(cardId, uid);
  if (!row) return res.status(404).json({ error: 'card not found' });

  let ease = row.ease;
  let interval = row.interval_days;
  let reps = row.reps;
  let lapses = row.lapses;
  const now = Date.now();
  let dueAt: string;

  switch (rating as Rating) {
    case 'again': {
      reps = 0;
      interval = 0;
      ease = Math.max(MIN_EASE, ease - 0.2);
      lapses += 1;
      dueAt = new Date(now + 60_000).toISOString();
      break;
    }
    case 'hard': {
      ease = Math.max(MIN_EASE, ease - 0.15);
      if (reps === 0 && interval === 0) {
        // Brand-new card graded 'hard': one short 10-minute relearning step. But a card
        // that keeps getting 'hard' must not loop in the 10-minute step forever - after a
        // SECOND consecutive 'hard' from the new state, graduate it to a 1-day interval so
        // it escapes the relearn loop (the review is logged AFTER this handler, so the most
        // recent logged rating being 'hard' means this is the 2nd consecutive one).
        // review_log has no user_id, so it is scoped by joining back to its card; the card
        // was already owner-checked above, and the join keeps that true if this ever moves.
        const prev = await db
          .prepare(
            `SELECT r.rating FROM review_log r
               JOIN flashcards f ON f.id = r.card_id
              WHERE r.card_id = ? AND f.user_id = ?
              ORDER BY r.id DESC LIMIT 1`,
          )
          .get<{ rating: string }>(cardId, uid);
        if (prev?.rating === 'hard') {
          reps = 1;
          interval = 1;
          dueAt = new Date(now + 86_400_000).toISOString();
        } else {
          interval = 0;
          dueAt = new Date(now + 600_000).toISOString();
        }
      } else {
        reps = reps + 1;
        interval = clampInterval(interval * 1.2);
        dueAt = new Date(now + interval * 86_400_000).toISOString();
      }
      break;
    }
    case 'good': {
      reps = reps + 1;
      interval = clampInterval(reps === 1 ? 1 : interval * ease);
      dueAt = new Date(now + interval * 86_400_000).toISOString();
      break;
    }
    case 'easy': {
      const bumped = Math.min(MAX_EASE, ease + 0.15);
      ease = bumped;
      if (reps === 0 && interval === 0) {
        // Brand-new card graded 'easy': jump straight to a 4-day interval, count the first rep.
        reps = 1;
        interval = 4;
      } else {
        reps = reps + 1;
        interval = clampInterval(interval * bumped * 1.3);
      }
      dueAt = new Date(now + interval * 86_400_000).toISOString();
      break;
    }
  }

  // updated_at moves with the schedule. The delta feed pages by (updated_at, id), so a
  // review that left it alone would never reach a client already past the old value - the
  // card would stay due on that device forever and get re-reviewed.
  await db
    .prepare('UPDATE flashcards SET ease = ?, interval_days = ?, reps = ?, lapses = ?, due_at = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(ease, interval, reps, lapses, dueAt, nowIso(), cardId, uid);
  await db.prepare('INSERT INTO review_log (card_id, rating) VALUES (?, ?)').run(cardId, rating);

  const updated = (await getCardWithTitle(cardId, uid))!;
  res.json({ card: flashcardDto(updated), nextDueAt: dueAt });
});

/** [startISO, endISO) UTC bounds of the current LOCAL day, so 'reviewed today' matches
 *  the student's wall-clock day, not UTC (off by the tz offset otherwise, ~half the year). */
function localDayBounds(): [string, string] {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return [start.toISOString(), end.toISOString()];
}

// GET /api/study/stats
router.get('/stats', async (req, res) => {
  const uid = userId(req);
  const now = nowIso();
  const due = (
    await db
      .prepare('SELECT COUNT(*) as c FROM flashcards WHERE user_id = ? AND deleted_at IS NULL AND suspended = 0 AND due_at <= ?')
      .get<{ c: number }>(uid, now)
  )!.c;
  const total = (await db.prepare('SELECT COUNT(*) as c FROM flashcards WHERE user_id = ? AND deleted_at IS NULL').get<{ c: number }>(uid))!.c;
  const [dayStart, dayEnd] = localDayBounds();
  // review_log carries no user_id, so 'reviewed today' is scoped through the card it
  // belongs to - otherwise this counts every user's reviews. `f.deleted_at IS NULL`
  // preserves what the hard delete used to do for free: review_log rows referenced the
  // card `ON DELETE CASCADE`, so deleting a card removed its reviews from this count.
  const reviewedToday = (
    await db
      .prepare(
        `SELECT COUNT(*) as c FROM review_log r
           JOIN flashcards f ON f.id = r.card_id
          WHERE f.user_id = ? AND f.deleted_at IS NULL AND r.reviewed_at >= ? AND r.reviewed_at < ?`,
      )
      .get<{ c: number }>(uid, dayStart, dayEnd)
  )!.c;

  // n.title is selected alongside the grouped f.note_id, so Postgres requires it in
  // GROUP BY too (SQLite allowed the bare `GROUP BY f.note_id`). note_id -> title is
  // functionally determined, so the extra grouping key does not change the result.
  const byNote = await db
    .prepare(
      `SELECT f.note_id as "noteId", n.title as "noteTitle",
         COUNT(*) as total,
         SUM(CASE WHEN f.suspended = 0 AND f.due_at <= ? THEN 1 ELSE 0 END) as due
       FROM flashcards f
       LEFT JOIN notes n ON n.id = f.note_id AND n.user_id = f.user_id
       WHERE f.user_id = ? AND f.deleted_at IS NULL AND f.note_id IS NOT NULL
       GROUP BY f.note_id, n.title
       ORDER BY n.title ASC`,
    )
    .all<{ noteId: string; noteTitle: string | null; total: number; due: number }>(now, uid);

  res.json({
    due,
    total,
    reviewedToday,
    byNote: byNote.map(r => ({ noteId: r.noteId, noteTitle: r.noteTitle ?? 'Untitled', total: r.total, due: r.due })),
  });
});

// PATCH /api/study/cards/:id { question?, answer?, suspended? }
router.patch('/cards/:id', async (req, res) => {
  const uid = userId(req);
  const existing = await db
    .prepare('SELECT * FROM flashcards WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .get<FlashcardRow>(req.params.id, uid);
  if (!existing) return res.status(404).json({ error: 'card not found' });

  const body = (req.body ?? {}) as { question?: unknown; answer?: unknown; suspended?: unknown };
  const question = typeof body.question === 'string' && body.question.trim() ? body.question.trim() : existing.question;
  const answer = typeof body.answer === 'string' && body.answer.trim() ? body.answer.trim() : existing.answer;
  // suspended is an INTEGER 0/1 column; Postgres rejects a JS boolean, so map it here.
  const suspended = typeof body.suspended === 'boolean' ? (body.suspended ? 1 : 0) : existing.suspended;

  // updated_at advances so the edit is visible to a client whose cursor is already past
  // the row's previous value - suspending a card is a sync-visible change like any other.
  await db
    .prepare('UPDATE flashcards SET question = ?, answer = ?, suspended = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(question, answer, suspended, nowIso(), req.params.id, uid);

  res.json({ card: flashcardDto((await getCardWithTitle(req.params.id, uid))!) });
});

// DELETE /api/study/cards/:id
//
// A tombstone, not a `DELETE FROM flashcards`: a row that is simply gone leaves the delta
// feed nothing to hand a client, so the delete never propagates and the client re-uploads
// the card from its outbox. `deleted_at IS NULL` in the WHERE makes a second delete a 404
// rather than silently re-stamping a tombstone the client has already seen.
router.delete('/cards/:id', async (req, res) => {
  const uid = userId(req);
  const ts = nowIso();
  const result = await db
    .prepare('UPDATE flashcards SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .run(ts, ts, req.params.id, uid);
  if (result.changes === 0) return res.status(404).json({ error: 'card not found' });
  res.json({ ok: true });
});

export default router;
