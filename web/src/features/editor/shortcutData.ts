// The keyboard bindings, as data.
//
// Every binding here was read off the code that implements it, not off a spec -
// lib/useShortcuts.ts for the global chords, NotePage.tsx for the note-page window
// listener (Ctrl+S/F/H), SearchPage.tsx for "/", ReviewTab.tsx for the review keys, and
// TipTap's StarterKit defaults for the formatting marks. A cheatsheet that lists a
// shortcut which does not fire is worse than no cheatsheet.
//
// Extracted from ShortcutsSheet.tsx so the generated README documents the same list the
// "?" sheet shows, from one definition.

export interface Row {
  keys: string[];
  label: string;
}

export interface Group {
  name: string;
  rows: Row[];
}

/** `mod` and `shift` are passed in because the sheet renders ⌘/⇧ on a Mac and spells the
 *  modifiers out everywhere else - "⌘" on a Windows machine is just noise. */
export function shortcutGroups(mod: string, shift: string): Group[] {
  return [
    {
      name: 'Anywhere',
      rows: [
        { keys: [mod, 'K'], label: 'Jump to a note' },
        { keys: [mod, 'P'], label: 'Command palette: run anything' },
        { keys: [mod, 'N'], label: 'New note in the current notebook' },
        { keys: [mod, shift, 'F'], label: 'Search your notes' },
        { keys: [mod, '\\'], label: 'Show or hide the sidebar' },
        { keys: ['?'], label: 'This cheatsheet' },
        { keys: ['Esc'], label: 'Close whatever is open' },
      ],
    },
    {
      name: 'Writing',
      rows: [
        { keys: ['/'], label: 'Slash menu: headings, lists, tables, callouts' },
        { keys: ['[', '['], label: 'Link another note' },
        { keys: ['#', 'Space'], label: 'Heading (and "- " a bullet, "> " a quote)' },
        { keys: [mod, 'B'], label: 'Bold' },
        { keys: [mod, 'I'], label: 'Italic' },
        { keys: [mod, 'U'], label: 'Underline' },
        { keys: [mod, 'E'], label: 'Inline code' },
        { keys: [mod, 'Z'], label: 'Undo' },
      ],
    },
    {
      name: 'On a note',
      rows: [
        { keys: [mod, 'S'], label: 'Save a named version you can restore' },
        { keys: [mod, 'F'], label: 'Find in this note' },
        { keys: [mod, 'H'], label: 'Find and replace' },
        { keys: ['Tab'], label: 'Move between columns' },
      ],
    },
    {
      name: 'Search page',
      rows: [{ keys: ['/'], label: 'Focus the search box' }],
    },
    {
      name: 'Reviewing flashcards',
      rows: [
        { keys: ['Space'], label: 'Show the answer' },
        { keys: ['1'], label: 'Again' },
        { keys: ['2'], label: 'Hard' },
        { keys: ['3'], label: 'Good' },
        { keys: ['4'], label: 'Easy' },
      ],
    },
  ];
}

/** Derived, never typed by hand - the README prints it. */
export const SHORTCUT_COUNT: number = shortcutGroups('Ctrl', 'Shift').reduce(
  (n, g) => n + g.rows.length,
  0,
);
