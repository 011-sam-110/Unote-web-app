# Stage 3 — offline search

**Spec:** `docs/superpowers/specs/2026-08-09-offline-desktop-design.md` §10.
**Branch:** `feat/desktop-distribution`.
**Depends on:** Stage 1, which is built, tested and on this branch.

## The goal, precisely

Search must return results with no network, over the local Dexie mirror, **without losing
any query capability**. The server parser in `server/src/routes/search.ts` supports exactly
six things, and all six are implementable locally:

| Operator | Local implementation |
| --- | --- |
| bare terms | MiniSearch |
| `"phrases"` | adjacency check over `contentText` — MiniSearch does NOT do this natively |
| `-excluded` | post-filter |
| `tag:` | filter over the mirror |
| `-tag:` | filter over the mirror |
| `notebook:` | filter over the mirror |

`SearchParsed` lives in `web/src/lib/types.ts:150`. Reuse it — do not write a second
parser with its own bugs.

## What differs, and must be admitted in the UI

Ranking. The server ranks with `ts_rank` over a generated `tsvector` that weights title
above body (`setweight(..., 'A')`/`'B'`, `schema.sql:87-90`). MiniSearch will order the
same query differently. **The UI must say "offline search" when the local index answered**,
so a changed result order is explained rather than mysterious. Do not attempt to replicate
`ts_rank`; do bias the title field, so the difference is small.

## Tasks

- [ ] **1. Dependency.** `npm install minisearch -w web`. You own `web/package.json`.
- [ ] **2. Index module.** `web/src/lib/local/search/index.ts`:
      build from the mirror, serialise into the `meta` table, rehydrate on boot, and
      rebuild when `INDEX_VERSION` changes. Keep `INDEX_VERSION` a single exported
      constant and bump it whenever the indexed fields change — a stale index that
      silently returns wrong results is worse than a slow rebuild.
- [ ] **3. Incremental updates.** Every local write updates the index. A full rebuild per
      keystroke is not acceptable; a stale index is not acceptable either.
- [ ] **4. Query execution.** `web/src/lib/local/search/query.ts` — take a `SearchParsed`
      and return ranked results, implementing all six operators including phrase
      adjacency. Phrases are the one thing MiniSearch cannot do: match candidates first,
      then verify adjacency over the stored `contentText`.
- [ ] **5. Parity tests.** The important ones. For a fixed corpus, assert the local engine
      returns **the same SET of note ids** as the documented server semantics for each of
      the six operators and for combinations. Assert set equality, not order — order is
      explicitly allowed to differ, and asserting order would encode the difference as a
      requirement.
- [ ] **6. Empty and edge cases.** Empty query, operator-only query (`tag:x` alone),
      a phrase that spans a block boundary, a term that appears only in the title, and a
      note that is tombstoned locally (must NOT appear).
- [ ] **7. UI.** `web/src/pages/SearchPage.tsx` labels results as offline search when the
      local index answered. Match the existing page's voice.

## Ownership — do not stray

You own: `web/src/lib/local/search/**`, `web/package.json`, `web/src/pages/SearchPage.tsx`
and `.css`, and your own tests.

You do **NOT** own `web/src/lib/local/localApi.ts`, `db.ts`, `records.ts` or
`web/src/lib/sync/**` — another agent is rewriting those for Stage 2 in parallel and you
would collide. Export a clean function and report the exact wiring line you need in
`localApi.ts`; the integrator applies it.

Reading the `meta` table is fine via the existing `readMeta`/`writeMeta` helpers in
`db.ts`. Do not add a store to `db.ts` — if you think you need one, say so instead.

## Constraints

- Never edit the inline `<script>` in `web/index.html` — its sha256 is pinned.
- Never `git add -A`.
- Comments explain WHY, plain prose, hyphens not em dashes, British spelling.
