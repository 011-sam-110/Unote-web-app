// Client-side extraction. Inherited from the lecture flow: pull text in the browser wherever a
// library exists, so a 300MB vault never uploads 300MB - only the small extracted text (and,
// for photos, the downscaled bytes) crosses the wire.
//
//   TXT / MD   -> read in the browser, parse frontmatter + #hashtags for sort signal
//   PDF        -> pdf.js text layer in the browser; a scanned PDF yields no text (flagged)
//   DOCX/PPTX  -> uploaded and extracted server-side (no good browser equivalent)
//   Photos     -> downscaled, then OCR'd best-effort with tesseract.js (lazy, degrades to '')
import { downscaleImage } from '../downscale';
import type { RawDoc } from './types';

export type FileClass = 'text' | 'pdf' | 'office' | 'photo' | 'other';
export type StageMode = 'json' | 'upload-file' | 'upload-photo' | 'skip';

const TEXT_EXT = new Set(['md', 'markdown', 'mdx', 'txt', 'text']);
const OFFICE_EXT = new Set(['docx', 'pptx']);
const PHOTO_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'gif', 'bmp']);

function ext(name: string): string {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

export function classify(file: File): FileClass {
  const e = ext(file.name);
  if (TEXT_EXT.has(e)) return 'text';
  if (e === 'pdf' || file.type === 'application/pdf') return 'pdf';
  if (OFFICE_EXT.has(e)) return 'office';
  if (PHOTO_EXT.has(e) || file.type.startsWith('image/')) return 'photo';
  return 'other';
}

/** Folder segments (notebook signal), filename dropped: 'databases/indexing.md' -> ['databases']. */
export function folderPathOf(sourcePath: string | undefined): string[] {
  if (!sourcePath) return [];
  return sourcePath.split(/[\\/]+/).filter(Boolean).slice(0, -1);
}

function dedupe(list: string[]): string[] {
  return [...new Set(list.map((s) => s.trim()).filter(Boolean))];
}

/** YAML frontmatter `tags:`/`title:` + inline `#hashtags`. Deliberately forgiving.
 *  `body` is the document with any frontmatter block removed, so a caller that turns the
 *  markdown into a note does not paste the metadata back in as its first paragraph. */
export function parseSourceTags(md: string): { tags: string[]; title?: string; body: string } {
  const tags = new Set<string>();
  let title: string | undefined;
  let body = md;
  const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (fm) {
    body = md.slice(fm[0].length);
    const yaml = fm[1];
    const inline = yaml.match(/^tags:\s*\[([^\]]*)\]/m);
    if (inline) for (const t of inline[1].split(',')) { const s = t.trim().replace(/['"]/g, ''); if (s) tags.add(s); }
    const block = yaml.match(/^tags:\s*\n((?:[ \t]*-[ \t]*.+\r?\n?)+)/m);
    if (block) for (const line of block[1].split('\n')) { const m = line.match(/-\s*(.+)/); if (m) { const s = m[1].trim().replace(/['"]/g, ''); if (s) tags.add(s); } }
    const t = yaml.match(/^title:\s*(.+)$/m);
    if (t) title = t[1].trim().replace(/['"]/g, '');
  }
  // Inline #hashtags in the body - a letter must follow the '#', so markdown headings ('# H')
  // and '## Sub' never match.
  for (const m of body.matchAll(/(?:^|[\s(])#([a-zA-Z][\w/-]{1,31})/g)) tags.add(m[1]);
  return { tags: [...tags], title, body };
}

// --- PDF (pdf.js, lazy) ----------------------------------------------------------------------

let pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null;
async function loadPdfjs(): Promise<typeof import('pdfjs-dist')> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import('pdfjs-dist');
      // The worker is emitted same-origin by Vite, so it satisfies the app's strict CSP
      // (worker-src 'self'). Set once.
      const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      return pdfjs;
    })();
  }
  return pdfjsPromise;
}

export async function extractPdfText(file: File): Promise<string> {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;
  const pages: string[] = [];
  const max = Math.min(doc.numPages, 200);
  for (let i = 1; i <= max; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const line = content.items.map((it) => ('str' in it ? it.str : '')).join(' ').replace(/\s+/g, ' ').trim();
    if (line) pages.push(line);
    page.cleanup();
  }
  await doc.destroy();
  return pages.join('\n\n');
}

// --- OCR (tesseract.js, lazy, best-effort) ---------------------------------------------------

/** A minimal view of a tesseract worker, so we don't couple to their full type surface. */
interface OcrWorker {
  recognize(image: File | Blob): Promise<{ data: { text: string } }>;
  terminate(): Promise<void>;
}

export interface OcrRunner {
  recognize(file: File | Blob): Promise<string>;
  terminate(): Promise<void>;
  /** True once the engine itself failed to load, so callers can say so instead of showing
   *  twenty photos that each mysteriously "found no text". */
  engineFailed(): boolean;
}

/**
 * Same-origin asset paths, served from web/public/tesseract by scripts/vendor-tesseract.mjs.
 *
 * tesseract.js defaults these to cdn.jsdelivr.net and loads them with `importScripts()`, which
 * the production CSP (`script-src 'self' 'wasm-unsafe-eval' 'sha256-...'`) blocks - jsdelivr is
 * allowed for `connect-src` only. That is why OCR has never produced a character in production.
 * Absolute URLs off `location.origin`, not root-relative ones, because a root-relative path
 * inside a worker resolves against the worker's own base URL.
 */
function tesseractPaths() {
  const base = `${window.location.origin}/tesseract`;
  return {
    // A classic same-origin worker rather than the default blob: wrapper. `worker-src 'self'`
    // covers it, and it keeps one fewer CSP inheritance rule in play.
    workerBlobURL: false,
    workerPath: `${base}/worker.min.js`,
    // A directory, so tesseract picks the SIMD core when the device supports it.
    corePath: `${base}/`,
    // Resolves to `${base}/eng.traineddata.gz` (gzip is on by default).
    langPath: base,
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('OCR timed out')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * A shared OCR runner for one import. The engine download (~7MB of wasm core + language data)
 * and worker spawn are lazy - first photo only - and cached by the browser thereafter.
 *
 * Two failure modes, deliberately handled differently, because conflating them is what made a
 * single bad frame silently wipe the text off every other photo in a twenty-photo batch:
 *
 *   engine failure   - the worker or its assets would not load. Retrying per photo just costs
 *                      twenty more timeouts, so it latches and every later call short-circuits.
 *   recognise failure - THIS image could not be read (corrupt, HEIC the browser cannot decode,
 *                      timed out). Only that photo loses its text; the batch carries on.
 */
export function createOcrRunner(): OcrRunner {
  let workerPromise: Promise<OcrWorker> | null = null;
  let engineDead = false;
  async function getWorker(): Promise<OcrWorker> {
    if (!workerPromise) {
      workerPromise = (async () => {
        const tesseract = await import('tesseract.js');
        const opts = tesseractPaths();
        return (await tesseract.createWorker('eng', undefined, opts)) as unknown as OcrWorker;
      })();
      // A rejected load must not be retried by every subsequent photo, but it also must not
      // become an unhandled rejection when nothing is awaiting it yet.
      workerPromise.catch(() => { engineDead = true; });
    }
    return workerPromise;
  }
  return {
    engineFailed: () => engineDead,
    async recognize(file) {
      if (engineDead) return '';
      let worker: OcrWorker;
      try {
        // Generous: this is where the ~7MB download happens, on whatever connection the phone has.
        worker = await withTimeout(getWorker(), 120_000);
      } catch {
        engineDead = true;
        return '';
      }
      try {
        const res = await withTimeout(worker.recognize(file), 45_000);
        return (res.data?.text ?? '').replace(/\s+\n/g, '\n').trim();
      } catch {
        return ''; // this frame only - the next photo still gets a go
      }
    },
    async terminate() {
      if (!workerPromise) return;
      try {
        const w = await workerPromise;
        await w.terminate();
      } catch {
        /* never loaded, or already gone */
      }
    },
  };
}

// --- per-file processing ---------------------------------------------------------------------

export interface ProcessedDoc {
  localId: string;
  originalName: string;
  sourcePath?: string;
  folderPath?: string[];
  title?: string;
  sourceTags: string[];
  fileClass: FileClass;
  mode: StageMode;
  /** Note body (raw markdown/plain) for a JSON-staged text doc. */
  text?: string;
  /** The file to upload for office/photo staging (downscaled, for photos). */
  file?: File;
  ocrText?: string;
  /** Human hint surfaced in the ingest list, e.g. 'no text found'. */
  note?: string;
  ok: boolean;
  error?: string;
}

let seq = 0;

export async function processFile(file: File, doc: RawDoc, ocr: OcrRunner | null): Promise<ProcessedDoc> {
  const localId = `f${++seq}`;
  const sourcePath = doc.sourcePath ?? file.name;
  const folderPath = doc.folderPath ?? folderPathOf(sourcePath);
  const fileClass = classify(file);
  const base: ProcessedDoc = {
    localId,
    originalName: file.name,
    sourcePath,
    folderPath,
    title: doc.title,
    sourceTags: doc.sourceTags ?? [],
    fileClass,
    mode: 'skip',
    ok: false,
  };
  try {
    switch (fileClass) {
      case 'text': {
        const raw = await file.text();
        const { tags, title } = parseSourceTags(raw);
        return { ...base, mode: 'json', text: raw, title: base.title ?? title, sourceTags: dedupe([...base.sourceTags, ...tags]), ok: true };
      }
      case 'pdf': {
        const text = await extractPdfText(file);
        return { ...base, mode: 'json', text, note: text.trim() ? undefined : 'no text found (scanned PDF?)', ok: true };
      }
      case 'office':
        return { ...base, mode: 'upload-file', file, ok: true };
      case 'photo': {
        const small = await downscaleImage(file);
        const ocrText = ocr ? await ocr.recognize(small) : '';
        return { ...base, mode: 'upload-photo', file: small, ocrText, note: ocrText ? undefined : 'no text read', ok: true };
      }
      default:
        return { ...base, mode: 'skip', ok: false, error: 'unsupported file type' };
    }
  } catch (err) {
    return { ...base, mode: 'skip', ok: false, error: err instanceof Error ? err.message : 'could not read this file' };
  }
}

/** Run `fn` over `items` with a small concurrency window (photo OCR + uploads are heavy). */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
