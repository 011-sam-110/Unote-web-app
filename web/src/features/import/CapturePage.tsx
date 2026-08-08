// Mobile-first standalone capture page - rendered outside the App shell
// (see main.tsx). Full-viewport, no sidebar. Downscales photos client-side
// before handing off to the same import job pipeline as ImportModal.
import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import type { Notebook } from '../../lib/types';
import { useAuth } from '../auth/AuthContext';
import Icon from '../../components/Icon';
import { IMPORT_KINDS, findKind, formatBytes, validateFile, type ImportKind } from './kinds';
import { downscaleImage } from './downscale';
import { useImportJob } from './useImportJob';
import ImportProgress from './ImportProgress';
import PhotoImportFlow from './photos/PhotoImportFlow';
import './import-ui.css';
import './CapturePage.css';

/** 'bulk' is the multi-photo path - several photos in the tray become several notes. */
type Phase = 'pick' | 'ready' | 'bulk' | 'uploading' | 'done' | 'error';

export default function CapturePage() {
  const { scope } = useAuth();
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [notebooksLoading, setNotebooksLoading] = useState(true);
  const [notebooksFailed, setNotebooksFailed] = useState(false);
  const [notebookId, setNotebookId] = useState<string | null>(null);
  const [kind, setKind] = useState<ImportKind>('photo');
  // A TRAY, not one file. Photographing a six-page handout used to mean six round trips, each
  // waiting on an AI call, because the input was single-file and every shot uploaded on its own.
  const [files, setFiles] = useState<File[]>([]);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const [phase, setPhase] = useState<Phase>('pick');
  const [error, setError] = useState<string | null>(null);
  const [resultNoteId, setResultNoteId] = useState<string | null>(null);
  const [resultTitle, setResultTitle] = useState<string | null>(null);
  /** Set when the multi-photo flow finished, so the success screen can say "4 notes created". */
  const [bulkResult, setBulkResult] = useState<{ created: number; failed: number } | null>(null);
  // Multi-page session: after the first successful capture, "Add another page" chains the
  // next upload as mode=append into the note just created (mirrors ImportModal's chaining)
  // so a 3-page handout becomes ONE note, not three fragments.
  const [appendTarget, setAppendTarget] = useState<{ id: string; title: string | null } | null>(null);
  const [dragActive, setDragActive] = useState(false);
  // Two inputs, deliberately. `capture` and `multiple` together do not do what they look like
  // they do: iOS honours `capture`, opens the camera, and hands back exactly one file - so a
  // single combined input would silently cap every library pick at one photo.
  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);
  const { job, run, reset: resetJob } = useImportJob();

  useEffect(() => {
    api.notebooks()
      .then(res => {
        setNotebooks(res.notebooks);
        setNotebookId(prev => prev ?? res.notebooks[0]?.id ?? null);
      })
      .catch(() => setNotebooksFailed(true))
      .finally(() => setNotebooksLoading(false));
  }, []);

  useEffect(() => {
    if (kind !== 'photo' || files.length === 0) { setPreviewUrls([]); return; }
    const urls = files.map((f) => URL.createObjectURL(f));
    setPreviewUrls(urls);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [files, kind]);

  const kindMeta = findKind(kind);

  function handleKindChange(next: ImportKind) {
    setKind(next);
    setFiles([]);
    setError(null);
    if (phase !== 'uploading') setPhase('pick');
  }

  function openCamera() { cameraRef.current?.click(); }
  function openLibrary() { libraryRef.current?.click(); }

  function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    const chosen = Array.from(e.target.files ?? []);
    e.target.value = ''; // so picking the same file twice still fires a change
    if (chosen.length) acceptFiles(chosen);
  }

  /** Add to the tray. Photos accumulate - shoot, shoot, shoot, then import once. Anything else
   *  is single-file by nature, so it replaces. */
  function acceptFiles(chosen: File[]) {
    const errors: string[] = [];
    const valid: File[] = [];
    for (const f of chosen) {
      const err = validateFile(f, kind);
      if (err) errors.push(err); else valid.push(f);
    }
    setError(errors.length ? errors.join(' · ') : null);
    if (!valid.length) return;
    setFiles((prev) => (kind === 'photo' ? [...prev, ...valid] : valid.slice(0, 1)));
    setPhase('ready');
  }

  function removeFile(index: number) {
    setFiles((prev) => {
      const next = prev.filter((_, i) => i !== index);
      if (next.length === 0) setPhase('pick');
      return next;
    });
  }

  // Desktop fallback: /capture also accepts drag-drop, not just the camera tap target.
  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    const dropped = Array.from(e.dataTransfer.files ?? []);
    if (dropped.length) acceptFiles(dropped);
  }

  async function upload() {
    const file = files[0];
    if (!file || (!notebookId && !appendTarget)) return;

    // Several photos, and not adding to an existing note: sort them into notes instead of
    // chaining them all into one. One photo still takes the AI-vision path below, which reads
    // handwriting far better and costs only two calls when it is a single page.
    if (kind === 'photo' && files.length > 1 && !appendTarget) {
      setError(null);
      setPhase('bulk');
      return;
    }

    setPhase('uploading');
    setError(null);
    try {
      const uploadFile = kind === 'photo' ? await downscaleImage(file) : file;
      const form = new FormData();
      form.append('file', uploadFile);
      form.append('kind', kind);
      if (appendTarget) {
        form.append('mode', 'append');
        form.append('noteId', appendTarget.id);
      } else {
        form.append('mode', 'new');
        form.append('notebookId', notebookId!);
      }
      const { jobId } = await api.import(form);
      const result = await run(jobId);
      if (result.status === 'failed') {
        setError(result.error ?? 'Import failed');
        setPhase('error');
        return;
      }
      setResultNoteId(result.noteId ?? null);
      // The title comes back ON the job. It used to be fetched with GET /api/notes/:id
      // purely to display one string, which would have forced the QR-paired phone's
      // session to carry note-read access - a scanned code could then have read the
      // account's notes, not just added to them.
      setResultTitle(result.noteId ? result.noteTitle || 'Untitled note' : null);
      setPhase('done');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Upload failed. Check your connection and try again');
      setPhase('error');
    }
  }

  function resetPicker() {
    setFiles([]);
    setPreviewUrls([]);
    setPhase('pick');
    setError(null);
    setResultNoteId(null);
    resetJob();
  }

  /** Chain the next capture into the note just created (multi-page lecture sheet). */
  function addAnotherPage() {
    if (resultNoteId) setAppendTarget({ id: resultNoteId, title: resultTitle });
    resetPicker();
  }

  /** Start a fresh note instead (escape hatch out of the chaining session). */
  function captureAnother() {
    setAppendTarget(null);
    setResultTitle(null);
    setBulkResult(null);
    resetPicker();
  }

  return (
    <div className="cp-page">
      <header className="cp-header">
        <div className="cp-wordmark">Unote</div>
        <div className="cp-tagline">Capture a page in seconds</div>
      </header>

      <div className="cp-body">
        {phase === 'done' ? (
          <div className="cp-success">
            <div className="cp-success__icon" aria-hidden="true">✓</div>
            <h2>
              {bulkResult
                ? `${bulkResult.created} note${bulkResult.created === 1 ? '' : 's'} created`
                : appendTarget ? 'Page added' : 'Note ready'}
            </h2>
            {resultTitle && <p className="cp-success__title">{resultTitle}</p>}
            <p className="cp-success__message">
              {bulkResult && bulkResult.failed > 0
                ? `${bulkResult.failed} photo${bulkResult.failed === 1 ? '' : 's'} couldn't be imported. The rest are on your desktop.`
                : "Captured! It's on your desktop too."}
            </p>
            <div className="cp-success__actions">
              {!bulkResult && (
                <button type="button" className="im-btn im-btn--primary" onClick={addAnotherPage}>Add another page</button>
              )}
              <button type="button" className={`im-btn${bulkResult ? ' im-btn--primary' : ''}`} onClick={captureAnother}>
                {bulkResult ? 'Capture more' : 'Start a new note'}
              </button>
              {/* A QR-paired phone cannot open the note - its session is scoped to capture,
                  so /note/:id would 403. Offering the link anyway would look like a bug.
                  The note is already waiting on the desktop, which the copy above says. */}
              {resultNoteId && scope === 'full' && (
                <Link className="im-link-btn" to={`/note/${resultNoteId}`}>Open note</Link>
              )}
            </div>
          </div>
        ) : phase === 'uploading' ? (
          <div className="cp-progress">
            <ImportProgress job={job} compact />
          </div>
        ) : phase === 'bulk' ? (
          <div className="cp-bulk">
            <PhotoImportFlow
              files={files}
              notebooks={notebooks}
              defaultNotebookId={notebookId}
              onDone={({ created, failed }) => {
                setResultTitle(null);
                setResultNoteId(null);
                setBulkResult({ created, failed });
                setFiles([]);
                setPhase('done');
              }}
              onCancel={() => setPhase('ready')}
            />
          </div>
        ) : (
          <>
            <div className="cp-kind-switch" role="tablist" aria-label="Import kind">
              {IMPORT_KINDS.map(k => (
                <button
                  key={k.key}
                  type="button"
                  role="tab"
                  aria-selected={kind === k.key}
                  className={`cp-kind${kind === k.key ? ' is-active' : ''}`}
                  onClick={() => handleKindChange(k.key)}
                >
                  <Icon name={k.iconName} size={16} />
                  <span>{k.label}</span>
                </button>
              ))}
            </div>

            {appendTarget ? (
              <div className="cp-append-banner" data-testid="capture-append-banner">
                <span>
                  Adding to <strong>{appendTarget.title || 'your note'}</strong>
                </span>
                <button type="button" className="im-link-btn" onClick={captureAnother}>
                  Start a new note instead
                </button>
              </div>
            ) : (
            /* This is a single-select list of notebooks, not a set of tabs: there are
               no tabpanels behind it. It was role="tablist" with plain buttons inside,
               which is an invalid parent/child pairing (axe: aria-required-children).
               radiogroup/radio states the same thing correctly, and aria-checked makes
               the current selection audible rather than colour-only. The loading and
               error hints render OUTSIDE the group, because a radiogroup may only
               contain radios. */
            notebooksLoading ? (
              <div className="cp-notebooks__hint" role="status">Loading notebooks…</div>
            ) : notebooksFailed ? (
              <div className="cp-notebooks__hint" role="alert">Couldn't load notebooks. Check your connection</div>
            ) : notebooks.length === 0 ? (
              <div className="cp-notebooks__hint">Create a notebook on desktop first</div>
            ) : (
              <div className="cp-notebooks" role="radiogroup" aria-label="Notebook">
                {notebooks.map(nb => (
                  <button
                    key={nb.id}
                    type="button"
                    role="radio"
                    aria-checked={notebookId === nb.id}
                    className={`im-chip${notebookId === nb.id ? ' is-active' : ''}`}
                    onClick={() => setNotebookId(nb.id)}
                  >
                    {nb.emoji} {nb.name}
                  </button>
                ))}
              </div>
            )
            )}

            {error && (
              <div className="cp-error">
                <p>{error}</p>
                <button type="button" className="im-btn" onClick={() => setPhase(files.length ? 'ready' : 'pick')}>Dismiss</button>
              </div>
            )}

            <div
              className={`cp-dropzone${dragActive ? ' is-active' : ''}`}
              onDragOver={e => { e.preventDefault(); setDragActive(true); }}
              onDragLeave={() => setDragActive(false)}
              onDrop={onDrop}
            >
              {files.length > 0 ? (
                <div className="cp-preview">
                  {kind === 'photo' ? (
                    <ul className="cp-tray">
                      {files.map((f, i) => (
                        <li className="cp-tray__item" key={`${f.name}-${i}`}>
                          {previewUrls[i]
                            ? <img className="cp-tray__thumb" src={previewUrls[i]} alt={`Photo ${i + 1}`} />
                            : <span className="cp-tray__thumb cp-tray__thumb--none" aria-hidden="true" />}
                          <span className="cp-tray__num">{i + 1}</span>
                          <button
                            type="button"
                            className="cp-tray__remove"
                            aria-label={`Remove photo ${i + 1}`}
                            onClick={() => removeFile(i)}
                          >
                            &times;
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="cp-preview__file">
                      <span className="cp-preview__file-icon" aria-hidden="true"><Icon name={kindMeta.iconName} size={28} /></span>
                      <div>
                        <div className="cp-preview__file-name">{files[0].name}</div>
                        <div className="cp-preview__file-size">{formatBytes(files[0].size)}</div>
                      </div>
                    </div>
                  )}
                  {kind === 'photo' ? (
                    <div className="cp-add-actions">
                      <button type="button" className="im-btn" onClick={openCamera}>Take another</button>
                      <button type="button" className="im-btn" onClick={openLibrary}>Add from library</button>
                    </div>
                  ) : (
                    <button type="button" className="im-link-btn" onClick={openLibrary}>Choose a different file</button>
                  )}
                </div>
              ) : kind === 'photo' ? (
                <div className="cp-choose">
                  <button type="button" className="cp-cta" onClick={openCamera}>
                    <span className="cp-cta__icon" aria-hidden="true"><Icon name="camera" size={40} /></span>
                    <span className="cp-cta__label">Take photos</span>
                    <span className="cp-cta__hint">Shoot page after page, then import once</span>
                  </button>
                  <button type="button" className="im-btn cp-choose__alt" onClick={openLibrary}>
                    Choose from library
                  </button>
                  <span className="cp-cta__drop-hint">or drop photos here</span>
                </div>
              ) : (
                <button type="button" className="cp-cta" onClick={openLibrary}>
                  <span className="cp-cta__icon" aria-hidden="true"><Icon name={kindMeta.iconName} size={40} /></span>
                  <span className="cp-cta__label">{kindMeta.label}</span>
                  <span className="cp-cta__hint">{kindMeta.hint}</span>
                  <span className="cp-cta__drop-hint">or drop a file here</span>
                </button>
              )}
            </div>

            {/*
              Two inputs rather than one, and this is not stylistic. `capture` plus `multiple` on
              the same input makes iOS open the camera and return a SINGLE file, which would
              quietly defeat the whole point of the tray. So: camera without `multiple`, library
              with `multiple` and no `capture`.
            */}
            <input
              ref={cameraRef}
              type="file"
              accept={kindMeta.accept}
              capture={kind === 'photo' ? 'environment' : undefined}
              onChange={onFileChange}
              hidden
            />
            <input
              ref={libraryRef}
              type="file"
              accept={kindMeta.accept}
              multiple={kind === 'photo'}
              onChange={onFileChange}
              hidden
            />
          </>
        )}
      </div>

      {phase === 'ready' && files.length > 0 && (
        <div className="cp-sticky">
          <button type="button" className="im-btn im-btn--primary cp-sticky__btn" disabled={!notebookId && !appendTarget} onClick={upload}>
            {appendTarget
              ? 'Upload & add to note'
              : files.length > 1
                ? `Import ${files.length} photos`
                : 'Upload & process'}
          </button>
        </div>
      )}
    </div>
  );
}
