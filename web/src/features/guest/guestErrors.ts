// What the local store refuses, and the words it refuses in.
//
// Split out of guestApi.ts when that file became a re-export of lib/local/localApi:
// localApi throws GuestFeatureError, and guestApi re-exports it, so the class cannot
// live in either of them without an import cycle. It lives here, importing nothing.
//
// Three kinds of entry are described by this module and by localApi between them:
//
//   LOCAL    - answered from the local store, in exactly the DTO shape the server returns.
//   EMPTY    - answered with a valid empty result, because the surface is harmless
//              without a server (a note has no comments, no history, no ink) and an
//              error there would show a broken panel instead of an empty one.
//   BLOCKED  - rejected with a sentence naming what an account would buy. Nothing calls
//              the server: the endpoints all require a session, so a guest reaching one
//              would only ever collect a 401.
//
// Anything absent from the table below is BLOCKED by default (see lib/api.ts), which is
// the safe direction: a new endpoint is unavailable until someone decides otherwise.

/**
 * A feature that genuinely needs a server, refused in words a student can act on.
 * `errorMessage()` reads `.message`, so every existing toast and error panel in the app
 * shows this sentence without any of them knowing guest mode exists.
 */
export class GuestFeatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuestFeatureError';
  }
}

/** Per-endpoint refusals. The default covers anything not named here. */
const BLOCKED: Record<string, string> = {
  aiImprove: 'Make an account to use AI. It runs on the server, so there is nothing to run it on here.',
  aiSummarize: 'Make an account to use AI. It runs on the server, so there is nothing to run it on here.',
  aiFlashcards: 'Make an account to turn a note into flashcards.',
  aiAsk: 'Make an account to ask questions across your notes.',
  aiTitle: 'Make an account to use AI.',
  aiSuggest: 'Make an account to use AI review.',
  aiGaps: 'Make an account to use AI.',
  aiGapEdits: 'Make an account to use AI.',
  aiUsage: 'Make an account to use AI.',
  aiSaveKey: 'Make an account to save an AI key.',
  aiDeleteKey: 'Make an account to manage an AI key.',
  snapshot: 'Make an account to keep note history. Nothing is saved while you are trying Unote out.',
  restore: 'Make an account to keep note history.',
  version: 'Make an account to keep note history.',
  undeleteNote: 'Make an account to undo a delete. A deleted note is gone straight away here.',
  addComment: 'Make an account to leave comments on a note.',
  updateComment: 'Make an account to leave comments on a note.',
  deleteComment: 'Make an account to leave comments on a note.',
  createTemplate: 'Make an account to save your own templates.',
  deleteTemplate: 'Make an account to save your own templates.',
  createShare: 'Make an account to share a note. A share link has to be served from somewhere.',
  shares: 'Make an account to share a note.',
  revokeShare: 'Make an account to share a note.',
  addInk: 'Make an account to draw on a note.',
  deleteInk: 'Make an account to draw on a note.',
  clearInk: 'Make an account to draw on a note.',
  createCanvasItem: 'Make an account to use boards.',
  updateCanvasItems: 'Make an account to use boards.',
  deleteCanvasItem: 'Make an account to use boards.',
  createCanvasEdge: 'Make an account to use boards.',
  deleteCanvasEdge: 'Make an account to use boards.',
  import: 'Make an account to import slides, photos and recordings. Reading them needs the server.',
  importJob: 'Make an account to import slides, photos and recordings.',
  uploadImage: 'Make an account to put images in a note. There is nowhere to keep the file otherwise.',
  createImportBatch: 'Make an account to use the import wizard. You can still bring in Markdown from the sidebar.',
  importSources: 'Make an account to use the import wizard.',
  importLabelSpace: 'Make an account to use the import wizard.',
  getImportBatch: 'Make an account to use the import wizard.',
  addImportItems: 'Make an account to use the import wizard.',
  uploadImportFile: 'Make an account to use the import wizard.',
  categoriseImport: 'Make an account to use the import wizard.',
  decideImportItem: 'Make an account to use the import wizard.',
  commitImport: 'Make an account to use the import wizard.',
  discardImportBatch: 'Make an account to use the import wizard.',
  meta: 'Make an account to see server details.',
  qr: 'Make an account to capture notes from your phone. The phone has to reach your account, not this browser.',
  unlinkedMentions: 'Make an account to see unlinked mentions.',
};

const DEFAULT_BLOCKED = 'Make an account to use this. It needs a server, and nothing here is saved to one.';

export function guestBlockedMessage(method: string): string {
  return BLOCKED[method] ?? DEFAULT_BLOCKED;
}
