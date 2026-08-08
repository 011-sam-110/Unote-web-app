// Phone photos -> staged import items -> a proposed grouping.
//
// Shared by both surfaces: the desktop modal (two or more photos picked at once) and the phone
// capture page (a tray filled from the camera or the library). Everything here runs in the
// browser except the staging POST, so a twenty-photo import costs ZERO AI calls.
//
// Order matters in one place and it is easy to get wrong: capture time must be read from the
// ORIGINAL file, because fitting the image for upload re-encodes it through a canvas and a canvas
// re-encode discards EXIF. Read first, shrink second.
import { api } from '../../../lib/api';
import type { ImportItem, ImportGroupInput } from '../../../lib/types';
import { createOcrRunner, mapWithConcurrency } from '../connectors/extract';
import { fitImageForUpload } from '../imageFit';
import { readCaptureTime } from './exif';
import { groupByCaptureTime, type GroupablePhoto } from './group';

export type PhotoStage = 'queued' | 'preparing' | 'reading' | 'uploading' | 'staged' | 'failed';

export interface PhotoState {
  localId: string;
  name: string;
  stage: PhotoStage;
  /** Short human note shown next to the file - 'no text found', an error, etc. */
  note?: string;
  itemId?: string;
  capturedAt: number | null;
}

export interface PhotoProgress {
  total: number;
  done: number;
  files: PhotoState[];
  /** False once the OCR engine has failed to load, so the UI can say so ONCE rather than
   *  showing twenty photos that each mysteriously "found no text". */
  ocrAvailable: boolean;
}

export interface PhotoIngestResult {
  items: ImportItem[];
  groups: ImportGroupInput[];
  ocrAvailable: boolean;
  failed: number;
}

/** Uploads run three at a time. OCR is serialised behind them by the single tesseract worker,
 *  which is deliberate: a second worker means a second ~7MB core in memory on a phone. */
const CONCURRENCY = 3;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : 'something went wrong';
}

/**
 * Prepare, OCR, and stage every photo, then propose a grouping.
 *
 * Per-photo failures are contained: a HEIC the browser cannot decode, or a file too big to
 * compress under the upload cap, fails alone and the rest of the batch still lands.
 */
export async function ingestPhotos(
  batchId: string,
  files: File[],
  onProgress: (p: PhotoProgress) => void,
): Promise<PhotoIngestResult> {
  const states: PhotoState[] = files.map((f, i) => ({
    localId: `p${i}`,
    name: f.name,
    stage: 'queued',
    capturedAt: null,
  }));
  const ocr = createOcrRunner();
  const report = () =>
    onProgress({
      total: states.length,
      done: states.filter((s) => s.stage === 'staged' || s.stage === 'failed').length,
      files: states.slice(),
      ocrAvailable: !ocr.engineFailed(),
    });
  report();

  const staged = new Map<string, { item: ImportItem; capturedAt: number | null }>();

  await mapWithConcurrency(files, CONCURRENCY, async (file, i) => {
    const st = states[i];
    try {
      // 1. Capture time, from the untouched original. This MUST precede the re-encode below.
      st.stage = 'preparing';
      report();
      const capture = await readCaptureTime(file);
      st.capturedAt = capture.capturedAt;

      // 2. Shrink until it genuinely fits what the API accepts.
      const fit = await fitImageForUpload(file);
      if (!fit.fits) {
        st.stage = 'failed';
        st.note = /\.hei[cf]$/i.test(file.name)
          ? "this browser can't read HEIC - export it as JPEG and try again"
          : 'too large to upload even after compressing';
        report();
        return;
      }

      // 3. Read the text locally. Free, unlimited, and never leaves the device.
      st.stage = 'reading';
      report();
      const text = await ocr.recognize(fit.file);

      // 4. Stage the bytes + text against the batch.
      st.stage = 'uploading';
      report();
      const form = new FormData();
      form.append('file', fit.file, fit.file.name);
      form.append('kind', 'photo');
      if (text) form.append('ocrText', text);
      if (capture.capturedAt != null) form.append('capturedAt', new Date(capture.capturedAt).toISOString());
      const { item } = await api.uploadImportFile(batchId, form);

      staged.set(item.id, { item, capturedAt: capture.capturedAt });
      st.itemId = item.id;
      st.stage = 'staged';
      st.note = text ? undefined : ocr.engineFailed() ? 'text reader unavailable' : 'no text found';
    } catch (err) {
      st.stage = 'failed';
      st.note = errMsg(err);
    }
    report();
  });

  await ocr.terminate();

  // Group in the order the photos were given, so the fallbacks in groupByCaptureTime (which lean
  // on filename sequence when timestamps are missing) see a sensible starting order.
  const groupable: GroupablePhoto[] = [];
  for (const state of states) {
    if (!state.itemId) continue;
    const entry = staged.get(state.itemId);
    if (!entry) continue;
    groupable.push({
      id: entry.item.id,
      originalName: entry.item.originalName,
      capturedAt: entry.capturedAt,
      text: entry.item.preview,
    });
  }

  const groups = groupByCaptureTime(groupable);
  let items = groupable.map((g) => staged.get(g.id)!.item);
  if (groups.length) {
    try {
      const saved = await api.setImportGroups(batchId, { grouper: 'capture-time', groups });
      items = saved.items;
    } catch {
      // Grouping is a proposal, not the import. If saving it fails the photos are still staged
      // and the review screen simply opens with each photo as its own note.
    }
  }

  return {
    items,
    groups,
    ocrAvailable: !ocr.engineFailed(),
    failed: states.filter((s) => s.stage === 'failed').length,
  };
}

export interface PhotoCommitProgress {
  totalNotes: number;
  doneNotes: number;
  created: number;
  failed: number;
  createdNotebooks: Array<{ id: string; name: string }>;
}

/**
 * Commit the reviewed groups, in resumable slices that NEVER split a group.
 *
 * The server can cope with a split group (it looks up an already-committed sibling and appends to
 * the note it made), but sending whole groups keeps the common case a single transaction's worth
 * of work and makes "3 of 4 notes created" mean exactly what it says.
 */
export async function commitGroups(
  batchId: string,
  groups: ImportGroupInput[],
  onProgress: (p: PhotoCommitProgress) => void,
): Promise<PhotoCommitProgress> {
  const progress: PhotoCommitProgress = {
    totalNotes: groups.length,
    doneNotes: 0,
    created: 0,
    failed: 0,
    createdNotebooks: [],
  };
  onProgress({ ...progress });

  // Pack whole groups into chunks. A single group larger than the target still goes on its own,
  // because splitting it would be the one thing this is here to avoid.
  const CHUNK_ITEMS = 20;
  const chunks: ImportGroupInput[][] = [];
  let current: ImportGroupInput[] = [];
  let size = 0;
  for (const g of groups) {
    if (current.length && size + g.itemIds.length > CHUNK_ITEMS) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(g);
    size += g.itemIds.length;
  }
  if (current.length) chunks.push(current);

  for (const chunk of chunks) {
    const itemIds = chunk.flatMap((g) => g.itemIds);
    try {
      const res = await api.commitImport(batchId, itemIds);
      progress.created += res.created;
      progress.failed += res.failed;
      progress.createdNotebooks.push(...res.createdNotebooks);
    } catch {
      // A chunk that never landed is a failed chunk, not a lost one: its items keep their staged
      // status server-side, so pressing Import again re-sends exactly these groups.
      progress.failed += chunk.length;
    }
    progress.doneNotes += chunk.length;
    onProgress({ ...progress });
  }
  return progress;
}
