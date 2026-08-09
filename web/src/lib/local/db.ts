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
  LocalFlashcard, LocalNote, LocalNotebook, LocalReview, OutboxEntry, SyncMetaRow,
} from './records';

export class LocalDb extends Dexie {
  notebooks!: EntityTable<LocalNotebook, 'id'>;
  notes!: EntityTable<LocalNote, 'id'>;
  flashcards!: EntityTable<LocalFlashcard, 'id'>;
  reviews!: EntityTable<LocalReview, 'id'>;
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
