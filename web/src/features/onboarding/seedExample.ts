// The optional example notebook.
//
// The tour needs something to point at. Narrating an empty editor teaches nothing
// about wikilinks or backlinks, because there is nothing to link and nothing linking
// back - so the offer to seed is made up front, in plain words, and declining it is
// a first-class path (every step that needs seeded content declares a `skip` or
// `center` fallback in tourSteps.ts).
//
// This is deliberately SMALL: one notebook, two notes, one board. It is an example,
// not a demo vault - a student who accepts it should be able to read the whole thing
// in a minute and delete it in one click. (server/src/seed.ts holds the large demo
// vault; that one is CLI-only and seeds a whole degree's worth of material.)
//
// Everything is created through the ordinary authenticated API, so the result is
// indistinguishable from notes the student wrote themselves: same ownership, same
// search index, same backlinks.
import { api } from '../../lib/api';
import { bullets as bulletsOf, h, p } from '../editor/docBuilders';

export interface SeedResult {
  notebookId: string;
  noteId: string;
  /** The note the main one links TO - so it is the one with a backlink to show. */
  linkedNoteId: string;
  canvasId: string;
}

const NOTEBOOK_NAME = 'Algorithms (example)';
const LINKED_TITLE = 'Sorting algorithms';
const MAIN_TITLE = 'Lecture 1: Big-O notation';

/** seedExample's lists are all plain strings; the shared builder takes inline children. */
function bullets(list: string[]) {
  return bulletsOf(list.map((s) => [s]));
}

/**
 * Creates the example notebook and returns the ids the tour navigates to.
 *
 * Order matters: the linked note is created FIRST so the main note can carry a real
 * `wikilink` node pointing at its id, rather than bare text that only resolves on a
 * later save. The main note's contentText still carries the literal `[[Title]]` form
 * because that is what the server parses to build the `links` table - the rendered
 * node and the extracted backlink come from those two fields respectively, and both
 * have to be right for the backlinks step to have anything to show.
 */
export async function seedExampleNotebook(): Promise<SeedResult> {
  const { notebook } = await api.createNotebook({ name: NOTEBOOK_NAME, emoji: '📘', color: '#6366f1' });

  const linkedText = [
    'Comparison sorts cannot beat O(n log n) in the worst case. The decision-tree argument gives the lower bound.',
    'Merge sort: always O(n log n), stable, needs O(n) extra space.',
    'Quicksort: O(n log n) average, O(n^2) worst case, sorts in place.',
    'Stability matters when you sort by one key and then another. #revision',
  ].join('\n\n');

  const { note: linked } = await api.createNote({
    notebookId: notebook.id,
    title: LINKED_TITLE,
    tags: ['algorithms', 'revision'],
    contentText: linkedText,
    contentJson: {
      type: 'doc',
      content: [
        p('Comparison sorts cannot beat O(n log n) in the worst case. The decision-tree argument gives the lower bound.'),
        h(2, 'The three worth remembering'),
        bullets([
          'Merge sort: always O(n log n), stable, needs O(n) extra space.',
          'Quicksort: O(n log n) average, O(n^2) worst case, sorts in place.',
          'Insertion sort: O(n^2), but genuinely fast on small or nearly-sorted input.',
        ]),
        p('Stability matters when you sort by one key and then another. #revision'),
      ],
    },
  });

  // The plain-text form the server reads to build backlinks.
  const mainText = [
    'Big-O describes how the cost of an algorithm grows as the input grows. It is about the shape of the curve, not the constant.',
    'Dropping constants is the whole point: 3n + 40 and n both grow linearly, so both are O(n).',
    `Worked examples are in [[${LINKED_TITLE}]]. That link is a wikilink, and this note now shows up in its backlinks.`,
    'Read before the seminar. #revision',
  ].join('\n\n');

  const { note: main } = await api.createNote({
    notebookId: notebook.id,
    title: MAIN_TITLE,
    tags: ['algorithms', 'lecture'],
    contentText: mainText,
    contentJson: {
      type: 'doc',
      content: [
        p('Big-O describes how the cost of an algorithm grows as the input grows. It is about the shape of the curve, not the constant.'),
        h(2, 'The ones that come up'),
        bullets([
          'O(1): constant. Array index, hash lookup.',
          'O(log n): logarithmic. Binary search, balanced tree lookup.',
          'O(n log n): the floor for comparison sorting.',
          'O(n^2): nested loops over the same input.',
        ]),
        p('Dropping constants is the whole point: 3n + 40 and n both grow linearly, so both are O(n).'),
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Worked examples are in ' },
            { type: 'wikilink', attrs: { noteId: linked.id, title: LINKED_TITLE, alias: null } },
            { type: 'text', text: '. That link is a wikilink, and this note now shows up in its backlinks.' },
          ],
        },
        p('Read before the seminar. #revision'),
      ],
    },
  });

  const { note: canvas } = await api.createNote({
    notebookId: notebook.id,
    kind: 'canvas',
    title: 'Revision board (example)',
  });

  // Two stickies and a card linking back to a real note, so the board reads as
  // something in progress rather than a blank grid. Failures here are swallowed:
  // an empty board is a perfectly usable place to demonstrate the pen, and losing
  // the whole seed over a decorative sticky would be the wrong trade.
  try {
    await api.createCanvasItem(canvas.id, {
      kind: 'sticky',
      x: 120,
      y: 120,
      width: 200,
      height: 140,
      data: { text: 'Exam: which sorts are stable?', color: '#fde68a' },
    });
    await api.createCanvasItem(canvas.id, {
      kind: 'sticky',
      x: 380,
      y: 200,
      width: 200,
      height: 140,
      data: { text: 'Draw the decision tree for n = 3', color: '#bfdbfe' },
    });
    await api.createCanvasItem(canvas.id, {
      kind: 'link',
      x: 120,
      y: 320,
      width: 240,
      height: 96,
      data: { noteId: main.id, title: MAIN_TITLE },
    });
  } catch {
    // Board decoration only - see above.
  }

  // Two cards so the Study page has a real queue rather than an empty state during
  // the flashcards step. Same reasoning as the canvas items: best-effort.
  try {
    await api.createCard({
      noteId: main.id,
      question: 'What is the lower bound for comparison-based sorting?',
      answer: 'O(n log n) in the worst case, from the decision-tree argument.',
    });
    await api.createCard({
      noteId: linked.id,
      question: 'Which is stable, merge sort or quicksort?',
      answer: 'Merge sort. Quicksort is not stable in its usual in-place form.',
    });
  } catch {
    // Flashcards are a bonus; the step teaches the same thing without them.
  }

  return { notebookId: notebook.id, noteId: main.id, linkedNoteId: linked.id, canvasId: canvas.id };
}
