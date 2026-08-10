import { describe, expect, it } from 'vitest';
import {
  activeTab,
  closeOthers,
  closeTab,
  closeToRight,
  makeTab,
  moveTab,
  openPath,
  setIdentity,
  step,
  syncUrl,
} from './tabsReducer';
import type { TabsState } from './tabTypes';

/**
 * Builds a strip from paths, active on the one marked with a leading `*` (the first
 * otherwise).
 *
 * Built directly rather than by replaying openPath: openPath inserts BESIDE the active
 * tab, so replaying it would lay the fixtures out in an order the test names do not say,
 * and every assertion below would be about the helper rather than the reducer.
 */
function strip(...paths: string[]): TabsState {
  const tabs = paths.map((p) => makeTab(p.replace('*', '')));
  const marked = paths.findIndex((p) => p.startsWith('*'));
  return { tabs, activeId: tabs[marked < 0 ? 0 : marked].id };
}

const paths = (s: TabsState) => s.tabs.map((t) => t.path);

describe('opening', () => {
  it('replaces the active tab by default, which is what makes an ordinary link load in place', () => {
    const s = openPath(strip('/', '/study'), '/search');
    expect(paths(s)).toEqual(['/search', '/study']);
    expect(s.tabs).toHaveLength(2);
  });

  it('opens a new tab beside the active one, not at the end', () => {
    const s = openPath(strip('*/', '/study'), '/search', 'new');
    expect(paths(s)).toEqual(['/', '/search', '/study']);
    expect(activeTab(s)?.path).toBe('/search');
  });

  it('activates the tab already showing a path rather than opening a second copy', () => {
    const before = strip('*/', '/note/a');
    const after = openPath(before, '/note/a', 'new');
    expect(after.tabs).toHaveLength(2);
    expect(activeTab(after)?.path).toBe('/note/a');
  });

  it('dedupes even in background mode, and leaves the active tab alone', () => {
    const before = strip('*/', '/note/a');
    const after = openPath(before, '/note/a', 'background');
    expect(after).toBe(before);
  });

  it('drops the old label when a tab is moved somewhere else', () => {
    const s = strip('/note/a');
    const named = setIdentity(s, s.tabs[0].id, { label: 'B-trees', dot: '#3b6fd4' });
    expect(named.tabs[0].label).toBe('B-trees');
    const moved = openPath(named, '/note/b');
    expect(moved.tabs[0].path).toBe('/note/b');
    expect(moved.tabs[0].label).toBeUndefined();
    expect(moved.tabs[0].dot).toBeUndefined();
  });
});

describe('closing', () => {
  it('hands over to the neighbour on the RIGHT, so closing a run keeps moving forwards', () => {
    const s = strip('/a', '*/b', '/c');
    const after = closeTab(s, s.tabs[1].id);
    expect(activeTab(after)?.path).toBe('/c');
  });

  it('falls back to the left at the end of the strip', () => {
    const s = strip('/a', '/b', '*/c');
    const after = closeTab(s, s.tabs[2].id);
    expect(activeTab(after)?.path).toBe('/b');
  });

  it('leaves the active tab alone when a different one closes', () => {
    const s = strip('/a', '*/b', '/c');
    const after = closeTab(s, s.tabs[0].id);
    expect(activeTab(after)?.path).toBe('/b');
  });

  it('never leaves an empty strip - the last close opens Home', () => {
    const s = strip('/note/a');
    const after = closeTab(s, s.tabs[0].id);
    expect(paths(after)).toEqual(['/']);
    expect(activeTab(after)).toBeDefined();
  });

  it('close others keeps the one asked for, and makes it active', () => {
    const s = strip('/a', '/b', '*/c');
    const after = closeOthers(s, s.tabs[0].id);
    expect(paths(after)).toEqual(['/a']);
    expect(activeTab(after)?.path).toBe('/a');
  });

  it('close to the right adopts the surviving tab when the active one was closed with it', () => {
    const s = strip('/a', '/b', '*/c');
    const after = closeToRight(s, s.tabs[0].id);
    expect(paths(after)).toEqual(['/a']);
    expect(activeTab(after)?.path).toBe('/a');
  });
});

describe('reordering and stepping', () => {
  it('moves a tab to an index', () => {
    const s = strip('/a', '/b', '/c');
    expect(paths(moveTab(s, s.tabs[0].id, 2))).toEqual(['/b', '/c', '/a']);
  });

  it('clamps rather than dropping a tab off the end', () => {
    const s = strip('/a', '/b');
    expect(paths(moveTab(s, s.tabs[0].id, 99))).toEqual(['/b', '/a']);
  });

  it('steps and wraps in both directions', () => {
    const s = strip('*/a', '/b', '/c');
    expect(activeTab(step(s, -1))?.path).toBe('/c');
    expect(activeTab(step(step(s, 1), 1))?.path).toBe('/c');
  });

  it('does not step a strip of one', () => {
    const s = strip('/a');
    expect(step(s, 1)).toBe(s);
  });
});

describe('following the URL', () => {
  it('activates an open tab', () => {
    const s = strip('*/a', '/b');
    expect(activeTab(syncUrl(s, '/b'))?.path).toBe('/b');
  });

  it('moves the active tab when nothing is open on that path', () => {
    const s = strip('*/a', '/b');
    const after = syncUrl(s, '/search?q=trees');
    expect(paths(after)).toEqual(['/search?q=trees', '/b']);
  });

  it('is a no-op when the active tab is already there, so it cannot fight the navigator', () => {
    const s = strip('*/a');
    expect(syncUrl(s, '/a')).toBe(s);
  });
});

describe('identity', () => {
  it('returns the same object when nothing changed, so the strip does not re-render per keystroke', () => {
    const base = strip('/note/a');
    const s = setIdentity(base, base.tabs[0].id, { label: 'Trees' });
    expect(s).not.toBe(base);
    const again = setIdentity(s, s.tabs[0].id, { label: 'Trees' });
    expect(again).toBe(s);
  });
});
