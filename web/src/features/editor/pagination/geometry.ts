// Every pixel measurement pagination needs, derived once from a NoteLayout.
//
// Split out from the plugin so the numbers can be checked on their own, and so the sheet
// layer, the print stylesheet and the break placer all read the SAME geometry rather than
// each recomputing it from mm and drifting by a rounding step.

import { mmToPx, type PageDimsMm } from './pageSizes';
import { pageDims, type NoteLayout } from './layout';

/** Height of a header or footer band when it is switched on, in mm. Roughly Word's
 *  half-inch default, which is what a marker's eye expects at the top of a page. */
export const BAND_MM = 12;

/** Space between two sheets on screen. Purely visual - print collapses it to zero,
 *  because there the page break itself is the separation. */
export const SHEET_GAP_PX = 28;

export interface PageGeometry {
  pageWidthPx: number;
  pageHeightPx: number;
  marginTopPx: number;
  marginRightPx: number;
  marginBottomPx: number;
  marginLeftPx: number;
  headerBandPx: number;
  footerBandPx: number;
  /** The text box: what one sheet can actually hold. */
  contentWidthPx: number;
  contentHeightPx: number;
  gapPx: number;
  /**
   * Dead space in the document flow between the bottom of one text box and the top of the
   * next. This is the number placeBreaks needs, and getting it wrong is the difference
   * between text that sits on the paper and text that sits in the gap between two sheets.
   */
  interPageSkipPx: number;
  dimsMm: PageDimsMm;
}

export function geometryFor(layout: NoteLayout, gapPx: number = SHEET_GAP_PX): PageGeometry {
  const dimsMm = pageDims(layout);

  const pageWidthPx = mmToPx(dimsMm.w);
  const pageHeightPx = mmToPx(dimsMm.h);
  const marginTopPx = mmToPx(layout.margins.top);
  const marginRightPx = mmToPx(layout.margins.right);
  const marginBottomPx = mmToPx(layout.margins.bottom);
  const marginLeftPx = mmToPx(layout.margins.left);
  const headerBandPx = layout.header.on ? mmToPx(BAND_MM) : 0;
  const footerBandPx = layout.footer.on ? mmToPx(BAND_MM) : 0;

  // Clamped for the same reason contentBoxMm is: margins wider than the paper are
  // reachable, and a zero-height text box makes the break loop meaningless. A visibly
  // broken document the user can fix beats a hung tab.
  const contentWidthPx = Math.max(24, pageWidthPx - marginLeftPx - marginRightPx);
  const contentHeightPx = Math.max(24, pageHeightPx - marginTopPx - marginBottomPx - headerBandPx - footerBandPx);

  return {
    pageWidthPx,
    pageHeightPx,
    marginTopPx,
    marginRightPx,
    marginBottomPx,
    marginLeftPx,
    headerBandPx,
    footerBandPx,
    contentWidthPx,
    contentHeightPx,
    gapPx,
    interPageSkipPx: marginBottomPx + footerBandPx + gapPx + headerBandPx + marginTopPx,
    dimsMm,
  };
}

/** Cheap equality, so a re-render with an identical layout does not retrigger a measure. */
export function sameGeometry(a: PageGeometry | null, b: PageGeometry | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.pageWidthPx === b.pageWidthPx &&
    a.pageHeightPx === b.pageHeightPx &&
    a.contentHeightPx === b.contentHeightPx &&
    a.contentWidthPx === b.contentWidthPx &&
    a.interPageSkipPx === b.interPageSkipPx &&
    a.headerBandPx === b.headerBandPx &&
    a.footerBandPx === b.footerBandPx &&
    a.gapPx === b.gapPx
  );
}
