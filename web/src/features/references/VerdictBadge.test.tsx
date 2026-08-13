// Rendered, not just described.
//
// renderToStaticMarkup rather than a testing library: the repo carries no DOM testing
// library, and what needs proving here is a property of the OUTPUT - that each state emits
// a different glyph and names itself to a screen reader - which static markup answers
// directly and without a mounting harness.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import VerdictBadge from './VerdictBadge';
import { VERDICTS } from './verdicts';
import type { VerdictState } from './types';

const STATES: VerdictState[] = ['verified', 'unconfirmed', 'refuted', 'unreachable'];

function render(state: string): string {
  return renderToStaticMarkup(<VerdictBadge state={state} />);
}

describe('VerdictBadge', () => {
  it('renders a DIFFERENT glyph for each of the four states', () => {
    const glyphs = STATES.map((s) => /data-glyph="([a-z]+)"/.exec(render(s))?.[1]);
    expect(glyphs).toEqual(['tick', 'question', 'exclamation', 'dash']);
    expect(new Set(glyphs).size).toBe(4);
  });

  it('draws a different SVG path per state, so the shapes really do differ', () => {
    // Guards against all four resolving to the same drawing while still carrying four
    // different data-glyph attributes - which would pass the test above and fail a reader.
    const drawings = STATES.map((s) => {
      // React renders SVG children as `<path d="…"></path>`, so the geometry is read off
      // the `d` / `points` attributes rather than off a self-closing tag.
      const html = render(s);
      return (html.match(/(?:\bd|points)="[^"]+"/g) ?? []).join('|');
    });
    expect(new Set(drawings).size).toBe(4);
    for (const d of drawings) expect(d.length).toBeGreaterThan(0);
  });

  it('names itself to a screen reader instead of relying on the glyph', () => {
    for (const s of STATES) {
      expect(render(s)).toContain(`aria-label="${VERDICTS[s].announce.replace(/"/g, '&quot;')}"`);
    }
  });

  it('hides the decorative glyph and the duplicate label from assistive tech', () => {
    const html = render('verified');
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-hidden="true"');
  });

  it('carries the state as a data attribute, which is what the stylesheet hangs hue on', () => {
    for (const s of STATES) expect(render(s)).toContain(`data-state="${s}"`);
  });

  it('never emits a colour literal - hue comes from the themed tokens', () => {
    // A hex at the use site is how the syntax palette ended up served light-theme-only in
    // dark mode, measuring 2.88:1. Every colour lives in tokens.css, in both themes.
    for (const s of STATES) {
      expect(render(s)).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(render(s)).not.toMatch(/rgb\(/i);
    }
  });

  it('falls back to the unconfirmed glyph for a state it does not know', () => {
    expect(render('something-new')).toContain('data-glyph="question"');
  });

  it('renders the small size for the list', () => {
    expect(renderToStaticMarkup(<VerdictBadge state="verified" size="sm" />)).toContain('data-size="sm"');
  });
});
