// Text + background color for the block-menu "Color" action. Built on
// @tiptap/extension-text-style's bundled Color / BackgroundColor sub-modules - confirmed
// present in this repo (v3.28.0, resolved via subpath exports `./color` / `./background-color`,
// see the package's own `dist/index.cjs` main export). It's currently only pulled in as a
// *transitive* dependency of @tiptap/extension-details (already used for the Toggle block),
// not declared directly in web/package.json - flagged in this agent's `needs` so it gets
// promoted to a direct dependency. No `Color` extension package was needed as a fallback.
//
// TextStyleKit mirrors the TableKit pattern already used in buildExtensions.ts: opt into
// just the pieces we want and disable the rest.
//
// Font family, font size and line height were disabled here as "out of scope" when this
// file only had to serve the Color action. The bottom formatting bar needs all three, and
// they were already in the package - so this is a config change rather than three new
// extensions. They all write to the same `textStyle` mark, which is why they compose:
// a run can carry a family, a size and a colour at once without fighting.
import { TextStyleKit } from '@tiptap/extension-text-style';
import type { Extensions } from '@tiptap/core';

export function createTextColorExtensions(): Extensions {
  return [TextStyleKit];
}

export interface ColorSwatch {
  id: string;
  label: string;
  /** CSS value used both for the little preview dot and the applied mark - a token
   *  reference (not a resolved hex) so switching light/dark theme repaints existing
   *  colored text automatically instead of baking in a stale color. */
  text: string;
  bg: string;
}

// Six tokens-based hues - no invented raw hex. Four map straight onto the app's existing
// semantic tokens; "Blue" reuses --accent; "Purple" is a color-mix() of two existing
// tokens rather than a new color. The three swatch-only variables live in editor.css.
export const COLOR_SWATCHES: ColorSwatch[] = [
  { id: 'gray', label: 'Gray', text: 'var(--ink-2)', bg: 'var(--swatch-gray-soft)' },
  { id: 'red', label: 'Red', text: 'var(--danger)', bg: 'var(--danger-soft)' },
  { id: 'orange', label: 'Orange', text: 'var(--warn)', bg: 'var(--warn-soft)' },
  { id: 'green', label: 'Green', text: 'var(--ok)', bg: 'var(--ok-soft)' },
  { id: 'blue', label: 'Blue', text: 'var(--accent)', bg: 'var(--accent-soft)' },
  { id: 'purple', label: 'Purple', text: 'var(--swatch-purple)', bg: 'var(--swatch-purple-soft)' },
];
