import { describe, expect, it } from 'vitest';
import { FEATURE_SECTIONS } from './featureCatalog';
import { guestBlockedMessage } from '../guest/guestApi';

describe('featureCatalog', () => {
  it('covers sections 05 through 09', () => {
    expect(FEATURE_SECTIONS.map((s) => s.number)).toEqual(['05', '06', '07', '08', '09']);
  });

  it('gives every section a title, a blurb and at least one line', () => {
    for (const s of FEATURE_SECTIONS) {
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.blurb.length).toBeGreaterThan(0);
      expect(s.lines.length).toBeGreaterThan(0);
    }
  });

  it('names a real BLOCKED key on every gated line', () => {
    const generic = guestBlockedMessage('__definitely_not_a_method__');
    for (const s of FEATURE_SECTIONS) {
      for (const l of s.lines) {
        if (!l.needs) continue;
        expect(guestBlockedMessage(l.needs), `${s.title}: ${l.what}`).not.toBe(generic);
      }
    }
  });
});
