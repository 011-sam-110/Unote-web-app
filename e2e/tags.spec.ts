/**
 * Tag authoring through the real UI.
 *
 * Tags used to be a write-only feature: the server stored note_tags, PATCH accepted
 * them and search could filter on them, but nothing in the app could put one on a
 * note - so the old suite seeded tags straight through the API and left a comment
 * admitting "how tags get attached" was ambiguous. There are now two real authoring
 * routes, and this file drives both:
 *
 *   • the chip editor (web/src/features/editor/TagEditor.tsx) - explicit, removable
 *   • inline #hashtags in the note body - parsed out and shown as read-only chips
 *
 * The distinction between the two is behaviour worth protecting, not an
 * implementation detail: a body hashtag deliberately has NO remove button, because
 * the body is its source of truth and an "×" the next keystroke undid would be a lie.
 */
import { expect, test } from './auth.fixture';
import {
  activePane,
  createNoteViaButton,
  createNotebookViaSidebar,
  exact,
  openNotebook,
  setNoteTitle,
  typeInEditor,
  uniqueName,
  waitForSaved,
} from './utils';

/** The tag chip row in the note header. */
function tagEditor(page: import('@playwright/test').Page) {
  return page.getByTestId('tag-editor');
}

function tagInput(page: import('@playwright/test').Page) {
  return tagEditor(page).getByRole('textbox', { name: 'Add a tag' });
}

/** A tag unique to this run, so suggestion/filter assertions can't collide. */
function uniqueTag(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`.toLowerCase();
}

test.describe('Tag editor', () => {
  test('adds a chip, persists it through autosave, and survives a reload', async ({ page }) => {
    const notebookName = uniqueName('E2E Tag Notebook');
    const tag = uniqueTag('revision');

    await page.goto('/');
    await createNotebookViaSidebar(page, notebookName);
    await openNotebook(page, notebookName);
    await createNoteViaButton(page);
    await setNoteTitle(page, uniqueName('Tagged By Hand'));
    await typeInEditor(page, 'A note whose tag is added through the chip editor.');
    await waitForSaved(page);

    // Enter commits the draft as a chip.
    await tagInput(page).fill(tag);
    await tagInput(page).press('Enter');
    await expect(tagEditor(page).getByRole('button', { name: `#${tag}` })).toBeVisible();

    // A tag edit goes through the SAME debounced autosave a keystroke does, so the
    // saved chip is the real signal that it reached the server - no sleeping.
    await waitForSaved(page);
    await page.reload();
    await expect(tagEditor(page).getByRole('button', { name: `#${tag}` })).toBeVisible({ timeout: 10_000 });
  });

  test('normalises what the user actually types', async ({ page }) => {
    const notebookName = uniqueName('E2E Tag Normalise Notebook');
    const stamp = Date.now().toString(36);

    await page.goto('/');
    await createNotebookViaSidebar(page, notebookName);
    await openNotebook(page, notebookName);
    await createNoteViaButton(page);
    await setNoteTitle(page, uniqueName('Normalising Note'));
    await waitForSaved(page);

    // A leading '#', capitals and an interior space are all things people type. Each
    // folds to one canonical spelling rather than becoming a second, near-duplicate tag.
    await tagInput(page).fill(`#Week ${stamp}`);
    await tagInput(page).press('Enter');

    const expected = `week-${stamp}`.toLowerCase();
    await expect(tagEditor(page).getByRole('button', { name: `#${expected}` })).toBeVisible();

    // Re-entering the same tag in a different spelling is a no-op, not a duplicate.
    await tagInput(page).fill(expected.toUpperCase());
    await tagInput(page).press('Enter');
    await expect(tagEditor(page).getByRole('button', { name: `#${expected}` })).toHaveCount(1);

    await waitForSaved(page);
  });

  test('removes a chip via its × and the removal persists', async ({ page }) => {
    const notebookName = uniqueName('E2E Tag Remove Notebook');
    const keep = uniqueTag('keep');
    const drop = uniqueTag('drop');

    await page.goto('/');
    await createNotebookViaSidebar(page, notebookName);
    await openNotebook(page, notebookName);
    await createNoteViaButton(page);
    await setNoteTitle(page, uniqueName('Removable Tags Note'));
    await waitForSaved(page);

    for (const t of [keep, drop]) {
      await tagInput(page).fill(t);
      await tagInput(page).press('Enter');
    }
    await expect(tagEditor(page).getByRole('button', { name: `#${keep}` })).toBeVisible();
    await expect(tagEditor(page).getByRole('button', { name: `#${drop}` })).toBeVisible();
    await waitForSaved(page);

    await tagEditor(page).getByRole('button', { name: `Remove tag ${drop}` }).click();
    await expect(tagEditor(page).getByRole('button', { name: `#${drop}` })).toHaveCount(0);
    await waitForSaved(page);

    await page.reload();
    await expect(tagEditor(page).getByRole('button', { name: `#${keep}` })).toBeVisible({ timeout: 10_000 });
    await expect(tagEditor(page).getByRole('button', { name: `#${drop}` })).toHaveCount(0);
  });

  test('a #hashtag in the body becomes a read-only chip with no remove button', async ({ page }) => {
    const notebookName = uniqueName('E2E Hashtag Notebook');
    const bodyTag = uniqueTag('inline');
    const explicitTag = uniqueTag('explicit');

    await page.goto('/');
    await createNotebookViaSidebar(page, notebookName);
    await openNotebook(page, notebookName);
    await createNoteViaButton(page);
    await setNoteTitle(page, uniqueName('Hashtag Note'));
    await typeInEditor(page, `Deadlock prevention notes for #${bodyTag} revision.`);
    await waitForSaved(page);

    const autoChip = tagEditor(page).locator('.folio-tag-chip--auto').filter({ hasText: `#${bodyTag}` });
    await expect(autoChip).toBeVisible({ timeout: 10_000 });

    // The whole point of the auto/explicit split: a body tag offers no "×", because
    // removing it here would be undone by the body it was parsed from.
    await expect(autoChip.getByRole('button', { name: `Remove tag ${bodyTag}` })).toHaveCount(0);

    // An explicitly added chip alongside it DOES get one.
    await tagInput(page).fill(explicitTag);
    await tagInput(page).press('Enter');
    await waitForSaved(page);
    await expect(tagEditor(page).getByRole('button', { name: `Remove tag ${explicitTag}` })).toBeVisible();

    // Both kinds reach the server as real tags.
    await page.reload();
    await expect(tagEditor(page).getByRole('button', { name: `#${bodyTag}` })).toBeVisible({ timeout: 10_000 });
    await expect(tagEditor(page).getByRole('button', { name: `#${explicitTag}` })).toBeVisible();
  });

  test('suggests tags already in the vault and commits the picked one', async ({ page }) => {
    const notebookName = uniqueName('E2E Tag Suggest Notebook');
    const tag = uniqueTag('lecture');

    await page.goto('/');
    await createNotebookViaSidebar(page, notebookName);
    await openNotebook(page, notebookName);

    // Note 1 establishes the tag in this account's vocabulary.
    await createNoteViaButton(page);
    await setNoteTitle(page, uniqueName('Vocabulary Source'));
    await tagInput(page).fill(tag);
    await tagInput(page).press('Enter');
    await waitForSaved(page);

    // Note 2 should be offered it. A full page load is what refreshes the cached
    // vocabulary (lib/tags.ts caches it for a minute), so navigate rather than SPA-route.
    await openNotebook(page, notebookName);
    await createNoteViaButton(page);
    const secondNoteUrl = page.url();
    await setNoteTitle(page, uniqueName('Vocabulary Consumer'));
    await waitForSaved(page);
    await page.goto(secondNoteUrl);
    await expect(page.getByTestId('tag-editor')).toBeVisible({ timeout: 10_000 });

    await tagInput(page).fill(tag.slice(0, 7));
    const option = page.getByRole('option', { name: new RegExp(`#${tag}\\b`) });
    await expect(option).toBeVisible({ timeout: 10_000 });
    await option.click();

    await expect(tagEditor(page).getByRole('button', { name: `#${tag}` })).toBeVisible();
    await waitForSaved(page);
  });
});

test.describe('Tags are usable once authored', () => {
  test('a chip added in the editor filters the notebook list and opens its tag view', async ({ page }) => {
    // This replaces the old dashboard.spec.ts assertion that seeded `tags` straight
    // through POST /api/notes. Attaching the tag through the chip editor means the
    // filter is verified against a tag the APP wrote, not one the test injected.
    const notebookName = uniqueName('E2E Tag Filter Notebook');
    const tag = uniqueTag('filterme');

    await page.goto('/');
    await createNotebookViaSidebar(page, notebookName);
    await openNotebook(page, notebookName);
    const notebookUrl = page.url();

    // The note that gets the tag.
    await createNoteViaButton(page);
    const taggedTitle = uniqueName('Tagged Note');
    await setNoteTitle(page, taggedTitle);
    await typeInEditor(page, 'This note carries the tag under test.');
    await tagInput(page).fill(tag);
    await tagInput(page).press('Enter');
    await waitForSaved(page);

    // A sibling note with no tags, which the filter must hide.
    await page.goto(notebookUrl);
    await createNoteViaButton(page);
    const untaggedTitle = uniqueName('Untagged Note');
    await setNoteTitle(page, untaggedTitle);
    await typeInEditor(page, 'This note carries no tags at all.');
    await waitForSaved(page);

    await page.goto(notebookUrl);
    // The visible pane, not the whole of <main>. Both notes were opened above, so both
    // still have a TAB in the strip carrying their title - which is correct, and which
    // would let every assertion below pass on the strip rather than on the list it is
    // actually about. The last one would fail outright.
    const main = activePane(page);
    await expect(main.getByText(exact(taggedTitle)).first()).toBeVisible({ timeout: 10_000 });
    await expect(main.getByText(exact(untaggedTitle)).first()).toBeVisible();

    // The tag chip the notebook page derives from its notes' tags.
    await main.getByRole('button', { name: new RegExp(`^#${tag}\\b`) }).click();
    await expect(main.getByText(exact(taggedTitle)).first()).toBeVisible();
    await expect(main.getByText(exact(untaggedTitle))).toHaveCount(0);
  });

  test('clicking a chip in the note header opens that tag on the tags page', async ({ page }) => {
    const notebookName = uniqueName('E2E Tag Nav Notebook');
    const tag = uniqueTag('navigate');
    const noteTitle = uniqueName('Tag Nav Note');

    await page.goto('/');
    await createNotebookViaSidebar(page, notebookName);
    await openNotebook(page, notebookName);
    await createNoteViaButton(page);
    await setNoteTitle(page, noteTitle);
    await tagInput(page).fill(tag);
    await tagInput(page).press('Enter');
    await waitForSaved(page);

    await tagEditor(page).getByRole('button', { name: `#${tag}` }).click();
    await page.waitForURL(new RegExp(`/tags\\?tag=${tag}`), { timeout: 10_000 });
    await expect(page.getByRole('main').getByText(exact(noteTitle)).first()).toBeVisible({ timeout: 10_000 });
  });
});
