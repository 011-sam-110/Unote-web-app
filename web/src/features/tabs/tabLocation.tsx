// A pane's own idea of where it is.
//
// This is the piece that makes several pages mountable at once. `useParams` and
// `useSearchParams` answer for the URL, and the URL belongs to whichever tab is on screen
// - so a hidden note page asking the router for its id would be handed the VISIBLE note's
// id, refetch, and quietly replace its own contents. Every tabbed page reads its identity
// from here instead, which answers for the pane the page is actually in.
//
// Outside a pane every hook here falls through to the router, so a page still works if it
// is ever rendered on its own.
import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { matchPath, useParams, useSearchParams } from 'react-router-dom';
import { useTabsOptional } from './TabsContext';
import { pathnameOf } from './tabRoutes';

export interface PaneLocation {
  tabId: string;
  /** This pane's full path, which is only the browser's URL while the pane is active. */
  path: string;
  active: boolean;
}

const PaneCtx = createContext<PaneLocation | null>(null);

export function TabPaneProvider({ value, children }: { value: PaneLocation; children: ReactNode }) {
  return <PaneCtx.Provider value={value}>{children}</PaneCtx.Provider>;
}

export function useTabPane(): PaneLocation | null {
  return useContext(PaneCtx);
}

/**
 * Whether this pane is the one on screen.
 *
 * The guard for anything a page does to the world OUTSIDE itself - the document title, a
 * window listener, a CSS variable, "which notebook am I in". Those are all singular, and
 * a background pane writing to them is writing over the visible page.
 *
 * True outside a pane: a page rendered on its own is the one on screen by definition.
 */
export function useIsActiveTab(): boolean {
  const pane = useContext(PaneCtx);
  return pane ? pane.active : true;
}

/** `useParams`, answered against this pane's path. */
export function useTabParams<T extends Record<string, string | undefined>>(pattern: string): T {
  const pane = useContext(PaneCtx);
  const routerParams = useParams();
  const panePath = pane?.path;
  const paneParams = useMemo(
    () => (panePath === undefined ? null : ((matchPath(pattern, pathnameOf(panePath))?.params ?? {}) as T)),
    [panePath, pattern],
  );
  return (paneParams ?? routerParams) as T;
}

export type SearchInit = URLSearchParams | Record<string, string | string[]>;

function toParams(init: SearchInit): URLSearchParams {
  if (init instanceof URLSearchParams) return new URLSearchParams(init);
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(init)) {
    if (Array.isArray(v)) v.forEach((one) => out.append(k, one));
    else out.append(k, v);
  }
  return out;
}

/**
 * `useSearchParams`, answered against this pane's path, and writing back to the tab rather
 * than straight to the browser - so an inactive Search tab can keep its own query.
 *
 * The returned URLSearchParams is memoised on the query STRING. SearchPage has an effect
 * keyed on it, and a fresh object every render would re-run that effect forever.
 */
export function useTabSearchParams(): [URLSearchParams, (next: SearchInit, opts?: { replace?: boolean }) => void] {
  const pane = useContext(PaneCtx);
  const tabs = useTabsOptional();
  const [routerParams, setRouterParams] = useSearchParams();

  const panePath = pane?.path;
  const queryString = panePath === undefined ? null : panePath.slice(pathnameOf(panePath).length);

  const params = useMemo(
    () => (queryString === null ? null : new URLSearchParams(queryString)),
    [queryString],
  );

  const setParams = useCallback(
    (next: SearchInit, opts?: { replace?: boolean }) => {
      if (!pane || !tabs) {
        setRouterParams(next as never, opts);
        return;
      }
      const qs = toParams(next).toString();
      tabs.setPath(pane.tabId, pathnameOf(pane.path) + (qs ? `?${qs}` : ''), opts);
    },
    [pane, tabs, setRouterParams],
  );

  return [params ?? routerParams, pane && tabs ? setParams : setRouterParams];
}
