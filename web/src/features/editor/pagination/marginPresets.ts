// The margin choices the formatting bar offers.
//
// Word's own four presets, in Word's order and at Word's values, so a document set up here
// opens in Word with the preset Word would name - DOCX export writes these millimetres
// straight into the section properties. Minimal is the one addition: Word's narrowest is
// half an inch, and "let me use the whole page" asks for less than that. A quarter inch
// still clears the unprintable strip most printers leave at the edge of the sheet.

import { DEFAULT_MARGIN_MM, type MarginsMm } from './layout';

export type MarginPresetId = 'normal' | 'narrow' | 'moderate' | 'wide' | 'minimal';

export interface MarginPreset {
  id: MarginPresetId;
  label: string;
  margins: MarginsMm;
}

function allRound(mm: number): MarginsMm {
  return { top: mm, right: mm, bottom: mm, left: mm };
}

function sides(topBottom: number, leftRight: number): MarginsMm {
  return { top: topBottom, right: leftRight, bottom: topBottom, left: leftRight };
}

export const MARGIN_PRESETS: readonly MarginPreset[] = [
  { id: 'normal', label: 'Normal', margins: allRound(DEFAULT_MARGIN_MM) },
  { id: 'narrow', label: 'Narrow', margins: allRound(12.7) },
  { id: 'moderate', label: 'Moderate', margins: sides(25.4, 19.05) },
  { id: 'wide', label: 'Wide', margins: sides(25.4, 50.8) },
  { id: 'minimal', label: 'Minimal', margins: allRound(6.35) },
];

/** Far below the closest two presets (6.35 mm apart) and far above any float noise. */
const TOLERANCE_MM = 0.05;

/**
 * The preset these margins are, or null for margins no preset matches ("Custom").
 *
 * Compared with a tolerance rather than ===: the values have been through JSON on both
 * the client and the server and through a clamp on each side, and a margin that differs
 * from 19.05 in the fifteenth digit is still Moderate to anyone reading the box.
 */
export function marginPresetFor(margins: MarginsMm): MarginPreset | null {
  const near = (a: number, b: number) => Math.abs(a - b) <= TOLERANCE_MM;
  return (
    MARGIN_PRESETS.find(
      ({ margins: m }) =>
        near(m.top, margins.top) &&
        near(m.right, margins.right) &&
        near(m.bottom, margins.bottom) &&
        near(m.left, margins.left),
    ) ?? null
  );
}

/**
 * The menu row's secondary text: the millimetres, the way the page size row gives them.
 * Moderate and Wide keep Normal's top and bottom, so their row names only what they change.
 */
export function marginSummary(margins: MarginsMm): string {
  const mm = (n: number) => `${Number(n.toFixed(2))}`;
  const { top, right, bottom, left } = margins;
  if (top === right && right === bottom && bottom === left) return `${mm(top)} mm all round`;
  if (top === bottom && left === right) return `${mm(left)} mm left and right`;
  return `${mm(top)} / ${mm(right)} / ${mm(bottom)} / ${mm(left)} mm`;
}
