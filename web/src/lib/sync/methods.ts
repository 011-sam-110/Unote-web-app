// Which API methods route where, in the modes where it is not obvious.
//
// The overall rule in api.ts stays what it always was: prefer the local
// implementation, and refuse rather than fall through to a server call that could
// only answer 401. These two sets refine only the ONLINE case, where both a local
// and a server implementation exist and we have to pick.
//
// They live in their own module because they are LISTS, and lists that sit next to
// logic get edited by whoever is changing the logic. A write name silently missing
// from WRITE_METHODS would be served from the mirror and never pushed - an edit that
// looks saved and reaches no other device.

/**
 * Methods that MUTATE local state and therefore need an outbox entry.
 *
 * Every name here must exist on `localApi`; a test asserts the pairing, so adding a
 * write to one and not the other fails the suite rather than production.
 */
export const WRITE_METHODS: ReadonlySet<string> = new Set([
  // notebooks
  'createNotebook', 'updateNotebook', 'deleteNotebook',
  // notes
  'createNote', 'updateNote', 'deleteNote',
  // tags - these rewrite the tag arrays on notes, so they are note writes
  'renameTag', 'deleteTag', 'mergeTags',
  // flashcards. `review` is a write in the fullest sense: it advances the card's
  // SM-2 schedule AND appends to the review log.
  'createCard', 'updateCard', 'deleteCard', 'review',
  // boards and ink
  'createCanvasItem', 'updateCanvasItems', 'deleteCanvasItem', 'createCanvasEdge', 'deleteCanvasEdge',
  'addInk', 'deleteInk', 'clearInk',
  // An image inserted with no connection. The local implementation writes the bytes
  // to the blobs table and hands back a `local-blob:` reference instead of a URL;
  // local/blobs.ts gets them onto the server and rewrites the note afterwards.
  'uploadImage',
]);

/**
 * Reads the mirror can answer completely, and may therefore serve while online.
 *
 * Listed explicitly rather than inferred as "everything on localApi that is not a
 * write". `localApi` still carries deliberately EMPTY stubs - `versions`, `comments`,
 * `templates` - so that a guest with no account gets an empty panel instead of an
 * error. Those stubs are the right answer for a guest and the WRONG answer for a
 * signed-in user online, whose real data is on the server. An inferred list would
 * quietly serve the stub and show them nothing.
 *
 * `canvas` and `ink` were two of those stubs until Stage 2 and are now real reads off
 * the mirror, which is why they moved into this list.
 */
export const MIRRORED_READS: ReadonlySet<string> = new Set([
  'notebooks',
  'notes', 'recentNotes', 'note',
  'search', 'searchTitles', 'searchFull',
  'tags',
  'dashboard',
  'studyQueue', 'studyCards', 'studyStats',
  'canvas', 'ink',
]);

/** True when the method changes local state and must be queued for the server. */
export function isWrite(name: string): boolean {
  return WRITE_METHODS.has(name);
}

/** True when the mirror is a complete answer for this read. */
export function isMirroredRead(name: string): boolean {
  return MIRRORED_READS.has(name);
}
