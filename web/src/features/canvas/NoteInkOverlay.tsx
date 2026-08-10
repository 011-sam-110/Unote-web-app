// Stylus ink layered over an ORDINARY document note - annotating your lecture
// notes rather than drawing on a board.
//
// The hard part is anchoring. Ink must stick to the TEXT, not to the screen, so
// world coordinates here are measured from the note body's top-left corner. As
// the page scrolls, the body's on-screen position changes and the ink layer's
// viewport offset follows it, which scrolls the ink in lockstep with the words it
// annotates. Storing screen coordinates instead would leave every annotation
// stranded the moment the reader scrolled.
//
// The surface is a fixed-position overlay clipped to the scroll container rather
// than a full-height canvas: a note can be tens of thousands of pixels tall, and
// a canvas bitmap that size (times DPR) is hundreds of megabytes.

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from '../../components/Toast';
import type { InkTool } from '../../lib/types';
import { defaultColorFor, defaultWidthFor, type LocalStroke } from './strokes';
import { useInkLayer } from './useInkLayer';
import { useUndoStack } from './useUndoStack';
import InkSurface from './InkSurface';
import InkToolbar from './InkToolbar';
import './canvas.css';

export interface NoteInkOverlayProps {
  noteId: string;
  /** The element ink coordinates are measured from - the note body. */
  anchorRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
}

interface Frame {
  left: number;
  top: number;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
}

export default function NoteInkOverlay({ noteId, anchorRef, open, onClose }: NoteInkOverlayProps) {
  const ink = useInkLayer(noteId, open);
  const undo = useUndoStack();
  const [tool, setTool] = useState<InkTool>('pen');
  const [color, setColor] = useState<Record<'pen' | 'highlighter', string>>({
    pen: defaultColorFor('pen'),
    highlighter: defaultColorFor('highlighter'),
  });
  const [width, setWidth] = useState<Record<'pen' | 'highlighter', number>>({
    pen: defaultWidthFor('pen'),
    highlighter: defaultWidthFor('highlighter'),
  });
  const [fingerDraws, setFingerDraws] = useState(false);
  const [frame, setFrame] = useState<Frame | null>(null);
  const rafRef = useRef<number | null>(null);

  /** Re-measure where the note body sits inside the scroll container. */
  const measure = useCallback(() => {
    rafRef.current = null;
    const anchor = anchorRef.current;
    if (!anchor) return;
    // `.tab-pane` first: with tabs, each open page owns its own scrolling and `.app-main`
    // is a flex column that never scrolls, so resolving to it would leave the ink layer
    // measuring a box whose scrollTop is permanently 0 - the ink would sit still while the
    // note moved under it. `.app-main` stays as the fallback for anywhere a page renders
    // outside a pane.
    const scroller = (anchor.closest('.tab-pane, .app-main') as HTMLElement | null) ?? document.documentElement;
    const sRect =
      scroller === document.documentElement
        ? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
        : scroller.getBoundingClientRect();
    const aRect = anchor.getBoundingClientRect();
    // The note's toolbar is sticky at the top of this same scroller, so the first band of
    // the scroll area is chrome rather than note. Starting the ink layer at the scroller's
    // top put a transparent canvas over every toolbar button: Insert, Outline, Comments and
    // Ink itself all stopped responding to the mouse, which left no way to turn ink back OFF
    // except the palette's own close button. Ink begins where the writing does.
    const bar = scroller instanceof HTMLElement ? scroller.querySelector('.folio-action-bar') : null;
    const barBottom = bar ? bar.getBoundingClientRect().bottom : sRect.top;
    const top = Math.max(sRect.top, barBottom);
    setFrame({
      left: sRect.left,
      top,
      width: sRect.width,
      height: Math.max(0, sRect.height - (top - sRect.top)),
      // Offset of the note body's origin within the overlay - this IS the ink
      // viewport translation, and it changes on every scroll tick.
      offsetX: aRect.left - sRect.left,
      offsetY: aRect.top - top,
    });
  }, [anchorRef]);

  const scheduleMeasure = useCallback(() => {
    if (rafRef.current !== null) return;
    // Coalesce to one measurement per frame: scroll fires far more often than the
    // overlay can usefully redraw.
    rafRef.current = window.requestAnimationFrame(measure);
  }, [measure]);

  useEffect(() => {
    if (!open) return;
    measure();
    const anchor = anchorRef.current;
    // Same resolution as measure() above: the pane is what scrolls, so it is what has a
    // scroll event to listen to.
    const scroller = anchor?.closest('.tab-pane, .app-main') as HTMLElement | null;
    scroller?.addEventListener('scroll', scheduleMeasure, { passive: true });
    window.addEventListener('resize', scheduleMeasure);
    const ro = anchor ? new ResizeObserver(scheduleMeasure) : null;
    if (anchor && ro) ro.observe(anchor);
    return () => {
      scroller?.removeEventListener('scroll', scheduleMeasure);
      window.removeEventListener('resize', scheduleMeasure);
      ro?.disconnect();
      if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
    };
  }, [open, measure, scheduleMeasure, anchorRef]);

  // Ctrl/Cmd+Z belongs to the ink layer while it is open - the editor beneath is
  // not receiving input, so its own history would be the wrong thing to undo.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.stopPropagation();
        const entry = e.shiftKey ? undo.redo() : undo.undo();
        if (entry) toast(`${e.shiftKey ? 'Redid' : 'Undid'} ${entry.label}`, 'info', { durationMs: 1400 });
        return;
      }
      if (e.key === 'Escape') onClose();
    }
    // Capture phase so this wins over NotePage's own window-level handler.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, undo, onClose]);

  // useInkLayer returns a fresh object each render, so depending on `ink` here
  // would re-run this on EVERY render. Only the toggle matters, so the flush is
  // reached through a ref instead.
  const flushRef = useRef(ink.flush);
  flushRef.current = ink.flush;
  useEffect(() => {
    if (open) return;
    // Leaving the layer must not strand unsaved strokes in the debounce window.
    void flushRef.current();
  }, [open]);

  const handleStrokeCommitted = useCallback(
    (stroke: LocalStroke) => {
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

  const handleClear = useCallback(() => {
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

  if (!open || !frame) return null;

  const activeKey = tool === 'eraser' ? 'pen' : tool;

  return (
    <>
      <div
        className="cv-noteink"
        style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height }}
      >
        <InkSurface
          layer={ink}
          viewport={{ x: frame.offsetX, y: frame.offsetY, scale: 1 }}
          active
          tool={tool}
          color={color[activeKey]}
          width={width[activeKey]}
          fingerDraws={fingerDraws}
          onStrokeCommitted={handleStrokeCommitted}
          onErased={handleErased}
          className="cv-ink--overlay"
        />
      </div>
      <div className="cv-noteink__bar">
        <InkToolbar
          tool={tool}
          onToolChange={setTool}
          color={color[activeKey]}
          onColorChange={(c) => tool !== 'eraser' && setColor((p) => ({ ...p, [tool]: c }))}
          width={width[activeKey]}
          onWidthChange={(w) => tool !== 'eraser' && setWidth((p) => ({ ...p, [tool]: w }))}
          fingerDraws={fingerDraws}
          onFingerDrawsChange={setFingerDraws}
          onClear={handleClear}
          onClose={onClose}
        />
      </div>
    </>
  );
}
