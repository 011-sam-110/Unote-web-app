// Which API methods the local mirror can serve, and which of those are writes.
//
// This lives in its own module rather than inside api.ts for one reason: it is a
// LIST, and lists that sit next to logic get edited by people changing the logic.
// A method silently missing from WRITE_METHODS would be served from the mirror and
// never pushed - an edit that looks saved and reaches no other device.
//
// The default everywhere is refusal, matching what api.ts already did for guest
// mode: a method absent from both sets is either always-server or unsupported
// offline, and neither case may silently fall through to a stale local answer.

/**
 * Methods that MUTATE local state and therefore need an outbox entry.
 *
 * Every name here must exist on `localApi`. The pairing is asserted by a test, so
 * adding a write to one and not the other fails the build rather than production.
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
]);

/**
 * Read methods the mirror can answer.
 *
 * Listed explicitly rather than inferred as "everything on localApi that is not a
 * write", because that inference makes a typo in a write name silently produce a
 * read - the exact failure this module exists to prevent.
 */
export const READ_METHODS: ReadonlySet<string> = new Set([
  'notebooks',
  'notes', 'recentNotes', 'note',
  'search', 'searchTitles', 'searchFull',
  'tags',
  'dashboard',
  'studyQueue', 'studyCards', 'studyStats',
]);

/**
 * Never local, in any mode, for reasons that differ by group.
 *
 * Auth is how guest mode ENDS, so it cannot be answered by the thing it ends.
 * Share links belong to whoever sent them, not to the browser opening them. The
 * rest genuinely need a server: a model, a file store, or another participant.
 *
 * Kept as one list so "what does this app do without a network" has a single
 * answer that can be read in ten seconds.
 */
export const ALWAYS_SERVER_METHODS: ReadonlySet<string> = new Set([
  // auth
  'signup', 'login', 'logout', 'me', 'pair', 'changePassword', 'recover',
  'regenerateRecoveryKey', 'authProviders',
  // share links, from both sides
  'sharePeek', 'shareJoin', 'sharedNote', 'updateSharedNote', 'shareEvents',
  'sharedInk', 'addSharedInk', 'shares', 'createShare', 'revokeShare',
  // AI - nothing here is queueable; a model call has no offline meaning
  'aiImprove', 'aiSummarize', 'aiFlashcards', 'aiAsk', 'aiTitle', 'aiChat',
  'aiSuggest', 'aiGaps', 'aiGapEdits', 'aiHealth', 'aiUsage', 'aiSaveKey', 'aiDeleteKey',
  // import and uploads - the file store is server-side
  'import', 'importJob', 'uploadImage', 'createImportBatch', 'importSources',
  'importLabelSpace', 'getImportBatch', 'addImportItems', 'uploadImportFile',
  'categoriseImport', 'decideImportItem', 'setImportGroups', 'groupImportWithAi',
  'commitImport', 'discardImportBatch',
  // note history - server-side, and Stage 1 does not mirror note_versions
  'versions', 'version', 'snapshot', 'restore', 'undeleteNote',
  // collaboration
  'comments', 'addComment', 'updateComment', 'deleteComment',
  // Stage 2, not Stage 1
  'canvas', 'createCanvasItem', 'updateCanvasItems', 'deleteCanvasItem',
  'createCanvasEdge', 'deleteCanvasEdge', 'ink', 'addInk', 'deleteInk', 'clearInk',
  // misc server facts
  'templates', 'createTemplate', 'deleteTemplate', 'meta', 'qr',
  'unlinkedMentions', 'exportSummary',
]);

/**
 * Is this method one the mirror knows about at all?
 *
 * `exportUrl` and `exportAllUrl` deliberately match none of the three sets: they
 * return a STRING synchronously rather than a promise, so wrapping them in any
 * async path would break them. They fall through to the untouched server object.
 */
export function isLocalMethod(name: string): boolean {
  return WRITE_METHODS.has(name) || READ_METHODS.has(name);
}
