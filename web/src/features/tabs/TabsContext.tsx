// The tab strip's state, and the one place the URL and the strip are reconciled.
//
// The URL stays the source of truth for WHICH tab is active - back, forward, a redirect
// and a deep link all still work, and nothing else in the app had to learn about tabs.
// The strip is the source of truth for what is open and where each tab is pointed.
//
// Those two meet in exactly two places, and it matters that it is only two:
//
//   URL -> strip   one effect. If an open tab already has that path it becomes active;
//                  otherwise the ACTIVE tab moves there. That second half is what makes
//                  the app's several hundred existing <Link>s load in place with no
//                  changes to any of them.
//   strip -> URL   commit(), which navigates when the tab it just activated is pointed
//                  somewhere the browser is not. The URL effect then finds the path
//                  already active and does nothing, so the two cannot chase each other.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { flushTabNote } from '../editor/autosaveBus';
import { isTabbablePath } from './tabRoutes';
import { loadTabs, saveTabs } from './tabStorage';
import * as T from './tabsReducer';
import type { OpenMode, Tab, TabsState } from './tabTypes';

export interface TabsApi extends TabsState {
  open: (path: string, mode?: OpenMode) => void;
  activate: (id: string) => void;
  close: (id: string) => void;
  closeOthers: (id: string) => void;
  closeToRight: (id: string) => void;
  move: (id: string, to: number) => void;
  stepBy: (delta: number) => void;
  /** Called by a loaded page to name its own tab. */
  setIdentity: (id: string, next: { label?: string; dot?: string }) => void;
  /** Called by a page that changes its own query string (search terms, tag filters). */
  setPath: (id: string, path: string, opts?: { replace?: boolean }) => void;
}

const Ctx = createContext<TabsApi | null>(null);

export function useTabs(): TabsApi {
  const api = useContext(Ctx);
  if (!api) throw new Error('useTabs must be used inside <TabsProvider>');
  return api;
}

/** For the handful of things that render both inside and outside the shell. */
export function useTabsOptional(): TabsApi | null {
  return useContext(Ctx);
}

function urlOf(location: { pathname: string; search: string }): string {
  return location.pathname + location.search;
}

/**
 * The strip a session starts with.
 *
 * A deep link on a cold boot ADDS a tab rather than replacing one. The restored strip is
 * the user's workspace from last time; an emailed link into one note is an addition to
 * it, not an instruction to throw it away.
 */
function boot(url: string): TabsState {
  const stored = loadTabs();
  if (!stored) return T.initialState(isTabbablePath(url) ? url : T.HOME_PATH);
  if (!isTabbablePath(url)) return stored;

  const existing = stored.tabs.find((t) => t.path === url);
  if (existing) return { ...stored, activeId: existing.id };

  const tab = T.makeTab(url);
  return { tabs: [...stored.tabs, tab], activeId: tab.id };
}

export function TabsProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();

  const [state, setState] = useState<TabsState>(() => boot(urlOf(location)));

  // Where the browser currently is, readable synchronously from a callback. commit() has
  // to know it to decide whether a navigate is needed at all, and `location` is a render
  // value that a callback closes over one render too late.
  const urlRef = useRef(urlOf(location));

  // The live state, readable from a callback without waiting for a render. Written here on
  // every render so the two setState paths that bypass commit() - the URL effect and
  // setIdentity - are picked up too.
  const stateRef = useRef(state);
  stateRef.current = state;

  const commit = useCallback(
    (next: TabsState, opts?: { replace?: boolean }) => {
      // Synchronously, before setState. Two actions can fire in one tick - a middle-click
      // that closes a tab while another is still settling, a palette command run twice -
      // and the second reads this ref to build its own next state. Waiting for the render
      // to write it back would silently drop the first.
      stateRef.current = next;
      setState(next);
      const tab = T.activeTab(next);
      if (tab && tab.path !== urlRef.current) {
        urlRef.current = tab.path;
        navigate(tab.path, { replace: opts?.replace });
      }
    },
    [navigate],
  );

  // URL -> strip.
  useEffect(() => {
    const url = urlOf(location);
    urlRef.current = url;
    if (!isTabbablePath(url)) return;
    setState((prev) => T.syncUrl(prev, url));
  }, [location]);

  // Written immediately, not debounced.
  //
  // It was debounced for a moment, to keep a localStorage write out of the way of typing a
  // note title (which republishes its tab's label per keystroke). That traded a correctness
  // guarantee for an unmeasured micro-optimisation, and lost: opening a tab and reloading
  // inside the debounce window dropped the tab, because the save had not happened yet. The
  // e2e reload spec caught it. A small JSON.stringify is not worth a workspace.
  useEffect(() => {
    saveTabs(state);
  }, [state]);

  const api = useMemo<TabsApi>(() => {
    const act = (fn: (s: TabsState) => TabsState, opts?: { replace?: boolean }) => commit(fn(stateRef.current), opts);
    return {
      ...state,
      open: (path, mode = 'replace') => act((s) => T.openPath(s, path, mode)),
      activate: (id) => act((s) => T.activate(s, id)),
      close: (id) => {
        // Kick the save off BEFORE the pane unmounts. The request is in flight by the time
        // the editor goes, so a note closed a second after an edit still lands.
        void flushTabNote(id);
        act((s) => T.closeTab(s, id));
      },
      closeOthers: (id) => {
        stateRef.current.tabs.forEach((t) => {
          if (t.id !== id) void flushTabNote(t.id);
        });
        act((s) => T.closeOthers(s, id));
      },
      closeToRight: (id) => {
        const at = stateRef.current.tabs.findIndex((t) => t.id === id);
        stateRef.current.tabs.slice(at + 1).forEach((t) => void flushTabNote(t.id));
        act((s) => T.closeToRight(s, id));
      },
      move: (id, to) => act((s) => T.moveTab(s, id, to)),
      stepBy: (delta) => act((s) => T.step(s, delta)),
      setIdentity: (id, next) => setState((s) => T.setIdentity(s, id, next)),
      setPath: (id, path, opts) =>
        act((s) => ({ ...s, tabs: s.tabs.map((t) => (t.id === id ? { ...t, path } : t)) }), opts),
    };
  }, [state, commit]);

  // Ctrl/Cmd+click and middle-click open a tab in the app rather than one in the browser.
  //
  // One delegated listener instead of a prop on every <Link>: there are several hundred of
  // them, and any new one would otherwise have to remember to opt in. react-router leaves
  // modified clicks alone by design, so nothing has called preventDefault by the time this
  // runs and the browser has not yet acted on it.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (e.defaultPrevented) return;
      const middle = e.type === 'auxclick' && e.button === 1;
      const modified = e.type === 'click' && e.button === 0 && (e.metaKey || e.ctrlKey);
      // Shift is the browser's "open in a new window", and alt is its download modifier.
      // Neither is ours to take.
      if (e.shiftKey || e.altKey) return;
      if (!middle && !modified) return;

      const anchor = (e.target as Element | null)?.closest?.('a');
      if (!anchor) return;
      if (anchor.target && anchor.target !== '_self') return;
      if (anchor.hasAttribute('download')) return;

      const href = anchor.getAttribute('href');
      // Same-origin, absolute-path links only. "//host" is protocol-relative and leaves
      // the site despite starting with a slash.
      if (!href || !href.startsWith('/') || href.startsWith('//')) return;
      if (!isTabbablePath(href)) return;

      e.preventDefault();
      api.open(href, 'new');
    }

    document.addEventListener('click', onClick);
    document.addEventListener('auxclick', onClick);
    return () => {
      document.removeEventListener('click', onClick);
      document.removeEventListener('auxclick', onClick);
    };
  }, [api]);

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export type { Tab };
