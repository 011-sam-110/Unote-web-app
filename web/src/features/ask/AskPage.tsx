import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { api, ApiError } from '../../lib/api';
import type { Notebook } from '../../lib/types';
import { toast } from '../../components/Toast';
import EmptyState from '../../components/EmptyState';
import { useAiEnabled } from '../../lib/aiPrefs';
import { aiUnavailableMessage, refreshAiHealth, useAiHealth } from '../../lib/aiStatus';
import { openAiSettings } from '../auth/aiSettingsBus';
import { useGuest } from '../guest/guestMode';
import { markdownToDoc } from './mdToTiptap';
import './AskPage.css';

interface Source { id: string; title: string }

interface Pair {
  id: string;
  question: string;
  notebookId: string | null;
  status: 'loading' | 'done' | 'error';
  answer?: string;
  sources?: Source[];
  model?: string;
  error?: string;
}

export default function AskPage() {
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [notebookFilter, setNotebookFilter] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const [pairs, setPairs] = useState<Pair[]>([]);
  const [asking, setAsking] = useState(false);
  const [insertingId, setInsertingId] = useState<string | null>(null);
  const [aiOn, setAiOn] = useAiEnabled();
  // Must be called here, above the early returns below - a hook after a conditional
  // return would break the rules-of-hooks ordering.
  const aiHealth = useAiHealth();
  const guest = useGuest();
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    api.notebooks().then(res => setNotebooks(res.notebooks)).catch(() => { /* filter chips just won't show */ });
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [pairs.length]);

  // The AI kill-switch removes this whole surface - show a plain explanation instead of
  // a broken page for anyone who lands here via URL/bookmark. (After all hooks.)
  if (!aiOn) {
    return (
      <div className="ask-page" data-testid="ask-disabled">
        <EmptyState
          icon="📓"
          title="AI features are turned off"
          hint="You switched Unote to plain-notebook mode. Turn AI back on any time. Nothing about your notes changes either way."
          action={
            <button type="button" className="btn btn-primary" onClick={() => setAiOn(true)}>
              Turn AI back on
            </button>
          }
        />
      </div>
    );
  }

  // Distinct from the kill-switch above on purpose: "you turned this off" and "the
  // model gateway can't be reached" are different problems with different fixes, and
  // collapsing them into one message sends the user looking in the wrong place.
  //
  // The reason now comes from the server, per user: it distinguishes a deployment with no
  // gateway configured from a personal key that is not answering, and says which. "Try
  // again" is only offered for the second - a missing configuration will never fix itself
  // on a retry, and offering one there just wastes the reader's time.
  // Answered before the health branch below, which would otherwise tell a guest that "AI
  // is not set up on this site" and point them at a settings dialog. It is set up; they
  // just have no account for it to run against.
  if (guest) {
    return (
      <div className="ask-page" data-testid="ask-guest">
        <EmptyState
          icon="🔒"
          title="Asking your notes needs an account"
          hint="The answers are generated on the server from what you have written, and there is no account here to read from. Everything else works: writing, notebooks, search and tags."
          action={
            <Link className="btn btn-primary" to="/signup">
              Make an account
            </Link>
          }
        />
      </div>
    );
  }

  if (aiHealth.status === 'bad') {
    const message = aiUnavailableMessage(aiHealth);
    const retryable = aiHealth.reason !== 'not_configured';
    return (
      <div className="ask-page" data-testid="ask-unavailable">
        <EmptyState
          icon="🔌"
          title={message?.title ?? 'AI isn’t reachable right now'}
          hint={`${message?.detail ?? ''} Everything else works as normal: notes, search, flashcards, canvas.`.trim()}
          action={
            <>
              <button type="button" className="btn" onClick={() => openAiSettings()}>
                Open AI settings
              </button>
              {retryable && (
                <button type="button" className="btn" onClick={() => void refreshAiHealth()}>
                  Try again
                </button>
              )}
            </>
          }
        />
      </div>
    );
  }

  async function ask() {
    const q = question.trim();
    if (!q || asking) return;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const notebookId = notebookFilter;
    setPairs(prev => [...prev, { id, question: q, notebookId, status: 'loading' }]);
    setQuestion('');
    setAsking(true);
    try {
      const res = await api.aiAsk(q, notebookId ?? undefined);
      setPairs(prev => prev.map(p => (p.id === id ? { ...p, status: 'done', answer: res.answer, sources: res.sources, model: res.model } : p)));
    } catch (err) {
      const message = err instanceof ApiError
        ? (err.status === 502 ? 'AI offline. Is the gateway running?' : err.message)
        : 'Something went wrong asking your notes.';
      setPairs(prev => prev.map(p => (p.id === id ? { ...p, status: 'error', error: message } : p)));
    } finally {
      setAsking(false);
      textareaRef.current?.focus();
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      ask();
    }
  }

  async function insertIntoNote(pair: Pair) {
    if (!pair.answer) return;
    const notebookId = pair.notebookId ?? notebooks[0]?.id;
    if (!notebookId) {
      toast('Create a notebook first', 'error');
      return;
    }
    setInsertingId(pair.id);
    try {
      const doc = markdownToDoc(pair.answer);
      const res = await api.createNote({
        notebookId,
        title: pair.question.slice(0, 80),
        contentJson: doc,
        contentText: pair.answer,
      });
      toast('Added to a new note', 'ok');
      navigate(`/note/${res.note.id}`);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not create the note', 'error');
    } finally {
      setInsertingId(null);
    }
  }

  function retry(pair: Pair) {
    setQuestion(pair.question);
    textareaRef.current?.focus();
  }

  return (
    <div className="ak-page">
      <div className="ak-hero">
        <div className="ak-hero__crumb">Ask AI</div>
        <h1>Ask across everything you have written.</h1>
        <p className="ak-hero__sub">
          Answers cite the notes they came from. Nothing is written back into a note unless you add it
          yourself.
        </p>

        <div className="ak-chips">
          <button type="button" className={`ak-chip${notebookFilter === null ? ' is-active' : ''}`} onClick={() => setNotebookFilter(null)}>
            All notebooks
          </button>
          {notebooks.map(nb => (
            <button
              key={nb.id}
              type="button"
              className={`ak-chip${notebookFilter === nb.id ? ' is-active' : ''}`}
              onClick={() => setNotebookFilter(nb.id)}
            >
              {nb.emoji} {nb.name}
            </button>
          ))}
        </div>

        <div className="ak-input">
          <textarea
            ref={textareaRef}
            value={question}
            onChange={e => setQuestion(e.target.value)}
            onKeyDown={onKeyDown}
            /* A real question rather than an instruction: it shows the SHAPE of what works
               here, which "Ask your notes…" never did. */
            placeholder="What is the difference between a B-tree and a B+ tree?"
            rows={2}
            aria-label="Ask your notes"
          />
          <button type="button" className="ak-btn ak-btn--primary ak-input__submit" onClick={ask} disabled={asking || !question.trim()}>
            {asking ? 'Asking…' : 'Ask'}
          </button>
        </div>
      </div>

      {pairs.length === 0 ? (
        <EmptyState
          icon="💬"
          title="Nothing asked yet"
          hint="Try something like “What's the difference between a B-tree and a B+ tree?”"
        />
      ) : (
        <div className="ak-thread">
          {pairs.map(pair => (
            <div className="ak-pair" key={pair.id}>
              <div className="ak-bubble--question">{pair.question}</div>

              {pair.status === 'loading' && (
                <div className="ak-answer ak-answer--loading">
                  <div className="ak-shimmer-line" />
                  <div className="ak-shimmer-line" />
                  <div className="ak-shimmer-line ak-shimmer-line--short" />
                </div>
              )}

              {pair.status === 'error' && (
                <div className="ak-answer ak-answer--error">
                  <div className="ak-answer__error-text">{pair.error}</div>
                  <button type="button" className="ak-btn" onClick={() => retry(pair)}>Try again</button>
                </div>
              )}

              {pair.status === 'done' && (
                <div className="ak-answer">
                  <div className="ak-answer__markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(pair.answer ?? '') }} />
                  {pair.sources && pair.sources.length > 0 && (
                    <div className="ak-sources">
                      {pair.sources.map(s => (
                        <Link key={s.id} className="ak-chip ak-chip--source" to={`/note/${s.id}`}>→ {s.title}</Link>
                      ))}
                    </div>
                  )}
                  <div className="ak-answer__footer">
                    {pair.model && <span className="ak-model-tag">{pair.model}</span>}
                    <button
                      type="button"
                      className="ak-link-btn"
                      disabled={insertingId === pair.id}
                      onClick={() => insertIntoNote(pair)}
                    >
                      {insertingId === pair.id ? 'Adding…' : '+ Insert into new note'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}

function renderMarkdown(md: string): string {
  const html = marked.parse(normalizeAnswer(md), { async: false }) as string;
  return DOMPurify.sanitize(html);
}

/**
 * Tidy the two things models reliably get wrong here, in prose the reader cannot edit.
 *
 * The prompt asks for ASCII citations and plain-text maths (see askPrompt on the server), but
 * a prompt is a request, not a guarantee, and a model that ignores it lands full-width CJK
 * brackets and bare LaTeX macros in the middle of a serif paragraph. Repairing the rendering
 * costs two expressions and does not depend on which gateway answered.
 */
function normalizeAnswer(md: string): string {
  return (
    md
      // Full-width brackets around a citation, which the source chips below already carry.
      // Any spacing already in front of the marker is absorbed rather than doubled - and
      // only that spacing, because leading indentation is what makes a Markdown list nest.
      .replace(/[ \t]*【\s*([^】]*?)\s*】/g, (_m, inner: string) => (inner ? ` [${inner}]` : ''))
      // Inline-math delimiters. Markdown renders \( as a literal "(", so "\(O(n log n)\)"
      // reached the page as "(O(n log n))" - a second pair of brackets around the answer.
      .replace(/\\[()[\]]/g, '')
      // Bare LaTeX for the handful of operators that actually turn up in a maths answer.
      // The macro carries its own spacing in LaTeX ("n\log n"), so dropping the backslash
      // alone would close the gap and read as "nlog n".
      .replace(/(\w)?\\(log|ln|sin|cos|tan|exp|max|min|lim|sqrt)\b/g, (_m, before: string | undefined, fn: string) =>
        before ? `${before} ${fn}` : fn,
      )
  );
}
