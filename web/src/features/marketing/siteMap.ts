// The site's own structure, as data.
//
// One list, two readers: SitemapPage renders it for a person, and sitemap.test.ts asserts
// that web/public/sitemap.xml lists exactly the entries marked `indexed` here. That test
// is the whole reason this file exists rather than the page hard-coding its own markup -
// a hand-maintained XML sitemap and a hand-maintained HTML one drift apart within a
// release or two, and the XML is the copy nobody looks at, so it drifts silently.
//
// It is not generated INTO the XML at build time, deliberately: sitemap.xml is a real
// static file that Vercel serves ahead of the SPA rewrite (see robots.txt), and a build
// step that rewrites it would also rewrite the `lastmod` dates, which are only meaningful
// if they reflect real edits. A test that fails on drift gets the same guarantee without
// teaching the sitemap to lie about its dates.

export type Access =
  /** Reachable with no account. */
  | 'open'
  /** Behind the login. Listed so the map is a map, linked as plain text so it isn't a dead end. */
  | 'account'
  /** Reachable by anyone holding the link, and by nobody else. */
  | 'link';

export interface SiteEntry {
  title: string;
  blurb: string;
  access: Access;
  /** Real path, where one exists. Omitted for surfaces that live inside another page. */
  path?: string;
  /**
   * Whether this URL belongs in sitemap.xml.
   *
   * Open ≠ indexed. `/login` and `/try` need no account and are still not worth a search
   * result: one is a form, the other is an action that redirects. Both are already sent
   * as noindex or excluded in robots.txt, and a sitemap that contradicts those headers is
   * a sitemap Google learns to distrust.
   */
  indexed?: boolean;
  children?: SiteEntry[];
}

export interface SiteBranch {
  id: string;
  title: string;
  blurb: string;
  entries: SiteEntry[];
}

export const SITE_MAP: SiteBranch[] = [
  {
    id: 'start',
    title: 'Getting in',
    blurb: 'Everything you can reach before you have an account.',
    entries: [
      { title: 'Home', path: '/', blurb: 'What Unote is, and who it is for.', access: 'open', indexed: true },
      {
        title: 'Sitemap',
        path: '/sitemap',
        blurb: 'This page - every surface in the app, on one screen.',
        access: 'open',
        indexed: true,
      },
      {
        title: 'Download for desktop',
        path: '/download',
        blurb: 'The same notebook and the same account, in a window instead of a tab. Free, and genuinely optional.',
        access: 'open',
        indexed: true,
      },
      {
        title: 'Start writing',
        path: '/try',
        blurb: 'Opens a notebook straight away. No email, no password; your notes stay on the device until you keep them.',
        access: 'open',
      },
      { title: 'Create an account', path: '/signup', blurb: 'Keeps your notes across devices. Issues a one-time recovery key.', access: 'open' },
      { title: 'Log in', path: '/login', blurb: 'Email and password, or Google and GitHub where they are enabled.', access: 'open' },
      { title: 'Recover an account', path: '/recover', blurb: 'The one-time key from signup, for when the password is gone.', access: 'open' },
    ],
  },
  {
    id: 'desk',
    title: 'Your desk',
    blurb: 'Where the writing happens.',
    entries: [
      {
        title: 'Dashboard',
        path: '/',
        blurb: 'Recent notes, pinned notebooks and what you were last working on. It takes over "/" once you are signed in, so the home page above is only ever the signed-out view.',
        access: 'account',
      },
      { title: 'Notebook', path: '/notebook/:id', blurb: 'One subject: its notes, its tags, and the boards filed under it.', access: 'account' },
      {
        title: 'Note',
        path: '/note/:id',
        blurb: 'The editor. Blocks, maths, chemistry, 3D models, sketches, code and tables.',
        access: 'account',
        children: [
          { title: 'Wikilinks and backlinks', blurb: '[[Link]] to another note; every note shows what points at it.', access: 'account' },
          { title: 'Boards', blurb: 'An infinite canvas. A board is a note, so it files and searches like one.', access: 'account' },
          { title: 'Ink', blurb: 'Apple Pencil and stylus writing, over the note or on a board.', access: 'account' },
          { title: 'Comments', blurb: 'Threads anchored to a selection, on your own notes or a shared one.', access: 'account' },
          { title: 'History', blurb: 'Earlier versions of a note, restorable.', access: 'account' },
        ],
      },
      { title: 'Search', path: '/search', blurb: 'Full-text across every note, with operators for tag, notebook and date.', access: 'account' },
      { title: 'Tags', path: '/tags', blurb: 'Every tag you use, what it is on, and how to merge or rename one.', access: 'account' },
      {
        title: 'Offline',
        blurb: 'Writing, ink, boards, images and search all keep working with no connection. Changes queue and sync when you are back.',
        access: 'account',
      },
    ],
  },
  {
    id: 'study',
    title: 'Turning notes into revision',
    blurb: 'The part that reads your notes back to you.',
    entries: [
      { title: 'Study', path: '/study', blurb: 'Spaced repetition over cards made from your own notes. SM-2 scheduling.', access: 'account' },
      { title: 'Ask', path: '/ask', blurb: 'Questions answered from your notebooks, with the notes it used.', access: 'account' },
      {
        title: 'Assistant',
        blurb: 'A conversation scoped to the note you are in: rewrite, explain, quiz, tidy. Every change is previewed before it is applied.',
        access: 'account',
      },
      { title: 'Templates', blurb: 'Cornell notes, lecture notes, essay plans, lab reports and more - or save your own.', access: 'account' },
    ],
  },
  {
    id: 'inout',
    title: 'In and out',
    blurb: 'Getting existing work in, and getting all of it back out.',
    entries: [
      {
        title: 'Import',
        blurb: 'Reads your files in the browser. Nothing is added to a notebook until you review it.',
        access: 'account',
        children: [
          { title: 'Documents', blurb: 'PDF, Word, PowerPoint, plain text.', access: 'account' },
          { title: 'Photos of notes', blurb: 'Grouped into notes by when they were taken, and read with OCR.', access: 'account' },
          { title: 'Markdown or a Unote export', blurb: 'A folder or .zip. Folders become notebooks.', access: 'account' },
          { title: 'Obsidian vault', blurb: 'Folders become notebooks, frontmatter becomes tags, [[links]] survive.', access: 'account' },
          { title: 'Notion export', blurb: 'The Markdown & CSV .zip. Page ids stripped, properties become tags.', access: 'account' },
          { title: 'Google Docs', blurb: 'A Takeout .zip, or documents downloaded as .docx or .html.', access: 'account' },
          { title: 'Lecture recording', blurb: 'Slides and captions pulled out of an MP4, entirely in your browser.', access: 'account' },
        ],
      },
      {
        title: 'Phone capture',
        path: '/capture',
        blurb: 'Scan a QR from the desktop app to send photos from your phone. The pairing code is single-use and the session it mints can do nothing but import.',
        access: 'link',
      },
      { title: 'Export', blurb: 'Any note, or everything, as Markdown. No export fee and no lock-in.', access: 'account' },
      {
        title: 'Shared note',
        path: '/join/:token',
        blurb: 'A read-only or editable link you create yourself. Unguessable, and revocable at any time.',
        access: 'link',
      },
    ],
  },
];

/** The URLs that belong in sitemap.xml, in the order they appear above. */
export function indexedPaths(): string[] {
  const out: string[] = [];
  const walk = (entries: SiteEntry[]) => {
    for (const e of entries) {
      if (e.indexed && e.path) out.push(e.path);
      if (e.children) walk(e.children);
    }
  };
  for (const branch of SITE_MAP) walk(branch.entries);
  return out;
}
