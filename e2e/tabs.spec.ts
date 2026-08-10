/**
 * Tabs: several notes open at once.
 *
 * The feature's whole claim is that a tab you switch away from stays ALIVE - so the
 * assertions that matter here are not "the strip has two chips in it" but "the editor I
 * typed into is still the same editor when I come back". A strip that looked perfect
 * while quietly remounting each page on every click would satisfy any test written
 * against the strip alone, and would be worth nothing: it would be the back button with
 * extra steps.
 *
 * So the load-bearing spec stamps the live editor's DOM node, switches away, switches
 * back, and checks the stamp is still there. That is exactly how a real remount bug was
 * caught during the build - panes were being reordered in the DOM to match a
 * recently-used ranking, React moved the nodes to match, and the TipTap instance inside
 * died with the move while everything else still looked right.
 */
import { expect, test } from './auth.fixture';
import {
  apiCreateNote,
  apiCreateNotebook,
  editorBody,
  exact,
  openNotebook,
  sidebarNav,
  uniqueName,
} from './utils';

const strip = (page: import('@playwright/test').Page) => page.getByRole('tablist', { name: /open tabs/i });

/**
 * A sidebar destination, matched by href rather than by name.
 *
 * The names carry a badge: once any spec in this worker's account has flashcards due, the
 * Study link is accessibly named "Study 4", and an anchored /^study$/i stops matching. That
 * made this file pass alone and go flaky in the full suite, which is the worst way for a
 * test to be wrong - it fails for whatever ran before it rather than for what it tests.
 */
const sidebarLink = (page: import('@playwright/test').Page, href: string) =>
  sidebarNav(page).locator(`a[href="${href}"]`);
const tab = (page: import('@playwright/test').Page, name: string | RegExp) =>
  strip(page).getByRole('tab', { name: typeof name === 'string' ? exact(name) : name });

test.describe('tabs', () => {
  test('an ordinary click loads in the tab you are on; Ctrl+click opens another', async ({ page, request }) => {
    const nb = await apiCreateNotebook(request, uniqueName('Tabs'));
    const first = await apiCreateNote(request, nb.id, uniqueName('Alpha'));
    const second = await apiCreateNote(request, nb.id, uniqueName('Beta'));

    await page.goto('/');
    await openNotebook(page, nb.name);
    await expect(strip(page).getByRole('tab')).toHaveCount(1);

    // Plain click: the tab moves, it does not multiply. This is what keeps browsing a
    // notebook from filling the strip.
    await page.getByRole('link', { name: exact(first.title) }).first().click();
    await page.waitForURL(/\/note\//);
    await expect(strip(page).getByRole('tab')).toHaveCount(1);
    await expect(tab(page, first.title)).toBeVisible();

    await page.goBack();
    await page.waitForURL(/\/notebook\//);
    await page.getByRole('link', { name: exact(second.title) }).first().click({ modifiers: ['ControlOrMeta'] });

    await expect(strip(page).getByRole('tab')).toHaveCount(2);
    await expect(tab(page, second.title)).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(new RegExp(`/note/${second.id}`));
  });

  test('switching away and back keeps the same live editor, not a reloaded copy', async ({ page, request }) => {
    const nb = await apiCreateNotebook(request, uniqueName('Keepalive'));
    const note = await apiCreateNote(request, nb.id, uniqueName('Live'), { contentText: 'original text' });

    await page.goto(`/note/${note.id}`);
    await expect(editorBody(page)).toBeVisible({ timeout: 15_000 });

    await editorBody(page).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' CANARY', { delay: 10 });
    await expect(editorBody(page)).toContainText('CANARY');

    // Stamp the live instance. If the pane is torn down and rebuilt, the attribute goes
    // with it - which no assertion about visible text could tell us on its own, because
    // a reloaded note would show the saved text too.
    await editorBody(page).evaluate((el) => el.setAttribute('data-keepalive-probe', 'same-instance'));

    await sidebarLink(page, '/study').click({ modifiers: ['ControlOrMeta'] });
    await expect(tab(page, /study/i)).toHaveAttribute('aria-selected', 'true');

    await tab(page, note.title).click();
    await expect(page).toHaveURL(new RegExp(`/note/${note.id}`));

    await expect(editorBody(page)).toHaveAttribute('data-keepalive-probe', 'same-instance');
    await expect(editorBody(page)).toContainText('CANARY');

    // The undo stack is the strictest evidence of all: it lives in ProseMirror's plugin
    // state, so it cannot survive anything short of the same editor still running.
    await editorBody(page).click();
    await page.keyboard.press('Control+z');
    await expect(editorBody(page)).not.toContainText('CANARY');
  });

  test('a background tab keeps its own note rather than adopting the visible one', async ({ page, request }) => {
    const nb = await apiCreateNotebook(request, uniqueName('Two'));
    const a = await apiCreateNote(request, nb.id, uniqueName('First'), { contentText: 'content of A' });
    const b = await apiCreateNote(request, nb.id, uniqueName('Second'), { contentText: 'content of B' });

    await page.goto(`/note/${a.id}`);
    await expect(editorBody(page)).toBeVisible({ timeout: 15_000 });

    // Ctrl+click, not a plain one: a plain click MOVES the tab you are on, so opening the
    // notebook normally would take note A's tab with it and there would be nothing left to
    // switch back to.
    await sidebarNav(page)
      .getByRole('link', { name: exact(nb.name) })
      .click({ modifiers: ['ControlOrMeta'] });
    await page.waitForURL(/\/notebook\//);
    await page.getByRole('link', { name: exact(b.title) }).first().click({ modifiers: ['ControlOrMeta'] });
    await expect(page).toHaveURL(new RegExp(`/note/${b.id}`));

    // Both panes are mounted. The hidden one must still be showing ITS note: the router
    // answers for the URL, so a pane reading its id from useParams would have silently
    // refetched itself into a second copy of whatever is on screen.
    await tab(page, a.title).click();
    await expect(editorBody(page)).toContainText('content of A');
    await tab(page, b.title).click();
    await expect(editorBody(page)).toContainText('content of B');
  });

  test('closing a tab hands over to its neighbour, and the strip is never empty', async ({ page, request }) => {
    const nb = await apiCreateNotebook(request, uniqueName('Closing'));
    const note = await apiCreateNote(request, nb.id, uniqueName('Kept'));

    await page.goto(`/note/${note.id}`);
    await sidebarLink(page, '/study').click({ modifiers: ['ControlOrMeta'] });
    await expect(strip(page).getByRole('tab')).toHaveCount(2);

    await tab(page, /study/i).getByRole('button', { name: /^close/i }).click();
    await expect(strip(page).getByRole('tab')).toHaveCount(1);
    await expect(tab(page, note.title)).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(new RegExp(`/note/${note.id}`));

    // Closing the last one opens Home rather than leaving nothing selected.
    await tab(page, note.title).getByRole('button', { name: /^close/i }).click();
    await expect(strip(page).getByRole('tab')).toHaveCount(1);
    await expect(page).toHaveURL(/\/$/);
  });

  test('the strip comes back after a reload', async ({ page, request }) => {
    const nb = await apiCreateNotebook(request, uniqueName('Restore'));
    const note = await apiCreateNote(request, nb.id, uniqueName('Persisted'));

    await page.goto(`/note/${note.id}`);
    await sidebarLink(page, '/tags').click({ modifiers: ['ControlOrMeta'] });
    await expect(strip(page).getByRole('tab')).toHaveCount(2);

    await page.reload();

    await expect(strip(page).getByRole('tab')).toHaveCount(2);
    await expect(tab(page, note.title)).toBeVisible();
    await expect(tab(page, /tags/i)).toHaveAttribute('aria-selected', 'true');
  });
});
