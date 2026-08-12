import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '../src/db.js';
import { resetDatabase, closeDatabase } from './helpers.js';

beforeAll(async () => { await resetDatabase(); });
afterAll(async () => { await closeDatabase(); });

async function columns(table: string): Promise<string[]> {
  const rows = await db
    .prepare(`SELECT column_name FROM information_schema.columns WHERE table_name = ?`)
    .all<{ column_name: string }>(table);
  return rows.map((r) => r.column_name).sort();
}

describe('references schema', () => {
  it('creates sources with CSL-JSON storage owned by a user', async () => {
    expect(await columns('sources')).toEqual(
      ['created_at', 'csl_json', 'id', 'kind', 'updated_at', 'user_id'],
    );
  });

  it('creates citations linking a note to a source, with a locator', async () => {
    const cols = await columns('citations');
    expect(cols).toEqual(
      ['created_at', 'id', 'locator', 'note_id', 'prefix', 'source_id', 'suffix', 'user_id'],
    );
  });

  it('creates source_verdicts keyed one-to-one on the source', async () => {
    expect(await columns('source_verdicts')).toEqual(
      ['checked_at', 'evidence', 'registry', 'source_id', 'state'],
    );
  });

  it('cascades citations away when their source is deleted', async () => {
    const rows = await db.prepare(`
      SELECT rc.delete_rule FROM information_schema.referential_constraints rc
      JOIN information_schema.table_constraints tc ON tc.constraint_name = rc.constraint_name
      WHERE tc.table_name = 'citations'
    `).all<{ delete_rule: string }>();
    expect(rows.every((r) => r.delete_rule === 'CASCADE')).toBe(true);
  });
});
