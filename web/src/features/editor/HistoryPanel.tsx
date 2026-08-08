// Right drawer: version list grouped by day (cause icons), read-only preview, restore,
// and a "Snapshot now" action with an optional label.
import { useCallback, useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { api } from '../../lib/api';
import type { NoteVersion, NoteVersionMeta } from '../../lib/types';
import { relativeTime, formatDate } from '../../lib/format';
import { toast } from '../../components/Toast';
import Spinner from '../../components/Spinner';
import Icon, { type IconName } from '../../components/Icon';
import { useDialogFocus } from '../../components/useDialogFocus';
import { createFolioExtensions } from './buildExtensions';
import { useDrawerInset } from './drawerInset';
import './editor.css';
import './notePage.css';

/** Matches `.folio-history-panel`'s width in notePage.css - it is also the space the note
 *  gives up while this drawer is open, so the two have to agree. */
const WIDTH = 400;

// Vector icons for interactive chrome (Icon.tsx rule) - emoji stays reserved for content.
const CAUSE_ICON: Record<string, IconName> = { autosave: 'pencil', manual: 'pin', ai: 'sparkles', restore: 'rotate-ccw', import: 'download' };
const CAUSE_LABEL: Record<string, string> = { autosave: 'Autosave', manual: 'Snapshot', ai: 'AI edit', restore: 'Restore', import: 'Import' };

function CauseIcon({ cause }: { cause: string }) {
  const name = CAUSE_ICON[cause];
  return name ? <Icon name={name} size={14} /> : <span aria-hidden="true">•</span>;
}

export interface HistoryPanelProps {
  noteId: string;
  open: boolean;
  onClose: () => void;
  onRestored: () => void;
}

export default function HistoryPanel({ noteId, open, onClose, onRestored }: HistoryPanelProps) {
  const [versions, setVersions] = useState<NoteVersionMeta[] | null>(null);
  const [active, setActive] = useState<NoteVersion | null>(null);
  const [loadingId, setLoadingId] = useState<number | null>(null);
  const [snapshotLabel, setSnapshotLabel] = useState('');
  const [snapshotting, setSnapshotting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const previewBox = useRef<Editor | null>(null);

  const load = useCallback(() => {
    api
      .versions(noteId)
      .then((r) => setVersions(r.versions))
      .catch(() => toast('Could not load history', 'error'));
  }, [noteId]);

  useEffect(() => {
    if (open) {
      load();
      setActive(null);
    }
  }, [open, load]);

  const previewExtensions = useState(() =>
    createFolioExtensions({ editable: false, editorBox: previewBox, getNotebookId: () => '' }),
  )[0];

  const previewEditor = useEditor(
    { extensions: previewExtensions, content: (active?.contentJson as Record<string, unknown>) ?? '', editable: false },
    [active?.id],
  );

  async function openVersion(v: NoteVersionMeta) {
    setLoadingId(v.id);
    try {
      const { version } = await api.version(noteId, v.id);
      setActive(version);
    } catch {
      toast('Could not load version', 'error');
    } finally {
      setLoadingId(null);
    }
  }

  async function doSnapshot() {
    setSnapshotting(true);
    try {
      await api.snapshot(noteId, snapshotLabel.trim() || undefined);
      setSnapshotLabel('');
      toast('Snapshot saved', 'ok');
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Snapshot failed', 'error');
    } finally {
      setSnapshotting(false);
    }
  }

  async function doRestore(v: NoteVersion) {
    if (!window.confirm(`Restore "${v.title || 'Untitled'}" from ${formatDate(v.createdAt)}? The current version will be kept in history.`)) return;
    setRestoring(true);
    try {
      await api.restore(noteId, v.id);
      toast('Note restored', 'ok');
      onRestored();
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Restore failed', 'error');
    } finally {
      setRestoring(false);
    }
  }

  const panelRef = useRef<HTMLElement | null>(null);
  // Non-modal drawer: the note behind stays readable, so Tab is NOT trapped. But
  // focus must move in, otherwise the Escape handler below never fires (focus is
  // still on the trigger outside the panel) and the drawer is a dead end.
  useDialogFocus(open, panelRef, onClose, { trap: false });

  // Push the note out from under the drawer rather than covering it.
  useDrawerInset('history', WIDTH, open);

  if (!open) return null;

  const grouped = groupByDay(versions ?? []);

  return (
    <div className="folio-history-overlay">
      <aside
        ref={panelRef}
        className="folio-history-panel"
        role="dialog"
        tabIndex={-1}
        aria-label="Version history"
        data-testid="history-drawer"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        <div className="folio-history-head">
          <h3>History</h3>
          <button type="button" className="folio-btn-icon" onClick={onClose} aria-label="Close history">
            ✕
          </button>
        </div>

        <div className="folio-history-snapshot">
          <input
            aria-label="Snapshot label"
            value={snapshotLabel}
            onChange={(e) => setSnapshotLabel(e.target.value)}
            placeholder="Label (optional)"
            maxLength={80}
          />
          <button type="button" className="folio-btn-primary" disabled={snapshotting} onClick={doSnapshot}>
            {snapshotting ? <Spinner size={14} /> : 'Snapshot now'}
          </button>
        </div>

        {!active ? (
          <div className="folio-history-list">
            {versions == null && <Spinner />}
            {versions?.length === 0 && (
              <div className="folio-history-empty">No history yet. Edits are snapshotted automatically as you go.</div>
            )}
            {grouped.map(([day, items]) => (
              <div key={day} className="folio-history-day">
                <div className="folio-history-day-label">{day}</div>
                {items.map((v) => (
                  <button key={v.id} type="button" className="folio-history-row" data-testid="history-version-item" onClick={() => openVersion(v)}>
                    <span className="folio-history-cause" title={CAUSE_LABEL[v.cause] ?? v.cause}>
                      <CauseIcon cause={v.cause} />
                    </span>
                    <span className="folio-history-row-main">
                      <span className="folio-history-row-title">{v.label || v.title || 'Untitled'}</span>
                      <span className="folio-history-row-meta">
                        {relativeTime(v.createdAt)} · {v.wordCount} words
                      </span>
                    </span>
                    {loadingId === v.id && <Spinner size={14} />}
                  </button>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <div className="folio-history-preview">
            <button type="button" className="folio-history-back" onClick={() => setActive(null)}>
              ← Back to list
            </button>
            <div className="folio-history-preview-meta">
              {formatDate(active.createdAt)} · <CauseIcon cause={active.cause} /> {CAUSE_LABEL[active.cause] ?? active.cause}
              {active.label ? ` · ${active.label}` : ''}
            </div>
            <div className="folio-history-preview-title">{active.title || 'Untitled'}</div>
            <div className="folio-editor folio-history-readonly">
              <EditorContent editor={previewEditor} />
            </div>
            <button type="button" className="folio-btn-primary folio-history-restore" disabled={restoring} onClick={() => doRestore(active)}>
              {restoring ? <Spinner size={14} /> : 'Restore this version'}
            </button>
          </div>
        )}
      </aside>
    </div>
  );
}

function groupByDay(versions: NoteVersionMeta[]): Array<[string, NoteVersionMeta[]]> {
  const map = new Map<string, NoteVersionMeta[]>();
  for (const v of versions) {
    const day = formatDate(v.createdAt);
    if (!map.has(day)) map.set(day, []);
    map.get(day)!.push(v);
  }
  return Array.from(map.entries());
}
