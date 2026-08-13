// The reader's page zoom.
//
// A property of the reader, not of the note: the same document wants a different zoom on a
// laptop and on a large monitor, and it should not sync between them. Stored in
// localStorage next to the existing focused-width preference.
//
// Two components need it - the page surface applies it, the format bar displays and changes
// it - and they are not in a parent/child relationship where prop drilling is natural. A
// custom event keeps the single stored value authoritative instead of letting each hold its
// own copy and drift.

const ZOOM_KEY = 'folio.pageZoom';

/** Google Docs' own ladder, which is the one people's fingers already know. */
export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2];

export const ZOOM_EVENT = 'folio:page-zoom';

export function readPageZoom(): number {
  if (typeof window === 'undefined') return 1;
  const raw = Number(window.localStorage.getItem(ZOOM_KEY));
  // Anything not on the ladder (a hand-edited value, an older build's number) reads as
  // 100% rather than as an arbitrary scale nothing in the UI can undo.
  return ZOOM_STEPS.includes(raw) ? raw : 1;
}

export function writePageZoom(zoom: number): void {
  try {
    window.localStorage.setItem(ZOOM_KEY, String(zoom));
  } catch {
    /* private browsing - the zoom still applies for this session, it just is not remembered */
  }
  window.dispatchEvent(new CustomEvent(ZOOM_EVENT));
}
