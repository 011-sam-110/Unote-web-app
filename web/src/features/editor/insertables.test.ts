import { describe, expect, it } from 'vitest';
import { INSERT_ITEMS, INSERT_SECTIONS, NO_DEMO } from './insertables';

describe('insertables', () => {
  it('has unique ids', () => {
    // Deliberately no hard-coded item count: the whole point of this design is that
    // adding a block means appending ONE entry, and a count assertion would make it two.
    const ids = INSERT_ITEMS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(0);
  });

  it('every item sits in a declared section', () => {
    for (const i of INSERT_ITEMS) expect(INSERT_SECTIONS).toContain(i.section);
  });

  it('only the blocks that cannot honestly demo themselves have no demo', () => {
    // Five need something the reader supplies (a file, a board, a stroke) or are not a
    // block at all. The other four are the document's own structure: a heading demo is a
    // real heading, so it joined the note's outline and, for h1, put a second top-level
    // title mid-section; a divider demo was indistinguishable from the rules between
    // sections. NO_DEMO points at the note itself for those.
    const undemonstrated = INSERT_ITEMS.filter((i) => !i.example).map((i) => i.id).sort();
    expect(undemonstrated).toEqual([
      'canvas-snapshot', 'divider', 'h1', 'h2', 'h3', 'image', 'model3d', 'sketch', 'toc',
    ]);
  });

  it('gives a reason for every block it cannot demonstrate', () => {
    for (const i of INSERT_ITEMS) {
      if (i.example) continue;
      expect(NO_DEMO[i.id], `${i.id} needs a reason`).toBeTruthy();
    }
    // No stale reasons for blocks that CAN demo themselves.
    for (const id of Object.keys(NO_DEMO)) {
      expect(INSERT_ITEMS.find((i) => i.id === id)?.example).toBeUndefined();
    }
  });

  it('every demo returns at least one node, and never an empty array', () => {
    for (const i of INSERT_ITEMS) {
      if (!i.example) continue;
      const nodes = i.example();
      expect(nodes.length, `${i.id} produced no nodes`).toBeGreaterThan(0);
      for (const n of nodes) expect(typeof n.type).toBe('string');
    }
  });
});
