import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import type { DashboardData, Notebook } from '../lib/types';
import { errorMessage, greeting, longDate, numberFmt, plural, relativeTime } from '../lib/format';
import NoteCard from '../components/NoteCard';
import EmptyState from '../components/EmptyState';
import Skeleton from '../components/Skeleton';
import Spinner from '../components/Spinner';
import Icon from '../components/Icon';
import EmojiPicker from '../components/EmojiPicker';
import { useNotebooks } from '../components/NotebooksContext';
import { toast } from '../components/Toast';
import { openImportModal } from '../components/importModalBus';
import { openImportWizard } from '../features/import/importWizardBus';
import { resolveFilingNotebook } from '../lib/notebookContext';
import { startTour } from '../features/onboarding/onboardingBus';
import { useAuth } from '../features/auth/AuthContext';

const SUGGESTED_NOTEBOOKS = [
  { name: 'Algorithms & Data Structures', emoji: '📗' },
  { name: 'Databases', emoji: '🗄️' },
  { name: 'Operating Systems', emoji: '⚙️' },
  { name: 'Software Engineering', emoji: '🧩' },
  { name: 'Personal', emoji: '✨' },
];

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const { notebooks } = useNotebooks();
  const { user } = useAuth();

  /* "Good afternoon, Sam." - the first name only, and only when there is one. A guest has
     no display name, and "Good afternoon, design-qa@unote.test." is worse than no name. */
  const firstName = (user?.displayName ?? '').trim().split(/\s+/)[0];
  const greetingLine = firstName ? `${greeting()}, ${firstName}.` : greeting();

  // Same filing rules the sidebar and Ctrl+N already use, so a note created from the
  // empty state lands where the user would expect rather than in notebooks[0].
  const firstNotebookId = resolveFilingNotebook(undefined, notebooks);

  const createFirstNote = useCallback(async () => {
    if (!firstNotebookId) {
      toast('Create a notebook first', 'error');
      return;
    }
    try {
      const { note } = await api.createNote({ notebookId: firstNotebookId });
      navigate(`/note/${note.id}`);
    } catch (e) {
      toast(errorMessage(e, 'Could not create note'), 'error');
    }
  }, [firstNotebookId, navigate]);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .dashboard()
      .then(setData)
      .catch((e) => setError(errorMessage(e, 'Could not load your dashboard')))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="dash">
        <div className="dash__main">
          <div style={{ maxWidth: 260 }}>
            <Skeleton lines={2} />
          </div>
          <div style={{ border: '1px solid var(--line)', borderRadius: 'var(--radius-lg)', padding: 20 }}>
            <Skeleton lines={4} />
          </div>
          <div className="note-grid">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} style={{ border: '1px solid var(--line)', borderRadius: 'var(--radius-lg)', padding: 14 }}>
                <Skeleton lines={3} />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="dash">
        <EmptyState
          icon="⚠️"
          title="Couldn't load your dashboard"
          hint={error}
          action={
            <button type="button" className="btn btn-primary" onClick={load}>
              Retry
            </button>
          }
        />
      </div>
    );
  }

  if (!data) return null;

  if (data.stats.notebooks === 0) {
    return (
      <div className="dash">
        <div className="dash__onboard" style={{ margin: '8vh auto', maxWidth: 480 }}>
          <OnboardingCreateNotebook onCreated={(nb) => navigate(`/notebook/${nb.id}`)} />
        </div>
      </div>
    );
  }

  return (
    <div className="dash">
      <div className="dash__main">
        <header className="dash__header">
          <h1 className="dash__greeting">{greetingLine}</h1>
          <div className="dash__date">{longDate()}</div>
        </header>

        {data.continueNote && (
          <Link to={`/note/${data.continueNote.id}`} className="dash__hero" data-testid="continue-card">
            <div className="dash__hero-label">Continue where you left off</div>
            <div className="dash__hero-title">{data.continueNote.title || 'Untitled'}</div>
            {data.continueNote.snippet && <div className="dash__hero-snippet">{data.continueNote.snippet}</div>}
            <div className="dash__hero-meta">
              <span>
                {data.continueNote.notebook.emoji} {data.continueNote.notebook.name}
              </span>
              <span>·</span>
              <span>{relativeTime(data.continueNote.updatedAt)}</span>
            </div>
          </Link>
        )}

        <RecallRow recall={data.recall} />

        <section className="dash__section">
          <div className="dash__section-head">
            <h2 className="dash__section-title">Recent lessons</h2>
          </div>
          {data.recent.length === 0 ? (
            /* The first screen a new account lands on, and the only zero-state that
               used to offer no way out of itself. It now names the two ways notes
               get here - write one, or import one you already have - and offers the
               tour for anyone who would rather be shown. */
            <EmptyState
              icon="📝"
              title="Your notes will show up here"
              hint="Write one from scratch, or bring in what you already have: lecture slides, a PDF, a photo of your handwriting, even a recording of the lecture itself."
              action={
                <div className="dash__empty-actions">
                  <button type="button" className="btn btn-primary" onClick={createFirstNote}>
                    <Icon name="plus" size={14} /> Write a note
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => openImportModal({ notebookId: firstNotebookId ?? undefined, defaultKind: 'slides' })}
                  >
                    <Icon name="upload" size={14} /> Import slides or a PDF
                  </button>
                  <button type="button" className="btn btn-secondary" onClick={() => openImportWizard()}>
                    <Icon name="upload" size={14} /> Import old notes
                  </button>
                  <button type="button" className="btn btn-secondary" onClick={() => startTour()}>
                    <Icon name="sparkles" size={14} /> Show me around
                  </button>
                </div>
              }
            />
          ) : (
            <div className="note-grid" data-testid="recent-notes">
              {data.recent.map((n) => (
                <NoteCard key={n.id} note={n} onClick={() => navigate(`/note/${n.id}`)} />
              ))}
            </div>
          )}
        </section>

        {data.pinned.length > 0 && (
          <section className="dash__section">
            <div className="dash__section-head">
              <h2 className="dash__section-title">Pinned</h2>
            </div>
            <div className="note-strip" data-testid="pinned-strip">
              {data.pinned.map((n) => (
                <NoteCard key={n.id} note={n} onClick={() => navigate(`/note/${n.id}`)} />
              ))}
            </div>
          </section>
        )}

        <section className="dash__section">
          <div className="dash__section-head">
            <h2 className="dash__section-title">Notebooks</h2>
          </div>
          <div className="notebook-col-row">
            {data.notebooks.map((nb) => (
              <Link key={nb.id} to={`/notebook/${nb.id}`} className="notebook-col">
                <div className="notebook-col__emoji" aria-hidden="true">{nb.emoji}</div>
                <div className="notebook-col__name">{nb.name}</div>
                <div className="notebook-col__meta">
                  {plural(nb.noteCount, 'note')}
                  {nb.lastNoteAt ? ` · ${relativeTime(nb.lastNoteAt)}` : ''}
                </div>
              </Link>
            ))}
          </div>
        </section>
      </div>

      <aside className="dash__rail">
        <div className="rail-card">
          <div className="rail-card__title">Study</div>
          {data.stats.flashcardsDue > 0 ? (
            <>
              <div className="rail-card__due">{data.stats.flashcardsDue}</div>
              <div className="rail-card__due-label">{plural(data.stats.flashcardsDue, 'card')} due</div>
              <Link to="/study" className="btn btn-primary" style={{ width: '100%' }}>
                Start review
              </Link>
            </>
          ) : (
            <>
              <div className="rail-card__celebrate">You're all caught up. 0 due 🎉</div>
              {/* ?tab=browse - a bare /study lands on Review, and this button is only
                  offered when there is nothing left to review. */}
              <Link to="/study?tab=browse" className="btn btn-secondary" style={{ width: '100%' }}>
                Browse cards
              </Link>
            </>
          )}
        </div>

        <div className="rail-card">
          <div className="rail-card__title">This week</div>
          <WeekStrip data={data.weekGrid} />
        </div>

        <WeeklyReviewCard review={data.weeklyReview} />

        <div className="rail-card">
          <div className="rail-card__title">Stats</div>
          <div className="rail-stats" data-testid="dashboard-stats">
            {plural(data.stats.notes, 'note')} · {numberFmt(data.stats.words)} words
            <br />
            {plural(data.stats.notebooks, 'notebook')}
          </div>
        </div>
      </aside>
    </div>
  );
}

/** Local (browser) 'YYYY-MM-DD' for today, to match the server's local-day date strings
 *  in weekGrid so "today" highlights the right column regardless of tz. */
function localDayKey(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Replaces the old flat 14-day heatmap with a Mon-Sun "this week" grid: each day shows
 *  a small stack of notebook-colored dots (which modules got attention) plus a count. */
function WeekStrip({ data }: { data: DashboardData['weekGrid'] }) {
  const today = localDayKey();
  return (
    <div className="week-grid">
      {data.map((d) => (
        <div
          key={d.date}
          className={`week-grid__day${d.date === today ? ' is-today' : ''}`}
          title={`${d.dayLabel} · ${plural(d.total, 'edit')}`}
        >
          <div className="week-grid__label">{d.dayLabel}</div>
          <div className="week-grid__dots">
            {d.byNotebook.length === 0 ? (
              <span className="week-grid__dot week-grid__dot--empty" />
            ) : (
              d.byNotebook.slice(0, 5).map((nb) => <span key={nb.id} className="week-grid__dot" style={{ background: nb.color }} />)
            )}
          </div>
          <div className="week-grid__count">{d.total > 0 ? d.total : ''}</div>
        </div>
      ))}
    </div>
  );
}

function WeeklyReviewCard({ review }: { review: DashboardData['weeklyReview'] }) {
  const items: Array<{ key: string; label: string; done: boolean }> = [
    { key: 'edited', label: `${plural(review.notesEditedThisWeek, 'note')} edited this week`, done: review.notesEditedThisWeek > 0 },
    { key: 'due', label: `${plural(review.flashcardsDue, 'card')} due`, done: review.flashcardsDue === 0 },
    { key: 'summary', label: `${plural(review.notesWithoutSummary, 'note')} could use a summary`, done: review.notesWithoutSummary === 0 },
    { key: 'comments', label: `${plural(review.unresolvedComments, 'comment')} unresolved`, done: review.unresolvedComments === 0 },
  ];
  return (
    <div className="rail-card">
      <div className="rail-card__title">Weekly review</div>
      <ul className="review-checklist">
        {items.map((it) => (
          <li key={it.key} className="review-checklist__item">
            <span className={`review-checklist__box${it.done ? ' is-done' : ''}`} aria-hidden="true">
              {it.done && <Icon name="check" size={9} />}
            </span>
            {it.label}
          </li>
        ))}
      </ul>
      {review.suggestions.length > 0 && (
        <div className="review-suggestions">
          {review.suggestions.map((s) => (
            <div key={s} className="review-suggestions__item">
              {s}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RecallRow({ recall }: { recall: DashboardData['recall'] }) {
  const withHistory = recall.filter((r) => r.lastNote);
  if (withHistory.length === 0) return null;
  return (
    <section className="dash__section">
      <div className="dash__section-head">
        <h2 className="dash__section-title">Pick up where you left off</h2>
      </div>
      <div className="recall-row" data-testid="recall-row">
        {withHistory.map((entry) => (
          <RecallCard key={entry.notebook.id} entry={entry} />
        ))}
      </div>
    </section>
  );
}

function RecallCard({ entry }: { entry: DashboardData['recall'][number] }) {
  const { notebook, lastNote, quiz } = entry;
  const [flipped, setFlipped] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  if (!lastNote) return null;

  function flipBack() {
    setFlipped(false);
    setRevealed(false);
  }

  async function handleGotIt() {
    if (!quiz || submitting) return;
    setSubmitting(true);
    try {
      await api.review(quiz.cardId, 'good');
      toast('Marked as reviewed', 'ok');
      flipBack();
    } catch (e) {
      toast(errorMessage(e, 'Could not save that review'), 'error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={`recall-card${flipped ? ' is-flipped' : ''}`} onMouseEnter={() => setFlipped(true)}>
      <div className="recall-card__inner">
        <button type="button" className="recall-card__face recall-card__face--front" onClick={() => setFlipped(true)}>
          <span className="recall-card__emoji" aria-hidden="true">
            {notebook.emoji}
          </span>
          <div className="recall-card__label">Last time in {notebook.name}</div>
          <div className="recall-card__title">{lastNote.title || 'Untitled'}</div>
          <div className="recall-card__meta">{relativeTime(lastNote.updatedAt)}</div>
          {quiz && (
            <div className="recall-card__hint">
              <Icon name="sparkles" size={11} /> Tap to self-test
            </div>
          )}
        </button>

        <div className="recall-card__face recall-card__face--back">
          <button type="button" className="recall-card__back-btn" onClick={flipBack} aria-label="Back">
            <Icon name="chevron-left" size={13} />
          </button>
          <div className="recall-card__quiz-label">Quick check</div>
          {quiz ? (
            !revealed ? (
              <>
                <div className="recall-card__question">{quiz.question}</div>
                <button type="button" className="btn btn-secondary" onClick={() => setRevealed(true)}>
                  Reveal answer
                </button>
              </>
            ) : (
              <>
                <div className="recall-card__question recall-card__question--small">{quiz.question}</div>
                <div className="recall-card__answer">{quiz.answer}</div>
                <div className="recall-card__actions">
                  <button type="button" className="btn btn-primary" disabled={submitting} onClick={handleGotIt}>
                    {submitting ? <Spinner size={12} /> : 'Got it'}
                  </button>
                  <Link className="btn btn-secondary" to={`/study?notebook=${notebook.id}`}>
                    Study
                  </Link>
                </div>
              </>
            )
          ) : (
            <>
              <div className="recall-card__meta">No flashcards in this notebook yet.</div>
              <Link className="btn btn-secondary" to={`/notebook/${notebook.id}`}>
                Open notebook
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function OnboardingCreateNotebook({ onCreated }: { onCreated: (nb: Notebook) => void }) {
  const { createNotebook } = useNotebooks();
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('📓');
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setSubmitting(true);
    try {
      const nb = await createNotebook({ name: trimmed, emoji });
      toast('Notebook created', 'ok');
      onCreated(nb);
    } catch (e2) {
      toast(errorMessage(e2, 'Could not create notebook'), 'error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <EmptyState
      icon="📓"
      title="Add your first notebook"
      hint="One notebook per course or module. It is Unote's only real piece of structure. Add as many as you like, any time."
      action={
        <form className="notebook-create-form" onSubmit={submit}>
          <div className="notebook-create-form__row">
            <EmojiPicker value={emoji} onSelect={setEmoji} size={18} label="Notebook emoji" />
            <input
              className="text-input"
              aria-label="Notebook name"
              placeholder="e.g. Algorithms & Data Structures"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          <div className="notebook-suggest-chips">
            {SUGGESTED_NOTEBOOKS.map((s) => (
              <button
                key={s.name}
                type="button"
                className="chip"
                onClick={() => {
                  setName(s.name);
                  setEmoji(s.emoji);
                }}
              >
                {s.emoji} {s.name}
              </button>
            ))}
          </div>
          <button type="submit" className="btn btn-primary" disabled={!name.trim() || submitting}>
            {submitting ? <Spinner size={13} /> : <Icon name="plus" size={14} />}
            Create notebook
          </button>
        </form>
      }
    />
  );
}
