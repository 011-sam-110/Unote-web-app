// GET /api/sync/changes - the delta feed the offline client pulls.
//
// One endpoint for every mirrored table rather than six, because the client needs
// them advanced by ONE cursor: six independent cursors can be individually
// correct and jointly inconsistent (a note arriving before the notebook it lives
// in), and reconciling that on the client is strictly harder than serving it
// consistently here.
import { Router } from 'express';
import { db } from '../db.js';
import { userId } from '../auth/middleware.js';
import { encodeCursor, decodeCursor } from '../lib/syncCursor.js';
import { DEFAULT_SYNC_LIMIT, MAX_SYNC_LIMIT } from '../lib/syncLimits.js';
// Types only. The values live in ../lib/syncLimits.js instead of being imported from
// the web workspace, because a runtime import across that boundary is pulled into the
// serverless bundle; `import type` is erased at compile time and is not.
import type {
  SyncChangeSet, SyncChangesResponse, SyncCursor, SyncEntity,
} from '../../../web/src/lib/sync/contract.js';

const router = Router();

/**
 * How each entity is read. Tables carrying user_id filter on it directly; the
 * canvas and ink tables carry only note_id and must join through notes, which is
 * also what keeps another user's rows unreachable.
 *
 * `alias` is the table prefix the cursor predicate and ORDER BY must use. The joined
 * tables need it because `notes` also has updated_at and id, and an unqualified
 * reference there is ambiguous - Postgres rejects the query outright.
 */
const SOURCES: Array<{ entity: SyncEntity; alias: string; sql: string }> = [
  {
    entity: 'notebook',
    alias: '',
    sql: `SELECT id, updated_at, deleted_at, name, emoji, color, position, archived, created_at
          FROM notebooks WHERE user_id = ?`,
  },
  {
    entity: 'note',
    alias: '',
    // Tags are aggregated in rather than left to note_tags having its own entity.
    //
    // They have no updated_at of their own, so a tag change is only ever visible
    // through the note's - which the PATCH already advances. Shipping them here is
    // what makes a pull carry them at all: without this column a note edited on
    // another device arrives with its new title and body but no tags, and the
    // client's merge leaves the old set in place. Push was never the problem (tags
    // ride inside the note's own PATCH payload); pull was.
    // layout_json rides along for the same reason tags do. It is a column on the note with
    // no updated_at of its own, so without naming it here a page-size change made on the
    // laptop reaches the phone as a note whose body updated and whose paper did not - and
    // the layout would look correct in one browser and be silently absent in the other.
    sql: `SELECT id, updated_at, deleted_at, notebook_id, title, content_json, content_text,
                 kind, pinned, archived, created_at, layout_json,
                 COALESCE(
                   (SELECT array_agg(nt.tag ORDER BY nt.tag)
                      FROM note_tags nt WHERE nt.note_id = notes.id),
                   '{}'
                 ) AS tags
          FROM notes WHERE user_id = ?`,
  },
  {
    entity: 'flashcard',
    alias: '',
    sql: `SELECT id, updated_at, deleted_at, note_id, question, answer, due_at, interval_days,
                 ease, reps, lapses, suspended, created_at
          FROM flashcards WHERE user_id = ?`,
  },
  {
    entity: 'canvasItem',
    alias: 'ci.',
    sql: `SELECT ci.id, ci.updated_at, ci.deleted_at, ci.note_id, ci.kind, ci.data,
                 ci.x, ci.y, ci.width, ci.height, ci.rotation, ci.z, ci.created_at
          FROM canvas_items ci JOIN notes n ON n.id = ci.note_id WHERE n.user_id = ?`,
  },
  {
    entity: 'canvasEdge',
    alias: 'ce.',
    sql: `SELECT ce.id, ce.updated_at, ce.deleted_at, ce.note_id, ce.from_item_id,
                 ce.to_item_id, ce.label, ce.style, ce.created_at
          FROM canvas_edges ce JOIN notes n ON n.id = ce.note_id WHERE n.user_id = ?`,
  },
  {
    entity: 'ink',
    alias: 'i.',
    sql: `SELECT i.id, i.updated_at, i.deleted_at, i.note_id, i.stroke, i.created_at
          FROM note_ink i JOIN notes n ON n.id = i.note_id WHERE n.user_id = ?`,
  },
];

interface Row {
  id: string;
  updated_at: string;
  deleted_at: string | null;
  [k: string]: unknown;
}

/** snake_case columns to the camelCase the client store speaks. */
function camel(row: Row): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase())] = v;
  }
  return out;
}

router.get('/changes', async (req, res) => {
  const uid = userId(req);

  const rawSince = typeof req.query.since === 'string' ? req.query.since : '';
  // A malformed cursor is treated as "start from the beginning" rather than an
  // error: the alternative is a client wedged forever on a cursor it cannot fix.
  const since: SyncCursor = decodeCursor(rawSince) ?? { updatedAt: '', id: '' };

  const requested = Number(req.query.limit ?? DEFAULT_SYNC_LIMIT);
  const limit = Number.isFinite(requested)
    ? Math.min(Math.max(Math.trunc(requested), 1), MAX_SYNC_LIMIT)
    : DEFAULT_SYNC_LIMIT;

  // One extra row tells us whether another page exists without a second query.
  const perTable = limit + 1;
  const changes: SyncChangeSet = {};
  const flat: Array<{ entity: SyncEntity; row: Row }> = [];

  for (const source of SOURCES) {
    const a = source.alias;
    const rows = await db
      .prepare(
        `${source.sql}
           AND (${a}updated_at > ? OR (${a}updated_at = ? AND ${a}id > ?))
         ORDER BY ${a}updated_at ASC, ${a}id ASC
         LIMIT ?`,
      )
      .all<Row>(uid, since.updatedAt, since.updatedAt, since.id, perTable);
    for (const row of rows) flat.push({ entity: source.entity, row });
  }

  // Merge every table into ONE ordered stream and cut at `limit`, so the cursor
  // returned is a single position all tables share. Cutting per-table instead
  // would advance some tables past others and lose whatever fell in the gap.
  flat.sort((a, b) =>
    a.row.updated_at < b.row.updated_at ? -1
    : a.row.updated_at > b.row.updated_at ? 1
    : a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0,
  );

  const page = flat.slice(0, limit);
  const hasMore = flat.length > limit;

  for (const { entity, row } of page) {
    (changes[entity] ??= []).push(camel(row) as never);
  }

  const last = page.at(-1);
  const body: SyncChangesResponse = {
    cursor: last ? encodeCursor({ updatedAt: last.row.updated_at, id: last.row.id }) : null,
    hasMore,
    serverNow: new Date().toISOString(),
    changes,
  };
  res.json(body);
});

export default router;
