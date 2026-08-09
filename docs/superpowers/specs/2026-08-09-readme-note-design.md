# README note — design

**Date:** 2026-08-09
**Status:** approved, not started
**Visual review:** https://claude.ai/code/artifact/7dccef14-afb3-4ae8-8047-bdd801f678ae

Every guest and every new account opens on a pinned note called **README**: short
documentation for the whole app, generated from Unote's own registries, and built out
of the blocks it describes rather than merely listing them.

Two properties carry the design. It is **generated**, so adding a block to
`insertables.ts` documents that block without anyone remembering to. And it is
**dogfooded**, so the section on columns *is* a column layout, the section on maths
contains real KaTeX, and the reference tables live inside real toggles.

---

## 1. What exists today

| Surface | Today | Gap |
| --- | --- | --- |
| Guest (`/try`) | `seedGuestWorkspace()` (`guestStore.ts:292`) creates a "My notes" notebook and **one empty note** | Lands on a blank page with no idea what the app does |
| New account | `seedNewUser()` (`server/src/seed.ts:823`) creates a "My notes" notebook; the tour auto-opens and offers the `Algorithms (example)` notebook | The tour teaches five things and vanishes; nothing persists as reference |
| Existing accounts | Nothing | No reference at all beyond `?` for keybindings |

Three registries already hold the facts, in three different shapes:

| Registry | File | Holds |
| --- | --- | --- |
| `INSERT_ITEMS` | `web/src/features/editor/insertables.ts` | 23 blocks: id, title, description, section, keywords |
| Command registry | `web/src/lib/commands.ts` + `components/CommandPalette.tsx` | 8 global commands; ~11 more declared inline in the palette because they need component state |
| Shortcut groups | `web/src/features/onboarding/ShortcutsSheet.tsx` | 25 bindings in a private `groups()` function |

A fourth is the useful surprise: **`BLOCKED` in `guestApi.ts:50`** is already a
complete map of what a guest cannot do, each entry carrying a plain-English refusal
sentence. It is the source of truth for every "needs an account" mark, so no second
availability list is written or maintained.

---

## 2. Decisions settled

| Question | Answer |
| --- | --- |
| Form | A real note, titled README, pinned, in "My notes" |
| Authoring | Fully generated from registries; nothing hand-laid-out |
| Coverage | The whole app — nine sections, editor through sharing |
| Intermediate form | TipTap doc JSON, **not** Markdown |
| Guest vs account | One `guest` flag; gates derived from `BLOCKED` |
| Where it is created | Client-side, one builder, two write paths |
| Existing accounts | A new "Open the guide" palette command |

**Why TipTap JSON and not Markdown.** The first draft of this design emitted
Markdown and converted it with the existing `markdownToTipTap`. Dogfooding kills that:
callouts, columns, toggles, `chem` and math nodes have no Markdown spelling, so a
Markdown source form can only ever produce the plainest quarter of the document.
The builder emits nodes directly. Markdown remains the *export* format, which the app
already supports — so "readme.md" survives as what you get when you export it.

**Why client-side.** The registries are web-only — `insertables.ts` imports TipTap's
`Editor`, `pickAndInsertImage` and `toast`, none of which Node can load. Generating
server-side would mean duplicating all 23 descriptions into `server/`, which is the
staleness this design exists to prevent. One builder in `web/`, called from both the
guest seed and the post-signup path, keeps a single definition per fact.

---

## 3. The builder

`web/src/features/readme/buildReadme.ts` — pure, synchronous, no network.

```ts
export interface ReadmeOptions {
  /** Marks features whose API method is BLOCKED, and omits demos that need an upload. */
  guest: boolean;
}

export interface ReadmeDoc {
  title: string;              // 'README'
  tags: string[];             // ['unote', 'guide']
  contentJson: TipTapDoc;     // the document
  contentText: string;        // flattened, for search indexing and backlinks
}

export function buildReadme(opts: ReadmeOptions): ReadmeDoc;
```

Inputs, and what each one supplies:

| Section of the note | Generated from |
| --- | --- |
| 02 · Everything you can insert | `INSERT_ITEMS` + `INSERT_SECTIONS` |
| 04 · Find — commands | command registry + `paletteCatalog.ts` |
| 04 · Find — keys | `shortcutData.ts` |
| Every "needs an account" mark | `BLOCKED` via `guestBlockedMessage()` |
| 05–09 · feature sections | `featureCatalog.ts` |

### 3.1 Blocks carry their own demo

`InsertItem` gains one optional field:

```ts
export interface InsertItem {
  // ...existing fields unchanged...
  /** Live demonstration for the README. Omit when the block needs an uploaded
   *  asset — the README then renders the description row and says why. */
  example?: () => TipTapNode[];
}
```

This is the one change to `insertables.ts`, and it is additive: the file header's
"append ONE InsertItem" contract still holds, the entry just now documents *and*
demonstrates itself.

**Five blocks omit `example`, deliberately:**

| Block | Why no live demo |
| --- | --- |
| `/image` | Needs an uploaded file; no asset exists at seed time |
| `/3d model` | Same — needs a GLB/STL on the server |
| `/insert from canvas` | Needs an existing board to snapshot |
| `/sketch` | Needs stroke data; a seeded scribble is meaningless |
| `/table of contents` | Not a node at all — it steers to the outline panel |

Their rows render with the reason. Nothing fake is drawn.

### 3.2 Document outline

| # | Section | Blocks it is built from |
| --- | --- | --- |
| — | Title, tags, lede | `heading`, `paragraph` |
| — | Opening tip | `callout` (tone `info`) |
| 01 | Write | `columnList` ×2, `taskList`, `paragraph` with `code` marks |
| 02 | Everything you can insert | `details` ×2 wrapping `table`, `blockquote`, `inlineMath`, `blockMath`, `chem`, `codeBlock` |
| 03 | Connect | `columnList` ×3, a real `wikilink`, a `#hashtag` in text |
| 04 | Find | `columnList` ×2 — keybindings beside search operators — plus a `details` wrapping the generated palette-command `table` |
| 05–09 | Study, Boards, Import, AI, Share & export | `bulletList` from `featureCatalog` |
| — | Guest gate / closing | `callout` (tone `warn` for guests, `ok` otherwise) |

Node shapes confirmed against the code, not assumed:

- `callout` — `{ emoji, tone }`, tones `info | warn | ok` (`Callout.ts:28`)
- `columnList` > `column` > content (`Columns.ts:168`)
- `details` + `detailsSummary` + `detailsContent` (`buildExtensions.ts:94`)
- `chem` — `{ smiles, name, molfile }`; renders from `smiles` alone via
  smiles-drawer, entirely client-side, so it works for guests
  (`chemInsertable.ts:39`, `ChemView.tsx:54`)
- `inlineMath` / `blockMath` — `{ latex }`, KaTeX, also client-side

The caffeine SMILES `CN1C=NC2=C1C(=O)N(C(=O)N2C)C` is the chemistry example: a
student-recognisable molecule that needs no server and no asset.

---

## 4. Guest vs account

One flag, and the difference is derived rather than declared. A feature is marked
"needs an account" **iff** the API method it names appears in `BLOCKED`.

The guest build must also say three quieter things out loud, because the app behaves
differently and currently does so silently:

1. **Backlinks are always empty** — `guestApi.ts:204` returns `backlinks: []`. §03
   promises backlinks; for a guest it must say they arrive with an account.
2. **Search is substring, not operators** — `guestApi.ts:247` does
   `.includes()`. §04 lists `tag:`, `notebook:`, `"phrase"` and `-exclude`, none of
   which a guest gets.
3. **Everything is browser-local**, with the ~4 MB ceiling `guestStore.ts` already
   warns about.

---

## 5. Where it is created

`web/src/features/readme/ensureReadme.ts` owns the create-once decision for all three
entry points.

| Entry point | Trigger | Guard |
| --- | --- | --- |
| Guest | `seedGuestWorkspace()` writes README first (pinned), then the blank note | Only fires on an empty store, as today |
| New account | `ensureReadme()` from `OnboardingHost`, before the tour opens | Onboarding record is `unseen` **and** no existing note titled README |
| Anyone | "Open the guide" palette command (Help section) | Opens the existing README, or writes one if missing |

**Never during a guest handover.** `OnboardingHost` already suppresses the tour while
`handoverPending` is true. `ensureReadme()` obeys the same condition: a guest who
signs up brings their own migrated README with them, and creating a second one while
their work is mid-flight is exactly the ambush that check exists to prevent.

**`/try` opens the README on the first visit only.** `startGuest()` returns the README
id when it has just seeded; on every later visit `latestNoteId()` wins, so a returning
guest lands back on their own work rather than on documentation they have read.

---

## 6. Change surface

| File | Change | Why |
| --- | --- | --- |
| `features/readme/buildReadme.ts` | new | The builder |
| `features/readme/featureCatalog.ts` | new | Sections 05–09 as typed data, each naming its gating API method |
| `features/readme/ensureReadme.ts` | new | The guarded create-once |
| `features/editor/docBuilders.ts` | extracted | `p()`, `h()`, `bullets()` lifted from `seedExample.ts`, which imports them back |
| `features/editor/insertables.ts` | edited | Optional `example` per item |
| `features/editor/shortcutData.ts` | extracted | Binding list out of `ShortcutsSheet.tsx`; the sheet imports it back |
| `components/paletteCatalog.ts` | extracted | Descriptive half of the context commands; `run` stays in the palette |
| `features/guest/guestStore.ts` | edited | `seedGuestWorkspace()` writes the README first |
| `features/onboarding/OnboardingHost.tsx` | edited | Calls `ensureReadme()` before the tour |
| `lib/commands.ts` | edited | Adds "Open the guide" |

Two extractions exist because the data is currently trapped inside a component.
`ShortcutsSheet.tsx` holds its 27 bindings in a private function; `CommandPalette.tsx`
declares ~11 commands inline. In both cases only the *descriptive* half moves — the
shortcut sheet still renders, and every `run(ctx)` stays where its state lives.

---

## 7. Verification

| Check | Catches |
| --- | --- |
| Every `INSERT_ITEMS` title, palette command and shortcut label appears in the output | A block added without a description shipping a blank row |
| Every emitted node type exists in the schema `buildExtensions.ts` registers | A demo built from a node the editor cannot draw |
| For `{ guest: true }`, nothing in `BLOCKED` is described as available, and no `example` requires an upload | The note promising a student something that will refuse them |
| Playwright: `/try` lands on README; KaTeX renders, the `chem` node renders, toggles open | A document that is valid JSON but visually broken |

The last one is the point. This repo has a standing lesson that a green count is not
evidence — a capture harness once reported "78 screenshots, 0 failed" when all 78 were
the login form. Asserting the doc JSON contains a `chem` node proves nothing about
whether a molecule appears on screen, so the e2e check reads the rendered page.

Suites to run before pushing: `npm run test -w server`, `npm run e2e` (not just
typecheck — renaming a button once broke 8 specs silently), and `npm run build -w web`.

---

## 8. Known limits

**Sections 05–09 are data, not derivation.** Sections 01–04 are emitted from
registries that already exist. There is no registry behind Study, Boards, Import, AI
or Share, so `featureCatalog.ts` holds one sentence per feature. That is still one
definition in one place, but it is a sentence written by hand rather than one the code
already contains — and a feature added without touching that file will not appear.

**The note is not kept in sync after creation.** It is seeded once and then belongs to
the user, who may edit or delete it. "Open the guide" regenerates a current copy on
demand; it never rewrites one someone has edited.
