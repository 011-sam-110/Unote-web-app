# Stage 4 — Yjs note bodies

**Status: SPECIFIED, NOT BUILT.** Deliberately.

**Date:** 2026-08-09
**Parent spec:** `2026-08-09-offline-desktop-design.md` §11, which names this stage and
gates it: *"Deferred until Stage 1 is proven in real use."*

## Why this is not built

Stage 1 is not proven in real use. It is proven in tests - 47 unit tests, 9 convergence
cases and 3 real-browser offline specs - but no installer has ever been built, no release
cut, and no human has run the desktop app for a day and come back with a corrupted note.
That is the evidence the gate asks for and it does not exist yet.

Stage 4 replaces the representation of every note body, touching the editor, the sync
transport and the server schema at once. Doing that on top of an unvalidated Stage 1 would
mean two unproven layers, and when a note came back wrong nobody could say which one did
it. Build it after the first real week of desktop use, not before.

## What it buys

Stage 1 resolves note-body conflicts by **last-write-wins**: edit the same note offline on
two machines and one edit survives whole, the other goes to history. That is honest and
recoverable, but it is a real limitation and the one users will eventually hit.

A CRDT removes it. Two offline edits to different paragraphs of the same note both survive,
merged, with no conflict to resolve and no version demoted.

## Scope — bodies only

**Becomes a CRDT:** the note body.

**Stays a last-write-wins record:** title, `notebookId`, tags, position, and every other
entity in `SYNC_ENTITIES`. These are single scalar fields where "one of the two wins" is
the correct semantic anyway, and making them CRDTs would buy nothing for real complexity.

This split is why the parent spec insists note bodies stay addressed as whole records with
their own sync metadata - so the body representation can be swapped without touching the
transport or the store.

## Design

### Storage: an append-only update log

A new table, deliberately shaped like `review_log`:

```sql
CREATE TABLE IF NOT EXISTS note_body_updates (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  update_b64 TEXT NOT NULL,     -- one Yjs update, base64
  created_at TEXT NOT NULL
);
```

Append-only is the whole point. Yjs updates are commutative and idempotent, so a log of
them merges with **no conflict resolution at all** - the same property that made flashcard
reviews the cheapest thing in Stage 1. Sync becomes at-least-once delivery plus dedup by
update id, and the existing `baseUpdatedAt` conflict machinery is simply not consulted for
bodies.

### Compaction

An append-only log grows without bound, and a note edited for a term would replay thousands
of updates on every cold load. Periodically (server-side, on write when the row count for a
note crosses a threshold) merge the log into a single snapshot update and delete the merged
rows in the same transaction. Never delete before the snapshot is committed.

### THE TRAP — seeding the Y.Doc

This is the failure mode that will eat a week if it is not designed for.

Every existing note holds ProseMirror JSON. To become a Y.Doc it must be seeded. **If two
clients seed the same note independently, they produce two Y.Docs with different client
ids and no shared history, and merging them CONCATENATES the content rather than
reconciling it.** The user sees their note duplicated, and it looks like data corruption
because it is.

The seed must therefore happen exactly once per note, and be seen by every client as the
same first update. Two acceptable ways:

1. **Server seeds on migration.** A one-off pass converts every note body to an initial
   update row. Clients only ever receive a Y.Doc that already exists. Simplest to reason
   about; needs a migration over the whole table.
2. **First-writer seeds, guarded by a uniqueness constraint.** The first update for a note
   is inserted with a fixed id derived from the note id, so a second client's seed violates
   the primary key and it pulls the winner instead.

Option 1 is preferred. Option 2 is written down because it is what someone reaches for when
the migration looks expensive, and it only works with that constraint in place.

Either way: a client must **never** seed a Y.Doc from local ProseMirror JSON for a note it
has not confirmed is unseeded server-side.

### Editor

TipTap already sits on ProseMirror, so this is `y-prosemirror` plus a `Y.Doc` per open
note. Real-time collaboration is explicitly **not** in scope (parent spec §14) - no
awareness protocol, no presence cursors, no websocket. Updates travel over the existing
sync transport on the existing schedule. The CRDT is being used for offline merge, not for
live co-editing, and those need very different infrastructure.

### Interaction with note history

`note_versions` currently receives the losing copy of a conflict. With no conflicts there
is nothing to demote, so history becomes purely time-based snapshots. Keep the table and
write a snapshot on compaction - it is the natural point, and it means history stays
useful rather than quietly emptying out.

## Testing

The convergence harness from Stage 1 already runs two independent clients over
`fake-indexeddb`. Extend it with randomised interleavings: N clients, random edits at
random offsets, random partition and heal, then assert every client converges to a
byte-identical document. A CRDT that is only tested on tidy sequences is not tested.

Specifically assert the seeding trap: two clients, both offline, both opening a note that
has never been seeded, then both reconnecting. The content must not double.

## Estimate

Two to three weeks, most of it in migration and the editor integration rather than the
sync path. The sync path is the easy half - append-only logs are the shape this codebase
already handles best.
