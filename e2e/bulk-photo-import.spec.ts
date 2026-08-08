/**
 * Bulk photo import: many phone photos in, several grouped notes out.
 *
 * This spec exists because every interesting part of the feature is invisible from the outside
 * and silently degrades rather than failing loudly:
 *
 *   - OCR runs in a worker whose assets used to be CDN-hosted and CSP-blocked, which made every
 *     photo import as a picture with no text at all. Nothing errored; the notes were just empty.
 *   - Capture time is read from EXIF, which the pre-upload canvas re-encode destroys. Read it in
 *     the wrong order and grouping silently falls back to filename order.
 *   - Grouping is a guess, and a wrong guess looks exactly like a right one until you open the
 *     note a week later.
 *
 * So the assertions are deliberately about OUTCOMES: how many notes, which photos ended up in
 * which, and whether the text made it into the body.
 */
import { expect, test } from './auth.fixture';
import { apiCreateNotebook, uniqueName } from './utils';
import { withExifDate } from './fixtures/exifJpeg';

test.describe.configure({ mode: 'serial' });

interface Shot {
  name: string;
  /** Rendered onto the page, so OCR has something real to read and grouping something to title. */
  lines: string[];
  /** Minutes after the batch's base time - what decides the grouping. */
  offsetMin: number;
}

/**
 * Two documents photographed in two sittings: three pages of one handout shot within a minute,
 * then a single unrelated page nearly an hour later. Correct behaviour is 2 notes, 3 pages + 1.
 */
const SHOTS: Shot[] = [
  { name: 'IMG_0411.jpg', lines: ['Graph traversal', 'breadth first search'], offsetMin: 0 },
  { name: 'IMG_0412.jpg', lines: ['queue frontier', 'visited set'], offsetMin: 0.5 },
  { name: 'IMG_0413.jpg', lines: ['shortest path', 'unweighted graph'], offsetMin: 1 },
  { name: 'IMG_0500.jpg', lines: ['Chemistry titration', 'burette reading'], offsetMin: 55 },
];

/** Render legible black-on-white text to a JPEG in the browser, then stamp EXIF onto it here. */
async function makePhotos(page: import('@playwright/test').Page) {
  const base = new Date(2026, 2, 14, 14, 2, 0); // fixed, so the spec cannot drift with the clock
  const encoded = await page.evaluate((shots) => {
    return shots.map((s) => {
      const c = document.createElement('canvas');
      c.width = 1000;
      c.height = 700;
      const x = c.getContext('2d')!;
      x.fillStyle = '#ffffff';
      x.fillRect(0, 0, c.width, c.height);
      x.fillStyle = '#000000';
      x.font = '64px Georgia';
      s.lines.forEach((line, i) => x.fillText(line, 50, 140 + i * 110));
      return c.toDataURL('image/jpeg', 0.92).split(',')[1];
    });
  }, SHOTS.map((s) => ({ lines: s.lines })));

  return SHOTS.map((shot, i) => {
    const taken = new Date(base.getTime() + shot.offsetMin * 60_000);
    return {
      name: shot.name,
      mimeType: 'image/jpeg',
      buffer: withExifDate(Buffer.from(encoded[i], 'base64'), taken),
    };
  });
}

test('four phone photos become two grouped notes', async ({ page, request }) => {
  // The first photo pays for a one-off ~7MB OCR engine download, then four OCR passes.
  test.setTimeout(180_000);

  const notebook = await apiCreateNotebook(request, uniqueName('E2E Bulk Photos'));
  await page.goto(`/notebook/${notebook.id}`);

  const photos = await makePhotos(page);

  await page.getByRole('main').getByRole('button', { name: /import/i }).first().click();
  const dialog = page.getByRole('dialog', { name: /^import$/i });
  const photoItem = page.getByRole('menuitem', { name: /photo/i });
  await expect(photoItem.or(dialog).first()).toBeVisible({ timeout: 10_000 });
  if (await photoItem.isVisible().catch(() => false)) await photoItem.first().click();
  await expect(dialog).toBeVisible({ timeout: 10_000 });

  const photoTab = dialog.getByRole('tab', { name: /photo/i });
  if (await photoTab.count()) await photoTab.first().click();

  await dialog.locator('input[type="file"]').first().setInputFiles(photos);

  // Four photos picked: the modal must offer the bulk path, not the old one-note chain.
  await expect(dialog.getByRole('button', { name: /import 4 photos/i })).toBeVisible({ timeout: 10_000 });
  await dialog.getByRole('button', { name: /import 4 photos/i }).click();

  // --- the review screen -----------------------------------------------------------------
  // "4 photos -> 2 notes" is the headline claim of the whole feature.
  await expect(dialog.getByText(/4 photos\s*→\s*2 notes/i)).toBeVisible({ timeout: 150_000 });

  // Grouped by capture time, and it must SAY so - an unexplained guess is the failure mode.
  await expect(dialog.getByText(/grouped by when they were taken/i)).toBeVisible();
  await expect(dialog.getByText(/gap before/i).first()).toBeVisible();

  // The three-page group gets its title from the OCR text, not the filename. This assertion is
  // what proves OCR actually ran: with the CSP bug the title fell back to "IMG_0411".
  const titles = dialog.locator('.pr-title');
  await expect(titles).toHaveCount(2);
  await expect(titles.first()).toHaveValue(/graph traversal/i);

  const groups = dialog.locator('.pr-group');
  await expect(groups.nth(0).getByText(/^3 pages$/)).toBeVisible();
  await expect(groups.nth(1).getByText(/^1 page$/)).toBeVisible();

  await dialog.getByRole('button', { name: /create 2 notes/i }).click();

  // --- what actually landed --------------------------------------------------------------
  await expect(page.getByText(/created 2 notes/i)).toBeVisible({ timeout: 90_000 });

  const res = await request.get(`/api/notes?notebookId=${notebook.id}`);
  expect(res.ok()).toBeTruthy();
  const { notes } = await res.json();
  expect(notes).toHaveLength(2);

  const graph = notes.find((n: { title: string }) => /graph traversal/i.test(n.title));
  expect(graph, 'the three-page handout should be one note titled from its first page').toBeTruthy();

  // All three pages are inside that ONE note: three images, and text from page 3 present.
  const full = await (await request.get(`/api/notes/${graph.id}`)).json();
  const json = JSON.stringify(full.note.contentJson);
  expect((json.match(/"image"/g) ?? []).length, 'all three photos should be pages of this note').toBe(3);
  expect(full.note.contentText.toLowerCase()).toContain('shortest path');
});

/**
 * The case capture-time clustering cannot see.
 *
 * All four photos are shot within seconds of each other, so the free grouper correctly reads them
 * as one document - but two are chemistry and two are graph theory. This is the entire reason the
 * AI pass exists, and it costs ONE model call for the whole batch because it sorts the extracted
 * text rather than the images.
 */
test('AI grouping splits a single burst that covers two subjects', async ({ page, request }) => {
  test.setTimeout(180_000);

  const notebook = await apiCreateNotebook(request, uniqueName('E2E AI Grouping'));
  await page.goto(`/notebook/${notebook.id}`);

  const base = new Date(2026, 2, 14, 9, 0, 0);
  const burst = [
    { name: 'IMG_0701.jpg', lines: ['Titration method', 'burette and conical flask'] },
    { name: 'IMG_0702.jpg', lines: ['endpoint colour change', 'phenolphthalein indicator'] },
    { name: 'IMG_0703.jpg', lines: ['Dijkstra algorithm', 'priority queue relaxation'] },
    { name: 'IMG_0704.jpg', lines: ['adjacency list', 'edge weights non negative'] },
  ];
  const encoded = await page.evaluate((shots) => shots.map((s) => {
    const c = document.createElement('canvas');
    c.width = 1000; c.height = 700;
    const x = c.getContext('2d')!;
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, c.width, c.height);
    x.fillStyle = '#000000'; x.font = '58px Georgia';
    s.lines.forEach((line, i) => x.fillText(line, 50, 140 + i * 110));
    return c.toDataURL('image/jpeg', 0.92).split(',')[1];
  }), burst.map((s) => ({ lines: s.lines })));

  // Twenty seconds apart: unmistakably one sitting, so time alone gives exactly one group.
  const photos = burst.map((shot, i) => ({
    name: shot.name,
    mimeType: 'image/jpeg',
    buffer: withExifDate(Buffer.from(encoded[i], 'base64'), new Date(base.getTime() + i * 20_000)),
  }));

  await page.getByRole('main').getByRole('button', { name: /import/i }).first().click();
  const dialog = page.getByRole('dialog', { name: /^import$/i });
  const photoItem = page.getByRole('menuitem', { name: /photo/i });
  await expect(photoItem.or(dialog).first()).toBeVisible({ timeout: 10_000 });
  if (await photoItem.isVisible().catch(() => false)) await photoItem.first().click();
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  const photoTab = dialog.getByRole('tab', { name: /photo/i });
  if (await photoTab.count()) await photoTab.first().click();

  await dialog.locator('input[type="file"]').first().setInputFiles(photos);
  await dialog.getByRole('button', { name: /import 4 photos/i }).click();

  // Time-based grouping sees one document, which is the honest reading of the timestamps.
  await expect(dialog.getByText(/4 photos\s*→\s*1 note/i)).toBeVisible({ timeout: 150_000 });

  await dialog.getByRole('button', { name: /with ai/i }).click();

  // The AI reads the text and splits by subject. Asserting "more than one" rather than exactly
  // two keeps this about the behaviour under test instead of the model's exact partition.
  await expect(dialog.getByText(/grouped with ai/i)).toBeVisible({ timeout: 90_000 });
  await expect(dialog.locator('.pr-group')).not.toHaveCount(1, { timeout: 15_000 });
  await expect(dialog.getByRole('button', { name: /create \d+ notes/i })).toBeVisible();
});
