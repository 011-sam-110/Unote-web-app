// The bar has to be honest about what it knows.
//
// Two failure modes are worth pinning, because both LOOK fine on screen and both lie:
// an unrecognised step silently landing on 0%, and a determinate aria-valuenow being
// published while the bar is actually sweeping. renderToStaticMarkup answers both off
// the output, matching VerdictBadge.test.tsx rather than adding a mounting harness.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ImportProgress from './ImportProgress';
import type { ImportJob } from '../../lib/types';

function job(over: Partial<ImportJob> = {}): ImportJob {
  return { id: 'j1', status: 'running', ...over };
}

function render(j: ImportJob | null): string {
  return renderToStaticMarkup(<ImportProgress job={j} />);
}

const widthOf = (html: string) => /style="width:([^"]+)"/.exec(html)?.[1]?.trim();
const valueNow = (html: string) => /aria-valuenow="(\d+)"/.exec(html)?.[1];

describe('ImportProgress', () => {
  it('advances the bar as the pipeline advances', () => {
    const widths = ['Extracting text…', 'Improving with AI…', 'Saving note…', 'Saving figures…', 'Done']
      .map((step) => widthOf(render(job({ step }))))
      .map((w) => Number.parseInt(w ?? '', 10));

    expect(widths).toEqual([...widths].sort((a, b) => a - b));
    expect(new Set(widths).size).toBe(5);
    expect(widths.at(-1)).toBe(100);
  });

  it('publishes aria-valuenow only when the step is on the known scale', () => {
    expect(valueNow(render(job({ step: 'Saving note…' })))).toBe('60');
    // A step the pipeline grew since this file was written must read as busy, NOT as 0%.
    const unknown = render(job({ step: 'Transcribing audio…' }));
    expect(valueNow(unknown)).toBeUndefined();
    expect(unknown).toContain('is-active');
  });

  it('falls back to the indeterminate sweep before the first step arrives', () => {
    const queued = render(job({ status: 'queued' }));
    expect(queued).toContain('is-active');
    expect(valueNow(queued)).toBeUndefined();
    expect(render(null)).toContain('Starting…');
  });

  it('names the current phase to a screen reader', () => {
    // The label is the whole point of the component - a bar with no phase name is the
    // state this replaced.
    expect(render(job({ step: 'Improving with AI…' }))).toContain('Improving with AI…');
    expect(render(job({ step: 'Improving with AI…' }))).toContain('Step 2 of 5');
  });
});
