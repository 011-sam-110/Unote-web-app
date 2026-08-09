// Carrying browser-local guest work into a real account.
//
// This is the point of guest mode: someone tried the product, wrote something they care
// about, and made an account. Everything up to here was deliberately unsaved, so this is
// the one moment where losing it would be the app's fault rather than the stated deal.
//
// Two rules the implementation follows:
//  - The local store is only cleared once every note has been confirmed created. A partial
//    failure leaves the guest copy exactly where it was, so the offer can be made again.
//  - Notebooks are matched to the account's existing ones by name before a new one is
//    created, so a returning user does not accumulate a second "My notes" every visit.
import { api } from '../../lib/api';
import { clearLocalStore, localSnapshot } from '../../lib/local/localApi';
import { clearData } from './guestStore';
import { isGuest } from './guestMode';

export interface MigrationProgress {
  total: number;
  done: number;
}

export interface MigrationResult {
  notesCreated: number;
  notebooksCreated: number;
  failed: number;
  /** True when nothing failed, which is the only case that clears the guest copy. */
  complete: boolean;
}

export async function migrateGuestWork(onProgress?: (p: MigrationProgress) => void): Promise<MigrationResult> {
  if (isGuest()) {
    // A live guest flag would send every call below straight back into the local store.
    // The caller (GuestMigrationHost) ends guest mode the moment a session appears.
    throw new Error('Sign in before bringing your notes across.');
  }

  const data = await localSnapshot();
  const notes = data.notes;
  const total = notes.length;
  let done = 0;
  let notesFailed = 0;
  let notebooksFailed = 0;
  let notebooksCreated = 0;
  onProgress?.({ total, done });

  const { notebooks: existing } = await api.notebooks();
  const byName = new Map(existing.map((nb) => [nb.name.trim().toLowerCase(), nb.id]));
  const mapped = new Map<string, string>();

  for (const nb of data.notebooks) {
    const key = nb.name.trim().toLowerCase();
    const found = byName.get(key);
    if (found) {
      mapped.set(nb.id, found);
      continue;
    }
    try {
      const { notebook } = await api.createNotebook({ name: nb.name, emoji: nb.emoji, color: nb.color });
      mapped.set(nb.id, notebook.id);
      byName.set(key, notebook.id);
      notebooksCreated++;
    } catch {
      // Its notes fall back to whatever notebook the account already has, rather than
      // being dropped for want of a folder.
      notebooksFailed++;
    }
  }

  const fallback = mapped.values().next().value ?? existing[0]?.id;

  for (const note of notes) {
    const notebookId = mapped.get(note.notebookId) ?? fallback;
    if (!notebookId) {
      notesFailed++;
      done++;
      onProgress?.({ total, done });
      continue;
    }
    try {
      await api.createNote({
        notebookId,
        title: note.title,
        contentJson: note.contentJson,
        contentText: note.contentText,
        tags: note.tags,
      });
    } catch {
      notesFailed++;
    }
    done++;
    onProgress?.({ total, done });
  }

  // Only a clean run drops the local copy. If anything failed the guest notes stay put,
  // and the prompt can be shown again rather than the work quietly disappearing.
  //
  // Both stores go: the Dexie rows these notes were read from, and the pre-upgrade
  // localStorage blob that guestMode still reads to decide whether work is present. The
  // outbox goes with them (clearLocalStore), which matters more than it looks - those
  // entries name ids the account has never heard of, and pushing them after a handover
  // would create every note a second time.
  const complete = notesFailed === 0 && notebooksFailed === 0;
  if (complete) {
    await clearLocalStore();
    clearData();
  }
  return { notesCreated: total - notesFailed, notebooksCreated, failed: notesFailed + notebooksFailed, complete };
}
