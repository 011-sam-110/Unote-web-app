// Server-side mirror of the note page layout.
//
// The client owns the interactive model (web/src/features/editor/pagination/). This copy
// exists because DOCX export has to write real section properties - page size and margins
// in twips - and the server cannot import from the web workspace without breaking its own
// tsc build.
//
// The two are pinned together by test/pageLayout.parity.test.ts. That test is not
// ceremony: if the screen and the DOCX disagree about how big A4 is, the symptom is a page
// count that silently changes on export, and nobody would think to suspect a constant.

export interface PageDimsMm {
  w: number;
  h: number;
}

export const PAGE_SIZES = {
  a3: { label: 'A3', w: 297, h: 420 },
  a4: { label: 'A4', w: 210, h: 297 },
  a5: { label: 'A5', w: 148, h: 210 },
  letter: { label: 'Letter', w: 215.9, h: 279.4 },
  legal: { label: 'Legal', w: 215.9, h: 355.6 },
  executive: { label: 'Executive', w: 184.15, h: 266.7 },
} as const;

export type StandardPageSizeId = keyof typeof PAGE_SIZES;
export type PageSizeId = StandardPageSizeId | 'custom';
export type Orientation = 'portrait' | 'landscape';
export type Zone = 'left' | 'center' | 'right';

export const ZONES: Zone[] = ['left', 'center', 'right'];
export const DEFAULT_MARGIN_MM = 25.4;
export const MIN_PAGE_MM = 50;
export const MAX_PAGE_MM = 2000;

export type ZoneText = Record<Zone, string>;

export interface BandLayout {
  on: boolean;
  differentFirst: boolean;
  zones: ZoneText;
  firstZones: ZoneText;
}

export interface MarginsMm {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface NoteLayout {
  mode: 'paged' | 'plain';
  pageSize: PageSizeId;
  custom: PageDimsMm;
  orientation: Orientation;
  margins: MarginsMm;
  header: BandLayout;
  footer: BandLayout;
}

function emptyZones(): ZoneText {
  return { left: '', center: '', right: '' };
}

function emptyBand(): BandLayout {
  return { on: false, differentFirst: false, zones: emptyZones(), firstZones: emptyZones() };
}

export function defaultLayout(): NoteLayout {
  return {
    mode: 'paged',
    pageSize: 'a4',
    custom: { w: PAGE_SIZES.a4.w, h: PAGE_SIZES.a4.h },
    orientation: 'portrait',
    margins: {
      top: DEFAULT_MARGIN_MM,
      right: DEFAULT_MARGIN_MM,
      bottom: DEFAULT_MARGIN_MM,
      left: DEFAULT_MARGIN_MM,
    },
    header: emptyBand(),
    footer: emptyBand(),
  };
}

function clampMm(value: unknown, fallback: number, min = 0, max = MAX_PAGE_MM): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function readZones(raw: unknown): ZoneText {
  const src = (raw ?? {}) as Partial<Record<Zone, unknown>>;
  const out = emptyZones();
  for (const zone of ZONES) {
    const value = src[zone];
    if (typeof value === 'string') out[zone] = value.slice(0, 200);
  }
  return out;
}

function readBand(raw: unknown): BandLayout {
  const src = (raw ?? {}) as Record<string, unknown>;
  return {
    on: src.on === true,
    differentFirst: src.differentFirst === true,
    zones: readZones(src.zones),
    firstZones: readZones(src.firstZones),
  };
}

/** Total, like the client's copy: every branch yields a usable layout. A note that will
 *  not open is a far worse outcome than a note that opens with default margins. */
export function parseLayout(raw: string | null | undefined): NoteLayout {
  const base = defaultLayout();
  if (!raw) return base;

  let src: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return base;
    src = parsed as Record<string, unknown>;
  } catch {
    return base;
  }

  const pageSize =
    src.pageSize === 'custom' || (typeof src.pageSize === 'string' && src.pageSize in PAGE_SIZES)
      ? (src.pageSize as PageSizeId)
      : base.pageSize;

  const customSrc = (src.custom ?? {}) as Record<string, unknown>;
  const margins = (src.margins ?? {}) as Record<string, unknown>;

  return {
    mode: src.mode === 'plain' ? 'plain' : 'paged',
    pageSize,
    custom: {
      w: clampMm(customSrc.w, base.custom.w, MIN_PAGE_MM),
      h: clampMm(customSrc.h, base.custom.h, MIN_PAGE_MM),
    },
    orientation: src.orientation === 'landscape' ? 'landscape' : 'portrait',
    margins: {
      top: clampMm(margins.top, DEFAULT_MARGIN_MM),
      right: clampMm(margins.right, DEFAULT_MARGIN_MM),
      bottom: clampMm(margins.bottom, DEFAULT_MARGIN_MM),
      left: clampMm(margins.left, DEFAULT_MARGIN_MM),
    },
    header: readBand(src.header),
    footer: readBand(src.footer),
  };
}

export function resolvePageDims(
  size: PageSizeId,
  orientation: Orientation,
  custom?: PageDimsMm,
): PageDimsMm {
  const base: PageDimsMm =
    size === 'custom'
      ? { w: custom?.w ?? PAGE_SIZES.a4.w, h: custom?.h ?? PAGE_SIZES.a4.h }
      : { w: PAGE_SIZES[size].w, h: PAGE_SIZES[size].h };
  return orientation === 'landscape' ? { w: base.h, h: base.w } : base;
}

export function pageDims(layout: NoteLayout): PageDimsMm {
  return resolvePageDims(layout.pageSize, layout.orientation, layout.custom);
}

/**
 * Millimetres to twips (twentieths of a point), the unit OOXML measures pages in.
 *
 * 1 inch = 1440 twips = 25.4mm. Rounded because Word rejects fractional twips in section
 * properties - it does not error, it silently substitutes its own default, which shows up
 * as a document that opens at Letter size no matter what was asked for.
 */
export function mmToTwip(mm: number): number {
  return Math.round((mm / 25.4) * 1440);
}
