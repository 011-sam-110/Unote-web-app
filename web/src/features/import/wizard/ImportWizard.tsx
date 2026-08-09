// The full-screen "Import old notes" wizard: Source -> Ingest/Extract -> Review -> Commit.
// All three connectors are the same wizard with a different source chosen at stage 1. Nothing
// is written into a real notebook until the Review screen's Import button reaches the commit
// stage, and closing before then discards the whole staging batch.
import { useEffect, useMemo, useState } from 'react';
import './import-wizard.css';
import Icon from '../../../components/Icon';
import { api } from '../../../lib/api';
import type { ImportItem, ImportSource, NotebookLite } from '../../../lib/types';
import { CONNECTORS, getConnector } from '../connectors/registry';
import type { SourceConnector } from '../connectors/types';
import { expandArchives } from '../zipEntries';
import { ingestAndCategorise, commitItems, type IngestProgress, type CommitProgress } from './pipeline';
import ReviewStage from './ReviewStage';
// Photos do not go through stage -> categorise -> ReviewStage like documents do. They have their
// own engine (shared with the desktop import dialog and the phone capture page) because the
// question for a pile of photos is not "which notebook does each one belong in" but "which of
// these are pages of the SAME note" - and that has to be answered before filing anything.
import PhotoImportFlow from '../photos/PhotoImportFlow';

export interface ImportWizardProps {
  open: boolean;
  initialSource?: string;
  notebooks: NotebookLite[];
  onClose: () => void;
  onCommitted: () => void;
}

type Stage = 'source' | 'ingest' | 'photos' | 'review' | 'commit' | 'done';

const STEPS: Array<{ key: Stage; label: string }> = [
  { key: 'source', label: 'Source' },
  { key: 'ingest', label: 'Read' },
  { key: 'review', label: 'Review' },
  { key: 'done', label: 'Done' },
];

function msg(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong';
}

export default function ImportWizard({ open, initialSource, notebooks, onClose, onCommitted }: ImportWizardProps) {
  const [stage, setStage] = useState<Stage>('source');
  const [source, setSource] = useState<string | null>(initialSource ?? null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [availability, setAvailability] = useState<Record<string, ImportSource>>({});
  const [ingest, setIngest] = useState<IngestProgress | null>(null);
  const [ingestRunning, setIngestRunning] = useState(false);
  const [ingestDone, setIngestDone] = useState(false);
  const [items, setItems] = useState<ImportItem[]>([]);
  const [categoriser, setCategoriser] = useState('heuristic');
  const [commit, setCommit] = useState<CommitProgress | null>(null);
  const [useOcr, setUseOcr] = useState(true);
  /** Photos picked for the grouped flow. It owns its own batch, so nothing is staged here. */
  const [photoFiles, setPhotoFiles] = useState<File[]>([]);
  const [photoResult, setPhotoResult] = useState<{ created: number; failed: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Non-fatal: the import is going ahead, but not with everything the user handed over. */
  const [notice, setNotice] = useState<string | null>(null);

  // Reset on open, honouring an initial source preselect.
  useEffect(() => {
    if (!open) return;
    setStage(initialSource ? 'ingest' : 'source');
    setSource(initialSource ?? null);
    setBatchId(null);
    setIngest(null);
    setIngestRunning(false);
    setIngestDone(false);
    setItems([]);
    setCommit(null);
    setPhotoFiles([]);
    setPhotoResult(null);
    setError(null);
    setNotice(null);
    api.importSources().then(({ sources }) => setAvailability(Object.fromEntries(sources.map((s) => [s.id, s])))).catch(() => {});
  }, [open, initialSource]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && stage !== 'commit') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const connector: SourceConnector | undefined = source ? getConnector(source) : undefined;

  function isAvailable(c: SourceConnector): boolean {
    const a = availability[c.id];
    return a ? a.available : c.setup === 'none';
  }

  async function close() {
    const bId = batchId;
    onClose();
    // Discard staging unless it was committed - nothing should linger in Postgres.
    if (bId && stage !== 'done') api.discardImportBatch(bId).catch(() => {});
  }

  function pickSource(c: SourceConnector) {
    if (!isAvailable(c)) return;
    setSource(c.id);
    setStage('ingest');
    setIngest(null);
    setIngestDone(false);
  }

  async function handleFiles(fileList: FileList | File[]) {
    if (!connector) return;
    // A .zip is unpacked here rather than in the connector: `ingest` is synchronous, and
    // reading an archive is not. Entries keep their full path as the file name, so the
    // folder structure inside a Unote export becomes the same notebook signal a picked
    // folder gives - which is what makes export then import a real round trip.
    let files: File[];
    try {
      // The connector's own path filter goes in, so the archive's size budget is spent on
      // the files this source can actually read rather than on a vault's attachments.
      const expansion = await expandArchives(Array.from(fileList), connector.keepPath);
      files = expansion.files;
      // A truncated archive is a partial import, and a partial import that says nothing
      // looks exactly like a complete one. Ignored entries are not worth a line - dropping
      // `.obsidian/` config is the connector working, not a loss.
      setNotice(
        expansion.truncated > 0
          ? `This archive is larger than one import can hold, so ${expansion.truncated} file${expansion.truncated === 1 ? ' was' : 's were'} left out. Import what came through, then bring the rest over in a second pass.`
          : null,
      );
    } catch (e) {
      setError(msg(e));
      return;
    }
    const docs = connector.ingest(files);
    if (!docs.length) {
      setError('None of those files are supported by this source. Try a different source or file type.');
      return;
    }
    setError(null);

    // Photos: skip staging and categorising entirely. PhotoImportFlow reads the text, groups by
    // capture time, and runs its own review - creating its own batch, which is why none is made
    // here. Making one would leave an empty batch behind on every photo import.
    if (connector.id === 'photos') {
      const picked = docs.map((d) => d.file).filter((f): f is File => !!f);
      if (!picked.length) {
        setError('None of those files are photos. Try a different source or file type.');
        return;
      }
      setPhotoFiles(picked);
      setStage('photos');
      return;
    }

    let bId = batchId;
    try {
      if (!bId) {
        const created = await api.createImportBatch(connector.id);
        bId = created.batchId;
        setBatchId(bId);
      }
      setIngestRunning(true);
      setIngestDone(false);
      const res = await ingestAndCategorise(bId, docs, useOcr && connector.id === 'photos', setIngest);
      setItems(res.items);
      setCategoriser(res.categoriser);
      setIngestRunning(false);
      setIngestDone(true);
    } catch (e) {
      setError(msg(e));
      setIngestRunning(false);
    }
  }

  async function runCommit(itemIds: string[]) {
    if (!batchId) return;
    setStage('commit');
    setCommit({ total: itemIds.length, done: 0, created: 0, failed: 0, createdNotebooks: [] });
    try {
      await commitItems(batchId, itemIds, setCommit);
      setStage('done');
      onCommitted();
    } catch (e) {
      setError(msg(e));
      setStage('review');
    }
  }

  const activeStepIndex = useMemo(() => {
    // The photo flow covers reading AND review inside one stage, so it sits on the Read step
    // until it finishes; its own header shows where within that it has got to.
    const map: Record<Stage, number> = { source: 0, ingest: 1, photos: 1, review: 2, commit: 2, done: 3 };
    return map[stage];
  }, [stage]);

  if (!open) return null;

  return (
    <div className="iw-overlay" role="dialog" aria-modal="true" aria-label="Import old notes">
      <div className="iw-panel">
        <header className="iw-head">
          <div className="iw-head-title">
            <Icon name="upload" size={18} />
            <h2>Import old notes</h2>
          </div>
          <ol className="iw-steps" aria-hidden="true">
            {STEPS.map((s, i) => (
              <li key={s.key} className={i === activeStepIndex ? 'is-active' : i < activeStepIndex ? 'is-done' : ''}>
                <span className="iw-step-dot">{i < activeStepIndex ? <Icon name="check" size={12} /> : i + 1}</span>
                {s.label}
              </li>
            ))}
          </ol>
          <button type="button" className="iw-close" aria-label="Close import" onClick={close}>
            <Icon name="x" size={18} />
          </button>
        </header>

        <div className="iw-content">
          {stage === 'source' && (
            <div className="iw-source">
              {/* "Unote", not "Folio" - Folio is the repository name and the product is
                  called Unote in every other string in the app. */}
              <p className="iw-lead">Bring an existing pile of notes into Unote. Nothing is added to your notebooks until you review and confirm it.</p>
              <div className="iw-grid">
                {CONNECTORS.map((c) => {
                  const ok = isAvailable(c);
                  return (
                    <button key={c.id} type="button" className={`iw-tile ${ok ? '' : 'is-disabled'}`} disabled={!ok} onClick={() => pickSource(c)}>
                      <Icon name={c.icon} size={22} />
                      <span className="iw-tile-label">{c.label}</span>
                      <span className="iw-tile-desc">{ok ? c.description : c.setup === 'oauth' ? 'Needs setup' : 'Coming soon'}</span>
                    </button>
                  );
                })}
              </div>
              <p className="iw-tip"><Icon name="info" size={14} /> Dropping a folder keeps its structure as your notebooks.</p>
            </div>
          )}

          {stage === 'ingest' && connector && (
            <div className="iw-ingest">
              {!ingest && !ingestRunning ? (
                <>
                  <div
                    className={`iw-drop ${dragOver ? 'is-over' : ''}`}
                    onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={(e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); }}
                  >
                    <Icon name={connector.icon} size={30} />
                    <p className="iw-drop-title">{connector.label}</p>
                    <p className="iw-drop-hint">{connector.description}</p>
                    <div className="iw-drop-actions">
                      <label className="iw-btn iw-btn-primary">
                        Choose files
                        <input type="file" multiple accept={connector.accept} onChange={(e) => { if (e.target.files) handleFiles(e.target.files); }} hidden />
                      </label>
                      {connector.supportsFolder && (
                        <label className="iw-btn iw-btn-ghost">
                          Choose folder
                          <input
                            type="file"
                            multiple
                            ref={(el) => { if (el) { el.setAttribute('webkitdirectory', ''); el.setAttribute('directory', ''); } }}
                            onChange={(e) => { if (e.target.files) handleFiles(e.target.files); }}
                            hidden
                          />
                        </label>
                      )}
                    </div>
                  </div>
                  {connector.id === 'photos' && (
                    <>
                      <label className="iw-ocr">
                        <input type="checkbox" checked={useOcr} onChange={(e) => setUseOcr(e.target.checked)} />
                        Read the text in each photo. Needs a one-off 7MB download the first time, then it is cached.
                      </label>
                      <p className="iw-tip">
                        <Icon name="info" size={14} />
                        Photos taken close together are grouped into one note, and you can change the grouping before anything is saved.
                      </p>
                    </>
                  )}
                  <button type="button" className="iw-linkbtn" onClick={() => setStage('source')}>← Choose a different source</button>
                </>
              ) : (
                <>
                  <div className="iw-ingest-head">
                    <span>{connector.label} - reading {ingest?.total ?? 0} file{(ingest?.total ?? 0) === 1 ? '' : 's'}</span>
                    <span>{ingest?.done ?? 0} / {ingest?.total ?? 0}</span>
                  </div>
                  <div className="iw-progress"><span style={{ width: `${ingest && ingest.total ? Math.round((ingest.done / ingest.total) * 100) : 0}%` }} /></div>
                  <ul className="iw-filelist">
                    {(ingest?.files ?? []).map((f) => (
                      <li key={f.localId} className={`iw-filerow is-${f.status}`}>
                        <span className="iw-file-name" title={f.sourcePath}>{f.name}</span>
                        <span className="iw-file-status">
                          {f.status === 'staged' ? (f.words != null ? `${f.words} words` : 'ready') : f.status === 'failed' ? (f.note ?? 'failed') : f.status === 'extracting' ? 'reading…' : 'queued'}
                          {f.status === 'staged' && f.note ? ` · ${f.note}` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <div className="iw-ingest-foot">
                    <button type="button" className="iw-btn iw-btn-ghost" onClick={close}>Cancel</button>
                    <button type="button" className="iw-btn iw-btn-primary" disabled={!ingestDone || !items.length} onClick={() => setStage('review')}>
                      Continue to review →
                    </button>
                  </div>
                </>
              )}
              {notice && (
                <p className="iw-warn iw-err-block" role="status">
                  <Icon name="alert-circle" size={14} /> {notice}
                </p>
              )}
              {error && <p className="iw-err iw-err-block">{error}</p>}
            </div>
          )}

          {stage === 'photos' && (
            <div className="iw-photos">
              <PhotoImportFlow
                files={photoFiles}
                notebooks={notebooks}
                readText={useOcr}
                // Recorded so closing the WHOLE wizard discards the flow's batch too; without
                // this, an X on the dialog would leave the staged photos in Postgres forever.
                onBatchCreated={setBatchId}
                onDone={(res) => {
                  setPhotoResult(res);
                  setStage('done');
                  onCommitted();
                }}
                onCancel={() => {
                  setBatchId(null); // the flow discards its own batch on cancel
                  setPhotoFiles([]);
                  setStage('ingest');
                }}
              />
            </div>
          )}

          {stage === 'review' && batchId && (
            <ReviewStage
              batchId={batchId}
              items={items}
              setItems={setItems}
              notebooks={notebooks}
              categoriser={categoriser}
              onImport={runCommit}
              onCancel={close}
            />
          )}

          {stage === 'commit' && (
            <div className="iw-commit">
              <Icon name="upload" size={28} />
              <p className="iw-commit-title">Importing…</p>
              <div className="iw-progress"><span style={{ width: `${commit && commit.total ? Math.round((commit.done / commit.total) * 100) : 0}%` }} /></div>
              <p className="iw-commit-sub">{commit?.done ?? 0} / {commit?.total ?? 0} filed{commit && commit.createdNotebooks.length ? ` · creating ${commit.createdNotebooks.map((n) => n.name).join(', ')}` : ''}</p>
            </div>
          )}

          {stage === 'done' && (
            <div className="iw-done">
              <span className="iw-done-mark"><Icon name="check" size={26} /></span>
              {/* The photo flow reports its own totals; the document path reports commit's. */}
              <p className="iw-done-title">
                Done. {(photoResult?.created ?? commit?.created) ?? 0} note{((photoResult?.created ?? commit?.created) ?? 0) === 1 ? '' : 's'} imported
                {!photoResult && commit && commit.createdNotebooks.length ? ` into ${commit.createdNotebooks.length} new notebook${commit.createdNotebooks.length === 1 ? '' : 's'}` : ''}.
              </p>
              {photoResult && photoResult.failed > 0 && (
                <p className="iw-warn">{photoResult.failed} photo{photoResult.failed === 1 ? '' : 's'} could not be imported.</p>
              )}
              {!photoResult && commit && commit.failed > 0 && <p className="iw-warn">{commit.failed} item{commit.failed === 1 ? '' : 's'} could not be imported.</p>}
              {!photoResult && commit && commit.createdNotebooks.length > 0 && (
                <p className="iw-done-nbs">New: {commit.createdNotebooks.map((n) => n.name).join(', ')}</p>
              )}
              <button type="button" className="iw-btn iw-btn-primary" onClick={onClose}>Close</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
