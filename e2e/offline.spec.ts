// Offline note-taking, in a real browser with the network genuinely cut.
//
// Everything else covering this layer is a unit or a fake-server harness. This is
// the only place the whole stack runs at once: the Proxy seam picking a side, the
// Dexie mirror answering a read, the outbox holding a write, and the sync engine
// pushing it when the connection returns.
//
// One limitation worth stating rather than working around: `registerServiceWorker()`
// returns early under `import.meta.env.DEV`, and the e2e web server IS the Vite dev
// server. So there is no service worker here, and a full page RELOAD while offline
// cannot work - the app shell itself would fail to load. These specs therefore test
// the DATA layer offline, via client-side navigation, which is the part this project
// actually built. Offline shell delivery is the service worker's job and is verified
// separately by asserting the generated sw.js precaches the shell.
import { expect, test } from './auth.fixture';
import {
  createNoteViaButton,
  createNotebookViaSidebar,
  openNotebook,
  setNoteTitle,
  uniqueName,
  waitForSaved,
} from './utils';

/**
 * Read a value out of the app's IndexedDB WITHOUT creating it.
 *
 * `indexedDB.open(name)` with no version CREATES the database when it is absent -
 * empty, with no object stores, at version 1. Dexie then opens that same version,
 * finds none of its stores, and the app's whole local store is broken by the test
 * that was only trying to look at it. An earlier version of this file did exactly
 * that and made a spec fail for a reason that had nothing to do with the app.
 *
 * So: check the database exists first, and only then open it.
 */
async function readLocal(
  page: import('@playwright/test').Page,
  store: 'meta' | 'outbox',
  op: 'get-initial-sync' | 'count',
): Promise<string | number | null> {
  return page.evaluate(
    async ({ store, op }) => {
      const existing = await indexedDB.databases();
      if (!existing.some((d) => d.name === 'unote')) return null;

      return new Promise<string | number | null>((resolve) => {
        const open = indexedDB.open('unote');
        open.onerror = () => resolve(null);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains(store)) return resolve(null);
          const os = db.transaction(store).objectStore(store);
          const req = op === 'count' ? os.count() : os.get('initialSyncDone');
          req.onsuccess = () => {
            const raw = req.result;
            if (op === 'count') return resolve(typeof raw === 'number' ? raw : null);
            resolve((raw as { value?: string } | undefined)?.value ?? null);
          };
          req.onerror = () => resolve(null);
        };
      });
    },
    { store, op },
  );
}

/** Wait until the mirror has been filled, which is what makes offline reads possible. */
async function waitForFirstSync(page: import('@playwright/test').Page): Promise<void> {
  await expect
    .poll(() => readLocal(page, 'meta', 'get-initial-sync'), {
      timeout: 30_000,
      message: 'the first sync never completed, so the mirror is empty',
    })
    .toBe('1');
}

test.describe('Offline notes', () => {
  test('a note written online is still readable with the network cut', async ({ page, context }) => {
    const notebookName = uniqueName('Offline notebook');
    const noteTitle = uniqueName('Written online');

    await page.goto('/');
    await createNotebookViaSidebar(page, notebookName);
    await openNotebook(page, notebookName);
    await createNoteViaButton(page);
    await setNoteTitle(page, noteTitle);
    await waitForSaved(page);

    await waitForFirstSync(page);

    // Cut the network. Every fetch now rejects at the transport level, which is what
    // the app treats as offline - as opposed to an HTTP error, which proves a server
    // answered.
    await context.setOffline(true);

    // Client-side navigation away and back. The notebook list and its notes have to
    // come from the mirror now; there is nothing else to serve them.
    await page.getByRole('link', { name: 'Home' }).click();
    await openNotebook(page, notebookName);

    // .first(): the title legitimately renders more than once (the note card and the
    // open note's heading). Either one proves the mirror answered.
    await expect(page.getByText(noteTitle, { exact: false }).first()).toBeVisible({ timeout: 15_000 });

    await context.setOffline(false);
  });

  test('the offline indicator appears, and says the notes are safe', async ({ page, context }) => {
    await page.goto('/');
    await waitForFirstSync(page);

    await context.setOffline(true);
    // Provoke one request so the app learns the connection is gone rather than
    // waiting for its own poll.
    await page.getByRole('link', { name: 'Home' }).click();

    const status = page.getByTestId('connection-status');
    await expect(status).toBeVisible({ timeout: 20_000 });
    // The wording matters as much as the presence: this tells the user their work is
    // safe, rather than reporting a fault they cannot act on.
    await expect(status).toContainText(/saved on this device/i);

    await context.setOffline(false);
    // And it goes away again once there is nothing outstanding.
    await expect(status).toBeHidden({ timeout: 30_000 });
  });

  test('an edit made offline reaches the server after reconnecting', async ({ page, context, request }) => {
    const notebookName = uniqueName('Reconnect notebook');
    const originalTitle = uniqueName('Before offline');
    const offlineTitle = uniqueName('Edited offline');

    await page.goto('/');
    await createNotebookViaSidebar(page, notebookName);
    await openNotebook(page, notebookName);
    await createNoteViaButton(page);
    await setNoteTitle(page, originalTitle);
    await waitForSaved(page);

    const noteId = page.url().split('/note/')[1]?.split(/[?#]/)[0];
    expect(noteId, 'the URL should carry the note id').toBeTruthy();

    await waitForFirstSync(page);

    await context.setOffline(true);
    await setNoteTitle(page, offlineTitle);

    // The queue is the proof the edit was captured rather than dropped on a failed
    // request. Asserting the queue rather than the UI is deliberate: a title input
    // shows the new text whether or not anything persisted it.
    await expect
      .poll(() => readLocal(page, 'outbox', 'count'), {
        timeout: 20_000,
        message: 'the offline edit never reached the outbox',
      })
      .toBeGreaterThan(0);

    await context.setOffline(false);

    // Now the server should learn about it. Asking the API directly, rather than
    // reading the UI, is what makes this a claim about the server's data.
    await expect
      .poll(
        async () => {
          const res = await request.get(`/api/notes/${noteId}`);
          if (!res.ok()) return null;
          return (await res.json()).note?.title as string | null;
        },
        { timeout: 45_000, message: 'the queued edit never reached the server' },
      )
      .toBe(offlineTitle);
  });
});
