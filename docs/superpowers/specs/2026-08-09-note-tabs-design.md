# Tabs: keeping several notes open at once

**Date:** 2026-08-09
**Status:** approved, ready for implementation

## The problem

Unote opens one thing at a time. `/note/:noteId` mounts `NotePage`, and navigating
anywhere unmounts it - TipTap instance, undo history, scroll position, and whichever of
Outline / Comments / Ink / AI you had open all go with it. Cross-referencing two notes,
which is the ordinary shape of revision, means the back button and a fresh load each way.

## What we are building

A tab strip across the top of the content column. Every route the shell can show gets a
tab: notes, notebooks, Home, Search, Study, Ask, Tags. Switching tabs is instant and keeps
the page exactly as you left it.

### Decisions taken

| Question | Decision |
|---|---|
| What gets a tab | Every route inside the app shell, not just notes |
| Strip width | The content column only - to the right of the sidebar, which is untouched |
| Switching | Tabs stay mounted and alive, capped at the 4 most recent (2 on mobile) |
| Opening | A normal click loads into the active tab; Ctrl/Cmd+click, middle-click and `+` open new ones |
| Persistence | `localStorage`, per device, restored on reload |

### Where the strip goes, and why not where it was first drawn

The original sketch put the strip below the `Insert / Outline / Comments / Ink / Find`
bar. That bar is note-specific - a Search or Study tab has nothing to sit under - so with
every route getting a tab the strip has to sit above it. The sidebar keeps its full height
and its header; nothing to the left of the content column moves.

```
┌──────────────┬─────────────────────────────────────┐
│  U  Unote  ‹ │ ▣ Untitled ×│ Algorithms ×│Search ×│+│  ← the strip
│  🔍 Search   ├─────────────────────────────────────┤
│  ⌂ Home      │ + Insert │Outline│Comments│Ink│Find  │  ← belongs to the active tab
│  ▤ Study   4 ├─────────────────────────────────────┤
│  ✦ Ask AI    │ ● rwar / untitled                   │
│ NOTEBOOKS    │ Untitled                            │
│  ▮ rwar    2 │ Date: e.g. 14 Oct 2026              │
└──────────────┴─────────────────────────────────────┘
```

## Architecture

### The layout restructure comes first

`.app-main` is currently the scroll container (`overflow-y: auto`), and `NoteActionBar` is
`position: sticky; top: 0` inside it. Adding a strip as a sibling above `<Outlet/>` would
put two elements in a fight over the same sticky offset.

So `.app-main` becomes a flex column that does **not** scroll: a fixed-height strip, then
a pane region, then one scroll container **per tab pane**. This is not a workaround, it is
the thing that makes the rest work - each pane owning its own scrollbar is why scroll
position survives a switch for free, and why the note's sticky bar sticks to the top of
its own pane rather than to the shared column.

```
.app-main            display: flex; flex-direction: column; overflow: hidden
├── TabStrip         flex: 0 0 auto
└── .tab-panes       flex: 1; min-height: 0; position: relative
    ├── .tab-pane    height: 100%; overflow-y: auto        (active)
    └── .tab-pane    display: none                         (alive, hidden)
```

### Modules

Each is one file with one job, in `web/src/features/tabs/`.

| File | Responsibility |
|---|---|
| `tabTypes.ts` | `Tab { id, path, label?, dot? }`, `TabsState { tabs, activeId }` |
| `tabStorage.ts` | Read/write `localStorage`, reject malformed or over-long saved state |
| `tabsReducer.ts` | Pure state transitions - open, dedupe, close, pick the next active tab, reorder |
| `routeMeta.ts` | Pure: a path plus the notebook list → a tab's fallback label, icon and colour dot |
| `tabRoutes.tsx` | The one list mapping a route pattern to its element |
| `TabsContext.tsx` | Provider: holds state, syncs with the URL, intercepts modified clicks |
| `TabHost.tsx` | Renders the mounted panes, evicts past the cap, shows the active one |
| `tabLocation.tsx` | What a pane knows about itself - see below |
| `TabStrip.tsx` | The strip itself |
| `TabMenu.tsx` | The right-click menu, positioned at the pointer |
| `tabs.css` | Its styles |

### A pane's own idea of where it is

`tabLocation.tsx` grew larger than the "am I active?" guard this design first assumed, and
it is the piece that actually makes several pages mountable at once.

`useParams` and `useSearchParams` answer for the URL, and the URL belongs to whichever tab
is on screen. A hidden note page asking the router for its id would be handed the
**visible** note's id, refetch, and quietly replace its own contents with a second copy of
what the user is already looking at. Five pages read router state that way. So the file
exports `useTabParams` and `useTabSearchParams` alongside `useIsActiveTab`, each answering
against the pane rather than the browser, and each falling through to the router when a
page renders outside a pane. The five call sites change by one line apiece.

The same reasoning gives Search and Tags something they could not have had before: an
inactive Search tab keeps its own query, because setting search params writes to the tab
rather than to the address bar.

### Rendering several pages at once

react-router's `<Outlet/>` renders only the matched route, so `App` renders `<TabHost/>`
instead. TabHost matches each open tab's path against `TAB_ROUTES` with `matchPath` and
renders that element.

That makes `tabRoutes.tsx` the single source of truth for which element a path renders.
`main.tsx` **generates** its children from that same list rather than declaring its own -
each `{ path, element: null }`, which still resolves the URL, still keeps `<RequireAuth>`
in front of every route, and still feeds `useParams` in App. This design first proposed a
test asserting the two lists agree; generating one from the other is strictly better, and
the test that remains checks what generation cannot: that every pattern has a sample path
which matches it. (`element: null` rather than an omitted element because react-router
warns about a matched leaf route whose element is `undefined`, once per navigation.)

Liveness is a most-recently-used list capped at 4 panes (2 below 900px). A tab past the
cap stays in the strip and unmounts its pane; returning to it remounts and refetches, with
its scroll offset restored from memory. Inactive panes carry `inert` and `aria-hidden` -
the same treatment `App.tsx` already gives the closed mobile drawer - so the Tab key and
screen readers never wander into a note that is not on screen.

**Recency decides membership only, never DOM order.** The first build rendered the panes
most-recent-first, so every switch reordered them, React moved the pane nodes to match, and
the TipTap editor inside a moved subtree was torn down and rebuilt - the exact thing the
feature exists to prevent, while the strip, the URL and the note's visible text all still
looked correct. Panes render in strip order, which changes only when a tab is dragged.

### The globals a second mounted note would break

`autosaveBus.ts` says it outright: *"Only one note editor is mounted at a time, so a
single active flusher is enough."* Four things assume that, and each gets fixed rather
than worked around.

| What | Today | After |
|---|---|---|
| `setActiveFlush` | One global flusher; last mount wins | A registry keyed by tab id. `flushActiveNote()` flushes the visible one; a new `flushTabNote(id)` runs before a tab closes, so a background tab's pending edit can no longer be lost. No `flushAllNotes`: `useAutosave` already registers its own `beforeunload` per instance, so every mounted note saves itself when the window goes |
| `setActiveNotebook` | Set on mount, cleared on unmount | Set when the tab becomes active, cleared when it stops being active |
| `document.title` | Every mounted note writes it | Only the active tab writes it |
| window `keydown` (Ctrl+S/F/H) | Bound per mounted note | Bound only while the tab is active, so Ctrl+F opens Find in one note, not four |
| `drawerInset` CSS var | Registered by any open drawer | Registered only by the active tab - a background note's AI panel must not indent the visible one |

`useAutosave` deliberately keeps running in a background tab. A tab you switched away from
should still be saving.

### Opening, closing, and the URL

The URL stays the source of truth for which tab is active. On a URL change, if an open tab
already has that path it is activated; otherwise the **active tab's path is updated** -
which is what makes an ordinary `<Link>` click load in place, with no changes to the
hundreds of existing links.

New tabs come from deliberate gestures. A single delegated listener in `TabsContext`
catches Ctrl/Cmd+click and middle-click on internal anchors, calls `preventDefault`, and
opens an app tab instead of a browser one - again, no per-link changes.

That listener needs an anchor to catch, and the commonest way to open a note in the whole
app did not have one: `NoteCard`'s title was a `<button>` calling `navigate()`. So it is a
link now. This was found by clicking, not by testing - every suite was green while Ctrl+
clicking a note card did nothing. It is also the better semantic on its own merits: the
browser's own "open in new tab", middle-click, and the destination in the status bar are
all behaviours a button cannot be given. The a11y comment the card carries is unaffected -
its concern was a `role="button"` **wrapper** containing focusable descendants, and the
title is a leaf.

Closing flushes that tab's autosave first, then activates the neighbour to the right, or
the left if there is none. Closing the last tab opens a fresh Home tab; the strip is never
empty. Right-clicking a tab offers Close, Close others, Close to the right, and Copy link.

A tab's label follows the live note title as it is typed. Before a note loads, `routeMeta`
supplies the fallback label, icon and the notebook's colour dot.

### No new keyboard shortcuts, on purpose

Every natural chord is already taken by the browser: Ctrl+W, Ctrl+Tab and Ctrl+1-9 in
Chrome, Alt+1-9 in Firefox on Windows, Cmd+Shift+[ and ] in Chrome on macOS. `shortcutData.ts`
states the rule this follows - *"A cheatsheet that lists a shortcut which does not fire is
worse than no cheatsheet."*

So tab operations ship in the command palette (Ctrl/Cmd+P), which already exists for
precisely this: Close tab, Close other tabs, Next tab, Previous tab. Mouse gestures and
the context menu cover the rest. The desktop build owns its own accelerators and is where
real chords belong later.

## Testing

- **Unit** (35, in `features/tabs/`) - `tabStorage` round-trips and rejects junk, including a stored `//evil.example` path it would otherwise navigate itself to on boot; `tabsReducer` covers dedupe, close-and-activate-neighbour, reorder and never-empty; `routeMeta` names every route, checked against `TAB_ROUTES` itself rather than a second list.
- **e2e** (`e2e/tabs.spec.ts`, 5) - the load-bearing one stamps the live editor's DOM node, switches away, switches back, and asserts the stamp survived. Visible text is not enough: a reloaded note shows the saved text too, so a remount would pass any assertion written against what is on screen. It then presses Ctrl+Z, because the undo stack lives in ProseMirror's plugin state and cannot survive anything short of the same editor still running.
- **Live browser** - done before the server suite, which drops the dev database.

Two things the e2e suite needed because `<main>` now holds several pages plus a strip:
`editorBody()` filters to the visible editor (an unscoped testid matches every open note
and fails strict mode), and `activePane()` exists for assertions that mean "what the user
is looking at" - one spec asserted a title was absent from `<main>` and was matching that
note's own tab label.

## Out of scope

Split view and side-by-side panes. Per-tab back/forward history - browser back moves the
app URL, which changes the active tab's path. Cross-device sync. Pinned tabs. A hard limit
on how many tabs may be open; only how many stay mounted is capped.
