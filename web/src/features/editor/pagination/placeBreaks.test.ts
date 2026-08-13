import { describe, expect, it } from 'vitest';
import { placeBreaks, sheetOffsets } from './placeBreaks';

/** 1000px of text box, 200px of chrome between sheets - round numbers so the expected
 *  values below are readable rather than arithmetic puzzles. */
const GEO = { contentHeightPx: 1000, interPageSkipPx: 200 };

describe('placeBreaks', () => {
  it('keeps everything on one page when it fits', () => {
    const plan = placeBreaks({ blocks: [100, 200, 300], ...GEO });
    expect(plan.pages).toHaveLength(1);
    expect(plan.spacers).toEqual([0, 0, 0]);
    expect(plan.pageOfBlock).toEqual([0, 0, 0]);
    expect(plan.pages[0].usedPx).toBe(600);
  });

  it('pushes the whole block that would straddle the boundary', () => {
    // 400 + 400 = 800 fits; the third block would end at 1200, so it moves.
    const plan = placeBreaks({ blocks: [400, 400, 400], ...GEO });
    expect(plan.pageOfBlock).toEqual([0, 0, 1]);
    // 200px of the first sheet was unused, plus the 200px of chrome.
    expect(plan.spacers).toEqual([0, 0, 400]);
    expect(plan.pages).toHaveLength(2);
  });

  it('treats an exact fit as fitting, not as a break', () => {
    const plan = placeBreaks({ blocks: [500, 500], ...GEO });
    expect(plan.pages).toHaveLength(1);
    expect(plan.spacers).toEqual([0, 0]);
  });

  it('tolerates sub-pixel overshoot on an exact fit', () => {
    // Real measurements land here constantly; without tolerance this would break the page
    // and every full sheet in the app would grow a spurious second page.
    const plan = placeBreaks({ blocks: [500.2, 500.2], ...GEO });
    expect(plan.pages).toHaveLength(1);
  });

  it('gives an oversized block its own page and lets it overflow', () => {
    const plan = placeBreaks({ blocks: [100, 2500, 100], ...GEO });

    // It cannot share page 0 with the 100px block above it, so it is pushed.
    expect(plan.pageOfBlock).toEqual([0, 1, 2]);
    expect(plan.pages[1].overflowPx).toBe(1500);
    // The sheet behind it grows; the block after it starts cleanly on the next sheet.
    expect(plan.pages[2].overflowPx).toBe(0);
    expect(plan.pages[2].usedPx).toBe(100);
  });

  it('does not push an oversized block that is already at the top of a page', () => {
    const plan = placeBreaks({ blocks: [2500], ...GEO });
    expect(plan.pages).toHaveLength(1);
    expect(plan.spacers).toEqual([0]);
    expect(plan.pages[0].overflowPx).toBe(1500);
  });

  it('terminates on a run of oversized blocks', () => {
    // The shape that would hang a naive implementation: nothing ever fits, so a loop that
    // retries the same block on a fresh page never advances.
    const plan = placeBreaks({ blocks: [3000, 3000, 3000], ...GEO });
    expect(plan.pages).toHaveLength(3);
    expect(plan.pageOfBlock).toEqual([0, 1, 2]);
    expect(plan.pages.every(p => p.overflowPx === 2000)).toBe(true);
  });

  it('handles an empty document', () => {
    const plan = placeBreaks({ blocks: [], ...GEO });
    expect(plan.pages).toHaveLength(1);
    expect(plan.pages[0].usedPx).toBe(0);
  });

  it('survives a non-positive content height instead of looping', () => {
    // Reachable through a hand-edited layout with margins taller than the paper.
    const plan = placeBreaks({ blocks: [10, 10], contentHeightPx: 0, interPageSkipPx: 0 });
    expect(plan.pages.length).toBeGreaterThan(0);
    expect(plan.pageOfBlock).toHaveLength(2);
  });

  it('records which blocks landed on which page', () => {
    const plan = placeBreaks({ blocks: [600, 600, 600], ...GEO });
    expect(plan.pages.map(p => p.blockIndices)).toEqual([[0], [1], [2]]);
  });
});

describe('sheetOffsets', () => {
  it('stacks sheets at a constant pitch when none overflow', () => {
    const plan = placeBreaks({ blocks: [1000, 1000, 1000], ...GEO });
    expect(sheetOffsets(plan.pages, 1200, 40)).toEqual([0, 1240, 2480]);
  });

  it('accounts for an overflowing sheet being taller', () => {
    const plan = placeBreaks({ blocks: [2500, 100], ...GEO });
    // Sheet 0 is 1200 tall plus 1500 of overflow, then the 40px gap.
    expect(sheetOffsets(plan.pages, 1200, 40)).toEqual([0, 2740]);
  });
});
