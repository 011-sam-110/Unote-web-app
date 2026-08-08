import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './auth.fixture';
import { TESTIDS, apiCreateNotebook, editorBody, uniqueName } from './utils';

/**
 * The per-change AI review: decorations in the note, cards in the rail, approve/deny one at
 * a time.
 *
 * UNLIKE ai.spec.ts, THIS FILE DOES NOT CALL THE GATEWAY. `POST /api/ai/suggest` is stubbed
 * with a fixed set of edits, for two reasons that both matter more here than realism does:
 *
 *   • What is under test is the plugin's position arithmetic, and that can only be asserted
 *     against edits whose `before` and `after` are known to the character. A live model
 *     returns different suggestions every run, so a live run could only ever assert "some
 *     text changed" - which is exactly the assertion that would pass while the note was
 *     being quietly corrupted.
 *   • The free gateway's quota is spent often enough that ai.spec.ts already skips on it. A
 *     correctness test for a text-mangling code path must not be skippable.
 *
 * `GET /api/ai/checks` is NOT stubbed. The rail's severity ordering comes from the real
 * catalogue on purpose, so retuning a family server-side reorders this test with it.
 */

/** Ids are written into the seeded content so the stubbed edits can name them. TipTap's
 *  UniqueID only mints an id for a node that has none, so these survive the load. */
const ALPHA = 'rvw-alpha';
const BETA = 'rvw-beta';
const GAMMA = 'rvw-gamma';
const DELTA = 'rvw-delta';

const BLOCKS: Array<{ id: string; text: string }> = [
  { id: ALPHA, text: 'Binary search trees keep the left subtree smaller and the right subtree larger.' },
  { id: BETA, text: 'A hash map gives O(1) average lookup.' },
  { id: GAMMA, text: "Dijkstra's algorithm works correctly with negative edge weights." },
  { id: DELTA, text: 'Topological sort only applies to directed acyclic graphs.' },
];

/**
 * The stubbed run.
 *
 * Chosen so severity order and document order DISAGREE: down the page the suggestions are
 * clarity, grammar, accuracy, and the rail has to show accuracy, clarity, grammar.
 *
 * `E_EARLY` deliberately shortens its block by 38 characters. That is the point of the
 * remapping assertions below: every position after it in the document moves back by 38, and
 * `E_LATE` sits two blocks further down with a fourth block after that - so a position that
 * failed to move lands in real text rather than off the end of the document, and corrupts
 * silently instead of throwing.
 */
const E_EARLY = {
  id: 'rvw-e-early',
  blockId: ALPHA,
  op: 'replace' as const,
  before: 'keep the left subtree smaller and the right subtree larger',
  after: 'order their subtrees',
  reason: 'One clause per idea reads faster than a 13-word chain of comparisons.',
  checkId: 'clarity.sentence-too-long',
};

const E_MINOR = {
  id: 'rvw-e-minor',
  blockId: BETA,
  // Regex metacharacters in `before`, on purpose: the plugin matches with a pattern built
  // from this string, and an unescaped "O(1)" would either throw or match the wrong thing.
  op: 'replace' as const,
  before: 'O(1) average lookup',
  after: 'O(1) average-case lookup',
  reason: 'Average-case is the precise term; "O(1) average" reads as a claim about all cases.',
  checkId: 'grammar.technical-term-typo',
};

const E_LATE = {
  id: 'rvw-e-late',
  blockId: GAMMA,
  op: 'replace' as const,
  before: 'works correctly with negative edge weights',
  after: 'does not work with negative edge weights',
  reason: "Dijkstra's assumes non-negative weights; this contradicts the rest of the note.",
  checkId: 'accuracy.factual-error',
};

/** Names a block that is not in the document. Must be reported, never silently dropped. */
const E_STALE = {
  id: 'rvw-e-stale',
  blockId: 'rvw-does-not-exist',
  op: 'replace' as const,
  before: 'anything at all',
  after: 'something else',
  reason: 'Anchored to a block that is not in this note.',
  checkId: 'structure.wall-of-text',
};

const EXPECTED_AFTER_REVIEW = [
  'Binary search trees order their subtrees.',
  'A hash map gives O(1) average lookup.',
  "Dijkstra's algorithm does not work with negative edge weights.",
  'Topological sort only applies to directed acyclic graphs.',
];

async function seedNote(
  request: APIRequestContext,
  title: string,
  blocks: Array<{ id: string; text: string }>,
): Promise<{ id: string; title: string }> {
  const notebook = await apiCreateNotebook(request, uniqueName('E2E Review Notebook'));
  const res = await request.post('/api/notes', {
    data: {
      notebookId: notebook.id,
      title,
      contentText: blocks.map((b) => b.text).join('\n'),
      contentJson: {
        type: 'doc',
        content: blocks.map((b) => ({
          type: 'paragraph',
          attrs: { id: b.id },
          content: [{ type: 'text', text: b.text }],
        })),
      },
    },
  });
  expect(res.ok(), `seed note failed: ${res.status()}`).toBeTruthy();
  const { note } = await res.json();
  return note;
}

/** Keeps the AI menu on screen whatever the gateway is doing. */
async function stubAiHealth(page: Page): Promise<void> {
  await page.route('**/api/meta/ai-health', (route) =>
    route.fulfill({ json: { ok: true, model: 'stub', source: 'shared-pool' } }),
  );
}

/**
 * Fixes the run's response, and keeps the AI menu on screen whatever the gateway is doing.
 *
 * `/api/ai/chat` is stubbed alongside `/api/ai/suggest` because the panel is a conversation
 * now: pressing "Improve writing" sends a message, and the model's answer is what decides
 * which tool runs. Leaving that call live would put a real gateway request in front of every
 * assertion in this file - the one thing the header explains this suite must never do - and
 * would make the run's determinism depend on a model reading a button label correctly.
 *
 * The stub returns the tool call that press is meant to produce, so what is under test stays
 * the plugin's position arithmetic rather than the routing.
 */
async function stubSuggestions(page: Page, edits: unknown[]): Promise<void> {
  await stubAiHealth(page);
  await page.route('**/api/ai/chat', (route) =>
    route.fulfill({
      json: { kind: 'tool', tool: 'improve_writing', args: {}, say: 'Reading through your note.', model: 'stub' },
    }),
  );
  await page.route('**/api/ai/suggest', (route) =>
    route.fulfill({ json: { edits, rejected: 0, ranFamilies: ['accuracy', 'clarity', 'grammar', 'structure'] } }),
  );
}

/**
 * The DOCUMENT's text, block by block, with the review widgets taken out.
 *
 * This is the distinction the whole feature rests on. A paragraph's `textContent` includes
 * the proposed text, because a suggestion renders as a widget INSIDE the paragraph it is
 * about; the document itself contains no such thing until an approval puts it there.
 * Stripping `.folio-ai-ins` is what makes an assertion here an assertion about the note
 * rather than about the overlay.
 */
async function documentBlocks(page: Page): Promise<string[]> {
  return page.evaluate((testid) => {
    const root = document.querySelector(`[data-testid="${testid}"]`);
    if (!root) return [];
    return Array.from(root.children).map((child) => {
      const clone = child.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('.folio-ai-ins').forEach((w) => w.remove());
      return (clone.textContent ?? '').trim();
    });
  }, TESTIDS.noteEditor);
}

/**
 * Open the AI panel and start a run.
 *
 * The panel is addressed by test id rather than by the name of its toggle. That toggle has
 * been called "AI" and is now called "Assistant", and a name-based selector went on matching
 * nothing for as long as it took someone to run this file.
 *
 * Pressing "Improve writing" sends a message rather than calling an endpoint, so this waits
 * on the rail (the run) and not on the click, and `stubSuggestions` fixes both hops.
 */
async function openReview(page: Page): Promise<void> {
  const main = page.getByRole('main');
  await page.getByTestId('assistant-open').click();
  await main.getByRole('button', { name: /improve writing/i }).first().click();
  await expect(page.getByTestId('ai-review-rail')).toBeVisible({ timeout: 15_000 });
}

/** The check picker, from the same panel, under the composer. */
async function openChecks(page: Page): Promise<void> {
  const main = page.getByRole('main');
  await page.getByTestId('assistant-open').click();
  await main.getByRole('button', { name: /choose what to check/i }).click();
  await expect(page.getByTestId('check-picker')).toBeVisible({ timeout: 15_000 });
}

/** The picker's family toggles that are currently on. */
function enabledFamilies(page: Page) {
  return page.getByTestId('check-picker').locator('input[type="checkbox"]:checked');
}

async function openNoteAndWait(page: Page, note: { id: string; title: string }): Promise<void> {
  await page.goto(`/note/${note.id}`);
  await expect(page.getByPlaceholder('Untitled')).toHaveValue(note.title, { timeout: 10_000 });
}

function card(page: Page, editId: string) {
  return page.locator(`[data-testid="ai-review-card"][data-edit-id="${editId}"]`);
}

/** The struck-through range for one suggestion, inside the note. */
function struck(page: Page, editId: string) {
  return page.locator(`.folio-ai-del[data-edit-id="${editId}"]`);
}

function group(page: Page, familyId: string) {
  return page.locator(`[data-testid="ai-review-group"][data-family="${familyId}"]`);
}

/** Minor families arrive folded, so anything grammar has to be opened first. */
async function expand(page: Page, familyId: string): Promise<void> {
  await group(page, familyId).getByRole('button').first().click();
}

/** The note as the SERVER has it, polled until a pending autosave has landed. */
async function storedText(request: APIRequestContext, noteId: string, settles: string): Promise<string> {
  await expect
    .poll(
      async () => {
        const res = await request.get(`/api/notes/${noteId}`);
        const body = await res.json();
        return body.note.contentText as string;
      },
      { timeout: 20_000, message: `autosave never persisted "${settles}"` },
    )
    .toContain(settles);
  const res = await request.get(`/api/notes/${noteId}`);
  const body = await res.json();
  return `${body.note.contentText} ${JSON.stringify(body.note.contentJson)}`;
}

test.describe('AI review (stubbed suggestions)', () => {
  test('renders suggestions as decorations and never writes them into the note', async ({ page, request }) => {
    const note = await seedNote(request, uniqueName('AI Review Decorations'), BLOCKS);
    await stubSuggestions(page, [E_EARLY, E_MINOR, E_LATE, E_STALE]);

    await page.goto(`/note/${note.id}`);
    await expect(page.getByPlaceholder('Untitled')).toHaveValue(note.title, { timeout: 10_000 });
    await openReview(page);

    // Three of the four resolve; the fourth names a block that is not in this note.
    await expect(page.locator('.folio-ai-del')).toHaveCount(3);
    await expect(struck(page, E_EARLY.id)).toHaveText(E_EARLY.before);
    await expect(struck(page, E_MINOR.id)).toHaveText(E_MINOR.before);
    await expect(struck(page, E_LATE.id)).toHaveText(E_LATE.before);
    await expect(page.locator('.folio-ai-ins')).toHaveCount(3);

    // The fourth is reported, not dropped.
    await expect(page.getByTestId('ai-review-stale')).toContainText('1 suggestion no longer applies');

    // The document itself is untouched: every block still reads exactly as it was seeded.
    expect(await documentBlocks(page)).toEqual(BLOCKS.map((b) => b.text));

    // And it stays untouched through a REAL autosave with the review on screen. Typing at
    // the end of the last block forces the save the debounce would otherwise sit on, so this
    // asserts what the server actually stored while three suggestions were rendered.
    await editorBody(page).locator('p').last().click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Confirmed.');

    const saved = await storedText(request, note.id, 'Confirmed.');
    for (const proposal of [E_EARLY.after, E_MINOR.after, E_LATE.after]) {
      expect(saved).not.toContain(proposal);
    }

    // An edit elsewhere in the note does not move a suggestion off its words.
    await expect(struck(page, E_LATE.id)).toHaveText(E_LATE.before);
  });

  test('remaps the remaining suggestions after each approval', async ({ page, request }) => {
    const note = await seedNote(request, uniqueName('AI Review Remapping'), BLOCKS);
    await stubSuggestions(page, [E_EARLY, E_MINOR, E_LATE]);

    await page.goto(`/note/${note.id}`);
    await expect(page.getByPlaceholder('Untitled')).toHaveValue(note.title, { timeout: 10_000 });
    await openReview(page);

    // --- Approve the EARLY one. Its block loses 38 characters, so every position after it
    // --- in the document shifts back by 38.
    await card(page, E_EARLY.id).getByTestId('ai-review-approve').click();
    await expect
      .poll(async () => (await documentBlocks(page))[0])
      .toBe('Binary search trees order their subtrees.');

    // THE ASSERTION THIS SPEC EXISTS FOR. The late suggestion was resolved against the
    // document as it was BEFORE that approval. Had its position been carried over unmapped
    // it would now sit 38 characters past the phrase it is about - still inside real text,
    // because two more blocks follow - so approving it would quietly rewrite words that
    // were never flagged. The decoration says where it actually points.
    await expect(struck(page, E_LATE.id)).toHaveText('works correctly with negative edge weights');
    await expect(struck(page, E_MINOR.id)).toHaveText('O(1) average lookup');

    // --- Now approve the LATE one, two blocks further down.
    await card(page, E_LATE.id).getByTestId('ai-review-approve').click();
    await expect
      .poll(async () => (await documentBlocks(page))[2])
      .toBe("Dijkstra's algorithm does not work with negative edge weights.");

    // Deny the third, so the run ends with one of each verdict.
    await expand(page, 'grammar');
    await card(page, E_MINOR.id).getByTestId('ai-review-deny').click();
    const settled = page.getByTestId('ai-review-settled');
    await expect(settled.locator(`[data-edit-id="${E_MINOR.id}"]`)).toContainText('Denied');
    await expect(settled.locator(`[data-edit-id="${E_LATE.id}"]`)).toContainText('Approved');
    // A denied suggestion leaves the text it quoted exactly as the student wrote it, and
    // takes its strikethrough with it.
    await expect(struck(page, E_MINOR.id)).toHaveCount(0);

    // The whole note, end to end: two approvals landed on their own words, and nothing else
    // in the document moved.
    expect(await documentBlocks(page)).toEqual(EXPECTED_AFTER_REVIEW);

    // And that is what reaches the server.
    const saved = await storedText(request, note.id, 'order their subtrees');
    expect(saved).toContain("Dijkstra's algorithm does not work with negative edge weights.");
    expect(saved).toContain('A hash map gives O(1) average lookup.');
    expect(saved).not.toContain('average-case');
  });

  test('groups cards by severity rather than by document order', async ({ page, request }) => {
    const note = await seedNote(request, uniqueName('AI Review Ordering'), BLOCKS);
    await stubSuggestions(page, [E_EARLY, E_MINOR, E_LATE]);

    await page.goto(`/note/${note.id}`);
    await expect(page.getByPlaceholder('Untitled')).toHaveValue(note.title, { timeout: 10_000 });
    await openReview(page);

    // Down the page the suggestions are clarity, grammar, accuracy. The rail is not.
    const groups = page.getByTestId('ai-review-group');
    await expect(groups).toHaveCount(3);
    expect(await groups.evaluateAll((els) => els.map((el) => el.getAttribute('data-family')))).toEqual([
      'accuracy',
      'clarity',
      'grammar',
    ]);

    // The critical card is open on arrival; the minor family is folded away with its count
    // showing, so a pile of small fixes cannot push a factual error off the screen.
    await expect(card(page, E_LATE.id)).toBeVisible();
    await expect(card(page, E_MINOR.id)).toHaveCount(0);
    await expect(group(page, 'grammar')).toContainText('Grammar');
    await expand(page, 'grammar');
    await expect(card(page, E_MINOR.id)).toBeVisible();

    // The reason is the card's whole purpose - a diff can say what changed, never why.
    await expect(card(page, E_LATE.id)).toContainText("Dijkstra's assumes non-negative weights");
  });

  /**
   * A formatting suggestion has to arrive as formatting, in all three places it appears.
   *
   * The model answers in markdown, because markdown is how you write "make this bold" in
   * text. For a long time every one of these treated that answer as literal characters: the
   * preview in the note read `**closest**`, the card's diff read `**closest**`, and approving
   * it wrote the asterisks into the student's note. An action called "clean up formatting"
   * could not apply formatting.
   *
   * All three are asserted together on purpose. Any one of them fixed alone leaves the reader
   * judging a suggestion by a preview that does not match what approving it will do, which is
   * a worse failure than the original bug.
   */
  test('applies a formatting suggestion as formatting, in the preview, the card and the note', async ({ page, request }) => {
    const note = await seedNote(request, uniqueName('AI Review Formatting'), [
      { id: 'rvw-fmt', text: 'Dijkstra picks the closest unvisited node each step.' },
    ]);
    await stubSuggestions(page, [
      {
        id: 'rvw-e-fmt',
        blockId: 'rvw-fmt',
        op: 'replace',
        before: 'picks the closest unvisited node',
        after: 'always picks the **closest unvisited** node',
        reason: 'Naming the invariant makes the greedy step obvious on a re-read.',
        checkId: 'clarity.sentence-too-long',
      },
    ]);

    await openNoteAndWait(page, note);
    await openReview(page);

    // 1. The preview inside the note, which is where the suggestion is actually judged.
    const preview = page.locator('.folio-ai-ins').first();
    await expect(preview.locator('strong')).toHaveText('closest unvisited');
    await expect(preview).not.toContainText('**');

    // 2. The card's diff, which has to agree with it.
    const diff = card(page, 'rvw-e-fmt').locator('ins');
    await expect(diff.locator('strong')).toHaveText('closest unvisited');

    // 3. What approving it puts in the document: a real mark, not four asterisks.
    await card(page, 'rvw-e-fmt').getByTestId('ai-review-approve').click();
    const body = editorBody(page);
    await expect(body.locator('strong')).toHaveText('closest unvisited');
    await expect(body).not.toContainText('**');
    await expect(body).toContainText('Dijkstra always picks the closest unvisited node each step.');
  });

  test('says how many cards a family is holding back instead of truncating silently', async ({ page, request }) => {
    const words = ['alfa', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
    const note = await seedNote(request, uniqueName('AI Review Volume'), [
      { id: 'rvw-cap', text: `${words.join(' ')}.` },
    ]);

    await stubSuggestions(
      page,
      words.map((w, i) => ({
        id: `rvw-cap-${i}`,
        blockId: 'rvw-cap',
        op: 'replace' as const,
        before: w,
        after: w.toUpperCase(),
        reason: `Proper nouns in this note are capitalised; "${w}" is not.`,
        checkId: 'grammar.inconsistent-capitalisation',
      })),
    );

    await page.goto(`/note/${note.id}`);
    await expect(page.getByPlaceholder('Untitled')).toHaveValue(note.title, { timeout: 10_000 });
    await openReview(page);

    // Eight distinct words, eight strikethroughs: every suggestion is anchored even though
    // only some of them get a card.
    await expect(page.locator('.folio-ai-del')).toHaveCount(8);

    await expand(page, 'grammar');
    await expect(page.getByTestId('ai-review-card')).toHaveCount(5);
    await expect(page.getByTestId('ai-review-more')).toHaveText('3 more in Grammar');

    await page.getByTestId('ai-review-more').click();
    await expect(page.getByTestId('ai-review-card')).toHaveCount(8);
    await expect(page.getByTestId('ai-review-more')).toHaveCount(0);
  });

  /**
   * The uploads comparison is live now, but only where there is a second side to compare
   * against. The reason shown is the server's own sentence for that case (see
   * `POST /api/ai/gaps/edits`), so a student who imports something and still gets refused
   * reads the same wording from the route that they read from the menu.
   */
  test('offers the uploads comparison only when the note has uploads', async ({ page, request }) => {
    const note = await seedNote(request, uniqueName('AI Review No Uploads'), BLOCKS);
    await stubAiHealth(page);

    await openNoteAndWait(page, note);
    const main = page.getByRole('main');
    await page.getByTestId('assistant-open').click();

    const gaps = main.getByRole('button', { name: /find missing content from uploads/i });
    await expect(gaps).toBeDisabled();

    // The reason is no longer nested INSIDE the chip - as a second line of italic text it
    // stretched that one pill to three times the width of its neighbours and broke the row.
    // It now sits beside the row and is wired to the control with aria-describedby, so it
    // is still visible text (not a title-only tooltip) and is still announced with the
    // button. Assert both halves of that contract rather than the old nesting.
    const describedBy = await gaps.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const reason = main.locator(`#${describedBy}`);
    await expect(reason).toBeVisible();
    await expect(reason).toHaveText('Import slides, a photo or a transcript first.');
  });

  /**
   * The undo path.
   *
   * A review has no Undo of its own - approvals land one at a time and autosave persists
   * them - so History is the only way back to the note the student wrote, and it is only
   * there if a snapshot was taken BEFORE the first approval and only once for the whole run.
   *
   * Ordering is proved rather than inferred: the snapshot request is held open by the route
   * handler below, and while it is unanswered the document must still read exactly as it was
   * seeded. A snapshot fired off beside the edit, or after it, would fail that assertion.
   */
  test('takes one restore point per run, before the first approval writes anything', async ({ page, request }) => {
    const note = await seedNote(request, uniqueName('AI Review Undo'), BLOCKS);
    await stubSuggestions(page, [E_EARLY, E_MINOR, E_LATE]);

    let openTheGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      openTheGate = resolve;
    });
    let snapshots = 0;
    await page.route('**/api/notes/*/versions', async (route) => {
      // GETs (History) pass straight through; only the snapshot POST is held.
      if (route.request().method() !== 'POST') return route.fallback();
      snapshots++;
      await gate;
      await route.continue();
    });

    await openNoteAndWait(page, note);
    await openReview(page);
    expect(snapshots, 'opening a review must not write history on its own').toBe(0);

    await card(page, E_EARLY.id).getByTestId('ai-review-approve').click();

    // The approval is now waiting on the restore point.
    await expect
      .poll(() => snapshots, { message: 'the first approval requested no snapshot' })
      .toBe(1);

    // THE ASSERTION THIS SPEC EXISTS FOR. The snapshot request is unanswered, and until it
    // is, not one character of the note has moved.
    expect(await documentBlocks(page)).toEqual(BLOCKS.map((b) => b.text));

    openTheGate();
    await expect
      .poll(async () => (await documentBlocks(page))[0])
      .toBe('Binary search trees order their subtrees.');

    // A second approval in the same run reuses the same restore point. Eight approvals must
    // leave History with one entry to go back to, not eight indistinguishable ones.
    await card(page, E_LATE.id).getByTestId('ai-review-approve').click();
    await expect
      .poll(async () => (await documentBlocks(page))[2])
      .toBe("Dijkstra's algorithm does not work with negative edge weights.");
    expect(snapshots, 'the second approval took a second snapshot').toBe(1);

    // And the server agrees - one restore point, holding the note as it was BEFORE the
    // review. That last part is the independent proof that the ordering above was real:
    // a snapshot taken after the first approval would have recorded the reviewed text.
    const listed = await request.get(`/api/notes/${note.id}/versions`);
    const { versions } = (await listed.json()) as { versions: Array<{ id: number; label: string | null }> };
    const restorePoints = versions.filter((v) => v.label === 'Before AI review');
    expect(restorePoints).toHaveLength(1);

    const stored = await request.get(`/api/notes/${note.id}/versions/${restorePoints[0].id}`);
    const { version } = (await stored.json()) as { version: { contentJson: unknown } };
    const restored = JSON.stringify(version.contentJson);
    expect(restored).toContain('keep the left subtree smaller and the right subtree larger');
    expect(restored).not.toContain('order their subtrees');
  });

  /**
   * The whole feature, end to end and through a reload: what was approved is in the note,
   * what was denied never was, and what was never decided is untouched.
   */
  test('persists the approved change and only the approved change', async ({ page, request }) => {
    const note = await seedNote(request, uniqueName('AI Review Full Path'), BLOCKS);
    await stubSuggestions(page, [E_EARLY, E_MINOR, E_LATE]);

    await openNoteAndWait(page, note);
    await openReview(page);

    await card(page, E_LATE.id).getByTestId('ai-review-approve').click();
    await expect
      .poll(async () => (await documentBlocks(page))[2])
      .toBe("Dijkstra's algorithm does not work with negative edge weights.");

    await expand(page, 'grammar');
    await card(page, E_MINOR.id).getByTestId('ai-review-deny').click();
    await expect(
      page.getByTestId('ai-review-settled').locator(`[data-edit-id="${E_MINOR.id}"]`),
    ).toContainText('Denied');

    // Wait for the approval to reach the server before reloading - the reload asserts what
    // was PERSISTED, so it must not race the autosave that persists it.
    await storedText(request, note.id, 'does not work with negative edge weights');

    await page.reload();
    await expect(page.getByPlaceholder('Untitled')).toHaveValue(note.title, { timeout: 10_000 });
    await expect(editorBody(page)).toBeVisible();

    await expect
      .poll(async () => await documentBlocks(page))
      .toEqual([
        // Never decided: still the student's sentence.
        BLOCKS[0].text,
        // Denied: the model's wording never touched the note.
        BLOCKS[1].text,
        // Approved.
        "Dijkstra's algorithm does not work with negative edge weights.",
        BLOCKS[3].text,
      ]);

    // Nothing of the review itself survived the reload: the suggestions were decorations,
    // and decorations are not in the document.
    await expect(page.getByTestId('ai-review-rail')).toHaveCount(0);
    await expect(page.locator('.folio-ai-ins')).toHaveCount(0);
    await expect(page.locator('.folio-ai-del')).toHaveCount(0);
  });
});

/**
 * The check picker.
 *
 * Its specs live here rather than with Task 8's component because until the note page
 * mounted it, there was nowhere for Playwright to reach it. The catalogue is NOT stubbed:
 * the picker exists to render what the server actually runs, so a test against a fixture
 * catalogue would pass while the two drifted apart.
 */
test.describe('Check picker', () => {
  test('renders the served catalogue and remembers the choice per notebook', async ({ page, request }) => {
    const first = await seedNote(request, uniqueName('AI Checks Notebook A'), BLOCKS);
    await stubAiHealth(page);

    await openNoteAndWait(page, first);
    await openChecks(page);

    // Eight families, straight from GET /api/ai/checks.
    await expect(page.getByTestId('check-picker').locator('input[type="checkbox"]')).toHaveCount(8);

    // A notebook nobody has chosen for runs the catalogue's DEFAULT preset - which the
    // server marks with a flag, so this stays true if the presets are reordered (the flag
    // itself is pinned by server/test/checks.test.ts).
    await expect(page.getByTestId('check-preset-lecture-notes')).toHaveAttribute('aria-pressed', 'true');
    await expect(enabledFamilies(page)).toHaveCount(4);

    // The cheapest preset: one family, and the cost line says so before any quota is spent.
    await page.getByTestId('check-preset-proofread').click();
    await expect(enabledFamilies(page)).toHaveCount(1);
    await expect(page.getByTestId('check-family-grammar')).toBeChecked();
    await expect(page.getByTestId('check-cost')).toContainText('runs 1 of 8 families');

    // Saved as you change it - no Save button to forget.
    await page.getByRole('dialog').getByRole('button', { name: /^done$/i }).click();
    await expect(page.getByTestId('check-picker')).toHaveCount(0);

    await page.reload();
    await expect(page.getByPlaceholder('Untitled')).toHaveValue(first.title, { timeout: 10_000 });
    await openChecks(page);
    await expect(enabledFamilies(page)).toHaveCount(1);
    await expect(page.getByTestId('check-family-grammar')).toBeChecked();
    await page.getByRole('dialog').getByRole('button', { name: /^done$/i }).click();

    // A second notebook keeps its own answer: a chemistry notebook and an essay notebook
    // want different checks, and one being set must not decide for the other.
    const second = await seedNote(request, uniqueName('AI Checks Notebook B'), BLOCKS);
    await openNoteAndWait(page, second);
    await openChecks(page);
    await expect(enabledFamilies(page)).toHaveCount(4);
    await expect(page.getByTestId('check-family-grammar')).not.toBeChecked();
    await expect(page.getByTestId('check-preset-lecture-notes')).toHaveAttribute('aria-pressed', 'true');
  });
});
