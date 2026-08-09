import { describe, expect, it } from 'vitest';
import { SHORTCUT_COUNT, shortcutGroups } from './shortcutData';
import { guestBlockedMessage } from '../guest/guestApi';

describe('shortcutData', () => {
  it('has five groups', () => {
    expect(shortcutGroups('Ctrl', 'Shift').map((g) => g.name)).toEqual([
      'Anywhere', 'Writing', 'On a note', 'Search page', 'Reviewing flashcards',
    ]);
  });

  it('SHORTCUT_COUNT is derived from the rows, not typed by hand', () => {
    // The README prints this number, so it must track the data. No literal expectation:
    // adding a binding is one edit, and asserting 25 here would make it two.
    const rows = shortcutGroups('Ctrl', 'Shift').reduce((n, g) => n + g.rows.length, 0);
    expect(SHORTCUT_COUNT).toBe(rows);
    expect(SHORTCUT_COUNT).toBeGreaterThan(0);
  });

  it('substitutes the platform modifier into the keys', () => {
    const anywhere = shortcutGroups('⌘', '⇧')[0];
    expect(anywhere.rows[0].keys).toEqual(['⌘', 'K']);
    expect(anywhere.rows[3].keys).toEqual(['⌘', '⇧', 'F']);
  });

  it('names a real BLOCKED key wherever a binding claims it needs an account', () => {
    // guestBlockedMessage falls back to a generic sentence for an unknown method, so a
    // typo in `needs` would silently un-gate a binding the guest README must mark.
    const generic = guestBlockedMessage('__definitely_not_a_method__');
    for (const g of shortcutGroups('Ctrl', 'Shift')) {
      for (const r of g.rows) {
        if (!r.needs) continue;
        expect(guestBlockedMessage(r.needs), `${r.label} -> ${r.needs}`).not.toBe(generic);
      }
    }
  });

  it('never emits an empty label', () => {
    for (const g of shortcutGroups('Ctrl', 'Shift')) {
      for (const r of g.rows) expect(r.label.length).toBeGreaterThan(0);
    }
  });

  it('matches the recorded bindings exactly', () => {
    // The count test above only proves SHORTCUT_COUNT is derived - if a row were
    // dropped, both sides of it would shrink together and it would still pass. This
    // snapshot is what actually catches a row going missing, being reordered, or
    // being silently relabelled. Adding a binding is still one edit plus `-u`.
    expect(shortcutGroups('Ctrl', 'Shift')).toMatchSnapshot();
  });
});
