// Paper sizes and the millimetre/pixel arithmetic every other part of pagination
// depends on.
//
// Mirrored in server/src/lib/pageLayout.ts, which needs the same numbers to write DOCX
// section properties. The two are pinned together by server/test/pageLayout.parity.test.ts
// rather than by trust: if the screen and the DOCX disagree about how big A4 is, the bug
// shows up as a page count that changes when you export, which is a miserable thing to
// track down from a user's description.

/** Portrait dimensions in millimetres. ISO/ANSI values - these are fixed by standard. */
export interface PageDimsMm {
  w: number;
  h: number;
}

export const PAGE_SIZES = {
  a3: { label: 'A3', w: 297, h: 420 },
  a4: { label: 'A4', w: 210, h: 297 },
  a5: { label: 'A5', w: 148, h: 210 },
  letter: { label: 'Letter', w: 215.9, h: 279.4 },
  legal: { label: 'Legal', w: 215.9, h: 355.6 },
  executive: { label: 'Executive', w: 184.15, h: 266.7 },
} as const;

export type StandardPageSizeId = keyof typeof PAGE_SIZES;
export type PageSizeId = StandardPageSizeId | 'custom';
export type Orientation = 'portrait' | 'landscape';

export const PAGE_SIZE_IDS = Object.keys(PAGE_SIZES) as StandardPageSizeId[];

/**
 * CSS reference pixels per millimetre.
 *
 * CSS fixes 1in = 96px and 1in = 25.4mm regardless of the physical display, so this is
 * exact arithmetic rather than an approximation of any particular screen. It is the same
 * conversion the browser's own print pipeline uses to turn `@page { size: 210mm 297mm }`
 * into a page box, which is why the sheets on screen and the sheets in the PDF line up.
 */
export const MM_TO_PX = 96 / 25.4;

export function mmToPx(mm: number): number {
  return mm * MM_TO_PX;
}

export function pxToMm(px: number): number {
  return px / MM_TO_PX;
}

/**
 * Resolve a size id + orientation to real dimensions.
 *
 * Custom sizes carry their own portrait measurements; everything else looks up the table.
 * Landscape swaps the axes here, once, so no caller has to remember to do it - forgetting
 * that swap is the obvious bug in this area and it produces sheets that look right and
 * paginate wrong.
 */
export function resolvePageDims(
  size: PageSizeId,
  orientation: Orientation,
  custom?: PageDimsMm,
): PageDimsMm {
  const base: PageDimsMm =
    size === 'custom'
      ? { w: custom?.w ?? PAGE_SIZES.a4.w, h: custom?.h ?? PAGE_SIZES.a4.h }
      : { w: PAGE_SIZES[size].w, h: PAGE_SIZES[size].h };
  return orientation === 'landscape' ? { w: base.h, h: base.w } : base;
}

/** Smallest sheet we will lay out, in mm. Below this the content box goes negative once
 *  margins are subtracted and the break loop has nothing sensible to do. */
export const MIN_PAGE_MM = 50;
export const MAX_PAGE_MM = 2000;
