// The AI panel - the note's ONE AI surface, and now a conversation rather than a menu.
//
// It has been three things. It began as a study-assistant drawer (read the note plus its
// uploaded sources, report what's missing, never rewrite anything). Then the action bar's
// `✦ AI ▾` dropdown was folded into it, so Improve writing, Clean up formatting, Find missing
// content from uploads and Generate flashcards moved here as buttons. What was still missing
// was the obvious thing: there was nowhere to TYPE. A panel of four fixed buttons cannot be
// asked "is the bit about B-trees right?", and a student's actual question never fits four
// buttons.
//
// So this is a chat, the same shape as Ask AI, scoped to one note. The buttons survive as
// what they always should have been: shortcuts that send a message. Pressing Improve writing
// puts "Improve the writing in this note." in the thread and sends it; the model reads it and
// calls a tool; the tool runs and its result lands back in the thread. Typing that sentence
// yourself does exactly the same thing, because it IS the same thing.
//
// WHY THE REVIEW RENDERS INSIDE THE THREAD. It used to replace the whole panel, which was
// right when the panel was a menu - there was nothing underneath worth keeping. In a
// conversation it would throw away the exchange that produced it, and take the composer with
// it, so the student could not say "actually, ignore the grammar ones" while looking at them.
// The rail now renders under the turn that started it, where a code diff sits in an agent
// chat. Suggestions live in the editor's plugin state, not in this component, so closing the
// drawer and reopening it comes back to the same review.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Editor } from '@tiptap/core';
import { ApiError, api } from '../../lib/api';
import { toast } from '../../components/Toast';
import Icon from '../../components/Icon';
import Spinner from '../../components/Spinner';
import { useDialogFocus } from '../../components/useDialogFocus';
import { markdownToSafeHtml } from './markdown';
import { useResizableDrawer } from './useResizableDrawer';
import { useDrawerInset } from './drawerInset';
import { QUICK_ACTIONS, toolLabel, type ToolOutcome } from './assistantActions';
import AiReviewRail from './AiReviewRail';
import type { Attachment } from '../../lib/types';

/**
 * Verbatim from `POST /api/ai/gaps/edits` (server/src/routes/ai.ts), which answers a note
 * with no usable uploads with exactly this sentence. One wording, whichever side of the wire
 * it comes from.
 */
const GAPS_NO_UPLOADS = 'Import slides, a photo or a transcript first.';

/** The width this panel opens at the first time. After that the reader's own width wins -
 *  see useResizableDrawer. */
const DEFAULT_WIDTH = 420;

export interface AssistantPanelProps {
  noteId: string;
  attachments?: Attachment[];
  open: boolean;
  onClose: () => void;
  /** Append prose into the note (explicit user choice, never automatic). */
  onInsert: (markdown: string) => void;

  /** Non-null while any AI call is in flight; the composer and the shortcuts disable
   *  together, because the page runs one AI request at a time. */
  aiBusy: string | null;
  /**
   * Run the tool the model chose, and say what happened.
   *
   * NotePage owns this because the tools write to the note, the deck and the review plugin,
   * none of which this component has a handle on. `intent` is the tool the student's button
   * press meant, if it was a button press - see assistantActions.ts.
   */
  runTool: (tool: string, args: Record<string, unknown>) => Promise<ToolOutcome>;
  onOpenChecks: () => void;

  // --- Review state, rendered inline under the turn that produced it ---
  editor: Editor | null;
  reviewOpen: boolean;
  /** Awaited before the first approval writes - see AiReviewRail. */
  beforeApply: () => Promise<void>;
  onReviewDone: () => void;
}

type Turn =
  | { id: string; role: 'user'; text: string }
  | { id: string; role: 'assistant'; kind: 'pending' }
  | { id: string; role: 'assistant'; kind: 'reply'; markdown: string; model: string }
  | { id: string; role: 'assistant'; kind: 'error'; text: string }
  | {
      id: string;
      role: 'assistant';
      kind: 'tool';
      tool: string;
      say: string;
      phase: 'running' | 'review' | 'settled';
      /** One line under the tool's name once it has finished. */
      detail?: string;
      /** Set when the outcome was prose - rendered, with an Add to note button. */
      prose?: { markdown: string; sources?: string[] };
      failed?: boolean;
    };

let seq = 0;
function turnId(): string {
  seq += 1;
  return `t${seq}`;
}

export default function AssistantPanel({
  noteId,
  attachments,
  open,
  onClose,
  onInsert,
  aiBusy,
  runTool,
  onOpenChecks,
  editor,
  reviewOpen,
  beforeApply,
  onReviewDone,
}: AssistantPanelProps) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  /** Which turn the open review belongs to, so the rail renders under it rather than at the
   *  bottom of whatever has been said since. */
  const [reviewTurn, setReviewTurn] = useState<string | null>(null);

  const hasUploads = (attachments ?? []).some((a) => a.status === 'ready');
  const busy = sending || !!aiBusy;

  const panelRef = useRef<HTMLElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const { width, gripProps, dragging } = useResizableDrawer('folio.aiPanelWidth', DEFAULT_WIDTH, 'Resize AI panel');

  // Push the note out from under the panel instead of covering the text it is about.
  useDrawerInset('assistant', width, open);

  // Non-modal drawer: the note behind stays readable and editable, so Tab is NOT trapped.
  // Focus still has to move in, or the Escape handler never fires (focus would still be on
  // the trigger outside the panel) and the drawer becomes a dead end.
  useDialogFocus(open, panelRef, onClose, { trap: false });

  useEffect(() => {
    if (!open) return;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns, open, reviewOpen]);

  // The review can be ended from the rail (Approve all, Discard, its ✕) or from NotePage.
  // Whatever ended it, the turn that owns it stops claiming to have suggestions waiting -
  // a card still reading "6 suggestions to review" above a closed review is a promise the
  // panel is no longer keeping.
  useEffect(() => {
    if (reviewOpen || !reviewTurn) return;
    setTurns((prev) =>
      prev.map((t) =>
        t.id === reviewTurn && t.role === 'assistant' && t.kind === 'tool'
          ? { ...t, phase: 'settled', detail: 'Review closed' }
          : t,
      ),
    );
    setReviewTurn(null);
  }, [reviewOpen, reviewTurn]);

  const patch = useCallback((id: string, next: Turn) => {
    setTurns((prev) => prev.map((t) => (t.id === id ? next : t)));
  }, []);

  /**
   * The conversation as the server wants it.
   *
   * A tool turn is replayed as what it DID, not as the sentence that announced it: "Ran
   * Improve writing: 6 suggestions" is what makes "do that again" and "why did you suggest
   * that?" answerable. A turn still running contributes nothing, because nothing has
   * happened yet.
   */
  function history(list: Turn[]): Array<{ role: 'user' | 'assistant'; content: string }> {
    const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (const t of list) {
      if (t.role === 'user') out.push({ role: 'user', content: t.text });
      else if (t.kind === 'reply') out.push({ role: 'assistant', content: t.markdown });
      else if (t.kind === 'tool' && t.phase !== 'running') {
        out.push({ role: 'assistant', content: `[Ran ${toolLabel(t.tool)}: ${t.detail ?? 'done'}]` });
      }
    }
    return out;
  }

  async function send(text: string, intent?: string) {
    const message = text.trim();
    if (!message || busy) return;

    const userTurn: Turn = { id: turnId(), role: 'user', text: message };
    const pendingId = turnId();
    // Built from `turns` rather than from inside the state updater. React defers an updater
    // until the re-render, so a snapshot assigned in there would still be empty by the time
    // the request below reads it, and every message would be sent with no conversation
    // behind it. `send` runs from an event handler, so `turns` here is the current list.
    const snapshot: Turn[] = [...turns, userTurn];
    setTurns([...snapshot, { id: pendingId, role: 'assistant', kind: 'pending' }]);
    setDraft('');
    setSending(true);

    try {
      const turn = await api.aiChat(noteId, history(snapshot));

      if (turn.kind === 'reply') {
        // A button press that came back as words rather than as the tool it names. The model
        // answered off-intent; run what the button said instead of leaving the student
        // holding a paragraph where they asked for an action. A typed message has no intent
        // and is simply answered.
        if (intent) {
          patch(pendingId, { id: pendingId, role: 'assistant', kind: 'tool', tool: intent, say: turn.markdown, phase: 'running' });
          await execute(pendingId, intent, {}, turn.markdown);
          return;
        }
        patch(pendingId, { id: pendingId, role: 'assistant', kind: 'reply', markdown: turn.markdown, model: turn.model });
        return;
      }

      patch(pendingId, { id: pendingId, role: 'assistant', kind: 'tool', tool: turn.tool, say: turn.say, phase: 'running' });
      await execute(pendingId, turn.tool, turn.args, turn.say);
    } catch (e) {
      patch(pendingId, { id: pendingId, role: 'assistant', kind: 'error', text: chatError(e) });
    } finally {
      setSending(false);
      composerRef.current?.focus();
    }
  }

  /**
   * Run one tool and fold its outcome back into the turn that announced it.
   *
   * `say` is passed in rather than read back off the turn: the patch that created the turn
   * has not been through a render yet, so the `turns` this closure can see is the list from
   * before the tool call and the sentence would come back undefined every time.
   */
  async function execute(id: string, tool: string, args: Record<string, unknown>, say: string) {
    const outcome = await runTool(tool, args);
    const base = { id, role: 'assistant' as const, kind: 'tool' as const, tool };

    if (outcome.kind === 'review') {
      setReviewTurn(id);
      patch(id, {
        ...base,
        say,
        phase: 'review',
        detail: `${outcome.count} ${outcome.count === 1 ? 'suggestion' : 'suggestions'} to review`,
      });
      return;
    }
    if (outcome.kind === 'prose') {
      patch(id, { ...base, say, phase: 'settled', prose: { markdown: outcome.markdown, sources: outcome.sources } });
      return;
    }
    patch(id, {
      ...base,
      say,
      phase: 'settled',
      detail: outcome.message,
      failed: outcome.kind === 'error',
    });
  }

  function onComposerKeyDown(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send(draft);
    }
  }

  if (!open) return null;

  return (
    <div className="folio-history-overlay">
      <aside
        ref={panelRef}
        className={`folio-history-panel folio-assistant folio-ai-panel folio-ai-chat${dragging ? ' is-resizing' : ''}`}
        style={{ width }}
        role="dialog"
        tabIndex={-1}
        aria-label="AI"
        data-testid="assistant-panel"
        onKeyDown={(e) => {
          // Escape closes the drawer and LEAVES any open review alone: the suggestions are
          // decorations in the editor's plugin state, so reopening comes back to the same
          // review rather than to a discarded one.
          if (e.key === 'Escape') onClose();
        }}
      >
        <div {...gripProps} />

        <div className="folio-history-head">
          <h3>
            <Icon name="sparkles" size={14} /> Assistant
          </h3>
          <button type="button" className="folio-btn-icon" onClick={onClose} aria-label="Close AI panel">
            ✕
          </button>
        </div>

        {/* The shortcuts. Flat and labelled rather than folded into a menu: taking away a
            layer of hiding is why they moved into this panel in the first place.
            The "why is this off" line sits UNDER the row rather than inside the chip: as a
            second line of italic text inside a pill it stretched that one chip to three
            times the width of its neighbours and broke the row. It is still visible text
            (not a title-only tooltip, which a touch user can never open) and is wired to
            the control it explains with aria-describedby. */}
        <div className="folio-ai-chat__quick" role="group" aria-label="Suggested actions">
          {QUICK_ACTIONS.map((action) => {
            const blocked = action.needsUploads && !hasUploads;
            return (
              <button
                key={action.intent}
                type="button"
                className="folio-ai-action"
                disabled={busy || blocked}
                title={blocked ? GAPS_NO_UPLOADS : action.message}
                aria-describedby={blocked ? 'folio-ai-quick-blocked' : undefined}
                onClick={() => void send(action.message, action.intent)}
              >
                {action.label}
              </button>
            );
          })}
          {QUICK_ACTIONS.some((a) => a.needsUploads) && !hasUploads && (
            <p className="folio-ai-action__hint" id="folio-ai-quick-blocked">
              {GAPS_NO_UPLOADS}
            </p>
          )}
        </div>

        <div className="folio-ai-chat__thread" data-testid="assistant-thread">
          {turns.length === 0 && (
            <div className="folio-ai-chat__empty">
              <p className="folio-ai-chat__empty-title">Ask about this note</p>
              <p className="folio-ai-chat__empty-hint">
                Every change arrives as a suggestion first. Nothing is written into the note until you
                approve it.
              </p>
            </div>
          )}

          {turns.map((turn) => (
            <div key={turn.id} className="folio-ai-turn" data-role={turn.role}>
              {turn.role === 'user' ? (
                <div className="folio-ai-bubble" data-testid="assistant-user-message">
                  {turn.text}
                </div>
              ) : turn.kind === 'pending' ? (
                <div className="folio-ai-thinking" role="status">
                  <Spinner size={16} />
                  <span>Thinking…</span>
                </div>
              ) : turn.kind === 'reply' ? (
                <div className="folio-ai-answer" data-testid="assistant-reply">
                  <div
                    className="folio-assistant__body"
                    // Sanitized via DOMPurify inside markdownToSafeHtml.
                    dangerouslySetInnerHTML={{ __html: markdownToSafeHtml(turn.markdown) }}
                  />
                  <div className="folio-ai-answer__foot">
                    <span className="folio-assistant__model">via {turn.model}</span>
                    <button type="button" className="folio-ai-linkbtn" onClick={() => onInsert(turn.markdown)}>
                      Add to note
                    </button>
                  </div>
                </div>
              ) : turn.kind === 'error' ? (
                <div className="folio-assistant__error" role="alert">
                  {turn.text}
                </div>
              ) : (
                <ToolTurn
                  turn={turn}
                  editor={editor}
                  showReview={reviewOpen && reviewTurn === turn.id}
                  beforeApply={beforeApply}
                  onReviewDone={onReviewDone}
                  onInsert={onInsert}
                />
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        <div className="folio-ai-chat__composer">
          {/* Field and controls in one card - see .folio-ai-chat__composer-box. */}
          <div className="folio-ai-chat__composer-box">
            <textarea
              ref={composerRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onComposerKeyDown}
              placeholder="Ask, or describe a change…"
              aria-label="Ask about this note"
              rows={2}
              disabled={busy}
              data-testid="assistant-composer"
            />
            <div className="folio-ai-chat__composer-row">
              <button type="button" className="folio-ai-linkbtn" onClick={onOpenChecks}>
                Choose what to check
              </button>
              <button
                type="button"
                className="folio-btn-primary"
                disabled={busy || !draft.trim()}
                onClick={() => void send(draft)}
                data-testid="assistant-send"
              >
                {busy ? 'Working…' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}

interface ToolTurnProps {
  turn: Extract<Turn, { kind: 'tool' }>;
  editor: Editor | null;
  showReview: boolean;
  beforeApply: () => Promise<void>;
  onReviewDone: () => void;
  onInsert: (markdown: string) => void;
}

/** One tool call in the conversation: what it is doing, then what it produced. */
function ToolTurn({ turn, editor, showReview, beforeApply, onReviewDone, onInsert }: ToolTurnProps) {
  return (
    <div className="folio-ai-tool" data-testid="assistant-tool" data-tool={turn.tool} data-phase={turn.phase}>
      <div className="folio-ai-tool__head">
        <span className="folio-ai-tool__icon" aria-hidden="true">
          {turn.phase === 'running' ? <Spinner size={13} /> : <Icon name="sparkles" size={13} />}
        </span>
        <span className="folio-ai-tool__name">{toolLabel(turn.tool)}</span>
        {turn.detail && (
          <span className="folio-ai-tool__detail" data-failed={turn.failed ? 'true' : undefined}>
            {turn.detail}
          </span>
        )}
      </div>

      {turn.say && turn.phase === 'running' && <p className="folio-ai-tool__say">{turn.say}</p>}

      {turn.prose && (
        <div className="folio-ai-answer">
          {turn.prose.sources && turn.prose.sources.length > 0 && (
            <div className="folio-assistant__sources">Checked against: {turn.prose.sources.join(', ')}</div>
          )}
          <div
            className="folio-assistant__body"
            data-testid="assistant-result"
            // The analysis is the point of the turn; without a live region it arrives
            // silently and a screen-reader user has no cue to go and read it.
            role="status"
            aria-live="polite"
            dangerouslySetInnerHTML={{ __html: markdownToSafeHtml(turn.prose.markdown) }}
          />
          <div className="folio-ai-answer__foot">
            <button
              type="button"
              className="folio-ai-linkbtn"
              onClick={() => {
                navigator.clipboard?.writeText(turn.prose?.markdown ?? '').then(
                  () => toast('Copied', 'ok'),
                  () => toast('Could not copy', 'error'),
                );
              }}
            >
              Copy
            </button>
            <button
              type="button"
              className="folio-ai-linkbtn"
              onClick={() => {
                onInsert(turn.prose?.markdown ?? '');
                toast('Added to the end of the note', 'ok');
              }}
            >
              Add to note
            </button>
          </div>
        </div>
      )}

      {showReview && (
        <div className="folio-ai-tool__review">
          <AiReviewRail editor={editor} beforeApply={beforeApply} onDone={onReviewDone} variant="inline" />
        </div>
      )}
    </div>
  );
}

/** A failed turn says what went wrong in the thread rather than as a toast that is gone by
 *  the time the student looks back at what they asked. */
function chatError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 502) return 'AI offline. Is the gateway running?';
    return e.message;
  }
  return e instanceof Error ? e.message : 'Something went wrong.';
}
