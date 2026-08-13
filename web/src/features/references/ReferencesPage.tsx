// The source library: the sources a student has collected, and what is actually known
// about each one.
//
// The counts along the top are deliberately not a score. `unconfirmed` is the largest
// number on almost every real library and that is correct - most student sources carry no
// DOI and no ISBN, so there is nothing to check them against. A UI that totalled these into
// a "3 of 12 verified" bar would be inventing a target nobody can reach and teaching
// students to distrust their own honest sources.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useIsActiveTab, useTabSearchParams } from '../tabs/tabLocation';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/format';
import EmptyState from '../../components/EmptyState';
import Skeleton from '../../components/Skeleton';
import Icon from '../../components/Icon';
import GuestGate from '../guest/GuestGate';
import { useGuest } from '../guest/guestMode';
import AddSourceDialog from './AddSourceDialog';
import SourceRow from './SourceRow';
import VerdictBadge from './VerdictBadge';
import { copyToClipboard } from './ReferenceText';
import { VERDICTS } from './verdicts';
import { DEFAULT_STYLE, STYLES, type StyleId } from './styles';
import { bibliographyText, buildBibliography, isNumericStyle } from './bibliography';
import type { SourceRecord, SourceType, VerdictState } from './types';
import './references.css';

const STATES: VerdictState[] = ['verified', 'unconfirmed', 'refuted', 'unreachable'];

export default function ReferencesPage() {
  // This tab's query, not the browser's: several pages are mounted at once and a hidden
  // pane reading useSearchParams would be handed the VISIBLE tab's filter.
  const [searchParams, setSearchParams] = useTabSearchParams();
  const active = useIsActiveTab();
  const guest = useGuest();

  const [types, setTypes] = useState<SourceType[]>([]);
  const [sources, setSources] = useState<SourceRecord[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // Both the filter and the chosen style live in THIS TAB's query, so two library tabs can
  // sit side by side in two styles - which is exactly what a student with one essay in
  // Harvard and one in APA needs.
  const filter = searchParams.get('state');
  const styleParam = searchParams.get('style');
  const style: StyleId = STYLES.some((s) => s.id === styleParam) ? (styleParam as StyleId) : DEFAULT_STYLE;

  const setParam = useCallback(
    (key: 'state' | 'style', value: string | null) => {
      const next = new URLSearchParams(searchParams);
      if (value) next.set(key, value);
      else next.delete(key);
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );
  const setFilter = useCallback((next: string | null) => setParam('state', next), [setParam]);

  const load = useCallback(() => {
    if (guest) {
      setLoading(false);
      setSources([]);
      return;
    }
    setLoading(true);
    setError(null);
    Promise.all([api.referenceTypes(), api.referenceSources()])
      .then(([t, s]) => {
        setTypes(t.types);
        setSources(s.sources);
      })
      .catch((e) => setError(errorMessage(e, 'Could not load your sources')))
      .finally(() => setLoading(false));
  }, [guest]);

  useEffect(() => {
    load();
  }, [load]);

  // A window listener is singular and belongs to whichever pane is on screen. A hidden
  // library refetching on every focus would spend the account's requests answering a
  // question nobody is looking at.
  useEffect(() => {
    if (!active || guest) return;
    const onFocus = () => {
      api
        .referenceSources()
        .then((s) => setSources(s.sources))
        .catch(() => {
          // A background refresh that fails leaves what is on screen alone. The list is
          // already there and is not wrong, only possibly stale.
        });
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [active, guest]);

  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const s of sources ?? []) out[s.verdict.state] = (out[s.verdict.state] ?? 0) + 1;
    return out;
  }, [sources]);

  const shown = useMemo(
    () => (filter ? (sources ?? []).filter((s) => s.verdict.state === filter) : (sources ?? [])),
    [sources, filter],
  );

  // Ordered as the STYLE orders a reference list - alphabetically for the author-date
  // styles, in list order for Vancouver, whose numbers are the citation numbers.
  const bibliography = useMemo(() => buildBibliography(shown, style), [shown, style]);

  return (
    <div className="rf-page">
      <div className="rf-page__crumb">References</div>
      <div className="rf-page__header">
        <h1 className="rf-page__title">
          {sources && sources.length > 0
            ? `${sources.length} ${sources.length === 1 ? 'source' : 'sources'}`
            : 'Your sources'}
        </h1>
        <button type="button" className="btn btn-primary" onClick={() => setAdding(true)} disabled={guest}>
          <Icon name="plus" size={14} />
          Add a source
        </button>
      </div>
      <p className="rf-page__lead">
        Everything you might cite, and what is actually known about each one. A source nobody
        has checked reads as <strong>unconfirmed</strong> - that is the normal state for a
        lecture, an interview or a book with no ISBN, and it is not a mark against it.
      </p>

      <GuestGate
        title="A source library needs an account"
        detail="A reading list has to still be there next term, and nothing in this browser is. Your notes still work without one."
      />

      {!guest && sources && sources.length > 0 && (
        <div className="rf-styles">
          <div className="rf-styles__pick" role="group" aria-label="Referencing style">
            <span className="rf-styles__label">Style</span>
            {STYLES.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`chip${style === s.id ? ' active' : ''}`}
                aria-pressed={style === s.id}
                title={s.note}
                onClick={() => setParam('style', s.id === DEFAULT_STYLE ? null : s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={bibliography.length === 0}
            onClick={() => void copyToClipboard(bibliographyText(bibliography, style), 'Reference list')}
          >
            <Icon name="copy" size={12} />
            Copy reference list
          </button>
        </div>
      )}

      {!guest && sources && sources.length > 0 && (
        <p className="rf-styles__note">
          {STYLES.find((s) => s.id === style)?.note}.{' '}
          {isNumericStyle(style)
            ? 'Numbered in the order they appear here, which is the order the numbers in your text follow.'
            : 'Listed alphabetically, as a reference list is.'}{' '}
          Open a source to see it written out.
        </p>
      )}

      {!guest && sources && sources.length > 0 && (
        <div className="rf-filters" role="group" aria-label="Filter by what is known">
          <button
            type="button"
            className={`chip${!filter ? ' active' : ''}`}
            aria-pressed={!filter}
            onClick={() => setFilter(null)}
          >
            All {sources.length}
          </button>
          {STATES.filter((s) => counts[s]).map((s) => (
            <button
              key={s}
              type="button"
              className={`rf-filter${filter === s ? ' is-active' : ''}`}
              aria-pressed={filter === s}
              onClick={() => setFilter(filter === s ? null : s)}
            >
              <VerdictBadge state={s} size="sm" />
              <span className="rf-filter__count">{counts[s]}</span>
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="rf-list">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="rf-row rf-row--skeleton">
              <Skeleton lines={2} />
            </div>
          ))}
        </div>
      ) : error ? (
        <EmptyState
          icon="⚠️"
          title="Couldn't load your sources"
          hint={error}
          action={
            <button type="button" className="btn btn-primary" onClick={load}>
              Retry
            </button>
          }
        />
      ) : !sources || sources.length === 0 ? (
        <EmptyState
          icon="📚"
          title={guest ? 'Sources need an account' : 'No sources yet'}
          hint={
            guest
              ? 'Make an account and everything you collect stays put.'
              : 'Paste a DOI, an ISBN or a link and the details are fetched from a registry. Or type a source in yourself - a lecture or an interview has no online record to fetch, and that is not a problem.'
          }
          action={
            guest ? undefined : (
              <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
                Add your first source
              </button>
            )
          }
        />
      ) : shown.length === 0 ? (
        <EmptyState
          icon="🔎"
          title={`Nothing is ${filter}`}
          hint={filter ? VERDICTS[filter as VerdictState]?.meaning : undefined}
          action={
            <button type="button" className="btn btn-secondary" onClick={() => setFilter(null)}>
              Show all sources
            </button>
          }
        />
      ) : (
        <div className="rf-list">
          {bibliography.map((entry) => (
            <SourceRow
              key={entry.source.id}
              source={entry.source}
              types={types}
              style={style}
              number={entry.number}
              onChanged={(next) => setSources((cur) => (cur ?? []).map((x) => (x.id === next.id ? next : x)))}
              onDeleted={(id) => setSources((cur) => (cur ?? []).filter((x) => x.id !== id))}
            />
          ))}
        </div>
      )}

      <AddSourceDialog
        open={adding}
        types={types}
        onClose={() => setAdding(false)}
        onSaved={(source) => setSources((cur) => [source, ...(cur ?? [])])}
        onSavedMany={(added) => setSources((cur) => [...added, ...(cur ?? [])])}
      />
    </div>
  );
}
