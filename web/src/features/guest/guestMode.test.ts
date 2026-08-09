// startGuest() has to be idempotent in what it REPORTS, not just in what it writes.
// TryRoute's effect runs twice under React StrictMode (dev, and every e2e run - see
// playwright.config.ts, which starts the web server with `npm run dev -w web`). Pass one
// seeds and reports `readmeId`; a naive re-check of `hasGuestWork()` on pass two would see
// pass one's own seed already sitting in storage and report `readmeId: null`, overwriting
// TryRoute's target with `latestNoteId()` before the visitor ever saw the README. This pins
// that both calls within one page load agree, and that a genuinely new page load - which
// seeded nothing itself - still reports null for a real returning visitor.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearData } from './guestStore';

const ACTIVE_KEY = 'unote:guest:active';

beforeEach(() => {
  clearData();
  localStorage.removeItem(ACTIVE_KEY);
});

describe('startGuest', () => {
  it('reports the same non-null readmeId on a repeat call within the same page load', async () => {
    const { startGuest } = await import('./guestMode');
    const first = startGuest();
    const second = startGuest();
    expect(first.readmeId).not.toBeNull();
    expect(second.readmeId).toBe(first.readmeId);
  });

  it('reports readmeId: null for a fresh page load that seeded nothing itself', async () => {
    // Simulate the FIRST page load: nothing seeded yet, so it seeds and reports non-null.
    vi.resetModules();
    const { startGuest: startOnFirstLoad } = await import('./guestMode');
    const firstLoad = startOnFirstLoad();
    expect(firstLoad.readmeId).not.toBeNull();

    // Simulate a SECOND, later page load (a real reload, not a StrictMode re-run): a fresh
    // module instance, so its own `seededReadmeIdThisLoad` starts back at null. The guest
    // work from the first load is still in storage, so this must read as "already here",
    // not "just seeded".
    vi.resetModules();
    const { startGuest: startOnReturnLoad } = await import('./guestMode');
    const returnLoad = startOnReturnLoad();
    expect(returnLoad.readmeId).toBeNull();
  });
});
