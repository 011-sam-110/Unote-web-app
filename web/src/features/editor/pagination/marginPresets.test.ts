import { describe, expect, it } from 'vitest';
import { MARGIN_PRESETS, marginPresetFor, marginSummary } from './marginPresets';
import { contentBoxMm, defaultLayout, parseLayout, serializeLayout } from './layout';
import { geometryFor } from './geometry';

describe('marginPresetFor', () => {
  it('names the default layout Normal, so an untouched note does not read as Custom', () => {
    expect(marginPresetFor(defaultLayout().margins)?.id).toBe('normal');
  });

  it("recognises each of Word's presets and Minimal", () => {
    expect(marginPresetFor({ top: 12.7, right: 12.7, bottom: 12.7, left: 12.7 })?.id).toBe('narrow');
    expect(marginPresetFor({ top: 25.4, right: 19.05, bottom: 25.4, left: 19.05 })?.id).toBe('moderate');
    expect(marginPresetFor({ top: 25.4, right: 50.8, bottom: 25.4, left: 50.8 })?.id).toBe('wide');
    expect(marginPresetFor({ top: 6.35, right: 6.35, bottom: 6.35, left: 6.35 })?.id).toBe('minimal');
  });

  it('survives the float noise of a JSON round trip', () => {
    expect(marginPresetFor({ top: 25.4, right: 19.049999999, bottom: 25.4000001, left: 19.05 })?.id).toBe('moderate');
  });

  it('is null - Custom - for margins no preset has', () => {
    expect(marginPresetFor({ top: 20, right: 20, bottom: 20, left: 20 })).toBeNull();
    // One side off is enough: Normal with a wider left margin is not Normal.
    expect(marginPresetFor({ top: 25.4, right: 25.4, bottom: 25.4, left: 30 })).toBeNull();
  });

  it('gives every preset a distinct identity', () => {
    for (const preset of MARGIN_PRESETS) expect(marginPresetFor(preset.margins)).toBe(preset);
  });
});

describe('marginSummary', () => {
  it('reads the uniform presets as one figure', () => {
    expect(marginSummary({ top: 12.7, right: 12.7, bottom: 12.7, left: 12.7 })).toBe('12.7 mm all round');
  });

  it('names only the sides for the presets that keep Normal top and bottom', () => {
    expect(marginSummary({ top: 25.4, right: 19.05, bottom: 25.4, left: 19.05 })).toBe('19.05 mm left and right');
  });

  it('spells out all four for anything else', () => {
    expect(marginSummary({ top: 10, right: 20, bottom: 30, left: 40 })).toBe('10 / 20 / 30 / 40 mm');
  });
});

describe('the presets on a page', () => {
  it('every preset survives the store round trip unchanged', () => {
    // parseLayout is what both the local store and the server run a sent layout through.
    for (const preset of MARGIN_PRESETS) {
      const layout = { ...defaultLayout(), margins: { ...preset.margins } };
      expect(parseLayout(serializeLayout(layout)).margins).toEqual(preset.margins);
    }
  });

  it('Minimal gives the text almost the whole width of an A4 sheet', () => {
    const minimal = MARGIN_PRESETS.find(p => p.id === 'minimal')!;
    const layout = { ...defaultLayout(), margins: { ...minimal.margins } };
    // 210 - 2 * 6.35
    expect(contentBoxMm(layout).w).toBeCloseTo(197.3, 5);
    const normal = geometryFor(defaultLayout());
    const wide = geometryFor(layout);
    expect(wide.contentWidthPx).toBeGreaterThan(normal.contentWidthPx);
    expect(wide.pageWidthPx).toBe(normal.pageWidthPx);
  });
});
