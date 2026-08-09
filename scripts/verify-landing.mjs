// Assertions for the PUBLIC marketing pages - "/" and "/download".
//
// "/" is aimed at the failure mode that page keeps hitting: an element whose default state
// is invisible and which only becomes visible if an animation runs. A screenshot count
// proves nothing about that; these checks do.
//
// "/download" gets its own pass rather than being folded into the loop above, because four
// of the six landing checks are about the product replica and the pencil sketch and simply
// do not exist there. Only overflow and console errors transfer. Running the landing checks
// against /download would not be a stricter test, it would be a broken one - so the two
// pages are checked for the things each actually has, and /download is additionally checked
// for the only thing it exists to do: hand over three working download links.
//
//   node scripts/verify-landing.mjs [--base http://localhost:5199]
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = argOf('--base', 'http://localhost:5199');

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const browser = await chromium.launch();

for (const vp of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
]) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  // A 401 from /api/auth/me is the expected answer when no API server is running behind
  // the dev server; it is the signed-out path, not a fault.
  const ignorable = (t) => /401|Unauthorized|\/api\/auth\/me/.test(t);
  page.on('console', (m) => m.type() === 'error' && !ignorable(m.text()) && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => !ignorable(String(e)) && consoleErrors.push(String(e)));

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.locator('h1').first().waitFor({ state: 'visible', timeout: 20_000 });

  // The product replica must occupy real space and be opaque. It previously carried an
  // entrance animation that left it at opacity 0 whenever the timeline did not complete.
  const frame = page.locator('.mkt-shot__frame');
  const box = await frame.boundingBox();
  const opacity = await page
    .locator('.mkt-shot')
    .evaluate((el) => getComputedStyle(el).opacity);
  check(
    `${vp.name}: product shot is rendered and opaque`,
    !!box && box.height > 200 && opacity === '1',
    `h=${box?.height ?? 0} opacity=${opacity}`,
  );

  // The typed line must contain its full text regardless of whether the typing ran.
  const typed = (await page.locator('.mkt-shot__typed').innerText()).trim();
  check(
    `${vp.name}: typed line has its full text`,
    typed.endsWith('using a queue.'),
    JSON.stringify(typed.slice(0, 40) + '…'),
  );

  // The selection toolbar is the payoff; it must persist, not animate away.
  await page.waitForTimeout(4200);
  check(
    `${vp.name}: "Make flashcard" toolbar is still visible after the sequence`,
    await page.locator('.mkt-shot__toolbar').isVisible(),
  );

  // The pencil sketch must be drawn even if the observer never fires. Measured via
  // computed style, NOT getBoundingClientRect: the wipe is a <rect> inside a <clipPath>,
  // which is never itself rendered, so its bounding box is always zero and would report a
  // false failure.
  await page.locator('.mkt-viz--canvas').scrollIntoViewIfNeeded();
  await page.waitForTimeout(2600);
  const wipeWidth = await page
    .locator('.mkt-sketch__wipe')
    .evaluate((el) => parseFloat(getComputedStyle(el).width) || 0);
  check(`${vp.name}: pencil sketch is drawn`, wipeWidth > 100, `wipe width=${Math.round(wipeWidth)}`);

  // No horizontal overflow: the page body must never scroll sideways.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check(`${vp.name}: no horizontal overflow`, overflow <= 1, `${overflow}px`);

  check(`${vp.name}: no console errors`, consoleErrors.length === 0, consoleErrors[0] ?? '');

  await ctx.close();
}

// ---------------------------------------------------------------------------------------
// /download
//
// The asset names are written out literally rather than imported from the page. That is
// deliberate: importing them would make this script agree with the component by
// construction and assert nothing. These strings are pinned to electron-builder.yml's
// artifactName, and if a rename ever breaks that link, this is where it should surface.
const RELEASES = 'https://github.com/011-sam-110/Folio/releases/latest/download';
const EXPECTED_ASSETS = ['Unote-Setup.exe', 'Unote-arm64.dmg', 'Unote-x64.dmg'];

for (const vp of [
  { name: 'download desktop', width: 1440, height: 900 },
  { name: 'download phone', width: 390, height: 844 },
]) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  const ignorable = (t) => /401|Unauthorized|\/api\/auth\/me/.test(t);
  page.on('console', (m) => m.type() === 'error' && !ignorable(m.text()) && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => !ignorable(String(e)) && consoleErrors.push(String(e)));

  await page.goto(`${BASE}/download`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.locator('h1').first().waitFor({ state: 'visible', timeout: 20_000 });

  // Every platform's link must be present at every viewport. Detection picks which button
  // leads, never which ones exist - a visitor on Linux, or on a Mac reading about the
  // Windows build for someone else, must still be able to reach all three.
  const hrefs = await page.locator('a[href^="https://github.com/011-sam-110/Folio/releases"]').evaluateAll(
    (els) => els.map((el) => el.getAttribute('href')),
  );
  for (const asset of EXPECTED_ASSETS) {
    check(`${vp.name}: links to ${asset}`, hrefs.includes(`${RELEASES}/${asset}`));
  }

  // The unsigned-build warnings are load-bearing, not a disclaimer. A student who meets an
  // unexplained "Windows protected your PC" concludes the download is malware and leaves,
  // and on macOS the app will not open at all without the instruction. If these ever stop
  // rendering, the download silently stops working for a large share of people.
  const body = await page.locator('main, body').first().innerText();
  check(`${vp.name}: warns about SmartScreen before the click`, /smartscreen|unrecognised app|more info/i.test(body));
  check(`${vp.name}: gives the macOS unsigned instruction`, /privacy & security|open anyway|xattr/i.test(body));

  // The honesty check. Offline is NOT a desktop-only feature - the service worker means the
  // web app has it too - and the page must not have quietly drifted into claiming it is.
  const offlineClaim = /offline[^.]{0,60}only[^.]{0,40}desktop|desktop[^.]{0,40}only[^.]{0,30}offline/i.test(body);
  check(`${vp.name}: does not sell offline as desktop-only`, !offlineClaim);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check(`${vp.name}: no horizontal overflow`, overflow <= 1, `${overflow}px`);

  check(`${vp.name}: no console errors`, consoleErrors.length === 0, consoleErrors[0] ?? '');

  await ctx.close();
}

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
