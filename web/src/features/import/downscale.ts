// Client-side photo downscale before upload - phones send 12MP+ JPEG/HEIC, we only need enough
// resolution for OCR. Best-effort: any failure (a format the browser cannot decode, canvas
// errors) falls back to uploading the original file untouched.
//
// The actual shrinking lives in imageFit.ts, which is shared with the bulk photo path and, unlike
// the version this replaced, keeps going until the file is genuinely under the upload cap.
import { fitImageForUpload } from './imageFit';

/**
 * Shrink a photo for upload, never failing.
 *
 * Callers that need to KNOW whether the result fits - and so whether posting it will 413 -
 * should use `fitImageForUpload` directly and read `fits`.
 */
export async function downscaleImage(file: File): Promise<File> {
  try {
    const { file: out } = await fitImageForUpload(file);
    return out;
  } catch {
    return file;
  }
}
