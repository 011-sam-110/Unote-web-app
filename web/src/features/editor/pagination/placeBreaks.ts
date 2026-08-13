// Where the page breaks go.
//
// Deliberately pure: it takes a list of block heights and a page geometry, and returns
// where the breaks land. No DOM, no ProseMirror, no React. Everything hard about
// pagination that is not "measuring things" lives here, which is what makes the edge
// cases - an exact fit, a block taller than the paper, a document that is one enormous
// table - testable without a browser.
//
// The measuring half lives in usePagination.ts. Keeping the two apart is the whole reason
// this file can be trusted.

export interface PlaceBreaksInput {
  /** Height of each top-level block, in document order, in px. */
  blocks: number[];
  /** Usable text height on one sheet, in px. Must be > 0. */
  contentHeightPx: number;
  /**
   * Dead vertical space in the document flow between the bottom of one sheet's text box
   * and the top of the next one's: bottom margin + footer band + the gap between sheets +
   * header band + top margin. Collapsed to a single number because the break arithmetic
   * does not care how it is divided up.
   */
  interPageSkipPx: number;
}

export interface PagePlan {
  /** How much of this sheet's text box is used. Never exceeds contentHeightPx. */
  usedPx: number;
  /**
   * How far a single oversized block hangs past the bottom of the text box. Zero for
   * every normal page. The sheet behind an overflowing page is drawn this much taller,
   * so the paper still contains its content instead of the text spilling onto the desk.
   */
  overflowPx: number;
  /** Indices into `blocks` that sit on this page. */
  blockIndices: number[];
}

export interface BreakPlan {
  /** spacers[i] is px of filler to insert immediately BEFORE block i. 0 means no break. */
  spacers: number[];
  /** pageOfBlock[i] is the zero-based page index block i sits on. */
  pageOfBlock: number[];
  pages: PagePlan[];
}

/**
 * A block is "oversized" when it cannot fit a sheet on its own. Pushing one to the next
 * page is pointless - it will not fit there either - so it is allowed to overflow, and the
 * page it is on is marked so the UI can say so rather than clipping it in silence.
 *
 * The tolerance matters. Sub-pixel layout means a block that exactly fills the text box
 * frequently measures a hundredth of a pixel over it, and without slack that block would
 * be declared oversized and every full page would grow a spurious overflow.
 */
const FIT_TOLERANCE_PX = 0.5;

export function placeBreaks(input: PlaceBreaksInput): BreakPlan {
  const { blocks, interPageSkipPx } = input;
  const contentHeightPx = Math.max(1, input.contentHeightPx);

  const spacers: number[] = new Array(blocks.length).fill(0);
  const pageOfBlock: number[] = new Array(blocks.length).fill(0);
  const pages: PagePlan[] = [{ usedPx: 0, overflowPx: 0, blockIndices: [] }];

  let page = 0;
  let used = 0;

  /** Close the current page and open the next, filling the remainder of the old one. */
  const breakTo = (blockIndex: number) => {
    const remainder = Math.max(0, contentHeightPx - used);
    spacers[blockIndex] = remainder + interPageSkipPx;
    page += 1;
    used = 0;
    pages.push({ usedPx: 0, overflowPx: 0, blockIndices: [] });
  };

  for (let i = 0; i < blocks.length; i++) {
    const height = Math.max(0, blocks[i]);
    const oversized = height > contentHeightPx + FIT_TOLERANCE_PX;

    if (oversized) {
      // Give it a fresh sheet unless it is already at the top of one, then let it hang
      // over the bottom. Anything else either loops forever or hides content.
      if (used > 0) breakTo(i);
      pageOfBlock[i] = page;
      pages[page].blockIndices.push(i);
      pages[page].usedPx = contentHeightPx;
      pages[page].overflowPx = height - contentHeightPx;
      // The next block starts on a new sheet: this one is full by definition.
      used = contentHeightPx;
      continue;
    }

    if (used > 0 && used + height > contentHeightPx + FIT_TOLERANCE_PX) breakTo(i);

    pageOfBlock[i] = page;
    pages[page].blockIndices.push(i);
    used += height;
    pages[page].usedPx = Math.min(used, contentHeightPx);
  }

  return { spacers, pageOfBlock, pages };
}

/**
 * Vertical offset of each sheet's top edge, relative to the top of the first sheet.
 *
 * Separate from placeBreaks because the sheet layer needs it and the break arithmetic does
 * not. Overflowing pages are taller, so this cannot be `index * pitch` - getting that wrong
 * puts the paper and the text out of register from the first oversized image onward.
 */
export function sheetOffsets(pages: PagePlan[], pageHeightPx: number, gapPx: number): number[] {
  const tops: number[] = [];
  let y = 0;
  for (const page of pages) {
    tops.push(y);
    y += pageHeightPx + page.overflowPx + gapPx;
  }
  return tops;
}
