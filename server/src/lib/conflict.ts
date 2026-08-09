// Conflict resolution, server-side and nowhere else.
//
// The server is the sole authority on purpose. A client that resolved conflicts
// itself would need this logic in two places, and two copies of a merge rule drift
// - at which point two devices disagree about which edit won and both are certain.
import { db } from '../db.js';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

/**
 * Bound a client's claimed edit time to something the row's own history allows:
 * never later than the server's now, never earlier than the row's created_at.
 *
 * Clamps rather than rejects. Rejecting would strand the user's edit in the outbox
 * over a wrong system clock they may not be able to change.
 */
export function clampEditTime(claimed: string | undefined, createdAt: string, serverNow: string): string {
  if (!claimed || !ISO.test(claimed)) return serverNow;
  if (claimed > serverNow) return serverNow;
  if (claimed < createdAt) return createdAt;
  return claimed;
}

export interface ResolveArgs {
  /** The server's current updated_at for the row. */
  currentUpdatedAt: string;
  /** What the client last saw. Undefined/null means "no opinion, do not check". */
  baseUpdatedAt: string | null | undefined;
  /** The client's clamped edit time. */
  clientUpdatedAt: string;
}

export interface Resolution {
  conflicted: boolean;
  winner: 'client' | 'server';
}

/**
 * Decide a single write.
 *
 * No baseUpdatedAt means the caller is the website writing normally - there is
 * nothing to compare, so the write proceeds. That is what keeps this change
 * invisible to every existing caller.
 */
export function resolve(args: ResolveArgs): Resolution {
  const { currentUpdatedAt, baseUpdatedAt, clientUpdatedAt } = args;
  if (baseUpdatedAt == null) return { conflicted: false, winner: 'client' };
  if (baseUpdatedAt === currentUpdatedAt) return { conflicted: false, winner: 'client' };
  // Both sides moved. Newest wins; a tie goes to the server, because the server's
  // copy is the one other clients have already pulled.
  return { conflicted: true, winner: clientUpdatedAt > currentUpdatedAt ? 'client' : 'server' };
}

/**
 * Preserve a note body that lost a conflict. Notes are the only entity with a
 * history table, so this is where "nothing is destroyed" is actually true - see
 * the spec's accepted limitation for the others.
 */
export async function demoteToVersion(noteId: string, title: string, contentJson: string): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO note_versions (note_id, title, content_json, cause)
       VALUES (?, ?, ?, 'conflict') RETURNING id`,
    )
    .get<{ id: number }>(noteId, title, contentJson);
  return row!.id;
}
