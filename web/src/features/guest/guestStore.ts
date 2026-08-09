// The localStorage store guest mode USED to be written into, kept for two jobs only.
//
// Notes now live in lib/local (Dexie), which is the same store the offline desktop app
// syncs - guest mode is that store with sync switched off rather than a system of its own.
// What is left here:
//
//   * `readData()` is the source the one-time import in lib/local/localApi reads. Anyone
//     who wrote notes before that store existed has them here and nowhere else, so this
//     has to keep parsing the old blob exactly as it did.
//   * The synchronous helpers guestMode.ts needs during render - storageAvailable(),
//     hasGuestWork(), storageUsage(), latestNoteId() - and seedGuestWorkspace(), whose
//     seed is picked up by that same import on the app's first read.
//
// Nothing else should be added to it. New reads and writes belong in localApi, which is
// the only one of the two that queues anything for the server.
//
// The original note stands, because it is why the blob exists at all: localStorage was
// chosen because guest mode is a trial that ends at signup, so the store was small and
// short-lived; because migration and export want the whole store as one value; and because
// hasGuestWork() is read during render, which an async database cannot answer without a
// loading state in front of the warning.
import type { Note, NoteLite, Notebook, NotebookLite } from '../../lib/types';

const DATA_KEY = 'unote:guest:v1';

/** Roughly where browsers cap an origin's localStorage, used only to warn before the wall. */
const SOFT_LIMIT_BYTES = 4 * 1024 * 1024;

export interface GuestNotebook {
  id: string;
  name: string;
  emoji: string;
  color: string;
  position: number;
  archived: boolean;
  createdAt: string;
}

export interface GuestNote {
  id: string;
  notebookId: string;
  title: string;
  contentJson: Record<string, unknown>;
  contentText: string;
  pinned: boolean;
  archived: boolean;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface GuestData {
  version: 1;
  startedAt: string;
  notebooks: GuestNotebook[];
  notes: GuestNote[];
}

/**
 * Thrown when the browser refuses a write. Callers surface the message verbatim: a guest
 * whose storage is full is one keystroke from losing everything, so this has to say what
 * happened and what to do about it rather than fail as a generic save error.
 */
export class GuestStorageFullError extends Error {
  constructor() {
    super('This browser is out of space for unsaved notes. Export what you have, or make an account to save it.');
    this.name = 'GuestStorageFullError';
  }
}

const EMPTY_DOC: Record<string, unknown> = { type: 'doc', content: [{ type: 'paragraph' }] };

function nowIso(): string {
  return new Date().toISOString();
}

export function newGuestId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return `g${c.randomUUID().replace(/-/g, '').slice(0, 20)}`;
  return `g${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function blank(): GuestData {
  return { version: 1, startedAt: nowIso(), notebooks: [], notes: [] };
}

/** Listeners fire after every committed write, so open surfaces can re-read counts. */
const listeners = new Set<() => void>();

export function subscribeGuestData(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function readData(): GuestData {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(DATA_KEY);
  } catch {
    // Private mode with storage disabled. Guest work cannot persist at all here, which
    // startGuest() checks for before offering the mode.
    return blank();
  }
  if (!raw) return blank();
  try {
    const parsed = JSON.parse(raw) as GuestData;
    if (parsed?.version !== 1 || !Array.isArray(parsed.notebooks) || !Array.isArray(parsed.notes)) return blank();
    return parsed;
  } catch {
    return blank();
  }
}

export function writeData(data: GuestData): void {
  try {
    localStorage.setItem(DATA_KEY, JSON.stringify(data));
  } catch {
    throw new GuestStorageFullError();
  }
  listeners.forEach((l) => l());
}

export function clearData(): void {
  try {
    localStorage.removeItem(DATA_KEY);
  } catch {
    // Nothing to clear if storage was never reachable.
  }
  listeners.forEach((l) => l());
}

/** Whether storage can actually be written, checked before guest mode is offered. */
export function storageAvailable(): boolean {
  try {
    const probe = '__unote_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

export function hasGuestWork(): boolean {
  const d = readData();
  return d.notes.length > 0 || d.notebooks.length > 0;
}

/** Bytes the store currently occupies, and how close that is to the browser's ceiling. */
export function storageUsage(): { bytes: number; softLimit: number; nearlyFull: boolean } {
  let bytes = 0;
  try {
    bytes = (localStorage.getItem(DATA_KEY) ?? '').length * 2; // UTF-16 code units
  } catch {
    bytes = 0;
  }
  return { bytes, softLimit: SOFT_LIMIT_BYTES, nearlyFull: bytes > SOFT_LIMIT_BYTES * 0.8 };
}

// --- derived shapes -------------------------------------------------------------
// The rest of the app consumes the API's DTOs, so everything below converts the stored
// rows into exactly those shapes. Guest mode is invisible to the pages that read them.

export function wordCountOf(text: string): number {
  const m = text.trim().match(/\S+/g);
  return m ? m.length : 0;
}

function snippetOf(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 180);
}

export function toNotebookLite(nb: GuestNotebook): NotebookLite {
  return { id: nb.id, name: nb.name, emoji: nb.emoji, color: nb.color };
}

export function toNotebook(nb: GuestNotebook, notes: GuestNote[]): Notebook {
  const own = notes.filter((n) => n.notebookId === nb.id && !n.archived);
  const last = own.reduce<string | null>((acc, n) => (!acc || n.updatedAt > acc ? n.updatedAt : acc), null);
  return { ...toNotebookLite(nb), position: nb.position, archived: nb.archived, noteCount: own.length, lastNoteAt: last };
}

export function toNoteLite(n: GuestNote, nb: GuestNotebook | undefined): NoteLite {
  return {
    id: n.id,
    notebookId: n.notebookId,
    title: n.title,
    kind: 'doc',
    snippet: snippetOf(n.contentText),
    pinned: n.pinned,
    archived: n.archived,
    updatedAt: n.updatedAt,
    createdAt: n.createdAt,
    tags: n.tags,
    notebook: nb ? toNotebookLite(nb) : { id: n.notebookId, name: 'Notes', emoji: '📓', color: '#78716c' },
    wordCount: wordCountOf(n.contentText),
  };
}

export function toNote(n: GuestNote, nb: GuestNotebook | undefined): Note {
  return {
    id: n.id,
    notebookId: n.notebookId,
    title: n.title,
    kind: 'doc',
    contentJson: n.contentJson,
    contentText: n.contentText,
    pinned: n.pinned,
    archived: n.archived,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    tags: n.tags,
    notebook: nb ? toNotebookLite(nb) : { id: n.notebookId, name: 'Notes', emoji: '📓', color: '#78716c' },
    attachments: [],
  };
}

// --- mutations ------------------------------------------------------------------

export function createNotebook(b: { name: string; emoji?: string; color?: string }): GuestNotebook {
  const data = readData();
  const nb: GuestNotebook = {
    id: newGuestId(),
    name: b.name.trim() || 'Untitled notebook',
    emoji: b.emoji || '📓',
    color: b.color || '#78716c',
    position: data.notebooks.length,
    archived: false,
    createdAt: nowIso(),
  };
  data.notebooks.push(nb);
  writeData(data);
  return nb;
}

export function updateNotebook(id: string, patch: Partial<GuestNotebook>): GuestNotebook | undefined {
  const data = readData();
  const nb = data.notebooks.find((n) => n.id === id);
  if (!nb) return undefined;
  Object.assign(nb, patch, { id: nb.id });
  writeData(data);
  return nb;
}

export function deleteNotebook(id: string): void {
  const data = readData();
  data.notebooks = data.notebooks.filter((n) => n.id !== id);
  data.notes = data.notes.filter((n) => n.notebookId !== id);
  writeData(data);
}

export function createNote(b: {
  notebookId: string;
  title?: string;
  contentJson?: Record<string, unknown>;
  contentText?: string;
  tags?: string[];
}): GuestNote {
  const data = readData();
  const now = nowIso();
  const note: GuestNote = {
    id: newGuestId(),
    notebookId: b.notebookId,
    title: b.title ?? '',
    contentJson: b.contentJson ?? EMPTY_DOC,
    contentText: b.contentText ?? '',
    pinned: false,
    archived: false,
    tags: b.tags ?? [],
    createdAt: now,
    updatedAt: now,
  };
  data.notes.push(note);
  writeData(data);
  return note;
}

export function updateNote(id: string, patch: Partial<GuestNote>): GuestNote | undefined {
  const data = readData();
  const note = data.notes.find((n) => n.id === id);
  if (!note) return undefined;
  Object.assign(note, patch, { id: note.id, updatedAt: nowIso() });
  writeData(data);
  return note;
}

export function deleteNote(id: string): void {
  const data = readData();
  data.notes = data.notes.filter((n) => n.id !== id);
  writeData(data);
}

/** The notebook a note belongs to, or undefined for an orphan (deleted notebook). */
export function notebookOf(data: GuestData, notebookId: string): GuestNotebook | undefined {
  return data.notebooks.find((n) => n.id === notebookId);
}

/**
 * Seed the store so "try it" lands on a page someone can type into rather than an empty
 * shell with a "create a notebook first" error waiting behind every control.
 */
export function seedGuestWorkspace(): { notebook: GuestNotebook; note: GuestNote } {
  const notebook = createNotebook({ name: 'My notes', emoji: '📓', color: '#2563eb' });
  const note = createNote({ notebookId: notebook.id });
  return { notebook, note };
}

/** The note /try should open: the one most recently worked on. */
export function latestNoteId(): string | null {
  const notes = readData().notes;
  if (notes.length === 0) return null;
  return notes.reduce((best, n) => (n.updatedAt > best.updatedAt ? n : best), notes[0]).id;
}
