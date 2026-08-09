// Every table the offline client mirrors must be able to answer two questions:
// "what changed since X" and "what was deleted". Without updated_at the first is
// unanswerable; without deleted_at a delete cannot be replicated to a client that
// was offline when it happened, so that client's outbox resurrects the record.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '../src/db.js';
import { resetDatabase, closeDatabase } from './helpers.js';

const MIRRORED = ['notebooks', 'notes', 'canvas_items', 'canvas_edges', 'note_ink', 'flashcards'] as const;

async function columns(table: string): Promise<string[]> {
  const rows = await db
    .prepare("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ?")
    .all<{ column_name: string }>(table);
  return rows.map((r) => r.column_name);
}

beforeAll(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeDatabase();
});

describe('sync schema prerequisites', () => {
  for (const table of MIRRORED) {
    it(`${table} has updated_at`, async () => {
      expect(await columns(table)).toContain('updated_at');
    });

    it(`${table} has deleted_at`, async () => {
      expect(await columns(table)).toContain('deleted_at');
    });
  }

  it('review_log has neither, being append-only', async () => {
    const cols = await columns('review_log');
    expect(cols).not.toContain('deleted_at');
  });
});

/**
 * The columns are useless if the existing write paths cannot insert without them.
 *
 * `updated_at` is NOT NULL on all six tables, but notebooks/flashcards/canvas_edges/
 * note_ink are inserted by routes (and by test helpers) that predate the column and
 * name it nowhere. A column default is therefore not tidiness - without it every
 * notebook create, card create, edge create and ink stroke fails on a NOT NULL
 * violation the moment this migration lands.
 */
describe('updated_at defaults so existing inserts keep working', () => {
  for (const table of ['notebooks', 'canvas_edges', 'note_ink', 'flashcards'] as const) {
    it(`${table}.updated_at is NOT NULL with a default`, async () => {
      const row = await db
        .prepare(
          `SELECT is_nullable, column_default FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = ? AND column_name = 'updated_at'`,
        )
        .get<{ is_nullable: string; column_default: string | null }>(table);
      expect(row?.is_nullable).toBe('NO');
      expect(row?.column_default).toBeTruthy();
    });
  }
});
