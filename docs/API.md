# Unote API contract (v1)

Authoritative. Agents implement EXACTLY this; if something is missing, extend without breaking these shapes.
All responses JSON. Errors: `{ "error": string }` with 4xx/5xx status. IDs are lowercase alphanumeric strings.
Timestamps are ISO-8601 UTC strings. Booleans stored as 0/1 in SQLite but serialized as JSON booleans.

## Conventions
- Base: `/api`
- `Note` (full): `{ id, notebookId, title, contentJson (TipTap doc object), contentText, pinned, archived, createdAt, updatedAt, tags: string[], notebook: NotebookLite, attachments: Attachment[] }`
- `NoteLite` (lists): `{ id, notebookId, title, snippet (plain text ≤160 chars), pinned, archived, updatedAt, createdAt, tags: string[], notebook: NotebookLite, wordCount }`
- `NotebookLite`: `{ id, name, emoji, color }`
- `Attachment`: `{ id, kind ('photo'|'slides'|'transcript'|'image'|'file'), originalName, url ('/uploads/…'), mime, size, status, createdAt }`. The original files a note was imported/transcribed from ("never destructive OCR": the source stays one click away). Failed uploads are excluded.
- CORS: origins are restricted to localhost + private-LAN hosts (10.*, 192.168.*, 172.16-31.*, *.local) over http(s); extend via `FOLIO_CORS_ORIGINS` (comma-separated). Requests without an Origin header (curl, same-origin) are always allowed.
- "Today"/day-bucketed stats (`reviewedToday`, dashboard `weekActivity`) use the SERVER MACHINE'S LOCAL day boundaries, not UTC.

## Notebooks (routes/notebooks.ts)
- `GET /api/notebooks` → `{ notebooks: [{ id, name, emoji, color, position, archived, noteCount, lastNoteAt }] }` ordered by position.
- `POST /api/notebooks` `{ name, emoji?, color? }` → `{ notebook }` (400 if name empty)
- `PATCH /api/notebooks/:id` `{ name?, emoji?, color?, position?, archived? }` → `{ notebook }` (404 unknown)
- `DELETE /api/notebooks/:id` → `{ ok: true }` (cascades notes)

## Notes (routes/notes.ts)
- `GET /api/notes?notebookId=&tag=&archived=0&sort=updated|created|title&limit=50&offset=0` → `{ notes: NoteLite[], total }`
- `GET /api/notes/recent?limit=12` → `{ notes: NoteLite[] }` by updatedAt desc, excludes archived.
- `GET /api/notes/:id` → `{ note: Note, backlinks: NoteLite[], outgoingLinks: NoteLite[] }` (note includes `attachments`)
- `POST /api/notes` `{ notebookId, title?, contentJson?, contentText?, tags? }` → `{ note }` (400 bad notebookId)
- `PATCH /api/notes/:id` `{ title?, contentJson?, contentText?, pinned?, archived?, notebookId?, tags? }` → `{ note }` (fields optional; contentJson+contentText travel together)
  - `contentJson` (POST and PATCH) is structurally validated: it must be an object shaped `{ type: 'doc', content: [...] }`. Anything else (null, string, wrong type, missing content array) is rejected with 400 so a bricked note is impossible.
  - On content change: extract `[[Wiki Links]]` from contentText (regex `\[\[([^\[\]]+)\]\]`, `[[Title|Alias]]` resolves by Title), resolve case-insensitively against note titles, replace rows in `links`.
  - RENAME IS LINK-PRESERVING: when `title` changes, every live note whose content references `[[oldTitle]]` (case-insensitive, aliased forms included) has its content_text and wikilink nodes rewritten to the new title and its links re-resolved. Referencing notes' `updated_at` is NOT bumped (a rename shouldn't reorder the recency feed).
  - Version snapshot policy: on save, if the latest version for this note is older than 10 minutes OR cause differs, insert a version (cause 'autosave'). Always snapshot before 'restore' and before AI rewrites (cause 'ai').
- `DELETE /api/notes/:id` → `{ ok: true }`. SOFT delete: sets `deleted_at`, removes the note from every read path (lists, search, dashboard, tags, backlinks, AI retrieval), keeps the row + version history. Notes deleted >30 days ago are hard-purged on server boot.
- `POST /api/notes/:id/undelete` → `{ note }`. Restores a soft-deleted note within the retention window and re-resolves links in both directions. No-op (200) if the note isn't deleted; 404 if it never existed/was purged.
- `GET /api/notes/:id/versions` → `{ versions: [{ id, cause, label, createdAt, title, wordCount }] }` desc
- `GET /api/notes/:id/versions/:vid` → `{ version: { id, title, contentJson, cause, label, createdAt } }`
- `POST /api/notes/:id/versions` `{ label? }` → `{ version }` (cause 'manual')
- `POST /api/notes/:id/restore/:vid` → `{ note }` (snapshots current as cause 'restore' first)
- `GET /api/notes/:id/export?format=markdown` → `text/markdown` attachment; convert TipTap JSON → Markdown server-side.
- `GET /api/notes/:id/unlinked-mentions` → `{ notes: NoteLite[] }`. Notes whose text mentions this note's title but don't link it.

## Export (routes/export.ts)
Whole-account export, mounted at `/api/export` rather than under `/api/notes` so nothing has to be registered ahead of `/:id` to avoid being read as a note id.
- `GET /api/export/summary` → `{ notes, notebooks, maxNotes, included, truncated }`. What an export would contain and what the cap would leave out. The UI asks for this BEFORE offering the download, so a capped export is announced rather than discovered.
- `GET /api/export/all?format=markdown` → `application/zip` attachment. One folder per notebook, one `.md` per live note, plus a `README.md`. Each file opens with YAML frontmatter (`title`, `notebook`, `tags`, `updated`) in the shape `features/import/connectors/extract.ts` parses, so an export re-imports with its titles and tags intact. Canvas notes export their item text with a line saying the layout is not included. Bounded at 2000 notes / 25MB of Markdown so the function finishes inside its time limit; `X-Unote-Export-Notes` and `X-Unote-Export-Omitted` report the actual split.

## Search (routes/search.ts)
- `GET /api/search?q=...&limit=20` → `{ results: [{ note: NoteLite, snippetHtml, score }] }`
  - FTS5 `bm25` ranked; `snippetHtml` from `snippet(notes_fts, 1, '<mark>', '</mark>', '…', 12)`.
  - Sanitize q into an FTS MATCH string safely (wrap tokens in double quotes, strip FTS operators; support trailing prefix `*` on last token for search-as-you-type). Empty/invalid q → `{ results: [] }`, never 500.
- `GET /api/search/titles?q=...&limit=10` → `{ results: [{ id, title, notebook: NotebookLite, updatedAt }] }`. Fast title contains/prefix match for the quick switcher (Ctrl+K).

## Tags (routes/tags.ts)
- `GET /api/tags` → `{ tags: [{ tag, count }] }` ordered by count desc.

## Dashboard (routes/dashboard.ts)
- `GET /api/dashboard` → `{ recent: NoteLite[] (8), pinned: NoteLite[], continueNote: NoteLite|null (most recently updated), stats: { notes, notebooks, words, flashcardsDue }, weekActivity: [{ date: 'YYYY-MM-DD', count }] (last 14 days, edits per day from note_versions+notes.updated_at), notebooks: [{ id, name, emoji, color, noteCount, lastNoteAt }] }`

## AI (routes/ai.ts; uses ai/client.ts `chat`; NEVER model 'auto')
All AI endpoints return 502 `{ error, attempts? }` if every model fails. Long-running is fine (≤90s).
Size guard: note content sent to the model is capped at ~24k chars (8k for /title), truncated with a trailing `[truncated]` marker. A huge note can no longer hang the whole model-fallback chain.
- `POST /api/ai/improve` `{ noteId?, text?, instruction? }` → `{ markdown, model }`. Rewrite/improve notes (structure, clarity, headings, keep meaning; obey optional instruction). If noteId given, use its contentText; NEVER auto-writes the note. The client previews + applies.
- `POST /api/ai/summarize` `{ noteId }` → `{ markdown, model }`. TL;DR + key points + terms.
- `POST /api/ai/flashcards` `{ noteId, count? (default 8) }` → `{ cards: [{ id, question, answer }] }`. Generates AND inserts into flashcards table linked to note.
- `POST /api/ai/ask` `{ question, notebookId? }` → `{ answer (markdown), sources: [{ id, title }], model }`. Retrieve top 6 notes via FTS on the question keywords, stuff into context with titles, answer with citations by title. Empty corpus → helpful message, not error.
- `POST /api/ai/title` `{ noteId }` → `{ title }` (≤60 chars, no quotes).
- `POST /api/ai/clean` `{ noteId }` → `{ markdown, model }`. FORMATTING-ONLY beautification: structure (headings/lists/tables/code fences), punctuation, capitalisation and obvious typos improve; the student's wording is preserved (no paraphrasing, no added/dropped content). Client previews + applies; the server never writes the note.
- `POST /api/ai/gaps` `{ noteId }` → `{ markdown, model, sources: [{ name, kind }] }`. Study-assistant gap analysis. Compares the note against its own attachments' extracted text (transcripts/slides/photos, capped 8k chars each) plus standard topic coverage, and returns advisory markdown ("Missing from your notes" / "Worth double-checking" / "Next steps"). NEVER rewrites the note; the client's Assistant panel renders it, and any insertion into the note is an explicit user action.
- Prompts live in `ai/prompts.ts`, exported as functions.
- `GET /api/ai/usage` → `{ usingOwnKey, keyHint, baseUrl, models, user, ip, resetAt }`.
- `PUT /api/ai/key` `{ apiKey, baseUrl?, models? }` → `{ present, hint, baseUrl, models, health }`. `models` is a comma-separated string or an array (max 6). The response's `health` is a LIVE probe of the credential just saved, so the settings dialog can say whether it actually works rather than only that it was stored.
- `DELETE /api/ai/key` → same shape with `present: false` and `health` describing the shared pool the user has returned to.
- BYOK contract: a bare key inherits this deployment's `FOLIO_AI_BASE_URL` **and** its model chain. A key from a different provider needs `baseUrl` and `models` too - the operator's chain (`gemini-2.5-flash`, ...) 404s at `api.openai.com`. See docs/AI-DEPLOYMENT.md.
- CLIENT AI KILL-SWITCH: the web app has a user toggle (sidebar footer) that removes every AI affordance (AI menu, selection AI, Assistant, Ask AI, flashcard generation). It is a client-side preference (`localStorage folio:aiEnabled`); the endpoints above remain available.

## Import (routes/imports.ts; multer; 25MB limit; async jobs)
- `POST /api/import` multipart fields: `file` (required), `kind` = `photo|slides|transcript`, `notebookId` (required for new), `noteId?` (merge target), `mode` = `new|append|improve` (default new) → `{ jobId }`
  - photo: jpeg/png/webp/heic→ vision OCR (send as base64 data URL image_url) → clean structured Markdown (headings, lists, LaTeX-ish math as plain text ok).
  - slides: PDF or PPTX → unpdf `extractText` per page / officeparser → AI restructure into a proper lecture-note outline (per-slide headings collapsed into topical sections).
  - transcript: .txt/.md/.pdf/.docx → text → AI turn into structured notes / essay feedback per mode.
  - mode `new`: create note titled from content (AI title) in notebookId; a leading body H1 that duplicates the resolved title is stripped so the title never appears twice. `append`: append markdown to existing noteId. `improve`: merge extraction with existing note content → AI produce improved combined note (snapshot version cause 'import' first).
  - Concurrency: writes into an existing note (`append`/`improve`) are serialized per note, and each write re-reads fresh content inside a transaction. Overlapping imports (or an import racing a live edit) can no longer clobber each other. If the note changed during the AI merge call, `improve` degrades to a non-destructive append of the extracted material.
  - Markdown → TipTap JSON conversion happens server-side (lib/markdown.ts) so notes open natively in the editor. `[[Wiki Links]]` become real wikilink nodes (noteId resolved by title at conversion time; unresolved → noteId null, rendered in a 'missing' style client-side), and `$...$` / `$$...$$` become inlineMath/blockMath nodes.
- `GET /api/import/jobs/:id` → `{ id, status: 'queued'|'running'|'done'|'failed', step?: string, noteId?, error?, attachmentId? }` (in-memory job store fine)
- `POST /api/import/image` multipart `file` → `{ url: '/uploads/...' }`. Plain image upload for embedding in editor.

### Bulk import (routes/imports.ts + lib/importBatch.ts) - staging, grouping, commit
Nothing here writes into a real notebook until `/commit`. Documents and photos are staged into
`import_batches` / `import_items`, the proposed sort and grouping are persisted so review survives
a refresh, and closing the wizard discards the batch. Only `/group-ai` uses a model.

- `POST /api/import/batches` `{ source }` (`files|photos|markdown|...`) → `{ batchId }`
- `GET /api/import/batches/:id` → `{ batch, items }`
- `DELETE /api/import/batches/:id` → `{ ok: true }`. Discards staging, including staged attachments.
- `POST /api/import/batches/:id/items` - JSON `{ items: [...] }` for pre-extracted text, OR multipart
  `file` for an office doc / photo. Photo fields: `kind=photo`, `ocrText?` (client-side tesseract),
  `capturedAt?` (ISO, from EXIF), `sourcePath?`, `title?`.
- `POST /api/import/batches/:id/categorise` `{ categoriser, suggestions }` → `{ categoriser, items }`
- `PATCH /api/import/batches/:id/items/:itemId` - per-item decision (notebook, tags, title, accept/reject).
- `PUT /api/import/batches/:id/groups` `{ grouper, groups: [{ key, itemIds[], title?, rationale?, notebookId? }] }`
  → `{ items, grouper }`. **Grouping = which staged photos become PAGES OF ONE NOTE.** `itemIds` order
  becomes page order. Wholesale replace: any item not named is reset to ungrouped (its own note), and
  already-committed items are left alone. No AI, no quota.
- `POST /api/import/batches/:id/group-ai` → `{ items, grouper: 'ai' }`. Regroups with **ONE** model call
  for the entire batch, over the OCR text only, no image is sent. AI-gated (`aiQuotaGate`). Ids the
  model omits become single-photo groups, so no photo is ever lost. 503 when the gateway is down;
  the staged photos are untouched.
- `POST /api/import/batches/:id/commit` `{ itemIds }` → `{ created, skipped, failed, createdNotebooks, items, batchStatus }`
  Resumable and idempotent in slices (≤100 ids). `created` counts **notes, not items**: a group of
  twelve pages is one note. A group split across chunks appends to the note its committed sibling
  already made.

## Study (routes/study.ts, SM-2 lite)
- `GET /api/study/queue?limit=20&notebookId=` → `{ cards: [{ id, noteId, noteTitle, notebookId?, notebookName?, question, answer, dueAt, reps }] , due, total }` (due = due_at <= now, not suspended). `notebookId` scopes the queue AND the due/total counts to one notebook (cram a single module).
- `GET /api/study/cards` → `{ cards: [{ id, noteId, noteTitle, notebookId?, notebookName?, question, answer, dueAt, reps, suspended }] }`. ALL cards including suspended and not-yet-due, newest first. (Patch A: the Browse/manage tab needs the whole deck, which `/queue` (due-only) cannot supply.)
- `POST /api/study/review` `{ cardId, rating: 'again'|'hard'|'good'|'easy' }` → `{ card, nextDueAt }`
  - A card is "new" when `interval_days == 0 && reps == 0`.
  - again: reps=0, interval=0 (due now +1min), ease-0.2 (min 1.3).
  - hard: ease-0.15 (min 1.3). New card → first 'hard' = interval stays 0, reps stays 0, due in 10 minutes (short relearning step); a SECOND consecutive 'hard' from the new state graduates the card to reps=1, interval=1d so it can never loop in the 10-minute step forever. Established card → reps+1, interval*1.2.
  - good: reps+1, interval = reps==1?1d: interval*ease.
  - easy: ease+0.15 capped at 3.0 (ease ceiling: a run of 'easy' can't compound into multi-year intervals). New card → interval jumps to 4d, reps→1. Established card → reps+1, interval*(ease+0.15 capped)*1.3.
  - Log every review to review_log. (Patch B: new-card hard/easy branches + hard/easy now increment reps on established cards.)
- `GET /api/study/stats` → `{ due, total, reviewedToday, byNote: [{ noteId, noteTitle, total, due }] }`. `reviewedToday` counts the server machine's LOCAL day, not the UTC day.
- `PATCH /api/study/cards/:id` `{ question?, answer?, suspended? }` → `{ card }`
- `DELETE /api/study/cards/:id` → `{ ok: true }`

## Templates (routes/templates.ts, iteration 2)
- `GET /api/templates` → `{ templates: [{ id, name, emoji, description, contentJson, builtin, createdAt }] }` builtin first, then newest.
- `POST /api/templates` `{ name, emoji?, description?, contentJson }` → `{ template }` (400 empty name/invalid doc; contentJson passes the same structural validation as notes).
- `DELETE /api/templates/:id` → `{ ok: true }` (builtin templates CAN be deleted: user's choice).
- Built-ins seeded on boot if templates table is empty: "Lecture note" (Date/Topic/Key terms toggle/Worked example/Questions to review skeleton) and "Cornell notes" (columnList: cue column + notes column, summary callout strip at bottom).
- Creating a note from a template happens client-side: `POST /api/notes` with the template's contentJson (+contentText derived client-side or server derives when contentText omitted; server derives from contentJson when contentText is missing).

## Comments (routes/comments.ts, iteration 2, single-user margin notes)
- `GET /api/notes/:id/comments` → `{ comments: [{ id, noteId, anchorText, body, resolved, createdAt, updatedAt }] }` oldest first.
- `POST /api/notes/:id/comments` `{ anchorText?, body }` → `{ comment }` (400 empty body).
- `PATCH /api/comments/:id` `{ body?, resolved? }` → `{ comment }`
- `DELETE /api/comments/:id` → `{ ok: true }`
- Anchoring: the editor applies a `comment` mark (attrs `{ commentId }`) to the selected text; anchorText stores the selection snapshot for the margin list + orphan detection. Comment marks are stripped in markdown export.

## Search operators (iteration 2, routes/search.ts)
`GET /api/search?q=` now parses, in this order: `"exact phrase"` (FTS phrase query), `-word` (NOT), `tag:name` (filter note_tags), `notebook:name` (filter by notebook name, case-insensitive prefix), remaining words AND'd with trailing prefix `*` on the last. Response gains optional `parsed: { terms, phrases, excluded, tag, notebook }` echo. Invalid/empty after parsing → `{ results: [], parsed }`, never 500.

## Manual flashcards (iteration 2, routes/study.ts)
- `POST /api/study/cards` `{ noteId?, question, answer }` → `{ card }` (400 empty q/a; new card: ease 2.5, interval 0, due now).

## Dashboard v2 (iteration 2, routes/dashboard.ts)
`GET /api/dashboard` response adds:
- `weekGrid`: 7 entries Mon-Sun of the CURRENT week `{ date, dayLabel ('Mon'..), total, byNotebook: [{ id, emoji, color, count }] }` (activity = notes created/updated + versions that local-tz day).
- `weeklyReview`: `{ notesEditedThisWeek, flashcardsDue, notesWithoutSummary (no h2 'Summary'/callout and >200 words), unresolvedComments, suggestions: string[] (max 4 short actionable lines derived from the numbers) }`.
- `recall`: per non-archived notebook `{ notebook: NotebookLite, lastNote: NoteLite|null, daysSince, quiz: { cardId, question, answer } | null }` (quiz = oldest-due or random card from that notebook's notes), ordered by daysSince desc, max 6.

## Meta (routes/meta.ts)
- `GET /api/meta` → includes `ai.configured` (means "could actually work", not "a key string exists") and `ai.problem`.
- `GET /api/meta/ai-health` → `{ ok, model?, error?, source: 'shared-pool'|'own-key', reason?: 'not_configured'|'unreachable', hint? }`. **Per user**: probes the caller's own saved key when they have one, so bringing a working key enables AI even while the operator's shared gateway is down. Every AI affordance in the web client is gated on this (`web/src/lib/aiStatus.ts`).
- `GET /api/meta/qr`

## Seed (src/seed.ts, `npm run seed -w server`)
Idempotent-ish (safe to rerun: wipes and recreates seed data only when DB empty OR `--force`).
Creates 5 notebooks: 📗 Algorithms & Data Structures, 🗄️ Databases, ⚙️ Operating Systems, 🧩 Software Engineering, ✨ Personal.
≥14 realistic 2nd-year CompSci notes (real content: Big-O, sorting, B-trees, SQL joins & normalisation, transactions, scheduling, paging, deadlock, design patterns, testing, agile, plus personal notes), with tags (#week1..), [[wikilinks]] between related notes, a few pinned, staggered created/updated dates across past weeks, ~12 flashcards across notes (some due now), and 2-3 versions on one note.
TipTap JSON content with varied blocks: headings, bullet/ordered lists, task lists, code blocks with language, blockquotes, callouts if supported, tables.
