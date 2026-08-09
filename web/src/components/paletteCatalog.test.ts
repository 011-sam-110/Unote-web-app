import { describe, expect, it } from 'vitest';
import { PALETTE_CATALOG, paletteDoc } from './paletteCatalog';
import { guestBlockedMessage } from '../features/guest/guestApi';

describe('paletteCatalog', () => {
  it('documents all eleven context commands', () => {
    // The one count assertion worth keeping: it guards a ONE-TIME extraction. Eleven
    // commands are being lifted out of CommandPalette.tsx and a dropped one would be
    // silent. If a twelfth command is added later, update this number with it.
    expect(PALETTE_CATALOG).toHaveLength(11);
  });

  it('has no duplicate ids', () => {
    const ids = PALETTE_CATALOG.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every command a title, a hint and a section', () => {
    for (const c of PALETTE_CATALOG) {
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.hint.length).toBeGreaterThan(0);
      expect(c.section.length).toBeGreaterThan(0);
    }
  });

  it('names a real BLOCKED key wherever it claims a command needs an account', () => {
    // guestBlockedMessage falls back to a generic sentence for an unknown method, so a
    // typo would silently produce vague copy. Compare against the specific message.
    const generic = guestBlockedMessage('__definitely_not_a_method__');
    for (const c of PALETTE_CATALOG) {
      if (!c.needs) continue;
      expect(guestBlockedMessage(c.needs), `${c.id} -> ${c.needs}`).not.toBe(generic);
    }
  });

  it('throws on an unknown id rather than returning undefined', () => {
    expect(() => paletteDoc('nope')).toThrow(/nope/);
  });
});
