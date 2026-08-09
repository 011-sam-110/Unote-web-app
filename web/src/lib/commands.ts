// palette-nav - global command registry for the Ctrl/Cmd+P command palette.
//
// Cross-agent contract (docs/ITER2-PLAN.md): `registerCommands(cmds)` /
// `useCommands()`, with this exact minimal Command shape (id, title, hint?,
// section, keywords?, shortcut?, run(ctx)). No other agent registers commands
// this wave - CommandPalette.tsx wires every built-in itself - but the
// registry is generic on purpose so a future feature (a template picker, a
// jump-to-comment) can add its own commands without touching this file or
// CommandPalette.tsx.
//
// `run(ctx)` only ever receives `{ navigate }` per the contract, so anything
// context-dependent (per-notebook "Go to…", New note's notebook filing,
// Snapshot now, Study this notebook, the sidebar/theme toggles that need
// component state) is assembled directly inside CommandPalette.tsx instead of
// being registered here - this file only holds the commands that are truly
// global and context-free.
import { useEffect, useState } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import type { IconName } from '../components/Icon';
import { toggleTheme } from './theme';
import { openShortcuts, startTour } from '../features/onboarding/onboardingBus';
import { ensureReadme } from '../features/readme/ensureReadme';

export interface CommandContext {
  navigate: NavigateFunction;
}

export interface Command {
  id: string;
  title: string;
  hint?: string;
  section: string;
  keywords?: string[];
  shortcut?: string;
  /** Presentation only - additive to the wave's minimal contract shape, and
   *  optional, so a registrant that omits both falls back to a default glyph. */
  icon?: IconName;
  emoji?: string;
  /** The api method this command ultimately calls, keyed against BLOCKED in
   *  features/guest/guestApi.ts, and only present where it needs a server. Same field,
   *  same meaning as PaletteDoc.needs - the generated README marks both from it. */
  needs?: string;
  run: (ctx: CommandContext) => void | Promise<void>;
}

let registry: Command[] = [];
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

/** Adds (or replaces, by id) commands in the global palette registry. Returns
 *  an unregister function, for commands scoped to a component's lifetime. */
export function registerCommands(cmds: Command[]): () => void {
  const ids = new Set(cmds.map((c) => c.id));
  registry = [...registry.filter((c) => !ids.has(c.id)), ...cmds];
  notify();
  return () => {
    registry = registry.filter((c) => !ids.has(c.id));
    notify();
  };
}

/** Live, reactive view of every registered command - CommandPalette merges
 *  this with its own context-dependent commands before filtering/rendering. */
export function useCommands(): Command[] {
  const [snapshot, setSnapshot] = useState(registry);
  useEffect(() => {
    const listener = () => setSnapshot(registry);
    listeners.add(listener);
    listener(); // pick up anything registered between first render and this effect
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return snapshot;
}

/**
 * Simple subsequence fuzzy scorer: every character of `query` must appear in
 * `text`, in order (case-insensitive), gaps allowed - returns null when it
 * isn't a subsequence at all. Consecutive runs and an early match start score
 * higher, so typing "nn" ranks "New note" above a coincidental late match.
 * Good enough for a few dozen commands; no fuzzy-match dependency needed.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  let ti = 0;
  let score = 0;
  let consecutive = 0;
  let firstIndex = -1;
  for (let qi = 0; qi < q.length; qi++) {
    const idx = t.indexOf(q[qi], ti);
    if (idx === -1) return null;
    if (firstIndex === -1) firstIndex = idx;
    consecutive = idx === ti ? consecutive + 1 : 1;
    score += 10 + consecutive * 4 - (idx - ti);
    ti = idx + 1;
  }
  score += Math.max(0, 20 - firstIndex);
  score -= (t.length - q.length) * 0.5;
  return score;
}

/** Scores a command against a query across its title (weighted highest), then
 *  keywords, then hint - null when the query doesn't subsequence-match any. */
export function matchCommand(query: string, cmd: Pick<Command, 'title' | 'keywords' | 'hint'>): number | null {
  if (!query.trim()) return 0;
  const candidates: Array<[string, number]> = [[cmd.title, 1]];
  for (const k of cmd.keywords ?? []) candidates.push([k, 0.6]);
  if (cmd.hint) candidates.push([cmd.hint, 0.3]);
  let best: number | null = null;
  for (const [text, weight] of candidates) {
    const s = fuzzyScore(query, text);
    if (s === null) continue;
    const weighted = s * weight;
    if (best === null || weighted > best) best = weighted;
  }
  return best;
}

/** Fixed section order for the browse-with-empty-query view; any other
 *  section name (from a future registrant) is appended alphabetically after. */
export const SECTION_ORDER = ['Navigate', 'Create', 'Note', 'View', 'Study', 'Help'];

// ---------------------------------------------------------------------------
// Built-ins that need no page/route context beyond `navigate` - registered
// once, the moment this module is first imported (by CommandPalette.tsx).
//
// Exported as well as registered, from this one array literal, because the
// generated README documents EVERY command in the palette and the palette is
// these plus the context-dependent ones in components/paletteCatalog.ts. A
// second copy for the README would be a second thing to keep in step; reading
// the registry back out instead would depend on module import order.
// ---------------------------------------------------------------------------
export const GLOBAL_COMMANDS: Command[] = [
  {
    id: 'nav-home',
    title: 'Home',
    section: 'Navigate',
    hint: 'Dashboard: recent notes, pinned, stats',
    keywords: ['dashboard'],
    icon: 'home',
    run: (ctx) => ctx.navigate('/'),
  },
  {
    id: 'nav-study',
    title: 'Study',
    section: 'Navigate',
    hint: 'Review due flashcards',
    keywords: ['flashcards', 'review', 'srs', 'spaced repetition'],
    icon: 'layers',
    needs: 'review',
    run: (ctx) => ctx.navigate('/study'),
  },
  {
    id: 'nav-ask',
    title: 'Ask AI',
    section: 'Navigate',
    hint: 'Ask a question across your notes',
    keywords: ['ai', 'question', 'chat'],
    icon: 'sparkles',
    needs: 'aiAsk',
    run: (ctx) => ctx.navigate('/ask'),
  },
  {
    id: 'nav-search',
    title: 'Search page',
    section: 'Navigate',
    hint: 'Full-text search: tag:, notebook:, "phrase", -exclude',
    keywords: ['find', 'full-text', 'operators'],
    icon: 'search',
    run: (ctx) => ctx.navigate('/search'),
  },
  {
    id: 'nav-tags',
    title: 'Tags',
    section: 'Navigate',
    hint: 'Browse notes by tag',
    keywords: ['labels', 'hashtag'],
    // No matching Icon.tsx glyph - CommandPalette renders a small local hash
    // icon for this one id instead of an `icon`/`emoji` field.
    run: (ctx) => ctx.navigate('/tags'),
  },
  {
    id: 'view-theme',
    title: 'Toggle theme',
    section: 'View',
    hint: 'Switch between light and dark',
    keywords: ['dark mode', 'light mode', 'appearance'],
    icon: 'moon',
    run: () => {
      toggleTheme();
    },
  },
  // These two go through a module bus rather than being assembled in
  // CommandPalette.tsx, because the surfaces they open live in the App shell and
  // `run(ctx)` only ever receives `{ navigate }` per this file's contract.
  {
    id: 'help-tutorial',
    title: 'Take the tutorial',
    section: 'Help',
    hint: 'A guided walk through what Unote can do',
    keywords: ['onboarding', 'tour', 'guide', 'walkthrough', 'help', 'getting started'],
    icon: 'sparkles',
    run: () => startTour(),
  },
  {
    id: 'help-guide',
    title: 'Open the guide',
    section: 'Help',
    hint: 'The README: every command, in one note',
    keywords: ['readme', 'docs', 'documentation', 'guide', 'help', 'commands', 'manual'],
    icon: 'info',
    run: async (ctx) => {
      const id = await ensureReadme();
      if (id) ctx.navigate(`/note/${id}`);
    },
  },
  {
    id: 'help-shortcuts',
    title: 'Keyboard shortcuts',
    section: 'Help',
    hint: 'Every binding, in one list',
    shortcut: '?',
    keywords: ['keys', 'cheatsheet', 'bindings', 'help'],
    icon: 'info',
    run: () => openShortcuts(),
  },
];

registerCommands(GLOBAL_COMMANDS);
