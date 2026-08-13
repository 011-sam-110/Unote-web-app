// The note's page layout: what shape of paper it is, how wide its margins are, and what
// its header and footer say.
//
// Stored on the note as `layout_json`. NULL means DEFAULT_LAYOUT below, which is why no
// backfill was needed when the column arrived - every note written before this feature
// existed simply reads as a default A4 document the first time it is opened.

import {
  MAX_PAGE_MM,
  MIN_PAGE_MM,
  PAGE_SIZES,
  type Orientation,
  type PageDimsMm,
  type PageSizeId,
  resolvePageDims,
} from './pageSizes';

/** Where a piece of header/footer text sits across the band. */
export type Zone = 'left' | 'center' | 'right';

export const ZONES: Zone[] = ['left', 'center', 'right'];

export type ZoneText = Record<Zone, string>;

export interface BandLayout {
  on: boolean;
  /** Word's "different first page". Off means every sheet uses `zones`. */
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
  /** `plain` is the per-note opt-out: the note renders as one continuous column, the way
   *  every note did before pagination existed. Boards are always plain. */
  mode: 'paged' | 'plain';
  pageSize: PageSizeId;
  custom: PageDimsMm;
  orientation: Orientation;
  margins: MarginsMm;
  header: BandLayout;
  footer: BandLayout;
}

/** 25.4mm is one inch, which is Word's own default and what a marker expects. */
export const DEFAULT_MARGIN_MM = 25.4;

function emptyZones(): ZoneText {
  return { left: '', center: '', right: '' };
}

function emptyBand(): BandLayout {
  return { on: false, differentFirst: false, zones: emptyZones(), firstZones: emptyZones() };
}

/**
 * What a note with no stored layout is.
 *
 * Header and footer are OFF, not empty-but-shown. An A4 sheet with two ruled empty bands
 * on it reads as a rendering fault rather than as a document waiting for a header, and
 * every existing note in the account would have grown them overnight.
 */
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
    // Bounded because this string is rendered on every sheet and stored on every save;
    // an accidental paste of a whole note into a header should not become the note.
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

/**
 * Turn whatever is in the database into a layout we can render.
 *
 * Deliberately total: every branch returns a usable layout rather than throwing. This
 * parses a column that older clients never wrote, that a future client may write new keys
 * into, and that a sync conflict can in principle leave half-written - and the cost of
 * throwing here is a note that will not open at all. An unrecognised page size falls back
 * to A4 rather than to `custom`, because a custom size with no dimensions is a blank sheet.
 */
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

export function serializeLayout(layout: NoteLayout): string {
  return JSON.stringify(layout);
}

/** True when this layout would render identically to a note that has never been touched,
 *  so the caller can store NULL instead of a default blob on every note in the account. */
export function isDefaultLayout(layout: NoteLayout): boolean {
  return serializeLayout(layout) === serializeLayout(defaultLayout());
}

export function pageDims(layout: NoteLayout): PageDimsMm {
  return resolvePageDims(layout.pageSize, layout.orientation, layout.custom);
}

/**
 * The usable text box on one sheet, in mm.
 *
 * Never returns a non-positive height: margins wider than the paper are reachable through
 * a hand-edited layout, and a zero or negative content box turns the break loop into an
 * infinite one. Clamped to a single line's worth instead, which renders as an obviously
 * broken document the user can then fix - visibly wrong beats hung.
 */
export function contentBoxMm(layout: NoteLayout, bandsMm = 0): PageDimsMm {
  const { w, h } = pageDims(layout);
  return {
    w: Math.max(10, w - layout.margins.left - layout.margins.right),
    h: Math.max(10, h - layout.margins.top - layout.margins.bottom - bandsMm),
  };
}
