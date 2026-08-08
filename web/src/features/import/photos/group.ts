// Guessing which photos are pages of the same note, for free.
//
// The signal is capture time. Someone photographing a six-page handout takes six pictures in
// under a minute; the next thing they photograph is hours later. That gap is a better grouping
// signal than content similarity, costs nothing, and - unlike the AI grouper - works offline and
// against no quota. The AI pass exists for the case this cannot see: two different subjects
// photographed back to back.
//
// Every group carries a `rationale`, which the review screen shows verbatim. A grouping the user
// cannot second-guess is worse than no grouping, because a wrong guess becomes invisible.
import type { ImportGroupInput } from '../../../lib/types';

/** A staged photo, as much as grouping needs to know about it. */
export interface GroupablePhoto {
  id: string;
  originalName: string;
  /** Epoch ms, or null when neither EXIF nor the file had a usable timestamp. */
  capturedAt: number | null;
  /** OCR text, used only to name the group. */
  text: string;
}

/**
 * Photos more than this far apart start a new note.
 *
 * Four minutes is deliberately generous for a single document: it survives someone flattening a
 * page, finding better light, or being interrupted mid-handout, while still splitting two things
 * photographed in separate sittings. Over-merging is the more annoying error of the two - pulling
 * a page out of a group in review is one drag, while noticing that two notes should have been one
 * means starting over - so the threshold leans towards splitting.
 */
const GAP_MS = 4 * 60 * 1000;

function minutes(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (mins < 60) return `${mins} min`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Filenames from a camera end in a counter (IMG_0412). Consecutive numbers support a group. */
function sequenceNumber(name: string): number | null {
  const m = name.replace(/\.[^./\\]+$/, '').match(/(\d{2,})\s*$/);
  return m ? Number(m[1]) : null;
}

/** First plausible heading in OCR text: a short, mostly-alphabetic opening line. */
function titleFromText(text: string): string | null {
  for (const raw of text.split('\n').slice(0, 6)) {
    const line = raw.replace(/^[#\s*_-]+/, '').trim();
    if (line.length < 4 || line.length > 80) continue;
    const letters = (line.match(/[a-zA-Z]/g) ?? []).length;
    if (letters < line.length * 0.6) continue; // mostly digits/symbols: a page number, not a title
    return line.replace(/[.,;:]+$/, '');
  }
  return null;
}

function titleFromFilename(name: string): string {
  const base = name.replace(/\.[^./\\]+$/, '').replace(/[_-]+/g, ' ').trim();
  return base || 'Untitled photo';
}

function nameGroup(pages: GroupablePhoto[]): string {
  for (const p of pages) {
    const t = titleFromText(p.text);
    if (t) return t;
  }
  const when = pages.find((p) => p.capturedAt != null)?.capturedAt;
  if (when != null) {
    return `Notes, ${new Date(when).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
  }
  return titleFromFilename(pages[0].originalName);
}

/** Explain the split, in the user's terms, so a wrong guess is obvious rather than mysterious. */
function explain(pages: GroupablePhoto[], gapBefore: number | null): string {
  const times = pages.map((p) => p.capturedAt).filter((t): t is number => t != null);
  const parts: string[] = [];
  if (times.length >= 2) {
    const span = Math.max(...times) - Math.min(...times);
    parts.push(`${pages.length} photos over ${minutes(span)}`);
  } else if (times.length === 1) {
    parts.push(`shot ${clockTime(times[0])}`);
  } else {
    parts.push(pages.length === 1 ? 'no capture time' : `${pages.length} photos, no capture time`);
  }
  if (gapBefore != null) parts.push(`${minutes(gapBefore)} gap before`);
  return parts.join(' · ');
}

/**
 * Cluster photos into proposed notes by capture time.
 *
 * Photos with no timestamp at all keep their given order and are cut only where the filename
 * counter jumps, which is the best that can be done without one - it still keeps a burst of
 * IMG_0411..IMG_0414 together.
 */
export function groupByCaptureTime(photos: GroupablePhoto[]): ImportGroupInput[] {
  if (photos.length === 0) return [];

  const ordered = photos.slice().sort((a, b) => {
    if (a.capturedAt != null && b.capturedAt != null) return a.capturedAt - b.capturedAt;
    if (a.capturedAt != null) return -1; // timed photos first; untimed keep their relative order
    if (b.capturedAt != null) return 1;
    const sa = sequenceNumber(a.originalName);
    const sb = sequenceNumber(b.originalName);
    if (sa != null && sb != null) return sa - sb;
    return a.originalName.localeCompare(b.originalName, undefined, { numeric: true });
  });

  const clusters: Array<{ pages: GroupablePhoto[]; gapBefore: number | null }> = [];
  let current: GroupablePhoto[] = [];
  let gapBefore: number | null = null;
  let pendingGap: number | null = null;

  for (const photo of ordered) {
    if (current.length === 0) {
      current = [photo];
      gapBefore = pendingGap;
      continue;
    }
    const prev = current[current.length - 1];
    let split = false;
    let thisGap: number | null = null;

    if (prev.capturedAt != null && photo.capturedAt != null) {
      thisGap = photo.capturedAt - prev.capturedAt;
      split = thisGap > GAP_MS;
    } else {
      // No usable time on at least one side. Fall back to the filename counter: a jump of more
      // than one means at least one photo in between went somewhere else.
      const a = sequenceNumber(prev.originalName);
      const b = sequenceNumber(photo.originalName);
      split = a == null || b == null || b - a > 2 || b - a < 0;
    }

    if (split) {
      clusters.push({ pages: current, gapBefore });
      current = [photo];
      gapBefore = thisGap;
    } else {
      current.push(photo);
    }
    pendingGap = thisGap;
  }
  if (current.length) clusters.push({ pages: current, gapBefore });

  return clusters.map((c, i) => ({
    key: `g${i}-${c.pages[0].id}`,
    itemIds: c.pages.map((p) => p.id),
    title: nameGroup(c.pages),
    rationale: explain(c.pages, c.gapBefore),
  }));
}

/** Every photo its own note - the escape hatch when the user disagrees with any clustering. */
export function groupOnePerPhoto(photos: GroupablePhoto[]): ImportGroupInput[] {
  return photos.map((p) => ({
    key: `s-${p.id}`,
    itemIds: [p.id],
    title: titleFromText(p.text) ?? titleFromFilename(p.originalName),
    rationale: 'kept separate',
  }));
}

/** All photos as pages of one note - for the handout that arrived in one burst anyway. */
export function groupAllTogether(photos: GroupablePhoto[]): ImportGroupInput[] {
  if (!photos.length) return [];
  const ordered = photos.slice().sort((a, b) => (a.capturedAt ?? 0) - (b.capturedAt ?? 0));
  return [{
    key: `all-${ordered[0].id}`,
    itemIds: ordered.map((p) => p.id),
    title: nameGroup(ordered),
    rationale: `${ordered.length} photos as one note`,
  }];
}
