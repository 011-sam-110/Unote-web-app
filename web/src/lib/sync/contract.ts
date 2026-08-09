// The wire contract between the local store and the server, and the single source
// of truth for both sides of sync. The server imports these types too (via a
// relative path from server/src), so a change cannot land on one side only.
//
// Nothing in this file may import anything else from the app. It is loaded by both
// the browser bundle and the Node server, and a stray DOM or Node import would
// break one of them.

/** Tables the offline client mirrors. */
export const SYNC_ENTITIES = [
  'notebook', 'note', 'canvasItem', 'canvasEdge', 'ink', 'flashcard', 'review',
] as const;
export type SyncEntity = (typeof SYNC_ENTITIES)[number];

/**
 * Push order, and it is load-bearing rather than tidy.
 *
 * The server validates references - routes/notes.ts answers 400 for an unknown
 * notebookId - so a note created offline inside a notebook created offline must be
 * sent after that notebook. Reviews go last because they reference flashcards.
 */
export const OUTBOX_ORDER: readonly SyncEntity[] = [
  'notebook', 'note', 'flashcard', 'canvasItem', 'canvasEdge', 'ink', 'review',
];

export type OutboxOp = 'create' | 'update' | 'delete';

/** Every synced record carries these three, whatever else it holds. */
export interface SyncedRecord {
  id: string;
  updatedAt: string;
  /** Non-null means tombstoned. The record still arrives - it is a delete notice. */
  deletedAt: string | null;
}

/**
 * A composite cursor, NOT a bare timestamp.
 *
 * With a bare timestamp `>` silently skips every record sharing the boundary
 * instant and `>=` returns them forever. Both failures are invisible until a user
 * loses a note. The id breaks the tie and makes the ordering total.
 */
export interface SyncCursor {
  updatedAt: string;
  id: string;
}

/** Opaque on the wire, so the client never constructs one by hand. */
export type EncodedCursor = string;

export interface SyncChangesResponse {
  /** Feed straight back as `since` on the next request. Null means caught up. */
  cursor: EncodedCursor | null;
  hasMore: boolean;
  /**
   * The server's clock when it answered. The client stores the offset and corrects
   * its own timestamps before pushing, because an offline edit carries only the
   * client's claim about when it happened - a machine an hour fast would otherwise
   * win every conflict and one an hour slow would lose every one.
   */
  serverNow: string;
  changes: SyncChangeSet;
}

export type SyncChangeSet = {
  [K in SyncEntity]?: Array<SyncedRecord & Record<string, unknown>>;
};

export const DEFAULT_SYNC_LIMIT = 500;
export const MAX_SYNC_LIMIT = 2000;

// --- writes -----------------------------------------------------------------

/**
 * The two fields a synced write adds to an ordinary request body.
 *
 * Both are optional, and that is what keeps this change invisible to the website:
 * a request with neither behaves exactly as it did before, so every existing
 * caller is unaffected.
 */
export interface SyncWriteFields {
  /**
   * The server `updated_at` the client last saw for this record. A mismatch
   * against the row's current value is a conflict. Absent means "no opinion, do
   * not check".
   */
  baseUpdatedAt?: string | null;
  /**
   * When the client believes the edit happened, already corrected for clock
   * offset. The server clamps it to between the row's created_at and its own now
   * rather than rejecting - rejecting would strand the edit in the outbox over a
   * wrong system clock the user may not be able to change.
   */
  clientUpdatedAt?: string;
}

/** Added to the response of any write that carried SyncWriteFields. */
export interface SyncWriteResult {
  /** True when the server resolved a conflict. The losing copy went to history. */
  conflicted?: boolean;
  /** Set when `conflicted` and the entity keeps history (notes only). */
  versionId?: number;
}
