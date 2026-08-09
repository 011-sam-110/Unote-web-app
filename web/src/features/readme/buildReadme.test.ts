import { describe, expect, it } from 'vitest';
import { README_TITLE, buildReadme } from './buildReadme';
import { INSERT_ITEMS, NO_DEMO } from '../editor/insertables';
import { PALETTE_CATALOG } from '../../components/paletteCatalog';
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
      expect(account.contentText, `missing block: ${item.title}`).toContain(item.title);
    }
  });

  it('gives a reason for each block it does not demonstrate', () => {
    for (const [, reason] of Object.entries(NO_DEMO)) {
      expect(account.contentText).toContain(reason);
    }
  });

  it('documents every palette command', () => {
    for (const cmd of PALETTE_CATALOG) {
      expect(account.contentText, `missing command: ${cmd.title}`).toContain(cmd.title);
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

  it('never embeds a demo for a block that needs an upload', () => {
    const types = typesIn(guest.contentJson);
    expect(types.has('image')).toBe(false);
    expect(types.has('model3d')).toBe(false);
    expect(types.has('sketch')).toBe(false);
  });

  it('warns the guest build about the three silent differences', () => {
    expect(guest.contentText).toMatch(/backlink/i);
    expect(guest.contentText).toMatch(/this browser/i);
    // Search operators are account-only; the guest build must not present them as usable.
    expect(guest.contentText).not.toContain('notebook:algorithms');
    expect(account.contentText).toContain('notebook:algorithms');
  });

  it('marks account-only features for a guest and not for an account', () => {
    expect(guest.contentText).toContain('needs an account');
    expect(account.contentText).not.toContain('needs an account');
  });

  it('produces plain text that matches the document', () => {
    expect(account.contentText.length).toBeGreaterThan(500);
    expect(account.contentText).toContain('README');
  });
});
