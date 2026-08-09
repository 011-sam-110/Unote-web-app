/**
 * What "/" renders inside the Electron shell.
 *
 * desktop/main.ts loads the live site, so the desktop app and the website are the same
 * SPA served to two different hosts. Left alone, RootRoute gives the marketing page to
 * anyone without a session - which means the desktop app opens onto its own advert,
 * pitching the product to someone who has already installed it. The fix is one condition
 * in RootRoute keyed on `window.unoteDesktop`, the flag desktop/preload.ts puts on the
 * page over contextBridge.
 *
 * These specs run in an ordinary browser and inject that flag themselves, because
 * Playwright here drives Chromium and not the packaged app. That is a fair test of the
 * CONDITION, which is all this change is. It is NOT a test of the shell: whether a real
 * installer boots into this screen is still a manual check on a build.
 *
 * The negative assertions are the load-bearing half. A spec that only looked for the
 * login form would pass just as happily if the form and the hero both rendered, and
 * "the advert is gone" is the entire point.
 */
import { expect, test } from './auth.fixture';

/**
 * Everyone here arrives as a stranger. The change is about what a SIGNED-OUT visitor
 * gets at "/", and a session routes straight past that branch into the dashboard.
 *
 * Clearing storageState this way also means the worker account is never created - the
 * fixture's override is replaced by this option, so nothing signs up on our behalf.
 */
test.use({ storageState: { cookies: [], origins: [] } });

/**
 * Exactly what desktop/preload.ts exposes, field for field.
 *
 * Written out here rather than imported: e2e sits outside web/src so the ambient type in
 * web/src/vite-env.d.ts is not in scope, and importing the preload would pull electron
 * into the test process for the sake of three values.
 */
const DESKTOP_BRIDGE = { isDesktop: true, version: '0.0.0', platform: 'win32' } as const;

/**
 * The marketing hero, and the thing that must NOT be on screen in the desktop app.
 *
 * Asserted on `.mkt-hero` and deliberately not on `.mkt`: AuthShell wraps the login
 * screen in `.mkt` too, for the paper-and-ink palette, so `.mkt` proves nothing either
 * way.
 */
const HERO = '.mkt-hero';

/**
 * Puts the bridge on the window BEFORE the app boots.
 *
 * addInitScript is the only way to win that race. The flag is read during RootRoute's
 * first render, so anything evaluated after page.goto arrives too late - the hero would
 * already be on screen and the spec would be testing a re-render rather than the boot.
 */
async function asDesktopShell(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript((bridge) => {
    // defineProperty rather than a plain assignment, because that is closer to what
    // contextBridge actually leaves behind: a data property the page can read and
    // nothing more.
    Object.defineProperty(window, 'unoteDesktop', { value: bridge, configurable: true });
  }, DESKTOP_BRIDGE);
}

test.describe('The desktop shell at "/"', () => {
  test('a signed-out desktop visitor gets the login form and no marketing page at all', async ({ page }) => {
    await asDesktopShell(page);
    await page.goto('/');

    // Read the flag back before asserting anything about the UI. Without this, an
    // injection that silently missed would fail below as "the app ignored the flag"
    // when the truth is that there was never a flag to ignore.
    expect(await page.evaluate(() => Reflect.get(window, 'unoteDesktop')?.isDesktop)).toBe(true);

    // AuthProvider withholds render entirely until the first /me settles, so the wait is
    // on the heading turning up rather than on a timer - same as every other spec here.
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();

    // Rendered in place, not redirected. Worth pinning: a <Navigate to="/login"> would
    // look identical to a spec that only checked the form, and it is not the same thing
    // - the desktop app's home would then be an auth URL rather than "/".
    expect(new URL(page.url()).pathname).toBe('/');

    await expect(page.locator(HERO)).toHaveCount(0);
  });

  test('a signed-out browser visitor still gets the marketing page', async ({ page }) => {
    // No injection, and that is the whole test. This is the regression guard that
    // matters most: the change is additive to the desktop app and must be completely
    // invisible to the website.
    await page.goto('/');

    await expect(page.locator(HERO)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('heading', { level: 1, name: /comes together/i })).toBeVisible();

    // The other half of the same claim: the browser must not get the login form at "/".
    // A condition wired up backwards would still show a hero somewhere on a page that
    // had also rendered the form, so absence is asserted here too.
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe('/');
  });

  test('the guest door is still reachable from the desktop login screen', async ({ page }) => {
    await asDesktopShell(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible({ timeout: 10_000 });

    // Kept deliberately. Without it a first-run desktop user with no account opens the
    // app onto a form and has nowhere to go but away, and the web landing's whole
    // argument is that you should be able to type before you register. Someone
    // installing the app has committed more, not less.
    const guestDoor = page.getByRole('link', { name: /try it first without an account/i });
    await expect(guestDoor).toHaveAttribute('href', '/try');
    await guestDoor.click();

    // /try starts the guest session and seeds a note before redirecting into it - the
    // same door guest.spec.ts drives from the landing page, reached from a screen that
    // page no longer shows.
    await expect(page).toHaveURL(/\/note\//, { timeout: 15_000 });
    await expect(page.getByTestId('guest-banner')).toContainText('Nothing here is saved');
  });
});
