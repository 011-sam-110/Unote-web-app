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

/**
 * One spatial child of a board. Mirrors `canvas_items` (schema.sql:215).
 *
 * `data` is TEXT holding JSON, exactly as the server column is, rather than a parsed
 * object. The column is opaque to the server and it is opaque here too, so keeping it
 * as the string that came off the wire means a payload written by a newer client
 * round-trips through this store untouched instead of being reshaped by a parse.
 */
export interface LocalCanvasItem extends LocalBase {
  noteId: string;
  kind: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  z: number;
  data: string;
  createdAt: string;
}

/**
 * A connector between two canvas items. Mirrors `canvas_edges`.
 *
 * The columns are `from_item_id`/`to_item_id`, and the names are kept: the DTO the UI
 * reads calls them `from`/`to`, but `from` is a reserved word in enough contexts to be
 * worth not having as a stored key.
 */
export interface LocalCanvasEdge extends LocalBase {
  noteId: string;
  fromItemId: string;
  toItemId: string;
  label: string;
  style: string;
  createdAt: string;
}

/**
 * One pen stroke. Mirrors `note_ink`.
 *
 * There is no conflict resolution for ink and there does not need to be: a stroke is
 * written once and never edited, so two devices drawing on the same note produce two
 * rows and both survive - the same property that makes `review_log` free. The only
 * write that ever touches an existing stroke is the eraser, and that is a delete.
 *
 * `updatedAt` is inherited from LocalBase and is real - the Stage 1 migration added
 * the column - but it exists so the delta feed can order and page these rows, not
 * because anything ever changes them. Do not read it as a version.
 */
export interface LocalInk extends LocalBase {
  noteId: string;
  /** TEXT holding {points, color, width, tool}, as the server stores it. */
  stroke: string;
  createdAt: string;
}

/**
 * The bytes of an image inserted while offline, held until the server has them.
 *
 * This mirrors nothing. It is a staging area with a strict lifecycle (see
 * local/blobs.ts): the note's content points at `local-blob:<id>` while the bytes live
 * here, and the row is dropped only once the note has been rewritten to the server's
 * URL AND that rewrite has been confirmed by the outbox draining.
 *
 * `noteId` starts null. The editor uploads an image before it knows where it will be
 * placed - the server's own /api/import/image does the same, filing the attachment
 * with note_id NULL - so the owning note is worked out later by finding the note whose
 * content carries this blob's reference.
 */
export interface LocalBlob {
  id: string;
  noteId: string | null;
  mime: string;
  bytes: Blob;
  /** The file's own name, so the upload reaches the server as the user's file. */
  name: string;
  createdAt: string;
  /** Set once the bytes are on the server. Until then the rewrite cannot happen. */
  serverUrl: string | null;
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
   *
   * `cursor` and `initialSyncDone` are BOTH cleared by the Dexie version 2 upgrade,
   * and nothing else here is - see db.ts for why. In particular the clock offset
   * survives, because a client that has forgotten how wrong its clock is loses
   * conflicts it should win until the next sync response recalibrates it.
   *
   * `searchIndex` holds the serialised offline search index (local/search).
   */
  key: 'cursor' | 'clockOffsetMs' | 'lastSyncAt' | 'initialSyncDone' | 'searchIndex' | 'customDictionary';
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
