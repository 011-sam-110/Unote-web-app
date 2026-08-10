import { useCallback, useEffect, useState } from 'react';
import { useTabSearchParams } from '../tabs/tabLocation';
import { api, ApiError } from '../../lib/api';
import type { StudyStats } from '../../lib/types';
import { toast } from '../../components/Toast';
import { useNotebooks } from '../../components/NotebooksContext';
import GuestGate from '../guest/GuestGate';
import ReviewTab from './ReviewTab';
import BrowseTab from './BrowseTab';
import { studyStatsChanged } from './studyStatsBus';
import './StudyPage.css';

type Tab = 'review' | 'browse';

export default function StudyPage() {
  /* `?tab=browse` opens straight into Browse. The dashboard's "Browse cards" button
     (shown when nothing is due) linked to a bare /study and landed on Review, which then
     had nothing to review - the one state where the button is offered is the one state
     where its destination is empty. Read once, as the initial value: after that the tabs
     own the state, so switching tabs does not rewrite the URL. */
  const [searchParams] = useTabSearchParams();
  const [tab, setTab] = useState<Tab>(searchParams.get('tab') === 'browse' ? 'browse' : 'review');
  const [stats, setStats] = useState<StudyStats | null>(null);
  // Cram-one-module filter: scopes the review queue to a single notebook (fix 24).
  const [notebookFilter, setNotebookFilter] = useState<string | undefined>(undefined);
  // Bumped whenever the Review tab's "no cards at all" empty state sends the user to
  // Browse wanting to add one manually - BrowseTab pops its composer open in response.
  const [composerSignal, setComposerSignal] = useState(0);

  function goToBrowse(withComposer = false) {
    if (withComposer) setComposerSignal(s => s + 1);
    setTab('browse');
  }
  const { notebooks } = useNotebooks();
  const visibleNotebooks = notebooks.filter((n) => !n.archived);
  const filterName = notebookFilter ? visibleNotebooks.find((n) => n.id === notebookFilter)?.name : undefined;

  const refreshStats = useCallback(async () => {
    try {
      const res = await api.studyStats();
      setStats(res);
      // Tell the sidebar too. Its badge is on a 60-second poll, so without this it can
      // read "2" while this page says "Nothing due" - see studyStatsBus.
      studyStatsChanged();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not load study stats', 'error');
    }
  }, []);

  useEffect(() => {
    refreshStats();
  }, [refreshStats]);

  return (
    // data-tab drives the page's measure: a reading column for Review, a table-width
    // one for Browse. See .sy-page in StudyPage.css.
    <div className="sy-page" data-tab={tab}>
      <header className="sy-page__header">
        <div>
          {/* The section name moves up into the caption so the heading can carry the one
              thing you came here to find out: how much is waiting. */}
          <div className="sy-page__crumb">Study</div>
          <h1>
            {stats
              ? stats.due > 0
                ? `${stats.due} ${stats.due === 1 ? 'card' : 'cards'} due`
                : 'Nothing due'
              : 'Study'}
          </h1>
          <p className="sy-page__sub">
            {filterName ? `Reviewing ${filterName} only` : 'Spaced repetition across every notebook'}
          </p>
        </div>
        <div className="sy-tabs" role="tablist" aria-label="Study view">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'review'}
            className={`sy-tab${tab === 'review' ? ' is-active' : ''}`}
            onClick={() => setTab('review')}
          >
            {/* No "· N due" any more: the heading above now says it, and saying it twice
                on one line of chrome made the tab look like the more important of the two. */}
            Review
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'browse'}
            className={`sy-tab${tab === 'browse' ? ' is-active' : ''}`}
            onClick={() => setTab('browse')}
          >
            Browse{stats ? ` · ${stats.total}` : ''}
          </button>
        </div>
      </header>

      {/* Flashcards need somewhere durable to keep a schedule, so a guest sees an empty
          deck. Better to say why than to let it look like a broken page. */}
      <GuestGate
        title="Flashcards need an account"
        detail="A review schedule has to survive this browser being closed, and nothing here does. Your notes still work without one."
      />

      {tab === 'review' && visibleNotebooks.length > 1 && (
        <div className="sy-filter" role="group" aria-label="Filter review queue by notebook" data-testid="study-notebook-filter">
          <button
            type="button"
            className={`sy-filter-chip${!notebookFilter ? ' is-active' : ''}`}
            onClick={() => setNotebookFilter(undefined)}
          >
            All notebooks
          </button>
          {visibleNotebooks.map((nb) => (
            <button
              key={nb.id}
              type="button"
              className={`sy-filter-chip${notebookFilter === nb.id ? ' is-active' : ''}`}
              onClick={() => setNotebookFilter((cur) => (cur === nb.id ? undefined : nb.id))}
            >
              {nb.emoji} {nb.name}
            </button>
          ))}
        </div>
      )}

      {tab === 'review' ? (
        <ReviewTab
          key={notebookFilter ?? 'all'}
          stats={stats}
          notebookId={notebookFilter}
          onReviewed={refreshStats}
          onSwitchToBrowse={goToBrowse}
        />
      ) : (
        <BrowseTab stats={stats} onChanged={refreshStats} openComposerSignal={composerSignal} />
      )}
    </div>
  );
}
