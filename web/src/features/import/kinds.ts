// Shared import-kind metadata used by ImportModal and CapturePage.
import type { IconName } from '../../components/Icon';

export type ImportKind = 'photo' | 'slides' | 'transcript';

export interface KindConfig {
  key: ImportKind;
  label: string;
  /** Vector icon (interactive chrome) - emoji is reserved for user content per Icon.tsx. */
  iconName: IconName;
  accept: string;
  hint: string;
  exts: string[];
  mimePrefixes?: string[];
}

export const IMPORT_KINDS: KindConfig[] = [
  {
    key: 'photo',
    label: 'Photo of notes',
    iconName: 'camera',
    accept: 'image/*,.heic,.heif',
    hint: 'JPEG, PNG, WEBP or HEIC · resized automatically',
    exts: ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'],
    mimePrefixes: ['image/'],
  },
  {
    key: 'slides',
    label: 'Lecture slides',
    iconName: 'layers',
    accept: '.pdf,.pptx,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation',
    hint: 'PDF or PPTX · up to 4MB',
    exts: ['pdf', 'pptx'],
  },
  {
    key: 'transcript',
    label: 'Transcript or essay',
    iconName: 'file-text',
    accept: '.txt,.md,.pdf,.docx,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    hint: 'TXT, MD, PDF or DOCX · up to 4MB',
    exts: ['txt', 'md', 'pdf', 'docx'],
  },
];

/**
 * What the user may hand us, per file.
 *
 * Deliberately larger than the 4MB the serverless import route accepts: photos are re-encoded to
 * fit (see imageFit.ts) before they are posted, so rejecting a 20MB camera original here would
 * refuse a file we can trivially handle. Non-photo kinds get no such treatment, so their real
 * ceiling is the server's - hence the split hints below.
 */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** The hard cap the API enforces on a single upload once deployed serverless. */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

export function findKind(kind: ImportKind): KindConfig {
  return IMPORT_KINDS.find(k => k.key === kind) ?? IMPORT_KINDS[0];
}

/** Inline validation: type + size. Returns a human-readable error, or null if the file is fine. */
export function validateFile(file: File, kind: ImportKind): string | null {
  // Photos are re-encoded to fit before upload, so a big camera original is fine. Everything else
  // is posted as-is and must already be under what the API will accept - telling the user here
  // beats letting them upload 20MB on mobile data and collecting a 413 at the end.
  const limit = kind === 'photo' ? MAX_FILE_BYTES : MAX_UPLOAD_BYTES;
  if (file.size > limit) {
    return `${file.name} is over the ${Math.round(limit / 1024 / 1024)}MB limit`;
  }
  const config = findKind(kind);
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const mimeOk = config.mimePrefixes?.some(prefix => file.type.startsWith(prefix)) ?? false;
  const extOk = config.exts.includes(ext);
  if (!mimeOk && !extOk) {
    return `${file.name} isn't a supported file for ${config.label.toLowerCase()}`;
  }
  return null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
