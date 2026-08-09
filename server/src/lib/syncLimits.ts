// Page-size bounds for GET /api/sync/changes.
//
// These are DUPLICATES of the values in `web/src/lib/sync/contract.ts`, which is the
// source of truth. They are duplicated rather than imported on purpose: the Vercel
// build bundles `api/index.ts`, and a runtime import reaching out of server/ into the
// web workspace pulls that whole module graph into the function - a deployment hazard
// this project has been bitten by before. Only `import type` crosses the boundary in
// shipped code, and that is erased entirely at compile time.
//
// `server/test/sync.test.ts` imports the contract at runtime (a test is not bundled)
// and asserts these two constants still equal it. That test is what keeps the copies
// honest; changing a number here without changing it there fails the suite.

/** Rows per page when the caller does not ask. */
export const DEFAULT_SYNC_LIMIT = 500;

/** Ceiling a caller can ask for. Larger requests are clamped, not rejected. */
export const MAX_SYNC_LIMIT = 2000;
