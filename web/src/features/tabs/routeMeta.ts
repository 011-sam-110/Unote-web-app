// What to call a tab before the page inside it has loaded and can say for itself.
//
// Every tab needs a name the instant it appears, including the frame before its fetch
// comes back - a strip that shows a blank tab and then a title flickers on every open.
// So the path names it first, and the page overwrites that through setIdentity once it
// knows better (a note's real title, its notebook's colour).
import type { IconName } from '../../components/Icon';
import type { Notebook } from '../../lib/types';
import { matchTabRoute } from './tabRoutes';

export interface TabMeta {
  label: string;
  /** The lead glyph, for the pages that are not a note or a notebook. */
  icon?: IconName;
  /** Tags leads with the same `#` glyph the sidebar uses, which is drawn rather than iconed. */
  hash?: boolean;
  /** The notebook square. Only a notebook page can know this from the path alone; a note
   *  publishes its own once loaded. */
  dot?: string;
}

export function routeMeta(path: string, notebooks: Notebook[]): TabMeta {
  const matched = matchTabRoute(path);
  const pattern = matched?.route.pattern;

  switch (pattern) {
    case '/':
      return { label: 'Home', icon: 'home' };
    case '/search':
      return { label: 'Search', icon: 'search' };
    case '/study':
      return { label: 'Study', icon: 'layers' };
    case '/ask':
      return { label: 'Ask AI', icon: 'sparkles' };
    case '/tags':
      return { label: 'Tags', hash: true };
    case '/references':
      return { label: 'Sources', icon: 'link' };
    case '/notebook/:notebookId': {
      const nb = notebooks.find((n) => n.id === matched?.params.notebookId);
      return { label: nb?.name ?? 'Notebook', dot: nb?.color };
    }
    case '/note/:noteId':
      return { label: 'Untitled', icon: 'file-text' };
    default:
      return { label: 'Unote' };
  }
}
