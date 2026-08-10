// The one list of what a path inside the shell renders.
//
// It used to live in main.tsx's router. It cannot stay there, because the router renders
// only the route that matches the URL and tabs need several mounted at once - so TabHost
// does the rendering and matches against this list itself.
//
// main.tsx derives its child routes FROM this list rather than declaring its own, so the
// two cannot drift. The router still has to know these paths: it is what resolves the URL
// into the "/" layout route, and what keeps <RequireAuth> in front of every one of them.
import type { ReactElement } from 'react';
import { matchPath, type RouteObject } from 'react-router-dom';
import DashboardPage from '../../pages/DashboardPage';
import NotebookPage from '../../pages/NotebookPage';
import SearchPage from '../../pages/SearchPage';
import TagsPage from '../../pages/TagsPage';
import NotePage from '../editor/NotePage';
import StudyPage from '../study/StudyPage';
import AskPage from '../ask/AskPage';

export interface TabRoute {
  /** An absolute react-router pattern. */
  pattern: string;
  element: ReactElement;
}

export const TAB_ROUTES: TabRoute[] = [
  { pattern: '/', element: <DashboardPage /> },
  { pattern: '/notebook/:notebookId', element: <NotebookPage /> },
  { pattern: '/note/:noteId', element: <NotePage /> },
  { pattern: '/study', element: <StudyPage /> },
  { pattern: '/ask', element: <AskPage /> },
  { pattern: '/search', element: <SearchPage /> },
  { pattern: '/tags', element: <TagsPage /> },
];

/** The query string is not part of what a path renders - `/search?q=trees` is the search
 *  page - so it is stripped before matching. Tabs still keep the full path, because two
 *  searches are two different tabs. */
export function pathnameOf(path: string): string {
  const cut = path.indexOf('?');
  return cut < 0 ? path : path.slice(0, cut);
}

export function matchTabRoute(path: string): { route: TabRoute; params: Record<string, string | undefined> } | null {
  const pathname = pathnameOf(path);
  for (const route of TAB_ROUTES) {
    const m = matchPath(route.pattern, pathname);
    if (m) return { route, params: m.params };
  }
  return null;
}

/** Whether a URL is something the strip can hold. Anything else - /login, /sitemap, an
 *  external link - is left to the browser. */
export function isTabbablePath(path: string): boolean {
  return matchTabRoute(path) !== null;
}

/**
 * The router's children for the "/" layout route, derived rather than restated.
 *
 * Each renders `null`. The layout renders <TabHost/> in place of <Outlet/>, so nothing
 * here would render anyway - their whole job is to make the URL resolve to the layout and
 * to feed useParams in App.
 *
 * `element: null` rather than omitting it: react-router only warns about a matched leaf
 * route whose element is `undefined`, so leaving it off logged "does not have an element
 * or Component… resulting in an empty page" on every navigation. Null says the same thing
 * the omission did, deliberately.
 */
export function tabRouterChildren(): RouteObject[] {
  return TAB_ROUTES.map((r) =>
    r.pattern === '/' ? { index: true, element: null } : { path: r.pattern.slice(1), element: null },
  );
}
