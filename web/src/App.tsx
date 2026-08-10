import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { NotebooksProvider, useNotebooks } from './components/NotebooksContext';
import Sidebar from './components/Sidebar';
import QuickSwitcher from './components/QuickSwitcher';
import CommandPalette from './components/CommandPalette';
import { Toaster, toast } from './components/Toast';
import Icon from './components/Icon';
import Tooltip from './components/Tooltip';
import { useShortcuts } from './lib/useShortcuts';
import { api } from './lib/api';
import { errorMessage } from './lib/format';
import { resolveFilingNotebook, setActiveNotebook } from './lib/notebookContext';
import ImportModal from './features/import/ImportModal';
import { _subscribeImportModal, type OpenImportModalArgs } from './components/importModalBus';
import OnboardingHost from './features/onboarding/OnboardingHost';
import ImportWizardHost from './features/import/wizard/ImportWizardHost';
import GuestBanner from './features/guest/GuestBanner';
import ConnectionStatus from './components/ConnectionStatus';
import SyncRunner from './lib/sync/SyncRunner';
import { TabsProvider } from './features/tabs/TabsContext';
import TabStrip from './features/tabs/TabStrip';
import TabHost from './features/tabs/TabHost';

const COLLAPSE_KEY = 'folio:sidebarCollapsed';

function getPersistedCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

function useIsMobile(breakpoint = 899): boolean {
  const query = `(max-width: ${breakpoint}px)`;
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setIsMobile(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return isMobile;
}

// TabsProvider sits INSIDE NotebooksProvider: a notebook tab takes its name and colour
// from the notebook list, and a tab has to be able to name itself before the page inside
// it has loaded.
export default function App() {
  return (
    <NotebooksProvider>
      <TabsProvider>
        <AppShell />
      </TabsProvider>
    </NotebooksProvider>
  );
}

function AppShell() {
  const { notebooks } = useNotebooks();
  const navigate = useNavigate();
  // useParams merges dynamic segments from every matched route in the tree,
  // so this picks up :notebookId even though App itself owns the "/" layout
  // route and doesn't declare that param.
  const params = useParams<{ notebookId?: string }>();
  const isMobile = useIsMobile();

  const [collapsed, setCollapsed] = useState(getPersistedCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [quickSwitcherOpen, setQuickSwitcherOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  // Lifted out of Sidebar so the command palette's "Open phone capture QR"
  // command can trigger the same modal Sidebar's footer button opens.
  const [qrOpen, setQrOpen] = useState(false);
  // Lifted for the same reason as qrOpen: the "?" chord, the command palette and the
  // account menu all open the same cheatsheet.
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const sidebarWrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
    } catch {
      // localStorage unavailable (private mode, etc) - collapse state just won't persist.
    }
  }, [collapsed]);

  // Mobile drawer a11y: while open, focus moves into the drawer, Tab is trapped inside it,
  // and Escape closes it (mirrors Modal.tsx). The closed drawer is made inert below so its
  // off-canvas controls can't be tabbed into.
  useEffect(() => {
    if (!isMobile || !mobileOpen) return;
    const wrap = sidebarWrapRef.current;
    const prevFocused = document.activeElement as HTMLElement | null;
    const FOCUSABLE =
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
    wrap?.querySelector<HTMLElement>(FOCUSABLE)?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setMobileOpen(false);
        return;
      }
      if (e.key === 'Tab' && wrap) {
        const focusables = Array.from(wrap.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        if (!wrap.contains(active)) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      prevFocused?.focus?.();
    };
  }, [isMobile, mobileOpen]);

  // Track the notebook page you're on so later Ctrl+N presses (from anywhere) file there.
  useEffect(() => {
    if (params.notebookId) setActiveNotebook(params.notebookId);
  }, [params.notebookId]);

  const handleNewNote = useCallback(async () => {
    // File into the CURRENT context: the route's notebook → the open note's notebook →
    // the last-used notebook → the first one (fix: Ctrl+N used to always hit notebooks[0]).
    const notebookId = resolveFilingNotebook(params.notebookId, notebooks);
    if (!notebookId) {
      toast('Create a notebook first', 'error');
      return;
    }
    try {
      const { note } = await api.createNote({ notebookId });
      const nb = notebooks.find((n) => n.id === notebookId);
      if (nb) toast(`Note created in ${nb.emoji} ${nb.name}`, 'ok');
      navigate(`/note/${note.id}`);
    } catch (e) {
      toast(errorMessage(e, 'Could not create note'), 'error');
    }
  }, [params.notebookId, notebooks, navigate]);

  // Same filing rules as a new note - a canvas IS a note, so it belongs in the
  // notebook you are currently working in rather than a special home of its own.
  const handleNewCanvas = useCallback(async () => {
    const notebookId = resolveFilingNotebook(params.notebookId, notebooks);
    if (!notebookId) {
      toast('Create a notebook first', 'error');
      return;
    }
    try {
      const { note } = await api.createNote({ notebookId, kind: 'canvas', title: 'Untitled canvas' });
      navigate(`/note/${note.id}`);
    } catch (e) {
      toast(errorMessage(e, 'Could not create canvas'), 'error');
    }
  }, [params.notebookId, notebooks, navigate]);

  useShortcuts({
    onQuickSwitcher: () => setQuickSwitcherOpen((o) => !o),
    onNewNote: handleNewNote,
    onFocusSearch: () => setQuickSwitcherOpen(true),
    onToggleSidebar: () => setCollapsed((c) => !c),
    onCommandPalette: () => setCommandPaletteOpen((o) => !o),
    onShortcutsHelp: () => setShortcutsOpen((o) => !o),
  });

  return (
    <>
      {/* First tab stop on every authenticated page: the sidebar's notebook list can
          run to dozens of links, and without this a keyboard user tabs through all of
          them before reaching the content on every navigation. */}
      <a className="folio-skip-link" href="#folio-main">
        Skip to content
      </a>

      {/* A <header> rather than a <div>: the mobile topbar sits outside the sidebar
          <nav> and outside <main>, so as a plain div its wordmark was page content
          belonging to no landmark - axe's `region` rule, reproducible at 390px with
          nothing else on screen. */}
      <header className="app-topbar">
        <button
          type="button"
          className="icon-btn"
          aria-label="Open menu"
          aria-expanded={mobileOpen}
          aria-controls="folio-sidebar-drawer"
          // On a phone the sidebar is off-canvas, so the tour's notebook step points
          // at the control that reveals it rather than at a hidden element.
          data-tour="mobile-menu"
          onClick={() => setMobileOpen(true)}
        >
          <Icon name="menu" size={18} />
        </button>
        <div className="app-topbar__brand">
          {/* Same drawn monogram as the sidebar - the phone header was still showing the
              old 📓 emoji, so the two chromes disagreed about what the product looks like. */}
          <span className="sidebar__brand-mark" aria-hidden="true">U</span>
          <span>Unote</span>
        </div>
        <div className="app-topbar__spacer" />
        <button type="button" className="icon-btn" aria-label="Search notes" onClick={() => setQuickSwitcherOpen(true)}>
          <Icon name="search" size={17} />
        </button>
      </header>

      <div
        className={`app-scrim${mobileOpen ? ' is-visible' : ''}`}
        aria-hidden="true"
        onClick={() => setMobileOpen(false)}
      />

      <div className="app-shell">
        <div
          ref={sidebarWrapRef}
          id="folio-sidebar-drawer"
          className="app-sidebar-wrap"
          data-collapsed={collapsed}
          data-mobile-open={mobileOpen}
          // On mobile this is a modal drawer over the content and is announced as one.
          // On desktop it is permanent page furniture, so it must NOT claim dialog
          // semantics - it is just the navigation region.
          role={isMobile ? 'dialog' : undefined}
          aria-modal={isMobile && mobileOpen ? true : undefined}
          aria-label={isMobile ? 'Main navigation' : undefined}
          // Closed-state drawer is fully inert on mobile: invisible controls must not be
          // reachable by Tab or assistive tech (visibility is also gated in shell.css).
          inert={isMobile && !mobileOpen ? true : undefined}
        >
          <Sidebar
            onCollapse={() => setCollapsed(true)}
            onCloseMobile={() => setMobileOpen(false)}
            onOpenSearch={() => setQuickSwitcherOpen(true)}
            onNewNote={handleNewNote}
            onNewCanvas={handleNewCanvas}
            currentNotebookId={params.notebookId}
            qrOpen={qrOpen}
            onOpenQr={() => setQrOpen(true)}
            onCloseQr={() => setQrOpen(false)}
            onOpenCommandPalette={() => setCommandPaletteOpen(true)}
          />
        </div>

        {collapsed && !isMobile && (
          <Tooltip content={<>Expand sidebar <kbd>⌘\</kbd></>} placement="right">
            <button
              type="button"
              className="icon-btn app-expand-btn"
              aria-label="Expand sidebar"
              onClick={() => setCollapsed(false)}
            >
              <Icon name="chevron-right" size={15} />
            </button>
          </Tooltip>
        )}

        {/* The content column: session-wide chrome, the tab strip, then the pages.
            A flex column that does not itself scroll - each tab pane owns its own
            scrolling, which is what carries a scroll position across a switch and what
            stops the strip and the note's sticky action bar fighting over `top: 0`. */}
        <div className="app-content">
          {/* Above the tabs, not inside them: both of these are true of the whole session
              rather than of one open page, and a guest must see the banner on every route
              including the editor. Each renders nothing when it has nothing to say. */}
          <GuestBanner />
          <ConnectionStatus />

          {/* OUTSIDE <main>, deliberately. The strip chooses which document you are
              looking at, which makes it navigation chrome rather than the document - and
              <main> is supposed to be the dominant CONTENT. Keeping it inside also made
              every tab's label and close button part of <main> for anything querying by
              role, which is not a theoretical problem: an e2e spec looking for the
              notebook page's "Import" button found the close button of a tab whose
              notebook was named "E2E Import Transcript Notebook", clicked it, and closed
              the tab it was trying to use. */}
          <TabStrip />

          <main className="app-main" id="folio-main" tabIndex={-1}>
            <TabHost />
          </main>
        </div>
      </div>

      <SyncRunner />
      <Toaster />
      <QuickSwitcher
        open={quickSwitcherOpen}
        onClose={() => setQuickSwitcherOpen(false)}
        currentNotebookId={params.notebookId}
      />
      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        onToggleSidebar={() => setCollapsed((c) => !c)}
        onOpenPhoneCapture={() => setQrOpen(true)}
      />
      <ImportModalHost />
      <ImportWizardHost />
      <OnboardingHost shortcutsOpen={shortcutsOpen} onShortcutsChange={setShortcutsOpen} />
    </>
  );
}

function ImportModalHost() {
  const [state, setState] = useState<{ open: boolean } & OpenImportModalArgs>({ open: false });

  useEffect(() => _subscribeImportModal((args) => setState({ open: true, ...args })), []);

  return (
    <ImportModal
      open={state.open}
      onClose={() => setState((s) => ({ ...s, open: false }))}
      notebookId={state.notebookId}
      noteId={state.noteId}
      defaultKind={state.defaultKind}
    />
  );
}
