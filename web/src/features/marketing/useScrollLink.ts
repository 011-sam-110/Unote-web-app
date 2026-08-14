// The general scroll-LINKED primitive for the landing page.
//
// useScrollProgress.ts is the pinned-section version and knows about sticky geometry. This
// is the ordinary one: an element travels through the viewport and that travel becomes a
// 0-1 number. Parallax, the strike sweep and the maker note's ink all run on it.
//
//   start ─────────────── the viewport line where p = 0 (element's TOP crosses it)
//   end   ─────────────── the viewport line where p = 1 (element's BOTTOM crosses it)
//
//   travel = height + (start − end) × viewportHeight
//   p      = (start × viewportHeight − rect.top) / travel
//
// Both lines are viewport FRACTIONS measured from the top, so `start: 0.85` means "when the
// element's top is 85% of the way down the screen". Passing start = end = 0 gives the
// special case the hero wants: p = 0 at scroll 0, p = 1 once the element has fully passed.
//
// TWO DELIBERATE DEPARTURES from how a React hook usually reports a value:
//
//  1. Progress arrives through a CALLBACK, not through state. A scrubbed value changes on
//     every frame of every scroll, and putting that in useState re-renders the component
//     tree 60 times a second to move something the compositor could have moved by itself.
//     Consumers write a CSS custom property or a transform straight onto a node instead.
//     `armed` is state, because it changes about twice in a session.
//  2. Measurement only runs while the element is on screen. An IntersectionObserver arms
//     and disarms the scroll listener, so three of these on one page cost nothing while the
//     reader is somewhere else on it.
//
// The callback is held in a ref, so consumers can pass an inline arrow function without
// wrapping it in useCallback and without re-subscribing the listener on every render.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** Linked motion is fine on a phone - unlike the pin, none of it depends on width. */
const MOTION_QUERY = '(prefers-reduced-motion: no-preference)';

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

export interface ScrollLinkOptions {
  /** Viewport fraction from the top at which p = 0. Default 0.85. */
  start?: number;
  /** Viewport fraction from the top at which p = 1. Default 0.4. */
  end?: number;
}

export default function useScrollLink(
  ref: RefObject<HTMLElement | null>,
  onProgress: (p: number) => void,
  { start = 0.85, end = 0.4 }: ScrollLinkOptions = {},
): boolean {
  const [armed, setArmed] = useState(false);
  const cb = useRef(onProgress);
  cb.current = onProgress;
  const last = useRef(-1);

  useLayoutEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(MOTION_QUERY);
    const sync = () => setArmed(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!armed || !el) return;

    let frame = 0;
    let watching = false;

    const measure = () => {
      const rect = el.getBoundingClientRect();
      const vh = window.innerHeight;
      // start === end is the hero case: the element's own height IS the travel, so it
      // finishes exactly as it leaves rather than at some line inside the viewport.
      const travel = rect.height + (start - end) * vh;
      if (travel <= 0) return;
      const p = clamp01((start * vh - rect.top) / travel);
      if (Math.abs(p - last.current) < 0.0005) return;
      last.current = p;
      cb.current(p);
    };

    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };

    const watch = () => {
      if (watching) return;
      watching = true;
      window.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', onScroll);
      measure();
    };
    const unwatch = () => {
      if (!watching) return;
      watching = false;
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };

    // Off screen, nothing is measured and nothing is listening. The margin is generous so
    // the first frame after the element appears is already correct rather than catching up.
    const io =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver(
            (entries) => {
              for (const entry of entries) {
                if (entry.isIntersecting) watch();
                else {
                  unwatch();
                  // Settle to whichever end it left by, so a fast scroll past cannot strand
                  // it half-drawn - the reader coming back finds a finished state, not a
                  // frozen one.
                  const settled = entry.boundingClientRect.top < 0 ? 1 : 0;
                  if (settled !== last.current) {
                    last.current = settled;
                    cb.current(settled);
                  }
                }
              }
            },
            { rootMargin: '25% 0px 25% 0px' },
          );

    if (io) io.observe(el);
    else watch();

    return () => {
      if (frame) cancelAnimationFrame(frame);
      unwatch();
      io?.disconnect();
    };
  }, [armed, ref, start, end]);

  return armed;
}
