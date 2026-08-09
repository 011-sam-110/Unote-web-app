// The local mirror. Dexie over IndexedDB.
//
// IndexedDB rather than the localStorage guest mode used: the ~4MB origin quota
// could hold plain-text trial notes but not a real library, and IndexedDB has no
// synchronous-write cliff on a large put.
//
// Indexes are chosen for the reads the app actually performs. deletedAt is NOT
// indexable as a null check, so every list read filters tombstones in code - the
// db.test.ts case for that is a guard, not a formality.
import Dexie, { type EntityTable } from 'dexie';
import type {
  LocalBlob, LocalCanvasEdge, LocalCanvasItem, LocalFlashcard, LocalInk, LocalNote,
  LocalNotebook, LocalReview, OutboxEntry, SyncMetaRow,
} from './records';

export class LocalDb extends Dexie {
  notebooks!: EntityTable<LocalNotebook, 'id'>;
  notes!: EntityTable<LocalNote, 'id'>;
  flashcards!: EntityTable<LocalFlashcard, 'id'>;
  reviews!: EntityTable<LocalReview, 'id'>;
  canvasItems!: EntityTable<LocalCanvasItem, 'id'>;
  canvasEdges!: EntityTable<LocalCanvasEdge, 'id'>;
  ink!: EntityTable<LocalInk, 'id'>;
  blobs!: EntityTable<LocalBlob, 'id'>;
  outbox!: EntityTable<OutboxEntry, 'seq'>;
  meta!: EntityTable<SyncMetaRow, 'key'>;

  /**
   * `dbName` is parameterised for one reason: the convergence harness (Task 14)
   * runs two independent clients in one process, and fake-indexeddb is
   * process-global - two clients on one database name would silently be ONE
   * store, and every convergence assertion would pass for the wrong reason.
   */
  constructor(dbName = 'unote') {
    super(dbName);
    this.version(1).stores({
      notebooks: 'id, position, updatedAt',
      notes: 'id, notebookId, updatedAt, title, *tags',
      flashcards: 'id, noteId, dueAt, updatedAt',
      reviews: 'id, cardId, reviewedAt',
      // [entity+recordId] is the coalescing key: finding the pending entry for a
      // record must be one index hit, since it happens on every keystroke batch.
      outbox: '++seq, [entity+recordId], entity',
      meta: 'key',
    });

    // Version 2 - Stage 2. Boards, ink and the bytes of an image inserted offline.
    //
    // Canvas items and ink are indexed by noteId because that is the only read the
    // app ever makes of them: a board or an ink overlay is always loaded for one
    // note. Ink additionally carries createdAt, because strokes render in the order
    // they were drawn and the server's own GET orders by it.
    this.version(2)
      .stores({
        canvasItems: 'id, noteId, updatedAt',
        canvasEdges: 'id, noteId, updatedAt',
        ink: 'id, noteId, createdAt',
        blobs: 'id, noteId',
      })
      .upgrade(async (tx) => {
        // THE ONE THING THIS UPGRADE IS REALLY FOR.
        //
        // Until this version the sync engine mirrored notebooks, notes and
        // flashcards only, and engine.ts SKIPPED canvas and ink records rather
        // than failing on them - but skipping still advanced the cursor past
        // them. So every board and every stroke this account already owns sits
        // BEHIND the cursor this browser holds, and a delta pull would never
        // mention them again.
        //
        // Clearing the cursor forces a full re-pull. Dropping initialSyncDone
        // with it keeps reads honest while that runs: a half-filled mirror must
        // not be presented as the whole library.
        //
        // Without this the tables would simply be born empty on every existing
        // install, permanently, with nothing in the UI to suggest anything was
        // missing.
        await tx.table('meta').delete('cursor');
        await tx.table('meta').delete('initialSyncDone');
      });
  }
}

export const localDb = new LocalDb();

/** Has this browser got a mirror yet? Decides first-sync vs delta on boot. */
export async function hasLocalData(): Promise<boolean> {
  return (await localDb.notes.count()) > 0 || (await localDb.notebooks.count()) > 0;
}

export async function readMeta(key: SyncMetaRow['key']): Promise<string | null> {
  return (await localDb.meta.get(key))?.value ?? null;
}

export async function writeMeta(key: SyncMetaRow['key'], value: string): Promise<void> {
  await localDb.meta.put({ key, value });
}
