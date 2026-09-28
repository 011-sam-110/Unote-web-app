import { expect, test } from './auth.fixture';
import {
  TESTIDS,
  clickNoteMoreItem,
  createNoteViaButton,
  createNotebookViaSidebar,
  editorBody,
  exact,
  openNotebook,
  setNoteTitle,
  typeInEditor,
  uniqueName,
  waitForSaved,
} from './utils';

test.describe('Core notes flow', () => {
  test('create a notebook and a note, edit it, and see it persist after reload', async ({ page }) => {
    const notebookName = uniqueName('E2E Notebook');
    const noteTitle = uniqueName('My first note');
    const bodyText = 'This paragraph should survive a full page reload.';

    await page.goto('/');
    await createNotebookViaSidebar(page, notebookName);
    await openNotebook(page, notebookName);

    await createNoteViaButton(page);
    await setNoteTitle(page, noteTitle);
    await typeInEditor(page, bodyText);

    await waitForSaved(page);
    const noteUrl = page.url();

    await page.reload();
    await expect(page.getByPlaceholder('Untitled')).toHaveValue(noteTitle, { timeout: 10_000 });
    await expect(editorBody(page)).toContainText(bodyText);
    expect(page.url()).toBe(noteUrl);
  });

  test('Ctrl+N creates a new note', async ({ page }) => {
    const notebookName = uniqueName('E2E Ctrl-N Notebook');
    await page.goto('/');
    await createNotebookViaSidebar(page, notebookName);
    await openNotebook(page, notebookName);

    await page.keyboard.press('Control+n');
    await page.waitForURL(/\/note\//, { timeout: 10_000 });
    await expect(page.getByTestId(TESTIDS.noteEditor)).toBeVisible();
  });

  test('wikilink autocomplete links a note and the target shows a backlink', async ({ page }) => {
    const notebookName = uniqueName('E2E Wikilink Notebook');
    const targetTitle = uniqueName('Linkable Target Note');
    const sourceTitle = uniqueName('Source Note');

    await page.goto('/');
    await createNotebookViaSidebar(page, notebookName);
    await openNotebook(page, notebookName);

    // Create the target note first so it exists for the wikilink autocomplete to find.
    await createNoteViaButton(page);
    await setNoteTitle(page, targetTitle);
    await typeInEditor(page, 'This is the note other notes will link to.');
    await waitForSaved(page);

    // Now create the source note and link to the target via [[.
    await openNotebook(page, notebookName);
    await createNoteViaButton(page);
    await setNoteTitle(page, sourceTitle);

    const body = editorBody(page);
    await body.click();
    await page.keyboard.type('See also ', { delay: 10 });
    await page.keyboard.type('[[', { delay: 10 });
    await page.keyboard.type(targetTitle.slice(0, 12), { delay: 15 });

    const menu = page.getByTestId(TESTIDS.wikilinkMenu);
    await expect(menu).toBeVisible({ timeout: 5_000 });
    await menu.getByTestId(TESTIDS.wikilinkMenuItem).filter({ hasText: exact(targetTitle) }).first().click();

    await waitForSaved(page);
    await expect(body).toContainText(targetTitle);

    // Open the linked note directly and confirm the backlinks section names the source.
    // Prefer a real link element if the wikilink renders as one; fall back to clicking
    // the inline text if it's a custom node instead.
    const link = body.getByRole('link', { name: exact(targetTitle) }).or(body.getByText(targetTitle, { exact: false }));
    await link.first().click();
    await page.waitForURL(/\/note\//, { timeout: 10_000 });
    await expect(page.getByPlaceholder('Untitled')).toHaveValue(targetTitle, { timeout: 10_000 });

    const backlinks = page.getByTestId(TESTIDS.backlinksSection);
    await expect(backlinks).toBeVisible();
    await expect(backlinks).toContainText(sourceTitle);
  });

  test('pinning a note surfaces it on the dashboard pinned strip', async ({ page }) => {
    const notebookName = uniqueName('E2E Pin Notebook');
    const noteTitle = uniqueName('Pin Me Note');

    await page.goto('/');
    await createNotebookViaSidebar(page, notebookName);
    await openNotebook(page, notebookName);
    await createNoteViaButton(page);
    await setNoteTitle(page, noteTitle);
    await typeInEditor(page, 'Content for the note that gets pinned.');
    await waitForSaved(page);

    // Pin lives in the action bar's "More" menu now, not as a top-level icon button.
    await clickNoteMoreItem(page, /^pin$/i);

    await page.goto('/');
    const pinnedStrip = page.getByTestId(TESTIDS.pinnedStrip);
    await expect(pinnedStrip).toBeVisible({ timeout: 10_000 });
    await expect(pinnedStrip).toContainText(noteTitle);
  });

  test('slash menu inserts a heading and a to-do item; the checkbox toggles', async ({ page }) => {
    const notebookName = uniqueName('E2E Slash Notebook');
    const noteTitle = uniqueName('Slash Menu Note');

    await page.goto('/');
    await createNotebookViaSidebar(page, notebookName);
    await openNotebook(page, notebookName);
    await createNoteViaButton(page);
    await setNoteTitle(page, noteTitle);

    const body = editorBody(page);
    await body.click();

    // Insert a Heading 1 block.
    await page.keyboard.type('/', { delay: 10 });
    const slashMenu = page.getByTestId(TESTIDS.slashMenu);
    await expect(slashMenu).toBeVisible({ timeout: 5_000 });
    await slashMenu.getByTestId(TESTIDS.slashMenuItem).filter({ hasText: /heading 1|h1/i }).first().click();
    await page.keyboard.type('A Big Heading', { delay: 10 });
    await expect(body.locator('h1')).toContainText('A Big Heading');

    // New line, insert a To-do item.
    await page.keyboard.press('Enter');
    await page.keyboard.type('/', { delay: 10 });
    await expect(slashMenu).toBeVisible({ timeout: 5_000 });
    await slashMenu.getByTestId(TESTIDS.slashMenuItem).filter({ hasText: /to-?do/i }).first().click();
    await page.keyboard.type('Finish the reading', { delay: 10 });

    const checkbox = body.locator('li input[type="checkbox"]').last();
    await expect(checkbox).toBeVisible();
    await expect(checkbox).not.toBeChecked();
    await checkbox.click();
    await expect(checkbox).toBeChecked();

    await waitForSaved(page);
    await page.reload();
    await expect(editorBody(page).locator('li input[type="checkbox"]').last()).toBeChecked();
  });

  test('slash menu scrolls under the mouse wheel and a row below the fold can be clicked', async ({ page }) => {
    // The popup once painted UNDER the paged editor's text layer: still visible through it,
    // but the wheel scrolled the note and clicks landed in the text. Enter still worked.
    const notebookName = uniqueName('E2E Slash Scroll Notebook');
    await page.goto('/');
    await createNotebookViaSidebar(page, notebookName);
    await openNotebook(page, notebookName);
    await createNoteViaButton(page);
    await setNoteTitle(page, uniqueName('Slash Scroll Note'));

    const body = editorBody(page);
    await body.click();
    await page.keyboard.type('/', { delay: 10 });
    const slashMenu = page.getByTestId(TESTIDS.slashMenu);
    await expect(slashMenu).toBeVisible({ timeout: 5_000 });

    const box = (await slashMenu.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 300);
    await expect.poll(() => slashMenu.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

    // Numbered list sits below the fold until the list scrolls. click() refuses when another
    // element would receive the pointer, which is exactly the bug.
    await slashMenu.getByTestId(TESTIDS.slashMenuItem).filter({ hasText: /numbered list/i }).first().click();
    await expect(slashMenu).toBeHidden();
    await page.keyboard.type('First point', { delay: 10 });
    await expect(body.locator('ol li')).toContainText('First point');
  });
});
