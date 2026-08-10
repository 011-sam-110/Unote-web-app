// How much of the right-hand edge a drawer is currently covering, published as a CSS
// variable so the page underneath can get out of its way.
//
// The right-hand drawers (AI, History, Comments) are fixed overlays pinned to the viewport
// edge. That is deliberate - they are non-modal, full height, and scroll independently of
// the note - but it also meant they sat ON TOP of the text they are about. Open the AI
// panel while writing and the last third of every line disappeared underneath it.
//
// Making the drawer a real flex sibling of the note would have fixed it, but the drawers
// render deep inside NotePage while the column that would have to shrink is `.app-main`,
// several levels up, so it would have taken a portal and a layout slot. Reserving the space
// instead costs one custom property: every open drawer registers its width here, the widest
// one wins (they overlap each other at the same edge, so it is a max, not a sum), and
// `.folio-note-page` pads its right side by that much.
//
// The width is live, so dragging the drawer's grip reflows the note as you drag rather than
// on release.
import { useEffect } from 'react';
import { useIsActiveTab, useTabPane } from '../tabs/tabLocation';

const openWidths = new Map<string, number>();

/** The note page's own left+right gutters, which the drawer inset is added on top of. */
const PAGE_GUTTERS = 64;
/** The outline rail plus the column gap between it and the note. */
const RAIL_SPACE = 212;
/** Below this the note column stops being a column and starts being a margin. */
const MIN_NOTE = 360;

function publish(): void {
  if (typeof document === 'undefined') return;
  let widest = 0;
  for (const w of openWidths.values()) if (w > widest) widest = w;
  const root = document.documentElement;
  root.style.setProperty('--folio-drawer-inset', `${Math.round(widest)}px`);

  // A drawer and the outline rail are both side chrome competing for the same margin, and
  // the note - the thing both of them are ABOUT - is what loses. On a wide monitor there is
  // room for all three; on a laptop with the panel dragged out there is not, and the rail is
  // the one that goes. Measured rather than guessed at a breakpoint, because the sidebar can
  // be collapsed and the drawer is a width the reader chose.
  const main = document.querySelector('.app-main');
  const available = main ? main.getBoundingClientRect().width : window.innerWidth;
  const crowded = widest > 0 && available - widest - PAGE_GUTTERS - RAIL_SPACE < MIN_NOTE;
  root.toggleAttribute('data-drawer-crowds-rail', crowded);
}

/**
 * Reserve `width` pixels at the right edge while `isOpen`.
 *
 * Safe to call unconditionally - a closed drawer registers nothing, and unmounting while
 * open releases the space, so a route change cannot leave the page permanently indented.
 */
export function useDrawerInset(key: string, width: number, isOpen: boolean): void {
  // `--folio-drawer-inset` is one custom property on one document, and up to four note
  // pages are mounted at once. A background tab left with its AI panel open would indent
  // the note the user is actually reading, by the width of a drawer that is not on screen.
  // The key is scoped per pane too, so two tabs with the same drawer open are two entries
  // rather than one overwriting the other.
  const isActive = useIsActiveTab();
  const pane = useTabPane();
  const scoped = pane ? `${pane.tabId}:${key}` : key;
  useEffect(() => {
    if (!isOpen || !isActive) return;
    const key = scoped;
    openWidths.set(key, width);
    publish();
    // Whether the rail still fits depends on the window as well as the drawer, so a resize
    // has to re-decide. Only registered while something is open - there is nothing to
    // recompute otherwise.
    window.addEventListener('resize', publish);
    return () => {
      openWidths.delete(key);
      window.removeEventListener('resize', publish);
      publish();
    };
  }, [scoped, width, isOpen, isActive]);
}
