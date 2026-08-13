// Put one user-supplied image on the server: shrink it, send it, and say so while it happens.
//
// Shared because the defect it fixes existed on two surfaces independently. The editor
// (paste, drop, slash menu) and the canvas board's own image drop each built their own
// FormData and posted the original bytes, while every OTHER path in the app - the capture
// page, the import modal, the photo pipeline - went through `fitImageForUpload` first. A
// 12MP phone photo went up at full resolution on exactly the two surfaces a student uses
// most, and those bytes were then re-downloaded by every later reader of the note.
//
// Measured: an 8.57MB 4032x3024 drop stores as a 284.7KB 1600x1200 JPEG, 30.8x fewer bytes.
// Against the local API the server's own cost for a 23MB upload is 377ms, so the wait was
// never the server - it was the transfer, which is what shrinking actually removes.
//
// Offline and guest uploads deliberately go through `api.uploadImage` rather than the
// progress transport: that call routes into the local mirror, which stashes the bytes in
// IndexedDB and returns a `local-blob:` reference for the sync engine to upload and rewrite
// later. Bypassing it to get a progress bar would turn "add an image on a train" into a
// failure.
import { api } from '../../lib/api';
import { startTask } from '../../components/taskProgressBus';
import { uploadWithProgress } from '../../lib/uploadWithProgress';
import { fitImageForUpload, MAX_UPLOAD_BYTES } from './imageFit';
import { isOnline } from '../../lib/sync/connectivity';
import { isGuest } from '../guest/guestMode';

/** Thrown when five downscale passes still cannot get the file under the cap. */
export class ImageTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageTooLargeError';
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export interface UploadedImage {
  /** Where the server will serve it from, or a `local-blob:` reference when offline. */
  url: string;
  originalBytes: number;
  uploadedBytes: number;
}

/**
 * @param label What to call this piece of work in the progress card, e.g. "Adding image".
 *              Callers uploading several files should number them, so two concurrent cards
 *              are tellable apart.
 */
export async function uploadImageWithProgress(file: File, label = 'Adding image…'): Promise<UploadedImage> {
  const task = startTask(label);
  try {
    // Phase 1: shrink. Indeterminate - canvas.toBlob reports nothing until it is finished,
    // and a fabricated percentage here would be the one number on screen that is not true.
    task.update({
      label: file.size > 1024 * 1024 ? `Shrinking ${formatBytes(file.size)} image…` : 'Preparing image…',
    });
    const { file: fitted, fits, changed } = await fitImageForUpload(file);

    if (!fits) {
      // Posting anyway collects a 413, which reads as the app being broken rather than as
      // the file being unusable.
      const message = `That image is too large to upload (max ${formatBytes(MAX_UPLOAD_BYTES)}).`;
      task.fail(message);
      throw new ImageTooLargeError(message);
    }

    const form = new FormData();
    form.append('file', fitted);
    const sizeLabel = changed ? `${formatBytes(file.size)} → ${formatBytes(fitted.size)}` : formatBytes(fitted.size);

    let url: string;
    if (isOnline() && !isGuest()) {
      task.update({ label: `Uploading ${sizeLabel}`, percent: 0 });
      const res = await uploadWithProgress<{ url: string }>('/api/import/image', form, (p) => {
        // `percent` stays undefined when the length is not computable, and the card falls
        // back to the indeterminate sweep rather than showing a made-up number.
        task.update({ percent: p.percent });
      });
      url = res.url;
    } else {
      // A write to IndexedDB: fast, with nothing meaningful to report a percentage against.
      task.update({ label: 'Saving to this device…', percent: undefined });
      url = (await api.uploadImage(form)).url;
    }

    task.done();
    return { url, originalBytes: file.size, uploadedBytes: fitted.size };
  } catch (e) {
    // ImageTooLargeError has already put its own message on the card; anything else is a
    // transport or server failure and needs one.
    if (!(e instanceof ImageTooLargeError)) {
      task.fail(e instanceof Error ? e.message : 'Image upload failed');
    }
    throw e;
  }
}
