// Sections 05-09 of the README, as data.
//
// Sections 01-04 are emitted from registries that already exist (INSERT_ITEMS, the
// command catalogue, the shortcut groups). Study, Boards, Import, AI and Share have no
// such registry, so their copy lives here - one definition in one place, but written by
// hand rather than derived. A feature added without touching this file will not appear in
// the README. That limit is deliberate and recorded in the design doc.
//
// `needs` names the api method the line depends on, keyed against BLOCKED in
// features/guest/guestApi.ts, so the guest build marks itself.

export interface FeatureLine {
  what: string;
  needs?: string;
}

export interface FeatureSection {
  number: string;
  title: string;
  blurb: string;
  lines: FeatureLine[];
}

export const FEATURE_SECTIONS: FeatureSection[] = [
  {
    number: '05',
    title: 'Study',
    blurb: 'Turn a note into flashcards and let the schedule decide when you see them again.',
    lines: [
      { what: 'Select a passage and make a card from it, or write one by hand', needs: 'createCard' },
      { what: 'Review with Space to reveal, then 1-4 for how well it went', needs: 'review' },
      { what: 'Cards you find hard come back sooner; cards you know drift further out', needs: 'review' },
    ],
  },
  {
    number: '06',
    title: 'Boards',
    blurb: 'An infinite canvas for the thinking that is not paragraphs.',
    lines: [
      { what: 'Stickies, cards that link to real notes, and arrows between them', needs: 'createCanvasItem' },
      { what: 'Draw with a pen, a highlighter or a finger', needs: 'addInk' },
      // uploadImage, not createCanvasItem: this one writes an IMAGE into a note.
      // CanvasInsertModal.tsx:71 calls api.uploadImage - the board is only the source
      // of the picture, so the thing a guest actually lacks is somewhere to put the file.
      { what: 'Drop a snapshot of a board into any note', needs: 'uploadImage' },
    ],
  },
  {
    number: '07',
    title: 'Bring notes in',
    blurb: 'Most notes start somewhere else. Point Unote at them.',
    lines: [
      { what: 'PDFs and slide decks, split into one note per slide', needs: 'import' },
      { what: 'Photos of handwritten pages, grouped automatically', needs: 'import' },
      { what: 'A lecture recording, transcribed in your browser', needs: 'import' },
      { what: 'A folder of old Markdown, sorted before anything is written', needs: 'createImportBatch' },
      { what: 'Your phone, paired by scanning a QR code', needs: 'qr' },
    ],
  },
  {
    number: '08',
    title: 'Ask AI',
    blurb: 'A conversation about the note you are looking at, or about everything you have written.',
    lines: [
      { what: 'Ask about this note; it can rewrite, summarise or make cards from it', needs: 'aiImprove' },
      { what: 'Ask across every note and get answers with the sources listed', needs: 'aiAsk' },
      { what: 'Every change is shown as a diff you approve before it lands', needs: 'aiSuggest' },
    ],
  },
  {
    number: '09',
    title: 'Share & export',
    blurb: 'Notes you can hand to someone, and notes you can take away.',
    lines: [
      { what: 'A link anyone can open, revocable whenever you like', needs: 'createShare' },
      { what: 'Invite someone to edit with you', needs: 'createShare' },
      { what: 'Export a note, or everything, as Markdown' },
    ],
  },
];
