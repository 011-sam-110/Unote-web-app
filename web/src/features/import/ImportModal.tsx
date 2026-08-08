// Desktop import dialog: 3 kind tabs, drag-drop + click-to-browse, notebook
// select OR (when `noteId` is given) a target-note context + append/improve
// mode radio, multi-page photo chaining, and a live job stepper.
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import Modal from '../../components/Modal';
import Icon from '../../components/Icon';
import { toast } from '../../components/Toast';
import { api, ApiError } from '../../lib/api';
import type { Note, Notebook } from '../../lib/types';
import { IMPORT_KINDS, findKind, formatBytes, validateFile, type ImportKind } from './kinds';
import { downscaleImage } from './downscale';
import { useImportJob } from './useImportJob';
import ImportProgress from './ImportProgress';
import './import-ui.css';
import './ImportModal.css';

// Lazily loaded: the lecture flow pulls in frame analysis and (via its worker) transformers.js,
// which no one importing a photo should have to download.
const LectureImport = lazy(() => import('./lecture/LectureImport'));
// Also lazy: the bulk photo flow drags in the review screen and (on first photo) the OCR engine.
// Someone importing a single page should download none of it.
const PhotoImportFlow = lazy(() => import('./photos/PhotoImportFlow'));

export interface ImportModalProps {
  open: boolean;
  onClose: () => void;
  notebookId?: string;
  noteId?: string;
  /** 'lecture' opens the client-side lecture-video flow; the rest are the server-backed kinds. */
  defaultKind?: 'photo' | 'slides' | 'transcript' | 'lecture';
  /** Fired when an import completes successfully, with the resulting note id. Lets a host
   *  (e.g. the open note) resync its editor when the import targeted it. */
  onImported?: (resultNoteId: string) => void;
}

type MergeMode = 'append' | 'improve';
/** 'bulk' is the multi-photo path: stage every photo, group them, review, then commit. */
type Phase = 'pick' | 'running' | 'bulk' | 'done' | 'error';
/** The server-backed kinds, plus the fully client-side lecture-video flow. */
type TabKey = ImportKind | 'lecture';

interface ChainState {
  index: number;
  mode: 'new' | MergeMode;
  noteId?: string;
}

export default function ImportModal({ open, onClose, notebookId, noteId, defaultKind, onImported }: ImportModalProps) {
  const [kind, setKind] = useState<TabKey>(defaultKind ?? 'photo');
  const [lectureBusy, setLectureBusy] = useState(false);
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [notebooksLoading, setNotebooksLoading] = useState(false);
  const [selectedNotebookId, setSelectedNotebookId] = useState<string>(notebookId ?? '');
  const [targetNote, setTargetNote] = useState<Note | null>(null);
  const [targetNoteLoading, setTargetNoteLoading] = useState(false);
  const [mergeMode, setMergeMode] = useState<MergeMode>('append');
  const [files, setFiles] = useState<File[]>([]);
  const [pagePreviews, setPagePreviews] = useState<string[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('pick');
  const [pageProgress, setPageProgress] = useState<{ index: number; total: number } | null>(null);
  const [resultNoteId, setResultNoteId] = useState<string | null>(null);
  const [resultTitle, setResultTitle] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chainRef = useRef<ChainState>({ index: 0, mode: 'new' });
  const navigate = useNavigate();
  const { job, run, reset } = useImportJob();

  // The lecture tab has its own flow; everything below this line is the server-backed path,
  // so it works against a narrowed kind that is always one the API accepts.
  const serverKind: ImportKind = kind === 'lecture' ? 'slides' : kind;
  const kindMeta = useMemo(() => findKind(serverKind), [serverKind]);

  // Fresh state every time the modal is opened.
  useEffect(() => {
    if (!open) return;
    setKind(defaultKind ?? 'photo');
    setFiles([]);
    setValidationError(null);
    setPhase('pick');
    setPageProgress(null);
    setResultNoteId(null);
    setResultTitle(null);
    setErrorMessage(null);
    setMergeMode('append');
    chainRef.current = { index: 0, mode: 'new' };
    reset();
  }, [open, defaultKind, reset]);

  useEffect(() => {
    if (!open || noteId) return;
    let cancelled = false;
    setNotebooksLoading(true);
    api.notebooks()
      .then(res => { if (!cancelled) setNotebooks(res.notebooks); })
      .catch(() => { if (!cancelled) toast('Could not load notebooks', 'error'); })
      .finally(() => { if (!cancelled) setNotebooksLoading(false); });
    return () => { cancelled = true; };
  }, [open, noteId]);

  useEffect(() => {
    if (notebookId) { setSelectedNotebookId(notebookId); return; }
    setSelectedNotebookId(prev => prev || notebooks[0]?.id || '');
  }, [notebookId, notebooks]);

  useEffect(() => {
    if (!open || !noteId) { setTargetNote(null); return; }
    let cancelled = false;
    setTargetNoteLoading(true);
    api.note(noteId)
      .then(res => { if (!cancelled) setTargetNote(res.note); })
      .catch(() => { if (!cancelled) toast('Could not load the target note', 'error'); })
      .finally(() => { if (!cancelled) setTargetNoteLoading(false); });
    return () => { cancelled = true; };
  }, [open, noteId]);

  // Layout effect (not a plain effect) so the new object URLs are committed
  // before paint - otherwise adding/removing a page briefly renders
  // thumbnails against a stale, index-shifted URL list.
  useLayoutEffect(() => {
    if (kind !== 'photo' || files.length === 0) { setPagePreviews([]); return; }
    const urls = files.map(f => URL.createObjectURL(f));
    setPagePreviews(urls);
    return () => { urls.forEach(u => URL.revokeObjectURL(u)); };
  }, [files, kind]);

  function handleKindChange(next: TabKey) {
    if (phase === 'running' || phase === 'bulk' || lectureBusy) return;
    setKind(next);
    setFiles([]);
    setValidationError(null);
  }

  function addFiles(list: FileList | File[]) {
    const incoming = Array.from(list);
    if (incoming.length === 0) return;
    const errors: string[] = [];
    const valid: File[] = [];
    for (const f of incoming) {
      const err = validateFile(f, serverKind);
      if (err) errors.push(err); else valid.push(f);
    }
    setValidationError(errors.length ? errors.join(' · ') : null);
    if (valid.length === 0) return;
    setFiles(prev => (kind === 'photo' ? [...prev, ...valid] : valid.slice(0, 1)));
  }

  function removeFile(index: number) {
    setFiles(prev => prev.filter((_, i) => i !== index));
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    if (phase === 'running') return;
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  }

  function onDropZoneKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInputRef.current?.click();
    }
  }

  function onFileInputChange(e: ChangeEvent<HTMLInputElement>) {
    if (e.target.files) addFiles(e.target.files);
    e.target.value = '';
  }

  async function runChain() {
    setPhase('running');
    setErrorMessage(null);
    try {
      while (chainRef.current.index < files.length) {
        const i = chainRef.current.index;
        setPageProgress({ index: i, total: files.length });
        const raw = files[i];
        const uploadFile = kind === 'photo' ? await downscaleImage(raw) : raw;
        const form = new FormData();
        form.append('file', uploadFile);
        form.append('kind', serverKind);
        form.append('mode', chainRef.current.mode);
        if (chainRef.current.mode === 'new') {
          form.append('notebookId', selectedNotebookId);
        } else {
          form.append('noteId', chainRef.current.noteId ?? '');
        }
        const { jobId } = await api.import(form);
        const result = await run(jobId);
        if (result.status === 'failed') {
          setErrorMessage(result.error ?? 'Import failed');
          setPhase('error');
          return;
        }
        if (result.noteId) chainRef.current.noteId = result.noteId;
        chainRef.current.mode = 'append';
        chainRef.current.index = i + 1;
      }
      const finalNoteId = chainRef.current.noteId ?? null;
      setResultNoteId(finalNoteId);
      if (finalNoteId) {
        try {
          const res = await api.note(finalNoteId);
          setResultTitle(res.note.title || 'Untitled note');
        } catch {
          setResultTitle(null);
        }
        onImported?.(finalNoteId);
      }
      setPhase('done');
    } catch (err) {
      setErrorMessage(err instanceof ApiError ? err.message : 'Import failed. Check the server is running');
      setPhase('error');
    }
  }

  function handleSubmit() {
    if (files.length === 0) { setValidationError('Add a file to import'); return; }
    if (!noteId && !selectedNotebookId) { setValidationError('Choose a notebook'); return; }

    // Several photos, and no note to add them to: this is a roll off someone's phone, not the
    // pages of one handout. Hand it to the bulk flow, which reads the text locally (no AI
    // quota), works out which photos belong together, and lets the user check before anything
    // is written. The old behaviour - chaining every photo into ONE note, one slow AI call at a
    // time - is still exactly right when the modal was opened against a note, so that stays.
    if (kind === 'photo' && files.length > 1 && !noteId) {
      setValidationError(null);
      setPhase('bulk');
      return;
    }

    chainRef.current = { index: 0, mode: noteId ? mergeMode : 'new', noteId };
    runChain();
  }

  function handleOpenNote() {
    if (!resultNoteId) return;
    navigate(`/note/${resultNoteId}`);
    onClose();
  }

  const canSubmit = files.length > 0 && (noteId ? true : !!selectedNotebookId);
  const runningOnClose = phase === 'running' || phase === 'bulk' || lectureBusy ? () => {} : onClose;
  // A lecture import always produces a NEW note, so it has nothing to offer when the modal was
  // opened to add material to an existing one.
  const showLectureTab = !noteId;

  return (
    <Modal open={open} onClose={runningOnClose} title="Import" width={phase === 'bulk' ? 900 : 560}>
      <div className="im-modal">
        <div className="im-modal__kinds" role="tablist" aria-label="Import kind">
          {IMPORT_KINDS.map(k => (
            <button
              key={k.key}
              type="button"
              role="tab"
              aria-selected={kind === k.key}
              className={`im-tab${kind === k.key ? ' is-active' : ''}`}
              disabled={phase === 'running' || phase === 'bulk'}
              onClick={() => handleKindChange(k.key)}
            >
              <Icon name={k.iconName} size={14} /> {k.label}
            </button>
          ))}
          {showLectureTab && (
            <button
              type="button"
              role="tab"
              aria-selected={kind === 'lecture'}
              className={`im-tab${kind === 'lecture' ? ' is-active' : ''}`}
              disabled={phase === 'running' || phase === 'bulk' || lectureBusy}
              onClick={() => handleKindChange('lecture')}
            >
              <Icon name="camera" size={14} /> Lecture video
            </button>
          )}
        </div>

        {kind === 'lecture' ? (
          <>
            <label className="im-field">
              <span>Notebook</span>
              <select
                value={selectedNotebookId}
                onChange={e => setSelectedNotebookId(e.target.value)}
                disabled={notebooksLoading || lectureBusy}
              >
                {notebooksLoading && <option value="">Loading…</option>}
                {!notebooksLoading && notebooks.length === 0 && <option value="">No notebooks yet</option>}
                {notebooks.map(nb => (
                  <option key={nb.id} value={nb.id}>{nb.emoji} {nb.name}</option>
                ))}
              </select>
            </label>
            <Suspense fallback={<div className="im-target__loading">Loading…</div>}>
              <LectureImport
                notebookId={selectedNotebookId}
                onBusyChange={setLectureBusy}
                onClose={onClose}
                onImported={onImported}
              />
            </Suspense>
          </>
        ) : (
        <>
        {phase === 'pick' && (
          <>
            {noteId ? (
              <div className="im-target">
                {targetNoteLoading ? (
                  <div className="im-target__loading">Loading note…</div>
                ) : targetNote ? (
                  <>
                    <div className="im-target__note">
                      <span className="im-chip im-chip--static">
                        <span className="im-notebook-dot" style={{ background: targetNote.notebook.color }} />
                        {targetNote.notebook.emoji} {targetNote.notebook.name}
                      </span>
                      <span className="im-target__title">{targetNote.title || 'Untitled'}</span>
                    </div>
                    <div className="im-mode">
                      <label className={`im-mode-option${mergeMode === 'append' ? ' is-active' : ''}`}>
                        <input type="radio" name="import-merge-mode" value="append" checked={mergeMode === 'append'} onChange={() => setMergeMode('append')} />
                        <span><strong>Append</strong>: add to the end of the note</span>
                      </label>
                      <label className={`im-mode-option${mergeMode === 'improve' ? ' is-active' : ''}`}>
                        <input type="radio" name="import-merge-mode" value="improve" checked={mergeMode === 'improve'} onChange={() => setMergeMode('improve')} />
                        <span><strong>Improve &amp; merge</strong>: AI blends this into the existing note</span>
                      </label>
                    </div>
                  </>
                ) : (
                  <div className="im-target__loading">Note unavailable</div>
                )}
              </div>
            ) : (
              <label className="im-field">
                <span>Notebook</span>
                <select value={selectedNotebookId} onChange={e => setSelectedNotebookId(e.target.value)} disabled={notebooksLoading}>
                  {notebooksLoading && <option value="">Loading…</option>}
                  {!notebooksLoading && notebooks.length === 0 && <option value="">No notebooks yet</option>}
                  {notebooks.map(nb => (
                    <option key={nb.id} value={nb.id}>{nb.emoji} {nb.name}</option>
                  ))}
                </select>
              </label>
            )}

            <div
              className={`im-drop${dragActive ? ' is-active' : ''}`}
              onDragOver={e => { e.preventDefault(); setDragActive(true); }}
              onDragLeave={() => setDragActive(false)}
              onDrop={onDrop}
              onClick={() => fileInputRef.current?.click()}
              role="button"
              tabIndex={0}
              aria-label={`Drop or browse for ${kindMeta.label.toLowerCase()}`}
              onKeyDown={onDropZoneKeyDown}
            >
              <div className="im-drop__icon" aria-hidden="true"><Icon name={kindMeta.iconName} size={26} /></div>
              <div className="im-drop__label">Drop {kindMeta.label.toLowerCase()} here, or click to browse</div>
              <div className="im-drop__hint">{kindMeta.hint}</div>
              <input
                ref={fileInputRef}
                type="file"
                accept={kindMeta.accept}
                multiple={kind === 'photo'}
                hidden
                onChange={onFileInputChange}
              />
            </div>

            {/* File-picker rejections (wrong type, too large) were shown but never
                announced, so the import just appeared not to respond. */}
            {validationError && <div className="im-error-inline" role="alert">{validationError}</div>}

            {files.length > 0 && (
              kind === 'photo' ? (
                <div className="im-pages">
                  {files.map((f, i) => (
                    <div className="im-page" key={`${f.name}-${i}`}>
                      <img src={pagePreviews[i]} alt={`Page ${i + 1}`} />
                      <button type="button" className="im-page__remove" aria-label={`Remove page ${i + 1}`} onClick={() => removeFile(i)}>×</button>
                      <span className="im-page__num">{i + 1}</span>
                    </div>
                  ))}
                  <button type="button" className="im-page im-page--add" onClick={() => fileInputRef.current?.click()}>
                    + Add page
                  </button>
                </div>
              ) : null
            )}

            {kind === 'photo' && !noteId && files.length > 1 && (
              <p className="im-hint" role="status">
                We&apos;ll sort these into notes by when they were taken, and show you the grouping before anything is saved.
              </p>
            )}

            {files.length > 0 && kind !== 'photo' && (
              <div className="im-files">
                {files.map((f, i) => (
                  <div className="im-file-card" key={f.name}>
                    <span className="im-file-card__icon" aria-hidden="true"><Icon name={kindMeta.iconName} size={18} /></span>
                    <div className="im-file-card__meta">
                      <div className="im-file-card__name">{f.name}</div>
                      <div className="im-file-card__size">{formatBytes(f.size)}</div>
                    </div>
                    <button type="button" className="im-icon-btn" aria-label="Remove file" onClick={() => removeFile(i)}>×</button>
                  </div>
                ))}
              </div>
            )}

            <div className="im-footer">
              <button type="button" className="im-btn" onClick={onClose}>Cancel</button>
              <button type="button" className="im-btn im-btn--primary" disabled={!canSubmit} onClick={handleSubmit}>
                {files.length > 1
                  ? (kind === 'photo' && !noteId ? `Import ${files.length} photos` : `Import ${files.length} pages`)
                  : 'Import'}
              </button>
            </div>
          </>
        )}

        {phase === 'running' && (
          <ImportProgress job={job} pageInfo={pageProgress ?? undefined} />
        )}

        {phase === 'bulk' && (
          <Suspense fallback={<div className="im-target__loading">Loading…</div>}>
            <PhotoImportFlow
              files={files}
              notebooks={notebooks}
              defaultNotebookId={selectedNotebookId || null}
              onDone={({ created, failed }) => {
                toast(
                  failed > 0
                    ? `Created ${created} note${created === 1 ? '' : 's'}, ${failed} failed`
                    : `Created ${created} note${created === 1 ? '' : 's'}`,
                  failed > 0 ? 'error' : 'ok',
                );
                onClose();
              }}
              onCancel={() => { setPhase('pick'); setFiles([]); }}
            />
          </Suspense>
        )}

        {phase === 'done' && (
          <div className="im-result">
            <div className="im-result__icon im-result__icon--ok" aria-hidden="true">✓</div>
            <div className="im-result__title">Note ready</div>
            {resultTitle && <div className="im-result__name">{resultTitle}</div>}
            <div className="im-footer">
              <button type="button" className="im-btn" onClick={onClose}>Close</button>
              <button type="button" className="im-btn im-btn--primary" onClick={handleOpenNote}>Open note</button>
            </div>
          </div>
        )}

        {/* ImportProgress covers the running phase; the terminal error pane sat
            outside it and was silent. */}
        {phase === 'error' && (
          <div className="im-result" role="alert">
            <div className="im-result__icon im-result__icon--error" aria-hidden="true">⚠️</div>
            <div className="im-result__title">Import failed</div>
            {errorMessage && <div className="im-result__message">{errorMessage}</div>}
            <div className="im-footer">
              <button type="button" className="im-btn" onClick={onClose}>Cancel</button>
              <button type="button" className="im-btn im-btn--primary" onClick={runChain}>Retry</button>
            </div>
          </div>
        )}
        </>
        )}
      </div>
    </Modal>
  );
}
