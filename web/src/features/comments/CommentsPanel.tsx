// Right-margin drawer listing every comment on the open note: anchor quote, body,
// resolved toggle, edit/delete, relative time. Clicking a comment scrolls to and flashes
// its marked text in the editor. A comment whose `comment` mark no longer exists in the
// doc (the marked text was deleted, or CommentMark hasn't been wired into the schema yet)
// shows an "orphaned" chip instead of a click-to-scroll affordance.
//
// Mirrors HistoryPanel's non-modal side-drawer shape (own classnames - see comments.css -
// so this stays fully independent of editor-blocks' file).
//
// Unlike HistoryPanel, this component fetches regardless of `open` so the action-bar
// toggle button can show a live unresolved-count badge even while the drawer is closed.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { api } from '../../lib/api';
import type { NoteComment } from '../../lib/types';
import { relativeTime } from '../../lib/format';
import { toast } from '../../components/Toast';
import Icon from '../../components/Icon';
import Spinner from '../../components/Spinner';
import CommentIcon from './CommentIcon';
import { useDialogFocus } from '../../components/useDialogFocus';
import { setCommentsListener } from './commentsBus';
import { useDrawerInset } from '../editor/drawerInset';
import './comments.css';

/** Matches `.folio-comments-panel`'s width in comments.css - it is also the space the note
 *  gives up while this drawer is open, so the two have to agree. */
const WIDTH = 380;

export interface CommentsPanelProps {
  noteId: string;
  open: boolean;
  onClose: () => void;
  editor: Editor | null;
  onUnresolvedCountChange?: (n: number) => void;
}

function collectLiveCommentIds(editor: Editor | null): Set<string> {
  const ids = new Set<string>();
  if (!editor || editor.isDestroyed) return ids;
  editor.state.doc.descendants((node) => {
    node.marks.forEach((m) => {
      if (m.type.name === 'comment' && typeof m.attrs.commentId === 'string' && m.attrs.commentId) {
        ids.add(m.attrs.commentId);
      }
    });
  });
  return ids;
}

/** Removes every span of the `comment` mark carrying this commentId from the live doc,
 *  so deleting a comment also clears its highlight immediately (no dangling mark left
 *  pointing at a comment record that no longer exists). No-op if the schema doesn't have
 *  the mark (defensive - see CommentMark.ts wiring note) or it isn't present in the doc. */
function stripCommentMark(editor: Editor | null, commentId: string): void {
  if (!editor || editor.isDestroyed) return;
  const markType = editor.state.schema.marks.comment;
  if (!markType) return;
  const { state, view } = editor;
  let tr = state.tr;
  let changed = false;
  state.doc.descendants((node, pos) => {
    node.marks.forEach((m) => {
      if (m.type === markType && m.attrs.commentId === commentId) {
        tr = tr.removeMark(pos, pos + node.nodeSize, markType);
        changed = true;
      }
    });
  });
  if (changed) view.dispatch(tr);
}

export default function CommentsPanel({ noteId, open, onClose, editor, onUnresolvedCountChange }: CommentsPanelProps) {
  const [comments, setComments] = useState<NoteComment[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [liveIds, setLiveIds] = useState<Set<string>>(() => new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadError(false);
    api
      .comments(noteId)
      .then((r) => setComments(r.comments))
      .catch(() => setLoadError(true));
  }, [noteId]);

  useEffect(() => {
    load();
  }, [load]);

  // SelectionToolbar (mounted inside FolioEditor, not a file we own) creates comments and
  // has no prop channel to us - it pings this bus instead so a freshly-added comment shows
  // up without waiting for the drawer to be reopened.
  useEffect(() => {
    setCommentsListener(load);
    return () => setCommentsListener(null);
  }, [load]);

  const recomputeLiveIds = useCallback(() => {
    setLiveIds(collectLiveCommentIds(editor));
  }, [editor]);

  useEffect(() => {
    recomputeLiveIds();
    if (!editor) return;
    editor.on('update', recomputeLiveIds);
    return () => {
      editor.off('update', recomputeLiveIds);
    };
  }, [editor, recomputeLiveIds]);

  useEffect(() => {
    if (comments) onUnresolvedCountChange?.(comments.filter((c) => !c.resolved).length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comments]);

  function scrollToComment(id: string) {
    const el = document.querySelector<HTMLElement>(`.folio-prosemirror [data-comment-id="${id}"]`);
    if (!el) {
      toast('That comment’s text is no longer in the note', 'info');
      return;
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('folio-flash');
    window.setTimeout(() => el.classList.remove('folio-flash'), 1200);
  }

  async function toggleResolved(c: NoteComment) {
    const next = !c.resolved;
    setComments((prev) => prev?.map((x) => (x.id === c.id ? { ...x, resolved: next } : x)) ?? prev);
    try {
      await api.updateComment(c.id, { resolved: next });
    } catch {
      toast('Could not update comment', 'error');
      setComments((prev) => prev?.map((x) => (x.id === c.id ? { ...x, resolved: !next } : x)) ?? prev);
    }
  }

  function startEdit(c: NoteComment) {
    setEditingId(c.id);
    setDraft(c.body);
  }

  async function saveEdit(c: NoteComment) {
    const body = draft.trim();
    if (!body) return;
    setBusyId(c.id);
    try {
      const { comment } = await api.updateComment(c.id, { body });
      setComments((prev) => prev?.map((x) => (x.id === c.id ? comment : x)) ?? prev);
      setEditingId(null);
    } catch {
      toast('Could not save comment', 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function remove(c: NoteComment) {
    setBusyId(c.id);
    try {
      await api.deleteComment(c.id);
      setComments((prev) => prev?.filter((x) => x.id !== c.id) ?? prev);
      stripCommentMark(editor, c.id);
    } catch {
      toast('Could not delete comment', 'error');
    } finally {
      setBusyId(null);
    }
  }

  const panelRef = useRef<HTMLElement | null>(null);
  // Non-modal drawer: the note behind stays readable, so Tab is NOT trapped. But
  // focus must move in, otherwise the Escape handler below never fires (focus is
  // still on the trigger outside the panel) and the drawer is a dead end.
  useDialogFocus(open, panelRef, onClose, { trap: false });

  // Push the note out from under the drawer rather than covering it.
  useDrawerInset('comments', WIDTH, open);

  if (!open) return null;

  return (
    <div className="folio-comments-overlay">
      <aside
        ref={panelRef}
        className="folio-comments-panel"
        role="dialog"
        tabIndex={-1}
        aria-label="Comments"
        data-testid="comments-drawer"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        <div className="folio-comments-head">
          <h3>Comments</h3>
          <button type="button" className="folio-btn-icon" onClick={onClose} aria-label="Close comments">
            <Icon name="x" size={15} />
          </button>
        </div>

        {comments == null && !loadError && (
          <div className="folio-comments-loading">
            <Spinner />
          </div>
        )}

        {loadError && (
          <div className="folio-comments-empty">
            Could not load comments.{' '}
            <button type="button" className="folio-history-back" onClick={load}>
              Retry
            </button>
          </div>
        )}

        {comments != null && comments.length === 0 && !loadError && (
          <div className="folio-comments-empty">
            No comments yet. Select some text and choose <strong>Comment</strong> to leave one in the margin.
          </div>
        )}

        {comments != null && comments.length > 0 && (
          <div className="folio-comments-list">
            {comments.map((c) => {
              const orphaned = !liveIds.has(c.id);
              const editing = editingId === c.id;
              return (
                <div key={c.id} className={`folio-comment-card${c.resolved ? ' is-resolved' : ''}`}>
                  <button
                    type="button"
                    className="folio-comment-anchor"
                    disabled={orphaned}
                    onClick={() => scrollToComment(c.id)}
                    title={orphaned ? undefined : 'Jump to this text'}
                  >
                    <CommentIcon size={12} />
                    <span className="folio-comment-anchor-text">{c.anchorText ? `“${c.anchorText}”` : 'General note'}</span>
                  </button>
                  {orphaned && <span className="folio-comment-orphan-chip">orphaned</span>}

                  {editing ? (
                    <div className="folio-comment-edit">
                      <textarea
                        className="folio-field-input"
                        rows={3}
                        value={draft}
                        autoFocus
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') setEditingId(null);
                          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                            e.preventDefault();
                            saveEdit(c);
                          }
                        }}
                      />
                      <div className="folio-comment-edit-actions">
                        <button type="button" className="folio-btn" onClick={() => setEditingId(null)} disabled={busyId === c.id}>
                          Cancel
                        </button>
                        <button type="button" className="folio-btn-primary" onClick={() => saveEdit(c)} disabled={busyId === c.id || !draft.trim()}>
                          {busyId === c.id ? <Spinner size={13} /> : 'Save'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="folio-comment-body">{c.body}</p>
                  )}

                  <div className="folio-comment-footer">
                    <span className="folio-comment-time">{relativeTime(c.updatedAt)}</span>
                    <div className="folio-comment-actions">
                      <label className="folio-comment-resolve">
                        <input type="checkbox" checked={c.resolved} onChange={() => toggleResolved(c)} />
                        Resolved
                      </label>
                      {!editing && (
                        <button type="button" className="folio-btn-icon" aria-label="Edit comment" onClick={() => startEdit(c)}>
                          <Icon name="pencil" size={13} />
                        </button>
                      )}
                      <button
                        type="button"
                        className="folio-btn-icon"
                        aria-label="Delete comment"
                        disabled={busyId === c.id}
                        onClick={() => remove(c)}
                      >
                        <Icon name="trash" size={13} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </aside>
    </div>
  );
}
