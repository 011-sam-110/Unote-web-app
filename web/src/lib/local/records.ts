// Local record shapes.
//
// Every mirrored record carries `baseUpdatedAt`: the server updated_at this client
// last saw for it. It is the entire basis of conflict detection, and it must be
// written ONLY when applying a server record - never by a local edit, or the
// client would claim to have seen a version it invented.
//
// OutboxOp is imported rather than redeclared: two definitions of the same union
// in two modules is how one of them silently gains a member the other rejects.
import type { SyncEntity, OutboxOp } from '../sync/contract';

export type { OutboxOp };

export interface LocalBase {
  id: string;
  updatedAt: string;
  deletedAt: string | null;
  /** Server's updated_at as last observed. Null for a record never pushed. */
  baseUpdatedAt: string | null;
}

export interface LocalNotebook extends LocalBase {
  name: string;
  emoji: string;
  color: string;
  position: number;
  archived: number;
  createdAt: string;
}

export interface LocalNote extends LocalBase {
  notebookId: string;
  title: string;
  contentJson: string;
  contentText: string;
  kind: string;
  pinned: number;
  archived: number;
  createdAt: string;
  tags: string[];
}

/** Column names match the server's `flashcards` table: question/answer, not front/back. */
export interface LocalFlashcard extends LocalBase {
  noteId: string | null;
  question: string;
  answer: string;
  dueAt: string;
  intervalDays: number;
  ease: number;
  reps: number;
  lapses: number;
  suspended: number;
  createdAt: string;
}

/** Append-only, so it needs no base and never conflicts. */
export interface LocalReview {
  /** Client-side id. The server's review_log PK is a BIGINT identity it owns. */
  id: string;
  cardId: string;
  rating: 'again' | 'hard' | 'good' | 'easy';
  reviewedAt: string;
}

export interface OutboxEntry {
  /** Dexie auto-increment. Drain order within an entity is insertion order. */
  seq?: number;
  entity: SyncEntity;
  op: OutboxOp;
  recordId: string;
  /** The write body. Coalescing replaces this wholesale with the newest. */
  payload: Record<string, unknown>;
  baseUpdatedAt: string | null;
  clientUpdatedAt: string;
  attempts: number;
  lastError: string | null;
}

export interface SyncMetaRow {
  /**
   * `initialSyncDone` gates whether reads may trust the mirror. Until the first
   * full pull finishes, an empty mirror and a genuinely empty account are
   * indistinguishable, and serving the empty one would show a signed-in user zero
   * notes on a fresh install.
   */
  key: 'cursor' | 'clockOffsetMs' | 'lastSyncAt' | 'initialSyncDone';
  value: string;
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Ids generated here must be indistinguishable from the server's newId(), because
 * the server accepts only that exact shape and silently re-mints anything else -
 * which would cost this record its inbound wikilinks.
 */
export function newLocalId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  let id = '';
  for (const b of bytes) id += ALPHABET[b % ALPHABET.length];
  return id;
}
