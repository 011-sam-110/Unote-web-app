# Tabs: keeping several notes open at once

**Date:** 2026-08-09
**Status:** approved, ready for implementation

## The problem

Unote opens one thing at a time. `/note/:noteId` mounts `NotePage`, and navigating
anywhere unmounts it — TipTap instance, undo history, scroll position, and whichever of
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
| Strip width | The content column only — to the right of the sidebar, which is untouched |
| Switching | Tabs stay mounted and alive, capped at the 4 most recent (2 on mobile) |
| Opening | A normal click loads into the active tab; Ctrl/Cmd+click, middle-click and `+` open new ones |
| Persistence | `localStorage`, per device, restored on reload |

### Where the strip goes, and why not where it was first drawn

The original sketch put the strip below the `Insert / Outline / Comments / Ink / Find`
bar. That bar is note-specific — a Search or Study tab has nothing to sit under — so with
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
the thing that makes the rest work — each pane owning its own scrollbar is why scroll
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
| `tabsReducer.ts` | Pure state transitions — open, dedupe, close, pick the next active tab, reorder |
| `routeMeta.ts` | Pure: a path plus the notebook list → a tab's fallback label, icon and colour dot |
| `tabRoutes.tsx` | The one list mapping a route pattern to its element |
| `TabsContext.tsx` | Provider: holds state, syncs with the URL, intercepts modified clicks |
| `TabHost.tsx` | Renders the mounted panes, evicts past the cap, shows the active one |
| `useIsActiveTab.ts` | The guard every page uses to ask "am I the one on screen?" |
| `TabStrip.tsx` | The strip itself |
| `tabs.css` | Its styles |

### Rendering several pages at once

react-router's `<Outlet/>` renders only the matched route, so `App` renders `<TabHost/>`
instead. TabHost matches each open tab's path against `TAB_ROUTES` with `matchPath` and
renders that element.

That makes `tabRoutes.tsx` the single source of truth for which element a path renders,
and reduces the router's children in `main.tsx` to path-only entries — they still resolve
the URL and still feed `useParams`, but they no longer carry elements. Two lists that must
agree is exactly the drift the codebase already guards against elsewhere
(`sitemap.test.ts`, `insertables.loadOrder.test.ts`), so a test asserts the route patterns
in `main.tsx` and in `TAB_ROUTES` are identical.

Liveness is a most-recently-used list capped at 4 panes (2 below 900px). A tab past the
cap stays in the strip and unmounts its pane; returning to it remounts and refetches, with
its scroll offset restored from memory. Inactive panes carry `inert` and `aria-hidden` —
the same treatment `App.tsx` already gives the closed mobile drawer — so the Tab key and
screen readers never wander into a note that is not on screen.

### The globals a second mounted note would break

`autosaveBus.ts` says it outright: *"Only one note editor is mounted at a time, so a
single active flusher is enough."* Four things assume that, and each gets fixed rather
than worked around.

| What | Today | After |
|---|---|---|
| `setActiveFlush` | One global flusher; last mount wins | A registry keyed by tab id. `flushActiveNote()` flushes the visible one; a new `flushAllNotes()` covers `beforeunload` and tab close, so a background tab's pending edit can no longer be lost |
| `setActiveNotebook` | Set on mount, cleared on unmount | Set when the tab becomes active, cleared when it stops being active |
| `document.title` | Every mounted note writes it | Only the active tab writes it |
| window `keydown` (Ctrl+S/F/H) | Bound per mounted note | Bound only while the tab is active, so Ctrl+F opens Find in one note, not four |
| `drawerInset` CSS var | Registered by any open drawer | Registered only by the active tab — a background note's AI panel must not indent the visible one |

`useAutosave` deliberately keeps running in a background tab. A tab you switched away from
should still be saving.

### Opening, closing, and the URL

The URL stays the source of truth for which tab is active. On a URL change, if an open tab
already has that path it is activated; otherwise the **active tab's path is updated** —
which is what makes an ordinary `<Link>` click load in place, with no changes to the
hundreds of existing links.

New tabs come from deliberate gestures. A single delegated listener in `TabsContext`
catches Ctrl/Cmd+click and middle-click on internal anchors, calls `preventDefault`, and
opens an app tab instead of a browser one — again, no per-link changes.

Closing flushes that tab's autosave first, then activates the neighbour to the right, or
the left if there is none. Closing the last tab opens a fresh Home tab; the strip is never
empty. Right-clicking a tab offers Close, Close others, Close to the right, and Copy link.

A tab's label follows the live note title as it is typed. Before a note loads, `routeMeta`
supplies the fallback label, icon and the notebook's colour dot.

### No new keyboard shortcuts, on purpose

Every natural chord is already taken by the browser: Ctrl+W, Ctrl+Tab and Ctrl+1–9 in
Chrome, Alt+1–9 in Firefox on Windows, Cmd+Shift+[ and ] in Chrome on macOS. `shortcutData.ts`
states the rule this follows — *"A cheatsheet that lists a shortcut which does not fire is
worse than no cheatsheet."*

So tab operations ship in the command palette (Ctrl/Cmd+P), which already exists for
precisely this: Close tab, Close other tabs, Next tab, Previous tab. Mouse gestures and
the context menu cover the rest. The desktop build owns its own accelerators and is where
real chords belong later.

## Testing

- **Unit** — `tabStorage` round-trips and rejects junk; `tabsReducer` covers dedupe, close-and-activate-neighbour, reorder, and never-empty; `routeMeta` maps every route pattern to a label.
- **Drift** — the route patterns in `main.tsx` match `TAB_ROUTES` exactly.
- **e2e** — open two notes, type in the first, switch away and back, and assert the caret, undo stack and scroll survived with no loading state; close a tab and check which one takes over; reload and check the strip comes back.
- **Live browser** — two notes open, edited in turn. Run this *before* `npm test -w server`, which drops the dev database.

## Out of scope

Split view and side-by-side panes. Per-tab back/forward history — browser back moves the
app URL, which changes the active tab's path. Cross-device sync. Pinned tabs. A hard limit
on how many tabs may be open; only how many stay mounted is capped.
