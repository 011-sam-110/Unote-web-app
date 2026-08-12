# Referencing - handoff

Written 2026-08-12. Everything needed to pick this up cold.

## Where it stands

**Part 1 (server) is complete and pushed.** Branch `feat/referencing`, 24 commits, head `180932e`,
`main` untouched. The PR is not open yet: `gh` 401s because the GitHub token expired on
2026-08-07. `git push` uses different credentials and works fine. Run `gh auth login -h github.com`,
then create the PR - the body is written and waiting.

**Part 2 (web) is not started.** No UI exists. Nothing a student can see.

Full server suite at time of writing: 44 files, 667 tests passing, 99 of them new.

- Spec: `docs/superpowers/specs/2026-08-12-referencing-design.md`
- Plan: `docs/superpowers/plans/2026-08-12-referencing-1-library.md` (carries as-built
  corrections where the shipped code diverged from what the plan prescribed)
- Execution ledger, including every review finding: `.superpowers/sdd/progress.md` (gitignored)

## What Part 1 gives Part 2

All under `/api/references`, authenticated, every statement filtered on the calling user.

| Endpoint | Does |
|---|---|
| `GET /types` | The 27 source types with their field lists. Fetch this - do not bundle a copy |
| `POST /resolve` | `{query}` - sniffs DOI/ISBN/URL/free text, returns `{kind, found, csl, missing, reason, candidates}` |
| `GET /sources` | The account's library, each with its verdict |
| `POST /sources` | `{kind, csl}` |
| `PATCH /sources/:id` | `{csl}` - **also deletes the stored verdict**, because what was checked is no longer what is stored |
| `DELETE /sources/:id` | |
| `POST /sources/:id/verify` | Returns `{verdict}` and stores it |

Sources are stored as **CSL-JSON**, which is exactly what citeproc-js consumes. There is no
intermediate citation format to convert through.

## The decisions that are not obvious

**Verification is deterministic, never a language model.** `server/src/lib/checks.ts` runs one
model request per check family. Putting "is this citation fake?" there would ask the fabrication
engine to audit its own output and render the answer in a rail students already trust. It follows
`server/src/lib/provenance.ts` instead.

**Four states, not two.** `verified` / `unconfirmed` / `refuted` / `unreachable`.
- `unconfirmed` is the **most common** state and is **not an error** - most student sources carry
  no DOI or ISBN. If the UI renders it as a problem, the feature is worse than useless.
- `unreachable` must **never** degrade into `refuted`. `refuted` accuses; `unreachable` claims
  nothing. Conflating them tells a student their real source is fabricated because a server had
  a bad day. Two separate bugs of exactly this shape were found and fixed during Part 1.

**State is carried by glyph first, hue second.** `verified` and `refuted` differ on the red-green
axis - the most common colour vision deficiency - on the two states that matter most. Glyphs:
tick / question mark / exclamation / dash. All four survive greyscale, which matters twice over
because a bibliography is the part of a document most likely to be printed, and paged output
(Part B) is the next feature.

**A note stores a reference to a source, never formatted text.** Switching Harvard to APA must
re-render every citation without editing the student's prose, which is only possible if the
rendered form is derived.

**Style lives on the note**, not on the user. A note must render in the same style when opened on
another device. A user-level default is only a seed for new notes, and Unote has no user-settings
surface at all (verified: no settings table, column or route; `docs/BACKLOG.md:67` shows it was
specced and never built). Until one exists the seed is the constant Harvard (Cite Them Right).

## Gotchas that cost real time

- **`registryFetch` vs `safeFetch` are not interchangeable.** `registryFetch` is for URLs *we*
  construct and applies a timeout plus the Crossref polite-pool User-Agent. `safeFetch` guards
  *user-supplied* URLs against SSRF. Using the wrong one is a security bug - and it already
  happened once, where a URL built by concatenating a field from a user-editable wiki bypassed
  the guard entirely.
- **A green suite is not evidence.** Four separate times on this feature, a suite reported green
  over a branch nothing exercised. Once, `npm run e2e` exited 0 having run **zero** tests because
  a database connection failed. **Judge on the reported test count and named suites, never the
  exit code.**
- **`npm run test -w server` drops the dev database.** Ping the other agent first.
- **`vercel env pull` writes `.env.local` with the PRODUCTION connection string.** Three agents
  have previously found it and written to production. Keep it out of the repo root.
- **`web/index.html` holds an inline script pinned by sha256** in both `vercel.json` and
  `server/src/lib/csp.ts`. Editing even a comment inside it breaks production CSP.
- **Tabs: several editors are mounted at once.** Anything in `buildExtensions.ts` is instantiated
  per editor, so the account-wide source library must live in app-level state, not extension
  state. Use `useTabParams` / `useTabSearchParams` / `useIsActiveTab` from
  `web/src/features/tabs/tabLocation.tsx` - `useParams` answers for the *visible* tab.
- **The service worker precache excludes `**/*.wasm`** and caps per file at 8MB
  (`web/vite.config.ts`).

## Coordination with the parallel spell-check work

A second agent works in this repo from its own worktree (`../folio-spellcheck`), reachable on the
bus: `python ~/.claude/bus/bus.py --channel proj send --from b --to spellcheck "..."`.

**We share one checkout on `main`'s working tree.** That is how a commit once landed on the wrong
branch. Announce a base by *reading it back*, never by stating what you intended.

Shared files - ping before touching, append at the end in a fenced block naming the feature:
`buildExtensions.ts`, `insertables.ts`, `SlashItems.ts`, `editor.css`, `schema.sql`, `tokens.css`.

**The marking convention, already agreed and half-built.** Red wavy underline is reserved by the
platform for spelling. Separation is by **form**, not colour:

| Layer | Form | Class | z |
|---|---|---|---|
| Spelling | red wavy underline, 1px | `folio-spell-error` | bottom |
| Grammar | blue dotted underline, 2px | `folio-grammar-error` | bottom |
| **Citation** | **badge on the node** | yours | **top** |

Right-click precedence: innermost anchor under the pointer wins. The spell checker already skips
`citation` and `bibliography` nodes structurally, so no author surname or journal title is ever
marked.

## Part 2 scope

1. CSL engine - citeproc-js, with **styles *and* locales compiled to `.ts`**. `CSL.Engine` needs
   `sys.retrieveLocale()` returning locale XML, shipped separately from styles. Leaving locales as
   runtime data would break offline formatting *and* silently produce US date forms for a UK
   student. (Verified against the citeproc docs, not assumed.)
2. `citation` (inline atom) and `bibliography` (block atom) TipTap nodes, **both rendering from
   attrs with no text content**.
3. Source library UI, and the intake flow - one box, then "what we found / what we still need"
   shown separately, with manual entry first-class.
4. Verdict badges, glyph-first, tokenised in both themes.
5. The two AI tools: cite-from-library, and find-real-sources. The model may only select from
   records a registry returned - it must never write citation metadata itself.
6. Offline: cached CSL drives insertion and formatting; only new lookups need a connection.

## Open items from the final review, none blocking

- Type the resolver contract (`kind: 'not-found' | 'unreachable'`) rather than matching a regex
  over prose that is *also* shown to the user, and default an unrecognised failure to
  `unreachable` rather than `refuted`. **Do this before Part 2 hardens the API contract.**
- Cumulative fetch budget across a redirect chain (6 hops x 8s can exceed a serverless limit).
- Content-type check in `resolveWebpage` so a cited PDF cannot verify on an empty title.
- `missingFrom` uses a fixed field list, so a journal article always reports `publisher` missing.
  It should be driven by `sourceTypes.ts`'s per-type fields.
- ISBN partial multi-author failure ships a truncated author list with no signal.
- No rate limiting on `/resolve` or `/verify`, which are authenticated outbound-fetch primitives.
- `search.ts` cannot distinguish a Crossref outage from zero results.
- **Every webpage test uses hand-written HTML fixtures.** They contain exactly the metadata shapes
  their author imagined, which is how the `og:title` = "Section | Site" case reached production
  logic. Part 2 should test against real saved pages.
