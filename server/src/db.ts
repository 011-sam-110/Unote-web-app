import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { DATABASE_URL, IS_SERVERLESS } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Postgres returns BIGINT (OID 20) as a string to avoid precision loss. Our only
// bigints are the identity PKs on note_versions/review_log, which stay far inside
// Number.MAX_SAFE_INTEGER and are compared numerically by callers.
pg.types.setTypeParser(20, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  // Each serverless instance holds its own pool, so keep per-instance connections
  // low to stay under Neon's ceiling when many instances are warm at once.
  max: IS_SERVERLESS ? 1 : 10,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
  ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? undefined : { rejectUnauthorized: false },
});

/**
 * Rewrite SQLite-style `?` placeholders to Postgres `$1..$n`.
 *
 * The whole route layer was written against better-sqlite3. Rather than hand-edit
 * ~95 SQL literals (and risk a silent off-by-one in a WHERE clause), the driver
 * adapts. Quoted runs and line comments are copied verbatim so a literal '?' in
 * text is never mistaken for a parameter.
 */
export function toPgPlaceholders(sql: string): string {
  return rewrite(sql).text;
}

/** Rewrite, and report how many placeholders were emitted so callers can check. */
export function rewrite(sql: string): { text: string; count: number } {
  let out = '';
  let n = 0;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += ch;
      i++;
      while (i < sql.length) {
        out += sql[i];
        if (sql[i] === quote) {
          // A doubled quote is an escaped quote, not the end of the run.
          if (sql[i + 1] === quote) {
            out += sql[i + 1];
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') out += sql[i++];
      continue;
    }
    // Block comments. Without this, a '?' inside /* ... */ is counted as a
    // parameter and every placeholder after it shifts by one - binding values to
    // the wrong columns silently, with no error anywhere.
    if (ch === '/' && sql[i + 1] === '*') {
      out += '/*';
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) out += sql[i++];
      if (i < sql.length) {
        out += '*/';
        i += 2;
      }
      continue;
    }
    // Dollar-quoted strings ($$...$$ or $tag$...$tag$). Same hazard as above, and
    // additionally the body is literal text where a '?' is never a parameter.
    if (ch === '$') {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? sql.length : end + tag.length;
        out += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }
    // E'...' escape strings, where a backslash escapes the closing quote.
    if ((ch === 'E' || ch === 'e') && sql[i + 1] === "'") {
      out += sql[i] + "'";
      i += 2;
      while (i < sql.length) {
        if (sql[i] === '\\' && i + 1 < sql.length) {
          out += sql[i] + sql[i + 1];
          i += 2;
          continue;
        }
        out += sql[i];
        if (sql[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === '?') {
      out += '$' + ++n;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return { text: out, count: n };
}

type Params = readonly unknown[];

/**
 * Mirrors the slice of better-sqlite3's Statement API the route layer used, but
 * async. Keeping the `prepare(sql).all(...)` shape meant the migration added an
 * `await` at each call site instead of restructuring every handler.
 */
export interface Statement {
  all<T = Record<string, unknown>>(...params: Params): Promise<T[]>;
  get<T = Record<string, unknown>>(...params: Params): Promise<T | undefined>;
  run(...params: Params): Promise<{ changes: number }>;
}

interface Queryable {
  query(text: string, values?: unknown[]): Promise<pg.QueryResult>;
}

function statement(runner: Queryable, sql: string): Statement {
  const { text, count } = rewrite(sql);

  /**
   * Catch a placeholder miscount at the call site instead of letting Postgres bind
   * values to the wrong columns.
   *
   * The rewriter has to understand every way SQL can quote or comment out a literal
   * '?'. A security review found it mishandled block comments and dollar-quoting -
   * harmless in this codebase today because no query contains them, but the failure
   * mode is silent data corruption, not an error. This assertion does not depend on
   * the rewriter being right about syntax it has never seen: if the number of
   * placeholders emitted disagrees with the number of arguments supplied, the query
   * does not run.
   */
  const assertArity = (params: Params) => {
    if (params.length !== count) {
      throw new Error(
        `SQL parameter mismatch: query expects ${count} placeholder(s) but ${params.length} argument(s) were supplied. ` +
          `This usually means a literal '?' inside a comment or quoted string was counted as a parameter. SQL: ${sql.slice(0, 200)}`,
      );
    }
  };

  return {
    async all<T>(...params: Params) {
      assertArity(params);
      const r = await runner.query(text, params as unknown[]);
      return r.rows as T[];
    },
    async get<T>(...params: Params) {
      assertArity(params);
      const r = await runner.query(text, params as unknown[]);
      return r.rows[0] as T | undefined;
    },
    async run(...params: Params) {
      assertArity(params);
      const r = await runner.query(text, params as unknown[]);
      return { changes: r.rowCount ?? 0 };
    },
  };
}

export interface Db {
  prepare(sql: string): Statement;
  exec(sql: string): Promise<void>;
}

export const db: Db = {
  prepare: (sql) => statement(pool, sql),
  exec: async (sql) => {
    await pool.query(sql);
  },
};

/**
 * Run `fn` inside a transaction on one dedicated connection.
 *
 * The module-level `db` draws a possibly-different pooled connection per
 * statement, which would silently run the body outside the transaction - so the
 * callback receives its own scoped `Db` and must use that instead.
 */
export async function tx<T>(fn: (t: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  const scoped: Db = {
    prepare: (sql) => statement(client, sql),
    exec: async (sql) => {
      await client.query(sql);
    },
  };
  try {
    await client.query('BEGIN');
    const result = await fn(scoped);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

let migrated: Promise<void> | null = null;

/**
 * Apply schema.sql. Idempotent, and de-duplicated so the concurrent requests that
 * hit a cold serverless instance run it once rather than racing each other.
 */
export function migrate(): Promise<void> {
  migrated ??= (async () => {
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(schema);
  })().catch((err) => {
    migrated = null; // let a later request retry rather than caching the failure
    throw err;
  });
  return migrated;
}

/**
 * Tables carrying a `deleted_at` tombstone, purged on the same 30-day clock.
 *
 * `notes` leads deliberately: notebooks cascade to their notes, so purging notebooks
 * first would delete notes that were never tombstoned and take their count with them.
 */
const TOMBSTONED = ['notes', 'notebooks', 'canvas_items', 'canvas_edges', 'note_ink', 'flashcards'] as const;

/**
 * Purge rows soft-deleted more than `days` ago, across every tombstoned table.
 *
 * Tombstones exist so an offline client learns about a delete it missed. They are
 * therefore garbage the moment no client could still be that far behind - but they
 * are NOT optional before then, so the window has to outlast a plausible offline
 * stretch. 30 days matches what notes already used.
 */
export async function purgeExpiredDeleted(days = 30): Promise<Record<string, number>> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const out: Record<string, number> = {};
  for (const table of TOMBSTONED) {
    // The table name is interpolated, never a parameter - Postgres has no placeholder
    // for an identifier. It comes from the const list above, so nothing user-supplied
    // reaches this string.
    const r = await db
      .prepare(`DELETE FROM ${table} WHERE deleted_at IS NOT NULL AND deleted_at < ?`)
      .run(cutoff);
    out[table] = r.changes;
  }
  return out;
}

/** @deprecated use purgeExpiredDeleted. Kept so existing boot code is untouched. */
export async function purgeExpiredDeletedNotes(days = 30): Promise<number> {
  const counts = await purgeExpiredDeleted(days);
  return counts.notes ?? 0;
}

export function newId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  for (const b of bytes) id += alphabet[b % alphabet.length];
  return id;
}

export function nowIso(): string {
  return new Date().toISOString();
}
