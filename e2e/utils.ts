import { type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { expect, test } from './auth.fixture';

/**
 * Shared helpers for the Unote e2e suite.
 *
 * Selector policy (per the build contract): prefer getByRole/getByPlaceholder/getByText
 * matched against the literal copy in docs/FRONTEND.md, or against real DOM already
 * confirmed by reading the in-progress source of the other parallel agents (notably
 * ImportModal.tsx, CapturePage.tsx, AskPage.tsx, NoteCard.tsx, Modal.tsx, Toast.tsx,
 * lib/format.ts and lib/useShortcuts.ts, all of which already existed with real
 * markup at the time this suite was written). Pages that were still placeholder
 * stubs at that time (NotePage.tsx, DashboardPage.tsx, NotebookPage.tsx, the
 * sidebar/App shell) have no confirmed DOM yet, so a handful of elements there are
 * targeted via data-testid hooks this file assumes exist - see the task handoff
 * notes for the full list; the owning web-* agents need to add them.
 */

export const TESTIDS = {
  noteEditor: 'note-editor', // the TipTap contenteditable root on /note/:id
  autosaveStatus: 'autosave-status', // element whose text cycles Saving.../Saved .../error
  slashMenu: 'slash-menu',
  slashMenuItem: 'slash-menu-item',
  wikilinkMenu: 'wikilink-menu',
  wikilinkMenuItem: 'wikilink-menu-item',
  backlinksSection: 'backlinks-section',
  historyDrawer: 'history-drawer',
  historyVersionItem: 'history-version-item',
  noteRow: 'note-row', // NotebookPage list row fallback - real NoteCard.tsx renders `.note-card` (role="button"), prefer that
  pinnedStrip: 'pinned-strip',
  recentGrid: 'recent-notes',
  continueCard: 'continue-card',
  statsLine: 'dashboard-stats',
  quickSwitcher: 'quick-switcher',
  quickSwitcherResult: 'quick-switcher-result',
  fulltextResults: 'fulltext-results',
  aiPreviewModal: 'ai-preview-modal',
} as const;

export function uniqueName(prefix: string): string {
  return `${prefix} ${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
}

/**
 * Failures that come from the AI provider rather than from Unote.
 *
 *  • "All AI models failed (…)" - every model in the pool refused; the free
 *    gateway's burst/day allowance is spent.
 *  • "AI offline - is the gateway running?" - the server's 502, i.e. the gateway
 *    call did not complete at all.
 *
 * The second one is only safe to treat as environmental because every AI spec
 * calls `ensureAiHealthy` first: a gateway that is genuinely missing or
 * misconfigured fails there, loudly, before any of this is reached. A 502 *after*
 * that precondition has passed means the gateway was up moments ago and faltered.
 */
export const UPSTREAM_QUOTA_RE =
  /All AI models failed|rate.?limit(ed)?|quota|429|AI offline/i;

/**
 * Classify an AI failure as "the upstream free tier is exhausted" rather than "the
 * app is broken", and skip if so.
 *
 * The three gateway-backed spec files drive a real, shared, free-tier gateway. When
 * its pool is spent every one of them fails identically and for a reason that has
 * nothing to do with Unote - which is exactly the situation in which a red suite
 * stops carrying information. Skipping loudly (with the provider's own message)
 * keeps a quota drought from masking real regressions elsewhere.
 *
 * This deliberately does NOT swallow other AI failures: anything that is not the
 * provider-exhaustion signature still fails the test.
 */
export function skipIfUpstreamQuota(detail: string | null | undefined): void {
  const text = detail ?? '';
  test.skip(UPSTREAM_QUOTA_RE.test(text), `AI gateway exhausted upstream: ${text}`);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function exact(text: string): RegExp {
  return new RegExp(escapeRegex(text));
}

/** The generic Modal.tsx dialog, however it's currently on screen. */
export function dialog(page: Page): Locator {
  return page.getByRole('dialog');
}

/**
 * Dismisses the first-run tutorial, if it appears.
 *
 * Most specs never see it: auth.fixture.ts writes the "already answered" record
 * into the storageState it hands them. The exception is the auth specs, which sign
 * up or sign in through the real forms as a genuinely new account - and a genuinely
 * new account IS offered the tutorial, whose overlay deliberately blocks clicks on
 * the page behind it.
 *
 * So those specs dismiss it the way a person would, rather than the app growing a
 * "disable onboarding in tests" flag. Suppressing a feature to keep a test green
 * would mean the suite stops exercising the shell a real new user actually meets.
 *
 * Tolerant on purpose: waits a beat for the card, and simply carries on if it never
 * shows (an account that has answered before, or a page where it does not apply).
 */
export async function dismissTourIfPresent(page: Page): Promise<void> {
  // The tutorial opens from an effect on the app shell's own mount, so once the
  // sidebar is on screen the card is either already there or one frame away. Gate
  // on the shell first, then give the card a short window - that keeps the no-op
  // case (an account that has answered before) cheap instead of costing a full
  // timeout on every call.
  await sidebarNav(page).waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined);
  const card = page.getByTestId('tour-card');
  await card.waitFor({ state: 'visible', timeout: 1_500 }).catch(() => undefined);
  if (!(await card.isVisible().catch(() => false))) return;
  await page.getByRole('button', { name: /^not now$/i }).click();
  await expect(card).toBeHidden({ timeout: 5_000 });
}

/**
 * Creates a notebook through the sidebar "+ New notebook" control and waits for it
 * to appear in the sidebar. The sidebar reveals an inline create form (not a modal)
 * with a "Notebook name" field + a "Create notebook" submit button. Returns once the
 * notebook link is visible in the sidebar.
 */
export async function createNotebookViaSidebar(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: /new notebook/i }).click();
  const nameInput = page.getByPlaceholder(/notebook name/i);
  await expect(nameInput).toBeVisible({ timeout: 5_000 });
  await nameInput.fill(name);
  await page.getByRole('button', { name: /create notebook/i }).click();
  await expect(sidebarNav(page).getByRole('link', { name: exact(name) })).toBeVisible({ timeout: 10_000 });
}

/** The sidebar `<nav aria-label="Unote">`. Notebook links elsewhere (breadcrumb,
 * dashboard columns/hero) share the same name, so notebook navigation must scope
 * to this nav to stay unambiguous. */
export function sidebarNav(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Unote' });
}

/** Opens a notebook from the sidebar by name (partial match). */
export async function openNotebook(page: Page, name: string): Promise<void> {
  await sidebarNav(page).getByRole('link', { name: exact(name) }).click();
  await page.waitForURL(/\/notebook\//);
}

/** Clicks "New note" on the currently open notebook page and waits for the editor to load. */
export async function createNoteViaButton(page: Page): Promise<void> {
  await page.getByRole('button', { name: /new note/i }).first().click();
  await page.waitForURL(/\/note\//);
  await expect(page.getByTestId(TESTIDS.noteEditor)).toBeVisible({ timeout: 10_000 });
}

/**
 * The note editor the user can see.
 *
 * Filtered to the visible one, because several note pages can be mounted at once now - one
 * per open tab, all but the active one hidden - and an unscoped testid resolves to every
 * one of them, which fails strict mode rather than picking wrongly. Visibility rather than
 * `.tab-pane[data-active]` so this keeps working on the surfaces that render a note
 * outside the tabbed shell, like a share link.
 */
export function editorBody(page: Page): Locator {
  return page.getByTestId(TESTIDS.noteEditor).filter({ visible: true });
}

export function titleInput(page: Page): Locator {
  return page.getByPlaceholder('Untitled');
}

export function autosaveStatus(page: Page): Locator {
  return page.getByTestId(TESTIDS.autosaveStatus);
}

/** Waits until the autosave chip settles on a "Saved" state. */
export async function waitForSaved(page: Page): Promise<void> {
  await expect(autosaveStatus(page)).toHaveText(/saved/i, { timeout: 15_000 });
}

/**
 * Clicks an item in the note action bar's "⋯ More" menu.
 *
 * The note-page bar (web/src/features/editor/NoteActionBar.tsx) groups its rare
 * actions - History, Export .md, Pin/Unpin, Note info, the AI transforms and the
 * three import kinds - behind one "More" dropdown, so they are no longer top-level
 * buttons on the page. Two clicks, not one.
 *
 * Scoped to <main> for the same reason runDesktopImport is: a notebook whose NAME
 * contains the action word would otherwise let the sidebar's "Change emoji for
 * <notebook>" button match first.
 */
export async function clickNoteMoreItem(page: Page, item: RegExp): Promise<void> {
  const main = page.getByRole('main');
  await main.getByRole('button', { name: /^more$/i }).click();
  await main.getByRole('button', { name: item }).first().click();
}

/** Types text into the editor body, focusing it first. */
export async function typeInEditor(page: Page, text: string): Promise<void> {
  const body = editorBody(page);
  await body.click();
  await page.keyboard.type(text, { delay: 10 });
}

export async function setNoteTitle(page: Page, title: string): Promise<void> {
  const input = titleInput(page);
  await input.click();
  await input.fill(title);
}

/**
 * Opens the Ctrl/Cmd+K quick switcher.
 *
 * The binding lives in the App shell (lib/useShortcuts.ts, mounted by AppShell), so
 * it does not exist until that shell has mounted and its effect has run. Pressing
 * immediately after a fresh `page.goto` can land before the listener is attached and
 * be swallowed - which is exactly how this failed from the dashboard while working
 * fine on a note page that had been open for a while.
 *
 * So: wait for the shell to be on screen, then press. The retry is guarded by a
 * visibility check because Ctrl+K TOGGLES - an unguarded re-press would close the
 * panel it had just opened.
 */
export async function openQuickSwitcher(page: Page): Promise<void> {
  const switcher = page.getByTestId(TESTIDS.quickSwitcher);
  await expect(sidebarNav(page)).toBeVisible({ timeout: 15_000 });
  await expect(async () => {
    if (!(await switcher.isVisible())) await page.keyboard.press('Control+k');
    await expect(switcher).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
}

export function quickSwitcherInput(page: Page): Locator {
  return page.getByTestId(TESTIDS.quickSwitcher).getByRole('textbox');
}

/** Selects the first <option> in a <select> whose visible text matches `pattern`. */
export async function selectOptionMatching(select: Locator, pattern: RegExp): Promise<void> {
  const options = select.locator('option');
  const count = await options.count();
  for (let i = 0; i < count; i++) {
    const text = (await options.nth(i).textContent()) ?? '';
    if (pattern.test(text)) {
      const value = await options.nth(i).getAttribute('value');
      await select.selectOption(value ?? text);
      return;
    }
  }
  throw new Error(`No <option> matching ${pattern} found`);
}

/**
 * Note list rows, class `note-card`, with the `note-row` testid as a fallback.
 *
 * The card's TITLE is a role=link, not the role=button this comment used to claim. It
 * changed with tabs: the commonest way to open a note in the whole app was the one way
 * that could not be Ctrl-clicked, middle-clicked or opened in a new tab from the
 * browser's own menu, and none of those are behaviours a button can be given.
 */
export function noteCards(page: Page): Locator {
  return page.locator('.note-card').or(page.getByTestId(TESTIDS.noteRow));
}

/**
 * The tab pane currently on screen.
 *
 * <main> holds SEVERAL pages now - one per mounted tab, all but one hidden - plus the tab
 * strip itself. So an assertion like "this title is not in <main>" no longer means what it
 * used to: it can match a background pane, or a tab's own label in the strip. Scope to
 * this when a spec means "what the user is looking at".
 */
export function activePane(page: Page): Locator {
  return page.locator('.tab-pane[data-active]');
}

/** Extracts the note id from the current /note/:id URL. */
export function noteIdFromUrl(page: Page): string {
  const m = page.url().match(/\/note\/([^/?#]+)/);
  if (!m) throw new Error(`not on a note page: ${page.url()}`);
  return m[1];
}

// ---------------------------------------------------------------------------
// Direct-API helpers for fast, reliable test *setup* (per docs/API.md). Used to
// seed notebooks/notes/cards whose creation is already covered by another spec -
// the *behavior under test* in each spec still goes through the UI.
//
// These call the API through the built-in `request` fixture, which e2e/auth.fixture.ts
// has already authenticated as the worker's own account. Everything they create is
// therefore owned by, and only visible to, that account.
//
// NOTE: this block used to justify seeding TAGS here on the grounds that "how tags
// get attached to a note" was ambiguous. It is not any more - there is a real chip
// editor (web/src/features/editor/TagEditor.tsx) plus inline #hashtag parsing, and
// both are exercised through the UI in tags.spec.ts. Tag authoring should not be
// faked through the API again.
// ---------------------------------------------------------------------------

export interface ApiNotebook {
  id: string;
  name: string;
}

export async function apiCreateNotebook(request: APIRequestContext, name: string): Promise<ApiNotebook> {
  const res = await request.post('/api/notebooks', { data: { name, emoji: '🧪' } });
  expect(res.ok(), `create notebook failed: ${res.status()}`).toBeTruthy();
  const { notebook } = await res.json();
  return notebook;
}

export interface ApiNote {
  id: string;
  title: string;
}

/**
 * Drives the desktop ImportModal end-to-end: opens it (tolerating either a kind
 * picker menu on the trigger, or kind tabs inside the modal itself - the exact
 * shape isn't pinned down by docs/FRONTEND.md), attaches a file, optionally picks
 * a notebook, submits, waits for the job to reach 'done', and follows through to
 * the resulting note (whether that's an explicit "Open note" button or an
 * automatic navigation).
 */
export async function runDesktopImport(
  page: Page,
  opts: { kindLabel: RegExp; filePath: string; notebookName?: string; doneTimeout?: number },
): Promise<Locator> {
  // Scope to <main>: a notebook whose NAME contains "Import" would otherwise make
  // the sidebar's "Change emoji for <notebook>" button match /import/i first.
  await page.getByRole('main').getByRole('button', { name: /import/i }).first().click();

  // The notebook page's "Import ▾" trigger opens a dropdown menu of kinds; choosing
  // one there opens the ImportModal already set to that kind. Wait for either the
  // menuitem (dropdown) or the modal itself (direct-open contexts).
  // The ImportModal (web/src/features/import/ImportModal.tsx) titles its dialog
  // exactly "Import" - scope to that so we never grab another dialog (e.g. an emoji
  // picker) that happens to be on screen.
  const d = page.getByRole('dialog', { name: /^import$/i });
  const kindMenuItem = page.getByRole('menuitem', { name: opts.kindLabel });
  await expect(kindMenuItem.or(d).first()).toBeVisible({ timeout: 10_000 });
  if (await kindMenuItem.isVisible().catch(() => false)) {
    await kindMenuItem.first().click();
  }

  await expect(d).toBeVisible({ timeout: 10_000 });

  // Ensure the right kind tab is active inside the modal (harmless if already set).
  const kindTab = d.getByRole('tab', { name: opts.kindLabel });
  if (await kindTab.count()) {
    await kindTab.first().click();
  }

  await d.locator('input[type="file"]').first().setInputFiles(opts.filePath);

  if (opts.notebookName) {
    const notebookSelect = d.getByRole('combobox').first();
    if (await notebookSelect.count()) {
      await selectOptionMatching(notebookSelect, exact(opts.notebookName)).catch(() => undefined);
    }
  }

  // Submit button reads "Import" (or "Import N pages" for multi-page photo chains).
  const submit = d.getByRole('button', { name: /^import(\s|$)|upload|start|process/i });
  if (await submit.count()) {
    await submit.first().click();
  }

  // Terminal states per ImportModal: phase 'done' shows an "Open note" button,
  // phase 'error' shows "Import failed" + the error message. Whichever comes
  // first tells us how the job resolved - fail loudly rather than timing out
  // blindly on a job that already errored.
  const openNoteBtn = d.getByRole('button', { name: /open note/i });
  const failed = d.getByText(/import failed/i);
  await expect(openNoteBtn.or(failed)).toBeVisible({ timeout: opts.doneTimeout ?? 120_000 });
  if (await failed.isVisible().catch(() => false)) {
    const detail = await d.locator('.im-result__message').textContent().catch(() => null);
    // A spent upstream quota is an environment condition, not a regression - the
    // app correctly surfaced the failure with a Retry. Anything else still fails.
    skipIfUpstreamQuota(detail);
    throw new Error(`Import job failed: ${detail ?? '(no error detail rendered)'}`);
  }

  await openNoteBtn.click();
  await page.waitForURL(/\/note\//, { timeout: 15_000 });
  return d;
}

export async function apiCreateNote(
  request: APIRequestContext,
  notebookId: string,
  title: string,
  opts: { tags?: string[]; contentText?: string } = {},
): Promise<ApiNote> {
  const res = await request.post('/api/notes', {
    data: {
      notebookId,
      title,
      tags: opts.tags,
      contentText: opts.contentText ?? title,
      contentJson: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: opts.contentText ?? title }] }],
      },
    },
  });
  expect(res.ok(), `create note failed: ${res.status()}`).toBeTruthy();
  const { note } = await res.json();
  return note;
}

export interface ApiFlashcard {
  id: string;
  question: string;
  answer: string;
}

/**
 * Creates a flashcard attached to a note. POST /api/study/cards starts a card at
 * `due_at = now`, so anything created here is immediately in the review queue -
 * which is what lets the study specs assert exact due counts.
 */
export async function apiCreateFlashcard(
  request: APIRequestContext,
  noteId: string,
  question: string,
  answer: string,
): Promise<ApiFlashcard> {
  const res = await request.post('/api/study/cards', { data: { noteId, question, answer } });
  expect(res.ok(), `create flashcard failed: ${res.status()}`).toBeTruthy();
  const { card } = await res.json();
  return card;
}
