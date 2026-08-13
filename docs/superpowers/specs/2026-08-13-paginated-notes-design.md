# Paginated notes: pages, headers/footers, exports, and a formatting bar

Date: 2026-08-13
Branch: `feat/pages-export` (worktree `C:\Users\sampo\Documents\folio-pages`, based on
`44ab61c` = `origin/main`)

## What this is

Turn a Unote note from a continuous scrolling column into a **paginated document**: real
A4 sheets you can see while typing, a page size you choose, headers and footers, export to
PDF / DOCX / Markdown / plain text, and a Word-style formatting bar pinned to the bottom of
the note.

## Decisions already taken

These were chosen explicitly and are not open questions. Recorded here because several of
them are the expensive option and a later reader will want to know it was deliberate.

| Decision | Choice | The alternative that was rejected |
|---|---|---|
| When pages are computed | **Live, while typing** (debounced) | Break guides only; a separate read-only Page view |
| Which notes paginate | **All text notes, on by default**, opt out per note | Per-note opt-in; per-notebook default |
| PDF engine | **Browser print** (`@page` CSS over the sheets we already render) | Own client-side PDF writer; server-side headless Chrome |
| Bar shape | **Bottom bar is formatting only**; the existing top action bar is unchanged | Full tabbed ribbon at the bottom; one row that expands to two |
| Phones (<820px) | **Pagination suspends**, note is the continuous column it is today, plus a read-only "Page view" button | Scaled A4 sheets everywhere; phone-width pages with A4-equivalent breaks |

"On by default" plus "live while typing" is the costly combination: every text note in the
account pays measurement cost on every change. The design below treats that as the primary
risk rather than an afterthought.

## What already exists (verified, not assumed)

- **TipTap v3.28**, React 19, Vite; server is Express 5 + Postgres.
- The note body is one column; width is `--folio-measure` (unset = full width, or 760px
  when "Focused width" is on). `web/src/features/editor/notePage.css`.
- **There is no print CSS anywhere in the app** except `features/marketing/sitemap.css`.
- **Export is Markdown only.** `server/src/lib/export.ts` renders TipTap JSON to Markdown;
  `server/src/routes/export.ts` serves the whole-account zip. No PDF, no DOCX, no deps for
  either.
- Formatting lives in a **selection bubble menu** (`SelectionToolbar.tsx`), not a
  persistent toolbar. The existing `NoteActionBar.tsx` at the top is Insert + panel toggles
  + note-object actions; it is not a formatting bar and does not become one.
- **`TextStyleKit` already ships `fontFamily`, `fontSize` and `lineHeight`** - they are
  explicitly switched off in `TextColor.ts:18-20`. Three extensions I expected to write are
  a config flip.
- `schema.sql` is applied idempotently on boot; the established migration idiom is to
  append `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...` at the bottom. There is no
  migrations directory.

## Scope: two slices

**Slice A - the page.** Page geometry, live pagination, headers/footers, and all four
exports. These share one model and cannot sensibly be separated: a footer that says
"Page 2 of 7" needs a page count, and a PDF has to agree with the sheet on screen.

**Slice B - the formatting bar.** Independent. Needs new marks and a new component, and
could ship before or after A.

This document specifies both. Slice A is the larger and riskier one.

---

# Slice A: the page

## Data model

One new column, following the existing convention that JSON is stored as `TEXT` (the same
choice `notes.content_json` and `canvas_items.data` make):

```sql
ALTER TABLE notes ADD COLUMN IF NOT EXISTS layout_json TEXT;
```

`NULL` means "the defaults below", so **no backfill is required** and every existing note
becomes an A4 document the first time it is opened. Shape:

```jsonc
{
  "mode": "paged",              // "paged" | "plain"  - "plain" is the per-note opt-out
  "pageSize": "a4",             // a4 | letter | legal | a5 | a3 | executive | custom
  "custom": { "w": 210, "h": 297 },   // mm; only read when pageSize === "custom"
  "orientation": "portrait",    // portrait | landscape
  "margins": { "top": 25.4, "right": 25.4, "bottom": 25.4, "left": 25.4 },  // mm
  "header": {
    "on": false,
    "differentFirst": false,
    "zones":      { "left": "", "center": "", "right": "" },
    "firstZones": { "left": "", "center": "", "right": "" }
  },
  "footer": { /* identical shape */ }
}
```

Header/footer default to **off**: an A4 sheet with two empty bands on it looks broken. They
are turned on from the bottom bar, and once on they render on every sheet.

Zone strings are plain text plus **field tokens** - `{{page}}`, `{{pages}}`, `{{title}}`,
`{{date}}`, `{{notebook}}` - rendered as non-editable chips in the UI and resolved per page
at render, print and export time. This is the one piece of syntax in the feature; it is
chosen over a rich structure because a header is a line of text with two or three
substitutions in it, and a document model for that would be a lot of machinery for no gain.

**Delta sync**: `layout_json` must be added to whatever column list the note sync payload
selects, or a layout change will not propagate to another device. This is a real trap -
the column will work perfectly in one browser and silently not exist in another.

**Canvas notes** (`kind = 'canvas'`) are always `plain`. A board has no reading order, so
it has no pages.

## The pagination engine

A ProseMirror plugin, `web/src/features/editor/pagination/`. The core idea: **one
continuous ProseMirror document, with spacer decorations that push blocks onto the next
sheet, and a separate non-editable layer behind it that draws the paper.** The document is
never split into per-page containers - doing that would break selection, undo, find, and
every node view in the app.

```
   what the user sees              what the DOM is

  +---------------------+      .folio-sheet-layer   (React, aria-hidden, behind)
  |  header band        |        +- .folio-sheet  (paper, shadow, header, footer)
  |                     |        +- .folio-sheet
  |  ...text...         |        +- .folio-sheet
  |            page 1/3 |
  +---------------------+      .folio-prosemirror   (ONE contenteditable, in front)
        (gap)                     +- p, h2, ul ...
  +---------------------+         +- <spacer widget>   <- pushes the next block
  |  header band        |         +- p, h2 ...            onto sheet 2
  |  ...text...         |
```

### How a break is placed

1. Compute the content box in px from mm at 96dpi (`1mm = 96/25.4 = 3.7795px`):
   `contentHeight = pageHeight - marginTop - marginBottom - headerBand - footerBand`.
2. Walk the top-level nodes, reading `offsetTop`/`offsetHeight` off the DOM node for each
   (`view.nodeDOM(pos)`).
3. Track the running offset within the current sheet. When a block would cross the
   boundary, insert a **widget decoration before it** whose height is exactly the remaining
   space plus the inter-sheet gap. The whole block moves to the next sheet; nothing ever
   straddles a break.
4. Publish the resulting page list (count, y-offset and height of each sheet) through the
   plugin key. React reads it and renders the sheet layer.

### Recompute triggers

Doc change (debounced), container resize (`ResizeObserver`), web font load
(`document.fonts.ready`), async node views finishing (images, 3D models, chemistry,
sketches - a `MutationObserver` plus `load` listeners on the content root), and any change
to page size, orientation or margins.

Debounce is **one animation frame plus a 120ms trailing idle**, so a burst of typing
measures once. Measurement is read-only DOM access batched before any write, to avoid
layout thrash.

### The three things that will bite

- **Hidden tab panes measure as zero.** Several note panes are mounted at once (see
  `features/tabs/`), and a hidden one has every height at 0 - which would compute
  thousands of pages and then thrash when it became visible. The plugin **must** bail when
  `view.dom.offsetParent === null`, and recompute on becoming visible. Everything the
  plugin does outside its own pane is guarded on `useIsActiveTab()`.
- **A block taller than one content box cannot be pushed** - pushing it would leave the
  next sheet just as overfull, forever. Rule: such a block starts on a fresh sheet and is
  allowed to overflow it; the page list marks the sheet `overflow: true` and the UI shows a
  quiet inline note ("This block is taller than one page"). It is not silently clipped.
- **Tables are not split across sheets in v1.** A table longer than a page is treated as
  the oversized block above. Splitting a table across pages, with a repeated header row, is
  a genuinely hard problem and is explicitly out of scope; saying so here is better than
  discovering it as a bug.

## Headers and footers

Rendered by React in the sheet layer, **not inside the contenteditable**. Putting repeated
chrome inside the document would make it part of the doc, part of undo, and part of every
export path that walks nodes.

They are still click-to-edit in place: clicking a band focuses a small inline editor for
that zone, and because all sheets show the same value, editing any one of them writes once
to `layout_json` (debounced through the existing autosave bus). With `differentFirst` on,
sheet 1 edits `firstZones` and the rest edit `zones`.

## Exports

One menu - `Export` in the bottom bar's status strip - with four entries. Each names what
it cannot carry, rather than dropping content silently.

### PDF - browser print

A print stylesheet over the sheets already on screen. `@page { size: <w>mm <h>mm; margin: 0 }`
with the margins living inside each sheet, and `break-after: page` on `.folio-sheet`. All
app chrome (`sidebar`, tab strip, both action bars, drawers, rails) is `display: none` in
print. Text stays selectable, KaTeX renders, code keeps its highlighting, fonts are real.

Because pagination is suspended below 820px, printing on a phone must first run a
**synchronous layout-for-print pass** at the note's real page geometry, otherwise a phone
would print the unpaginated column. `beforeprint` triggers it; `afterprint` restores.

### DOCX - server-side, real OOXML

New `server/src/lib/docx.ts` using the `docx` package, served from
`GET /api/notes/:id/export?format=docx`. Maps the page geometry to section properties
(page size and margins in twips), and header/footer zones to real Word headers/footers with
a `PAGE`/`NUMPAGES` field for `{{page}}`/`{{pages}}` - so page numbers stay live in Word.

Nodes that OOXML cannot hold - chemistry structures, 3D models, sketches, canvas items -
become an **unmistakable placeholder paragraph** naming exactly what was omitted and where
to see it, in a distinct style. Not an approximation, not a blank: if a reader cannot tell
from the document itself that something was left out, the export has lied to them.
Maths is emitted as its LaTeX source in a code style (OMML conversion is out of scope, and
is noted as such in the placeholder).

### Markdown

`tiptapToMarkdown` already exists and is well tested. This adds a per-note route rather
than a new renderer. Headers/footers are not part of a Markdown file and the download says
so once.

### Plain text

New `tiptapToPlainText` in `server/src/lib/export.ts`. Not "Markdown with the syntax
stripped" - a proper walk that keeps heading text, list markers and table cells as readable
columns, and drops only the notation.

## Mobile

Below 820px the plugin does not run: the note is the column it is today, at 19px, fully
writable. A **Page view** button renders the sheets read-only so the layout can be checked,
and printing works as described above. The layout settings still exist on the note and
still govern export - the phone simply does not render them live.

---

# Slice B: the formatting bar

`web/src/features/editor/formatbar/FormatBar.tsx` + `formatBar.css`. Sticky to the bottom
of the note pane, guarded on `useIsActiveTab()`.

**Row 1 - formatting.** Paragraph style (Normal / H1 / H2 / H3 / Quote / Code), font
family, font size, grow/shrink, bold, italic, underline, strikethrough, subscript,
superscript, text colour, highlight, clear formatting, bullet / ordered / task lists,
indent / outdent, four alignments, line spacing, paragraph marks, and a `...` overflow that
absorbs the tail at narrow widths.

**Row 2 - status strip.** `Page m of n`, word count, the page-size dropdown, header/footer
toggle, zoom, and the Export menu.

Extensions required:

| Need | Source |
|---|---|
| Font family, font size, line height | **Already present** - flip the three `false`s in `TextColor.ts` |
| Text colour, highlight | Already present |
| Underline, subscript, superscript | Verify against StarterKit v3.28 before adding packages |
| Text align | `@tiptap/extension-text-align` |
| Indent / outdent | Custom - no official extension exists |

The existing selection bubble menu stays. It is a different affordance (act on what you
just selected, without moving the mouse) and removing it would be a regression.

## Testing

- **Unit** (`server`): `tiptapToPlainText` and the DOCX mapper against fixture documents,
  including one that contains every node type the placeholder rule covers.
- **Unit** (`web`): the break-placement function as a pure function over a list of
  `{height}` blocks and a content height - no DOM. This is where the oversized-block and
  exact-fit edge cases get pinned down.
- **e2e** (Playwright): type past the bottom of sheet 1 and assert a second sheet appears;
  change page size and assert the count changes; set a footer field and assert it renders
  on every sheet; assert a hidden tab pane does not paginate.
- **Manual**: print to PDF at A4 and Letter and check the sheet count matches the screen.

Reminders for whoever runs these: `npm run test -w server` **drops the local dev database**,
so do browser checks first; e2e must run from the repo root; port 5173 belongs to a
different app, so use `npm run dev -w web -- --port 5199 --strictPort`.

## Explicitly out of scope

Splitting tables or code blocks across sheets; columns/sections with differing page setup
within one note; odd/even (mirrored) headers; footnotes and endnotes; a table of contents
field; PDF/A; importing page geometry from an uploaded DOCX.

## Coordination

`grammar-desktop` is working in the shared checkout at `C:\Users\sampo\Documents\folio` on
`feat/referencing`, applying a website-grammar pass to the desktop frontend. Agreed split:
they own `web/src/styles/**` (tokens, base, theme) and all non-editor features; this branch
owns `web/src/features/editor/**` - including `editor.css` and `notePage.css` - plus
`web/src/features/export/**` and the two server export files. Typography values that belong
in the note body come to this branch as values, not as diffs.
