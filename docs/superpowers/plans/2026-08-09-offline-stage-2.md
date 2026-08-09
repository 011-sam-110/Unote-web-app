# Stage 2 — ink, canvas boards, images and attachments offline

**Spec:** `docs/superpowers/specs/2026-08-09-offline-desktop-design.md` §8, §9.
**Branch:** `feat/desktop-distribution`.
**Depends on:** Stage 1, which is built, tested and on this branch.

## What is already done, so you do not rebuild it

- **The server feed already emits all three entities.** `server/src/routes/sync.ts:66-83`
  returns `canvasItem`, `canvasEdge` and `ink`. No server change is needed for the pull.
- **The wire contract already declares them.** `SYNC_ENTITIES` and `OUTBOX_ORDER` in
  `web/src/lib/sync/contract.ts` list all three in the correct push order.
- **What is missing is entirely client-side:** there are no Dexie tables, and
  `localApi.ts:722-723` stubs `ink()` to `{ strokes: [] }` and `canvas()` to
  `{ items: [], edges: [] }`.

## THE TRAP — read this before touching the schema

`engine.ts:35-45` documents it, and it is the one mistake that would be invisible:

> Records for an entity absent from `MIRRORED` are deliberately skipped — **and skipping
> still advances the cursor past them.**

So adding the tables without clearing the cursor leaves every pre-existing stroke, canvas
item and edge permanently unsynced, on every existing install, with nothing in the UI to
suggest anything is missing.

**Therefore the Dexie version 2 upgrade MUST also clear `cursor` and `initialSyncDone`
from the `meta` table**, forcing a full re-pull. Write a test that fails if it does not:
seed a v1 database with a cursor, open it at v2, assert the cursor is gone.

## Tasks

- [ ] **1. Dexie v2.** Add `canvasItems`, `canvasEdges`, `ink` and `blobs` stores to
      `web/src/lib/local/db.ts`. Index canvas items and ink by `noteId`. `blobs` is keyed
      by local blob id and holds `{ id, noteId, mime, bytes: Blob, createdAt }`.
      Add the `.upgrade()` that clears the cursor. Extend `db.test.ts`.
- [ ] **2. Records and mappers.** `records.ts` gains `LocalCanvasItem`, `LocalCanvasEdge`,
      `LocalInk`, `LocalBlob`, matching the server columns in `schema.sql:215-260`.
      Note `note_ink` has no `updated_at` — strokes are immutable and append-only, so ink
      conflict resolution is "there is none", the same property that makes `review_log`
      free. Say so in a comment rather than inventing a version field.
- [ ] **3. Mirror them.** Add the three to `MIRRORED` in `engine.ts`. Confirm the pull
      applies and tombstones them like any other record.
- [ ] **4. localApi reads and writes.** Replace the two stubs with real Dexie-backed
      implementations, plus the create/update/delete paths that queue outbox entries.
      Per-item last-write-wins, as §8 specifies.
- [ ] **5. Offline image insert — the ordering that matters.** Per §9:
      1. Write the bytes to `blobs` under a local id; render from an object URL.
      2. Queue the upload.
      3. On reconnect the upload runs, then **the note's content JSON is rewritten to the
         server URL, and that rewrite goes through the OUTBOX as an ordinary note update**
         — not a side-channel write.
      4. **The blob is dropped only once the rewrite is confirmed.** Dropping on upload
         success but before the rewrite lands leaves a note pointing at nothing.
      Write the test for step 4 as an explicit failure case: simulate upload success then
      a failed rewrite, and assert the blob survives.
- [ ] **6. Revoke object URLs.** Every `URL.createObjectURL` needs a matching revoke on
      unmount, or a long session leaks every image it has ever rendered.
- [ ] **7. Convergence.** Extend `web/src/lib/sync/convergence.test.ts` with two clients
      diverging on canvas items and ink, including the append-only ink case where both
      clients add strokes to the same note and both must survive.
- [ ] **8. e2e.** Extend `e2e/offline.spec.ts`: insert an image with the network cut,
      reload, confirm it still renders, reconnect, confirm the note ends up pointing at a
      server URL and still renders.

## Constraints

- Never edit the inline `<script>` in `web/index.html` — its sha256 is pinned in
  `server/src/lib/csp.ts` and `vercel.json`.
- Timestamps are TEXT, ISO-8601 UTC. Booleans are INTEGER 0/1.
- IDs are 14 chars of `abcdefghijklmnopqrstuvwxyz0123456789`.
- Never `git add -A`.
- Comments explain WHY, plain prose, hyphens not em dashes, British spelling.
