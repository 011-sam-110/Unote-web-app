import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearData, latestNoteId, readData, seedGuestWorkspace } from './guestStore';

describe('seedGuestWorkspace', () => {
  beforeEach(() => clearData());

  it('creates one notebook and two notes', () => {
    seedGuestWorkspace();
    const data = readData();
    expect(data.notebooks).toHaveLength(1);
    expect(data.notes).toHaveLength(2);
  });

  it('writes the README first, pinned and tagged', () => {
    const { readme } = seedGuestWorkspace();
    const stored = readData().notes[0];
    expect(stored.id).toBe(readme.id);
    expect(stored.title).toBe('README');
    expect(stored.pinned).toBe(true);
    expect(stored.tags).toEqual(['unote', 'guide']);
  });

  it('returns the stored (pinned, re-stamped) README row, not a hand-forged copy', () => {
    // updateNote() re-stamps updatedAt on pin, so a forged `{ ...readme, pinned: true }`
    // (built from the PRE-pin row) would disagree with storage on updatedAt even though
    // `.pinned` matched. Comparing the whole row catches that; comparing only `.pinned`
    // would not - but ONLY when the pin's nowIso() call actually lands in a later
    // millisecond than the create's, which the real clock does just ~22/40 of the time
    // (see task-7-report.md). Freezing the clock (as the tie-break test below does,
    // deliberately, for the opposite reason) would make every nowIso() call return the
    // SAME instant, which would pass even on a build that forges the copy - so instead
    // this stubs `Date` to hand out a strictly increasing millisecond on every `new
    // Date()`, guaranteeing the pin (the third call: notebook, then the readme's create,
    // then the pin) always lands after the create it's compared against.
    let tick = 0;
    const base = Date.now();
    class TickingDate extends Date {
      constructor() {
        super(base + tick++);
      }
    }
    vi.stubGlobal('Date', TickingDate);
    try {
      const { readme } = seedGuestWorkspace();
      const stored = readData().notes.find((n) => n.id === readme.id);
      expect(readme).toEqual(stored);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('leaves a blank note to type into, and latestNoteId() lands a return visitor on it', () => {
    // This is the property that actually matters - which note /try reopens - not the
    // array position the note happens to occupy in storage. An array-position assertion
    // here would stay green even if the pin were reordered to run AFTER the blank note
    // was created, which would invert the behaviour (a returning guest lands back on the
    // README) while still passing. latestNoteId() is what TryRoute and startGuest() call,
    // so asserting through it is what would actually catch that.
    //
    // This also doubles as the regression test for the tie-break bug: nowIso() is
    // millisecond-resolution, and seedGuestWorkspace's pin-then-create-blank-note writes
    // routinely land in the same millisecond, so this only reliably passes with
    // `latestNoteId()`'s `>=` tie-break (see that function's own comment). Left on the
    // real clock this depended on the pin and the blank note landing in the same
    // millisecond by chance - which only happened ~48% of the time, so a revert of `>=`
    // to `>` only failed here about half the time. A frozen fake clock forces every
    // nowIso() call in this test to return the exact same instant, so the tie fires
    // every run. See the deliberate-break proof in task-7-report.md for the measured
    // failure rate under `>`, on both the real clock and this frozen one.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      const { note } = seedGuestWorkspace();
      expect(latestNoteId()).toBe(note.id);
      expect(readData().notes.find((n) => n.id === note.id)?.title).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('seeds the guest build of the README, not the account build', () => {
    seedGuestWorkspace();
    expect(readData().notes[0].contentText).toContain('needs an account');
  });

  it('gives the README searchable body text', () => {
    seedGuestWorkspace();
    expect(readData().notes[0].contentText.length).toBeGreaterThan(500);
  });
});
