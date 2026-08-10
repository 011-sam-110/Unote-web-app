// What an open tab is.
//
// A tab's id is NOT its path. The two are separate because a tab is a place you keep
// coming back to rather than a fixed destination: clicking a link inside a tab moves that
// tab somewhere new, and the pane, its scroll offset and its position in the strip all
// have to survive that move. Keying any of it on the path would throw the pane away every
// time you followed a wikilink.

export interface Tab {
  /** Stable for the life of the tab. React keys, the mounted-pane list and the scroll
   *  memory are all keyed on this. */
  id: string;
  /** The route this tab is currently showing, e.g. `/note/abc`. Path + search, no hash. */
  path: string;
  /** What the page calls itself once it has loaded and can do better than the path can -
   *  a note's live title, which follows the title field as it is typed. Absent until
   *  then, and routeMeta supplies the fallback. */
  label?: string;
  /** The notebook colour a note or notebook tab leads with, same square the sidebar uses.
   *  Published by the page for the same reason as `label`. */
  dot?: string;
}

export interface TabsState {
  tabs: Tab[];
  /** Always present in `tabs`. The strip is never empty - closing the last tab opens Home
   *  rather than leaving nothing selected. */
  activeId: string;
}

/** Where a newly-requested path should go. */
export type OpenMode =
  /** Load into the tab you are already looking at - what an ordinary link click does. */
  | 'replace'
  /** Add a tab beside the active one and go to it - Ctrl/Cmd+click, middle-click, `+`. */
  | 'new'
  /** Add a tab but stay where you are. */
  | 'background';
