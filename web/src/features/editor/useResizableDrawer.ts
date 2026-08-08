// Drag-to-resize for the right-hand drawers, with the chosen width remembered.
//
// The AI panel went from a fixed 400px list of buttons to a conversation that holds code
// blocks, diffs and review cards, and 400px is not a width you can read a diff in. Rather
// than pick a new fixed number and be wrong for a different set of people, the reader picks.
//
// Persisted per key, so the AI panel and History do not have to agree, and so the choice
// survives the reload - a width you have to re-drag every session is barely a setting.
import { useCallback, useEffect, useRef, useState } from 'react';

export interface ResizableDrawer {
  width: number;
  /** Spread onto the grip element. */
  gripProps: {
    role: 'separator';
    'aria-orientation': 'vertical';
    'aria-label': string;
    'aria-valuenow': number;
    'aria-valuemin': number;
    'aria-valuemax': number;
    tabIndex: 0;
    className: string;
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
    onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
    onDoubleClick: () => void;
  };
  dragging: boolean;
}

/** How far one arrow-key press moves the edge. Shift multiplies it - see `onKeyDown`. */
const STEP = 24;

/**
 * The narrowest the page beside the drawer may be squeezed to, including its own padding.
 *
 * `window.innerWidth * 0.72` was measured against the wrong thing: the drawer overlays the
 * MAIN COLUMN, not the window, and the sidebar is not space the note can borrow back. On a
 * 1440 laptop that let the drawer reach 880 over a 1166px column, and once the 32px gutters
 * and the outline rail had taken their share the note itself computed to zero width - title,
 * body and all. Worse, the width is persisted, so re-opening the panel restored the collapse.
 */
const MIN_CANVAS = 420;

/**
 * The widest the drawer may get, given the space it actually has.
 *
 * A drawer can always be dragged wide, but never so wide that the note it is about is gone:
 * the panel exists to act on the text beside it, and a full-width drawer is a modal wearing
 * a drawer's clothes. The floor keeps the cap sane on a phone-width window, where the drawer
 * is legitimately most of the screen.
 */
function maxWidth(): number {
  if (typeof window === 'undefined') return 720;
  const main = document.querySelector('.app-main');
  const available = main ? main.getBoundingClientRect().width : window.innerWidth;
  return Math.max(320, Math.min(880, Math.round(window.innerWidth * 0.72), Math.round(available - MIN_CANVAS)));
}

const MIN = 320;

function clamp(px: number): number {
  return Math.min(maxWidth(), Math.max(MIN, Math.round(px)));
}

export function useResizableDrawer(storageKey: string, initial: number, label = 'Resize panel'): ResizableDrawer {
  const [width, setWidth] = useState<number>(() => {
    try {
      const saved = Number(window.localStorage.getItem(storageKey));
      if (Number.isFinite(saved) && saved > 0) return clamp(saved);
    } catch {
      // Private mode, or storage disabled. The default width is a perfectly good answer.
    }
    return clamp(initial);
  });
  const [dragging, setDragging] = useState(false);

  // Read inside the move handler, which is registered once per drag - reading state there
  // would close over the width at pointerdown and every move would fight the last.
  const widthRef = useRef(width);
  widthRef.current = width;

  const persist = useCallback(
    (px: number) => {
      try {
        window.localStorage.setItem(storageKey, String(px));
      } catch {
        // Not being able to remember the width is not worth interrupting anyone over.
      }
    },
    [storageKey],
  );

  // A window narrow enough to invalidate the saved width has to pull it back in, or the
  // drawer sits wider than the viewport with its grip off-screen and no way to shrink it.
  //
  // Run once on mount too. The first clamp happens during render, when `.app-main` has not
  // been committed yet and maxWidth() can only fall back to the window - so a width saved
  // from a wider window, or from before the cap existed, is still too wide at that point.
  useEffect(() => {
    function onResize() {
      setWidth((w) => clamp(w));
    }
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Left button only, and never a secondary click - a context menu mid-drag would leave
      // the pointer captured with no pointerup coming.
      if (e.button !== 0) return;
      e.preventDefault();
      const grip = e.currentTarget;
      grip.setPointerCapture(e.pointerId);
      setDragging(true);

      // The drawer is anchored to the right edge, so the width IS the distance from the
      // pointer to that edge. Measured live rather than from a start offset, which would
      // drift if the window were resized mid-drag.
      const move = (ev: PointerEvent) => setWidth(clamp(window.innerWidth - ev.clientX));
      const up = () => {
        setDragging(false);
        persist(widthRef.current);
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.removeEventListener('pointercancel', up);
      };
      // Bound to the grip rather than the window because the pointer is captured to it:
      // capture routes every subsequent event here even when the cursor is over the editor,
      // which is what stops the drag from selecting text in the note behind.
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
      grip.addEventListener('pointercancel', up);
    },
    [persist],
  );

  // Keyboard resize. A separator that can only be dragged is a control someone using a
  // keyboard cannot reach at all, and this one owns how much of the screen they can read.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const step = e.shiftKey ? STEP * 4 : STEP;
      let next: number | null = null;
      if (e.key === 'ArrowLeft') next = widthRef.current + step;
      else if (e.key === 'ArrowRight') next = widthRef.current - step;
      else if (e.key === 'Home') next = MIN;
      else if (e.key === 'End') next = maxWidth();
      if (next === null) return;
      e.preventDefault();
      const clamped = clamp(next);
      setWidth(clamped);
      persist(clamped);
    },
    [persist],
  );

  /** Double-click the grip to go back to the width the panel shipped with. */
  const onDoubleClick = useCallback(() => {
    const reset = clamp(initial);
    setWidth(reset);
    persist(reset);
  }, [initial, persist]);

  return {
    width,
    dragging,
    gripProps: {
      role: 'separator',
      'aria-orientation': 'vertical',
      'aria-label': label,
      'aria-valuenow': width,
      'aria-valuemin': MIN,
      'aria-valuemax': maxWidth(),
      tabIndex: 0,
      className: `folio-drawer-grip${dragging ? ' is-dragging' : ''}`,
      onPointerDown,
      onKeyDown,
      onDoubleClick,
    },
  };
}
