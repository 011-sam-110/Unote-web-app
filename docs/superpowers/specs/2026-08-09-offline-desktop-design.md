# Offline desktop app — design

**Date:** 2026-08-09
**Status:** Stages 0 and 1 built on `feat/offline-desktop`. Plan: `docs/superpowers/plans/2026-08-09-offline-desktop.md`
**Visual review:** https://claude.ai/code/artifact/344b5c92-d2a6-4b80-94d5-55d106f4fe4b

## Corrections found while building

Recorded here because each one contradicts something stated below, and the commit
messages are the only other place they exist.

- **No CSP change was needed.** §3 is right that `worker-src` is already present; it
  was verified, not assumed.
- **`updated_at` needs a column DEFAULT**, not just `NOT NULL` after a backfill.
  Without one, every existing insert into `notebooks`, `flashcards`, `canvas_edges`
  and `note_ink` returns 500 - none of those statements names the column.
- **The schema block belongs at the END of `schema.sql`.** Placed near the `users`
  ALTERs it references tables created 30 lines later, failing the whole migration on
  a fresh database's first boot.
- **Tags do not sync with the note for free.** §7 says `note_tags` needs nothing
  because tags ride inside the note's PATCH payload. True for push; false for pull.
  The delta feed now aggregates them into the note row.
- **The outbox's coalescing constrains payload shape.** Because an update collapses
  into a pending create by replacing the payload wholesale, every update payload has
  to be a complete create-valid body - otherwise the push becomes a create missing
  `notebookId`, collects 400, and wedges the queue permanently.
- **`registerType: 'autoUpdate'` was wrong** for the claim in §3 that an update
  "activates on next launch". It forces `skipWaiting` and `clientsClaim`, seizing
  open pages while `cleanupOutdatedCaches` deletes the precache underneath them.
- **A pre-existing crash, unrelated to offline:** 14 consecutive 'easy' reviews of one
  card overflow the JS `Date` range in the SM-2 scheduler. Both the server route and
  the new client port now clamp the interval to 36500 days.

**Deployment note.** The Electron shell loads the production origin, so Stage 0's
offline support does nothing until a web build carrying the service worker is
deployed. Until then the app is an ordinary window onto the live site.

An Electron desktop app for Windows and macOS that loads the live site, keeps working
with no connection, and picks up every web deploy without shipping a new binary.

The request bundles two problems of wildly different size. Shipping the app's *code*
offline and auto-updating it is a service worker — two days. Taking *notes* offline is
the whole cost, because every read and write in the app is currently
`lib/api.ts` → `fetch` → Express → Neon Postgres. There is no local database and no
write queue.

Making all four requested surfaces work offline — notes, search, ink and boards,
flashcards — is not an offline *mode* beside the online one. It converts Unote to
**local-first**: the client's own database becomes the primary read and write path,
and the server becomes a sync peer.

---

## 1. What already exists

The expensive part of a local-first conversion is normally threading a second data
path through every page. That work is done and in production, as guest mode.

| Exists | Lines | What it gives the offline layer |
| --- | --- | --- |
| `web/src/lib/api.ts` | 345 | A single `Proxy` (line ~337) routes every call to `serverApi` or a local implementation. Pages are unaware which is live. |
| `web/src/features/guest/guestApi.ts` | 399 | Notebooks, notes, tags and search implemented entirely locally. |
| `web/src/features/guest/guestStore.ts` | 303 | Local persistence plus honest quota handling (`GuestStorageFullError`). |
| `web/src/features/guest/guestMigrate.ts` | 98 | Already pushes local work *up* to the server, matching notebooks by name. |
| `web/src/features/editor/useAutosave.ts` | — | Debounce, dirty tracking, capped-backoff retry and a `beforeunload` keepalive flush. An in-memory outbox in all but name. |
| `notes.deleted_at`, `note_versions` | — | Soft-delete and a version table: the two schema features a sync engine needs most. |

Five gaps separate that from an offline layer:

1. **Guest mode is upload-only.** It never reads server state down.
2. **Migration creates rather than reconciles.** Run against an account that already
   holds those notes, `migrateGuestWork` would duplicate every one of them.
3. **The store is capped near 4 MB of plain text** (`SOFT_LIMIT_BYTES`,
   `guestStore.ts`), and boards are explicitly refused (`guestApi.ts:208`). Ink,
   images and canvas blow straight through both.
4. **Note IDs are minted server-side** (`newId()` in `db.ts`, used by
   `routes/notes.ts:193`). An offline-created note would change identity on first
   sync, breaking every wikilink and backlink aimed at it.
5. **No delta endpoint exists.** `since` appears once in the whole server, in
   `routes/share.ts:467`, for share events.

---

## 2. Decisions settled

| Question | Answer |
| --- | --- |
| Runtime | Electron. Bundled Chromium. |
| Platforms | Windows and macOS. Linux is a non-goal. |
| Audience | Shipped to students, not a personal build. |
| Web asset delivery | Load the production origin directly. |
| Offline scope | Notes, notebooks, tags, search, ink, boards, flashcards. |
| Conflicts | Silent last-write-wins; losing copy kept in `note_versions`. |
| Local storage | Dexie over IndexedDB, replacing guest mode's localStorage. |

**Why Electron and not Tauri.** Tauri uses the OS webview, which is WebView2
(Chromium) on Windows but WebKit on macOS. Unote leans on transformers.js Whisper,
WASM tesseract, three.js and `model-viewer` — precisely where WebKit diverges. The
~150 MB per install buys the engine we actually test against.

**Why load the production origin.** Unote's session is an httpOnly, same-origin
cookie; `lib/api.ts` is explicit that no tokens are ever passed. Serving bundled
assets from `file://` or a custom protocol makes every API call cross-origin, stops
the cookie being sent, and forces CORS plus `SameSite=None` cookies or a whole token
auth path added server-side. Pointing the window at the real origin avoids all of it,
and web updates arrive automatically because the app genuinely *is* the website.

The cost is that **first launch needs internet once**, so the service worker can
install. Acceptable for something the user just downloaded, and handled explicitly in
§3.

---

## 3. The shell

`desktop/` at the repo root: `main.ts`, `preload.ts`, `offline.html`,
`electron-builder.yml`. It does not import from `web/` or `server/`.

- `BrowserWindow` with `contextIsolation: true`, `nodeIntegration: false`, and a
  preload exposing only `window.unoteDesktop = { version, platform }` over
  `contextBridge`. The web app must never gain Node access.
- `loadURL('https://unote-six.vercel.app')`. Electron's default session persists
  cookies to disk, so the login survives restarts with no extra work.
- **First-run-offline fallback.** If the service worker is already installed it
  serves `loadURL` even with no network. If it is not — first launch, no connection —
  `did-fail-load` fires and we load a bundled `offline.html` that explains the
  situation and offers Retry. Without this the user gets a Chrome error page.
- External links open in the system browser via `shell.openExternal`; in-app
  navigation is restricted to the production origin.

**Web code updates** use `vite-plugin-pwa` with `registerType: 'autoUpdate'`:
precache the build, install new deploys in the background, activate on next launch.

**No CSP change is required.** `worker-src 'self' blob:` is already present in both
`server/src/lib/csp.ts:82` and `vercel.json:22`. Registration must live in its own
module — **the sha256-pinned inline theme script in `web/index.html` must not be
touched**, since its digest is pinned in `csp.ts:27` and `vercel.json:22` and editing
even a comment inside it silently breaks the policy in production, with no symptom
beyond a wrong-theme first paint. `server/test/csp.test.ts` guards it; run
`npx vitest run test/csp.test.ts --root server` after any `index.html` change.

**Binary updates** use `electron-updater`, needed only when Electron or native bits
change. The update feed is hosted as static files on the same Vercel project under
`/desktop/`, which avoids distributing a GitHub token with the app.

**Signing is a prerequisite, not a detail.** macOS needs a Developer ID certificate
plus notarisation (Apple Developer Program, ~£79/yr); Windows needs Authenticode or
Azure Trusted Signing. Unsigned builds are blocked by Gatekeeper and flagged by
SmartScreen. This gates distribution, not development.

---

## 4. The local store

`web/src/lib/local/` — Dexie over IndexedDB. Tables mirror the server's shape, plus
two of the client's own.

| Table | Mirrors | Extra client columns |
| --- | --- | --- |
| `notebooks` | `notebooks` | `baseUpdatedAt` |
| `notes` | `notes` | `baseUpdatedAt` |
| `ink` | `note_ink` | `baseUpdatedAt` |
| `canvasItems` | `canvas_items` | `baseUpdatedAt` |
| `canvasEdges` | `canvas_edges` | `baseUpdatedAt` |
| `flashcards` | `flashcards` | `baseUpdatedAt` |
| `reviewLog` | `review_log` | append-only, no base |
| `blobs` | — | offline-inserted images and attachments |
| `outbox` | — | queued writes |
| `syncMeta` | — | cursor, server clock offset, index version |

`baseUpdatedAt` is the server `updated_at` this client last saw for that record. It
is the basis of conflict detection (§6) and must never be written by client code
except when applying a server record.

Guest mode moves onto this same store and stops being a separate system: it becomes
local-first with no account attached and sync disabled. `guestApi` is promoted to
`localApi`. `guestExport.ts` and `guestMigrate.ts` keep working against the new store
— migrate becomes "adopt this local data into a fresh account", which is the same
operation as a first push.

---

## 5. The seam

`lib/api.ts` currently branches on a boolean, `isGuest()`. It becomes a three-state
resolver.

| State | Reads | Writes | Sync |
| --- | --- | --- | --- |
| Guest, no account | local | local | none |
| Signed in, online | local | local, then server | live |
| Signed in, offline | local | local, then outbox | on reconnect |

Reads never wait on the network in any state. That is what makes the app feel local
rather than merely tolerant of disconnection, and it is why the desktop app will feel
faster than the website even when both are online.

**No page component changes.** The `ALWAYS_SERVER` set in `lib/api.ts` grows to cover
the endpoints that cannot work locally (§8). The default stays refusal rather than
fallthrough, as it is today.

Online writes still go local-first and then to the server. A single code path for
both connection states is the point: an "online" write that bypassed the local store
would leave the mirror stale and reintroduce the two-source-of-truth problem this
design exists to remove.

---

## 6. The sync engine

### Pull

New endpoint: `GET /api/sync/changes?since=<cursor>&limit=<n>`, returning created,
updated and tombstoned records across every mirrored table, each carrying
`updatedAt` and `deletedAt`, plus the server's own `now`.

**The cursor is a composite `(updated_at, id)`, not a bare timestamp.** With a bare
timestamp, `>` silently skips records sharing the boundary second and `>=` loops
forever on them. Both failures are invisible until a user loses a note.

The response is paginated: `{ cursor, hasMore, ...records }`, capped at `limit`
(default 500) records across all tables combined. The client loops while `hasMore`,
and commits each page to IndexedDB in one transaction with the new cursor — so an
interrupted first sync resumes from where it stopped rather than restarting.

Ownership differs by table and the query must respect it: `notebooks` and
`flashcards` carry `user_id` directly, while `canvas_items`, `canvas_edges` and
`note_ink` are scoped only by `note_id` and must join through `notes` to filter by
user. Covering indexes on `(user_id, updated_at, id)` — or the joined equivalent —
are part of the work; only `notes` has one today (`idx_notes_user_updated`).

Apply rule: a server record wins when its `updatedAt` beats the local copy's.
Applying it also sets `baseUpdatedAt`.

### Push

Drain the outbox in dependency order, because the server validates references:
`routes/notes.ts:196` returns 400 for an unknown `notebookId`. Order is
**notebooks → notes → ink, canvas, flashcards → review log**.

Two coalescing rules, both load-bearing:

- **Repeated updates to the same record collapse to one entry** holding the latest
  payload. A two-hour offline editing session must not queue thousands of PATCHes.
  This is the same accounting `useAutosave` already does in memory.
- **A delete supersedes pending updates** for that record.

Each entry carries `baseUpdatedAt`. The server compares it to the row's current
`updated_at`; a mismatch is a conflict.

### Conflicts

**The server is the sole authority.** On a mismatch it keeps whichever side is newer,
writes the loser to `note_versions` with `cause: 'conflict'`, and returns the winning
record. The client applies what it gets back. One decision point, one code path — a
client that resolved conflicts itself would need the same logic in two places and
would drift.

**Clock skew is the failure mode here**, and it is not hypothetical: an offline edit
carries only the client's claim about when it happened, so a client an hour fast wins
every conflict and one an hour slow loses every one. Every sync response includes the
server's `now`; the client stores the offset in `syncMeta` and translates its
timestamps into server time before sending.

The server does not trust the result. It clamps any submitted edit time to two
concrete bounds: **not later than the server's `now`**, and **not earlier than the
row's `created_at`**. Anything outside that window is replaced by the clamped value
rather than rejected, because rejecting it would strand the user's edit in the outbox
with nothing they could do about a wrong system clock.

**Accepted limitation.** `note_versions` covers notes only. Ink, canvas items, edges
and flashcards are per-item last-write-wins with no history, so a genuinely concurrent
edit to the same canvas item loses one side silently. Per-item granularity makes this
rare — items carry their own IDs, so moving two different shapes never collides — but
it is real and should not be described as safe.

---

## 7. Server changes required

| Change | Reason |
| --- | --- |
| **`updated_at` on `notebooks`, `canvas_edges`, `note_ink`, `flashcards`** | Only `notes` and `canvas_items` have one. Without it there is no way to ask what changed, so delta sync cannot exist for those tables. |
| **`deleted_at` on `notebooks`, `canvas_items`, `canvas_edges`, `note_ink`, `flashcards`** | Only `notes` has one. A hard delete cannot be replicated to a client that was offline when it happened; that client's outbox re-uploads the record and **resurrects it**, silently. |
| Accept client-supplied IDs on create | So an offline-created record keeps its identity and its inbound wikilinks. Accept only `newId()`'s own shape — 14 characters of the same 36-symbol alphabet — 409 on collision, and never let a supplied ID address a row the caller does not own. Absent the field, the server mints one as it does today. |
| `GET /api/sync/changes` | No delta endpoint exists. |
| `cause: 'conflict'` in the version enum | `schema.sql:103` lists `autosave, manual, ai, restore, import`. |
| Purge job covers new tombstones | `notes` tombstones are purged after 30 days on boot; the five new ones need the same treatment or they accumulate forever. |

`note_tags` needs nothing. Tags ride inside the note's PATCH payload
(`AutosavePayload.tags`) and are derived from it, so they replicate with the note.

---

## 8. Offline scope

| Surface | Offline | Notes |
| --- | --- | --- |
| Notes, notebooks, tags | full | Guest mode already implements most of the local shape. |
| Flashcards and SM-2 review | full | `review_log` is append-only, so it merges with no conflict resolution at all. The cheapest win here. |
| Ink, canvas boards | full | Per-item last-write-wins. Blob-heavy; see §9. |
| Search | full | See §10. |
| Images and attachments in notes | full | See §9. |
| AI chat, suggestions, review | needs net | Nothing queues a model call. |
| Import staging, lecture and photo import | needs net | Batches live server-side (`routes/imports.ts`). |
| Share links, guest join, comments | needs net | Inherently multi-party. |
| QR phone capture | needs net | Pairing is a server-minted session. |

Everything in the second group gets an explicit needs-internet state naming what is
unavailable, not a dead button. `ALWAYS_SERVER` in `lib/api.ts` is the single list.

---

## 9. Images and attachments

Notes can contain uploaded images (`routes/uploads.ts`, `attachments` table,
`stored_name`). An offline note that cannot take a screenshot is not offline, so this
is in scope rather than deferred.

Offline insert writes the bytes to the `blobs` table under a local ID, renders from an
object URL, and queues an upload. On reconnect the upload runs, and **the note's
content JSON is rewritten to the server URL** — which means the rewrite is itself a
note update that must go through the outbox, not a side-channel write. The blob is
dropped only once the rewrite has been confirmed.

This ordering matters: dropping the blob on upload success but before the rewrite
lands leaves a note pointing at nothing.

---

## 10. Offline search

MiniSearch over the local mirror, serialised into `syncMeta` and rehydrated on boot,
rebuilt when the index version changes, updated incrementally on every local write.

The parser in `routes/search.ts` supports exactly six things: bare terms, `"phrases"`,
`-excluded`, `tag:`, `-tag:` and `notebook:` (`SearchParsed`, `web/src/lib/types.ts:150`).
**All six are implementable locally** — the operators are filters over the mirror, and
phrases need an adjacency check over `contentText` that MiniSearch does not do natively.
Capability is not reduced.

**Ranking is what differs.** The server ranks with `ts_rank` over a generated `tsvector`
that weights title above body (`setweight(..., 'A')` / `'B'`, `schema.sql:87-90`).
MiniSearch will order results differently for the same query. The UI says "offline
search" when the local index answered, so a changed result order is explained rather
than mysterious.

---

## 11. Staging

| Stage | Scope | Effort |
| --- | --- | --- |
| 0 | Electron shell, service worker, updater, offline fallback page. App code offline; data still needs the network. **Independently shippable.** | 2 days |
| 1 | Schema prerequisites (§7), local store, three-state seam, sync engine. Notes, notebooks, tags, flashcards. **The real project.** | ~2 weeks |
| 2 | Ink, canvas boards, images and attachments offline. | ~5 days |
| 3 | Offline search index. | ~2 days |
| 4 | Yjs note bodies. Removes last-write-wins entirely. Deferred until Stage 1 is proven in real use. | later |

Stage 0 ships alone and is useful alone. Stage 1 is where the risk lives.

**The implementation plan covers Stages 0 and 1 only.** Stages 2 and 3 build on the
store and transport Stage 1 delivers, and specifying them before that exists would be
guessing at interfaces. They get their own plans.

Stage 4 is named here so Stage 1 is not built in a way that blocks it: note bodies
stay addressed as whole records with their own sync metadata, so swapping the body
representation later does not touch the transport or the store.

---

## 12. Testing

No single piece of this is hard. The risk is concentrated in one place: **sync bugs
destroy work, silently**, and this ships to students on two platforms.

- **A two-client convergence harness.** Drive two local stores against one server
  through scripted divergence — offline edits on both sides, deletes racing updates,
  a delete arriving at a client that edited the record — then assert final document
  state on both clients and the server.
- **The resurrection case gets its own test per table.** Client A goes offline and
  edits a record; client B deletes it; A reconnects. The record must stay deleted.
  This is the exact bug the missing tombstones would cause.
- **Clock-skew tests.** A client an hour fast and one an hour slow must both lose and
  win conflicts on the merits.
- **Outbox coalescing tests.** 500 edits to one note drain as one request.
- Playwright offline specs via `context.setOffline(true)`.
- Existing suites stay green: `npm run test -w server`, `npm run e2e`,
  `node scripts/smoke-api.mjs`, `node scripts/smoke-sync.mjs`.

The harness asserts converged content, not call counts. A capture harness on this
project once reported "78 screenshots captured, 0 failed" when all 78 were pictures
of the login form. A green count is not evidence.

---

## 13. Ruled out: Express and SQLite inside Electron

Tempting, given Unote began as a single-user local SQLite app, and it would make
everything work offline with no client changes at all. Three reasons it is wrong here.

1. **It breaks the actual requirement.** With the server local, any server-side change
   needs a new signed binary — the opposite of a web deploy reaching the app.
2. **A permanent dual-dialect tax.** Every migration written twice, forever.
3. **Search would diverge structurally.** The FTS is a generated `tsvector` column in
   the schema; SQLite FTS5 has no equivalent, so local and cloud results would rank
   differently by construction rather than by tuning.

It also does not remove the sync work. It relocates it to database replication and
adds schema translation on top.

---

## 14. Non-goals

- iOS and Android apps. The service worker work makes the site installable as a PWA
  on Android and iOS 16.4+ as a side effect, but no store build is in scope.
- Linux builds.
- Real-time collaboration. It falls out of Stage 4 and is not pursued before it.
- Offline AI, offline import staging, offline share links.
- Moving the source of truth off Neon. The server stays authoritative.
