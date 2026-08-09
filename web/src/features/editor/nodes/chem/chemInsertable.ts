// Insert-menu descriptor for the Chemistry structure block. Section 'Notation' (alongside
// math). The InsertItem / InsertSection types below match the shared editor contract; they
// are declared locally so this module typechecks standalone, and the parent's structurally
// identical InsertItem accepts `chemInsertable` when it is wired into the Insert menu.
import type { Editor } from '@tiptap/core';
import { chem, p } from '../../docBuilders';

export type InsertSection = 'Basic' | 'Lists' | 'Notation' | 'Media' | 'Layout' | 'Advanced';

export interface InsertItem {
  id: string;
  title: string;
  description: string;
  icon: string;
  section: InsertSection;
  keywords?: string[];
  run: (editor: Editor, range?: { from: number; to: number }) => void;
  /** Live demonstration for the generated README. Omit when the block needs an
   *  uploaded asset; add the reason to NO_DEMO instead. */
  example?: () => Record<string, unknown>[];
}

export const chemInsertable: InsertItem = {
  id: 'chem',
  title: 'Chemistry structure',
  description: 'Draw or type a molecule (SMILES)',
  icon: '⬡',
  section: 'Notation',
  keywords: [
    'chemistry',
    'molecule',
    'smiles',
    'structure',
    'organic',
    'compound',
    'bond',
    'reaction',
    'chem',
  ],
  // Handles both call shapes: with a range (delete the "/" query first), or without (insert
  // at the current selection).
  run: (editor, range) => {
    const chain = editor.chain().focus();
    if (range) chain.deleteRange(range);
    chain.insertContent({ type: 'chem', attrs: { smiles: '', name: '', molfile: null } }).run();
  },
  example: () => [
    p('Type a SMILES string and get a structure. Double-click it to open the draw editor.'),
    chem('CN1C=NC2=C1C(=O)N(C(=O)N2C)C', 'Caffeine'),
  ],
};

export default chemInsertable;
