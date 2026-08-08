// The bulk photo import, end to end: stage -> group -> review -> commit.
//
// One component, both surfaces. The desktop modal renders it when two or more photos are picked;
// the phone capture page renders it when the tray holds more than one. Keeping the flow in one
// place is the point - the alternative was two near-identical state machines drifting apart, which
// is how /capture ended up single-file while ImportModal quietly chained everything into one note.
import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from '../../../components/Icon';
import { api, ApiError } from '../../../lib/api';
import type { ImportItem, ImportGroupInput, NotebookLite } from '../../../lib/types';
import { ingestPhotos, commitGroups, type PhotoProgress, type PhotoCommitProgress } from './pipeline';
import { groupByCaptureTime, type GroupablePhoto } from './group';
import PhotoReview from './PhotoReview';
import './photo-import.css';

export interface PhotoImportFlowProps {
  files: File[];
  notebooks: NotebookLite[];
  /** Notebook the surface had already selected; applied to every group as the starting choice. */
  defaultNotebookId?: string | null;
  onDone: (result: { created: number; failed: number }) => void;
  onCancel: () => void;
}

type Phase = 'staging' | 'review' | 'committing' | 'error';

function msg(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return e instanceof Error ? e.message : 'Something went wrong';
}

export default function PhotoImportFlow({ files, notebooks, defaultNotebookId, onDone, onCancel }: PhotoImportFlowProps) {
  const [phase, setPhase] = useState<Phase>('staging');
  const [batchId, setBatchId] = useState<string | null>(null);
  const [progress, setProgress] = useState<PhotoProgress | null>(null);
  const [items, setItems] = useState<ImportItem[]>([]);
  const [grouper, setGrouper] = useState('capture-time');
  const [busy, setBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [ocrAvailable, setOcrAvailable] = useState(true);
  const [commit, setCommit] = useState<PhotoCommitProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Staging must run exactly once per mount: a second run would upload every photo again into a
  // second batch. React StrictMode makes that harder than it looks, and getting it wrong is not
  // loud - it is a dialog that sits at "0 of 4" forever.
  //
  // StrictMode fires effect -> cleanup -> effect. A `startedRef` alone stops the SECOND run, but
  // the FIRST run's cleanup still fires, so a per-run `cancelled` flag captured in the closure is
  // already true by the time the surviving async work checks it - and every update it makes is
  // silently dropped. `aliveRef` is re-armed by each effect invocation instead, so the simulated
  // unmount cannot kill work that is still legitimately in flight, while a real unmount still does.
  const startedRef = useRef(false);
  const aliveRef = useRef(true);
  const batchRef = useRef<string | null>(null);

  useEffect(() => {
    aliveRef.current = true;
    const stop = () => { aliveRef.current = false; };
    if (startedRef.current) return stop;
    startedRef.current = true;

    (async () => {
      try {
        const { batchId: id } = await api.createImportBatch('photos');
        batchRef.current = id; // recorded before the liveness check, so discard can still clean up
        if (!aliveRef.current) return;
        setBatchId(id);

        const result = await ingestPhotos(id, files, (p) => {
          if (aliveRef.current) setProgress(p);
        });
        if (!aliveRef.current) return;

        if (!result.items.length) {
          setError('None of these photos could be read. Try again, or pick different files.');
          setPhase('error');
          return;
        }
        setOcrAvailable(result.ocrAvailable);
        setItems(applyDefaultNotebook(result.items, defaultNotebookId ?? null));
        setPhase('review');
      } catch (err) {
        if (aliveRef.current) {
          setError(msg(err));
          setPhase('error');
        }
      }
    })();

    return stop;
  }, [files, defaultNotebookId]);

  /** Seed each group's notebook from whatever the surface had selected, so the common case
   *  ("import these into Algorithms") needs no per-group choice at all. */
  function applyDefaultNotebook(list: ImportItem[], notebookId: string | null): ImportItem[] {
    if (!notebookId) return list;
    return list.map((i) => (i.decidedNotebookId ? i : { ...i, decidedNotebookId: notebookId }));
  }

  const groupablesFrom = useCallback((list: ImportItem[]): GroupablePhoto[] =>
    list.map((i) => ({
      id: i.id,
      originalName: i.originalName,
      capturedAt: i.capturedAt ? new Date(i.capturedAt).getTime() : null,
      text: i.preview,
    })), []);

  async function saveGroups(groups: ImportGroupInput[], name: string) {
    if (!batchId) return;
    setBusy(true);
    setAiError(null);
    try {
      const res = await api.setImportGroups(batchId, { grouper: name, groups });
      setItems(res.items);
      setGrouper(res.grouper);
    } catch (err) {
      setAiError(msg(err));
    } finally {
      setBusy(false);
    }
  }

  /** Recompute the free capture-time clustering from what is already staged. */
  function regroupByTime() {
    void saveGroups(groupByCaptureTime(groupablesFrom(items)), 'capture-time');
  }

  async function regroupWithAi() {
    if (!batchId) return;
    setBusy(true);
    setAiError(null);
    try {
      const res = await api.groupImportWithAi(batchId);
      setItems(res.items);
      setGrouper(res.grouper);
    } catch (err) {
      // The photos are untouched by a failed regroup - say so, rather than implying data loss.
      setAiError(msg(err));
    } finally {
      setBusy(false);
    }
  }

  async function runCommit(groups: ImportGroupInput[]) {
    if (!batchId) return;
    setPhase('committing');
    // Persist the final arrangement first: commit reads grouping from the database, not from
    // this request, so an unsaved edit in the review screen would otherwise be silently ignored.
    try {
      const saved = await api.setImportGroups(batchId, { grouper, groups });
      setItems(saved.items);
    } catch (err) {
      setError(msg(err));
      setPhase('error');
      return;
    }
    const result = await commitGroups(batchId, groups, setCommit);
    onDone({ created: result.created, failed: result.failed });
  }

  async function discard() {
    const id = batchRef.current;
    onCancel();
    if (id) api.discardImportBatch(id).catch(() => {});
  }

  if (phase === 'error') {
    return (
      <div className="pi-state" role="alert">
        <Icon name="alert-circle" size={20} />
        <p className="pi-state-msg">{error}</p>
        <button type="button" className="iw-btn" onClick={discard}>Close</button>
      </div>
    );
  }

  if (phase === 'staging') {
    const done = progress?.done ?? 0;
    const total = progress?.total ?? files.length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    return (
      <div className="pi-state" role="status" aria-live="polite">
        <h3 className="pi-state-title">Reading {total} photo{total === 1 ? '' : 's'}</h3>
        <div className="pi-bar"><div className="pi-bar-fill" style={{ width: `${pct}%` }} /></div>
        <p className="pi-state-msg">{done} of {total} done</p>
        {/* The first photo pays for a one-off ~7MB engine download. Saying so beats a spinner
            that looks stuck on a slow connection. */}
        {done === 0 && <p className="pi-hint">Setting up the text reader - the first photo takes a moment.</p>}
        <ul className="pi-files">
          {(progress?.files ?? []).map((f) => (
            <li className={`pi-file is-${f.stage}`} key={f.localId}>
              <span className="pi-file-name">{f.name}</span>
              <span className="pi-file-state">{f.note ?? f.stage}</span>
            </li>
          ))}
        </ul>
        <button type="button" className="iw-btn" onClick={discard}>Cancel</button>
      </div>
    );
  }

  if (phase === 'committing') {
    const pct = commit && commit.totalNotes ? Math.round((commit.doneNotes / commit.totalNotes) * 100) : 0;
    return (
      <div className="pi-state" role="status" aria-live="polite">
        <h3 className="pi-state-title">Creating notes</h3>
        <div className="pi-bar"><div className="pi-bar-fill" style={{ width: `${pct}%` }} /></div>
        <p className="pi-state-msg">{commit?.created ?? 0} of {commit?.totalNotes ?? 0} created</p>
      </div>
    );
  }

  return (
    <PhotoReview
      items={items}
      notebooks={notebooks}
      grouper={grouper}
      busy={busy}
      aiError={aiError}
      ocrAvailable={ocrAvailable}
      onRegroup={saveGroups}
      onRegroupByTime={regroupByTime}
      onRegroupWithAi={regroupWithAi}
      onCommit={runCommit}
      onDiscard={discard}
    />
  );
}
