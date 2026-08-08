// Shrink an image until it genuinely fits the upload cap.
//
// The cap is not advisory. On Vercel the import route rejects anything over 4MB (imports.ts
// MAX_SIZE), and a 413 is the whole import failing, not a degraded one. Two existing paths each
// got half of this right: downscale.ts capped the long edge and then stopped (a 12MP phone JPEG
// at 1600px is usually but not always under 4MB, and an already-small 6MB PNG was passed through
// untouched), while the lecture flow had a real retry loop nobody else could reach. This is that
// loop, shared, and applied unconditionally rather than only when the image is oversized.

/** Must stay in step with MAX_SIZE in server/src/routes/imports.ts for the serverless case. */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

const MAX_EDGE = 1600; // plenty for OCR; a phone's 12MP original is ~4000px
const START_QUALITY = 0.85;
const MIN_QUALITY = 0.5;
const MAX_ATTEMPTS = 5;

export interface FitResult {
  file: File;
  /** False when the image could not be brought under the limit - the caller must not upload it. */
  fits: boolean;
  /** True when we re-encoded; false when the original was already fine and is passed through. */
  changed: boolean;
}

async function encode(bitmap: ImageBitmap, w: number, h: number, quality: number): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

function renamed(file: File, blob: Blob): File {
  const name = `${file.name.replace(/\.[^./\\]+$/, '')}.jpg`;
  return new File([blob], name, { type: 'image/jpeg', lastModified: file.lastModified });
}

/**
 * Re-encode `file` until it is at most `limit` bytes.
 *
 * Steps down resolution and quality together, because past a point quality alone stops paying:
 * a dense page of handwriting keeps its detail far better at 1120px/q0.7 than at 1600px/q0.4.
 *
 * Never throws. A format the browser cannot decode - HEIC in Chrome, most often - comes back as
 * `{ fits: file.size <= limit, changed: false }` so the caller can report that one file honestly
 * instead of the whole import dying.
 */
export async function fitImageForUpload(file: File, limit = MAX_UPLOAD_BYTES): Promise<FitResult> {
  if (!file.type.startsWith('image/') && !/\.(jpe?g|png|webp|gif|bmp)$/i.test(file.name)) {
    return { file, fits: file.size <= limit, changed: false };
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // Undecodable here (HEIC without native support). Pass it through and let the caller decide;
    // if it is small enough the server may still cope, and if not the caller reports the file.
    return { file, fits: file.size <= limit, changed: false };
  }

  try {
    const { width, height } = bitmap;
    let scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    let quality = START_QUALITY;

    // Already small in both dimensions AND in bytes: nothing to gain from a re-encode.
    if (scale >= 1 && file.size <= limit) return { file, fits: true, changed: false };

    let best: Blob | null = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const blob = await encode(bitmap, width * scale, height * scale, quality);
      if (!blob) break;
      best = blob;
      if (blob.size <= limit) return { file: renamed(file, blob), fits: true, changed: true };
      scale *= 0.75;
      quality = Math.max(MIN_QUALITY, quality - 0.1);
    }

    if (best) {
      // Still too big after five passes - hand back the smallest we managed, flagged as unfit so
      // the caller shows an error rather than posting it and collecting a 413.
      return { file: renamed(file, best), fits: best.size <= limit, changed: true };
    }
    return { file, fits: file.size <= limit, changed: false };
  } finally {
    bitmap.close();
  }
}
