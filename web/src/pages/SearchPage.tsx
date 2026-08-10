// search-tags agent - full-text search results page (Ctrl+Shift+F / navbar Search,
// and the destination for every "search notes →" link on the Tags page).
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTabSearchParams } from '../features/tabs/tabLocation';
import { api, getMode } from '../lib/api';
import type { SearchResult } from '../lib/types';
import { errorMessage, parseSnippetHtml, plural, relativeTime } from '../lib/format';
import Icon from '../components/Icon';
import Spinner from '../components/Spinner';
import Skeleton from '../components/Skeleton';
import EmptyState from '../components/EmptyState';
import './SearchPage.css';

type Sort = 'relevance' | 'updated' | 'title';

interface OperatorHint {
  key: string;
  label: string;
  hint: string;
  /** Text inserted at the query; caretBack moves the cursor back from the end
   *  of the inserted text (used for `""` so the cursor lands between the quotes). */
  insertText: string;
  caretBack?: number;
}

const OPERATOR_HINTS: OperatorHint[] = [
  { key: 'phrase', label: '"phrase"', hint: 'exact phrase', insertText: '""', caretBack: 1 },
  { key: 'exclude', label: '-word', hint: 'exclude a word', insertText: '-' },
  { key: 'tag', label: 'tag:name', hint: 'only that tag', insertText: 'tag:' },
  { key: 'notebook', label: 'notebook:name', hint: 'only that notebook', insertText: 'notebook:' },
];

const EXAMPLES: Array<{ q: string; label: string }> = [
  { q: '"binary search tree"', label: 'Exact phrase match' },
  { q: 'tag:week3', label: 'Everything tagged #week3' },
  { q: 'notebook:Algorithms', label: 'Only one notebook' },
  { q: 'sort -bubble', label: '"sort" but not "bubble"' },
];

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export default function SearchPage() {
  const navigate = useNavigate();
  // This tab's query, not the browser's - an inactive Search tab keeps its own terms.
  const [searchParams, setSearchParams] = useTabSearchParams();
  const initialQ = searchParams.get('q') ?? '';

  const [query, setQuery] = useState(initialQ);
  const [sort, setSort] = useState<Sort>('relevance');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [searchedFor, setSearchedFor] = useState<string | null>(null);
  const [answeredLocally, setAnsweredLocally] = useState(false);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const lastPushedRef = useRef(initialQ);
  const firstRunRef = useRef(true);
  const reqIdRef = useRef(0);

  const runSearch = useCallback((q: string) => {
    const myReq = ++reqIdRef.current;
    const trimmed = q.trim();
    if (!trimmed) {
      setResults([]);
      setError(null);
      setLoading(false);
      setDurationMs(null);
      setSearchedFor(null);
      setAnsweredLocally(false);
      return;
    }
    setLoading(true);
    setError(null);
    const start = performance.now();
    // Which index is about to answer, read at the same instant the api Proxy resolves
    // the method. Kept per request rather than read at render, so a reconnect between
    // typing and results cannot relabel a search that has already happened.
    const local = getMode() !== 'online';
    api
      .searchFull(trimmed, 50)
      .then((res) => {
        if (reqIdRef.current !== myReq) return;
        setResults(res.results);
        setDurationMs(performance.now() - start);
        setSearchedFor(trimmed);
        setAnsweredLocally(local);
      })
      .catch((e) => {
        if (reqIdRef.current !== myReq) return;
        setError(errorMessage(e, 'Search failed'));
        setResults([]);
      })
      .finally(() => {
        if (reqIdRef.current === myReq) setLoading(false);
      });
  }, []);

  // Sync the ?q= URL param → local state when it changes from OUTSIDE this page
  // (e.g. a "search notes →" link brings you here while already on /search).
  useEffect(() => {
    const urlQ = searchParams.get('q') ?? '';
    if (urlQ !== lastPushedRef.current) {
      lastPushedRef.current = urlQ;
      setQuery(urlQ);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // Local state → URL (debounced) + fire the search. Runs immediately on mount
  // (no debounce delay for the first, URL-driven query).
  useEffect(() => {
    if (firstRunRef.current) {
      firstRunRef.current = false;
      lastPushedRef.current = query;
      runSearch(query);
      return;
    }
    const t = setTimeout(() => {
      lastPushedRef.current = query;
      setSearchParams(query ? { q: query } : {}, { replace: true });
      runSearch(query);
    }, 280);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // Global "/" focuses the search box (unless the user is already typing somewhere).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === '/' && !isTypingTarget(e.target)) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const sortedResults = useMemo(() => {
    if (sort === 'relevance') return results;
    const copy = [...results];
    if (sort === 'updated') copy.sort((a, b) => new Date(b.note.updatedAt).getTime() - new Date(a.note.updatedAt).getTime());
    else copy.sort((a, b) => (a.note.title || 'Untitled').localeCompare(b.note.title || 'Untitled'));
    return copy;
  }, [results, sort]);

  function insertOperator(h: OperatorHint) {
    const base = query.trimEnd();
    const next = base ? `${base} ${h.insertText}` : h.insertText;
    setQuery(next);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const pos = next.length - (h.caretBack ?? 0);
      el.setSelectionRange(pos, pos);
    });
  }

  function onInputKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && sortedResults.length > 0) {
      e.preventDefault();
      navigate(`/note/${sortedResults[0].note.id}`);
    } else if (e.key === 'Escape' && query) {
      e.preventDefault();
      setQuery('');
    }
  }

  function renderRow(r: SearchResult) {
    const segments = parseSnippetHtml(r.snippetHtml);
    const visibleTags = r.note.tags.slice(0, 3);
    return (
      <div
        key={r.note.id}
        className="sr-row"
        role="button"
        tabIndex={0}
        data-testid="search-result"
        onClick={() => navigate(`/note/${r.note.id}`)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            navigate(`/note/${r.note.id}`);
          }
        }}
      >
        <div className="sr-row__top">
          <span className="sr-row__dot" style={{ background: r.note.notebook?.color }} aria-hidden="true" />
          <span aria-hidden="true">{r.note.notebook?.emoji}</span>
          <span className="sr-row__notebook">{r.note.notebook?.name}</span>
          {r.note.pinned && (
            <span className="sr-row__pin" aria-label="Pinned">
              <Icon name="pin-filled" size={11} />
            </span>
          )}
          <span className="sr-row__time">{relativeTime(r.note.updatedAt)}</span>
        </div>
        <div className="sr-row__title">{r.note.title || 'Untitled'}</div>
        <div className="sr-row__snippet">
          {segments.length > 0
            ? segments.map((seg, i) => (seg.mark ? <mark key={i}>{seg.text}</mark> : <span key={i}>{seg.text}</span>))
            : r.note.snippet || 'No content yet'}
        </div>
        {visibleTags.length > 0 && (
          <div className="sr-row__tags">
            {visibleTags.map((t) => (
              <span key={t} className="tag-pill">#{t}</span>
            ))}
            {r.note.tags.length > 3 && <span className="tag-pill">+{r.note.tags.length - 3}</span>}
          </div>
        )}
      </div>
    );
  }

  const trimmedQuery = query.trim();

  return (
    <div className="sr-page">
      <div className="sr-page__crumb">Search</div>
      <h1 className="sr-page__title">Everything you have written</h1>

      <div className="sr-search-box" data-tour="search-box">
        <Icon name="search" size={18} className="sr-search-box__icon" />
        <input
          ref={inputRef}
          className="sr-search-box__input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder='Search notes… try tag:week3 or "exact phrase"'
          aria-label="Search notes"
          autoFocus
          autoComplete="off"
          spellCheck={false}
        />
        {loading && <Spinner size={16} />}
        {query && !loading && (
          <button type="button" className="icon-btn" aria-label="Clear search" onClick={() => setQuery('')}>
            <Icon name="x" size={14} />
          </button>
        )}
      </div>

      <div className="sr-hints" role="group" aria-label="Search operators">
        {OPERATOR_HINTS.map((h) => (
          <button key={h.key} type="button" className="chip sr-hint" onClick={() => insertOperator(h)} title={h.hint}>
            <code>{h.label}</code>
            <span className="sr-hint__desc">{h.hint}</span>
          </button>
        ))}
      </div>

      {trimmedQuery && !loading && !error && (
        <div className="sr-meta-row">
          <span className="sr-meta-row__count">
            {plural(sortedResults.length, 'result')}
            {durationMs !== null && searchedFor === trimmedQuery ? ` in ${Math.max(1, Math.round(durationMs))}ms` : ''}
          </span>
          {/* Said out loud because the ranking genuinely differs: the index on this
              device scores with BM25, the server with ts_rank, so the same query can
              come back in a different order. Every operator still works - only the
              order moves - and an unexplained reshuffle is what makes people think
              search is broken. */}
          {answeredLocally && searchedFor === trimmedQuery && (
            <span className="sr-meta-row__local" data-testid="search-offline-badge">
              <Icon name="archive" size={11} />
              Offline search. Ranked on this device, so the order can differ.
            </span>
          )}
          <label className="sr-sort">
            <span>Sort</span>
            <select className="select-input" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              <option value="relevance">Relevance</option>
              <option value="updated">Last updated</option>
              <option value="title">Title</option>
            </select>
          </label>
        </div>
      )}

      <div className="sr-results">
        {loading ? (
          <div className="sr-skeletons">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="sr-row sr-row--skeleton">
                <Skeleton lines={3} />
              </div>
            ))}
          </div>
        ) : error ? (
          <EmptyState
            icon="⚠️"
            title="Couldn't search your notes"
            hint={error}
            action={
              <button type="button" className="btn btn-primary" onClick={() => runSearch(query)}>
                Retry
              </button>
            }
          />
        ) : !trimmedQuery ? (
          <div className="sr-tips">
            <div className="sr-tips__title">Try an operator</div>
            <div className="sr-tips__grid">
              {EXAMPLES.map((ex) => (
                <button key={ex.q} type="button" className="sr-tips__example" onClick={() => setQuery(ex.q)}>
                  <code>{ex.q}</code>
                  <span>{ex.label}</span>
                </button>
              ))}
            </div>
          </div>
        ) : sortedResults.length === 0 ? (
          <EmptyState
            icon="🔎"
            title={`No results for "${trimmedQuery}"`}
            hint="Try fewer words, check spelling, or drop a tag:/notebook: filter. You can also browse by tag instead."
            action={
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-secondary" onClick={() => setQuery('')}>
                  Clear search
                </button>
                <Link to="/tags" className="btn btn-primary">
                  Browse tags
                </Link>
              </div>
            }
          />
        ) : (
          <div className="sr-list">{sortedResults.map(renderRow)}</div>
        )}
      </div>
    </div>
  );
}
