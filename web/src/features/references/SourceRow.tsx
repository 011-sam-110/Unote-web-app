// One saved source, and everything the app is willing to claim about it.
//
// The verdict is never shown on its own. A badge with no basis and no age is an assertion;
// a badge that names WHICH registry answered, WHAT it said and HOW LONG AGO is falsifiable -
// the student can go and check. That is the difference between this and a confidence score,
// and it is why `evidence` and `checkedAt` are rendered rather than stored and forgotten.
import { useState } from 'react';
import Icon from '../../components/Icon';
import Modal from '../../components/Modal';
import { toast } from '../../components/Toast';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/format';
import SourceForm from './SourceForm';
import VerdictBadge from './VerdictBadge';
import { extraFacts, summaryLine, titleOf, typeById } from './csl';
import { isStale, presentationFor, relativeAge } from './verdicts';
import type { Csl, SourceRecord, SourceType } from './types';

export default function SourceRow({
  source,
  types,
  onChanged,
  onDeleted,
}: {
  source: SourceRecord;
  types: SourceType[];
  onChanged: (s: SourceRecord) => void;
  onDeleted: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const type = typeById(types, source.kind);
  const { verdict } = source;
  const presentation = presentationFor(verdict.state);
  const age = relativeAge(verdict.checkedAt);
  const stale = isStale(verdict.checkedAt);

  async function check() {
    setChecking(true);
    try {
      const { verdict: next } = await api.verifyReferenceSource(source.id);
      onChanged({ ...source, verdict: next });
      setOpen(true);
      toast(`Checked: ${presentationFor(next.state).label.toLowerCase()}`, next.state === 'refuted' ? 'error' : 'ok');
    } catch (e) {
      toast(errorMessage(e, 'Could not check that source'), 'error');
    } finally {
      setChecking(false);
    }
  }

  async function remove() {
    setDeleting(true);
    try {
      await api.deleteReferenceSource(source.id);
      onDeleted(source.id);
      toast('Source deleted', 'ok');
    } catch (e) {
      toast(errorMessage(e, 'Could not delete that source'), 'error');
      setDeleting(false);
    }
  }

  return (
    <article className="rf-row" data-state={verdict.state} data-testid="source-row">
      <div className="rf-row__main">
        <button
          type="button"
          className="rf-row__disclose"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="rf-row__chev" data-open={open}>
            <Icon name="chevron-right" size={13} />
          </span>
          <span className="rf-row__text">
            <span className="rf-row__title">{titleOf(source.csl)}</span>
            <span className="rf-row__summary">{summaryLine(source.csl) || 'No further details saved'}</span>
          </span>
        </button>
        <div className="rf-row__badges">
          {type && <span className="rf-row__kind">{type.label}</span>}
          <VerdictBadge state={verdict.state} size="sm" />
        </div>
      </div>

      {open && (
        <div className="rf-row__detail">
          {/* Evidence first, then what the state means, then how old it is. In that order
              because the student's question is "why does it say that", and the answer is
              the registry's sentence rather than ours. */}
          <p className="rf-row__evidence">{verdict.evidence || presentation.meaning}</p>
          <p className="rf-row__meaning">{presentation.meaning}</p>
          <p className="rf-row__age" data-stale={stale}>
            {age ? (
              <>
                Checked {age}
                {verdict.registry ? ` against ${verdict.registry}` : ''}
                {stale && ' — old enough to be worth re-checking'}
              </>
            ) : (
              'Never checked'
            )}
          </p>

          <div className="rf-row__actions">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void check()} disabled={checking}>
              <Icon name="refresh" size={12} />
              {checking ? 'Checking…' : age ? 'Check again' : 'Check now'}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>
              <Icon name="pencil" size={12} />
              Edit
            </button>
            {confirmDelete ? (
              <span className="rf-row__confirm">
                <span>Delete this source?</span>
                <button type="button" className="btn btn-danger btn-sm" onClick={() => void remove()} disabled={deleting}>
                  {deleting ? 'Deleting…' : 'Yes, delete'}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(false)} disabled={deleting}>
                  Cancel
                </button>
              </span>
            ) : (
              <button type="button" className="btn btn-ghost btn-sm rf-row__delete" onClick={() => setConfirmDelete(true)}>
                <Icon name="trash" size={12} />
                Delete
              </button>
            )}
          </div>
        </div>
      )}

      {editing && type && (
        <EditSourceDialog
          source={source}
          type={type}
          onClose={() => setEditing(false)}
          onSaved={(next) => {
            onChanged(next);
            setEditing(false);
          }}
        />
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------

/**
 * Editing clears the stored verdict SERVER-SIDE, because what was checked is no longer what
 * is stored. The dialog says so before the save rather than letting a tick quietly survive
 * a change to the title it was a tick about, and the saved record is adopted from the
 * response - so the badge that comes back is the real one, not the one we had.
 */
function EditSourceDialog({
  source,
  type,
  onClose,
  onSaved,
}: {
  source: SourceRecord;
  type: SourceType;
  onClose: () => void;
  onSaved: (s: SourceRecord) => void;
}) {
  const [csl, setCsl] = useState<Csl>(source.csl);
  const [busy, setBusy] = useState(false);
  const checked = Boolean(source.verdict.checkedAt);
  // Stored values this type has no box for. Listed rather than hidden: a saved field that
  // never appears on screen is a part of the reference the student cannot check.
  const extras = extraFacts(type, csl);

  async function save() {
    setBusy(true);
    try {
      const { source: next } = await api.updateReferenceSource(source.id, csl);
      onSaved(next);
      toast(checked ? 'Saved. The previous check no longer applies.' : 'Saved', 'ok');
    } catch (e) {
      toast(errorMessage(e, 'Could not save that source'), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={`Edit ${type.label.toLowerCase()}`} width={560}>
      <div className="rf-add">
        {checked && (
          <p className="rf-edit__warn">
            <Icon name="alert-circle" size={14} />
            <span>
              This source is currently <strong>{presentationFor(source.verdict.state).label.toLowerCase()}</strong>.
              Saving a change clears that - the thing that was checked is no longer the thing
              that is stored, and it will read as unconfirmed until you check it again.
            </span>
          </p>
        )}
        {/* The type is fixed after a source is saved: PATCH /sources/:id takes `csl` only,
            so there is nothing to send a change of kind to. Said plainly rather than
            offering a picker that would silently do nothing. */}
        <p className="rf-edit__kind">
          Type: <strong>{type.label}</strong> <span>set when the source was added</span>
        </p>
        <SourceForm type={type} csl={csl} onChange={setCsl} autoFocusFirst />
        {extras.length > 0 && (
          <>
            <p className="rf-facts__extra-note">
              Also saved on this source, though a {type.label.toLowerCase()} has no field for it.
              These are kept as they are.
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
        <div className="rf-add__actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
