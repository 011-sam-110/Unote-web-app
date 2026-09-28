// Iteration-1 fix coverage: editor data integrity (load race, failed-save retry,
// restore-refresh), soft-delete undo, notebook type-to-delete, context filing (Ctrl+N),
// the study notebook filter and the "Move to notebook" submenu. Import-pipeline fixes
// live in import.spec.ts / mobile-capture.spec.ts.
import { expect, test } from './auth.fixture';
import {
  TESTIDS,
  apiCreateFlashcard,
  apiCreateNote,
  apiCreateNotebook,
  clickNoteMoreItem,
  createNoteViaButton,
  createNotebookViaSidebar,
  editorBody,
  exact,
  noteIdFromUrl,
  openNotebook,
  openQuickSwitcher,
  quickSwitcherInput,
  setNoteTitle,
  sidebarNav,
  typeInEditor,
  uniqueName,
  waitForSaved,
} from './utils';

test.describe('Editor data integrity', () => {
  test('rapid navigation: a slow stale note GET cannot overwrite the current note', async ({ page, request }) => {
    const notebook = await apiCreateNotebook(request, uniqueName('E2E Race Notebook'));
    const noteA = await apiCreateNote(request, notebook.id, uniqueName('Race Note Alpha'), {
      contentText: 'ALPHA-CONTENT unique marker for the stale note.',
    });
    const noteB = await apiCreateNote(request, notebook.id, uniqueName('Race Note Bravo'), {
      contentText: 'BRAVO-CONTENT unique marker for the fresh note.',
    });

    // Delay only note A's GET so its response resolves AFTER note B's.
    await page.route(`**/api/notes/${noteA.id}`, async (route) => {
      if (route.request().method() === 'GET') {
        await new Promise((r) => setTimeout(r, 2_500));
      }
      await route.fallback();
    });

    await page.goto(`/notebook/${notebook.id}`);
    // Start loading slow note A (SPA navigation)...
    await page.getByText(exact(noteA.title)).first().click();
    await page.waitForURL(/\/note\//);
    // ...and immediately jump to note B via the quick switcher while A is still in flight.
    await openQuickSwitcher(page);
    await quickSwitcherInput(page).fill(noteB.title);
    const row = page.getByTestId(TESTIDS.quickSwitcherResult).filter({ hasText: exact(noteB.title) }).first();
    await expect(row).toBeVisible({ timeout: 5_000 });
    await row.click();
    await page.waitForURL(new RegExp(`/note/${noteB.id}`));

    await expect(editorBody(page)).toContainText('BRAVO-CONTENT', { timeout: 10_000 });
    // Wait past the delayed stale response, then confirm it did NOT hijack the editor.
    await page.waitForTimeout(3_000);
    await expect(editorBody(page)).toContainText('BRAVO-CONTENT');
    await expect(editorBody(page)).not.toContainText('ALPHA-CONTENT');
    await expect(page.getByPlaceholder('Untitled')).toHaveValue(noteB.title);
  });

  test('a failed autosave keeps the note dirty, surfaces an error chip, and auto-retries to success', async ({ page }) => {
    const notebookName = uniqueName('E2E Retry Notebook');
    await page.goto('/');
    await createNotebookViaSidebar(page, notebookName);
    await openNotebook(page, notebookName);
    await createNoteViaButton(page);
    await setNoteTitle(page, uniqueName('Retry Note'));
    await typeInEditor(page, 'First line saved normally.');
    await waitForSaved(page);
    const noteId = noteIdFromUrl(page);

    // Fail the next PATCHes, then let them through again.
    let failing = true;
    await page.route(`**/api/notes/${noteId}`, async (route) => {
      if (failing && route.request().method() === 'PATCH') {
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'injected failure' }) });
        return;
      }
      await route.fallback();
    });

    await typeInEditor(page, ' CRITICAL-EDIT that must not be lost.');
    const chip = page.getByTestId(TESTIDS.autosaveStatus);
    await expect(chip).toContainText(/save failed/i, { timeout: 15_000 });

    // Server "recovers" - the automatic backoff retry must persist the edit with no
    // further user input.
    failing = false;
    await expect(chip).toContainText(/saved/i, { timeout: 20_000 });

    await page.reload();
    await expect(editorBody(page)).toContainText('CRITICAL-EDIT', { timeout: 10_000 });
  });

  test('restoring a version refreshes the live editor - the next autosave does not revert it', async ({ page }) => {
    const notebookName = uniqueName('E2E Resync Notebook');
    const original = 'ORIGINAL-RESYNC-CONTENT before the snapshot.';
    const later = 'LATER-CONTENT that the restore must wipe.';

    await page.goto('/');
    await createNotebookViaSidebar(page, notebookName);
    await openNotebook(page, notebookName);
    await createNoteViaButton(page);
    await setNoteTitle(page, uniqueName('Resync Note'));
    await typeInEditor(page, original);
    await waitForSaved(page);

    // Snapshot, then change the content.
    await clickNoteMoreItem(page, /^history$/i);
    const drawer = page.getByTestId(TESTIDS.historyDrawer);
    await expect(drawer).toBeVisible({ timeout: 10_000 });
    await drawer.getByRole('button', { name: /snapshot now/i }).click();
    await expect(drawer.getByTestId(TESTIDS.historyVersionItem).first()).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Close history' }).click();
    await expect(drawer).toBeHidden({ timeout: 5_000 });

    const body = editorBody(page);
    await body.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.type(later, { delay: 10 });
    await waitForSaved(page);

    // Restore the snapshot.
    await clickNoteMoreItem(page, /^history$/i);
    await expect(drawer).toBeVisible({ timeout: 10_000 });
    page.once('dialog', (d) => void d.accept());
    await drawer.getByTestId(TESTIDS.historyVersionItem).first().click();
    await drawer.getByRole('button', { name: /restore this version/i }).click();

    // The LIVE editor must now show the restored content without a manual reload...
    await expect(body).toContainText('ORIGINAL-RESYNC-CONTENT', { timeout: 10_000 });
    await expect(body).not.toContainText('LATER-CONTENT');

    // ...and the killer regression: typing AFTER the restore autosaves the restored doc,
    // not the stale pre-restore one. Reload to see what the server really has.
    await body.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' plus-post-restore-edit', { delay: 10 });
    await waitForSaved(page);
    await page.reload();
    await expect(editorBody(page)).toContainText('ORIGINAL-RESYNC-CONTENT', { timeout: 10_000 });
    await expect(editorBody(page)).toContainText('plus-post-restore-edit');
    await expect(editorBody(page)).not.toContainText('LATER-CONTENT');
  });
});

test.describe('Soft delete + undo', () => {
  test('deleting a note shows an Undo toast that restores it', async ({ page, request }) => {
    const notebook = await apiCreateNotebook(request, uniqueName('E2E Undo Notebook'));
    const note = await apiCreateNote(request, notebook.id, uniqueName('Undoable Note'));

    await page.goto(`/notebook/${notebook.id}`);
    const card = page.getByText(exact(note.title)).first();
    await expect(card).toBeVisible({ timeout: 10_000 });

    // Open the note row's "..." menu → Delete… → confirm.
    await page.locator(`button[aria-label="${note.title} options"]`).click();
    await page.getByRole('menuitem', { name: /delete/i }).click();
    await page.getByRole('button', { name: /delete note/i }).click();

    // Note is gone from the LIST (scope to main - the Undo toast itself quotes the title),
    // and the toast offers Undo.
    const main = page.getByRole('main');
    await expect(main.getByText(exact(note.title))).toHaveCount(0, { timeout: 10_000 });
    const undo = page.getByRole('button', { name: /^undo$/i });
    await expect(undo).toBeVisible({ timeout: 5_000 });
    await undo.click();

    await expect(main.getByText(exact(note.title)).first()).toBeVisible({ timeout: 10_000 });
    // And the server agrees it's live again.
    const res = await request.get(`/api/notes/${note.id}`);
    expect(res.ok()).toBeTruthy();
  });

  test('deleting a notebook requires typing its name to confirm', async ({ page, request }) => {
    const notebook = await apiCreateNotebook(request, uniqueName('E2E TypeDel Notebook'));
    await page.goto('/');

    const nav = sidebarNav(page);
    await expect(nav.getByRole('link', { name: exact(notebook.name) })).toBeVisible({ timeout: 10_000 });
    await nav.getByRole('button', { name: `${notebook.name} options` }).click();
    await page.getByRole('menuitem', { name: /delete/i }).click();

    const dialog = page.getByRole('dialog', { name: new RegExp(`Delete "${notebook.name}"`) });
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    const confirm = dialog.getByRole('button', { name: /delete notebook/i });

    // Blocked until the exact name is typed.
    await expect(confirm).toBeDisabled();
    await dialog.getByPlaceholder(notebook.name).fill('wrong name');
    await expect(confirm).toBeDisabled();
    await dialog.getByPlaceholder(notebook.name).fill(notebook.name);
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect(nav.getByRole('link', { name: exact(notebook.name) })).toHaveCount(0, { timeout: 10_000 });
    const res = await request.get(`/api/notebooks`);
    const { notebooks } = await res.json();
    expect(notebooks.some((n: { id: string }) => n.id === notebook.id)).toBe(false);
  });
});

test.describe('Context filing (Ctrl+N)', () => {
  test('Ctrl+N while reading a note files the new note into that note’s notebook', async ({ page, request }) => {
    // Two notebooks; the note lives in the SECOND one, so the old notebooks[0] fallback
    // would file the new note into the wrong place.
    await apiCreateNotebook(request, uniqueName('E2E Filing Decoy'));
    const target = await apiCreateNotebook(request, uniqueName('E2E Filing Target'));
    const note = await apiCreateNote(request, target.id, uniqueName('Filing Context Note'));

    await page.goto(`/note/${note.id}`);
    await expect(page.getByPlaceholder('Untitled')).toHaveValue(note.title, { timeout: 10_000 });

    await page.keyboard.press('Control+n');
    await page.waitForURL((url) => /\/note\//.test(url.pathname) && !url.pathname.includes(note.id), { timeout: 10_000 });

    // The breadcrumb names the notebook the new note landed in.
    await expect(page.locator('.folio-breadcrumb-notebook')).toContainText(target.name, { timeout: 10_000 });
  });
});

test.describe('AI kill-switch', () => {
  test('the sidebar toggle removes every AI affordance and restores them', async ({ page, request }) => {
    const notebook = await apiCreateNotebook(request, uniqueName('E2E AI Toggle Notebook'));
    const note = await apiCreateNote(request, notebook.id, uniqueName('AI Toggle Note'));

    // AI affordances are now gated on BOTH the user's preference and live gateway
    // health (web/src/lib/aiStatus.ts - useAiAvailable). GET /api/meta/ai-health
    // performs a real completion against the free gateway, so under load it can
    // answer 'bad' and hide every AI control before this spec has touched anything.
    //
    // The subject here is the PREFERENCE switch, not gateway reachability, so health
    // is pinned to healthy. That keeps the test deterministic without weakening it -
    // the assertions about what the toggle does are unchanged, and the real gateway
    // is still exercised for real in ai.spec.ts.
    await page.route('**/api/meta/ai-health', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, model: 'e2e-stub' }),
      }),
    );

    await page.goto(`/note/${note.id}`);
    await expect(page.getByPlaceholder('Untitled')).toHaveValue(note.title, { timeout: 10_000 });

    // AI surfaces present while enabled.
    //
    // The old first assertion here looked for `button[name="AI"]`, which stopped existing
    // when the AI dropdown became the "Assistant" panel - ai.spec.ts has a comment about
    // exactly that selector rotting, and this copy of it was missed. It failed the "on"
    // branch outright, and made the "off" branch vacuous (toHaveCount(0) trivially passes
    // for an element that never existed).
    //
    // Replaced with the More menu's AI group, which is a real AI affordance inside the
    // note that nothing else in this test covers - the assistant toggle on the next line
    // already covers the toolbar.
    const moreButton = page.getByRole('main').getByRole('button', { name: /^more$/i });
    await moreButton.click();
    await expect(page.getByRole('button', { name: /^summarise$/i })).toBeVisible();
    await page.keyboard.press('Escape');

    await expect(page.getByTestId('assistant-open')).toBeVisible();
    await expect(sidebarNav(page).getByRole('link', { name: 'Ask AI' })).toBeVisible();

    // Flip the switch off.
    await page.getByTestId('ai-toggle').click();
    await moreButton.click();
    await expect(page.getByRole('button', { name: /^summarise$/i })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('assistant-open')).toHaveCount(0);
    await expect(sidebarNav(page).getByRole('link', { name: 'Ask AI' })).toHaveCount(0);

    // The Ask page (direct URL) explains the state instead of rendering the AI chat.
    await page.goto('/ask');
    await expect(page.getByTestId('ask-disabled')).toBeVisible({ timeout: 10_000 });

    // The preference survives a reload.
    await page.goto(`/note/${note.id}`);
    await expect(page.getByPlaceholder('Untitled')).toHaveValue(note.title, { timeout: 10_000 });
    await expect(page.getByTestId('assistant-open')).toHaveCount(0);

    // And "Turn AI back on" from the Ask page restores everything.
    await page.goto('/ask');
    await page.getByRole('button', { name: /turn ai back on/i }).click();
    await expect(sidebarNav(page).getByRole('link', { name: 'Ask AI' })).toBeVisible({ timeout: 5_000 });
    await page.goto(`/note/${note.id}`);
    await expect(page.getByTestId('assistant-open')).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('Study notebook filter', () => {
  test('the Review tab can be scoped to one notebook via chips', async ({ page, request }) => {
    // This used to assert against the CLI demo vault ("Databases has exactly one due
    // card"). That vault belonged to a single global user and no longer exists for a
    // per-worker account, so the spec now plants its own two-notebook deck. Seeding two
    // DIFFERENT card counts is the point: a filter that silently did nothing would still
    // satisfy a one-notebook fixture.
    const solo = await apiCreateNotebook(request, uniqueName('E2E Study Solo'));
    const pair = await apiCreateNotebook(request, uniqueName('E2E Study Pair'));
    const soloNote = await apiCreateNote(request, solo.id, uniqueName('Study Solo Note'));
    const pairNote = await apiCreateNote(request, pair.id, uniqueName('Study Pair Note'));

    const soloQuestion = uniqueName('Solo question');
    await apiCreateFlashcard(request, soloNote.id, soloQuestion, 'The one and only answer.');
    await apiCreateFlashcard(request, pairNote.id, uniqueName('Pair question A'), 'Answer A.');
    await apiCreateFlashcard(request, pairNote.id, uniqueName('Pair question B'), 'Answer B.');

    await page.goto('/study');

    const filter = page.getByTestId('study-notebook-filter');
    await expect(filter).toBeVisible({ timeout: 10_000 });
    const counter = page.locator('.sy-review__counter');

    // Scoped to the one-card notebook: an exact count, and it must be OUR card.
    await filter.getByRole('button', { name: exact(solo.name) }).click();
    await expect(page.getByText(`Reviewing ${solo.name} only`)).toBeVisible({ timeout: 5_000 });
    await expect(counter).toHaveText('1 due', { timeout: 10_000 });
    await expect(page.locator('.sy-review-card__question').first()).toHaveText(soloQuestion);

    // Scoped to the two-card notebook: the count tracks the filter rather than being
    // whatever the queue happened to hold.
    await filter.getByRole('button', { name: exact(pair.name) }).click();
    await expect(page.getByText(`Reviewing ${pair.name} only`)).toBeVisible({ timeout: 5_000 });
    await expect(counter).toHaveText('2 due', { timeout: 10_000 });

    // Back to all notebooks: at least the three we planted. Not an equality check -
    // other specs sharing this worker's account may have left cards of their own.
    await filter.getByRole('button', { name: /All notebooks/ }).click();
    await expect(page.getByText(/across every notebook/i)).toBeVisible({ timeout: 5_000 });
    await expect
      .poll(async () => Number((((await counter.textContent()) ?? '').match(/(\d+)\s*due/) ?? [])[1] ?? 0), {
        timeout: 10_000,
      })
      .toBeGreaterThanOrEqual(3);
  });
});

test.describe('Move to notebook submenu', () => {
  // The note row's "..." sits at the right edge, so the submenu flips to the LEFT of the
  // menu. It used to shut the moment the pointer reached it (a submenu row shared the
  // root's "hovered a plain item, close the submenu" branch), so no notebook could ever
  // be picked with a mouse. Real pointer moves with steps, not locator.hover(), because
  // the bug lived in the enter events fired along the way.
  test('the submenu survives the pointer travelling into it, and the pick moves the note', async ({ page, request }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const source = await apiCreateNotebook(request, uniqueName('E2E Move Source'));
    const target = await apiCreateNotebook(request, uniqueName('E2E Move Target'));
    const note = await apiCreateNote(request, source.id, uniqueName('Movable Note'));

    await page.goto(`/notebook/${source.id}`);
    await expect(page.getByText(exact(note.title)).first()).toBeVisible({ timeout: 10_000 });
    await page.locator(`button[aria-label="${note.title} options"]`).click();

    const trigger = page.getByRole('menuitem', { name: 'Move to notebook' });
    const tb = await trigger.boundingBox();
    if (!tb) throw new Error('no Move to notebook item');
    await page.mouse.move(tb.x + tb.width - 20, tb.y + tb.height / 2, { steps: 5 });

    const pick = page.getByRole('menuitem', { name: exact(target.name) });
    await expect(pick).toBeVisible();
    const menuBox = await page.locator('.folio-menu').first().boundingBox();
    const subBox = await page.locator('.folio-menu').nth(1).boundingBox();
    if (!menuBox || !subBox) throw new Error('menu or submenu has no box');
    expect(subBox.x, 'submenu should open to the left of the menu here').toBeLessThan(menuBox.x);

    // Cut the corner across the row below on the way, as a hand does.
    const archive = await page.getByRole('menuitem', { name: 'Archive' }).boundingBox();
    if (!archive) throw new Error('no Archive item');
    await page.mouse.move(archive.x + archive.width - 40, archive.y + archive.height / 2, { steps: 6 });
    // Other specs' notebooks share this list, so the pick may sit below the fold of a
    // scrolling submenu. Scrolling it does not move the pointer.
    await pick.scrollIntoViewIfNeeded();
    const pb = await pick.boundingBox();
    if (!pb) throw new Error('submenu item has no box');
    await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2, { steps: 12 });
    // Longer than the close delay: the submenu must still be there, not just slow to go.
    await page.waitForTimeout(500);
    await expect(pick).toBeVisible();

    await page.mouse.down();
    await page.mouse.up();
    await expect(page.getByText('Note moved')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole('main').getByText(exact(note.title))).toHaveCount(0);
    const res = await request.get(`/api/notes/${note.id}`);
    expect(res.ok()).toBeTruthy();
    expect((await res.json()).note.notebookId).toBe(target.id);
  });
});
