// The infinite board. Composes the viewport, the document model, the ink layer
// and the selection interactions into one page.
//
// Layering inside `.cv-board`, bottom to top:
//   .cv-world   items + connectors, in world coordinates under one CSS transform
//   .cv-ink     stylus ink, always drawn ON TOP of items (you annotate over cards),
//               but pointer-transparent unless an ink tool is armed
//   chrome      toolbars, which are the only fixed-size elements on the board
//
// Note on ink storage: board ink goes to note_ink via /api/canvas/:id/ink rather
// than becoming canvas_items of kind='ink'. One code path then serves both the
// board and the doc-note overlay, and stroke-level undo/erase falls out of the
// append-only API for free.

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Icon from '../../components/Icon';
import Tooltip from '../../components/Tooltip';
import EmptyState from '../../components/EmptyState';
import { toast } from '../../components/Toast';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/format';
import type { CanvasItem, CanvasItemData, CanvasItemKind, InkTool, Note } from '../../lib/types';
import {
  bounds,
  centerOf,
  rectContains,
  rectFromPoints,
  rectOf,
  rectsIntersect,
  toWorld,
  type Point,
  type Rect,
  type Viewport,
} from './geometry';
import { DEFAULT_SIZES, MIN_SIZE, defaultDataFor, labelFor, type HandleId } from './items';
import { defaultColorFor, defaultWidthFor, inkBounds, type LocalStroke } from './strokes';
import { useCanvasBoard, type ItemPatch } from './useCanvasBoard';
import { useInkLayer } from './useInkLayer';
import { useUndoStack } from './useUndoStack';
import { useViewport } from './useViewport';
import CanvasItemView from './CanvasItemView';
import Connectors from './Connectors';
import InkSurface from './InkSurface';
import InkToolbar from './InkToolbar';
import SelectionToolbar from './SelectionToolbar';
import NotePickerModal from './NotePickerModal';
import ShareButton from '../share/ShareButton';
import { uploadImageWithProgress } from '../import/uploadImageWithProgress';
import './canvas.css';

type PlacementMode = 'sticky' | 'text' | 'rect' | 'ellipse' | 'arrow';
type BoardMode = 'select' | PlacementMode | InkTool;

const INK_MODES: BoardMode[] = ['pen', 'highlighter', 'eraser'];
const isInkMode = (m: BoardMode): m is InkTool => (INK_MODES as string[]).includes(m);

/** Below this the drag is treated as a click, so a shaky click does not nudge an
 *  item by a pixel and push a pointless undo entry. */
const DRAG_THRESHOLD_PX = 3;

export interface CanvasBoardProps {
  note: Note;
}

export default function CanvasBoard({ note }: CanvasBoardProps) {
  const navigate = useNavigate();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const doc = useCanvasBoard(note.id);
  const ink = useInkLayer(note.id, true);
  const undo = useUndoStack();
  const { viewport, setViewport, panning, spaceHeld, gestureRef, zoomTo, zoomToFit, beginPan } = useViewport(hostRef);

  // Scrolls an item into the middle of the board. Used by keyboard selection: a
  // selected item that stays off-screen is no better than no selection at all.
  const centreOn = useCallback(
    (item: Rect) => {
      const host = hostRef.current;
      if (!host) return;
      const host_ = host.getBoundingClientRect();
      const c = centerOf(item);
      setViewport((vp) => ({ ...vp, x: host_.width / 2 - c.x * vp.scale, y: host_.height / 2 - c.y * vp.scale }));
    },
    [setViewport],
  );

  const [mode, setMode] = useState<BoardMode>('select');
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [marquee, setMarquee] = useState<{ a: Point; b: Point } | null>(null);
  const [pendingConnect, setPendingConnect] = useState<{ from: CanvasItem; to: Point } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [title, setTitle] = useState(note.title);

  const [inkColor, setInkColor] = useState<Record<'pen' | 'highlighter', string>>({
    pen: defaultColorFor('pen'),
    highlighter: defaultColorFor('highlighter'),
  });
  const [inkWidth, setInkWidth] = useState<Record<'pen' | 'highlighter', number>>({
    pen: defaultWidthFor('pen'),
    highlighter: defaultWidthFor('highlighter'),
  });
  const [fingerDraws, setFingerDraws] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Window-bound pointer handlers must read the CURRENT viewport/items, but are
  // created once per gesture - refs, not deps.
  const vpRef = useRef<Viewport>(viewport);
  vpRef.current = viewport;
  const itemsRef = useRef(doc.items);
  itemsRef.current = doc.items;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  const inkTool: InkTool = isInkMode(mode) ? mode : 'pen';
  const inkActive = isInkMode(mode);
  const activeInkColor = inkColor[inkTool === 'eraser' ? 'pen' : inkTool];
  const activeInkWidth = inkWidth[inkTool === 'eraser' ? 'pen' : inkTool];

  const selectedItems = useMemo(() => doc.items.filter((i) => selection.has(i.id)), [doc.items, selection]);

  /** Pointer position in the host's own pixel space. */
  const hostPoint = useCallback((e: { clientX: number; clientY: number }): Point => {
    const rect = hostRef.current?.getBoundingClientRect();
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
  }, []);

  const worldPoint = useCallback((e: { clientX: number; clientY: number }): Point => toWorld(hostPoint(e), vpRef.current), [hostPoint]);

  // --- initial framing ------------------------------------------------------
  // Fit once, when the board first has content and a measured size. Re-fitting on
  // every change would yank the view out from under someone who has panned away.
  const framedRef = useRef(false);
  useEffect(() => {
    if (framedRef.current || doc.status !== 'ready') return;
    framedRef.current = true;
    const content = bounds(doc.items.map(rectOf));
    zoomToFit(content ?? inkBounds(ink.strokes));
  }, [doc.status, doc.items, ink.strokes, zoomToFit]);

  // --- title ---------------------------------------------------------------
  const titleTimer = useRef<number | null>(null);
  function handleTitleChange(next: string) {
    setTitle(next);
    if (titleTimer.current !== null) window.clearTimeout(titleTimer.current);
    titleTimer.current = window.setTimeout(() => {
      api.updateNote(note.id, { title: next }).catch(() => toast('Could not rename this canvas', 'error'));
    }, 600);
  }
  useEffect(() => {
    document.title = `${title || 'Untitled canvas'} · Unote`;
  }, [title]);

  // --- helpers --------------------------------------------------------------

  const itemAt = useCallback((world: Point, exclude?: string): CanvasItem | null => {
    // Topmost first: z ascending is render order, so search it in reverse.
    const sorted = [...itemsRef.current].sort((a, b) => b.z - a.z);
    for (const it of sorted) {
      if (it.id === exclude) continue;
      if (rectContains(rectOf(it), world)) return it;
    }
    return null;
  }, []);

  /** Apply patches locally + persist + record one undo entry for the pair. */
  const commitPatches = useCallback(
    (before: ItemPatch[], after: ItemPatch[], label: string) => {
      if (after.length === 0) return;
      doc.patchLocal(after);
      doc.queuePatch(after);
      undo.push({
        label,
        undo: () => {
          doc.patchLocal(before);
          doc.queuePatch(before);
        },
        redo: () => {
          doc.patchLocal(after);
          doc.queuePatch(after);
        },
      });
    },
    [doc, undo],
  );

  const addItems = useCallback(
    async (specs: Array<{ kind: CanvasItemKind; x: number; y: number; width: number; height: number; data?: CanvasItemData }>, label: string) => {
      const created = await doc.createItems(specs);
      if (created.length === 0) return [];
      setSelection(new Set(created.map((c) => c.id)));
      setSelectedEdgeId(null);
      undo.push({
        label,
        undo: () => doc.destroyItems(created.map((c) => c.id)),
        // restore() re-creates and records the id remap, so a second undo after
        // this redo still finds the right rows.
        redo: () => void doc.restore(created, []),
      });
      return created;
    },
    [doc, undo],
  );

  const deleteSelection = useCallback(() => {
    const ids = [...selectionRef.current];
    if (ids.length === 0) return;
    const removed = itemsRef.current.filter((i) => ids.includes(i.id));
    // Capture the connectors too: the server cascades them, so an undo that only
    // restored the items would silently lose every arrow attached to them.
    const removedEdges = doc.edges.filter((e) => ids.includes(e.from) || ids.includes(e.to));
    doc.destroyItems(ids);
    setSelection(new Set());
    setEditingId(null);
    undo.push({
      label: removed.length === 1 ? labelFor(removed[0].kind) : `${removed.length} items`,
      undo: () => void doc.restore(removed, removedEdges),
      redo: () => doc.destroyItems(removed.map((i) => i.id)),
    });
  }, [doc, undo]);

  const duplicateSelection = useCallback(async () => {
    const sel = itemsRef.current.filter((i) => selectionRef.current.has(i.id));
    if (sel.length === 0) return;
    await addItems(
      sel.map((i) => ({ kind: i.kind, x: i.x + 24, y: i.y + 24, width: i.width, height: i.height, data: i.data })),
      sel.length === 1 ? labelFor(sel[0].kind) : `${sel.length} items`,
    );
  }, [addItems]);

  const changeZ = useCallback(
    (toFront: boolean) => {
      const sel = itemsRef.current.filter((i) => selectionRef.current.has(i.id));
      if (sel.length === 0) return;
      const zs = itemsRef.current.map((i) => i.z);
      const edge = toFront ? Math.max(0, ...zs) : Math.min(0, ...zs);
      const before = sel.map((i) => ({ id: i.id, z: i.z }));
      // Keep the selection's own relative order while moving it as a block.
      const ordered = [...sel].sort((a, b) => a.z - b.z);
      const after = ordered.map((i, idx) => ({ id: i.id, z: toFront ? edge + 1 + idx : edge - ordered.length + idx }));
      commitPatches(before, after, toFront ? 'bring to front' : 'send to back');
    },
    [commitPatches],
  );

  const setSelectionColor = useCallback(
    (color: string) => {
      const sel = itemsRef.current.filter((i) => selectionRef.current.has(i.id));
      if (sel.length === 0) return;
      commitPatches(
        sel.map((i) => ({ id: i.id, data: i.data })),
        sel.map((i) => ({ id: i.id, data: { ...i.data, color } })),
        'colour',
      );
    },
    [commitPatches],
  );

  // --- item drag / resize / connect -----------------------------------------

  const beginDrag = useCallback(
    (e: ReactPointerEvent, ids: Set<string>) => {
      const start = worldPoint(e);
      const origin = itemsRef.current.filter((i) => ids.has(i.id)).map((i) => ({ id: i.id, x: i.x, y: i.y }));
      if (origin.length === 0) return;
      let moved = false;
      let last = { dx: 0, dy: 0 };

      function onMove(ev: PointerEvent) {
        // A second finger means the user switched to navigating; abandon the drag
        // rather than fighting the pinch.
        if (gestureRef.current) {
          finish();
          return;
        }
        const rect = hostRef.current?.getBoundingClientRect();
        const w = toWorld({ x: ev.clientX - (rect?.left ?? 0), y: ev.clientY - (rect?.top ?? 0) }, vpRef.current);
        const dx = w.x - start.x;
        const dy = w.y - start.y;
        if (!moved && Math.hypot(dx, dy) * vpRef.current.scale < DRAG_THRESHOLD_PX) return;
        moved = true;
        last = { dx, dy };
        // Local only - NOT a request. The whole point of the bulk PATCH is that
        // this loop never touches the network.
        doc.patchLocal(origin.map((o) => ({ id: o.id, x: o.x + dx, y: o.y + dy })));
      }

      function finish() {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
        if (!moved) return;
        const before = origin.map((o) => ({ id: o.id, x: o.x, y: o.y }));
        const after = origin.map((o) => ({ id: o.id, x: o.x + last.dx, y: o.y + last.dy }));
        doc.queuePatch(after);
        undo.push({
          label: origin.length === 1 ? 'move' : `move ${origin.length} items`,
          undo: () => {
            doc.patchLocal(before);
            doc.queuePatch(before);
          },
          redo: () => {
            doc.patchLocal(after);
            doc.queuePatch(after);
          },
        });
      }

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', finish);
    },
    [doc, undo, worldPoint, gestureRef],
  );

  const beginResize = useCallback(
    (e: ReactPointerEvent, item: CanvasItem, handle: HandleId) => {
      const start = worldPoint(e);
      const s = { x: item.x, y: item.y, w: item.width, h: item.height };
      let moved = false;
      let latest: Rect = { x: s.x, y: s.y, width: s.w, height: s.h };

      function onMove(ev: PointerEvent) {
        const rect = hostRef.current?.getBoundingClientRect();
        const w = toWorld({ x: ev.clientX - (rect?.left ?? 0), y: ev.clientY - (rect?.top ?? 0) }, vpRef.current);
        const dx = w.x - start.x;
        const dy = w.y - start.y;
        if (!moved && Math.hypot(dx, dy) * vpRef.current.scale < DRAG_THRESHOLD_PX) return;
        moved = true;

        // Handles on the left/top edge move the origin and keep the opposite edge
        // pinned; the min-size clamp is applied to the WIDTH first so the origin
        // stays consistent with it (clamping x afterwards would let the box drift).
        const movesX = handle === 'nw' || handle === 'sw';
        const movesY = handle === 'nw' || handle === 'ne';
        const width = Math.max(MIN_SIZE, movesX ? s.w - dx : s.w + dx);
        const height = Math.max(MIN_SIZE, movesY ? s.h - dy : s.h + dy);
        const x = movesX ? s.x + s.w - width : s.x;
        const y = movesY ? s.y + s.h - height : s.y;
        latest = { x, y, width, height };
        doc.patchLocal([{ id: item.id, ...latest }]);
      }

      function finish() {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
        if (!moved) return;
        const before = [{ id: item.id, x: s.x, y: s.y, width: s.w, height: s.h }];
        const after = [{ id: item.id, ...latest }];
        doc.queuePatch(after);
        undo.push({
          label: 'resize',
          undo: () => {
            doc.patchLocal(before);
            doc.queuePatch(before);
          },
          redo: () => {
            doc.patchLocal(after);
            doc.queuePatch(after);
          },
        });
      }

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', finish);
    },
    [doc, undo, worldPoint],
  );

  const beginConnect = useCallback(
    (e: ReactPointerEvent, item: CanvasItem) => {
      setPendingConnect({ from: item, to: worldPoint(e) });

      function onMove(ev: PointerEvent) {
        const rect = hostRef.current?.getBoundingClientRect();
        const w = toWorld({ x: ev.clientX - (rect?.left ?? 0), y: ev.clientY - (rect?.top ?? 0) }, vpRef.current);
        setPendingConnect({ from: item, to: w });
      }

      async function finish(ev: PointerEvent) {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
        setPendingConnect(null);
        const rect = hostRef.current?.getBoundingClientRect();
        const w = toWorld({ x: ev.clientX - (rect?.left ?? 0), y: ev.clientY - (rect?.top ?? 0) }, vpRef.current);
        const target = itemAt(w, item.id);
        if (!target) return;
        const edge = await doc.createEdge(item.id, target.id);
        if (!edge) return;
        undo.push({
          label: 'connector',
          undo: () => doc.destroyEdge(edge.id),
          redo: () => void doc.createEdge(item.id, target.id),
        });
      }

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', finish);
    },
    [doc, undo, worldPoint, itemAt],
  );

  function handleItemPointerDown(e: ReactPointerEvent, item: CanvasItem) {
    // In a placement mode the click belongs to the board, not the item, so it can
    // drop a new sticky on top of an existing one.
    if (mode !== 'select') return;
    if (spaceHeld || e.button === 1) {
      e.stopPropagation();
      beginPan(e);
      return;
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.stopPropagation();
    setSelectedEdgeId(null);

    const next = new Set(selectionRef.current);
    if (e.shiftKey) {
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
    } else if (!next.has(item.id)) {
      next.clear();
      next.add(item.id);
    }
    setSelection(next);
    selectionRef.current = next;

    if (editingId && editingId !== item.id) setEditingId(null);
    // While a textarea is open the pointer belongs to the text, not to a drag.
    if (editingId === item.id) return;
    if (next.has(item.id)) beginDrag(e, next);
  }

  // --- board background -----------------------------------------------------

  function handleBoardPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (editingId) setEditingId(null);
    if (spaceHeld || e.button === 1) {
      beginPan(e);
      return;
    }
    if (e.pointerType === 'touch') {
      // A tap in a placement mode still places - otherwise the tool row would do
      // nothing at all on a tablet.
      if (mode !== 'select' && !isInkMode(mode)) {
        void placeItem(mode, worldPoint(e));
        return;
      }
      // Otherwise one finger NAVIGATES. That is the whole reason a stylus feels
      // right here: the pen draws and selects, the hand scrolls the board -
      // exactly the split Freeform uses. useViewport promotes this to a pinch if
      // a second finger arrives, and beginPan yields to it.
      beginPan(e);
      return;
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    if (mode !== 'select' && !isInkMode(mode)) {
      void placeItem(mode, worldPoint(e));
      return;
    }
    if (isInkMode(mode)) return;

    // Marquee.
    setSelectedEdgeId(null);
    if (!e.shiftKey) {
      setSelection(new Set());
      selectionRef.current = new Set();
    }
    const start = worldPoint(e);
    const baseSelection = e.shiftKey ? new Set(selectionRef.current) : new Set<string>();
    setMarquee({ a: start, b: start });

    function onMove(ev: PointerEvent) {
      const rect = hostRef.current?.getBoundingClientRect();
      const w = toWorld({ x: ev.clientX - (rect?.left ?? 0), y: ev.clientY - (rect?.top ?? 0) }, vpRef.current);
      setMarquee({ a: start, b: w });
      const box = rectFromPoints(start, w);
      const next = new Set(baseSelection);
      for (const it of itemsRef.current) if (rectsIntersect(box, rectOf(it))) next.add(it.id);
      setSelection(next);
      selectionRef.current = next;
    }
    function finish() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      setMarquee(null);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  }

  const placeItem = useCallback(
    async (placement: PlacementMode, at: Point) => {
      const kind: CanvasItemKind = placement === 'sticky' ? 'sticky' : placement === 'text' ? 'text' : 'shape';
      const shape = placement === 'rect' || placement === 'ellipse' || placement === 'arrow' ? placement : undefined;
      const size = DEFAULT_SIZES[kind];
      const created = await addItems(
        [{ kind, x: at.x - size.width / 2, y: at.y - size.height / 2, width: size.width, height: size.height, data: defaultDataFor(kind, shape) }],
        labelFor(kind),
      );
      setMode('select');
      // Drop straight into typing: placing a sticky you then have to double-click
      // to write in is a pointless extra step.
      if (created[0] && (kind === 'sticky' || kind === 'text')) setEditingId(created[0].id);
    },
    [addItems],
  );

  // --- images ---------------------------------------------------------------

  const addImageFiles = useCallback(
    async (files: readonly File[], at: Point) => {
      const images = files.filter((f) => f.type.startsWith('image/'));
      if (images.length === 0) return;
      for (const [i, file] of images.entries()) {
        try {
          // Downscaled and reported, exactly as the editor's drop is. This used to post the
          // original bytes with nothing on screen - and a board drop is usually SEVERAL
          // photos at once, so it was the worst instance of that in the app.
          const { url } = await uploadImageWithProgress(
            file,
            images.length > 1 ? `Adding image ${i + 1} of ${images.length}…` : 'Adding image…',
          );
          // Probe the natural size so a portrait photo does not land in a
          // landscape box and letterbox itself.
          const size = await naturalSize(url).catch(() => ({ width: DEFAULT_SIZES.image.width, height: DEFAULT_SIZES.image.height }));
          const max = 420;
          const ratio = Math.min(1, max / Math.max(size.width, size.height));
          await addItems(
            [{
              kind: 'image',
              x: at.x + i * 24 - (size.width * ratio) / 2,
              y: at.y + i * 24 - (size.height * ratio) / 2,
              width: size.width * ratio,
              height: size.height * ratio,
              data: { url },
            }],
            'image',
          );
        } catch (e) {
          toast(errorMessage(e, 'Could not add that image'), 'error');
        }
      }
    },
    [addItems],
  );

  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      // Array.from, not spread: FileList is array-LIKE but is only iterable under
      // the DOM.Iterable lib, which this project does not enable.
      const files = e.clipboardData ? Array.from(e.clipboardData.files) : [];
      if (files.length === 0) return;
      e.preventDefault();
      const host = hostRef.current;
      const center = host
        ? toWorld({ x: host.clientWidth / 2, y: host.clientHeight / 2 }, vpRef.current)
        : { x: 0, y: 0 };
      void addImageFiles(files, center);
    }
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [addImageFiles]);

  // --- keyboard -------------------------------------------------------------

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      const mod = e.ctrlKey || e.metaKey;

      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        const entry = e.shiftKey ? undo.redo() : undo.undo();
        if (entry) toast(`${e.shiftKey ? 'Redid' : 'Undid'} ${entry.label}`, 'info', { durationMs: 1400 });
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        const entry = undo.redo();
        if (entry) toast(`Redid ${entry.label}`, 'info', { durationMs: 1400 });
        return;
      }
      if (typing) return;

      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        const all = new Set(itemsRef.current.map((i) => i.id));
        setSelection(all);
        selectionRef.current = all;
        return;
      }
      if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        void duplicateSelection();
        return;
      }
      if (mod && e.key === '0') {
        e.preventDefault();
        zoomTo(1);
        return;
      }
      if (mod) return; // leave every other ⌘-combo to the app shell

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedEdgeId) {
          e.preventDefault();
          const edge = doc.edges.find((x) => x.id === selectedEdgeId);
          doc.destroyEdge(selectedEdgeId);
          setSelectedEdgeId(null);
          if (edge) {
            undo.push({
              label: 'connector',
              undo: () => void doc.createEdge(edge.from, edge.to),
              redo: () => doc.destroyEdge(edge.id),
            });
          }
          return;
        }
        if (selectionRef.current.size > 0) {
          e.preventDefault();
          deleteSelection();
        }
        return;
      }
      if (e.key === 'Escape') {
        setEditingId(null);
        setSelection(new Set());
        selectionRef.current = new Set();
        setSelectedEdgeId(null);
        setMode('select');
        return;
      }

      // --- keyboard-only item handling ---------------------------------------
      // A board is inherently a pointer surface, but selecting, moving and editing
      // an item must not REQUIRE a pointer. Tab cycles the selection through items
      // in reading order, arrows nudge, Enter edits. (Creating an item at an
      // arbitrary point and freehand ink remain pointer/stylus-only - that
      // limitation is stated in the board's help text rather than left silent.)
      const ordered = [...itemsRef.current].sort((a, b) => a.y - b.y || a.x - b.x);
      if (e.key === 'Tab' && ordered.length > 0) {
        e.preventDefault();
        const currentId = [...selectionRef.current][0];
        const at = ordered.findIndex((i) => i.id === currentId);
        const step = e.shiftKey ? -1 : 1;
        const next = ordered[(at + step + ordered.length) % ordered.length];
        const sel = new Set([next.id]);
        setSelection(sel);
        selectionRef.current = sel;
        setSelectedEdgeId(null);
        // Bring the newly selected item into view; off-screen selection is useless.
        centreOn(rectOf(next));
        return;
      }

      const NUDGE = e.shiftKey ? 40 : 8;
      const delta =
        e.key === 'ArrowLeft' ? { dx: -NUDGE, dy: 0 }
        : e.key === 'ArrowRight' ? { dx: NUDGE, dy: 0 }
        : e.key === 'ArrowUp' ? { dx: 0, dy: -NUDGE }
        : e.key === 'ArrowDown' ? { dx: 0, dy: NUDGE }
        : null;
      if (delta && selectionRef.current.size > 0) {
        e.preventDefault();
        const ids = selectionRef.current;
        const origin = itemsRef.current.filter((i) => ids.has(i.id)).map((i) => ({ id: i.id, x: i.x, y: i.y }));
        if (origin.length === 0) return;
        const after = origin.map((o) => ({ id: o.id, x: o.x + delta.dx, y: o.y + delta.dy }));
        doc.patchLocal(after);
        doc.queuePatch(after);
        undo.push({
          label: origin.length === 1 ? 'move' : `move ${origin.length} items`,
          undo: () => { doc.patchLocal(origin); doc.queuePatch(origin); },
          redo: () => { doc.patchLocal(after); doc.queuePatch(after); },
        });
        return;
      }

      if (e.key === 'Enter' && selectionRef.current.size === 1) {
        e.preventDefault();
        setEditingId([...selectionRef.current][0]);
        return;
      }
      // Single-key tool switches, the convention every board tool shares.
      const keyed: Record<string, BoardMode> = { v: 'select', s: 'sticky', t: 'text', r: 'rect', o: 'ellipse', p: 'pen', h: 'highlighter', e: 'eraser' };
      const next = keyed[e.key.toLowerCase()];
      if (next) {
        e.preventDefault();
        setMode(next);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [undo, deleteSelection, duplicateSelection, zoomTo, selectedEdgeId, doc, centreOn]);

  // --- ink undo entries -----------------------------------------------------

  const handleStrokeCommitted = useCallback(
    (stroke: LocalStroke) => {
      // Ids change when a stroke is restored, so the entry tracks the live one.
      const ref = { current: stroke };
      undo.push({
        label: 'stroke',
        undo: () => ink.removeStrokes([ref.current.id]),
        redo: () => {
          const revived = ink.restoreStrokes([ref.current]);
          if (revived[0]) ref.current = revived[0];
        },
      });
    },
    [ink, undo],
  );

  const handleErased = useCallback(
    (removed: LocalStroke[]) => {
      const ref = { current: removed };
      undo.push({
        label: removed.length === 1 ? 'erase' : `erase ${removed.length} strokes`,
        undo: () => {
          const revived = ink.restoreStrokes(ref.current);
          if (revived.length > 0) ref.current = revived;
        },
        redo: () => ink.removeStrokes(ref.current.map((s) => s.id)),
      });
    },
    [ink, undo],
  );

  const handleClearInk = useCallback(() => {
    const all = ink.strokes;
    if (all.length === 0) return;
    const ref = { current: all };
    void ink.clearAll();
    undo.push({
      label: 'clear ink',
      undo: () => {
        const revived = ink.restoreStrokes(ref.current);
        if (revived.length > 0) ref.current = revived;
      },
      redo: () => ink.removeStrokes(ref.current.map((s) => s.id)),
    });
  }, [ink, undo]);

  // --- text commit ----------------------------------------------------------

  const handleCommitText = useCallback(
    (item: CanvasItem, text: string) => {
      setEditingId(null);
      if ((item.data.text ?? '') === text) return;
      commitPatches([{ id: item.id, data: item.data }], [{ id: item.id, data: { ...item.data, text } }], 'text');
    },
    [commitPatches],
  );

  // --- render ---------------------------------------------------------------

  const selBounds = useMemo(() => bounds(selectedItems.map(rectOf)), [selectedItems]);
  const selToolbarPos = useMemo(() => {
    if (!selBounds || editingId) return null;
    const x = selBounds.x * viewport.scale + viewport.x + (selBounds.width * viewport.scale) / 2;
    const y = selBounds.y * viewport.scale + viewport.y;
    return { left: x, top: y - 46 };
  }, [selBounds, viewport, editingId]);

  const marqueeRect = marquee ? rectFromPoints(marquee.a, marquee.b) : null;
  const cursor = spaceHeld || panning ? (panning ? 'grabbing' : 'grab') : mode === 'select' ? 'default' : isInkMode(mode) ? 'crosshair' : 'copy';

  if (doc.status === 'error') {
    return (
      <div className="cv-page cv-page--message">
        <EmptyState
          icon="⚠️"
          title="Couldn't load this canvas"
          hint={doc.error}
          action={
            <button type="button" className="folio-btn-primary" onClick={doc.reload}>
              Retry
            </button>
          }
        />
      </div>
    );
  }

  return (
    <div className="cv-page">
      <header className="cv-header">
        <Link to={`/notebook/${note.notebook.id}`} className="cv-header__crumb">
          {note.notebook.emoji} {note.notebook.name}
        </Link>
        <span className="cv-header__sep" aria-hidden="true">
          ›
        </span>
        <input
          className="cv-header__title"
          value={title}
          placeholder="Untitled canvas"
          aria-label="Canvas title"
          onChange={(e) => handleTitleChange(e.target.value)}
        />
        <span className="cv-header__badge">
          <Icon name="canvas" size={13} /> Canvas
        </span>
        <ShareButton noteId={note.id} noteTitle={title} kind={note.kind} />
      </header>

      {/* A board is a spatial, pointer-first surface. Rather than leave that
          silently unusable for keyboard and screen-reader users, the region names
          itself, states what IS keyboard-operable, and names the two things that
          genuinely are not (placing an item at an arbitrary point, and freehand
          ink). `cv-board__help` is visually hidden but read on focus. */}
      <p id="cv-board-help" className="folio-visually-hidden">
        Infinite canvas with {doc.items.length} {doc.items.length === 1 ? 'item' : 'items'}. Keyboard: Tab and
        Shift+Tab move through items, arrow keys move the selected item (hold Shift for larger steps), Enter edits
        it, Delete removes it, Control+A selects all, Control+0 resets zoom, and V, S, T, R, O, P, H and E switch
        tools. Placing a new item at a chosen position and freehand ink drawing require a pointer or stylus and have
        no keyboard equivalent; use the tool buttons to place an item at the centre of the view.
      </p>
      <div
        ref={hostRef}
        className={`cv-board${panning ? ' is-panning' : ''}`}
        style={{ cursor }}
        role="application"
        aria-label={`${title || 'Untitled canvas'} board`}
        aria-describedby="cv-board-help"
        tabIndex={0}
        onPointerDown={handleBoardPointerDown}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) e.preventDefault();
        }}
        onDrop={(e) => {
          const files = Array.from(e.dataTransfer.files);
          if (files.length === 0) return;
          e.preventDefault();
          void addImageFiles(files, worldPoint(e));
        }}
      >
        {/* Dot grid is painted as a background so it costs nothing to scroll, and
            its size follows the zoom so the board reads as infinite depth. */}
        <div
          className="cv-grid"
          aria-hidden="true"
          style={{
            backgroundSize: `${24 * viewport.scale}px ${24 * viewport.scale}px`,
            backgroundPosition: `${viewport.x}px ${viewport.y}px`,
          }}
        />

        <div
          className="cv-world"
          style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})` }}
        >
          <Connectors
            items={doc.items}
            edges={doc.edges}
            selectedEdgeId={selectedEdgeId}
            onSelectEdge={setSelectedEdgeId}
            scale={viewport.scale}
            pending={pendingConnect}
          />

          {doc.items.map((item) => (
            <CanvasItemView
              key={item.id}
              item={item}
              selected={selection.has(item.id)}
              soleSelection={selection.size === 1}
              editing={editingId === item.id}
              scale={viewport.scale}
              onPointerDown={handleItemPointerDown}
              onStartResize={beginResize}
              onStartConnect={beginConnect}
              onStartEdit={(it) => setEditingId(it.id)}
              onCommitText={handleCommitText}
              onOpenLink={(id) => navigate(`/note/${id}`)}
            />
          ))}

          {marqueeRect && (
            <div
              className="cv-marquee"
              style={{ left: marqueeRect.x, top: marqueeRect.y, width: marqueeRect.width, height: marqueeRect.height, borderWidth: 1 / viewport.scale }}
            />
          )}
        </div>

        <InkSurface
          layer={ink}
          viewport={viewport}
          active={inkActive}
          tool={inkTool}
          color={activeInkColor}
          width={activeInkWidth}
          fingerDraws={fingerDraws}
          onStrokeCommitted={handleStrokeCommitted}
          onErased={handleErased}
        />

        {selToolbarPos && selectedItems.length > 0 && (
          <SelectionToolbar
            selected={selectedItems}
            left={selToolbarPos.left}
            top={selToolbarPos.top}
            onColor={setSelectionColor}
            onDuplicate={() => void duplicateSelection()}
            onBringFront={() => changeZ(true)}
            onSendBack={() => changeZ(false)}
            onDelete={deleteSelection}
          />
        )}

        {doc.status === 'ready' && doc.items.length === 0 && ink.strokes.length === 0 && (
          <div className="cv-hint">
            <p>
              Pick a tool below, then click the board to place it. Drag with two fingers or hold <kbd>space</kbd> to pan,
              and <kbd>⌘</kbd>+scroll to zoom.
            </p>
          </div>
        )}

        {/* --- chrome --- */}
        <div className="cv-chrome cv-chrome--left">
          <Tooltip content={<>Undo <kbd>⌘Z</kbd></>} placement="top">
            <button
              type="button"
              className="cv-chrome__btn"
              aria-label="Undo"
              disabled={!undo.canUndo}
              onClick={() => {
                const entry = undo.undo();
                if (entry) toast(`Undid ${entry.label}`, 'info', { durationMs: 1400 });
              }}
            >
              <Icon name="undo" size={16} />
            </button>
          </Tooltip>
          <Tooltip content={<>Redo <kbd>⌘⇧Z</kbd></>} placement="top">
            <button
              type="button"
              className="cv-chrome__btn"
              aria-label="Redo"
              disabled={!undo.canRedo}
              onClick={() => {
                const entry = undo.redo();
                if (entry) toast(`Redid ${entry.label}`, 'info', { durationMs: 1400 });
              }}
            >
              <Icon name="redo" size={16} />
            </button>
          </Tooltip>
        </div>

        <div className="cv-toolstack">
          {inkActive && (
            <InkToolbar
              tool={inkTool}
              onToolChange={(t) => setMode(t)}
              color={activeInkColor}
              onColorChange={(c) => inkTool !== 'eraser' && setInkColor((prev) => ({ ...prev, [inkTool]: c }))}
              width={activeInkWidth}
              onWidthChange={(w) => inkTool !== 'eraser' && setInkWidth((prev) => ({ ...prev, [inkTool]: w }))}
              fingerDraws={fingerDraws}
              onFingerDrawsChange={setFingerDraws}
              onClear={handleClearInk}
            />
          )}

          <div className="cv-tools" role="toolbar" aria-label="Canvas tools" data-tour="canvas-tools">
            <ToolButton mode={mode} value="select" icon="cursor" label="Select" hint="V" onSelect={setMode} />
            <span className="cv-tools__sep" aria-hidden="true" />
            <ToolButton mode={mode} value="sticky" icon="sticky" label="Sticky note" hint="S" onSelect={setMode} />
            <ToolButton mode={mode} value="text" icon="type" label="Text" hint="T" onSelect={setMode} />
            <ToolButton mode={mode} value="rect" icon="square" label="Rectangle" hint="R" onSelect={setMode} />
            <ToolButton mode={mode} value="ellipse" icon="circle" label="Ellipse" hint="O" onSelect={setMode} />
            <ToolButton mode={mode} value="arrow" icon="arrow-right" label="Arrow" onSelect={setMode} />
            <Tooltip content="Add an image" placement="top">
              <button type="button" className="cv-tools__btn" aria-label="Add an image" onClick={() => fileInputRef.current?.click()}>
                <Icon name="image" size={17} />
              </button>
            </Tooltip>
            <Tooltip content="Link a note" placement="top">
              <button type="button" className="cv-tools__btn" aria-label="Link a note" onClick={() => setPickerOpen(true)}>
                <Icon name="link" size={17} />
              </button>
            </Tooltip>
            <span className="cv-tools__sep" aria-hidden="true" />
            <ToolButton mode={mode} value="pen" icon="pen" label="Pen" hint="P" onSelect={setMode} />
            <ToolButton mode={mode} value="highlighter" icon="highlighter" label="Highlighter" hint="H" onSelect={setMode} />
            <ToolButton mode={mode} value="eraser" icon="eraser" label="Eraser" hint="E" onSelect={setMode} />
          </div>
        </div>

        <div className="cv-chrome cv-chrome--right">
          <Tooltip content="Zoom out" placement="top">
            <button type="button" className="cv-chrome__btn" aria-label="Zoom out" onClick={() => zoomTo(viewport.scale / 1.25)}>
              <Icon name="chevron-down" size={15} />
            </button>
          </Tooltip>
          <button
            type="button"
            className="cv-chrome__zoom"
            onClick={() => zoomTo(1)}
            title="Reset to 100% (⌘0)"
            aria-label={`Zoom ${Math.round(viewport.scale * 100)} percent. Reset to 100 percent`}
          >
            {Math.round(viewport.scale * 100)}%
          </button>
          <Tooltip content="Zoom in" placement="top">
            <button type="button" className="cv-chrome__btn" aria-label="Zoom in" onClick={() => zoomTo(viewport.scale * 1.25)}>
              <Icon name="chevron-down" size={15} style={{ transform: 'rotate(180deg)' }} />
            </button>
          </Tooltip>
          <Tooltip content="Zoom to fit" placement="top">
            <button
              type="button"
              className="cv-chrome__btn"
              aria-label="Zoom to fit"
              onClick={() => zoomToFit(bounds(doc.items.map(rectOf)) ?? inkBounds(ink.strokes))}
            >
              <Icon name="maximize" size={15} />
            </button>
          </Tooltip>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = e.target.files ? Array.from(e.target.files) : [];
          const host = hostRef.current;
          const center = host ? toWorld({ x: host.clientWidth / 2, y: host.clientHeight / 2 }, vpRef.current) : { x: 0, y: 0 };
          void addImageFiles(files, center);
          e.target.value = '';
        }}
      />

      <NotePickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={(picked) => {
          setPickerOpen(false);
          const host = hostRef.current;
          const center = host ? toWorld({ x: host.clientWidth / 2, y: host.clientHeight / 2 }, vpRef.current) : { x: 0, y: 0 };
          void addItems(
            [{
              kind: 'link',
              x: center.x - DEFAULT_SIZES.link.width / 2,
              y: center.y - DEFAULT_SIZES.link.height / 2,
              width: DEFAULT_SIZES.link.width,
              height: DEFAULT_SIZES.link.height,
              data: { noteId: picked.id, title: picked.title },
            }],
            'note link',
          );
        }}
      />
    </div>
  );
}

function ToolButton({
  mode,
  value,
  icon,
  label,
  hint,
  onSelect,
}: {
  mode: BoardMode;
  value: BoardMode;
  icon: 'cursor' | 'sticky' | 'type' | 'square' | 'circle' | 'arrow-right' | 'pen' | 'highlighter' | 'eraser';
  label: string;
  hint?: string;
  onSelect: (m: BoardMode) => void;
}) {
  return (
    <Tooltip content={hint ? <>{label} <kbd>{hint}</kbd></> : label} placement="top">
      <button
        type="button"
        className={`cv-tools__btn${mode === value ? ' is-active' : ''}`}
        aria-label={label}
        aria-pressed={mode === value}
        onClick={() => onSelect(value)}
      >
        <Icon name={icon} size={17} />
      </button>
    </Tooltip>
  );
}

/** Read an uploaded image's intrinsic size so its item can be created at the
 *  right aspect ratio rather than a fixed box. */
function naturalSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth || 320, height: img.naturalHeight || 240 });
    img.onerror = reject;
    img.src = url;
  });
}
