// BubbleMenu shown on a non-empty text selection: formatting marks, a link popover,
// a Comment composer, an "Add to flashcards" action, and an "AI" quick-instruction
// submenu that opens AiPreviewModal on completion.
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { BubbleMenu } from '@tiptap/react/menus';
import type { Editor } from '@tiptap/core';
import type { Transaction } from '@tiptap/pm/state';
import { api, ApiError } from '../../lib/api';
import { toast } from '../../components/Toast';
import Icon from '../../components/Icon';
import { useAiAvailable } from '../../lib/aiStatus';
import AiPreviewModal from './AiPreviewModal';
import QuickCardModal from './QuickCardModal';
import CommentIcon from '../comments/CommentIcon';
import { notifyCommentAdded } from '../comments/commentsBus';
import { markdownToSafeHtml } from './markdown';
import { useNativeMenuSuppressed } from './nativeMenuSuppression';

/** Closes `close()` on outside click or Escape while `active` - used for the AI dropdown and
 *  the comment composer popover (the AI dropdown previously only closed on mouse-leave, which
 *  iter1 review flagged as neither click-outside- nor keyboard-dismissable). */
function useDismiss(active: boolean, ref: React.RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!active) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [active, ref, close]);
}

const AI_INSTRUCTIONS = [
  { id: 'improve', label: 'Improve', instruction: 'Improve the writing: clarity, flow and correctness. Keep the meaning and roughly the same length.' },
  { id: 'shorten', label: 'Shorten', instruction: 'Make this significantly more concise while keeping the key meaning.' },
  { id: 'expand', label: 'Expand', instruction: 'Expand this with more detail and explanation.' },
  { id: 'fix', label: 'Fix grammar', instruction: 'Fix grammar and spelling only; do not change the meaning or style.' },
  { id: 'explain', label: 'Explain simpler', instruction: 'Rewrite this to be much easier to understand, as if explaining to a beginner.' },
];

interface AiResult {
  before: string;
  after: string;
  model: string;
  range: { from: number; to: number };
}

function aiErrorMessage(e: unknown): string {
  if (e instanceof ApiError && e.status === 502) return 'AI offline. Is the gateway running?';
  return e instanceof Error ? e.message : 'AI request failed';
}

export default function SelectionToolbar({ editor }: { editor: Editor }) {
  const { noteId } = useParams<{ noteId: string }>();
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState('');
  const [aiOpen, setAiOpen] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResult, setAiResult] = useState<AiResult | null>(null);
  // Availability, not just preference: with no reachable gateway these buttons
  // would look live and fail only after the user clicks and waits.
  const aiEnabled = useAiAvailable();
  const [commentOpen, setCommentOpen] = useState(false);
  const [commentDraft, setCommentDraft] = useState('');
  const [commentSaving, setCommentSaving] = useState(false);
  const [quickCardOpen, setQuickCardOpen] = useState(false);
  const [quickCardAnswer, setQuickCardAnswer] = useState('');

  const isNativeMenuOpen = useNativeMenuSuppressed(editor.view.dom);

  const aiTriggerRef = useRef<HTMLDivElement>(null);
  const commentTriggerRef = useRef<HTMLDivElement>(null);
  useDismiss(aiOpen, aiTriggerRef, () => setAiOpen(false));
  useDismiss(commentOpen, commentTriggerRef, () => setCommentOpen(false));

  // Pin the AI-edit target range by mapping it through every transaction that lands while
  // the request is in flight (and while the preview modal is open). Without this, applying
  // "Replace selection" used the positions captured BEFORE the round trip - typing anywhere
  // above the selection shifted the doc and the result landed at the wrong spot (or threw).
  const trackedRangeRef = useRef<{ from: number; to: number } | null>(null);
  const trackerAttachedRef = useRef(false);

  // Same problem, independent tracker: the comment's anchor range must survive the async
  // api.addComment() round trip before the mark gets applied.
  const commentRangeRef = useRef<{ from: number; to: number } | null>(null);

  useEffect(() => {
    function onTransaction({ transaction }: { transaction: Transaction }) {
      if (!transaction.docChanged) return;
      const r = trackedRangeRef.current;
      if (r) {
        r.from = transaction.mapping.map(r.from, 1);
        r.to = transaction.mapping.map(r.to, -1);
        if (r.to < r.from) r.to = r.from;
      }
      const cr = commentRangeRef.current;
      if (cr) {
        cr.from = transaction.mapping.map(cr.from, 1);
        cr.to = transaction.mapping.map(cr.to, -1);
        if (cr.to < cr.from) cr.to = cr.from;
      }
    }
    editor.on('transaction', onTransaction);
    trackerAttachedRef.current = true;
    return () => {
      editor.off('transaction', onTransaction);
      trackerAttachedRef.current = false;
    };
  }, [editor]);

  /** The tracked range, clamped to the current doc (defensive against deletions). */
  function currentTargetRange(fallback: { from: number; to: number }): { from: number; to: number } {
    const r = trackedRangeRef.current ?? fallback;
    const max = editor.state.doc.content.size;
    const from = Math.max(0, Math.min(r.from, max));
    const to = Math.max(from, Math.min(r.to, max));
    return { from, to };
  }

  function clearAiResult() {
    trackedRangeRef.current = null;
    setAiResult(null);
  }

  function openLink() {
    const attrs = editor.getAttributes('link');
    setLinkValue((attrs.href as string) || '');
    setLinkOpen(true);
    setAiOpen(false);
  }

  function applyLink() {
    const href = linkValue.trim();
    if (!href) editor.chain().focus().extendMarkRange('link').unsetLink().run();
    else editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
    setLinkOpen(false);
  }

  async function runAi(instruction: string) {
    const { from, to } = editor.state.selection;
    const text = editor.state.doc.textBetween(from, to, '\n');
    if (!text.trim()) return;
    setAiOpen(false);
    setAiLoading(true);
    trackedRangeRef.current = { from, to }; // live-mapped from here on
    try {
      const res = await api.aiImprove({ text, instruction });
      setAiResult({ before: text, after: res.markdown, model: res.model, range: { from, to } });
    } catch (e) {
      trackedRangeRef.current = null;
      toast(aiErrorMessage(e), 'error');
    } finally {
      setAiLoading(false);
    }
  }

  function openCommentComposer() {
    setLinkOpen(false);
    setAiOpen(false);
    setCommentDraft('');
    setCommentOpen(true);
  }

  async function submitComment() {
    const body = commentDraft.trim();
    if (!body || !noteId || commentSaving) return;
    const { from, to } = editor.state.selection;
    const anchorText = editor.state.doc.textBetween(from, to, ' ').trim().slice(0, 200);
    commentRangeRef.current = { from, to }; // live-mapped from here on
    setCommentSaving(true);
    try {
      const { comment } = await api.addComment(noteId, { anchorText, body });
      const range = commentRangeRef.current ?? { from, to };
      // Graceful degradation: apply the mark only if the schema actually has it (depends on
      // editor-blocks having wired CommentMark into buildExtensions.ts - see CommentMark.ts).
      // The comment is still saved and visible in the margin panel either way.
      if (editor.schema.marks.comment) {
        editor.chain().setTextSelection(range).setMark('comment', { commentId: comment.id }).run();
      }
      notifyCommentAdded();
      setCommentOpen(false);
      toast('Comment added', 'ok');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not add comment', 'error');
    } finally {
      commentRangeRef.current = null;
      setCommentSaving(false);
    }
  }

  function openQuickCard() {
    const { from, to } = editor.state.selection;
    const text = editor.state.doc.textBetween(from, to, '\n').trim();
    setQuickCardAnswer(text);
    setQuickCardOpen(true);
  }

  return (
    <>
      <BubbleMenu
        editor={editor}
        pluginKey="folioSelectionMenu"
        // flip to below the selection when there's no room above (never cover the selected
        // line); shift keeps it inside the viewport horizontally.
        options={{ placement: 'top', offset: 8, flip: { fallbackPlacements: ['bottom'], padding: 8 }, shift: { padding: 8 } }}
        shouldShow={({ editor, state }) => {
          // Deliberately selection-type-agnostic: it asks "did the user just invoke the
          // browser's menu here", not "what kind of selection is this". A right-clicked
          // inline atom produces a NodeSelection, which is also non-empty, so anything that
          // owns its own context menu is covered by the same predicate.
          if (isNativeMenuOpen()) return false;
          const { empty } = state.selection;
          if (empty) return false;
          if (editor.isActive('table') || editor.isActive('image') || editor.isActive('codeBlock')) return false;
          return true;
        }}
      >
        <div className="folio-bubble folio-selection-bubble">
          <button type="button" className={editor.isActive('bold') ? 'active' : ''} title="Bold" onClick={() => editor.chain().focus().toggleBold().run()}>
            <b>B</b>
          </button>
          <button type="button" className={editor.isActive('italic') ? 'active' : ''} title="Italic" onClick={() => editor.chain().focus().toggleItalic().run()}>
            <i>I</i>
          </button>
          <button type="button" className={editor.isActive('strike') ? 'active' : ''} title="Strikethrough" onClick={() => editor.chain().focus().toggleStrike().run()}>
            <s>S</s>
          </button>
          <button type="button" className={editor.isActive('code') ? 'active' : ''} title="Inline code" onClick={() => editor.chain().focus().toggleCode().run()}>
            {'</>'}
          </button>
          <button type="button" className={editor.isActive('highlight') ? 'active' : ''} title="Highlight" onClick={() => editor.chain().focus().toggleHighlight().run()}>
            ◆
          </button>
          <button type="button" className={editor.isActive('link') ? 'active' : ''} title="Link" onClick={openLink}>
            <Icon name="link" size={14} />
          </button>
          <span className="folio-bubble-sep" />
          <div className="folio-ai-trigger" ref={commentTriggerRef}>
            <button type="button" title="Comment" onClick={() => (commentOpen ? setCommentOpen(false) : openCommentComposer())}>
              <CommentIcon size={13} />
            </button>
            {commentOpen && (
              <div className="folio-comment-composer" onMouseDown={(e) => e.stopPropagation()}>
                <textarea
                  autoFocus
                  aria-label="Comment on the selected text"
                  rows={3}
                  value={commentDraft}
                  placeholder="Leave a note in the margin…"
                  onChange={(e) => setCommentDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setCommentOpen(false);
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      submitComment();
                    }
                  }}
                />
                <div className="folio-comment-composer-actions">
                  <button type="button" onClick={() => setCommentOpen(false)} disabled={commentSaving}>
                    Cancel
                  </button>
                  <button type="button" className="primary" onClick={submitComment} disabled={commentSaving || !commentDraft.trim()}>
                    {commentSaving ? '…' : 'Comment'}
                  </button>
                </div>
              </div>
            )}
          </div>
          <button type="button" title="Add to flashcards" onClick={openQuickCard}>
            <Icon name="layers" size={14} />
          </button>
          {aiEnabled && (
            <>
              <span className="folio-bubble-sep" />
              <div className="folio-ai-trigger" ref={aiTriggerRef}>
                <button type="button" className="folio-ai-btn" disabled={aiLoading} onClick={() => setAiOpen((v) => !v)}>
                  {aiLoading ? '…' : <><Icon name="sparkles" size={13} /> AI</>}
                </button>
                {aiOpen && (
                  <div className="folio-ai-dropdown">
                    {AI_INSTRUCTIONS.map((o) => (
                      <button key={o.id} type="button" onClick={() => runAi(o.instruction)}>
                        {o.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
        {linkOpen && (
          <div className="folio-link-popover" onMouseDown={(e) => e.stopPropagation()}>
            <input
              autoFocus
              aria-label="Link URL"
              value={linkValue}
              placeholder="https://…"
              onChange={(e) => setLinkValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applyLink();
                if (e.key === 'Escape') setLinkOpen(false);
              }}
            />
            <button type="button" onClick={applyLink}>{linkValue.trim() ? 'Apply' : 'Remove'}</button>
          </div>
        )}
      </BubbleMenu>

      {aiResult && (
        <AiPreviewModal
          open
          onClose={clearAiResult}
          heading="AI edit"
          model={aiResult.model}
          before={aiResult.before}
          afterMarkdown={aiResult.after}
          actions={[
            {
              label: 'Replace selection',
              primary: true,
              onClick: () => {
                const html = markdownToSafeHtml(aiResult.after);
                editor.chain().focus().insertContentAt(currentTargetRange(aiResult.range), html).run();
                clearAiResult();
              },
            },
            {
              label: 'Insert below',
              onClick: () => {
                const html = markdownToSafeHtml(aiResult.after);
                editor.chain().focus().insertContentAt(currentTargetRange(aiResult.range).to, html).run();
                clearAiResult();
              },
            },
            {
              label: 'Copy',
              onClick: () => {
                navigator.clipboard?.writeText(aiResult.after).then(
                  () => toast('Copied', 'ok'),
                  () => toast('Could not copy', 'error'),
                );
              },
            },
          ]}
        />
      )}

      <QuickCardModal
        open={quickCardOpen}
        onClose={() => setQuickCardOpen(false)}
        noteId={noteId}
        initialAnswer={quickCardAnswer}
      />
    </>
  );
}
