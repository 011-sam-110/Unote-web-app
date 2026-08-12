// The user's own words.
//
// Stored in the existing local meta store rather than behind a new server table and route.
// That is not laziness: Unote has NO user-preferences surface at all today - `users` has no
// settings column, publicUser() returns id/email/displayName, and there is no settings
// route. docs/BACKLOG.md records the gap. Building one for this feature alone would mean a
// migration, a route and a sync WRITE_METHODS entry, and would still leave the dictionary
// unavailable offline, which is exactly when a student is most likely to add a word.
//
// The trade is explicit and worth stating: this dictionary is PER DEVICE. Adding "Falmer"
// on a laptop does not teach the phone. When a real user_settings table exists, this becomes
// one key in it and gains sync; nothing here has to change shape for that.
import { readMeta, writeMeta } from '../../../lib/local/db';
import { importWords } from './linter';

let cache: string[] | null = null;
/** Notified when the list changes, so an open menu re-reads rather than showing a stale set. */
const listeners = new Set<() => void>();

export async function loadCustomWords(): Promise<string[]> {
  if (cache) return cache;
  try {
    const raw = await readMeta('customDictionary');
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    cache = Array.isArray(parsed) ? parsed.filter((w): w is string => typeof w === 'string') : [];
  } catch {
    // A corrupt entry must not take the editor down with it.
    cache = [];
  }
  return cache;
}

/** Push the saved words into the engine. Safe to call before the engine has loaded. */
export async function primeDictionary(): Promise<void> {
  const words = await loadCustomWords();
  if (words.length) await importWords(words);
}

export async function addCustomWord(word: string): Promise<void> {
  const trimmed = word.trim();
  if (!trimmed) return;
  const words = await loadCustomWords();
  // Case-insensitive: a student who taught it "Falmer" should not be asked again for "falmer".
  if (words.some((w) => w.toLowerCase() === trimmed.toLowerCase())) return;
  cache = [...words, trimmed];
  await writeMeta('customDictionary', JSON.stringify(cache));
  await importWords([trimmed]);
  listeners.forEach((fn) => fn());
}

export function onDictionaryChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Test seam. */
export function __resetDictionaryForTests(): void {
  cache = null;
  listeners.clear();
}
