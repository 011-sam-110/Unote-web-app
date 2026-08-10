/**
 * Guest mode, end to end.
 *
 * Deliberately does NOT use e2e/auth.fixture.ts: every other spec exists to prove the app
 * works with a session, and this one exists to prove it works without one. `storageState`
 * is cleared so the browser arrives as a real first-time visitor.
 *
 * The load-bearing assertion is the network one. Guest mode's whole promise is that
 * nothing leaves the browser, and the only way to test a promise like that is to watch the
 * wire rather than to trust the code that was supposed to implement it.
 */
import { test, expect, type Page } from '@playwright/test';

test.use({ storageState: { cookies: [], origins: [] } });

const PASSWORD = 'e2e-folio-password';

function uniqueEmail(): string {
  return `guest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

/** Every request the page makes to a note-mutating endpoint. Should stay empty. */
function watchWrites(page: Page): string[] {
  const writes: string[] = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (!url.pathname.startsWith('/api')) return;
    if (req.method() === 'GET') return;
    // Signing up and logging in are the two calls guest mode is allowed to make.
    if (url.pathname.startsWith('/api/auth/')) return;
    writes.push(`${req.method()} ${url.pathname}`);
  });
  return writes;
}

/**
 * The landing page's PRIMARY button opens the editor, not a signup form.
 *
 * This used to be a text link in the small print under the buttons, with "Start writing"
 * going to /signup. Asking for an account before anyone has typed a word is asking them to
 * buy the thing unseen, so the main button is the guest door now and the account is offered
 * once there is something worth keeping. Asserted on the primary button specifically: a
 * regression here would most likely be someone pointing it back at /signup, which a test
 * that accepted any link into guest mode would not notice.
 */
test('the landing page primary button goes straight into the editor', async ({ page }) => {
  await page.goto('/');
  const start = page.getByRole('link', { name: /start writing/i }).first();
  await expect(start).toBeVisible();
  await start.click();
  await expect(page).toHaveURL(/\/note\//);
  await expect(page.getByTestId('guest-banner')).toContainText('Nothing here is saved');
});

test('a guest can write, and the work survives a reload without any server write', async ({ page }) => {
  const writes = watchWrites(page);

  await page.goto('/try');
  await expect(page).toHaveURL(/\/note\//);

  await page.getByLabel('Note title').fill('Lecture 1: sorting');
  await page.getByTestId('note-editor').click();
  await page.keyboard.type('Merge sort is n log n in the worst case.');

  // The autosave debounce is 800ms; give it room to have fired if it were going to.
  await page.waitForTimeout(1500);
  await page.reload();

  await expect(page.getByLabel('Note title')).toHaveValue('Lecture 1: sorting');
  await expect(page.getByTestId('note-editor')).toContainText('Merge sort is n log n');
  // The banner is on the note page too, not just the dashboard - that is the point of it.
  await expect(page.getByTestId('guest-banner')).toBeVisible();

  expect(writes, 'guest mode must not write to the server').toEqual([]);
});

test('the sidebar Export control offers the guest their own notes', async ({ page }) => {
  await page.goto('/try');
  await page.getByLabel('Note title').fill('Exportable');
  await page.waitForTimeout(1200);

  await page.getByTestId('export-button').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('1 note');
  await expect(dialog).toContainText('Download .zip');
});

test('signing up offers to bring the guest notes into the new account', async ({ page }) => {
  await page.goto('/try');
  await expect(page).toHaveURL(/\/note\//);
  await page.getByLabel('Note title').fill('Carried across');
  await page.getByTestId('note-editor').click();
  await page.keyboard.type('This should end up in the account.');
  await page.waitForTimeout(1200);

  await page.goto('/signup');
  await page.getByLabel('Email').fill(uniqueEmail());
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();

  // The recovery key is shown once and gated behind an acknowledgement. The handover
  // prompt must NOT be on screen yet: it would steal focus from the only render of a
  // credential that cannot be reissued.
  await expect(page.getByRole('dialog', { name: /Bring your notes with you/i })).toHaveCount(0);
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: /open unote/i }).click();

  const prompt = page.getByRole('dialog', { name: /Bring your notes with you/i });
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText('None of it has been saved');
  await prompt.getByRole('button', { name: /Copy them into my account/i }).click();
  await expect(prompt).toBeHidden();

  // The note is the account's now: this reads it back through the server's own search,
  // which knows nothing about localStorage.
  const res = await page.request.get('/api/search?q=Carried%20across&limit=10');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { results: Array<{ note: { title: string } }> };
  expect(body.results.map((r) => r.note.title)).toContain('Carried across');

  // And guest mode is over: the unsaved-work banner is gone.
  await expect(page.getByTestId('guest-banner')).toHaveCount(0);
});

/**
 * A guest's first screen is the README, and it must RENDER - not merely exist as JSON.
 *
 * Asserting the doc contains a `chem` node proves nothing about whether a molecule
 * appears. Each assertion below reads something only a working node view produces: the
 * KaTeX span, the smiles-drawer SVG, an opened toggle's own content becoming visible, a
 * callout's tone attribute, a table, a task-list checkbox.
 *
 * `smiles-drawer` draws into an <svg> here (smilesRenderer.ts uses its `SvgDrawer`, not a
 * canvas backend) - there is no <canvas> anywhere in this document, so the structure is
 * read from `.folio-chem-svg` gaining drawn children, not from a canvas element.
 */
test('a guest lands on a README that renders its own blocks', async ({ page }) => {
  await page.goto('/try');

  // The note's identity: NotePage renders the title in its own field above the body
  // (buildReadme.ts deliberately emits no "README" heading in the body - a second `h1
  // README` would sit right under the real one), so the title field is what to read.
  await expect(page.getByLabel('Note title')).toHaveValue('README');

  // Toggles render closed by default. `Details` is `persist: true`, so the content node
  // already exists in the DOM, but the `hidden` attribute the DetailsContent node view
  // sets keeps it out of the render tree until opened.
  const firstToggle = page.locator('.folio-details').first();
  await expect(firstToggle).toBeVisible();
  const firstToggleContent = firstToggle.locator('[data-type="detailsContent"]');
  await expect(firstToggleContent).toBeHidden();

  // Opening it, the way a person would. The toggle's expand control is the <button>
  // @tiptap/extension-details' node view renders as the first child of `.folio-details`;
  // the extension ships it empty and unstyled, so it used to compute to a literal 0x0 box
  // and NOBODY could open a toggle on any input device (see editor.css's `Details /
  // toggle` block for the full shape). These assertions are the regression guard for that:
  // `toBeVisible()` fails on a zero-area element, and Playwright's `.click()` does real
  // hit-testing, so both fail if the button ever loses its box again. Deliberately NOT
  // `dispatchEvent('click')` - that reaches the listener without going through the
  // rendered UI at all, and would pass against a control no user can reach.
  const firstToggleButton = firstToggle.locator('button').first();
  await expect(firstToggleButton).toBeVisible();
  await expect(firstToggleButton).toHaveAttribute('aria-expanded', 'false');
  await firstToggleButton.click();
  await expect(firstToggleContent).toBeVisible();
  await expect(firstToggleButton).toHaveAttribute('aria-expanded', 'true');

  // ...and it closes again, so this is a toggle rather than a one-way reveal.
  await firstToggleButton.click();
  await expect(firstToggleContent).toBeHidden();

  // The keyboard path, which is a separate mechanism from the click and was separately
  // broken: the button lives inside ProseMirror's contenteditable, and the editor's own
  // keydown handler calls preventDefault() on Enter, which cancels the browser's implicit
  // activation of a focused button. buildExtensions.ts's `renderToggleButton` handles
  // Enter and Space on the button itself and keeps focus there afterwards, so both keys
  // work and both directions work.
  await firstToggleButton.focus();
  await page.keyboard.press('Enter');
  await expect(firstToggleContent).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(firstToggleContent).toBeHidden();
  await page.keyboard.press('Space');
  await expect(firstToggleContent).toBeVisible();

  // Every group's reference table and live demos sit INSIDE that group's toggle
  // (buildReadme.ts's insertSection), so open the rest too. That is also required for the
  // "every block is named" check below: `innerText()` (unlike `textContent()`) only reads
  // what is actually rendered on screen, and a closed toggle's content does not count.
  const toggles = page.locator('.folio-details');
  const toggleCount = await toggles.count();
  for (let i = 1; i < toggleCount; i++) {
    await toggles.nth(i).locator('button').first().click();
  }

  // Live blocks, each read from what its node view actually emits.
  await expect(page.locator('.katex').first()).toBeVisible();
  await expect(page.locator('table').first()).toBeVisible();
  await expect(page.locator('[data-tone="info"]').first()).toBeVisible();
  await expect(page.getByRole('checkbox').first()).toBeVisible();

  // The chemistry demo (caffeine) draws asynchronously once the smiles-drawer chunk has
  // loaded and parsed the SMILES string - give it generous time. Read a bond line rather
  // than "any child": smiles-drawer always writes a <style> tag into the <svg> first
  // (SvgWrapper.js), which exists (and is present) whether or not a molecule ever drew,
  // so checking for children alone would pass on an empty structure.
  await expect(page.locator('.folio-chem-svg line').first()).toBeVisible({ timeout: 15_000 });

  // Every insert block is named somewhere in the note.
  const body = await page.getByTestId('note-editor').innerText();
  for (const name of ['Callout', 'Table', 'Code block', 'Chemistry structure', '3D model']) {
    expect(body, `README does not mention ${name}`).toContain(name);
  }

  // The guest build is honest about what it cannot do.
  expect(body).toContain('needs an account');
});

test('a guest returning to /try lands on their own work, not the guide', async ({ page }) => {
  await page.goto('/try');
  await expect(page.getByLabel('Note title')).toHaveValue('README');

  // The blank note seeded alongside the README (guestStore.ts's seedGuestWorkspace) has no
  // title, which NoteCard falls back to labelling "Untitled". Its card title is a LINK -
  // it became one with tabs, so that Ctrl/middle-clicking a note opens it in a new tab the
  // way every other link in the app can be opened.
  await page.goto('/');
  await page.getByRole('link', { name: 'Untitled', exact: true }).click();
  await page.getByTestId('note-editor').click();
  await page.keyboard.type('my own note');

  // Let the autosave debounce fire before navigating away: a client-side route change
  // would leave a pending timer running, but /try is a real navigation and would drop it.
  await page.waitForTimeout(1200);

  await page.goto('/try');
  await expect(page.getByLabel('Note title')).not.toHaveValue('README');
  await expect(page.getByTestId('note-editor')).toContainText('my own note');
});
