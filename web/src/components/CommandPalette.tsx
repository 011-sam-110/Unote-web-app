// palette-nav - Ctrl/Cmd+P command palette. A centered panel visually sibling
// to QuickSwitcher (Ctrl/Cmd+K), but clearly action-flavored: where the quick
// switcher finds NOTES, this finds THINGS TO DO - navigation, creation, view
// toggles and study shortcuts - grouped by section when browsing with an
// empty query, fuzzy-ranked flat once the user starts typing.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useCommands, matchCommand, SECTION_ORDER, type Command, type CommandContext } from '../lib/commands';
import { paletteDoc } from './paletteCatalog';
import { useNotebooks } from './NotebooksContext';
import { useTheme } from '../lib/theme';
import { api } from '../lib/api';
import { errorMessage, plural } from '../lib/format';
import { resolveFilingNotebook } from '../lib/notebookContext';
import { openImportModal } from './importModalBus';
import { openImportWizard } from '../features/import/importWizardBus';
import { flushActiveNote } from '../features/editor/autosaveBus';
import { useTabsOptional } from '../features/tabs/TabsContext';
import { toast } from './Toast';
import Icon from './Icon';
import Spinner from './Spinner';
import HashGlyph from './HashGlyph';
import { useDialogFocus } from './useDialogFocus';

type Row = { type: 'header'; label: string } | { type: 'cmd'; cmd: Command; index: number };

export default function CommandPalette({
  open,
  onClose,
  onToggleSidebar,
  onOpenPhoneCapture,
}: {
  open: boolean;
  onClose: () => void;
  /** Same callback App.tsx wires to Ctrl/Cmd+\ - flips the sidebar collapse state. */
  onToggleSidebar: () => void;
  /** Opens the sidebar's phone-capture QR modal (state lives in App.tsx). */
  onOpenPhoneCapture: () => void;
}) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [mode, setMode] = useState<'list' | 'new-notebook'>('list');
  const [notebookName, setNotebookName] = useState('');
  const [busy, setBusy] = useState(false);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  // Merges :notebookId / :noteId from whichever child route is currently
  // matched, same trick App.tsx's own comment documents for useParams here.
  const params = useParams<{ noteId?: string; notebookId?: string }>();
  const { notebooks, createNotebook } = useNotebooks();
  const [theme] = useTheme();
  // Optional: the palette also renders for a guest and inside the shell only, but it is
  // cheaper to tolerate its absence than to assert a provider it does not own.
  const tabs = useTabsOptional();
  const staticCommands = useCommands();

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
    setMode('list');
    setNotebookName('');
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // Refocus the (re-mounted) input whenever we switch between the command
  // list and the inline "new notebook" prompt.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [mode, open]);

  const onNotebookOrNoteRoute = /^\/(notebook|note)\//.test(location.pathname);
  // Same resolution order New note / Import already use: route param → open
  // note's notebook (module state NotePage publishes) → last used → first.
  const filingNotebookId = resolveFilingNotebook(params.notebookId, notebooks);
  const filingNotebook = notebooks.find((n) => n.id === filingNotebookId);
  // "Study this notebook" only makes sense as a command while genuinely on a
  // notebook/note route - elsewhere the fallback chain would resolve to
  // "some" notebook and mislabel a command that isn't actually contextual.
  const contextNotebook = onNotebookOrNoteRoute ? filingNotebook : undefined;
  const noteId = params.noteId;

  const dynamicCommands = useMemo<Command[]>(() => {
    const cmds: Command[] = [];

    for (const nb of notebooks.filter((n) => !n.archived)) {
      cmds.push({
        id: `nav-notebook-${nb.id}`,
        title: `Go to ${nb.emoji} ${nb.name}`,
        section: 'Navigate',
        hint: plural(nb.noteCount, 'note'),
        keywords: [nb.name],
        emoji: nb.emoji,
        run: (ctx) => ctx.navigate(`/notebook/${nb.id}`),
      });
    }

    cmds.push({
      ...paletteDoc('create-note'),
      // Overrides the catalog's static hint: this one is computed from the filing
      // notebook, which is component state paletteDoc can't see.
      hint: filingNotebook ? `Filed in ${filingNotebook.emoji} ${filingNotebook.name}` : 'Filed in your last-used notebook',
      keywords: ['note', 'create'],
      icon: 'plus',
      run: async (ctx) => {
        const notebookId = resolveFilingNotebook(params.notebookId, notebooks);
        if (!notebookId) {
          toast('Create a notebook first', 'error');
          return;
        }
        const { note } = await api.createNote({ notebookId });
        const nb = notebooks.find((n) => n.id === notebookId);
        toast(nb ? `Note created in ${nb.emoji} ${nb.name}` : 'Note created', 'ok');
        ctx.navigate(`/note/${note.id}`);
      },
    });

    cmds.push({
      ...paletteDoc('create-canvas'),
      keywords: ['canvas', 'board', 'whiteboard', 'draw', 'sketch', 'mindmap'],
      icon: 'canvas',
      run: async (ctx) => {
        const notebookId = resolveFilingNotebook(params.notebookId, notebooks);
        if (!notebookId) {
          toast('Create a notebook first', 'error');
          return;
        }
        const { note } = await api.createNote({ notebookId, kind: 'canvas', title: 'Untitled canvas' });
        ctx.navigate(`/note/${note.id}`);
      },
    });

    cmds.push({
      ...paletteDoc('create-notebook'),
      keywords: ['notebook', 'create', 'module'],
      icon: 'folder-plus',
      run: () => setMode('new-notebook'),
    });

    cmds.push(
      {
        ...paletteDoc('create-import-photo'),
        keywords: ['ocr', 'camera', 'scan', 'photo'],
        icon: 'camera',
        run: () => openImportModal({ notebookId: filingNotebookId, defaultKind: 'photo' }),
      },
      {
        ...paletteDoc('create-import-slides'),
        keywords: ['pdf', 'pptx', 'lecture', 'slides'],
        icon: 'upload',
        run: () => openImportModal({ notebookId: filingNotebookId, defaultKind: 'slides' }),
      },
      {
        ...paletteDoc('create-import-transcript'),
        keywords: ['transcript', 'docx', 'essay'],
        icon: 'file-text',
        run: () => openImportModal({ notebookId: filingNotebookId, defaultKind: 'transcript' }),
      },
      {
        ...paletteDoc('import-old-notes'),
        keywords: ['import', 'bulk', 'folder', 'obsidian', 'notion', 'migrate'],
        icon: 'upload',
        run: () => openImportWizard(),
      },
      {
        ...paletteDoc('create-phone-capture'),
        keywords: ['qr', 'mobile', 'phone', 'camera'],
        icon: 'phone',
        run: () => onOpenPhoneCapture(),
      },
    );

    cmds.push({
      ...paletteDoc('view-sidebar'),
      keywords: ['collapse', 'expand', 'sidebar'],
      icon: 'menu',
      run: () => onToggleSidebar(),
    });

    if (tabs) {
      cmds.push({
        ...paletteDoc('tab-close'),
        keywords: ['tab', 'close', 'shut'],
        icon: 'x',
        run: () => tabs.close(tabs.activeId),
      });
      // Offered only when there is a second tab to move to or close. A palette listing
      // three commands that do nothing is the same failure as a cheatsheet listing a key
      // that does not fire.
      if (tabs.tabs.length > 1) {
        cmds.push(
          {
            ...paletteDoc('tab-close-others'),
            keywords: ['tab', 'close', 'only', 'tidy'],
            icon: 'x',
            run: () => tabs.closeOthers(tabs.activeId),
          },
          {
            ...paletteDoc('tab-next'),
            keywords: ['tab', 'next', 'switch', 'cycle'],
            icon: 'arrow-right',
            run: () => tabs.stepBy(1),
          },
          {
            ...paletteDoc('tab-prev'),
            keywords: ['tab', 'previous', 'back', 'switch', 'cycle'],
            icon: 'arrow-right',
            run: () => tabs.stepBy(-1),
          },
        );
      }
    }

    if (noteId) {
      cmds.push({
        ...paletteDoc('note-snapshot'),
        keywords: ['version', 'history', 'save'],
        icon: 'copy',
        run: async () => {
          await flushActiveNote();
          await api.snapshot(noteId);
          toast('Snapshot saved', 'ok');
        },
      });
    }

    if (contextNotebook) {
      cmds.push({
        ...paletteDoc('study-notebook'),
        // Overrides the catalog's static hint: this one names the specific notebook
        // being studied, which is component state paletteDoc can't see.
        hint: `Cram ${contextNotebook.emoji} ${contextNotebook.name} only`,
        keywords: ['cram', 'flashcards', 'review'],
        icon: 'layers',
        run: (ctx) => ctx.navigate(`/study?notebookId=${contextNotebook.id}`),
      });
    }

    return cmds;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notebooks, filingNotebookId, filingNotebook, contextNotebook, noteId, tabs, onToggleSidebar, onOpenPhoneCapture]);

  const allCommands = useMemo(() => [...staticCommands, ...dynamicCommands], [staticCommands, dynamicCommands]);
  const q = query.trim();

  // Grouped-by-section rows for browsing (empty query) vs. a flat fuzzy-ranked
  // list once typing starts - same "index space" trick QuickSwitcher uses so
  // ↑↓/Enter can address a row without caring which mode produced it.
  const { rows, flatCommands } = useMemo(() => {
    if (!q) {
      const bySection = new Map<string, Command[]>();
      for (const cmd of allCommands) {
        if (!bySection.has(cmd.section)) bySection.set(cmd.section, []);
        bySection.get(cmd.section)!.push(cmd);
      }
      const sectionNames = [
        ...SECTION_ORDER.filter((s) => bySection.has(s)),
        ...[...bySection.keys()].filter((s) => !SECTION_ORDER.includes(s)).sort(),
      ];
      const builtRows: Row[] = [];
      const flat: Command[] = [];
      for (const section of sectionNames) {
        builtRows.push({ type: 'header', label: section });
        for (const cmd of bySection.get(section)!) {
          builtRows.push({ type: 'cmd', cmd, index: flat.length });
          flat.push(cmd);
        }
      }
      return { rows: builtRows, flatCommands: flat };
    }
    const scored = allCommands
      .map((cmd) => ({ cmd, score: matchCommand(q, cmd) }))
      .filter((x): x is { cmd: Command; score: number } => x.score !== null)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.cmd);
    return {
      rows: scored.map((cmd, index): Row => ({ type: 'cmd', cmd, index })),
      flatCommands: scored,
    };
  }, [allCommands, q]);

  // Makes the role="dialog" claim true: traps Tab, closes on Escape from anywhere,
  // and restores focus to the trigger. `false` because this panel focuses its own
  // search input (handleClose is hoisted, so referencing it here is fine).
  useDialogFocus(open, panelRef, handleClose, { takeInitialFocus: false });

  if (!open) return null;

  function handleClose() {
    onClose();
  }

  const ctx: CommandContext = { navigate };

  function runCommand(cmd: Command) {
    // "New notebook" switches the palette into its inline prompt instead of
    // closing - everything else runs and dismisses immediately.
    if (cmd.id === 'create-notebook') {
      cmd.run(ctx);
      return;
    }
    handleClose();
    Promise.resolve(cmd.run(ctx)).catch((e) => toast(errorMessage(e, 'Command failed'), 'error'));
  }

  async function submitNewNotebook() {
    const name = notebookName.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      const nb = await createNotebook({ name, emoji: '📓' });
      toast('Notebook created', 'ok');
      navigate(`/notebook/${nb.id}`);
      handleClose();
    } catch (e) {
      toast(errorMessage(e, 'Could not create notebook'), 'error');
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (mode === 'new-notebook') {
      if (e.key === 'Escape') {
        e.preventDefault();
        setMode('list');
      } else if (e.key === 'Enter') {
        e.preventDefault();
        submitNewNotebook();
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      handleClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (flatCommands.length > 0) setActiveIndex((i) => Math.min(i + 1, flatCommands.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (flatCommands.length > 0) setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = flatCommands[activeIndex];
      if (cmd) runCommand(cmd);
    }
  }

  function iconFor(cmd: Command): ReactNode {
    if (cmd.id === 'nav-tags') return <HashGlyph size={15} />;
    if (cmd.id === 'view-theme') return <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={15} />;
    if (cmd.emoji) return <span aria-hidden="true">{cmd.emoji}</span>;
    return <Icon name={cmd.icon ?? 'sparkles'} size={15} />;
  }

  function hintFor(cmd: Command): string | undefined {
    if (cmd.id === 'view-theme') return theme === 'dark' ? 'Switch to light' : 'Switch to dark';
    return cmd.hint;
  }

  return createPortal(
    <div
      className="folio-cmdk-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div
        ref={panelRef}
        className="folio-cmdk"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        data-testid="command-palette"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="folio-cmdk__input-row">
          <Icon name={mode === 'new-notebook' ? 'folder-plus' : 'search'} size={16} style={{ color: 'var(--ink-3)', flex: '0 0 auto' }} />
          {mode === 'list' ? (
            <input
              ref={inputRef}
              className="folio-cmdk__input"
              placeholder="Type a command…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search commands"
              autoComplete="off"
              spellCheck={false}
            />
          ) : (
            <input
              ref={inputRef}
              className="folio-cmdk__input"
              placeholder="Notebook name…"
              value={notebookName}
              onChange={(e) => setNotebookName(e.target.value)}
              aria-label="New notebook name"
              autoComplete="off"
              spellCheck={false}
            />
          )}
          {busy && <Spinner size={15} />}
        </div>

        {mode === 'new-notebook' ? (
          <div className="folio-cmdk__prompt-hint">
            Creates 📓 "{notebookName.trim() || '…'}". Change its emoji/color from the sidebar after.
          </div>
        ) : (
          <div className="folio-cmdk__results">
            {rows.length === 0 && <div className="folio-cmdk__empty">No matching commands for "{q}".</div>}
            {rows.map((row) =>
              row.type === 'header' ? (
                <div className="folio-cmdk__section-label" key={`h-${row.label}`}>
                  {row.label}
                </div>
              ) : (
                <div
                  key={row.cmd.id}
                  className={`folio-cmdk__row${row.index === activeIndex ? ' is-active' : ''}`}
                  data-testid="command-palette-item"
                  onMouseEnter={() => setActiveIndex(row.index)}
                  onClick={() => runCommand(row.cmd)}
                >
                  <span className="folio-cmdk__row-icon">{iconFor(row.cmd)}</span>
                  <span className="folio-cmdk__row-main">
                    <span className="folio-cmdk__row-title">{row.cmd.title}</span>
                    {hintFor(row.cmd) && <span className="folio-cmdk__row-hint">{hintFor(row.cmd)}</span>}
                  </span>
                  {row.cmd.shortcut && <kbd className="folio-cmdk__row-shortcut">{row.cmd.shortcut}</kbd>}
                </div>
              ),
            )}
          </div>
        )}

        <div className="folio-cmdk__footer">
          {mode === 'new-notebook' ? (
            <>
              <span>
                <kbd>Enter</kbd> Create
              </span>
              <span>
                <kbd>Esc</kbd> Back
              </span>
            </>
          ) : (
            <>
              <span>
                <kbd>↑</kbd>
                <kbd>↓</kbd> Navigate
              </span>
              <span>
                <kbd>Enter</kbd> Run
              </span>
              <span>
                <kbd>Esc</kbd> Close
              </span>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
