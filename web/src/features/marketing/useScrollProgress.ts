// Scroll-LINKED progress for a pinned section.
//
// The distinction this hook exists to serve, and the one the rest of the landing page did
// not have: a scroll-TRIGGERED animation crosses a threshold and then plays on its own
// clock, and scrolling back up does not rewind it. A scroll-LINKED one has no clock at
// all - its current frame is a pure function of scroll offset, so it advances, reverses
// and holds exactly as the reader drags the page. useReveals.ts owns the triggered kind.
// This owns the linked kind, and they do not overlap.
//
// The measurement, which is the whole hook:
//
//   container   ┌─────────────┐ ← p = 0 the moment the stage pins
//   (tall)      │ ┌─────────┐ │
//               │ │  stage  │ │ position: sticky, top: <stickyTop>
//               │ └─────────┘ │
//               └─────────────┘ ← p = 1 the moment it unpins, flush
//
//   travel = container.height − stage.height − stickyTop
//   p      = clamp(−(container.top − stickyTop) / travel, 0, 1)
//
// stickyTop is READ from the stage's computed style rather than duplicated here, so the
// CSS stays the single source of truth for how far down the pin sits. Getting `travel`
// wrong is what makes a pinned section release early and jump, or release late and sit
// dead at its last frame - so it is derived, never guessed.
//
// SAFETY, same rule as useReveals: this hook only ever reports `armed` once it has
// decided to drive something. Un-armed it reports progress 0, no pinning CSS applies at
// all, and the section renders as an ordinary readable stack of blocks rather than four
// blank screens. Reduced motion, a narrow viewport, or any paint before the decision has
// been made all take that path.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** The pin is desktop-only and motion-only. Below this the section unpins and stacks -
 *  see the matching rule in marketing.css, which has to agree with this query. */
const PIN_QUERY = '(min-width: 861px) and (prefers-reduced-motion: no-preference)';

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

export interface ScrollProgress {
  /** True only when this hook is actually driving the section. */
  armed: boolean;
  /** 0-1 across the pin's travel. Always 0 while un-armed. */
  progress: number;
}

export default function useScrollProgress(
  containerRef: RefObject<HTMLElement | null>,
  stageRef: RefObject<HTMLElement | null>,
): ScrollProgress {
  const [armed, setArmed] = useState(false);
  const [progress, setProgress] = useState(0);
  // Held in a ref as well as state so the scroll handler can skip a re-render when the
  // value has not moved enough to change a pixel. A pinned section is read at 60fps and
  // most frames of a slow scroll round to the same place.
  const last = useRef(0);

  // Arming decision, in a layout effect so the class lands in the same frame as first
  // paint. The listener is added in the effect below only once this has said yes.
  useLayoutEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(PIN_QUERY);
    const sync = () => setArmed(mq.matches);
    sync();
    // Re-evaluated on resize and on a change to the motion preference, so crossing the
    // breakpoint in either direction hands the section to the other implementation
    // cleanly instead of leaving a half-pinned stage behind.
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  const measure = useCallback(() => {
    const container = containerRef.current;
    const stage = stageRef.current;
    if (!container || !stage) return;

    const stickyTop = parseFloat(getComputedStyle(stage).top) || 0;
    const travel = container.offsetHeight - stage.offsetHeight - stickyTop;
    // A container shorter than its own stage cannot pin. Report the end rather than
    // dividing by zero or a negative, which would invert the whole section.
    if (travel <= 0) {
      last.current = 1;
      setProgress(1);
      return;
    }

    const p = clamp01(-(container.getBoundingClientRect().top - stickyTop) / travel);
    // Quantised to the pixel budget of the longest thing it drives (a full-width rail),
    // which is the point below which a change cannot be seen.
    if (Math.abs(p - last.current) < 0.0005) return;
    last.current = p;
    setProgress(p);
  }, [containerRef, stageRef]);

  useEffect(() => {
    if (!armed) {
      last.current = 0;
      setProgress(0);
      return;
    }

    // rAF-coalesced: scroll fires far more often than the screen repaints, and measuring
    // in the handler itself would read layout several times per frame.
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };

    measure();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);

    // The stage's own height decides `travel`, and it settles after fonts load and after
    // the replica's rail wraps. Re-measuring on that settle is what stops the pin
    // releasing a few hundred pixels early on a cold load.
    const ro =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => onScroll());
    if (ro) {
      if (containerRef.current) ro.observe(containerRef.current);
      if (stageRef.current) ro.observe(stageRef.current);
    }

    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      ro?.disconnect();
    };
  }, [armed, measure, containerRef, stageRef]);

  return { armed, progress };
}
