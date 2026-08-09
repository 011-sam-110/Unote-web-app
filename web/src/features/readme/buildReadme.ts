// The README note, generated.
//
// Reads six sources and emits one TipTap document:
//   INSERT_ITEMS + INSERT_SECTIONS  (editor/insertables.ts)     - section 02
//   PALETTE_CATALOG                 (components/paletteCatalog) - section 04
//   GLOBAL_COMMANDS                 (lib/commands.ts)           - section 04
//   shortcutGroups()                (editor/shortcutData.ts)    - section 04
//   FEATURE_SECTIONS                (./featureCatalog.ts)       - sections 05-09
//   BLOCKED                         (guest/guestApi.ts)         - every account-only mark
//
// TipTap JSON rather than Markdown, deliberately: callouts, columns, toggles, chem and
// math have no Markdown spelling, and this note is built out of the blocks it documents.
// Markdown remains the export format.
// Only what this file uses: the demos for math, code and chem come from each block's own
// `example`, not from here.
//
// Heading levels are the document's own structure AND four blocks' demonstration of
// themselves (see NO_DEMO in insertables.ts): h1 is a section title, h2 a group title
// inside section 02, h3 a column label. Emitting a heading anywhere else puts a line in
// the reader's outline panel that is not a part of this note.
//
// Note the title is NOT emitted here: NotePage renders it in its own field above the
// body, so an h1 "README" would be the second one on screen.
import {
  boldText, bullets, callout, codeText, columns, divider, doc, h,
  p, table, todo, toggle, toPlainText, type Inline, type Node,
} from '../editor/docBuilders';
import { INSERT_ITEMS, INSERT_SECTIONS, NO_DEMO, type InsertItem } from '../editor/insertables';
import { PALETTE_CATALOG } from '../../components/paletteCatalog';
import { GLOBAL_COMMANDS, SECTION_ORDER } from '../../lib/commands';
import { SHORTCUT_COUNT, shortcutGroups } from '../editor/shortcutData';
import { FEATURE_SECTIONS } from './featureCatalog';
import { guestBlockedMessage } from '../guest/guestApi';

export const README_TITLE = 'README';
const README_TAGS = ['unote', 'guide'];

export interface ReadmeDoc {
  title: string;
  tags: string[];
  contentJson: Record<string, unknown>;
  contentText: string;
}

const GATE = 'needs an account';

/** The generic fallback guestBlockedMessage returns for a method it does not know. Used
 *  to tell "genuinely blocked" apart from "unrecognised method name". */
const GENERIC_BLOCK = guestBlockedMessage('__unknown__');

function isGated(method: string | undefined): boolean {
  if (!method) return false;
  return guestBlockedMessage(method) !== GENERIC_BLOCK;
}

/** The trailing cell of a reference row: a gate mark for a guest, empty otherwise. */
function gateCell(guest: boolean, method: string | undefined): Inline[] {
  return guest && isGated(method) ? [GATE] : [];
}

/**
 * Which api method an insert block ultimately needs. Only the gated ones appear.
 *
 * All three are `uploadImage`, which is about having somewhere to keep a file rather
 * than about boards or the import wizard - and that is what a guest actually lacks.
 * `canvas-snapshot` writes an image into a note (CanvasInsertModal.tsx:71 calls
 * api.uploadImage; the board is only where the picture came from). `model3d` posts by
 * raw XHR to /api/import/file, which no api-client method covers - `uploadImportFile`
 * is a DIFFERENT endpoint (/api/import/batches/:id/items) and naming it here would
 * describe the block as part of the import wizard, which it is not.
 */
const BLOCK_NEEDS: Record<string, string> = {
  image: 'uploadImage',
  model3d: 'uploadImage',
  'canvas-snapshot': 'uploadImage',
};

function insertRows(guest: boolean, items: InsertItem[]): Inline[][][] {
  return items.map((item) => {
    // Both, not one or the other: "needs a file you upload" says what the block wants and
    // is true in every build, and the gate says who can give it to the block. Replacing
    // the first with the second lost a guest the more useful half.
    const reason = item.example ? '' : (NO_DEMO[item.id] ?? '');
    const gated = gateCell(guest, BLOCK_NEEDS[item.id]).length > 0;
    const trailing: Inline[] = gated ? [reason ? `${reason} — ${GATE}` : GATE] : [reason];
    // The title verbatim, not lower-cased: it is the block's name as the menu shows it,
    // the string the coverage test looks for, and the slash menu matches case-insensitively.
    return [[codeText(`/${item.title}`)], [item.description], trailing];
  });
}

function insertSection(guest: boolean): Node[] {
  const out: Node[] = [
    h(1, '02 · Everything you can insert'),
    p('Type ', codeText('/'), ' and the name, or use the ', codeText('+'), ' in the left margin.'),
  ];

  for (const section of INSERT_SECTIONS) {
    const items = INSERT_ITEMS.filter((i) => i.section === section);
    if (items.length === 0) continue;

    // The demos go INSIDE the group's toggle, under its reference table. A toggle opens
    // closed, so demos left as siblings after it read as unlabelled fragments belonging
    // to whichever group the reader last opened.
    const demos: Node[] = [];
    for (const item of items) {
      if (!item.example) continue;
      demos.push(...item.example());
    }

    const count = `${items.length} block${items.length === 1 ? '' : 's'}`;
    out.push(
      h(2, section),
      toggle(demos.length > 0 ? `${count}, ${demos.length} of them shown live` : count, [
        table(['Command', 'Inserts', ''], insertRows(guest, items)),
        ...demos,
      ]),
    );
  }
  return out;
}

function writeSection(): Node[] {
  return [
    h(1, '01 · Write'),
    p('Markdown works as you type. Start a line with any of these and it becomes the thing:'),
    columns([
      [
        h(3, 'Type this'),
        p(codeText('# '), ' ', codeText('## '), ' ', codeText('### ')),
        p(codeText('- '), ' then Tab to nest'),
        p(codeText('1. ')),
        p(codeText('> ')),
        p(codeText('```')),
      ],
      [
        h(3, 'Get this'),
        p('Headings, three levels'),
        p('A bullet list'),
        p('A numbered list'),
        p('A quote'),
        p('A code block'),
      ],
    ]),
    p('That two-column layout is itself a block. Marks are the usual ones: Ctrl+B bold, Ctrl+I italic, Ctrl+U underline, Ctrl+E inline code.'),
    // No hand-written quote here: /Quote's own demo in section 02 says the same sentence,
    // and the reader met it twice within a page.
  ];
}

function connectSection(guest: boolean): Node[] {
  const backlinks = guest
    ? 'Backlinks arrive with an account: without one there is no server to work out what points here.'
    : 'Every note lists its backlinks, so you can find the notes pointing at this one.';
  return [
    h(1, '03 · Connect'),
    columns([
      [h(3, 'Link'), p('Type ', codeText('[['), ' and pick a note. It becomes a real link, not text.')],
      [h(3, 'Tag'), p('Write ', codeText('#revision'), ' anywhere in a sentence and the note files itself under it.')],
      [h(3, 'Come back'), p(backlinks)],
    ]),
  ];
}

/** Title, hint, section and gate for one palette command, whichever half it comes from. */
interface CommandDoc {
  id: string;
  title: string;
  hint: string;
  section: string;
  needs?: string;
}

/**
 * Hints reworded for a guest build, by command id.
 *
 * Not a gate: the search page opens for a guest and finds notes, so marking it "needs an
 * account" would be a lie in the other direction. Only the WORDS are wrong - guest search
 * is substring matching (guestApi.search), and this hint's operator list contradicted the
 * sentence four lines above it saying operators need an account.
 */
const GUEST_HINTS: Record<string, string> = {
  'nav-search': 'Finds any note containing what you type',
};

/**
 * Every command Ctrl+P offers, in the order the palette itself groups them.
 *
 * The palette is two halves: the context-dependent ones CommandPalette.tsx assembles
 * (their words live in paletteCatalog.ts) and the global ones lib/commands.ts registers.
 * The note claims to list every command, so it reads both and never a count of its own.
 *
 * A function, not a module-level const, deliberately: lib/commands.ts will import
 * ensureReadme -> buildReadme once "Open the guide" exists, and reading GLOBAL_COMMANDS
 * at this module's top level would then hit it mid-initialisation.
 */
function paletteCommands(guest: boolean): CommandDoc[] {
  const hint = (id: string, own: string | undefined) =>
    (guest ? GUEST_HINTS[id] : undefined) ?? own ?? '';
  const merged: CommandDoc[] = [
    ...PALETTE_CATALOG.map((c) => ({ id: c.id, title: c.title, hint: hint(c.id, c.hint), section: c.section, needs: c.needs })),
    ...GLOBAL_COMMANDS.map((c) => ({ id: c.id, title: c.title, hint: hint(c.id, c.hint), section: c.section, needs: c.needs })),
  ];
  const rank = (s: string) => {
    const i = SECTION_ORDER.indexOf(s);
    return i === -1 ? SECTION_ORDER.length : i;
  };
  // Stable, so commands keep their catalog order inside a section.
  return merged.sort((a, b) => rank(a.section) - rank(b.section));
}

function findSection(guest: boolean): Node[] {
  const keyCol: Node[] = [h(3, 'Keys worth learning')];
  for (const group of shortcutGroups('Ctrl', 'Shift')) {
    keyCol.push(p(boldText(group.name)));
    for (const row of group.rows) {
      // A guest still HAS the key - it is the feature behind it that needs a server - so
      // the binding is listed and marked rather than hidden.
      const gate: Inline[] = guest && isGated(row.needs) ? [' — ', GATE] : [];
      keyCol.push(p(codeText(row.keys.join(' + ')), ' — ', row.label, ...gate));
    }
  }

  const searchCol: Node[] = [h(3, 'Search understands')];
  if (guest) {
    searchCol.push(
      p('Search matches any note containing what you type.'),
      // Spelled out rather than splicing GATE onto a plural subject.
      p('Operators like ', codeText('tag:'), ' and ', codeText('-exclude'), ' need an account.'),
    );
  } else {
    searchCol.push(
      p(codeText('tag:revision'), ' — only that tag'),
      p(codeText('notebook:algorithms'), ' — only that notebook'),
      p(codeText('"decision tree"'), ' — that exact phrase'),
      p(codeText('-quicksort'), ' — everything but'),
    );
  }

  const commands = paletteCommands(guest);
  const commandRows: Inline[][][] = commands.map((cmd) => [
    [cmd.title],
    [cmd.hint],
    gateCell(guest, cmd.needs),
  ]);

  return [
    h(1, '04 · Find'),
    p('Press ', codeText('Ctrl+P'), ' to run any command, or ', codeText('?'), ` for all ${SHORTCUT_COUNT} bindings.`),
    columns([keyCol, searchCol]),
    toggle(`Every command in the palette — ${commands.length}`, [
      table(['Command', 'Does', ''], commandRows),
    ]),
  ];
}

function featureSections(guest: boolean): Node[] {
  const out: Node[] = [];
  for (const section of FEATURE_SECTIONS) {
    out.push(h(1, `${section.number} · ${section.title}`), p(section.blurb));
    out.push(
      bullets(
        section.lines.map((line): Inline[] =>
          guest && isGated(line.needs) ? [line.what, ` — ${GATE}`] : [line.what],
        ),
      ),
    );
  }
  return out;
}

function closing(guest: boolean): Node[] {
  if (guest) {
    return [
      callout('🔑', 'warn', [
        p('You are trying Unote without an account. Everything above works and stays in this browser — nothing is sent anywhere, and nothing survives clearing your browser data.'),
        p('Boards, flashcards, images, imports, AI and sharing need a server. Make an account and they turn on, with these notes carried over.'),
      ]),
    ];
  }
  return [
    callout('✓', 'ok', [
      p('That is the whole tool. Press ', codeText('Ctrl+P'), ' and pick "Open the guide" to get this note back at any time.'),
    ]),
  ];
}

export function buildReadme(opts: { guest: boolean }): ReadmeDoc {
  const { guest } = opts;

  const content: Node[] = [
    p('Unote is a place to write, link and revise. This note is the short version of everything it does — and it is built out of the blocks it describes, so you are already looking at most of them. It is an ordinary note: edit it, take it apart, delete it.'),
    callout('💡', 'info', [
      p('Put your cursor on any empty line and press ', codeText('/'), `. That one key reaches all ${INSERT_ITEMS.length} blocks below.`),
    ]),
    divider(),
    ...writeSection(),
    todo([
      { checked: true, content: ['Read this far'] },
      { checked: false, content: ['Press ', codeText('/'), ' on an empty line and insert a callout'] },
      { checked: false, content: ['Type ', codeText('[['), ' and link this note to a new one'] },
      { checked: false, content: ['Press ', codeText('Ctrl+K'), ' and come back here by name'] },
    ]),
    divider(),
    ...insertSection(guest),
    divider(),
    ...connectSection(guest),
    divider(),
    ...findSection(guest),
    divider(),
    ...featureSections(guest),
    divider(),
    ...closing(guest),
  ];

  const contentJson = doc(content);
  return {
    title: README_TITLE,
    tags: README_TAGS,
    contentJson,
    contentText: toPlainText(contentJson),
  };
}
