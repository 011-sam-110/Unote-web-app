// When a photo was taken - the signal the whole auto-grouping rests on.
//
// Pages of one handout are shot seconds apart; a different lecture is hours away. That gap is a
// far better grouping signal than filename or content, and it is free.
//
// TIMING IS LOAD-BEARING: this must run on the ORIGINAL file, before downscaleImage. That
// re-encodes through a canvas, and a canvas re-encode drops every byte of metadata - EXIF
// included. Read first, shrink second, or every photo silently falls back to file order.
//
// Hand-rolled rather than a dependency: we need exactly one tag out of a JPEG APP1 segment, and
// the whole parser is smaller than the type stubs of any library that would do it.

/** Where a photo's timestamp came from - shown in the review screen so a wrong group is explicable. */
export type CaptureSource = 'exif' | 'file' | 'none';

export interface CaptureInfo {
  /** Epoch milliseconds, or null when nothing usable was found. */
  capturedAt: number | null;
  source: CaptureSource;
}

/** EXIF lives at the front of the file; 256KB is far more than any APP1 segment needs. */
const HEAD_BYTES = 256 * 1024;

const TAG_DATETIME = 0x0132; // IFD0  DateTime (file modified, per the camera)
const TAG_EXIF_IFD = 0x8769; // IFD0  pointer to the Exif sub-IFD
const TAG_DATETIME_ORIGINAL = 0x9003; // Exif  DateTimeOriginal - the shutter press
const TAG_DATETIME_DIGITIZED = 0x9004; // Exif  DateTimeDigitized

/**
 * Parse `YYYY:MM:DD HH:MM:SS` (EXIF's format) as LOCAL time.
 *
 * EXIF timestamps carry no zone, and the camera wrote wall-clock time where the photo was taken.
 * Local is therefore the honest reading - and grouping only ever compares two of these to each
 * other, so a zone offset would cancel out anyway.
 */
function parseExifDate(raw: string): number | null {
  const m = raw.trim().match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const year = Number(y);
  if (year < 1990 || year > 2100) return null; // an unset camera clock is worse than no signal
  const ms = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)).getTime();
  return Number.isFinite(ms) ? ms : null;
}

interface Reader {
  u16(off: number): number;
  u32(off: number): number;
}

function reader(view: DataView, little: boolean): Reader {
  return {
    u16: (off) => view.getUint16(off, little),
    u32: (off) => view.getUint32(off, little),
  };
}

/** Read an ASCII value out of one IFD entry, following the offset when it doesn't fit inline. */
function asciiValue(view: DataView, r: Reader, tiffStart: number, entryOff: number): string | null {
  const count = r.u32(entryOff + 4);
  if (count === 0 || count > 64) return null;
  const inline = count <= 4;
  const at = inline ? entryOff + 8 : tiffStart + r.u32(entryOff + 8);
  if (at < 0 || at + count > view.byteLength) return null;
  let out = '';
  for (let i = 0; i < count; i++) {
    const c = view.getUint8(at + i);
    if (c === 0) break;
    out += String.fromCharCode(c);
  }
  return out || null;
}

/** Walk one IFD, returning the first date tag found and any Exif sub-IFD pointer. */
function scanIfd(
  view: DataView,
  r: Reader,
  tiffStart: number,
  ifdOff: number,
  wanted: number[],
): { date: string | null; exifIfd: number | null } {
  let date: string | null = null;
  let exifIfd: number | null = null;
  if (ifdOff + 2 > view.byteLength) return { date, exifIfd };
  const count = r.u16(ifdOff);
  if (count > 512) return { date, exifIfd }; // corrupt or not really an IFD
  for (let i = 0; i < count; i++) {
    const entry = ifdOff + 2 + i * 12;
    if (entry + 12 > view.byteLength) break;
    const tag = r.u16(entry);
    if (tag === TAG_EXIF_IFD) {
      exifIfd = tiffStart + r.u32(entry + 8);
    } else if (!date && wanted.includes(tag)) {
      date = asciiValue(view, r, tiffStart, entry);
    }
  }
  return { date, exifIfd };
}

/** Find the APP1/Exif segment in a JPEG and pull the best available capture timestamp. */
function jpegCaptureTime(buf: ArrayBuffer): number | null {
  const view = new DataView(buf);
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null; // not a JPEG

  let off = 2;
  while (off + 4 <= view.byteLength) {
    if (view.getUint8(off) !== 0xff) break; // out of sync - give up rather than guess
    const marker = view.getUint8(off + 1);
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      off += 2;
      continue;
    }
    if (marker === 0xda) break; // start of scan: all metadata is behind us
    const size = view.getUint16(off + 2);
    if (size < 2) break;
    const segment = off + 4;

    if (marker === 0xe1 && segment + 6 <= view.byteLength) {
      let header = '';
      for (let i = 0; i < 4; i++) header += String.fromCharCode(view.getUint8(segment + i));
      if (header === 'Exif') {
        const tiff = segment + 6;
        if (tiff + 8 > view.byteLength) return null;
        const byteOrder = view.getUint16(tiff);
        if (byteOrder !== 0x4949 && byteOrder !== 0x4d4d) return null;
        const r = reader(view, byteOrder === 0x4949);
        if (r.u16(tiff + 2) !== 42) return null;
        const ifd0 = tiff + r.u32(tiff + 4);

        const first = scanIfd(view, r, tiff, ifd0, [TAG_DATETIME]);
        // DateTimeOriginal (the shutter press) beats IFD0's DateTime (last modified), so the
        // sub-IFD is preferred whenever it has one.
        if (first.exifIfd != null) {
          const sub = scanIfd(view, r, tiff, first.exifIfd, [TAG_DATETIME_ORIGINAL, TAG_DATETIME_DIGITIZED]);
          if (sub.date) {
            const ts = parseExifDate(sub.date);
            if (ts != null) return ts;
          }
        }
        if (first.date) return parseExifDate(first.date);
        return null;
      }
    }
    off += 2 + size;
  }
  return null;
}

/**
 * Best available capture time for a photo.
 *
 * EXIF when the file has it (JPEG from any phone camera). Otherwise `file.lastModified`, which is
 * weaker - on a copied or downloaded file it is the copy time, not the shutter time - but still
 * usually preserves the ORDER photos were taken in, which is most of what grouping needs.
 * HEIC and PNG generally land here.
 */
export async function readCaptureTime(file: File): Promise<CaptureInfo> {
  try {
    const head = await file.slice(0, HEAD_BYTES).arrayBuffer();
    const exif = jpegCaptureTime(head);
    if (exif != null) return { capturedAt: exif, source: 'exif' };
  } catch {
    /* unreadable slice - fall through to the file timestamp */
  }
  if (file.lastModified && Number.isFinite(file.lastModified)) {
    return { capturedAt: file.lastModified, source: 'file' };
  }
  return { capturedAt: null, source: 'none' };
}
