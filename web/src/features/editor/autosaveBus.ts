// Lets in-editor navigation (e.g. clicking a wikilink) flush the currently-open
// note's pending autosave *before* it leaves, so a just-made edit (like the link
// you're following) is durably persisted and visible on the destination note -
// rather than racing the next page's data fetch.
//
// It used to be a single flusher, on the stated grounds that only one note editor is
// mounted at a time. Tabs ended that: up to four notes are mounted at once, each with its
// own autosave still running, and a background tab that has unsaved work is exactly the
// one whose edit is easiest to lose. So this is a registry keyed by tab.
//
// Closing the WINDOW is already covered without any help from here - useAutosave registers
// its own beforeunload per instance, so every mounted note saves itself. What needed a new
// entry point is closing a TAB, which unmounts one note while the page lives on.
type Flusher = () => Promise<void>;

const flushers = new Map<string, Flusher>();

/** The tab whose note is on screen. Only one, by definition. */
let activeKey: string | null = null;

/** The key a note page uses when it is rendered outside a tab pane. */
export const SOLO_KEY = 'solo';

export function registerFlush(key: string, fn: Flusher | null): void {
  if (fn) flushers.set(key, fn);
  else flushers.delete(key);
}

export function setActiveFlushKey(key: string): void {
  activeKey = key;
}

/** Only clears if this key is still the one holding it. Two panes swapping which is
 *  active run their effects in one commit, and an unconditional clear on the way out
 *  would wipe the incoming pane's claim. */
export function clearActiveFlushKey(key: string): void {
  if (activeKey === key) activeKey = null;
}

async function run(fn: Flusher | undefined): Promise<void> {
  if (!fn) return;
  try {
    await fn();
  } catch {
    // A failed save shouldn't block navigation - the autosave chip surfaces the error.
  }
}

/** The note the user is looking at. */
export async function flushActiveNote(): Promise<void> {
  await run(activeKey ? flushers.get(activeKey) : undefined);
}

/** One particular tab, whether or not it is the visible one - used on the way to closing
 *  it, while its editor is still mounted and has something to save. */
export async function flushTabNote(key: string): Promise<void> {
  await run(flushers.get(key));
}
