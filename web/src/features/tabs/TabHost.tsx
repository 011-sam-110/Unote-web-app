// Renders the open tabs, several at once, and shows the active one.
//
// This replaces <Outlet/> in the shell. The router renders only the route matching the
// URL, which is exactly what tabs cannot do: switching back to a note has to find the
// editor still there, with its undo stack, its caret and its open panels intact.
//
// Two things bound the cost of that. Only the most recently used panes stay mounted - a
// Unote note can hold a 3D model, a chemistry renderer or a canvas board, and fifteen of
// those is a real cost on a school laptop. And a tab past the cap keeps its place in the
// strip, unmounts, and comes back with its scroll offset where it was left.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTabs } from './TabsContext';
import { TabPaneProvider } from './tabLocation';
import { matchTabRoute } from './tabRoutes';

/** Scroll offsets by tab, module-level so an evicted pane's position outlives its DOM. */
const scrollStore = new Map<string, number>();

/** Panes kept mounted at once. Two on a phone, where memory is tighter and nobody is
 *  cross-referencing four notes anyway. */
const CAP_DESKTOP = 4;
const CAP_MOBILE = 2;

function useMountCap(): number {
  const query = '(max-width: 899px)';
  const [cap, setCap] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia(query).matches ? CAP_MOBILE : CAP_DESKTOP,
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setCap(mq.matches ? CAP_MOBILE : CAP_DESKTOP);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return cap;
}

/**
 * Which tabs currently have a mounted pane.
 *
 * Returns a SET, and the caller renders in strip order. The recency ranking decides
 * membership only, and deliberately does not reach the DOM: ordering panes by recency
 * meant every switch reordered them, React moved the pane nodes to match, and a moved
 * subtree took the TipTap editor inside it down with it - which is the one thing the
 * whole feature exists to prevent. Strip order changes only when a tab is dragged, where
 * a move is the point.
 *
 * Derived during render rather than in an effect, so switching to an evicted tab does not
 * paint one frame of nothing before the pane arrives.
 */
function useLiveTabs(openIds: string[], activeId: string, cap: number): Set<string> {
  const mru = useRef<string[]>([]);
  const next = [activeId, ...mru.current.filter((id) => id !== activeId)]
    .filter((id) => openIds.includes(id))
    .slice(0, cap);
  if (next.length !== mru.current.length || next.some((id, i) => mru.current[i] !== id)) {
    mru.current = next;
  }
  return new Set(mru.current);
}

/**
 * Scroll position across a switch.
 *
 * A hidden pane cannot be trusted to keep its own: `display: none` takes it out of layout,
 * and several browsers reset scrollTop when it comes back. An evicted pane has no DOM to
 * keep anything in at all. So the offset is recorded on the way out and re-applied on the
 * way in - and re-applied again as content arrives, because a remounted note is an empty
 * box for as long as its fetch takes and cannot be scrolled to where it was until there is
 * something to scroll.
 */
function usePaneScroll(tabId: string, active: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);

  // On the way out: remember. Cleanup runs before the pane is hidden or unmounted, while
  // the element still has a real scrollTop to read.
  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    return () => {
      if (el) scrollStore.set(tabId, el.scrollTop);
    };
  }, [active, tabId]);

  useLayoutEffect(() => {
    const el = ref.current;
    const want = scrollStore.get(tabId) ?? 0;
    if (!active || !el || want === 0) return;

    let done = false;
    let queued = 0;
    const apply = () => {
      if (done || !ref.current) return;
      ref.current.scrollTop = want;
      // Satisfied only once the box is actually tall enough to hold the offset.
      if (Math.abs(ref.current.scrollTop - want) < 1) done = true;
    };
    // Writing scrollTop straight from the observer's callback re-enters layout inside the
    // observation loop, which the browser reports as "ResizeObserver loop completed with
    // undelivered notifications" - harmless in effect, but a real error event that a page
    // should not be emitting on every tab switch. One frame later is outside the loop.
    const applyLater = () => {
      if (done || queued) return;
      queued = requestAnimationFrame(() => {
        queued = 0;
        apply();
      });
    };
    apply();

    // Content arriving after the fetch is what makes the box tall enough.
    const ro = new ResizeObserver(applyLater);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    // A user scroll means they no longer want to be put back.
    const onScroll = () => {
      done = true;
    };
    el.addEventListener('wheel', onScroll, { passive: true });
    el.addEventListener('touchmove', onScroll, { passive: true });
    const stop = window.setTimeout(() => {
      done = true;
      ro.disconnect();
    }, 3000);

    return () => {
      window.clearTimeout(stop);
      if (queued) cancelAnimationFrame(queued);
      ro.disconnect();
      el.removeEventListener('wheel', onScroll);
      el.removeEventListener('touchmove', onScroll);
    };
  }, [active, tabId]);

  return ref;
}

export default function TabHost() {
  const { tabs, activeId } = useTabs();
  const cap = useMountCap();
  const live = useLiveTabs(
    tabs.map((t) => t.id),
    activeId,
    cap,
  );

  // Offsets for tabs that are gone entirely, so the map cannot grow forever.
  useEffect(() => {
    const open = new Set(tabs.map((t) => t.id));
    for (const id of scrollStore.keys()) if (!open.has(id)) scrollStore.delete(id);
  }, [tabs]);

  return (
    <div className="tab-panes">
      {tabs.map((tab) => {
        if (!live.has(tab.id)) return null;
        const matched = matchTabRoute(tab.path);
        if (!matched) return null;
        return (
          <TabPane key={tab.id} tabId={tab.id} path={tab.path} active={tab.id === activeId}>
            {matched.route.element}
          </TabPane>
        );
      })}
    </div>
  );
}

function TabPane({
  tabId,
  path,
  active,
  children,
}: {
  tabId: string;
  path: string;
  active: boolean;
  children: React.ReactNode;
}) {
  const ref = usePaneScroll(tabId, active);
  // Memoised: this is the value every tabbed page reads its identity from, so a fresh
  // object each render would re-render all of them - including the three that are not
  // on screen - on any change to the strip.
  const location = useMemo(() => ({ tabId, path, active }), [tabId, path, active]);
  return (
    <div
      ref={ref}
      className="tab-pane"
      role="tabpanel"
      id={`folio-tabpanel-${tabId}`}
      aria-labelledby={`folio-tab-${tabId}`}
      data-active={active || undefined}
      // A hidden pane is a whole page of focusable controls that must not be reachable by
      // Tab or announced by a screen reader - the same treatment the shell already gives
      // its closed mobile drawer.
      inert={!active ? true : undefined}
      aria-hidden={!active ? true : undefined}
    >
      <TabPaneProvider value={location}>{children}</TabPaneProvider>
    </div>
  );
}
