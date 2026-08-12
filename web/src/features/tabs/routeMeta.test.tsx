import { describe, expect, it } from 'vitest';
import { routeMeta } from './routeMeta';
import { isTabbablePath, matchTabRoute, pathnameOf, TAB_ROUTES, tabRouterChildren } from './tabRoutes';
import type { Notebook } from '../../lib/types';

const NOTEBOOKS = [
  { id: 'nb1', name: 'Algorithms', emoji: '📘', color: '#3b6fd4', position: 0, archived: false, noteCount: 4, lastNoteAt: null },
] as Notebook[];

/** A concrete path for every pattern, so "every route can be a tab" is checked against the
 *  list itself rather than against a second list someone has to remember to update. */
const SAMPLES: Record<string, string> = {
  '/': '/',
  '/notebook/:notebookId': '/notebook/nb1',
  '/note/:noteId': '/note/n1',
  '/study': '/study',
  '/ask': '/ask',
  '/search': '/search',
  '/tags': '/tags',
  '/references': '/references',
};

describe('tabRoutes', () => {
  it('has a sample for every route, so this file cannot silently stop covering one', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(TAB_ROUTES.map((r) => r.pattern).sort());
  });

  it('matches each route', () => {
    for (const route of TAB_ROUTES) {
      expect(matchTabRoute(SAMPLES[route.pattern])?.route.pattern).toBe(route.pattern);
    }
  });

  it('ignores the query when matching but keeps it on the path', () => {
    expect(matchTabRoute('/search?q=trees')?.route.pattern).toBe('/search');
    expect(pathnameOf('/search?q=trees')).toBe('/search');
    expect(pathnameOf('/search')).toBe('/search');
  });

  it('refuses paths the strip cannot hold', () => {
    expect(isTabbablePath('/login')).toBe(false);
    expect(isTabbablePath('/sitemap')).toBe(false);
    expect(isTabbablePath('/capture')).toBe(false);
    expect(isTabbablePath('/note/n1')).toBe(true);
  });

  it('derives the router children from the same list, index route included', () => {
    const children = tabRouterChildren();
    expect(children).toHaveLength(TAB_ROUTES.length);
    expect(children[0]).toEqual({ index: true, element: null });
    expect(children.slice(1).map((c) => `/${c.path}`)).toEqual(TAB_ROUTES.slice(1).map((r) => r.pattern));
    // Explicitly null, never a real element: TabHost renders these, and a second copy here
    // is the drift this generation exists to prevent. Null rather than absent is what stops
    // react-router warning about a matched leaf route on every navigation.
    expect(children.every((c) => c.element === null)).toBe(true);
  });
});

describe('routeMeta', () => {
  it('names every route before its page has loaded', () => {
    for (const route of TAB_ROUTES) {
      expect(routeMeta(SAMPLES[route.pattern], NOTEBOOKS).label).toBeTruthy();
    }
  });

  it('takes a notebook tab name and colour from the notebook list', () => {
    expect(routeMeta('/notebook/nb1', NOTEBOOKS)).toMatchObject({ label: 'Algorithms', dot: '#3b6fd4' });
  });

  it('still names a notebook that has not loaded yet', () => {
    expect(routeMeta('/notebook/nb1', []).label).toBe('Notebook');
  });

  it('calls an unloaded note Untitled, the same word the empty title field uses', () => {
    expect(routeMeta('/note/n1', NOTEBOOKS).label).toBe('Untitled');
  });
});
