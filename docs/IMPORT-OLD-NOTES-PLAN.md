# Import old notes - implementation plan

Design only. No code here. This plan describes a prominent "Import old notes" flow that lets a
student bring an existing pile of material into Folio: bulk documents, bulk photos, and an
extensible set of source connectors. Everything is auto-sorted into categories (notebooks and
tags), then the student reviews and corrects the proposed sort before anything is committed to
their real notebooks.

The single hardest constraint shapes the whole design: **Folio's AI gateway is not reachable in
production today** (`FOLIO_AI_BASE_URL` points at localhost, which a Vercel function cannot
reach). So auto-sort must work with zero AI and get better, not appear or disappear, when AI is
available. The categoriser is therefore a pluggable strategy with a real heuristic fallback.

---

## 0. What already exists (and is reused, not rebuilt)

The current single-file import pipeline is solid and we build on it rather than around it:

- **`POST /api/import`** (`server/src/routes/imports.ts`): multipart upload of one file, with
  `kind` in {photo, slides, transcript} and `mode` in {new, append, improve}. Every kind ends in
  at least one AI call (photo -> vision OCR, slides -> restructure, transcript -> notes). It
  creates exactly one note. **This path is AI-required today.** We leave it untouched and add a
  parallel bulk path beside it.
- **`import_jobs` table** + **`GET /api/import/jobs/:id`** + `useImportJob` poller (800ms): the
  durable, serverless-safe progress mechanism. Reused for per-item work.
- **`attachments` table**: `bytes BYTEA` in-row (no durable disk on Vercel), `extracted_text`,
  `kind` in {photo, slides, transcript, image, file}, `status` in {uploaded, extracting, ready,
  failed}. Reused verbatim for staged uploads; the bytes ARE the storage.
- **`server/src/lib/extract.ts`** (`extractFromUpload`): PDF via `unpdf`, PPTX/DOCX via
  `officeparser`, TXT/MD plain read. Reused for server-side extraction of Office formats.
- **`server/src/lib/attachments.ts`**: `insertAttachment`, `withTempFile`, `attachmentUrl`,
  `claimAttachmentsForNote`. Reused.
- **`server/src/lib/markdown.ts`**: `markdownToTipTap`, `markdownToPlainText`,
  `stripLeadingTitleHeading`. Reused to turn extracted markdown into note content WITHOUT any AI.
- **The lecture flow** (`web/src/features/import/lecture/*`): the precedent that matters most. It
  extracts slides and Whisper captions **entirely in-browser** (transformers.js), builds a TipTap
  document client-side (`buildNote.ts`), uploads only the small derived JPEGs one-per-request with
  bounded concurrency under the 4MB cap (`lectureApi.ts`), and creates the note through plain
  `POST /api/notes` with **no AI call at all**. This is the template for the whole bulk path:
  do the heavy lifting in the browser, keep each request tiny, and never depend on the gateway.
- **`openImportModal` bus** (`web/src/components/importModalBus.ts`) + `ImportModalHost` in
  `App.tsx` + CommandPalette entries: the existing global entry point. The new flow plugs into the
  same host so the button can be triggered from anywhere.
- **Categories** = **notebooks** (`notebooks` table, per-user, emoji + colour) and **tags**
  (`note_tags`, normalised lowercase via `tags.ts`). These are the label space the categoriser
  sorts into. No new concept of "category" is invented.

Serverless facts that constrain everything below: request body cap ~4.5MB (we self-limit to 4MB),
function timeout ~60s, no durable local disk, and background work after `res.json()` is not
guaranteed to survive instance freeze. Consequence: **bulk work is orchestrated from the client**
(one small request per item, resumable), exactly as the lecture flow already does.

---

## 1. UX flow

One prominent entry point ("Import old notes", in the sidebar header and the command palette)
opens a full-screen **Import wizard** with four stages: Source -> Ingest/Extract -> Review ->
Commit. All three of Sampo's paths (documents, photos, anything-else) are the SAME wizard with a
different source connector chosen at stage 1.

### Stage 1 - Source picker (the "import from anything" grid)

```
+------------------------------------------------------------------+
|  Import old notes                                            [x]  |
|  Bring an existing pile of notes into Folio. Nothing is added    |
|  to your notebooks until you review and confirm it.             |
|                                                                  |
|   [ Documents ]   [ Photos ]     [ Markdown ]    [ Obsidian ]    |
|   PDF DOCX PPTX   JPG PNG HEIC   .md + folders   vault folder    |
|                                                                  |
|   [ Notion ]      [ Google Docs] [ Plain text ]  [ More... ]     |
|   .zip export     (connect)      .txt            paste / other   |
|                                                                  |
|  Tip: dropping a FOLDER keeps its structure as your notebooks.  |
+------------------------------------------------------------------+
```

The grid is rendered from the connector registry (section 6), so adding a source adds a tile with
no wizard changes. Greyed tiles show a "needs setup" or "coming soon" state.

### Stage 2 - Ingest and extract

Drag-drop or browse (supports `webkitdirectory` for folders and `.zip`). As files arrive they are
listed with a per-item status that streams: queued -> extracting -> ready / failed. Extraction
happens client-side wherever possible (section 4), so a 200-file, 300MB Obsidian vault never
uploads 300MB; only the extracted text and any photo bytes cross the wire.

```
+------------------------------------------------------------------+
|  Documents  -  reading 42 files                                  |
|  [##############################----------]  31 / 42            |
|                                                                  |
|   databases/lecture-3.pdf .............. ready   1,240 words     |
|   databases/indexing.md ................ ready     980 words     |
|   os/scheduling.docx ................... extracting...           |
|   random-scan.pdf ...................... failed  (no text)       |
|                                                                  |
|                        [ Cancel ]   [ Continue to review -> ]    |
+------------------------------------------------------------------+
```

When extraction finishes, the categoriser runs automatically (section 5). A banner states which
strategy ran, honestly:

- AI reachable / personal key: "Sorted with AI - review the suggestions below."
- No AI: "Sorted by folder, filename and keywords (AI is offline) - review and adjust below."

Either way the user lands on the same review screen. AI-down never blocks the import.

### Stage 3 - Review and verify (the core screen)

This is where nothing-commits-until-confirmed lives. Left rail = the proposed categories
(notebooks). Main area = items grouped under their proposed notebook. Every item shows the
proposed notebook (editable), proposed tags (editable), a confidence dot, and a preview toggle.

```
+---------------------------------------------------------------------------+
|  Review import - 42 notes into 5 notebooks        [Filter: All v]  [x]   |
|                                                                           |
|  CATEGORIES            |  Databases  (12 notes)         [Accept all ^]    |
|  --------------------- |  -------------------------------------------     |
|  > Databases     12    |  [x] B-Trees and indexing                        |
|    Operating Sys  9    |      from databases/indexing.md                  |
|    Networks       7    |      Notebook [Databases        v]   .high       |
|    * Algorithms   6 NEW|      Tags [#databases] [#indexing] [+]           |
|    Unsorted       8    |      [ preview v ]                                |
|  --------------------- |  ------------------------------------------      |
|  + New notebook        |  [x] Query planning                              |
|                        |      from databases/lecture-3.pdf                |
|  Bulk actions:         |      Notebook [Databases        v]   .med        |
|  [Accept selected]     |      Tags [#databases] [+]                       |
|  [Move to... v]        |      [ preview v ]                               |
|  [Reject selected]     |  ------------------------------------------      |
|  [Merge into note...]  |  [ ] random-scan.pdf   (no text extracted)       |
|                        |      Notebook [Unsorted    v]   reject? [x]      |
|  ----------------------|-------------------------------------------       |
|         42 selected  -  create 4 notebooks + 1 new   [ Import 42 notes ]  |
+---------------------------------------------------------------------------+
```

Interactions the review screen must support:

- **Per item**: change proposed notebook (dropdown of existing + "New notebook..."), edit tags
  (add/remove chips), rename the note title inline, expand a read-only preview of the extracted
  content, accept (checkbox on) or reject (checkbox off).
- **Bulk**: select-all / select-by-notebook / select-by-confidence ("select all low confidence"),
  then "Move selected to notebook X", "Accept selected", "Reject selected".
- **Merge**: an item (or several) can be redirected from "create a new note" to "append/merge into
  an existing note", reusing the existing `mode: append|improve` machinery. Useful when re-importing
  material that belongs in a note the student already has.
- **New notebooks**: proposals marked `NEW` in the rail. The user can rename them, give an emoji,
  or drag their items elsewhere before commit. New notebooks are only actually created on commit,
  and only if they still hold at least one accepted item.
- **Confidence** is shown as a dot (high/med/low), and low-confidence items can be surfaced first
  so the review effort goes where the machine was least sure. With the heuristic strategy,
  confidence is derived (folder match = high, keyword-only = low); it is honest, not decorative.

### Stage 4 - Commit and done

Commit is client-orchestrated (section 3) so a large batch cannot hit the function timeout and is
resumable. Progress mirrors the lecture upload UI.

```
+------------------------------------------------------------------+
|  Importing...  [######################------]  33 / 42           |
|  Creating "Algorithms" notebook... filing notes...              |
+------------------------------------------------------------------+
        v
+------------------------------------------------------------------+
|  Done. 41 notes imported into 5 notebooks (1 new).              |
|  1 item skipped (no text could be read): random-scan.pdf        |
|  [ Go to Databases ]   [ Review skipped ]   [ Close ]           |
+------------------------------------------------------------------+
```

### Photos path (differences)

Same wizard; the Photos connector downscales client-side (reuse `downscale.ts`) and each photo's
bytes DO need to be stored (the note shows the image), so each downscaled photo uploads as one
`attachment` under the 4MB cap, bounded-concurrency, exactly like lecture slides. Auto-sort for
photos uses filename, EXIF/lastModified date, and - if OCR is available - extracted text (section
4). The review screen shows a thumbnail per item instead of a word count. A common pattern
(several photos of one multi-page handout) is supported by a "group into one note" action in
review, reusing the existing multi-page chaining.

---

## 2. Data model

Nothing lands in a real notebook until the user commits, so we need a **staging area**. Two new
tables; `attachments` and `import_jobs` are reused as-is.

```sql
-- One "Import old notes" session.
CREATE TABLE IF NOT EXISTS import_batches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL,                 -- connector id: files | photos | obsidian | notion | ...
  status TEXT NOT NULL DEFAULT 'open',  -- open | categorised | committing | committed | discarded
  categoriser TEXT,                     -- which strategy produced the suggestions: heuristic|llm|browser
  item_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (...utc...),
  updated_at TEXT NOT NULL DEFAULT (...utc...)
);
CREATE INDEX IF NOT EXISTS idx_import_batches_user ON import_batches(user_id, created_at DESC);

-- One staged document/photo awaiting review. Content lives here, NOT in notes, until commit.
CREATE TABLE IF NOT EXISTS import_items (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- denormalised, like notes
  attachment_id TEXT REFERENCES attachments(id) ON DELETE SET NULL, -- photos + office files
  source_path TEXT,                     -- 'databases/indexing.md' -> the strongest sort signal
  original_name TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',        -- derived, user-editable
  content_json TEXT,                     -- TipTap JSON built at extraction time (nullable until ready)
  content_text TEXT NOT NULL DEFAULT '', -- plaintext mirror, also feeds the categoriser
  source_tags TEXT NOT NULL DEFAULT '[]',-- tags found in the source (frontmatter, #hashtags, Notion props)

  -- Suggestion (what the categoriser proposed)
  suggested_notebook_id TEXT,            -- an existing notebook, or NULL when proposing a new one
  suggested_notebook_name TEXT,          -- for a proposed NEW notebook not yet created
  suggested_tags TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0,
  rationale TEXT,                        -- 'matched folder Databases' - shown on hover, aids trust

  -- Decision (what the user chose; defaults mirror the suggestion)
  decided_notebook_id TEXT,
  decided_notebook_name TEXT,
  decided_tags TEXT,
  decided_mode TEXT NOT NULL DEFAULT 'new', -- new | append | improve
  decided_target_note_id TEXT,           -- for append/improve

  status TEXT NOT NULL DEFAULT 'pending',-- pending|extracting|categorised|ready|accepted|rejected|committed|failed
  note_id TEXT,                          -- set once committed
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (...utc...)
);
CREATE INDEX IF NOT EXISTS idx_import_items_batch ON import_items(batch_id, created_at);
```

Notes on the model:

- **Staging is the whole point.** Content sits in `import_items.content_json` and is copied into a
  real `notes` row only at commit. Discarding a batch (`DELETE`) cleans up items and their staged
  attachments via cascade, and no notebook was ever touched.
- **`attachments` reused unchanged.** A photo or an Office file that needed server extraction is
  stored as an attachment (bytes in-row) with `note_id = NULL` while staged; commit sets its
  `note_id` (reusing the existing `claimAttachmentsForNote` idea). Client-extracted text files
  (md/txt/pdf) need no attachment row at all - only their text is staged.
- **`import_jobs` reused** for the one place a single item still runs a real server job: server-side
  extraction of an uploaded Office file (and, later, optional gateway OCR of a photo). The batch and
  item status fields carry batch-level progress; `import_jobs` stays the per-file work record so the
  existing poller and its ownership checks are reused verbatim.
- Proposed-new-notebook is represented by `(suggested_notebook_id = NULL, suggested_notebook_name =
  'Algorithms')`. Commit resolves the name to a real notebook once, then files every item that chose
  it. This is what stops the categoriser from silently spawning notebooks before the user agrees.

---

## 3. API surface

All under `/api/import`, behind the existing `requireAuth` mount. The bulk endpoints are
deliberately NOT behind `aiQuotaGate` (unlike `POST /api/import`), because the default path uses no
AI; the categorise endpoint applies the gate only when it actually calls a model.

| Method + path | Purpose |
| --- | --- |
| `POST /api/import/batches` | Create a batch `{ source }`. Returns `{ batchId }`. |
| `POST /api/import/batches/:id/items` | Add staged items. JSON body for pre-extracted docs (`{ items: [{ originalName, sourcePath, title, contentJson, contentText, sourceTags }] }`), OR multipart for files that need server extraction (docx/pptx/photo) - server extracts, stores the attachment, returns the staged item. Batched, one small request per few items. |
| `POST /api/import/batches/:id/categorise` | Run the categoriser over items lacking a suggestion. Returns `{ categoriser, items: [suggestion] }`. Server picks the best available strategy and degrades to heuristic; the client may also pass `strategy: 'heuristic'` to force the no-AI path. Applies `aiQuotaGate` internally only if it chose the LLM strategy. |
| `GET /api/import/batches/:id` | Batch + all items with suggestions and decisions. The review screen polls this while extraction/categorisation is still streaming. |
| `PATCH /api/import/batches/:id/items/:itemId` | Record a user decision: `decidedNotebookId` or `decidedNotebookName`, `decidedTags`, `title`, `status: accepted|rejected`, or `decidedMode/decidedTargetNoteId` for merge. |
| `POST /api/import/batches/:id/commit` | Commit a slice of accepted items (client sends item ids in small chunks, resumable). Creates any newly-approved notebooks once, creates notes via the existing no-AI note-create path, sets tags, files attachments, marks items `committed` with their `note_id`. Idempotent: already-committed items are skipped. Returns created note ids + notebook ids + a running tally. |
| `DELETE /api/import/batches/:id` | Discard a staging batch and its uncommitted attachments. |
| `GET /api/import/sources` | The connector registry: available source ids, labels, capabilities, and setup state. Drives the Stage-1 grid so new sources need no client change. |

Client additions in `web/src/lib/api.ts` mirror these (`api.createImportBatch`, `api.addImportItems`,
`api.categoriseBatch`, `api.importBatch`, `api.decideImportItem`, `api.commitImport`,
`api.discardImportBatch`, `api.importSources`). New types in `types.ts`: `ImportBatch`,
`ImportItem`, `ImportSuggestion`, `ImportSource`.

Why commit is chunked and client-driven: a 200-item batch cannot be committed in one request under
a 60s function timeout, and background work after the response is not guaranteed to run to
completion on serverless. So the client loops "commit next N accepted items" and polls, exactly the
resumable pattern the lecture upload and the ImportModal chain already use. If the tab closes
mid-commit, re-opening the batch shows what is already committed and offers to finish the rest.

---

## 4. Extraction - client-side vs server-side

Principle inherited from the lecture flow: extract in the browser wherever a browser library exists,
so big files never hit the 4MB body cap and the server never has to hold state. Only send up the
small extracted text (and, for photos, the downscaled bytes).

| Format | Where | How | Notes |
| --- | --- | --- | --- |
| TXT / MD | Client | `FileReader` + `markdownToTipTap` shipped to the client (or a small client markdown parser) | Frontmatter and `#tags` parsed for sort signal. Zero upload of the raw file. |
| PDF | Client (preferred) | `pdf.js` text layer in the browser | Only extracted text uploads. Falls back to the server `unpdf` path if a PDF fails client-side. Scanned/image-only PDFs yield no text -> flagged "no text" in review (candidate for OCR later). |
| DOCX / PPTX | Server | existing `extractFromUpload` (`officeparser`) | No good browser equivalent, so the file uploads (must be < 4MB) to `POST /items` multipart and is extracted server-side, reusing `withTempFile`. |
| Photos (JPG/PNG/HEIC/WEBP) | Client for bytes; OCR is the open question | `downscale.ts` to shrink; store as `attachment` | See OCR below. |

OCR for photos - the honest reality:

- **EasyOCR exists on Sampo's dev machine but is irrelevant here**: it is a Python/torch stack that
  cannot run in a Vercel function or the browser. It is not part of the shipping plan.
- **MVP (no AI): no OCR.** A photo imports as an image note (thumbnail + attachment), sorted by
  filename and EXIF/lastModified date. This is genuinely useful (the photos are captured, filed, and
  visible) and never depends on AI. Full-text search of the handwriting is simply deferred.
- **Phase 2 option A - gateway vision OCR**: reuse the exact `ocrPhotoPrompt` path the current photo
  import uses, but only when AI is reachable (or the user has a personal key), behind `aiQuotaGate`,
  and clearly optional ("Read text from photos" toggle, off by default for a big batch to protect
  the quota).
- **Phase 2 option B - in-browser OCR**: `tesseract.js` or a transformers.js TrOCR model, no AI
  dependency, no quota, at the cost of a multi-MB model download and slow per-image processing.
  Offer it as an opt-in for users who want searchable photo text offline.

Extracted text always becomes a TipTap document via the existing `markdownToTipTap` /
`plainTextFromDoc` helpers - no AI is required to turn a document into a note. AI, when present, only
improves the STRUCTURE (the existing slides/transcript restructure prompts), and that becomes an
optional per-item "Tidy with AI" action in review, never a precondition for import.

---

## 5. The pluggable categoriser

A single interface, three interchangeable backends, always wrapped so a failure degrades to the
heuristic. The categoriser sorts items into the existing label space (notebooks + tags).

```ts
interface CategoriserInput {
  items: Array<{
    id: string;
    title: string;
    text: string;          // extracted plaintext (may be '')
    filename: string;
    folderPath?: string[];  // ['databases'] - strongest signal
    sourceTags?: string[];  // frontmatter / #hashtags / Notion props
  }>;
  labelSpace: {
    notebooks: Array<{ id: string; name: string; emoji: string }>;
    tags: string[];
    // Per-notebook term profile, precomputed from the user's existing notes' content_text.
    notebookProfiles?: Map<string /*notebookId*/, Map<string /*term*/, number /*weight*/>>;
  };
}

interface Suggestion {
  itemId: string;
  notebook: { kind: 'existing'; id: string } | { kind: 'new'; name: string; emoji?: string };
  tags: string[];
  title?: string;
  confidence: number;      // 0..1, honest per strategy
  rationale?: string;      // 'matched folder "databases"'
}

interface Categoriser {
  readonly id: 'heuristic' | 'llm' | 'browser-embed';
  categorise(input: CategoriserInput): Promise<Suggestion[]>;
}

// Selection, with graceful degradation baked in:
async function pickCategoriser(ctx): Promise<Categoriser>  // llm if AI healthy/personal key,
                                                           // else browser-embed if model cached,
                                                           // else heuristic. Always falls back
                                                           // to heuristic on any error.
```

### (a) Heuristic strategy - the always-available fallback, in detail

Runs with zero AI, cheaply, and can run client-side (free, private, no quota) or server-side. It
composes four signals in priority order and stops at the first confident hit:

1. **Folder structure (highest confidence).** `folderPath` from the source (a dropped folder, an
   Obsidian vault, a Notion zip) is the best signal a student ever gives us. Match each path segment
   against existing notebook names, case-insensitively and with light fuzz (slugify both sides,
   allow singular/plural and separator differences). A match -> that notebook, confidence ~0.9. A
   consistent unmatched folder shared by several items -> propose ONE new notebook named after the
   folder, confidence ~0.8.
2. **Source tags / frontmatter (high).** YAML `tags:` in Markdown, inline `#hashtags`, Notion's
   "Tags" property. Normalise through the existing `normalizeTag` rule and attach them as the item's
   tags directly. If a tag equals an existing notebook name, treat it as a notebook hint too.
3. **Keyword / TF-IDF similarity to existing notebooks (medium).** Precompute a term-frequency
   profile per existing notebook from its notes' `content_text` (a cheap bag-of-words with stopword
   removal; the `notebookProfiles` map). For an item with no folder/tag signal, build its own TF-IDF
   vector and score cosine similarity against each notebook profile. Assign to the nearest notebook
   above a threshold (say 0.15), confidence scaled by the score. This is what sorts a loose pile of
   PDFs into the right existing notebooks by topic, with no AI.
4. **Clustering the remainder (low).** Items that still match nothing are clustered among themselves
   (a light agglomerative pass over their TF-IDF vectors). Each cluster above a small size becomes a
   proposed new notebook whose name is its top distinguishing terms (for example "Graphs, BFS,
   Dijkstra" -> propose "Graphs"). Tiny leftovers go to a single **Unsorted** bucket. Confidence low
   by construction, so review surfaces them first.

Tags, independent of notebook: derive a few candidate tags per item from its top TF-IDF terms that
also already exist in the user's tag vocabulary (so we reinforce their taxonomy rather than invent
noise), plus any source tags from signal 2.

This strategy alone delivers the MVP promise: a usable suggested sort the student corrects in
review, and it cannot break when AI is down.

### (b) LLM strategy - the upgrade when the gateway is reachable

Same interface. A new `categorisePrompt(items, labelSpace)` in `server/src/ai/prompts.ts` sends
compact per-item summaries (title + a capped snippet + folder + source tags) plus the label space
(existing notebook names + top tags) and asks for a strict JSON array of assignments with
confidence and any proposed new notebooks. Reuses `complete()` / `chat()` and `extractJson()`
verbatim, and the `UNTRUSTED_NOTICE` fencing (imported files are untrusted input - the existing
prompt hardening already exists for exactly this). Runs behind `aiQuotaGate`. Batched: many items
per call (respect `AI_MAX_CHARS`, chunk if needed) so a 40-file import spends one or two calls, not
forty, protecting the shared pool. On quota exceeded (429) or any failure, `pickCategoriser` falls
straight back to the heuristic and the review banner says so.

### (c) In-browser strategy - later, best of both

A transformers.js embedding model (for example a small MiniLM) computes a semantic vector per item
and per notebook profile, replacing the TF-IDF cosine in heuristic step 3 with real semantic
similarity. No server, no quota, private. It slots in as a third `Categoriser` with the same
interface; the only new machinery is a cached model download, and the lecture worker already proves
transformers.js runs in this app's CSP.

The selection order (`pickCategoriser`) means the app quietly uses the best backend available and
the user experience is identical: suggestions appear, they get reviewed. "AI is down" only ever
changes the quality of the first guess, never whether the import works.

---

## 6. "Import from anything else" - the connector pattern

New sources must be cheap to add, so ingestion is a registry of adapters that all normalise into one
shape, `RawDoc`, which then flows through the same extract -> stage -> categorise -> review -> commit
pipeline. A source is added by writing one connector and registering it; the wizard, the pipeline,
and the review screen do not change.

```ts
interface RawDoc {
  externalId?: string;       // dedupe / re-import
  title?: string;
  folderPath?: string[];     // category signal
  sourceTags?: string[];     // category signal
  // exactly one of these two:
  text?: string;             // already-extracted markdown/plain (md, notion, gdocs export)
  file?: File;               // needs extraction (pdf/docx/pptx/photo)
  attachments?: File[];      // embedded images to store alongside
  createdAt?: string; updatedAt?: string;
}

interface SourceConnector {
  id: string;                // 'files' | 'photos' | 'markdown' | 'obsidian' | 'notion' | 'gdocs' | ...
  label: string;
  icon: IconName;
  accept?: string;           // file-input accept, if file-based
  supportsFolder?: boolean;  // webkitdirectory
  setup?: 'none' | 'oauth' | 'coming-soon';
  ingest(input: FileList | OAuthHandle): AsyncIterable<RawDoc>;
}
```

The connectors are almost entirely client-side (they read files/folders/zips and yield RawDoc), so
the server stays a thin staging + commit surface. The registry is exposed via
`GET /api/import/sources` only so server-gated sources (OAuth) can advertise their availability.

Prioritised first set (value vs effort):

1. **Files (generic)** - multi-file PDF/DOCX/PPTX/TXT/MD. MVP. This is the current formats, in bulk.
2. **Photos** - multi-image, downscale, optional OCR. MVP.
3. **Markdown / plain text with folders** - nearly free once Files exists, and the RICHEST heuristic
   signal (folder = notebook, frontmatter = tags). MVP.
4. **Obsidian vault** - a folder or `.zip` of `.md` with YAML frontmatter tags and `[[wikilinks]]`.
   High value and cheap because Folio ALREADY supports wikilinks and tags natively, so an Obsidian
   note maps almost one-to-one. Phase 2.
5. **Notion export** - `.zip` of Markdown + CSV; strip Notion's hashed filename suffix, folders ->
   notebooks, the "Tags"/multi-select property -> tags. Phase 2.
6. **Google Docs** - via Drive OAuth (the estate already has a Google OAuth app; add a read-only
   Drive scope) exporting each doc to markdown/text. Or, with zero new infrastructure, the user
   exports as .docx and uses the Files connector today. Phase 3 for the OAuth version.
7. **Apple Notes** - no clean API; realistic path is user-exported PDFs or an `.enex`/`.txt` dump,
   handled as a file connector. Phase 3, lowest priority; document the manual export.

---

## 7. Phased delivery

**Phase 1 - MVP, zero AI dependency (ship first).**
The smallest genuinely useful slice, and the one that proves the architecture:
- Import wizard shell + Source grid with the **Files**, **Photos**, and **Markdown/folder**
  connectors.
- Client-side extraction: TXT/MD in-browser, PDF via pdf.js, DOCX/PPTX via the existing server
  extractor; photos downscaled and stored as attachments (no OCR yet).
- Staging tables (`import_batches`, `import_items`) + the batch API + client-orchestrated commit.
- **Heuristic categoriser only** (folder + frontmatter + TF-IDF + clustering), running client-side.
- Full review screen: per-item and bulk accept/reassign/edit-tags/reject, new-notebook approval,
  merge-into-existing, confidence sorting.
- Commit path reusing the no-AI note-create path (`markdownToTipTap` + `POST /api/notes`).
Outcome: a student can drop a folder of old notes and get them sorted, reviewed, and filed, with the
gateway completely offline.

**Phase 2 - richer sources + AI upgrade.**
- ~~Obsidian and Notion connectors.~~ **Shipped**, along with Google Docs, which moved up from
  Phase 3: `web/src/features/import/connectors/sources/`. All three read exported FILES in the
  browser, so none of them needs a credential or a deployment secret, and `sourcesRegistry()`
  now advertises them as `setup: 'none'`. Google Docs is the Takeout / "File > Download" path -
  a Drive OAuth connector can be added beside it later without changing anything downstream.
  Two things the plan did not anticipate, both in the connectors' own tests:
  - The **size budget has to be spent after filtering, not before.** Archive entries are read in
    order, so a vault whose `attachments/` folder sorts first ate the 40MB budget its notes
    needed. `SourceConnector.keepPath` is applied inside `expandZip` for that reason, and a
    truncated archive now says so instead of quietly importing half a vault.
  - **Notion writes page properties as bare `Key: value` lines** under the H1, with no
    frontmatter fence, so the generic parser cannot see them. `RawDoc.transformText` exists to
    give one source a hook into extraction without the pipeline learning about connectors.
- **LLM categoriser** behind the same interface, used when AI is healthy or a personal key is set,
  batched and quota-gated, degrading to heuristic. Review banner states which ran.
- Optional photo OCR (gateway vision or tesseract.js), off by default for large batches.
- Optional per-item "Tidy with AI" in review (reuse existing restructure prompts).

**Phase 3 - offline-smart + connected sources.**
- In-browser embedding categoriser (transformers.js) replacing TF-IDF similarity.
- Google Docs via Drive OAuth (the file-based Google Docs connector shipped in Phase 2 above);
  Apple Notes via exported files.
- Re-import de-duplication using `externalId` so importing the same vault twice updates rather than
  duplicates.

---

## 8. Reuse vs new (explicit)

| Concern | Reused as-is | New |
| --- | --- | --- |
| Progress tracking | `import_jobs` table, `GET /jobs/:id`, `useImportJob` poller | batch/item status fields for batch-level progress |
| Upload storage | `attachments` (bytes BYTEA), `insertAttachment`, `attachmentUrl`, `withTempFile`, `claimAttachmentsForNote` | staged attachments carry `note_id=NULL` until commit |
| Extraction (server) | `extractFromUpload` (unpdf, officeparser) | client-side pdf.js + FileReader path for md/txt/pdf |
| Markdown -> note | `markdownToTipTap`, `markdownToPlainText`, `stripLeadingTitleHeading`, `plainTextFromDoc` | none - this is the no-AI note builder |
| Note creation | `POST /api/notes` (the lecture flow's no-AI path), `setTags`, `syncLinksForNote` | commit orchestrator that loops over accepted items |
| Categories | `notebooks`, `note_tags`, `normalizeTag`, tag merge/rename | categoriser + `notebookProfiles` term index |
| AI plumbing | `aiQuotaGate`, `aiCtx`, `complete`, `chat`, `extractJson`, `capForAi`, `UNTRUSTED_NOTICE`, `aiHealth` | `categorisePrompt`, `Categoriser` interface + strategy selection |
| Client entry | `openImportModal` bus, `ImportModalHost` in App.tsx, CommandPalette | Import wizard component + Source grid |
| Client heavy-lift precedent | lecture in-browser extraction, bounded-concurrency per-request upload, fit-to-4MB | connector `ingest` adapters yielding `RawDoc` |
| Staging | - | `import_batches`, `import_items` tables + batch API |

The genuinely new surface is small: two tables, a batch/commit API, the categoriser abstraction with
its heuristic, the connector registry, and the wizard UI. Everything expensive (extraction, storage,
progress, note creation, AI plumbing, quota, prompt hardening) already exists.

---

## 9. Risks and open questions for Sampo

1. **Photo OCR in the MVP.** Recommendation: MVP imports photos as image notes sorted by
   filename/date, with NO OCR, so there is zero AI dependency and no multi-MB model download. OCR
   (gateway vision or tesseract.js) is a Phase-2 opt-in. Is "photos filed and visible but not yet
   text-searchable" acceptable for the first ship, or is searchable photo text a must-have on day
   one (which forces either an AI dependency or a heavy browser model)?

2. **Where the heuristic categoriser runs.** Client-side is free, private, needs no quota, and works
   even if the gateway is up but slow; server-side is more consistent and is the natural home for the
   LLM strategy. Recommendation: heuristic on the client, LLM on the server, staging always in
   Postgres so review survives a refresh. Agree, or keep all categorisation server-side for one code
   path?

3. **New-notebook aggressiveness.** Auto-proposing new notebooks from folders/clusters risks
   notebook sprawl (a pile of loose files becoming 15 half-empty notebooks). Recommendation: propose
   a new notebook ONLY from a clear folder signal or a cluster above a minimum size, default the rest
   to a single "Unsorted" bucket, and require explicit approval of each new notebook in review. How
   conservative should the default be?

Secondary decisions (lower stakes): batch-size and total-bytes caps for a single import (protect
Neon storage and the per-request 4MB limit - suggest ~100 items / a few hundred MB of photos per
batch); whether re-importing should de-duplicate via `externalId` in Phase 1 or wait for Phase 3;
and whether the "Tidy with AI" restructure should be offered per-item in review or left to the
existing single-note Improve action after import.
