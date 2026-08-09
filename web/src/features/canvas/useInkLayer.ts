// Ink state + persistence for one note's ink layer.
//
// The layer is deliberately decoupled from the surface that draws it: the same
// hook backs a canvas board and the annotation overlay on an ordinary document
// note, because the server treats /api/canvas/:noteId/ink as valid for ANY note
// the caller owns, not only kind='canvas'.
//
// Persistence shape mirrors the API's own: appends are BATCHED and debounced
// (one POST per burst of strokes, never one per point), erases are per-id
// DELETEs. Local state is authoritative while the user is drawing; the network
// is a write-behind cache.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, getMode } from '../../lib/api';
import { toast } from '../../components/Toast';
import type { InkStroke } from '../../lib/types';
import type { LocalStroke } from './strokes';

/** Debounce before uploading a burst of finished strokes. Long enough that a
 *  flurry of quick marks becomes one request, short enough that a browser crash
 *  loses almost nothing. */
const UPLOAD_DEBOUNCE_MS = 700;

export interface InkLayer {
  strokes: LocalStroke[];
  ready: boolean;
  /** Append a finished stroke. Returns the local record (with its temp id). */
  addStroke: (stroke: Omit<LocalStroke, 'id' | 'pending'>) => LocalStroke;
  /** Remove by id, returning the removed records so an undo can restore them. */
  removeStrokes: (ids: readonly string[]) => LocalStroke[];
  /** Re-add previously removed strokes (undo of an erase). New ids are minted
   *  because the API cannot create a stroke at a caller-chosen id. */
  restoreStrokes: (strokes: readonly LocalStroke[]) => LocalStroke[];
  clearAll: () => Promise<void>;
  /** Force any queued appends out now (called before navigating away). */
  flush: () => Promise<void>;
}

let tempSeq = 0;
const nextTempId = () => `tmp-ink-${++tempSeq}`;
const isTemp = (id: string) => id.startsWith('tmp-ink-');

export function useInkLayer(noteId: string, enabled: boolean): InkLayer {
  const [strokes, setStrokes] = useState<LocalStroke[]>([]);
  const [ready, setReady] = useState(false);

  // Strokes finished but not yet uploaded, in the order they were drawn - the
  // POST response returns ids positionally, so order is load-bearing.
  const queueRef = useRef<LocalStroke[]>([]);
  const timerRef = useRef<number | null>(null);
  // Temp ids erased while their POST was already in flight. We cannot DELETE them
  // until the server tells us what id it gave them, so the delete is deferred to
  // the upload's completion rather than dropped (which would resurrect the stroke
  // on the next page load).
  const deleteAfterFlushRef = useRef<Set<string>>(new Set());
  const inFlightRef = useRef<Promise<void> | null>(null);
  // temp id -> server id. An undo entry captures the stroke at commit time, when
  // it still has a temp id; by the time the user presses ⌘Z the upload has
  // usually landed and replaced that id. Without this table the undo would look
  // for an id that no longer exists and silently do nothing.
  const remapRef = useRef<Map<string, string>>(new Map());
  // Guards against a stale GET for a previous note committing over this one, the
  // same monotonic-sequence trick NotePage uses for its note load.
  const loadSeqRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const seq = ++loadSeqRef.current;
    setReady(false);
    api
      .ink(noteId)
      .then(({ strokes: fetched }) => {
        if (loadSeqRef.current !== seq) return;
        setStrokes(fetched.map(normalizeStroke).filter((s): s is LocalStroke => s !== null));
        setReady(true);
      })
      .catch(() => {
        if (loadSeqRef.current !== seq) return;
        // A failed load must not present as an empty layer - that invites the user
        // to draw over ink they cannot see and cannot recover.
        toast('Could not load ink for this note', 'error');
        setReady(false);
      });
    return () => {
      loadSeqRef.current++;
    };
  }, [noteId, enabled]);

  const upload = useCallback(async (): Promise<void> => {
    const batch = queueRef.current;
    if (batch.length === 0) return;
    queueRef.current = [];

    const run = (async () => {
      try {
        const { ids } = await api.addInk(
          noteId,
          batch.map((s) => ({ points: s.points, color: s.color, width: s.width, tool: s.tool })),
        );
        // Positional mapping: ids[i] belongs to batch[i].
        const mapping = new Map<string, string>();
        batch.forEach((s, i) => {
          if (ids[i]) {
            mapping.set(s.id, ids[i]);
            remapRef.current.set(s.id, ids[i]);
          }
        });
        setStrokes((prev) =>
          prev.map((s) => {
            const real = mapping.get(s.id);
            return real ? { ...s, id: real, pending: false } : s;
          }),
        );
        // Anything erased while it was in flight now has a real id to delete.
        const deferred = deleteAfterFlushRef.current;
        for (const [tempId, realId] of mapping) {
          if (deferred.has(tempId)) {
            deferred.delete(tempId);
            api.deleteInk(noteId, realId).catch(() => {});
          }
        }
      } catch {
        // Put the batch back so the next flush retries it, rather than silently
        // losing the strokes the user can still see on screen.
        queueRef.current = [...batch, ...queueRef.current];
        toast('Ink not saved yet, retrying', 'error');
      }
    })();

    inFlightRef.current = run;
    await run;
    if (inFlightRef.current === run) inFlightRef.current = null;
  }, [noteId]);

  const scheduleUpload = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void upload();
    }, UPLOAD_DEBOUNCE_MS);
  }, [upload]);

  const flush = useCallback(async () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    await inFlightRef.current;
    await upload();
  }, [upload]);

  // Last-chance save. Ink is the one thing on a board with no other autosave path,
  // so a tab close mid-debounce would otherwise drop the last few strokes.
  useEffect(() => {
    if (!enabled) return;
    const onHide = () => {
      if (queueRef.current.length === 0) return;
      const batch = queueRef.current;
      queueRef.current = [];
      const body = batch.map((s) => ({ points: s.points, color: s.color, width: s.width, tool: s.tool }));

      // A beacon aimed at the server is worse than useless with no connection: it
      // fails silently and these strokes are gone. Offline the write goes to the
      // local store instead, which is not guaranteed to finish before the page does
      // - an IndexedDB write during pagehide is best-effort - but a chance of
      // keeping them beats a certainty of losing them.
      if (getMode() !== 'online') {
        void api.addInk(noteId, body).catch(() => {});
        return;
      }

      // keepalive lets the request outlive the page; fetch directly because the
      // api helper's response handling is pointless once we're unloading.
      try {
        navigator.sendBeacon?.(
          `/api/canvas/${noteId}/ink`,
          new Blob([JSON.stringify({ strokes: body })], { type: 'application/json' }),
        );
      } catch {
        // Nothing more we can do while the page is going away.
      }
    };
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      onHide();
    };
  }, [noteId, enabled]);

  const addStroke = useCallback(
    (stroke: Omit<LocalStroke, 'id' | 'pending'>): LocalStroke => {
      const local: LocalStroke = { ...stroke, id: nextTempId(), pending: true };
      setStrokes((prev) => [...prev, local]);
      queueRef.current.push(local);
      scheduleUpload();
      return local;
    },
    [scheduleUpload],
  );

  /** Follow the temp-id -> server-id chain for an id captured earlier. */
  const resolveId = useCallback((id: string): string => {
    let cur = id;
    // Bounded: a cycle must not hang the UI.
    for (let i = 0; i < 32; i++) {
      const next = remapRef.current.get(cur);
      if (!next) return cur;
      cur = next;
    }
    return cur;
  }, []);

  const removeStrokes = useCallback(
    (ids: readonly string[]): LocalStroke[] => {
      if (ids.length === 0) return [];
      const idSet = new Set(ids.map(resolveId));
      const removed: LocalStroke[] = [];
      setStrokes((prev) => {
        const next: LocalStroke[] = [];
        for (const s of prev) {
          if (idSet.has(s.id)) removed.push(s);
          else next.push(s);
        }
        return next;
      });

      for (const id of idSet) {
        if (isTemp(id)) {
          const qIdx = queueRef.current.findIndex((s) => s.id === id);
          if (qIdx >= 0) {
            // Never uploaded - dropping it from the queue is the whole delete.
            queueRef.current.splice(qIdx, 1);
          } else {
            deleteAfterFlushRef.current.add(id);
          }
        } else {
          api.deleteInk(noteId, id).catch(() => {});
        }
      }
      return removed;
    },
    [noteId, resolveId],
  );

  const restoreStrokes = useCallback(
    (toRestore: readonly LocalStroke[]): LocalStroke[] => {
      if (toRestore.length === 0) return [];
      const revived = toRestore.map((s) => ({ ...s, id: nextTempId(), pending: true }));
      setStrokes((prev) => [...prev, ...revived]);
      queueRef.current.push(...revived);
      scheduleUpload();
      return revived;
    },
    [scheduleUpload],
  );

  const clearAll = useCallback(async () => {
    queueRef.current = [];
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setStrokes([]);
    try {
      await api.clearInk(noteId);
    } catch {
      toast('Could not clear ink', 'error');
    }
  }, [noteId]);

  return { strokes, ready, addStroke, removeStrokes, restoreStrokes, clearAll, flush };
}

/** Defensive read of a server stroke: the `stroke` column is opaque JSON, so a
 *  row written by an older client (or a partial write) must degrade to null and
 *  be skipped rather than crash the layer. */
function normalizeStroke(s: InkStroke): LocalStroke | null {
  if (!s || !Array.isArray(s.points) || s.points.length === 0) return null;
  const points = s.points.filter(
    (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]),
  );
  if (points.length === 0) return null;
  return {
    id: s.id,
    points: points.map((p) => [p[0], p[1], Number.isFinite(p[2]) ? p[2] : 0.5]),
    color: typeof s.color === 'string' ? s.color : '#1f2328',
    width: Number.isFinite(s.width) ? s.width : 3,
    tool: s.tool === 'highlighter' ? 'highlighter' : 'pen',
  };
}
