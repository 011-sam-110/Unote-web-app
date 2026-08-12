// Adding a source: one box, then an honest answer.
//
// THE SPLIT IS THE FEATURE. When a registry answers, what it supplied and what it did not
// are shown as TWO SEPARATE GROUPS, and the second group is a set of empty boxes with the
// student's cursor in the first of them. Competing tools take a DOI and hand back a
// complete-looking reference with the gaps quietly filled from the shape of the other
// fields; a student cannot tell which half came from a registry and which half came from a
// guess. Here a field the registry did not supply is visibly ASKED FOR. That is the whole
// reason this feature exists, and it is why the two groups are never merged into one form
// however much tidier that would look.
//
// Typing a source in by hand is a FIRST-CLASS path, not the error branch. A lecture, an
// interview, an unpublished manuscript and a book with no ISBN have no online record at all,
// and a student with one in front of them must be able to enter it without first failing a
// lookup. It is also what works with no connection.
import { useEffect, useMemo, useState } from 'react';
import Modal from '../../components/Modal';
import Icon from '../../components/Icon';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/format';
import SourceForm from './SourceForm';
import { extraFacts, readField, splitFields, typeById, typeForCsl } from './csl';
import type { Candidate, Csl, ResolveResponse, SourceRecord, SourceType } from './types';

type Stage =
  | { at: 'ask' }
  | { at: 'found'; res: ResolveResponse; kind: string; csl: Csl }
  | { at: 'candidates'; res: ResolveResponse; query: string }
  | { at: 'nothing'; res: ResolveResponse; query: string }
  | { at: 'manual'; kind: string; csl: Csl; from?: string };

/** What the server decided the query was, said back in the student's words. Sniffing lives
 *  on the server - this only names the answer it already gave us. */
const KIND_WORD: Record<string, string> = {
  doi: 'a DOI',
  isbn: 'an ISBN',
  url: 'a link',
  query: 'a title',
};

export default function AddSourceDialog({
  open,
  types,
  onClose,
  onSaved,
}: {
  open: boolean;
  types: SourceType[];
  onClose: () => void;
  onSaved: (source: SourceRecord) => void;
}) {
  const [query, setQuery] = useState('');
  const [stage, setStage] = useState<Stage>({ at: 'ask' });
  const [busy, setBusy] = useState<null | 'resolve' | 'save'>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingFound, setEditingFound] = useState(false);

  // Reopening starts over. A dialog that reopens onto the last lookup's answer is one of
  // the ways a student ends up saving somebody else's source.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setStage({ at: 'ask' });
    setBusy(null);
    setError(null);
    setEditingFound(false);
  }, [open]);

  async function lookUp(text: string) {
    const q = text.trim();
    if (!q) return;
    setBusy('resolve');
    setError(null);
    try {
      const res = await api.resolveReference(q);
      if (res.kind === 'query') {
        setStage(res.candidates.length ? { at: 'candidates', res, query: q } : { at: 'nothing', res, query: q });
        return;
      }
      if (!res.found || !res.csl) {
        setStage({ at: 'nothing', res, query: q });
        return;
      }
      setEditingFound(false);
      setStage({ at: 'found', res, kind: typeForCsl(res.csl, types), csl: res.csl });
    } catch (e) {
      setError(errorMessage(e, 'That lookup did not work'));
    } finally {
      setBusy(null);
    }
  }

  /** Choosing a search result re-asks the REGISTRY by DOI rather than keeping the fields
   *  off the search index. The index is a summary; the registry record is the source. */
  function useCandidate(c: Candidate) {
    setQuery(c.doi);
    void lookUp(c.doi);
  }

  function startManual(kind: string, csl: Csl = {}, from?: string) {
    setStage({ at: 'manual', kind, csl, from });
    setError(null);
  }

  async function save(kind: string, csl: Csl, alsoCheck: boolean) {
    setBusy('save');
    setError(null);
    try {
      const { source } = await api.createReferenceSource({ kind, csl });
      let saved = source;
      if (alsoCheck) {
        // A separate act, and it says so on the button. Resolving fetched a record;
        // checking compares what is now SAVED against the registry, which is a different
        // question and the only one a verdict is allowed to answer.
        try {
          const { verdict } = await api.verifyReferenceSource(source.id);
          saved = { ...source, verdict };
        } catch {
          // The save succeeded. Leaving the verdict as `unconfirmed` is the true state,
          // and the row's own Check button is right there.
        }
      }
      onSaved(saved);
      onClose();
    } catch (e) {
      setError(errorMessage(e, 'Could not save that source'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add a source" width={620}>
      <div className="rf-add">
        {stage.at === 'ask' && (
          <AskStage
            query={query}
            setQuery={setQuery}
            busy={busy === 'resolve'}
            onLookUp={() => void lookUp(query)}
            onManual={() => startManual('website')}
          />
        )}

        {stage.at === 'found' && (
          <FoundStage
            stage={stage}
            types={types}
            editingFound={editingFound}
            setEditingFound={setEditingFound}
            onKind={(kind) => setStage({ ...stage, kind })}
            onCsl={(csl) => setStage({ ...stage, csl })}
            onBack={() => setStage({ at: 'ask' })}
            busy={busy === 'save'}
            onSave={() => void save(stage.kind, stage.csl, true)}
          />
        )}

        {stage.at === 'candidates' && (
          <CandidateStage
            stage={stage}
            busy={busy === 'resolve'}
            onPick={useCandidate}
            onBack={() => setStage({ at: 'ask' })}
            onManual={() => startManual('journal', { title: stage.query }, stage.query)}
          />
        )}

        {stage.at === 'nothing' && (
          <NothingStage
            stage={stage}
            onBack={() => setStage({ at: 'ask' })}
            onManual={() =>
              startManual(
                stage.res.kind === 'url' ? 'website' : stage.res.kind === 'isbn' ? 'book' : 'journal',
                // Only a link and a title are seeded, and only into the field they belong
                // in. A raw DOI or ISBN query is NOT copied into csl.DOI/csl.ISBN: the
                // string a student pasted is often a doi.org URL rather than the bare
                // identifier, and storing that would make the next check resolve a
                // nonsense URL and come back REFUTED - a false accusation, manufactured by
                // us, on a source that may be perfectly real.
                stage.res.kind === 'url'
                  ? { URL: stage.query }
                  : stage.res.kind === 'query'
                    ? { title: stage.query }
                    : {},
                stage.query,
              )
            }
          />
        )}

        {stage.at === 'manual' && (
          <ManualStage
            stage={stage}
            types={types}
            onKind={(kind) => setStage({ ...stage, kind })}
            onCsl={(csl) => setStage({ ...stage, csl })}
            onBack={() => setStage({ at: 'ask' })}
            busy={busy === 'save'}
            onSave={() => void save(stage.kind, stage.csl, false)}
          />
        )}

        {error && (
          <p className="rf-add__error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function AskStage({
  query,
  setQuery,
  busy,
  onLookUp,
  onManual,
}: {
  query: string;
  setQuery: (s: string) => void;
  busy: boolean;
  onLookUp: () => void;
  onManual: () => void;
}) {
  return (
    <>
      <p className="rf-add__lead">
        Paste a DOI, an ISBN, a link, or type the title. You do not have to say which - the
        server works it out.
      </p>
      <div className="rf-add__row">
        <input
          className="text-input rf-add__input"
          value={query}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          placeholder="10.1038/nature12373"
          aria-label="DOI, ISBN, link or title"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !busy) {
              e.preventDefault();
              onLookUp();
            }
          }}
        />
        <button type="button" className="btn btn-primary" disabled={busy || !query.trim()} onClick={onLookUp}>
          {busy ? 'Looking…' : 'Look it up'}
        </button>
      </div>

      {/* Not a fallback, and positioned so it does not read as one. Plenty of real sources
          have no online record: a lecture, an interview, an unpublished manuscript, a book
          older than any registry. This is also the path that works on a train. */}
      <div className="rf-add__alt">
        <div className="rf-add__alt-line" />
        <span>or</span>
        <div className="rf-add__alt-line" />
      </div>
      <button type="button" className="btn btn-secondary rf-add__manual" onClick={onManual}>
        <Icon name="pencil" size={13} />
        Type a source in yourself
      </button>
      <p className="rf-add__note">
        Nothing is looked up on this path, so nothing is filled in for you - which is the
        point when the source is a lecture, an interview or a book with no ISBN.
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------

function TypePicker({
  types,
  value,
  onChange,
  label = 'Source type',
}: {
  types: SourceType[];
  value: string;
  onChange: (id: string) => void;
  label?: string;
}) {
  return (
    <div className="rf-field rf-add__type">
      <label className="field-label" htmlFor="rf-type">
        {label}
      </label>
      <select id="rf-type" className="select-input" value={value} onChange={(e) => onChange(e.target.value)}>
        {types.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function FoundStage({
  stage,
  types,
  editingFound,
  setEditingFound,
  onKind,
  onCsl,
  onBack,
  busy,
  onSave,
}: {
  stage: Extract<Stage, { at: 'found' }>;
  types: SourceType[];
  editingFound: boolean;
  setEditingFound: (b: boolean) => void;
  onKind: (id: string) => void;
  onCsl: (csl: Csl) => void;
  onBack: () => void;
  busy: boolean;
  onSave: () => void;
}) {
  const type = typeById(types, stage.kind) ?? types[0];
  const split = useMemo(
    () => (type ? splitFields(type, stage.csl, stage.res.missing) : null),
    [type, stage.csl, stage.res.missing],
  );
  const extras = useMemo(() => (type ? extraFacts(type, stage.csl) : []), [type, stage.csl]);
  const registry = stage.res.registry ?? 'the registry';
  if (!type || !split) return null;

  return (
    <>
      <p className="rf-add__lead">
        That looked like {KIND_WORD[stage.res.kind] ?? 'an identifier'}, and{' '}
        <strong>{registry}</strong> had a record for it.
      </p>

      <TypePicker types={types} value={stage.kind} onChange={onKind} />

      {/* ---- group one: what a registry actually said ---- */}
      <section className="rf-group rf-group--found">
        <header className="rf-group__head">
          <h3 className="rf-group__title">
            <Icon name="check" size={13} />
            Found by {registry}
          </h3>
          <span className="rf-group__count">{split.found.length + extras.length}</span>
          <button type="button" className="btn btn-ghost btn-sm rf-group__edit" onClick={() => setEditingFound(!editingFound)}>
            {editingFound ? 'Done' : 'Correct these'}
          </button>
        </header>
        {editingFound ? (
          <SourceForm type={{ ...type, fields: split.found }} csl={stage.csl} onChange={onCsl} />
        ) : (
          <dl className="rf-facts">
            {split.found.map((f) => (
              <div className="rf-facts__row" key={f.csl}>
                <dt>{f.label}</dt>
                <dd>{readField(stage.csl, f)}</dd>
              </div>
            ))}
          </dl>
        )}
        {/* Saved, and therefore shown. These are values this TYPE has no box for - which
            usually means the type above is wrong, and this is what makes that visible
            instead of leaving a journal's volume and pages stored but named nowhere. */}
        {extras.length > 0 && (
          <>
            <p className="rf-facts__extra-note">
              Also saved, though a {type.label.toLowerCase()} has no field for it. If that looks
              wrong, change the type above.
            </p>
            <dl className="rf-facts rf-facts--extra">
              {extras.map((f) => (
                <div className="rf-facts__row" key={f.key}>
                  <dt>{f.label}</dt>
                  <dd>{f.value}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </section>

      {/* ---- group two: what it did not, asked for rather than invented ---- */}
      <section className="rf-group rf-group--needed">
        <header className="rf-group__head">
          <h3 className="rf-group__title">
            <Icon name="alert-circle" size={13} />
            {registry} did not supply these
          </h3>
          <span className="rf-group__count">{split.needed.length}</span>
        </header>
        {split.needed.length === 0 ? (
          <p className="rf-group__empty">
            Every field this type cites came back filled in. Nothing was guessed to get there.
          </p>
        ) : (
          <>
            <p className="rf-group__note">
              None of these were filled in for you. Add what you can from the source itself -
              a box left empty stays empty rather than becoming a plausible-looking guess.
            </p>
            <SourceForm
              type={{ ...type, fields: split.needed }}
              csl={stage.csl}
              onChange={onCsl}
              autoFocusFirst
              reportedMissing={split.reportedMissing}
            />
          </>
        )}
      </section>

      <div className="rf-add__actions">
        <button type="button" className="btn btn-secondary" onClick={onBack} disabled={busy}>
          Back
        </button>
        <button type="button" className="btn btn-primary" onClick={onSave} disabled={busy}>
          {busy ? 'Saving…' : 'Save and check'}
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

function CandidateStage({
  stage,
  busy,
  onPick,
  onBack,
  onManual,
}: {
  stage: Extract<Stage, { at: 'candidates' }>;
  busy: boolean;
  onPick: (c: Candidate) => void;
  onBack: () => void;
  onManual: () => void;
}) {
  return (
    <>
      <p className="rf-add__lead">
        That was a title rather than an identifier, so here is what the registry has.{' '}
        <strong>Pick the one you meant</strong> - the details are then taken from the
        registry's own record, not from this list.
      </p>
      <ul className="rf-candidates">
        {stage.res.candidates.map((c) => (
          <li key={c.doi}>
            <button type="button" className="rf-candidate" disabled={busy} onClick={() => onPick(c)}>
              <span className="rf-candidate__title">{c.title}</span>
              <span className="rf-candidate__meta">
                {[c.authors.slice(0, 3).join(', '), c.containerTitle, c.year].filter(Boolean).join(' · ')}
              </span>
              <span className="rf-candidate__doi">{c.doi}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="rf-add__actions">
        <button type="button" className="btn btn-secondary" onClick={onBack} disabled={busy}>
          Back
        </button>
        <button type="button" className="btn btn-ghost" onClick={onManual} disabled={busy}>
          None of these - type it in
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

function NothingStage({
  stage,
  onBack,
  onManual,
}: {
  stage: Extract<Stage, { at: 'nothing' }>;
  onBack: () => void;
  onManual: () => void;
}) {
  return (
    <>
      {/* The server's own words, shown verbatim and NOT classified here. Whether a failure
          means "no record" or "could not ask" is the server's judgement to make, and
          re-deciding it on this side by pattern-matching the sentence would be a second,
          disagreeing implementation of the one distinction the feature turns on. */}
      <div className="rf-nothing">
        <h3 className="rf-nothing__title">Nothing came back for that</h3>
        <p className="rf-nothing__query">{stage.query}</p>
        {stage.res.reason && <p className="rf-nothing__reason">{stage.res.reason}</p>}
        <p className="rf-nothing__meaning">
          This is not a judgement about the source. A lookup finding nothing means the
          registry has no record to show - plenty of real sources have none.
        </p>
      </div>
      <div className="rf-add__actions">
        <button type="button" className="btn btn-secondary" onClick={onBack}>
          Try something else
        </button>
        <button type="button" className="btn btn-primary" onClick={onManual}>
          Type it in yourself
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

function ManualStage({
  stage,
  types,
  onKind,
  onCsl,
  onBack,
  busy,
  onSave,
}: {
  stage: Extract<Stage, { at: 'manual' }>;
  types: SourceType[];
  onKind: (id: string) => void;
  onCsl: (csl: Csl) => void;
  onBack: () => void;
  busy: boolean;
  onSave: () => void;
}) {
  const type = typeById(types, stage.kind) ?? types[0];
  if (!type) return null;
  const hasTitle = typeof stage.csl.title === 'string' && stage.csl.title.trim() !== '';

  return (
    <>
      <p className="rf-add__lead">
        Type it in from the source in front of you. Nothing here is looked up, so nothing is
        filled in for you - it will be saved as <strong>unconfirmed</strong>, which is the
        honest state for a source nobody has checked, not a mark against it.
      </p>
      {stage.from && <p className="rf-add__from">Started from: {stage.from}</p>}
      <TypePicker types={types} value={stage.kind} onChange={onKind} />
      <SourceForm type={type} csl={stage.csl} onChange={onCsl} autoFocusFirst />
      <div className="rf-add__actions">
        <button type="button" className="btn btn-secondary" onClick={onBack} disabled={busy}>
          Back
        </button>
        <button type="button" className="btn btn-primary" onClick={onSave} disabled={busy || !hasTitle}>
          {busy ? 'Saving…' : 'Save to library'}
        </button>
      </div>
      {!hasTitle && <p className="rf-add__note">A title is the one field a reference cannot do without.</p>}
    </>
  );
}
