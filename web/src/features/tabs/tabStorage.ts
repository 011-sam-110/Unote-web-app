// Where the open tabs live between visits: this browser, this device.
//
// Not the server, deliberately. The set of notes open on a phone is rarely the set open
// on a laptop, and syncing them would need a rule for two devices writing at once to buy
// a behaviour nobody asked for. It also means a guest session - which has no account to
// hang anything off - restores its tabs like everyone else.
import type { TabsState } from './tabTypes';

const KEY = 'unote.tabs.v1';

/** Enough for any real workspace. The cap exists so a corrupted or hostile write cannot
 *  make the app mount an unbounded strip on boot. */
const MAX_TABS = 40;
const MAX_PATH = 512;

/** Reads whatever is in storage and returns it only if it is still a usable tab list.
 *  Anything malformed is discarded rather than repaired - a half-restored strip is harder
 *  to explain than an empty one. */
export function loadTabs(): TabsState | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return null; // private mode, or storage disabled
  }
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const { tabs, activeId } = parsed as { tabs?: unknown; activeId?: unknown };
    if (!Array.isArray(tabs) || typeof activeId !== 'string') return null;

    const seen = new Set<string>();
    const clean = tabs
      .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
      .map((t) => ({
        id: typeof t.id === 'string' ? t.id : '',
        path: typeof t.path === 'string' ? t.path : '',
        label: typeof t.label === 'string' ? t.label.slice(0, 200) : undefined,
        dot: typeof t.dot === 'string' ? t.dot.slice(0, 32) : undefined,
      }))
      // Same-origin paths only. A stored "//evil.example" or "https://…" would otherwise
      // become a link the app navigates itself to on boot.
      .filter((t) => t.id && t.path.startsWith('/') && !t.path.startsWith('//') && t.path.length <= MAX_PATH)
      .filter((t) => {
        if (seen.has(t.id) || seen.has(t.path)) return false;
        seen.add(t.id);
        seen.add(t.path);
        return true;
      })
      .slice(0, MAX_TABS);

    if (clean.length === 0) return null;
    return { tabs: clean, activeId: clean.some((t) => t.id === activeId) ? activeId : clean[0].id };
  } catch {
    return null;
  }
}

export function saveTabs(state: TabsState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ tabs: state.tabs.slice(0, MAX_TABS), activeId: state.activeId }));
  } catch {
    // Quota or private mode. Tabs still work for this session; they just will not come back.
  }
}
