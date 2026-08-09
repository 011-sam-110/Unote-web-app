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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './auth.fixture';
import {
  createNoteViaButton,
  createNotebookViaSidebar,
  editorBody,
  openNotebook,
  setNoteTitle,
  TESTIDS,
  uniqueName,
  waitForSaved,
} from './utils';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

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

  test('an image inserted with the network cut renders, survives a remount, and ends up on the server', async ({ page, context, request }) => {
    // Longer than the file's default because this spec waits on the sync POLL. There
    // is no push channel, so a reconnect that does not coincide with a connectivity
    // event is up to a minute away from the next cycle.
    test.setTimeout(150_000);
    // A note that cannot take a screenshot is not offline, so this is the whole of
    // §9 end to end: bytes to IndexedDB, a `local-blob:` reference in the document,
    // and on reconnect an upload followed by a rewrite of the note's content - which
    // goes through the outbox like any other edit.
    //
    // "Reload" in the plan is a client-side remount here rather than a browser
    // reload, for the reason at the top of this file: the e2e web server is Vite in
    // dev mode, there is no service worker, and a real reload while offline would
    // fail to fetch the app shell. Navigating away and back re-runs the load path
    // and rebuilds the image's node view from the store, which is the part this
    // stage actually built.
    const notebookName = uniqueName('Image notebook');
    const noteTitle = uniqueName('With a screenshot');

    await page.goto('/');
    await createNotebookViaSidebar(page, notebookName);
    await openNotebook(page, notebookName);
    await createNoteViaButton(page);
    await setNoteTitle(page, noteTitle);
    await waitForSaved(page);

    const noteId = page.url().split('/note/')[1]?.split(/[?#]/)[0];
    expect(noteId, 'the URL should carry the note id').toBeTruthy();
    await waitForFirstSync(page);

    await context.setOffline(true);

    const body = editorBody(page);
    await body.click();
    await page.keyboard.type('/', { delay: 10 });
    const slashMenu = page.getByTestId(TESTIDS.slashMenu);
    await expect(slashMenu).toBeVisible({ timeout: 5_000 });
    const chooser = page.waitForEvent('filechooser');
    await slashMenu.getByTestId(TESTIDS.slashMenuItem).filter({ hasText: /^image/i }).first().click();
    await (await chooser).setFiles(path.join(FIXTURES_DIR, 'note-photo.png'));

    // A blob: src is the node view having resolved the reference out of IndexedDB.
    // The DOCUMENT holds `local-blob:<id>`; an object URL in there would be dead the
    // next time this note was opened.
    const image = body.locator('img.folio-image').first();
    await expect(image).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => image.getAttribute('src'), { timeout: 10_000 }).toMatch(/^blob:/);

    // Away and back, so the note is loaded from the mirror and the node view is
    // rebuilt from scratch.
    await page.getByRole('link', { name: 'Home' }).click();
    await openNotebook(page, notebookName);
    await page.getByText(noteTitle, { exact: false }).first().click();
    const reopened = editorBody(page).locator('img.folio-image').first();
    await expect(reopened).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => reopened.getAttribute('src'), { timeout: 10_000 }).toMatch(/^blob:/);

    await context.setOffline(false);

    // Asking the API rather than the UI is what makes this a claim about the
    // server's data: the note it holds must point at the server's own copy of the
    // image, with no trace of the local reference left in it.
    await expect
      .poll(
        async () => {
          const res = await request.get(`/api/notes/${noteId}`);
          if (!res.ok()) return null;
          return JSON.stringify((await res.json()).note?.contentJson ?? null);
        },
        { timeout: 90_000, message: 'the note never came to point at an uploaded image' },
      )
      .toMatch(/\/uploads\//);

    const serverCopy = JSON.stringify((await (await request.get(`/api/notes/${noteId}`)).json()).note.contentJson);
    expect(serverCopy).not.toContain('local-blob:');

    // And it still renders - from the server's URL now rather than from the bytes.
    await page.reload();
    const afterSync = editorBody(page).locator('img.folio-image').first();
    await expect(afterSync).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => afterSync.getAttribute('src'), { timeout: 15_000 }).toMatch(/\/uploads\//);
  });
});
