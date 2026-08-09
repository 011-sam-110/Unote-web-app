// startGuest() has to be idempotent in what it REPORTS, not just in what it writes.
// TryRoute's effect runs twice under React StrictMode (dev, and every e2e run - see
// playwright.config.ts, which starts the web server with `npm run dev -w web`). Pass one
// seeds and reports `readmeId`; a naive re-check of `hasGuestWork()` on pass two would see
// pass one's own seed already sitting in storage and report `readmeId: null`, overwriting
// TryRoute's target with `latestNoteId()` before the visitor ever saw the README. This pins
// that both calls within one page load agree, and that a genuinely new page load - which
// seeded nothing itself - still reports null for a real returning visitor.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearData, readData } from './guestStore';

const ACTIVE_KEY = 'unote:guest:active';

beforeEach(() => {
  // Every case gets its own module instance, not just the ones that call it explicitly -
  // otherwise a case's outcome depends on whatever order the test runner happens to pick,
  // since `seededReadmeIdThisLoad` is a module-scoped variable that survives a bare
  // `import()` (Vitest only re-evaluates a module graph across `resetModules()`, not
  // between `it` blocks on its own).
  vi.resetModules();
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

  it('re-seeds and reports a fresh, real readmeId after endGuest+startGuest, mid-load (no reload)', async () => {
    // One of the two entry paths the reviewer reproduced this on: /try seeds -> sign up
    // (AuthContext calls endGuest({keepWork:true})) -> migrate or discard (both call
    // clearData()) -> log out (AuthContext.logout is setUser(null), no reload) -> /try
    // again. All inside ONE page load, so a memo that gates seeding on "did I already
    // seed once this load" - rather than on what's actually in storage - could skip
    // re-seeding and keep reporting the id of a note that clearData() just deleted.
    //
    // NOTE: this particular sequence is ALSO covered by endGuest()'s own belt-and-braces
    // memo clear (see that function), so on its own it does not isolate startGuest()'s
    // reordering fix - reverting only the `let readmeId = seededReadmeIdThisLoad` line in
    // startGuest() and leaving endGuest()'s clear in place does NOT fail this case, because
    // endGuest() has already nulled the memo before startGuest() ever re-reads it. The next
    // test, which clears storage WITHOUT going through endGuest(), is the one that isolates
    // and proves the startGuest() fix specifically - see its comment.
    const { startGuest, endGuest } = await import('./guestMode');

    const first = startGuest();
    expect(first.readmeId).not.toBeNull();

    endGuest({ keepWork: false });
    const second = startGuest();

    // Re-seeded: the store has a real notebook + 2 notes again, not the empty shell the
    // bug left behind.
    expect(readData().notes).toHaveLength(2);
    // A fresh id, not the memo replaying the id of a note that no longer exists.
    expect(second.readmeId).not.toBeNull();
    expect(second.readmeId).not.toBe(first.readmeId);
    expect(readData().notes.some((n) => n.id === second.readmeId)).toBe(true);
  });

  it('re-seeds and reports a fresh, real readmeId when storage is cleared directly, mid-load (no reload)', async () => {
    // The OTHER entry path the reviewer reproduced this on: something clears the guest
    // store directly (clearData()) without going through endGuest() at all - e.g. a
    // discard/migrate action that isn't also ending the guest session in the same call.
    // Because this bypasses endGuest()'s memo clear, `seededReadmeIdThisLoad` is still
    // whatever startGuest() set it to on the first call, while storage is empty - the
    // exact diverged state the reordering fix in startGuest() (not endGuest()'s
    // belt-and-braces addition) has to handle on its own. This is the case that actually
    // isolates the fix: reverting only the `let readmeId = seededReadmeIdThisLoad` line
    // fails HERE even with endGuest()'s clear left fully intact.
    const { startGuest } = await import('./guestMode');

    const first = startGuest();
    expect(first.readmeId).not.toBeNull();

    clearData();
    const second = startGuest();

    expect(readData().notes).toHaveLength(2);
    expect(second.readmeId).not.toBeNull();
    expect(second.readmeId).not.toBe(first.readmeId);
    expect(readData().notes.some((n) => n.id === second.readmeId)).toBe(true);
  });
});
