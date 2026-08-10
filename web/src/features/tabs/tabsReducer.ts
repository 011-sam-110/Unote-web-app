// Every transition the tab strip can make, as pure functions over TabsState.
//
// Pure and separate from the provider on purpose: the provider has to know the NEXT state
// before it can navigate (closing the active tab has to route to whichever tab takes
// over), and a reducer hidden behind a dispatch cannot tell it that. It also means the
// interesting rules - dedupe, which tab takes over from a closed one, never being empty -
// are testable without a router or a DOM.
import type { OpenMode, Tab, TabsState } from './tabTypes';

/** The tab a fresh install starts with, and what closing the last tab falls back to. */
export const HOME_PATH = '/';

let counter = 0;

export function newTabId(): string {
  // randomUUID is unavailable over plain http on a LAN address, which is exactly how the
  // dev server is reached from a phone. The counter is only ever compared against other
  // ids in this tab list, so uniqueness within the session is all it has to carry.
  try {
    return crypto.randomUUID();
  } catch {
    counter += 1;
    return `tab-${Date.now()}-${counter}`;
  }
}

export function makeTab(path: string, extra?: Partial<Tab>): Tab {
  return { id: newTabId(), path, ...extra };
}

export function activeTab(state: TabsState): Tab | undefined {
  return state.tabs.find((t) => t.id === state.activeId);
}

export function initialState(path: string = HOME_PATH): TabsState {
  const tab = makeTab(path);
  return { tabs: [tab], activeId: tab.id };
}

/**
 * Open `path`.
 *
 * Dedupe comes first and applies to every mode, including the explicit ones: asking for a
 * new tab on a note you already have open gives you the tab you already have, not a
 * second copy of the same note with two editors racing to autosave it.
 */
export function openPath(state: TabsState, path: string, mode: OpenMode = 'replace'): TabsState {
  const existing = state.tabs.find((t) => t.path === path);
  if (existing) {
    return mode === 'background' ? state : { ...state, activeId: existing.id };
  }

  if (mode === 'replace') {
    const current = activeTab(state);
    if (!current) return openPath(state, path, 'new');
    // A move, not a new tab: the label and dot belonged to where this tab USED to be, so
    // they are dropped and re-published by whatever loads next. Keeping them would leave
    // the strip naming the previous note until the new one finished loading.
    return {
      ...state,
      tabs: state.tabs.map((t) => (t.id === current.id ? { id: t.id, path } : t)),
    };
  }

  // Beside the active tab rather than at the end, so a note opened from the one you are
  // reading lands next to it.
  const tab = makeTab(path);
  const at = state.tabs.findIndex((t) => t.id === state.activeId);
  const tabs = [...state.tabs];
  tabs.splice(at < 0 ? tabs.length : at + 1, 0, tab);
  return { tabs, activeId: mode === 'background' ? state.activeId : tab.id };
}

export function activate(state: TabsState, id: string): TabsState {
  if (!state.tabs.some((t) => t.id === id) || state.activeId === id) return state;
  return { ...state, activeId: id };
}

/**
 * Close one tab and decide what takes over.
 *
 * The neighbour to the RIGHT wins, falling back to the left at the end of the strip.
 * Closing a run of tabs left to right then keeps working through them rather than jumping
 * backwards after each one.
 */
export function closeTab(state: TabsState, id: string): TabsState {
  const at = state.tabs.findIndex((t) => t.id === id);
  if (at < 0) return state;

  const tabs = state.tabs.filter((t) => t.id !== id);
  if (tabs.length === 0) return initialState();
  if (state.activeId !== id) return { ...state, tabs };

  const next = tabs[at] ?? tabs[at - 1];
  return { tabs, activeId: next.id };
}

export function closeOthers(state: TabsState, id: string): TabsState {
  const keep = state.tabs.find((t) => t.id === id);
  if (!keep) return state;
  return { tabs: [keep], activeId: keep.id };
}

export function closeToRight(state: TabsState, id: string): TabsState {
  const at = state.tabs.findIndex((t) => t.id === id);
  if (at < 0) return state;
  const tabs = state.tabs.slice(0, at + 1);
  // The active tab may have just been closed along with the rest of the right-hand side.
  const activeId = tabs.some((t) => t.id === state.activeId) ? state.activeId : tabs[at].id;
  return { tabs, activeId };
}

/** Drag-reorder. `to` is an index into the current list. */
export function moveTab(state: TabsState, id: string, to: number): TabsState {
  const from = state.tabs.findIndex((t) => t.id === id);
  if (from < 0) return state;
  const target = Math.max(0, Math.min(state.tabs.length - 1, to));
  if (from === target) return state;
  const tabs = [...state.tabs];
  const [moved] = tabs.splice(from, 1);
  tabs.splice(target, 0, moved);
  return { ...state, tabs };
}

/** Step through the strip, wrapping at both ends. */
export function step(state: TabsState, delta: number): TabsState {
  const at = state.tabs.findIndex((t) => t.id === state.activeId);
  if (at < 0 || state.tabs.length < 2) return state;
  const next = (at + delta + state.tabs.length) % state.tabs.length;
  return { ...state, activeId: state.tabs[next].id };
}

/** What a loaded page calls itself. Identical values are dropped so a page republishing
 *  the same title on every keystroke does not re-render the whole strip. */
export function setIdentity(state: TabsState, id: string, next: { label?: string; dot?: string }): TabsState {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab) return state;
  const label = next.label ?? tab.label;
  const dot = next.dot ?? tab.dot;
  if (tab.label === label && tab.dot === dot) return state;
  return { ...state, tabs: state.tabs.map((t) => (t.id === id ? { ...t, label, dot } : t)) };
}

/** Follow a URL change that did not come from the strip - a redirect, the back button, or
 *  any of the app's several hundred existing <Link>s. An open tab wins; otherwise the
 *  active tab moves, which is what makes an ordinary link click load in place. */
export function syncUrl(state: TabsState, path: string): TabsState {
  const current = activeTab(state);
  if (current?.path === path) return state;
  return openPath(state, path, 'replace');
}
