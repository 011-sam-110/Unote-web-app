import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTabParams } from '../features/tabs/tabLocation';
import { api } from '../lib/api';
import type { NoteLite } from '../lib/types';
import { errorMessage, plural } from '../lib/format';
import NoteCard from '../components/NoteCard';
import EmptyState from '../components/EmptyState';
import Skeleton from '../components/Skeleton';
import Icon from '../components/Icon';
import Tooltip from '../components/Tooltip';
import EmojiPicker from '../components/EmojiPicker';
import ContextMenu, { menuItem, menuDivider, type MenuEntry } from '../components/ContextMenu';
import ConfirmDialog from '../components/ConfirmDialog';
import { useNotebooks } from '../components/NotebooksContext';
import { toast } from '../components/Toast';
import { openImportModal } from '../components/importModalBus';
import TemplatePicker from '../features/templates/TemplatePicker';
import { deriveContentText } from '../features/templates/deriveContentText';
import { saveNoteAsTemplate } from '../features/templates/saveAsTemplate';
import type { Template } from '../lib/types';

type Sort = 'updated' | 'created' | 'title';

export default function NotebookPage() {
  // Not useParams - see features/tabs/tabLocation.tsx. Several pages are mounted at
  // once and the router answers for the URL, which belongs to the visible tab.
  const { notebookId } = useTabParams<{ notebookId: string }>('/notebook/:notebookId');
  const navigate = useNavigate();
  const { notebooks, loading: notebooksLoading, updateNotebook } = useNotebooks();
  const notebook = notebooks.find((n) => n.id === notebookId);

  const [sort, setSort] = useState<Sort>('updated');
  const [activeNotes, setActiveNotes] = useState<NoteLite[] | null>(null);
  const [archivedNotes, setArchivedNotes] = useState<NoteLite[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<NoteLite | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const load = useCallback(() => {
    if (!notebookId) return;
    setLoading(true);
    setError(null);
    Promise.all([
      api.notes({ notebookId, archived: false, sort, limit: 200 }),
      api.notes({ notebookId, archived: true, sort, limit: 200 }),
    ])
      .then(([active, archived]) => {
        setActiveNotes(active.notes);
        setArchivedNotes(archived.notes);
      })
      .catch((e) => setError(errorMessage(e, 'Could not load notes')))
      .finally(() => setLoading(false));
  }, [notebookId, sort]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    setSelectedTag(null);
    setArchivedOpen(false);
  }, [notebookId]);

  const tagCounts = useMemo(() => {
    const m = new Map<string, number>();
    (activeNotes ?? []).forEach((n) => n.tags.forEach((t) => m.set(t, (m.get(t) ?? 0) + 1)));
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [activeNotes]);

  const filteredActive = useMemo(() => {
    if (!activeNotes) return [];
    if (!selectedTag) return activeNotes;
    return activeNotes.filter((n) => n.tags.includes(selectedTag));
  }, [activeNotes, selectedTag]);

  async function createNewNote() {
    if (!notebookId) return;
    try {
      const { note } = await api.createNote({ notebookId });
      navigate(`/note/${note.id}`);
    } catch (e) {
      toast(errorMessage(e, 'Could not create note'), 'error');
    }
  }

  /** A canvas is a note with kind='canvas'; it files into this notebook and shows
   *  in these same lists, just with a board instead of an editor behind it. */
  async function createNewCanvas() {
    if (!notebookId) return;
    try {
      const { note } = await api.createNote({ notebookId, kind: 'canvas', title: 'Untitled canvas' });
      navigate(`/note/${note.id}`);
    } catch (e) {
      toast(errorMessage(e, 'Could not create canvas'), 'error');
    }
  }

  // Split-button chevron: pick a template (or "Blank note", which is just createNewNote).
  async function createNoteFromTemplate(template: Template | null) {
    if (!notebookId) return;
    setPickerOpen(false);
    if (!template) {
      await createNewNote();
      return;
    }
    try {
      const contentText = deriveContentText(template.contentJson);
      const { note } = await api.createNote({ notebookId, contentJson: template.contentJson, contentText });
      navigate(`/note/${note.id}`);
    } catch (e) {
      toast(errorMessage(e, 'Could not create note'), 'error');
    }
  }

  async function handleSaveAsTemplate(note: NoteLite) {
    try {
      const { note: full } = await api.note(note.id);
      saveNoteAsTemplate(full);
    } catch (e) {
      toast(errorMessage(e, 'Could not load note'), 'error');
    }
  }

  async function togglePin(note: NoteLite) {
    const flip = (list: NoteLite[] | null) =>
      list ? list.map((n) => (n.id === note.id ? { ...n, pinned: !n.pinned } : n)) : list;
    setActiveNotes(flip);
    setArchivedNotes(flip);
    try {
      await api.updateNote(note.id, { pinned: !note.pinned });
    } catch (e) {
      setActiveNotes(flip);
      setArchivedNotes(flip);
      toast(errorMessage(e, 'Could not update pin'), 'error');
    }
  }

  async function duplicateNote(note: NoteLite) {
    try {
      const { note: full } = await api.note(note.id);
      await api.createNote({
        notebookId: full.notebookId,
        title: `${full.title || 'Untitled'} (copy)`,
        contentJson: full.contentJson,
        contentText: full.contentText,
        tags: full.tags,
      });
      toast('Note duplicated', 'ok');
      load();
    } catch (e) {
      toast(errorMessage(e, 'Could not duplicate note'), 'error');
    }
  }

  async function moveNote(note: NoteLite, targetNotebookId: string) {
    try {
      await api.updateNote(note.id, { notebookId: targetNotebookId });
      toast('Note moved', 'ok');
      setActiveNotes((prev) => (prev ? prev.filter((n) => n.id !== note.id) : prev));
      setArchivedNotes((prev) => (prev ? prev.filter((n) => n.id !== note.id) : prev));
    } catch (e) {
      toast(errorMessage(e, 'Could not move note'), 'error');
    }
  }

  async function setArchived(note: NoteLite, archived: boolean) {
    try {
      await api.updateNote(note.id, { archived });
      toast(archived ? 'Note archived' : 'Note restored', 'ok');
      load();
    } catch (e) {
      toast(errorMessage(e, archived ? 'Could not archive note' : 'Could not restore note'), 'error');
    }
  }

  async function confirmDeleteNote() {
    if (!deleteTarget) return;
    const deletedId = deleteTarget.id;
    const deletedTitle = deleteTarget.title || 'Untitled';
    setDeleting(true);
    try {
      await api.deleteNote(deletedId);
      setActiveNotes((prev) => (prev ? prev.filter((n) => n.id !== deletedId) : prev));
      setArchivedNotes((prev) => (prev ? prev.filter((n) => n.id !== deletedId) : prev));
      setDeleteTarget(null);
      // Soft-delete: offer a 10s Undo that restores the note in place.
      toast(`Deleted "${deletedTitle}"`, 'ok', {
        durationMs: 10_000,
        action: {
          label: 'Undo',
          onClick: () => {
            api
              .undeleteNote(deletedId)
              .then(() => {
                toast('Note restored', 'ok');
                load();
              })
              .catch((e) => toast(errorMessage(e, 'Could not restore note'), 'error'));
          },
        },
      });
    } catch (e) {
      toast(errorMessage(e, 'Could not delete note'), 'error');
    } finally {
      setDeleting(false);
    }
  }

  async function commitTitle(value: string) {
    const v = value.trim();
    if (!notebook || !v || v === notebook.name) return;
    try {
      await updateNotebook(notebook.id, { name: v });
    } catch (e) {
      toast(errorMessage(e, 'Could not rename notebook'), 'error');
    }
  }

  function renderRow(note: NoteLite, isArchived: boolean) {
    const otherNotebooks = notebooks.filter((n) => n.id !== note.notebookId && !n.archived);
    const items: MenuEntry[] = [
      menuItem({ key: 'pin', label: note.pinned ? 'Unpin' : 'Pin', icon: 'pin', onSelect: () => togglePin(note) }),
      menuItem({ key: 'duplicate', label: 'Duplicate', icon: 'copy', onSelect: () => duplicateNote(note) }),
      menuItem({ key: 'save-template', label: 'Save as template', icon: 'file-text', onSelect: () => handleSaveAsTemplate(note) }),
      menuItem({
        key: 'move',
        label: 'Move to notebook',
        icon: 'move',
        submenu:
          otherNotebooks.length > 0
            ? otherNotebooks.map((nb) =>
                menuItem({ key: nb.id, label: `${nb.emoji} ${nb.name}`, onSelect: () => moveNote(note, nb.id) }),
              )
            : [menuItem({ key: 'none', label: 'No other notebooks', disabled: true })],
      }),
      menuDivider('d1'),
      isArchived
        ? menuItem({ key: 'unarchive', label: 'Restore', icon: 'unarchive', onSelect: () => setArchived(note, false) })
        : menuItem({ key: 'archive', label: 'Archive', icon: 'archive', onSelect: () => setArchived(note, true) }),
      menuItem({ key: 'delete', label: 'Delete…', icon: 'trash', danger: true, onSelect: () => setDeleteTarget(note) }),
    ];
    return (
      <NoteCard
        key={note.id}
        note={note}
        compact
        testId="note-row"
        href={`/note/${note.id}`}
        controls={
          <>
            <Tooltip content={note.pinned ? 'Unpin' : 'Pin'}>
              <button
                type="button"
                className={`icon-btn${note.pinned ? ' is-active' : ''}`}
                aria-label={note.pinned ? 'Unpin note' : 'Pin note'}
                onClick={() => togglePin(note)}
              >
                <Icon name={note.pinned ? 'pin-filled' : 'pin'} size={14} />
              </button>
            </Tooltip>
            <ContextMenu
              trigger={<Icon name="more" size={14} />}
              ariaLabel={`${note.title || 'Untitled'} options`}
              align="end"
              items={items}
            />
          </>
        }
      />
    );
  }

  if (!notebook && notebooksLoading) {
    return (
      <div className="nb-page">
        <Skeleton lines={3} />
      </div>
    );
  }

  if (!notebook) {
    return (
      <div className="nb-page">
        <EmptyState
          icon="🔍"
          title="Notebook not found"
          hint="It may have been deleted, or the link is out of date."
          action={
            <Link to="/" className="btn btn-primary">
              Go home
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="nb-page">
      <div className="nb-page__header">
        <div className="nb-page__title-row">
          <EmojiPicker
            value={notebook.emoji}
            size={28}
            label="Change notebook emoji"
            onSelect={(emoji) =>
              updateNotebook(notebook.id, { emoji }).catch((e) => toast(errorMessage(e, 'Could not update emoji'), 'error'))
            }
          />
          <div style={{ minWidth: 0, flex: 1 }}>
            <input
              key={notebook.id}
              className="nb-page__title"
              defaultValue={notebook.name}
              aria-label="Notebook name"
              onBlur={(e) => commitTitle(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  e.currentTarget.blur();
                } else if (e.key === 'Escape') {
                  e.currentTarget.value = notebook.name;
                  e.currentTarget.blur();
                }
              }}
            />
            <div className="nb-page__count">{plural(notebook.noteCount, 'note')}</div>
          </div>
        </div>
        <div className="nb-page__actions">
          <ContextMenu
            trigger={<>Import <Icon name="chevron-down" size={12} /></>}
            triggerClassName="btn btn-secondary"
            ariaLabel="Import notes"
            items={[
              menuItem({
                key: 'photo',
                label: 'Photo of notes',
                icon: 'upload',
                onSelect: () => openImportModal({ notebookId: notebook.id, defaultKind: 'photo' }),
              }),
              menuItem({
                key: 'slides',
                label: 'Slides PDF',
                icon: 'upload',
                onSelect: () => openImportModal({ notebookId: notebook.id, defaultKind: 'slides' }),
              }),
              menuItem({
                key: 'transcript',
                label: 'Transcript',
                icon: 'upload',
                onSelect: () => openImportModal({ notebookId: notebook.id, defaultKind: 'transcript' }),
              }),
            ]}
          />
          <button type="button" className="btn btn-secondary" onClick={createNewCanvas}>
            <Icon name="canvas" size={14} />
            New canvas
          </button>
          <div className="btn-split">
            <button type="button" className="btn btn-primary btn-split__main" onClick={createNewNote}>
              <Icon name="plus" size={14} />
              New note
            </button>
            <Tooltip content="Choose a template">
              <button
                type="button"
                className="btn btn-primary btn-split__chevron"
                aria-label="New note from template"
                onClick={() => setPickerOpen(true)}
              >
                <Icon name="chevron-down" size={13} />
              </button>
            </Tooltip>
          </div>
        </div>
      </div>

      <div className="nb-page__toolbar">
        <div className="nb-page__filters">
          {tagCounts.length > 0 && (
            <>
              <button type="button" className={`chip${!selectedTag ? ' active' : ''}`} onClick={() => setSelectedTag(null)}>
                All
              </button>
              {tagCounts.map(([tag, count]) => (
                <button
                  key={tag}
                  type="button"
                  className={`chip${selectedTag === tag ? ' active' : ''}`}
                  onClick={() => setSelectedTag((t) => (t === tag ? null : tag))}
                >
                  <span className="chip__tag">#{tag}</span> <span style={{ opacity: 0.6 }}>{count}</span>
                </button>
              ))}
            </>
          )}
        </div>
        <div className="nb-page__sort">
          <label className="field-label" htmlFor="nb-sort" style={{ margin: 0 }}>
            Sort
          </label>
          <select id="nb-sort" className="select-input" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="updated">Last updated</option>
            <option value="created">Date created</option>
            <option value="title">Title</option>
          </select>
        </div>
      </div>

      {loading ? (
        <div className="note-list">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} style={{ border: '1px solid var(--line)', borderRadius: 'var(--radius-lg)', padding: '12px 14px' }}>
              <Skeleton lines={2} />
            </div>
          ))}
        </div>
      ) : error ? (
        <EmptyState
          icon="⚠️"
          title="Couldn't load notes"
          hint={error}
          action={
            <button type="button" className="btn btn-primary" onClick={load}>
              Retry
            </button>
          }
        />
      ) : filteredActive.length === 0 ? (
        activeNotes && activeNotes.length > 0 ? (
          <EmptyState
            icon="🔎"
            title="No notes match this tag"
            hint="Try a different tag, or clear the filter."
            action={
              <button type="button" className="btn btn-secondary" onClick={() => setSelectedTag(null)}>
                Clear filter
              </button>
            }
          />
        ) : (
          <EmptyState
            icon="📝"
            title={`No notes yet in ${notebook.name}`}
            hint="New note starts you writing right away, or import a photo of your lecture notes."
            action={
              <button type="button" className="btn btn-primary" onClick={createNewNote}>
                <Icon name="plus" size={14} />
                New note
              </button>
            }
          />
        )
      ) : (
        <div className="note-list">{filteredActive.map((n) => renderRow(n, false))}</div>
      )}

      {!loading && !error && archivedNotes && archivedNotes.length > 0 && (
        <div className="nb-page__archived">
          <button
            type="button"
            className={`nb-page__archived-toggle${archivedOpen ? ' is-open' : ''}`}
            onClick={() => setArchivedOpen((o) => !o)}
            aria-expanded={archivedOpen}
          >
            <Icon name="chevron-right" size={13} />
            <span>Archived ({archivedNotes.length})</span>
          </button>
          {archivedOpen && <div className="nb-page__archived-list">{archivedNotes.map((n) => renderRow(n, true))}</div>}
        </div>
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        title={`Delete "${deleteTarget?.title || 'Untitled'}"?`}
        message="The note is kept in the trash for 30 days (you can Undo right after deleting), then purged along with its version history."
        confirmLabel="Delete note"
        danger
        loading={deleting}
        onConfirm={confirmDeleteNote}
        onCancel={() => setDeleteTarget(null)}
      />

      <TemplatePicker open={pickerOpen} onClose={() => setPickerOpen(false)} onPick={createNoteFromTemplate} />
    </div>
  );
}
