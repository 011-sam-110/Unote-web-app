// Everything React needs to know about the page surface, in one hook.
//
// Holds the geometry box the ProseMirror plugin reads, the plan the plugin publishes, and
// the phone breakpoint below which pagination is switched off entirely. FolioEditor calls
// it unconditionally and branches on `active`, because a hook cannot be conditional and
// several surfaces (history preview, the read-only share view) render notes with no pages
// at all.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { BreakPlan, PagePlan } from './placeBreaks';
import { sheetOffsets } from './placeBreaks';
import { geometryFor, type PageGeometry } from './geometry';
import type { NoteLayout, Zone } from './layout';
import type { PaginationBox } from './PaginationExtension';
import type { PaginationOptions } from './paginationPlugin';
import { PAGE_SIZES } from './pageSizes';
import { readPageZoom, writePageZoom, ZOOM_EVENT } from './zoomPref';

/**
 * Below this width an A4 sheet scales to under half size, which renders the note's 19px
 * serif at about 9px - readable, but not writable. Phones keep the continuous column they
 * have always had; the layout still exists on the note and still governs export.
 */
export const PAGED_MIN_WIDTH_PX = 820;

export { ZOOM_STEPS } from './zoomPref';

export interface PagedSurfaceProps {
  layout: NoteLayout;
  /** Field values other than the page numbers, which come from the plan. */
  fields: { title: string; notebook: string; date: string };
  onEditBand: ((band: 'header' | 'footer', zone: Zone, first: boolean, value: string) => void) | null;
  /** Reports the live page count so the format bar can show "Page 2 of 7". */
  onPageCount?: (count: number) => void;
}

interface InactiveSurface {
  active: false;
  box: PaginationBox;
  zoom: number;
  setZoom: (z: number) => void;
}

interface ActiveSurface {
  active: true;
  box: PaginationBox;
  geometry: PageGeometry;
  layout: NoteLayout;
  pages: PagePlan[];
  fields: PagedSurfaceProps['fields'];
  onEditBand: PagedSurfaceProps['onEditBand'];
  style: CSSProperties;
  zoom: number;
  setZoom: (z: number) => void;
  /** Wrapper style that reserves the RIGHT amount of room for the scaled page stack. */
  zoomStyle: CSSProperties;
}

export type PagedSurface = InactiveSurface | ActiveSurface;

function useIsWideEnough(): boolean {
  const [wide, setWide] = useState(() =>
    typeof window === 'undefined' ? true : window.innerWidth >= PAGED_MIN_WIDTH_PX,
  );

  useEffect(() => {
    const query = window.matchMedia(`(min-width: ${PAGED_MIN_WIDTH_PX}px)`);
    const onChange = () => setWide(query.matches);
    onChange();
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return wide;
}

export function usePagedSurface(props: PagedSurfaceProps | undefined): PagedSurface {
  const wide = useIsWideEnough();
  const [plan, setPlan] = useState<BreakPlan | null>(null);
  // Read from the shared preference, and re-read whenever the format bar writes it. Two
  // copies of "what zoom is this" is how the page and the readout end up disagreeing.
  const [zoom, setZoomState] = useState(readPageZoom);
  useEffect(() => {
    const sync = () => setZoomState(readPageZoom());
    window.addEventListener(ZOOM_EVENT, sync);
    return () => window.removeEventListener(ZOOM_EVENT, sync);
  }, []);
  const setZoom = useCallback((z: number) => {
    writePageZoom(z);
    setZoomState(z);
  }, []);

  const paged = Boolean(props) && props!.layout.mode === 'paged' && wide;
  const geometry = useMemo(
    () => (props && paged ? geometryFor(props.layout) : null),
    // The layout object is rebuilt on every note fetch, so depending on it directly would
    // recompute (and republish) on every autosave response. These are the fields geometry
    // actually reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      paged,
      props?.layout.pageSize,
      props?.layout.orientation,
      props?.layout.custom.w,
      props?.layout.custom.h,
      props?.layout.margins.top,
      props?.layout.margins.right,
      props?.layout.margins.bottom,
      props?.layout.margins.left,
      props?.layout.header.on,
      props?.layout.footer.on,
    ],
  );

  // The plugin reads through this box on every measure, so the closure it captured at
  // editor-construction time keeps seeing current values without the extension list ever
  // being rebuilt.
  const box = useRef<PaginationOptions | null>(null);
  const geometryRef = useRef<PageGeometry | null>(geometry);
  geometryRef.current = geometry;

  // Kept in a ref so a parent passing an inline callback does not have to memoise it -
  // and so the box below, which is built exactly once, always calls the current one.
  const onPageCountRef = useRef(props?.onPageCount);
  onPageCountRef.current = props?.onPageCount;
  const pageCountRef = useRef(0);

  if (!box.current) {
    box.current = {
      getGeometry: () => geometryRef.current,
      onPlan: next => {
        setPlan(next);
        // Only when the count actually changes: the plan is republished whenever a break
        // moves, which on a long note is most keystrokes, and the format bar does not need
        // to re-render for a page whose number did not change.
        const count = next?.pages.length ?? 0;
        if (count !== pageCountRef.current) {
          pageCountRef.current = count;
          onPageCountRef.current?.(count);
        }
      },
    };
  }

  if (!props || !paged || !geometry) {
    return { active: false, box, zoom, setZoom };
  }

  // One sheet is always drawn, even before the first measure lands, so opening a note shows
  // paper immediately rather than a bare column that jumps into pages a frame later.
  const pages: PagePlan[] = plan?.pages ?? [{ usedPx: 0, overflowPx: 0, blockIndices: [] }];

  const printSize =
    props.layout.pageSize === 'custom'
      ? `${geometry.dimsMm.w}mm ${geometry.dimsMm.h}mm`
      : `${PAGE_SIZES[props.layout.pageSize].label} ${props.layout.orientation}`;

  const style = {
    '--folio-page-w': `${geometry.pageWidthPx}px`,
    '--folio-margin-l': `${geometry.marginLeftPx}px`,
    '--folio-margin-r': `${geometry.marginRightPx}px`,
    '--folio-content-top': `${geometry.marginTopPx + geometry.headerBandPx}px`,
    '--folio-content-h': `${geometry.contentHeightPx}px`,
    '--folio-sheet-gap': `${geometry.gapPx}px`,
    '--folio-print-size': printSize,
  } as CSSProperties;

  // Scaling is a transform, which does NOT affect layout - that is the point. Every
  // measurement the paginator takes stays in unscaled pixels, so zoom cannot perturb where
  // the breaks fall. The cost is that the scaled stack no longer occupies the right amount
  // of flow, which is what zoomStyle's explicit height puts back. The page plan already
  // knows the true total height, so this is exact rather than observed.
  const tops = sheetOffsets(pages, geometry.pageHeightPx, geometry.gapPx);
  const lastPage = pages[pages.length - 1];
  const documentHeightPx =
    (tops[tops.length - 1] ?? 0) + geometry.pageHeightPx + (lastPage?.overflowPx ?? 0);

  const zoomStyle: CSSProperties = {
    height: `${documentHeightPx * zoom}px`,
    // The scaled stack is narrower than the column, so centre what is actually drawn
    // rather than leaving it pinned left inside a full-width box.
    width: `${geometry.pageWidthPx * zoom}px`,
    margin: '0 auto',
  };

  return {
    active: true,
    box,
    geometry,
    layout: props.layout,
    pages,
    fields: props.fields,
    onEditBand: props.onEditBand,
    style: { ...style, transform: zoom === 1 ? undefined : `scale(${zoom})`, transformOrigin: 'top left' },
    zoom,
    setZoom,
    zoomStyle,
  };
}
