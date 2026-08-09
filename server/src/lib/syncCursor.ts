// Composite sync cursor. See web/src/lib/sync/contract.ts for why it is not a bare
// timestamp: with one, `>` silently skips every record sharing the boundary instant
// and `>=` returns them forever.
//
// `import type` only - the type is erased at compile time, so nothing from the web
// workspace is pulled into the serverless bundle.
import type { SyncCursor } from '../../../web/src/lib/sync/contract.js';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * JSON inside base64url rather than a delimiter-joined string, so an id that
 * happens to contain the delimiter cannot be forged into a different
 * (updatedAt, id) pair - which would make the server skip real records.
 */
export function encodeCursor(cursor: SyncCursor): string {
  return Buffer.from(JSON.stringify([cursor.updatedAt, cursor.id]), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): SyncCursor | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [updatedAt, id] = parsed;
    if (typeof updatedAt !== 'string' || typeof id !== 'string') return null;
    if (!ISO.test(updatedAt)) return null;
    return { updatedAt, id };
  } catch {
    return null;
  }
}
