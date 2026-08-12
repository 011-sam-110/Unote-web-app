# Referencing - design

**Status:** draft, awaiting Sam's approval. Not yet committed to the repo.
**Date:** 2026-08-12
**Scope:** Part A of two. Part B (paged output - title page, running header, footer, page
numbers) is a separate spec, written once the bibliography exists as real content.

Driven by user feedback: students want a built-in referencing tool. The bar Sam set is
"just as good as a website citing tool", plus two things those tools do not do - the AI
can use it, and invalid citations get caught.

---

## 1. Why this is not just a formatter

Cite This For Me was walked end to end before any of this was designed. It is good at
intake and honest about gaps: after a lookup it splits results into "Here's what we found"
and "Here's what we'll need your help with", and never invents the fields it could not
retrieve. That pattern is adopted directly.

What it does **not** do is verify. Its "Is your source credible?" page is a prose
checklist - questions for the student to consider. Nothing is resolved, fetched or
compared, so a fabricated reference formats exactly as beautifully as a real one.

That gap is the feature.

### 1.1 The checker must not be an LLM check

Unote already has a 56-check AI review catalogue (`server/src/lib/checks.ts`), a tool
catalogue (`server/src/ai/assistantTools.ts`), an `AiEdit` contract, and a review
ProseMirror plugin + rail with an approve step. The obvious move is to add
"is this citation fake?" as a check in that catalogue. **That is wrong and must not be
done.**

`checks.ts` states its own execution model: *"One model request per enabled family,
issued in parallel."* The catalogue is entirely LLM-driven. Asking a language model
whether a citation exists is asking the fabrication engine to audit its own output - and
rendering the verdict in a rail students already trust makes it worse than shipping
nothing. It would clear invented papers and flag real ones, confidently, in both
directions.

**Verification is deterministic and evidence-bearing.** The precedent already exists in
this repo: `server/src/lib/provenance.ts` validates AI citations against real source
structure ("cites slide 14 of a 12-slide source"). This follows that shape.

What is reused from the existing system: the rail as a **rendering and approval surface**,
its ownership checks, and its metering. What is not reused: the prompt-driven check
mechanism.

A genuinely model-shaped check - "this claim has no citation at all" - is a judgement
call and *would* belong in the catalogue. That is out of scope for this spec.

---

## 2. The four states

A citation is not valid-or-invalid. Collapsing these into a binary produces the worst
available bug: telling a student their real source is fake because a registry timed out.

| State | Meaning | Colour | Glyph |
|---|---|---|---|
| `VERIFIED` | Resolved against a registry; the student's fields match the record | green | `✓` |
| `UNCONFIRMED` | Hand-typed or partly found. **Not an error** - merely unchecked | amber | `?` |
| `REFUTED` | The registry contradicts it, or the identifier does not resolve | red | `!` |
| `UNREACHABLE` | Offline, or the registry is down | neutral grey | `-` |

Three rules that are load-bearing rather than cosmetic:

1. **`UNCONFIRMED` is the default and will be the most common state.** It must never
   render as a defect. Most student sources have no DOI or ISBN.
2. **`UNREACHABLE` must never degrade into `REFUTED`.** It is the absence of a claim, not
   a claim, and must not borrow the vocabulary of one - hence neutral grey rather than
   anything red-adjacent.
3. **Every verdict carries its evidence and the date it was checked**, so it is
   falsifiable rather than an opinion, and so a cached verdict stays honest instead of
   silently re-resolving and flipping between runs with no explanation.

### 2.1 Glyph before hue (accessibility, non-negotiable)

`VERIFIED` and `REFUTED` differ on the **red-green axis** - the most common colour vision
deficiency - on the two states carrying the most consequence. A student with deuteranopia
could not distinguish a sound source from a fabricated one, and would never report it,
because the interface still looks confident.

So state is carried by **glyph first, hue second**, legible with colour stripped entirely.

The decisive argument is not general accessibility, it is this project specifically: a
bibliography is the part of a document most likely to be **printed**, printing is
frequently greyscale, and **paged output is the very next feature**. Colour-only state
would not survive our own roadmap.

### 2.2 Both themes, tokenised

All four states are defined as CSS custom properties in `web/src/styles/tokens.css`, in
the light block *and* the dark overrides, in the same commit. No literals at the use site.

This is not a style preference. `tokens.css` records that syntax highlighting was
previously hard-coded light-theme hexes served unchanged in dark mode, where keywords
measured **2.88:1** and numbers 3.61:1 - well under AA. The exact failure was invisible
until someone measured, in this file, and was fixed by tokenising. A future contributor
argues with a style note; they do not argue with a documented incident.

---

## 3. Data model

Account-wide source library (Zotero model), not per-note or per-notebook. One reading list
serves several essays, and the checker strengthens as verified records accumulate.

```
sources           id, user_id, csl_json, kind, created_at, updated_at
                  -- csl_json is CSL-JSON, the format citeproc-js consumes directly
citations         id, user_id, note_id, source_id, locator, prefix, suffix, position
source_verdicts   source_id, state, evidence, registry, checked_at
```

Notes reference `source_id`. A note never stores formatted citation text - see §5.

### 3.1 Source types - all 27 at launch

Source *types* are data, not schema. Full parity with the incumbent from day one:

> archive material, artwork, blog, book, broadcast, chapter of an edited book,
> conference proceedings, court case, dictionary entry, dissertation, DVD/video/film,
> e-book or PDF, edited book, email, encyclopedia article, government publication,
> interview, journal, magazine, music or recording, newspaper, podcast, presentation,
> report, software, website, and "other".

This is affordable precisely *because* of the CSL decision (§4). Each type maps to a CSL
item type (`article-journal`, `chapter`, `webpage`, `legal_case`, `motion_picture`, …) and
CSL already defines which variables each type carries, so a type is a **field-list plus a
mapping**, not new formatting code. Hand-rolled formatters would have made 27 types
roughly 190 format rules; with CSL the engine already knows them all.

The work per type is therefore the intake form and the CSL type mapping. One registry
table (`sourceTypes.ts`) drives the picker, the form and the mapping, so the three cannot
drift - the same structural trick `checks.ts` uses to keep its picker and prompts in sync.

Contributors are **structured** - role (author/editor/translator/director/…) plus
given/family/suffix, repeatable - never a free-text author string. This is what makes
verification a real comparison against a registry record rather than a fuzzy match on a
blob.

---

## 4. Style engine

**CSL (Citation Style Language) via citeproc-js.** "Harvard" is not one style - nearly
every UK university publishes a variant - and CSL already has them. Styles are data, so
adding one is not engineering. Hand-rolling ~7 styles across 27 source types would be
roughly 190 format rules written and tested by hand.

Ship ~10 curated: Harvard (Cite Them Right), APA 7, MLA 9, Chicago, IEEE, Vancouver,
OSCOLA, ASA, AMA.

**Default: Harvard (Cite Them Right).** Sam had no required variant, so this is a decision
rather than a requirement: it is the most widely used UK Harvard and the one university
library guidance generally points at. Because a style is a data file, a module that
mandates a different variant is a drop-in, not a rewrite - which is the whole reason the
uncertainty here was safe to resolve by choosing.

### 4.1 Styles AND locales compile to `.ts`

**Verified against the citeproc-js documentation, not assumed.** `CSL.Engine` takes a
`sys` object that must supply `retrieveLocale()` as well as `retrieveItem()`, and
`retrieveLocale()` returns serialized locale XML for an RFC 4646 tag (`en-GB`) - separate
data, shipped in a separate repository from the styles.

Compiling styles but leaving locales as runtime data files would reproduce a failure this
project has already had: `schema.sql` was not bundled by Vercel and the deploy broke in
production only. Two reasons it would bite harder here:

- **en-GB.** The locale drives date formats and terms (`accessed` vs `retrieved`), so a
  missing or wrong locale yields a **silently wrong bibliography** rather than a crash.
- **Offline.** Runtime-fetched locales stop formatting working at zero bars, destroying
  the property compiling in was supposed to buy.

Both compile to `.ts` at build time, and `retrieveLocale` reads from that map. No runtime
data files, so `vercel.json` `includeFiles` cannot be got wrong.

---

## 5. Editor nodes

| Node | Kind | Content |
|---|---|---|
| `citation` | inline atom | none - renders from attrs |
| `bibliography` | block atom | none - renders from the note's citation set |

Both render entirely from attrs via a node view, with **no text nodes in the document**.
Two independent reasons, which happen to want the same design:

1. If the rendered `(Smith, 2020)` were real text, switching Harvard → APA could not
   rewrite it without editing the student's prose. Keeping it in attrs means a style
   change re-renders every citation and touches no text.
2. The spell checker being built in parallel would otherwise squiggle every author
   surname, journal title and Latin abbreviation. With no text nodes there is nothing for
   it to walk into.

`plainTextFromDoc` must be taught to render both atoms, for search and Markdown export.

### 5.1 Marking convention (agreed with the parallel spell-check work)

Three systems want to mark up one document: the existing AI review, spelling, and citation
flags. **Red wavy underline under running text is reserved by the platform** - Chrome,
Firefox, Safari, Windows and macOS all draw it for misspellings, and if browser-native
spellcheck is used there is no API to restyle it. So separation is by **form**, not
colour:

- **Spelling** - a line under a text range. Ambient, ignorable.
- **Citation** - a badge on its own node, carrying its own affordance.

Because the two never occupy the same visual channel, a red badge and a red squiggle
coexist unambiguously.

Z-order when ranges coincide, back to front: spelling underline → AI review highlight →
citation badge. Right-click precedence: innermost anchor under the pointer wins, so a
citation badge beats a spelling underline beats a review range.

### 5.2 Tabs

Several note editors are mounted at once (`web/src/features/tabs/`, commit `44ab61c`).

- Anything registered in `buildExtensions.ts` is instantiated **per editor**, so the
  account-wide source library must live in app-level state, never extension state.
- Any references panel must read identity from `useTabParams` / `useTabSearchParams` and
  guard outward-facing effects on `useIsActiveTab()`. `useParams` answers for the visible
  tab, so a hidden pane asking for its note id gets the wrong one.

---

## 6. Intake and resolution

One box takes a URL, DOI, ISBN, title or keyword; the server sniffs which it is rather
than making the student classify it first. A **manual entry** path is first-class, not a
fallback - it is also the offline path, so one mechanism serves both.

After a lookup, retrieved fields and missing fields are shown **separately**, and missing
fields are handed back as blanks. Nothing is invented.

### 6.1 Resolvers - measured, not assumed

Probed live from this machine on 2026-08-12:

| Probe | Result | Consequence |
|---|---|---|
| `api.crossref.org/works/10.1038/nature12373` | 200, 0.67s | Full record incl. structured authors |
| `doi.org` with `Accept: application/vnd.citationstyles.csl+json` | 200, `csl+json` | **DOIs return native CSL-JSON - no mapping layer needed at all** |
| `api.crossref.org/works/10.1016/j.cell.2019.99999` | 404 `Resource not found` | `REFUTED` is backed by an unambiguous signal |
| `openlibrary.org/isbn/9780140449136.json` | 200 | Title, publisher, date, pages |
| `openlibrary.org/isbn/<fabricated>.json` | 404 | Same for books |
| Crossref `query.bibliographic` title search | 200 | Title-only search returns the right paper first, with its DOI |

Content negotiation at `doi.org` covers DataCite and mEDRA too, not only Crossref.
**Caveat to handle at implementation:** the CSL-JSON payload carries no `id`, so one must
be assigned before handing the item to the engine.

**Two gotchas that only appeared by calling the APIs:**

- **OpenLibrary does not return author names.** It returns `{"key": "/authors/OL22242A"}`.
  Every book costs an extra round trip per author, or the reference list silently has no
  authors - a bug a naive implementation ships and nobody notices until a bibliography is
  missing every name.
- **Two name fields, non-ASCII.** That key resolves to a record with a native-script
  `name` (Cyrillic, in the case tested) and a separate Latin `personal_name`. Choosing
  wrong puts Cyrillic in an English Harvard reference list - silently wrong output, not a
  crash. Prefer `personal_name`; carry UTF-8 end to end.

### 6.2 Fetching a user-typed URL is SSRF

"Check the link is alive" reads as a UX nicety and is a server-side fetch of an
attacker-controlled string whose result is reported back to the attacker. On Vercel the
function can reach the cloud metadata endpoint and internal addresses, so an unfiltered
fetch turns "verify my source" into an internal port scanner with the verdict text as the
exfiltration channel. Required before this ships:

- Scheme allowlist: `http` / `https` only. No `file:`, `gopher:`, `data:`.
- Resolve the hostname **first**; reject loopback, link-local, private, CGNAT, multicast
  and reserved ranges on the **resolved** address.
- Re-check after **every** redirect and cap the chain - hop one can be public, hop two
  internal.
- Pin the connection to the address that was checked, or a DNS rebind between check and
  fetch walks straight through.
- Timeout and response-size cap. Never echo raw response bodies into a verdict.

### 6.3 When verification runs - event-driven, never polled

| Trigger | Scope |
|---|---|
| Citation inserted | That source, immediately |
| A source's fields edited | That source - the metadata changed, so the verdict may have |
| Note opened | Background, batched sweep of verdicts older than **7 days** |
| "Re-check all" in the rail | Everything in the note, on demand |
| Idle typing | **Nothing.** No requests. |

Polling on a timer was considered and rejected. A note with 20 citations checked every 15
seconds is 80 requests/minute - roughly 38,000 over an eight-hour study day, from one user
on one note. Crossref would throttle us, and the failure lands in the worst possible
place: every user starts seeing `UNREACHABLE`, a state deliberately designed to be
unalarming, appearing constantly for a reason unrelated to their sources.

It also re-asks a question built never to change. A DOI is a *persistent* identifier by
definition; one that resolved ten seconds ago resolves now. The staleness sweep exists for
the one thing that genuinely does decay - **link rot** on plain URLs - and seven days is
far inside the timescale on which that happens.

Crossref wants a contact `mailto` in the User-Agent for its polite pool, or throttling is
unpredictable. Verdicts cache per identifier, and each carries `checked_at` so a stored
verdict states its own age rather than implying freshness.

---

## 7. AI tools

Two tools, with the boundary drawn so a fabricated reference is **structurally
impossible** rather than discouraged.

**May:**
- Select a source from the student's existing library and insert the in-text citation.
- Search Crossref/OpenLibrary and *propose* real records for a claim needing support.
- Explain why a reference was refuted, quoting the registry response.
- Rebuild the bibliography after a style change.

**May not:**
- Write citation metadata itself. It may only select from records a registry returned.
- Insert anything without passing the existing approve step.
- Set `VERIFIED`. Only a resolver sets state.
- Decide unprompted which claims need citing - that is the student's academic judgement,
  and they are marked on it.

Both tools are added to `server/src/ai/assistantTools.ts`, which is the single catalogue
the prompt, the validator and the client all read.

---

## 8. Offline

Unote has three shipped offline stages; someone deliberately built for the student on a
train. Referencing being online-core must not regress that.

- Cached CSL-JSON drives insertion and formatting, so citing and re-styling work at zero
  bars. Styles and locales are compiled in, so the engine needs no network either.
- Only **new** lookups and **new** verification need a connection.
- Both degrade to `UNCONFIRMED` / `UNREACHABLE`. Neither fails, and neither flags.

---

## 9. Coordination (parallel spell-check work)

Shared files - ping before touching, append at the end in a fenced comment block naming
the feature: `buildExtensions.ts`, `insertables.ts`, `SlashItems.ts`, `editor.css`,
`schema.sql`, `tokens.css`.

`web/src/features/editor/__snapshots__/shortcutData.test.ts.snap` is shared in practice: a
Citation slash item will change it. Announce regeneration.

`npm run test -w server` drops the local dev database. Announce before running it.

`web/index.html` contains an inline script pinned by sha256 in both `vercel.json` and
`server/src/lib/csp.ts`. Editing even a comment inside it breaks production CSP. This work
needs no change there - lookups are proxied through our own server, so no `connect-src`
change is required.

---

## 10. Testing

- Unit: identifier sniffing; CSL-JSON round trip; each of the four states from fixture
  registry responses; the `personal_name` preference; SSRF rejection table (loopback,
  private, CGNAT, redirect-to-internal, rebind).
- Integration: resolve → review → save → cite → bibliography rebuild → style switch.
- e2e: insert a citation, switch style, confirm prose is untouched and every citation
  re-rendered. Run `npm run e2e`, not just unit tests and a build - renaming a button once
  broke 8 specs that nobody caught.
- Greyscale check: render all four states with colour stripped and confirm they remain
  distinguishable.

---

## 11. Decisions taken (previously open)

All three resolved with Sam on 2026-08-12:

1. **Source types:** all **27** at launch, full parity with the incumbent (§3.1).
2. **Default style:** Harvard (Cite Them Right). No variant was mandated, so this was
   decided rather than blocked on; styles are data, so it is reversible (§4).
3. **Check cadence:** event-driven with a 7-day staleness sweep, not polled (§6.3).
   A 15-second timer was proposed and rejected on rate-limit arithmetic.

### Still genuinely open

- **Bibliography placement.** Whether the `bibliography` node is inserted by the student
  wherever they want it, or pinned to the end of the note. Leaning: insertable like any
  other block, because a dissertation chapter may want one per section. Cheap to change.
- **Locator UI.** Harvard in-text citations often carry a page (`Smith, 2020, p. 14`).
  The data model has `locator`; the input affordance is not designed yet.
