import { describe, expect, it } from 'vitest';
import { isStale, presentationFor, relativeAge, STALE_AFTER_DAYS, VERDICTS } from './verdicts';
import type { VerdictState } from './types';

const STATES: VerdictState[] = ['verified', 'unconfirmed', 'refuted', 'unreachable'];

describe('the four states', () => {
  it('gives each state a glyph of its own SHAPE', () => {
    // Not a decorative choice. `verified` and `refuted` differ on the red-green axis - the
    // most common colour vision deficiency - on the two states that matter most, so the
    // glyph has to carry the state on its own. Four states, four distinct glyphs.
    const glyphs = STATES.map((s) => VERDICTS[s].glyph);
    expect(new Set(glyphs).size).toBe(4);
    expect(glyphs).toEqual(['tick', 'question', 'exclamation', 'dash']);
  });

  it('gives each state its own label and announcement', () => {
    expect(new Set(STATES.map((s) => VERDICTS[s].label)).size).toBe(4);
    expect(new Set(STATES.map((s) => VERDICTS[s].announce)).size).toBe(4);
  });

  it('says in as many words that `unconfirmed` is NOT a problem', () => {
    // The most common state by far - most student sources carry no DOI or ISBN. If it
    // reads as a defect a student learns to ignore every badge on the page.
    const p = VERDICTS.unconfirmed;
    expect(p.meaning).toMatch(/normal/i);
    expect(p.meaning).toMatch(/not a problem/i);
    expect(p.announce).toMatch(/normal/i);
    expect(p.label).toBe('Unconfirmed');
    // "Unverified" would describe a source that FAILED something. Nothing here has failed.
    expect(p.label).not.toMatch(/unverified/i);
  });

  it('says `unreachable` claims nothing about the source', () => {
    expect(VERDICTS.unreachable.meaning).toMatch(/says nothing about the source/i);
    // It must never read as an accusation. Only `refuted` accuses.
    expect(VERDICTS.unreachable.meaning).not.toMatch(/fake|invented|wrong/i);
  });

  it('lets only `refuted` accuse', () => {
    expect(VERDICTS.refuted.meaning).toMatch(/contradicts/i);
    for (const s of ['verified', 'unconfirmed', 'unreachable'] as VerdictState[]) {
      expect(VERDICTS[s].meaning).not.toMatch(/contradicts/i);
    }
  });

  it('treats an unrecognised state as unconfirmed, never as refuted', () => {
    // A server that grows a fifth state must not have it render as an accusation here.
    expect(presentationFor('something-new').label).toBe('Unconfirmed');
    expect(presentationFor('').glyph).toBe('question');
  });
});

describe('relativeAge', () => {
  const now = new Date('2026-08-12T12:00:00.000Z');
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

  it('says nothing was ever checked rather than showing a fresh-looking blank', () => {
    expect(relativeAge('', now)).toBeNull();
    expect(relativeAge('not a date', now)).toBeNull();
  });

  it('reads the age at each scale', () => {
    expect(relativeAge(ago(30_000), now)).toBe('just now');
    expect(relativeAge(ago(5 * 60_000), now)).toBe('5 min ago');
    expect(relativeAge(ago(60 * 60_000), now)).toBe('1 hour ago');
    expect(relativeAge(ago(5 * 3600_000), now)).toBe('5 hours ago');
    expect(relativeAge(ago(24 * 3600_000), now)).toBe('1 day ago');
    expect(relativeAge(ago(10 * 24 * 3600_000), now)).toBe('10 days ago');
    expect(relativeAge(ago(60 * 24 * 3600_000), now)).toBe('2 months ago');
    expect(relativeAge(ago(400 * 24 * 3600_000), now)).toBe('1 year ago');
  });

  it('never claims a check happens in the future when a clock is skewed', () => {
    expect(relativeAge(new Date(now.getTime() + 3 * 3600_000).toISOString(), now)).toBe('just now');
  });
});

describe('isStale', () => {
  const now = new Date('2026-08-12T12:00:00.000Z');
  const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 3600_000).toISOString();

  it('is false for a recent check', () => {
    expect(isStale(daysAgo(3), now)).toBe(false);
    expect(isStale(daysAgo(STALE_AFTER_DAYS - 1), now)).toBe(false);
  });

  it('is true past the threshold, so an old verdict reads as old', () => {
    // A tick from eight months ago and a tick from this morning are not the same claim -
    // the DOI could have been retracted since.
    expect(isStale(daysAgo(STALE_AFTER_DAYS + 1), now)).toBe(true);
  });

  it('is false when nothing was ever checked - that is "never", not "old"', () => {
    expect(isStale('', now)).toBe(false);
  });
});
