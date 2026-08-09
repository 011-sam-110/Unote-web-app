// The descriptive half of the palette commands that CommandPalette.tsx assembles itself.
//
// lib/commands.ts holds the commands that are truly global and context-free. The eleven
// below need component state to run (the current notebook, the sidebar toggle, the open
// note), so their `run` stays in CommandPalette.tsx - but their WORDS live here, because
// the generated README documents every command and two copies of a title drift.
//
// `needs` names the api method the command ultimately calls, keyed against the BLOCKED
// map in features/guest/guestApi.ts. That is what marks a command as account-only in the
// README, so nothing is hand-listed twice.
//
// create-note and study-notebook render a HINT computed from component state at runtime
// (the filing notebook / the notebook being studied) rather than a fixed string, so
// CommandPalette.tsx keeps that expression and does not take this entry's hint verbatim.
// The text below is a static stand-in good enough for the generated README.

export interface PaletteDoc {
  id: string;
  title: string;
  hint: string;
  section: string;
  shortcut?: string;
  needs?: string;
}

export const PALETTE_CATALOG: PaletteDoc[] = [
  { id: 'create-note', title: 'New note', hint: 'In the current notebook', section: 'Create', shortcut: '⌘N' },
  { id: 'create-canvas', title: 'New canvas', hint: 'Infinite board: stickies, shapes and Apple Pencil ink', section: 'Create', needs: 'createCanvasItem' },
  { id: 'create-notebook', title: 'New notebook', hint: 'Add a notebook for a new module', section: 'Create' },
  { id: 'create-import-photo', title: 'Import photo of notes', hint: 'Photo → OCR → structured notes', section: 'Create', needs: 'import' },
  { id: 'create-import-slides', title: 'Import slides PDF', hint: 'Slides → outline notes', section: 'Create', needs: 'import' },
  { id: 'create-import-transcript', title: 'Import transcript', hint: 'Text/PDF/Docx → structured notes', section: 'Create', needs: 'import' },
  { id: 'import-old-notes', title: 'Import old notes', hint: 'Bulk import documents, photos or a folder', section: 'Create', needs: 'createImportBatch' },
  { id: 'create-phone-capture', title: 'Open phone capture QR', hint: 'Scan with your phone to capture a page', section: 'Create', needs: 'qr' },
  { id: 'note-snapshot', title: 'Snapshot now', hint: 'Save a named version of this note', section: 'Note', needs: 'snapshot' },
  { id: 'view-sidebar', title: 'Toggle sidebar', hint: 'Collapse or expand the sidebar', section: 'View', shortcut: '⌘\\' },
  { id: 'study-notebook', title: 'Study this notebook', hint: 'Review just these flashcards', section: 'Study', needs: 'review' },
];

const BY_ID = new Map(PALETTE_CATALOG.map((c) => [c.id, c]));

/** Throws rather than returning undefined: a typo'd id in CommandPalette would otherwise
 *  drop a command out of the palette silently, with nothing failing anywhere. */
export function paletteDoc(id: string): PaletteDoc {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`paletteDoc: no catalog entry for "${id}"`);
  return found;
}
