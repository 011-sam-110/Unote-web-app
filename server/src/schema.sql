-- Unote database schema (PostgreSQL / Neon). Applied idempotently on boot (db.ts).
--
-- Ported from the original SQLite schema. Two deliberate carry-overs keep the
-- port honest rather than clever:
--   * Timestamps stay TEXT in ISO-8601 UTC. ISO-8601 sorts correctly as text, so
--     every existing ORDER BY / comparison keeps working untouched.
--   * Booleans stay INTEGER 0/1, so the ~40 `archived = 0` style predicates in the
--     route layer did not need rewriting during the migration.
-- FTS5's virtual table + sync triggers are replaced by a generated tsvector column,
-- which needs no triggers and cannot drift out of sync with its source rows.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  -- scrypt(password, salt) - salt is per-user and random; see server/src/auth/password.ts
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  -- One-time recovery key, hashed exactly like a password. The app sends no email,
  -- so this is the only route back into a locked-out account. Shown once at signup
  -- and never recoverable afterwards; redeeming it sets recovery_key_used.
  recovery_key_hash TEXT,
  recovery_key_salt TEXT,
  recovery_key_used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
-- Additive columns for databases created before recovery keys existed.
ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_key_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_key_salt TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_key_used INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_users_email ON users(lower(email));

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,               -- random 256-bit token, stored hashed
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Social (OAuth) identities linked to a local account. One user may have several - one
-- per provider they have signed in with. The account itself is still a `users` row; an
-- OAuth-only account simply has a password nobody holds (see routes/oauth.ts).
--
-- UNIQUE(provider, provider_user_id) is the anchor the callback resolves on first: a
-- returning identity maps straight to its user. Linking by verified email inserts a row
-- here pointing at the pre-existing user; a first-time user gets a fresh user + a row.
CREATE TABLE IF NOT EXISTS oauth_identities (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,              -- 'google' | 'github' (and future providers)
  provider_user_id TEXT NOT NULL,      -- the provider's stable subject id ('sub' / user id)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT,                          -- the address seen at link time, for reference
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  UNIQUE (provider, provider_user_id)
);
CREATE INDEX IF NOT EXISTS idx_oauth_identities_user ON oauth_identities(user_id);

CREATE TABLE IF NOT EXISTS notebooks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '📓',
  color TEXT NOT NULL DEFAULT '#6366f1',
  position INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_notebooks_user ON notebooks(user_id, position);

-- user_id is denormalised onto notes (rather than reached via notebook_id) so that
-- every read path can filter by owner with a single indexed predicate, and so a
-- forgotten join can never leak another user's rows.
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  content_json TEXT NOT NULL DEFAULT '{"type":"doc","content":[{"type":"paragraph"}]}',
  content_text TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'doc',  -- doc | canvas
  pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT, -- soft-delete: non-null = in trash (purged after 30 days on boot)
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  fts tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(content_text, '')), 'B')
  ) STORED
);
CREATE INDEX IF NOT EXISTS idx_notes_notebook ON notes(notebook_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_user_updated ON notes(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_fts ON notes USING GIN(fts);
-- Wikilink resolution matches on title; keep it case-insensitively indexed per user.
CREATE INDEX IF NOT EXISTS idx_notes_title ON notes(user_id, lower(title));

CREATE TABLE IF NOT EXISTS note_versions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  content_json TEXT NOT NULL,
  cause TEXT NOT NULL DEFAULT 'autosave', -- autosave | manual | ai | restore | import | conflict
  label TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_versions_note ON note_versions(note_id, created_at DESC);

CREATE TABLE IF NOT EXISTS note_tags (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (note_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON note_tags(tag);

-- Resolved wikilinks, extracted server-side from [[Title]] in content_text on save.
CREATE TABLE IF NOT EXISTS links (
  from_note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  to_note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  PRIMARY KEY (from_note_id, to_note_id)
);
CREATE INDEX IF NOT EXISTS idx_links_to ON links(to_note_id);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note_id TEXT REFERENCES notes(id) ON DELETE SET NULL,
  kind TEXT NOT NULL, -- photo | slides | transcript | image | file
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  -- Serverless has no durable local disk, so bytes live in the row. Large binaries
  -- are TOASTed out of the main heap by Postgres, so this does not bloat note reads.
  bytes BYTEA,
  extracted_text TEXT,
  status TEXT NOT NULL DEFAULT 'uploaded', -- uploaded | extracting | ready | failed
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_attachments_note ON attachments(note_id);
CREATE INDEX IF NOT EXISTS idx_attachments_user ON attachments(user_id);

-- Where this upload's material sits INSIDE the file: per-slide/per-page text with the true
-- page count, or per-timestamp segments for a transcript. JSON, written and read by
-- lib/provenance.ts, and the only thing that lets a gap citation say "slide 14 of 31".
--
-- It cannot be derived from extracted_text: that column holds the model-restructured notes,
-- and the restructure pass is told to drop slide numbers and footers, so the position is gone
-- before the row is written. This is filled from the RAW extraction instead, at import time.
--
-- TEXT holding JSON rather than JSONB, matching notes.content_json and canvas_items.data -
-- nothing queries inside it, so a second convention would buy nothing.
--
-- Nullable, and the null is meaningful: NULL is an upload from before this column existed and
-- carries no claim at all, while {"kind":"none",...} records that we looked and the source
-- genuinely has no sub-position. Both cite the file name; only the second is a fact about the
-- file. Deliberately not backfilled - there is no honest way to invent the position of a
-- deck whose numbers were already discarded.
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS provenance TEXT;

CREATE TABLE IF NOT EXISTS flashcards (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note_id TEXT REFERENCES notes(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  ease REAL NOT NULL DEFAULT 2.5,
  interval_days REAL NOT NULL DEFAULT 0,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  due_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  suspended INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_flashcards_due ON flashcards(user_id, due_at) WHERE suspended = 0;

CREATE TABLE IF NOT EXISTS review_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES flashcards(id) ON DELETE CASCADE,
  rating TEXT NOT NULL, -- again | hard | good | easy
  reviewed_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

-- Note templates: reusable skeletons, incl. built-in Lecture + Cornell.
-- Built-ins have a NULL user_id and are visible to everyone; user templates are owned.
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '📄',
  description TEXT NOT NULL DEFAULT '',
  content_json TEXT NOT NULL,
  builtin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_templates_user ON templates(user_id);

-- Margin comments: self-annotations anchored by a comment mark in the document.
CREATE TABLE IF NOT EXISTS note_comments (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  anchor_text TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_comments_note ON note_comments(note_id, created_at);

-- ---------------------------------------------------------------------------
-- Canvas: Freeform-style infinite boards.
-- A canvas is a note with kind='canvas'; its spatial children live here rather
-- than in content_json so that a single item drag does not rewrite the whole doc.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS canvas_items (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,              -- sticky | text | image | shape | link | ink | embed
  x DOUBLE PRECISION NOT NULL DEFAULT 0,
  y DOUBLE PRECISION NOT NULL DEFAULT 0,
  width DOUBLE PRECISION NOT NULL DEFAULT 220,
  height DOUBLE PRECISION NOT NULL DEFAULT 160,
  rotation DOUBLE PRECISION NOT NULL DEFAULT 0,
  z INTEGER NOT NULL DEFAULT 0,
  -- kind-specific payload: sticky/text body, image attachment id, shape variant,
  -- linked note id, or an ink stroke set ({strokes:[{points:[x,y,pressure],...}]}).
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_canvas_items_note ON canvas_items(note_id, z);

-- Connectors between canvas items (arrows/lines drawn between two nodes).
CREATE TABLE IF NOT EXISTS canvas_edges (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  from_item_id TEXT NOT NULL REFERENCES canvas_items(id) ON DELETE CASCADE,
  to_item_id TEXT NOT NULL REFERENCES canvas_items(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  style TEXT NOT NULL DEFAULT 'arrow', -- arrow | line | dashed
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_canvas_edges_note ON canvas_edges(note_id);

-- Pencil/stylus ink layered over a normal document note (canvas ink lives in
-- canvas_items instead). One row per stroke keeps incremental save cheap.
CREATE TABLE IF NOT EXISTS note_ink (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  -- {points:[[x,y,pressure],...], color, width, tool: pen|highlighter}
  stroke TEXT NOT NULL,
  -- Author of the stroke. NULL for an anonymous link guest; used to colour
  -- presence and to let a collaborator undo only their own ink.
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_note_ink_note ON note_ink(note_id);

-- Import jobs. Deliberately a table rather than a process-local map: the client
-- polls for progress, and on serverless each poll may land on a different
-- instance, so an in-memory store answers "job not found" for a job that is
-- running perfectly well somewhere else.
CREATE TABLE IF NOT EXISTS import_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued', -- queued | running | done | failed
  step TEXT,
  note_id TEXT,
  attachment_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_import_jobs_user ON import_jobs(user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Sharing: a note or canvas published behind an unguessable link, optionally
-- password-gated. Guests may join without an account.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS note_shares (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  -- The URL token is stored hashed, so a database leak does not hand out
  -- working share links. Same reasoning as the sessions table.
  token_hash TEXT NOT NULL UNIQUE,
  -- Optional gate. Hashed with scrypt + per-share salt, exactly like a password.
  password_hash TEXT,
  password_salt TEXT,
  permission TEXT NOT NULL DEFAULT 'edit', -- view | edit
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_shares_note ON note_shares(note_id);

-- A guest's proof that they cleared the password gate, and their identity for
-- presence. Separate from `sessions` so a guest grant can never be mistaken for
-- an account login.
CREATE TABLE IF NOT EXISTS share_guests (
  id TEXT PRIMARY KEY,              -- hashed guest token, as with sessions
  share_id TEXT NOT NULL REFERENCES note_shares(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL DEFAULT 'Guest',
  color TEXT NOT NULL DEFAULT '#6366f1',
  last_seen_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_share_guests_share ON share_guests(share_id, last_seen_at DESC);

-- Monotonic change feed per note, so collaborators can poll for "everything
-- since revision N" instead of refetching the whole document. Serverless
-- functions cannot hold WebSockets, so sync is delta-polling over this table.
CREATE TABLE IF NOT EXISTS note_events (
  seq BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,               -- doc | ink | item | edge | presence
  payload TEXT NOT NULL DEFAULT '{}',
  actor TEXT NOT NULL DEFAULT '',   -- user id or guest id, for echo suppression
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_note_events_note ON note_events(note_id, seq);

-- ---------------------------------------------------------------------------
-- AI: shared-pool accounting and user-supplied provider keys.
-- ---------------------------------------------------------------------------

-- Monthly spend against the shared free-tier pool, counted along two dimensions:
-- 'user' (subject = user id) and 'ip' (subject = a keyed hash of the address, never
-- the address itself). A request must clear both, since an account cap alone falls
-- to registering again and an IP cap alone falls to a hotspot.
--
-- Durable rather than in-memory because the budget is monthly: serverless instances
-- are short-lived, so an in-process counter would reset constantly and the real
-- ceiling would become (limit x number of warm instances).
CREATE TABLE IF NOT EXISTS ai_usage (
  scope TEXT NOT NULL,              -- user | ip
  subject TEXT NOT NULL,            -- user id, or HMAC(ip)
  period TEXT NOT NULL,             -- UTC calendar month, 'YYYY-MM'
  calls INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  PRIMARY KEY (scope, subject, period)
);
-- Supports the monthly sweep that drops periods nobody will read again.
CREATE INDEX IF NOT EXISTS idx_ai_usage_period ON ai_usage(period);

-- A user's own provider key, which takes them off the shared pool entirely: their
-- calls are billed to their key and skip the quota check.
--
-- The key is encrypted at rest with AES-256-GCM rather than hashed, because unlike a
-- password it has to be recoverable to be used. `hint` is the last four characters,
-- stored separately so the settings UI can show which key is saved without the
-- server ever having to decrypt one just to render a page.
CREATE TABLE IF NOT EXISTS ai_keys (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- Optional: lets a user point at their own OpenAI-compatible endpoint, not just
  -- swap the credential for the default one.
  base_url TEXT,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  hint TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

-- Comma-separated model names to try, in order, for this user's key. Only meaningful
-- alongside base_url: a key at a different provider is called with that provider's model
-- names, and the operator's chain (gemini-*/llama-*) is a 404 there every time. NULL keeps
-- the operator's chain, which is right for a key belonging to the same gateway.
ALTER TABLE ai_keys ADD COLUMN IF NOT EXISTS models TEXT;

-- ---------------------------------------------------------------------------
-- Import old notes: bulk staging.
--
-- The single-file /api/import path (above) creates one note per upload and always
-- calls the AI gateway. The bulk "Import old notes" wizard is different: it stages a
-- whole pile of documents/photos, auto-sorts them into notebooks + tags with a
-- zero-AI heuristic, and lets the student review and correct the sort BEFORE anything
-- is written into a real notebook. Staging is the whole point - content lives here,
-- not in `notes`, until the user commits, so discarding a batch touches no notebook.
--
-- `attachments` and `import_jobs` are reused as-is. These two tables are the only new
-- storage. A staged photo/office file is an `attachments` row (bytes in-row, note_id
-- NULL) referenced by attachment_id; client-extracted text (md/txt/pdf) needs no
-- attachment at all, only its text staged below.
-- ---------------------------------------------------------------------------

-- One "Import old notes" session.
CREATE TABLE IF NOT EXISTS import_batches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL,                 -- connector id: files | photos | markdown | ...
  status TEXT NOT NULL DEFAULT 'open',  -- open | categorised | committing | committed | discarded
  categoriser TEXT,                     -- which strategy produced the suggestions: heuristic | llm | browser-embed
  item_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_import_batches_user ON import_batches(user_id, created_at DESC);

-- One staged document/photo awaiting review. Content lives here, NOT in notes, until commit.
CREATE TABLE IF NOT EXISTS import_items (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,       -- denormalised, like notes
  attachment_id TEXT REFERENCES attachments(id) ON DELETE SET NULL,   -- photos + office files
  source_path TEXT,                      -- 'databases/indexing.md' -> the strongest sort signal
  original_name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'doc',      -- doc | photo
  title TEXT NOT NULL DEFAULT '',         -- derived, user-editable

  -- Raw extracted markdown/text. The note body is built from this at COMMIT time (via
  -- markdownToTipTap with a fresh wikilink resolver), rather than storing a frozen
  -- content_json at stage time - so wikilinks resolve against the user's notes as they
  -- exist at commit, and a re-run cannot leave a stale document behind.
  source_text TEXT NOT NULL DEFAULT '',
  content_text TEXT NOT NULL DEFAULT '',  -- plain-text mirror; feeds the categoriser + review preview
  word_count INTEGER NOT NULL DEFAULT 0,
  source_tags TEXT NOT NULL DEFAULT '[]', -- tags found in the source (frontmatter, #hashtags)

  -- Suggestion (what the categoriser proposed)
  suggested_notebook_id TEXT,             -- an existing notebook, or NULL when proposing a new one
  suggested_notebook_name TEXT,           -- for a proposed NEW notebook not yet created
  suggested_tags TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0,
  rationale TEXT,                         -- 'matched folder "databases"' - shown on hover, aids trust

  -- Decision (what the user chose; defaults mirror the suggestion)
  decided_notebook_id TEXT,
  decided_notebook_name TEXT,
  decided_tags TEXT,
  decided_mode TEXT NOT NULL DEFAULT 'new', -- new | append (merge into an existing note)
  decided_target_note_id TEXT,            -- for append

  -- Grouping: which items become PAGES OF THE SAME NOTE.
  --
  -- NULL is the original behaviour and stays the default: one item, one note. A shared group_key
  -- means "these are pages of one thing" - twelve photos of one handout - and commit files them
  -- into a single note in group_index order rather than twelve fragments. Photo imports set this
  -- from capture timestamps (or from one AI call over the OCR text); document imports leave it
  -- null and are completely unaffected.
  group_key TEXT,
  group_index INTEGER NOT NULL DEFAULT 0,
  -- When the photo was taken (EXIF DateTimeOriginal, else the file timestamp), ISO. Persisted
  -- rather than kept in the browser so re-grouping and the review screen survive a refresh.
  captured_at TEXT,

  status TEXT NOT NULL DEFAULT 'pending', -- pending | ready | categorised | accepted | rejected | committed | failed
  note_id TEXT,                           -- set once committed
  error TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_import_items_batch ON import_items(batch_id, created_at);

-- ---------------------------------------------------------------------------
-- Phone capture pairing
--
-- Scanning the QR on the desktop opens /capture on a phone that has NEVER signed
-- in, so it carries no session cookie. The QR therefore has to hand the phone a
-- credential, and the one it hands over must not be the account.
--
-- A pairing row is a one-shot bearer token: minted by an authenticated desktop
-- session, embedded in the QR, and exchanged exactly once for a CAPTURE-SCOPED
-- session (see sessions.scope below). Stored hashed, like note_shares.token_hash,
-- so a database leak yields no usable codes.
--
-- consumed_at rather than DELETE: the row is the record that a code was already
-- spent, which is what makes a second scan of a photographed QR fail closed.
CREATE TABLE IF NOT EXISTS capture_pairings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,                  -- set on redemption; a second attempt finds it non-null
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_capture_pairings_user ON capture_pairings(user_id);
CREATE INDEX IF NOT EXISTS idx_capture_pairings_expiry ON capture_pairings(expires_at);

-- What a session is allowed to do. 'full' is a normal sign-in and is the default,
-- so every existing row keeps exactly the authority it had. 'capture' is the paired
-- phone: same user_id, but auth/middleware.ts admits it to a small allowlist of
-- routes (list notebooks, start an import, poll that import) and refuses everything
-- else - so a scanned code cannot read notes, change the password, or spend AI quota
-- beyond the import it was scanned for.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'full';

-- Photo grouping, for databases created before it existed. NULL group_key on every existing row
-- means they keep the one-item-one-note behaviour they were staged under.
ALTER TABLE import_items ADD COLUMN IF NOT EXISTS group_key TEXT;
ALTER TABLE import_items ADD COLUMN IF NOT EXISTS group_index INTEGER NOT NULL DEFAULT 0;
ALTER TABLE import_items ADD COLUMN IF NOT EXISTS captured_at TEXT;

-- Deliberately AFTER those ALTERs, not next to the CREATE TABLE above.
--
-- On an existing database the CREATE TABLE is a no-op, so an index declared beside it would
-- reference a column that only the ALTER adds - which is precisely how this failed the first
-- time: "column group_key does not exist", on boot, for every deployment that already had data.
-- Commit walks a group at a time and looks up already-committed siblings to stay resumable.
CREATE INDEX IF NOT EXISTS idx_import_items_group ON import_items(batch_id, group_key, group_index);

-- ---------------------------------------------------------------------------
-- Additive columns for delta sync (offline desktop app).
--
-- Two separate needs, both unmeetable before this block:
--   * updated_at answers "what changed since <cursor>". Only notes and
--     canvas_items had one, so the other four tables could not be synced at all.
--   * deleted_at is a tombstone. A hard DELETE cannot be replicated to a client
--     that was offline when it happened - that client's outbox re-uploads the row
--     and RESURRECTS it, silently. Every mirrored table needs one.
--
-- Deliberately at the END of this file rather than beside the users ALTERs, for the
-- same reason recorded above idx_import_items_group: on an existing database the
-- CREATE TABLEs below are no-ops, but on a FRESH one the statements in this script
-- run in order, so an ALTER placed near the top would name a table that does not
-- exist yet and fail the whole migration on first boot.
--
-- The backfill order is load-bearing: add nullable, fill from created_at, THEN set a
-- default, THEN set NOT NULL. Adding the column with a default instead would stamp
-- every pre-existing row with now() and lose the created_at ordering, so a client's
-- first sync would see the entire account arrive at one instant.
-- ---------------------------------------------------------------------------

ALTER TABLE notebooks    ADD COLUMN IF NOT EXISTS updated_at TEXT;
ALTER TABLE canvas_edges ADD COLUMN IF NOT EXISTS updated_at TEXT;
ALTER TABLE note_ink     ADD COLUMN IF NOT EXISTS updated_at TEXT;
ALTER TABLE flashcards   ADD COLUMN IF NOT EXISTS updated_at TEXT;

UPDATE notebooks    SET updated_at = created_at WHERE updated_at IS NULL;
UPDATE canvas_edges SET updated_at = created_at WHERE updated_at IS NULL;
UPDATE note_ink     SET updated_at = created_at WHERE updated_at IS NULL;
UPDATE flashcards   SET updated_at = created_at WHERE updated_at IS NULL;

-- The default is not tidiness. Every INSERT into these four tables predates the
-- column and names it nowhere - notebooks in routes/notebooks.ts and lib/importBatch.ts,
-- flashcards in routes/study.ts and routes/ai.ts, canvas_edges and note_ink in
-- routes/canvas.ts and routes/share.ts - so without a default the NOT NULL below turns
-- "create a notebook" into a 500 for every caller. Same expression the columns declared
-- inline above use, so a row's updated_at is the same shape wherever it came from.
ALTER TABLE notebooks    ALTER COLUMN updated_at SET DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
ALTER TABLE canvas_edges ALTER COLUMN updated_at SET DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
ALTER TABLE note_ink     ALTER COLUMN updated_at SET DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
ALTER TABLE flashcards   ALTER COLUMN updated_at SET DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

ALTER TABLE notebooks    ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE canvas_edges ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE note_ink     ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE flashcards   ALTER COLUMN updated_at SET NOT NULL;

-- Tombstones. Nullable and NULL-by-default throughout: a null deleted_at is a live
-- row, which is exactly what every existing row is and what every existing query
-- already assumes (`deleted_at IS NULL` on notes).
ALTER TABLE notebooks    ADD COLUMN IF NOT EXISTS deleted_at TEXT;
ALTER TABLE canvas_items ADD COLUMN IF NOT EXISTS deleted_at TEXT;
ALTER TABLE canvas_edges ADD COLUMN IF NOT EXISTS deleted_at TEXT;
ALTER TABLE note_ink     ADD COLUMN IF NOT EXISTS deleted_at TEXT;
ALTER TABLE flashcards   ADD COLUMN IF NOT EXISTS deleted_at TEXT;

-- Delta-sync covering indexes. The cursor is composite (updated_at, id), so the
-- index must be too or every sync page becomes a sort.
--
-- canvas_items, canvas_edges and note_ink carry no user_id: they are scoped by
-- note_id and the sync query joins through notes. Their index therefore leads on
-- note_id, and notes' own idx_notes_user_updated covers the join side.
CREATE INDEX IF NOT EXISTS idx_notebooks_sync    ON notebooks(user_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_notes_sync        ON notes(user_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_flashcards_sync   ON flashcards(user_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_canvas_items_sync ON canvas_items(note_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_canvas_edges_sync ON canvas_edges(note_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_note_ink_sync     ON note_ink(note_id, updated_at, id);

-- ===========================================================================
-- REFERENCING (feature: references) - appended block, see
-- docs/superpowers/specs/2026-08-12-referencing-design.md
-- Append-only convention agreed with the parallel spellcheck work so two
-- features can add tables without tangling with each other's edits.
-- ===========================================================================

-- A source is stored as CSL-JSON, the format citeproc-js consumes directly, so no
-- internal citation format is invented and a DOI lookup can be stored verbatim.
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- One of sourceTypes.ts ids ('website', 'journal', ...). The CSL type lives inside
  -- csl_json; this is what the intake form was filled in as.
  kind TEXT NOT NULL,
  csl_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS sources_user_idx ON sources(user_id, updated_at DESC);

-- A citation is a note pointing at a library source. The note NEVER stores formatted
-- text: switching Harvard to APA has to re-render every citation without editing the
-- student's prose, which is only possible if the rendered form is derived, not stored.
CREATE TABLE IF NOT EXISTS citations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  -- "p. 14", "ch. 2" - the page or chapter inside the source.
  locator TEXT NOT NULL DEFAULT '',
  prefix TEXT NOT NULL DEFAULT '',
  suffix TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS citations_note_idx ON citations(note_id);
CREATE INDEX IF NOT EXISTS citations_source_idx ON citations(source_id);

-- One verdict per source, replaced on each check. checked_at is load-bearing rather than
-- audit noise: a stored verdict must state its own age, so an offline student sees
-- "checked 9 Aug" instead of a claim implying it was confirmed just now.
CREATE TABLE IF NOT EXISTS source_verdicts (
  source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('verified', 'unconfirmed', 'refuted', 'unreachable')),
  registry TEXT,
  evidence TEXT NOT NULL DEFAULT '',
  checked_at TEXT NOT NULL
);

-- Page layout: what shape of paper a note is, and what its header and footer say.
--
-- TEXT holding JSON rather than JSONB, matching notes.content_json and canvas_items.data.
-- Nullable and NULL by default, which is the whole reason this needed no backfill: the
-- parser in lib/pageLayout.ts reads NULL as "default A4 document", so every note written
-- before pagination existed becomes one the first time it is opened.
ALTER TABLE notes ADD COLUMN IF NOT EXISTS layout_json TEXT;
