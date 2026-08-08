/**
 * Build JPEGs carrying a real EXIF DateTimeOriginal, for the bulk photo import specs.
 *
 * Capture time is the entire basis of free auto-grouping, so a fixture without EXIF would test
 * only the fallback path and quietly leave the real one uncovered. These bytes are assembled to
 * the TIFF/EXIF spec by hand rather than copied from a sample file, which means the parser in
 * web/src/features/import/photos/exif.ts is being checked against an independent implementation
 * rather than against itself.
 */

const APP1 = 0xffe1;

/** EXIF wants `YYYY:MM:DD HH:MM:SS` in local wall-clock time, with no zone. */
function exifDateString(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}:${p(d.getMonth() + 1)}:${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * A minimal APP1 segment: TIFF header, IFD0 with one entry pointing at an Exif sub-IFD, and that
 * sub-IFD holding DateTimeOriginal.
 *
 * Little-endian ('II') because that is what phone cameras overwhelmingly write, so this is the
 * path worth exercising.
 */
function buildExifSegment(taken: Date): Buffer {
  const value = Buffer.from(`${exifDateString(taken)}\0`, 'ascii'); // 20 bytes incl. terminator

  // Offsets are measured from the start of the TIFF header.
  const TIFF_HEADER = 8;
  const IFD0 = TIFF_HEADER; // 2 count + 12 entry + 4 next
  const IFD0_SIZE = 2 + 12 + 4;
  const EXIF_IFD = IFD0 + IFD0_SIZE;
  const EXIF_IFD_SIZE = 2 + 12 + 4;
  const VALUE_OFFSET = EXIF_IFD + EXIF_IFD_SIZE;

  const tiff = Buffer.alloc(VALUE_OFFSET + value.length);
  let o = 0;
  tiff.write('II', o, 'ascii'); o += 2;      // little-endian
  tiff.writeUInt16LE(42, o); o += 2;          // magic
  tiff.writeUInt32LE(IFD0, o); o += 4;        // offset of IFD0

  // --- IFD0: a single entry, the pointer to the Exif sub-IFD ---
  tiff.writeUInt16LE(1, o); o += 2;           // entry count
  tiff.writeUInt16LE(0x8769, o); o += 2;      // tag: ExifIFDPointer
  tiff.writeUInt16LE(4, o); o += 2;           // type: LONG
  tiff.writeUInt32LE(1, o); o += 4;           // count
  tiff.writeUInt32LE(EXIF_IFD, o); o += 4;    // value: offset of the sub-IFD
  tiff.writeUInt32LE(0, o); o += 4;           // no next IFD

  // --- Exif sub-IFD: DateTimeOriginal ---
  tiff.writeUInt16LE(1, o); o += 2;           // entry count
  tiff.writeUInt16LE(0x9003, o); o += 2;      // tag: DateTimeOriginal
  tiff.writeUInt16LE(2, o); o += 2;           // type: ASCII
  tiff.writeUInt32LE(value.length, o); o += 4;
  tiff.writeUInt32LE(VALUE_OFFSET, o); o += 4; // 20 bytes does not fit inline, so it is an offset
  tiff.writeUInt32LE(0, o); o += 4;            // no next IFD

  value.copy(tiff, VALUE_OFFSET);

  const header = Buffer.from('Exif\0\0', 'ascii');
  const body = Buffer.concat([header, tiff]);
  const segment = Buffer.alloc(4 + body.length);
  segment.writeUInt16BE(APP1, 0);
  segment.writeUInt16BE(body.length + 2, 2); // segment length includes the length field itself
  body.copy(segment, 4);
  return segment;
}

/**
 * Splice an EXIF APP1 segment into a JPEG, immediately after the SOI marker.
 *
 * Any APP1 the encoder already wrote is dropped first, so calling this twice cannot leave two
 * competing timestamps in one file.
 */
export function withExifDate(jpeg: Buffer, taken: Date): Buffer {
  if (jpeg.readUInt16BE(0) !== 0xffd8) throw new Error('not a JPEG (no SOI)');

  let cursor = 2;
  while (cursor + 4 <= jpeg.length && jpeg[cursor] === 0xff) {
    const marker = jpeg.readUInt16BE(cursor);
    if (marker === 0xffda) break; // start of scan
    const size = jpeg.readUInt16BE(cursor + 2);
    if (marker === APP1) {
      jpeg = Buffer.concat([jpeg.subarray(0, cursor), jpeg.subarray(cursor + 2 + size)]);
      continue;
    }
    cursor += 2 + size;
  }

  return Buffer.concat([jpeg.subarray(0, 2), buildExifSegment(taken), jpeg.subarray(2)]);
}
