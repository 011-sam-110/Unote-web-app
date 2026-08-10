import { beforeEach, describe, expect, it } from 'vitest';
import { loadTabs, saveTabs } from './tabStorage';

const KEY = 'unote.tabs.v1';
const put = (value: unknown) => localStorage.setItem(KEY, typeof value === 'string' ? value : JSON.stringify(value));

beforeEach(() => localStorage.clear());

describe('tabStorage', () => {
  it('round-trips a strip', () => {
    saveTabs({ tabs: [{ id: 'a', path: '/note/1', label: 'Trees' }], activeId: 'a' });
    expect(loadTabs()).toEqual({ tabs: [{ id: 'a', path: '/note/1', label: 'Trees', dot: undefined }], activeId: 'a' });
  });

  it('is null with nothing stored', () => {
    expect(loadTabs()).toBeNull();
  });

  it('discards junk rather than half-restoring it', () => {
    put('{{{not json');
    expect(loadTabs()).toBeNull();
    put({ tabs: 'nope', activeId: 'a' });
    expect(loadTabs()).toBeNull();
    put({ tabs: [{ id: 'a', path: '/x' }] });
    expect(loadTabs()).toBeNull();
  });

  it('drops entries that are not same-origin paths', () => {
    put({
      tabs: [
        { id: 'a', path: '/note/1' },
        { id: 'b', path: 'https://evil.example/x' },
        // Protocol-relative: starts with a slash, still leaves the site.
        { id: 'c', path: '//evil.example/x' },
        { id: 'd', path: 'javascript:alert(1)' },
      ],
      activeId: 'a',
    });
    expect(loadTabs()?.tabs.map((t) => t.path)).toEqual(['/note/1']);
  });

  it('drops duplicate ids and duplicate paths', () => {
    put({
      tabs: [
        { id: 'a', path: '/note/1' },
        { id: 'a', path: '/note/2' },
        { id: 'b', path: '/note/1' },
        { id: 'c', path: '/note/3' },
      ],
      activeId: 'a',
    });
    expect(loadTabs()?.tabs.map((t) => t.id)).toEqual(['a', 'c']);
  });

  it('falls back to the first tab when the stored active id is not among them', () => {
    put({ tabs: [{ id: 'a', path: '/' }], activeId: 'gone' });
    expect(loadTabs()?.activeId).toBe('a');
  });

  it('caps how many tabs a single stored value can mount on boot', () => {
    put({
      tabs: Array.from({ length: 200 }, (_, i) => ({ id: `t${i}`, path: `/note/${i}` })),
      activeId: 't0',
    });
    expect(loadTabs()!.tabs.length).toBeLessThanOrEqual(40);
  });
});
