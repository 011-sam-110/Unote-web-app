import { describe, expect, it } from 'vitest';
import { README_TITLE, buildReadme } from './buildReadme';
import { INSERT_ITEMS, INSERT_SECTIONS, NO_DEMO } from '../editor/insertables';
import { PALETTE_CATALOG } from '../../components/paletteCatalog';
import { GLOBAL_COMMANDS } from '../../lib/commands';
import { shortcutGroups } from '../editor/shortcutData';
import { FEATURE_SECTIONS } from './featureCatalog';

/** Every node type buildExtensions.ts registers. A type outside this set renders as
 *  nothing in the editor, which is invisible in the JSON and obvious on screen. */
const SCHEMA_TYPES = new Set([
  'doc', 'paragraph', 'text', 'heading', 'bulletList', 'orderedList', 'listItem',
  'taskList', 'taskItem', 'blockquote', 'codeBlock', 'horizontalRule', 'hardBreak',
  'table', 'tableRow', 'tableHeader', 'tableCell', 'image', 'callout', 'details',
  'detailsSummary', 'detailsContent', 'columnList', 'column', 'chem', 'model3d',
  'sketch', 'wikilink', 'inlineMath', 'blockMath',
]);

function typesIn(node: Record<string, unknown>, seen = new Set<string>()): Set<string> {
  if (typeof node?.type === 'string') seen.add(node.type);
  for (const child of (node?.content as Record<string, unknown>[] | undefined) ?? []) {
    typesIn(child, seen);
  }
  return seen;
}

describe('buildReadme', () => {
  const account = buildReadme({ guest: false });
  const guest = buildReadme({ guest: true });

  /** Every table cell is its own paragraph, so a cell's text is a line of its own.
   *  Matching whole lines rather than substrings is what makes the short titles
   *  load-bearing: "Text" appears inside a palette hint, "Table" inside "/Table of
   *  contents", and "New note" inside "New notebook". */
  const lines = (doc: { contentText: string }) => new Set(doc.contentText.split('\n'));
  const accountLines = lines(account);

  it('is titled README and tagged', () => {
    expect(account.title).toBe(README_TITLE);
    expect(account.tags).toEqual(['unote', 'guide']);
  });

  it('emits a doc whose every node type the editor can render', () => {
    for (const doc of [account, guest]) {
      for (const type of typesIn(doc.contentJson)) {
        expect(SCHEMA_TYPES.has(type), `unknown node type: ${type}`).toBe(true);
      }
    }
  });

  it('documents every insert block', () => {
    for (const item of INSERT_ITEMS) {
      // The `/Title` form the reference table actually prints.
      expect(accountLines.has(`/${item.title}`), `missing block: /${item.title}`).toBe(true);
    }
  });

  it('gives a reason for each block it does not demonstrate', () => {
    for (const [, reason] of Object.entries(NO_DEMO)) {
      expect(account.contentText).toContain(reason);
    }
  });

  it('never leaves a blank cell where a reason belongs', () => {
    // The reverse direction - every reason reaches the page - is the test above. Without
    // this one a block with neither an example nor a NO_DEMO entry renders an empty cell,
    // which looks like a rendering bug and fails nothing.
    for (const item of INSERT_ITEMS) {
      if (item.example) continue;
      expect(NO_DEMO[item.id], `${item.id} would render a blank cell`).toBeTruthy();
    }
  });

  it('documents every palette command, both halves of it', () => {
    // The palette is PALETTE_CATALOG (context commands) plus the globals lib/commands.ts
    // registers. The note's toggle says "every command", so both have to be in it.
    for (const cmd of [...PALETTE_CATALOG, ...GLOBAL_COMMANDS]) {
      expect(accountLines.has(cmd.title), `missing command: ${cmd.title}`).toBe(true);
    }
  });

  it('documents every keyboard shortcut', () => {
    for (const group of shortcutGroups('Ctrl', 'Shift')) {
      for (const row of group.rows) {
        expect(account.contentText, `missing binding: ${row.label}`).toContain(row.label);
      }
    }
  });

  it('documents every feature section', () => {
    for (const section of FEATURE_SECTIONS) {
      expect(account.contentText).toContain(section.title);
      for (const line of section.lines) expect(account.contentText).toContain(line.what);
    }
  });

  it('actually uses the blocks it documents', () => {
    const types = typesIn(account.contentJson);
    for (const type of ['callout', 'columnList', 'details', 'taskList', 'table',
                        'blockquote', 'codeBlock', 'horizontalRule', 'inlineMath',
                        'blockMath', 'chem']) {
      expect(types.has(type), `README does not contain a ${type}`).toBe(true);
    }
  });

  it('never fakes a render for a block it cannot demonstrate', () => {
    // Neither flavour, not just the guest one: an image node with no uploaded file is a
    // broken picture in an account's note too.
    for (const doc of [account, guest]) {
      const types = typesIn(doc.contentJson);
      for (const type of ['image', 'model3d', 'sketch']) {
        expect(types.has(type), `README contains a ${type}`).toBe(false);
      }
    }
    // And the converse of the blank-cell guard: a block that demonstrates itself must not
    // also carry a reason, or the note prints an excuse next to a live example.
    for (const item of INSERT_ITEMS) {
      if (!item.example) continue;
      expect(NO_DEMO[item.id], `${item.id} demos itself AND gives a reason`).toBeUndefined();
    }
  });

  it('warns the guest build about the three silent differences', () => {
    expect(guest.contentText).toMatch(/backlink/i);
    expect(guest.contentText).toMatch(/this browser/i);
    // Search operators are account-only; the guest build must not present them as usable
    // ANYWHERE, including in the hint the Search page command carries into the table.
    expect(guest.contentText).not.toContain('notebook:algorithms');
    expect(guest.contentText).not.toContain('notebook:');
    expect(account.contentText).toContain('notebook:algorithms');
  });

  it('marks account-only features for a guest and not for an account', () => {
    expect(guest.contentText).toContain('needs an account');
    expect(account.contentText).not.toContain('needs an account');
  });

  it('produces plain text that matches the document', () => {
    expect(account.contentText.length).toBeGreaterThan(500);
    expect(account.contentText).toContain('Unote is a place to write, link and revise.');
    // NotePage renders the title in its own field above the body, so the body must not
    // open with it - a reader would see "README" twice.
    expect(account.contentText.startsWith(README_TITLE)).toBe(false);
  });

  it('counts demonstrated blocks, not the nodes they emit', () => {
    // This summary once read "6 blocks, 4 of them shown live" for Notation, because it
    // counted emitted nodes and chemistry returns two (a lead-in paragraph plus the
    // molecule). Every other group was right only by accident. Checked against the
    // registry rather than against literals, so it survives a block being added.
    for (const section of INSERT_SECTIONS) {
      const items = INSERT_ITEMS.filter((i) => i.section === section);
      if (items.length === 0) continue;
      const shown = items.filter((i) => i.example).length;
      const label = `${items.length} block${items.length === 1 ? '' : 's'}`;
      const expected = shown > 0 ? `${label}, ${shown} of them shown live` : label;
      expect(account.contentText, `wrong summary for ${section}`).toContain(expected);
    }
  });
});
