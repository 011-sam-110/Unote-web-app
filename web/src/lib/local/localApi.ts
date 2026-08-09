// The local store as an API surface: what the app talks to when there is no server
// to talk to.
//
// This began as features/guest/guestApi.ts, a localStorage stand-in for a visitor with
// no account. It is the same idea with the storage swapped and one restriction lifted:
// the same code now serves the offline desktop app, where the caller DOES have an
// account and every local write has to reach the server eventually. That is the whole
// reason for the outbox - guest mode is simply this store with sync switched off.
//
// Four rules hold for every mutation in this file, and each of them exists because the
// obvious alternative loses an edit:
//
//   1. The record write and its enqueue() happen in ONE Dexie transaction. A crash
//      between them would leave an edit stored but unqueued - saved on this device and
//      invisible to every other one.
//   2. `updatedAt` comes from correctedNow(), never Date.now(). A laptop an hour fast
//      would otherwise win every conflict and one an hour slow would lose every one.
//   3. `baseUpdatedAt` is NEVER touched by a local edit. It records what the SERVER last
//      showed us; advancing it here would make the next push claim a version this client
//      never saw, and every later write would then read as a conflict.
//   4. A delete writes a tombstone. A row removed outright has nothing left to tell the
//      server with, so the delete would never leave this device.
//
// Reads filter `deletedAt === null` in code rather than in a query: IndexedDB cannot
// index a null check, which db.test.ts pins as a guard rather than a formality.
//
// Update PAYLOADS are deliberately COMPLETE bodies rather than just the changed fields.
// outbox.enqueue() coalesces an update into a still-pending create by replacing the
// payload wholesale, so a partial payload would turn "create then rename" into a create
// with no notebookId - which the server answers 400 to, forever.
import type {
  DashboardData, Flashcard, Note, NoteLite, Notebook, NotebookLite, SearchResult, StudyStats, TitleResult,
} from '../types';
import { hasLocalData, localDb, readMeta } from './db';
import { correctedNow } from './clock';
import { enqueue } from './outbox';
import { newLocalId } from './records';
import type { LocalFlashcard, LocalNote, LocalNotebook } from './records';
import { sm2Step, type Rating } from './sm2';
import { GuestFeatureError } from '../../features/guest/guestErrors';
import { readData } from '../../features/guest/guestStore';
import type { GuestData } from '../../features/guest/guestStore';

/** A card the server has never scheduled: due now, ease 2.5, matching POST /api/study/cards. */
const NEW_CARD_EASE = 2.5;

function emptyDoc(): Record<string, unknown> {
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}

function notFound(what: string): never {
  throw new GuestFeatureError(`That ${what} is not on this device.`);
}

// --- record <-> DTO -------------------------------------------------------------
// The rest of the app consumes the server's DTOs, so everything here converts stored
// rows into exactly those shapes. No page knows which store answered it.

/** The store keeps content_json as text, like the server's column; the API returns it parsed. */
function parseDoc(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : emptyDoc();
  } catch {
    return emptyDoc();
  }
}

function wordCountOf(text: string): number {
  const m = text.trim().match(/\S+/g);
  return m ? m.length : 0;
}

function snippetOf(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 180);
}

/** A note whose notebook has been deleted still has to render, so the orphan gets a stand-in. */
function toNotebookLite(nb: LocalNotebook | undefined, notebookId: string): NotebookLite {
  if (!nb) return { id: notebookId, name: 'Notes', emoji: '📓', color: '#78716c' };
  return { id: nb.id, name: nb.name, emoji: nb.emoji, color: nb.color };
}

/** noteCount and lastNoteAt are DERIVED here, never stored - a persisted count goes stale. */
function toNotebookDto(nb: LocalNotebook, notes: LocalNote[]): Notebook {
  const own = notes.filter((n) => n.notebookId === nb.id && n.archived === 0 && n.deletedAt === null);
  const last = own.reduce<string | null>((acc, n) => (!acc || n.updatedAt > acc ? n.updatedAt : acc), null);
  return {
    ...toNotebookLite(nb, nb.id),
    position: nb.position,
    archived: nb.archived === 1,
    noteCount: own.length,
    lastNoteAt: last,
  };
}

function toNoteLite(n: LocalNote, nb: LocalNotebook | undefined): NoteLite {
  return {
    id: n.id,
    notebookId: n.notebookId,
    title: n.title,
    kind: n.kind === 'canvas' ? 'canvas' : 'doc',
    snippet: snippetOf(n.contentText),
    pinned: n.pinned === 1,
    archived: n.archived === 1,
    updatedAt: n.updatedAt,
    createdAt: n.createdAt,
    tags: n.tags,
    notebook: toNotebookLite(nb, n.notebookId),
    wordCount: wordCountOf(n.contentText),
  };
}

function toNoteDto(n: LocalNote, nb: LocalNotebook | undefined): Note {
  return {
    id: n.id,
    notebookId: n.notebookId,
    title: n.title,
    kind: n.kind === 'canvas' ? 'canvas' : 'doc',
    contentJson: parseDoc(n.contentJson),
    contentText: n.contentText,
    pinned: n.pinned === 1,
    archived: n.archived === 1,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    tags: n.tags,
    notebook: toNotebookLite(nb, n.notebookId),
    // Attachments need a file store, so a local-only note has none. An empty array
    // rather than undefined, so the note page renders no panel instead of a broken one.
    attachments: [],
  };
}

/**
 * The card DTO, including the note title the study pages label cards with.
 *
 * The note and notebook are looked up WITHOUT the tombstone filter, matching the
 * server's LEFT JOIN: a card attached to a soft-deleted note still shows its title.
 */
function toCardDto(c: LocalFlashcard, note: LocalNote | undefined, nb: LocalNotebook | undefined): Flashcard {
  return {
    id: c.id,
    noteId: c.noteId,
    noteTitle: note?.title ?? undefined,
    notebookId: note?.notebookId ?? undefined,
    notebookName: nb?.name ?? undefined,
    question: c.question,
    answer: c.answer,
    dueAt: c.dueAt,
    reps: c.reps,
    suspended: c.suspended === 1,
  };
}

// --- reads ----------------------------------------------------------------------

/**
 * Every note row passes through here on the way out of the database.
 *
 * `tags` is a CLIENT-side column: the sync feed does not carry it (there is no tags
 * column on notes server-side - they live in their own table), so a note pulled from the
 * server for the first time is written without one. engine.ts merges onto an existing
 * row, which covers every case except the first, and that is the case this guards.
 * Normalising once here is the alternative to every caller remembering to.
 */
function noteRow(n: LocalNote): LocalNote {
  return Array.isArray(n.tags) ? n : { ...n, tags: [] };
}

async function liveNotes(): Promise<LocalNote[]> {
  return (await localDb.notes.toArray()).filter((n) => n.deletedAt === null).map(noteRow);
}

/** Position order, then created order - the same ORDER BY GET /api/notebooks uses. */
async function liveNotebooks(): Promise<LocalNotebook[]> {
  return (await localDb.notebooks.toArray())
    .filter((nb) => nb.deletedAt === null)
    .sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
}

async function liveCards(): Promise<LocalFlashcard[]> {
  return (await localDb.flashcards.toArray()).filter((c) => c.deletedAt === null);
}

async function notebookMap(): Promise<Map<string, LocalNotebook>> {
  return new Map((await liveNotebooks()).map((nb) => [nb.id, nb]));
}

/** Tombstones included: see toCardDto. */
async function cardContext(): Promise<{ notes: Map<string, LocalNote>; notebooks: Map<string, LocalNotebook> }> {
  const notes = new Map((await localDb.notes.toArray()).map((n) => [n.id, noteRow(n)]));
  const notebooks = new Map((await localDb.notebooks.toArray()).map((nb) => [nb.id, nb]));
  return { notes, notebooks };
}

function sortedByUpdated(notes: LocalNote[]): LocalNote[] {
  return notes.slice().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

// --- search helpers -------------------------------------------------------------

/** Strip anything the snippet renderer would treat as markup - it only ever expects
 *  plain text plus the <mark> spans this adds itself. */
function plain(s: string): string {
  return s.replace(/[<>]/g, ' ');
}

function markSnippet(text: string, query: string): string {
  const clean = plain(text).replace(/\s+/g, ' ').trim();
  const at = clean.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return clean.slice(0, 180);
  const from = Math.max(0, at - 60);
  const head = from > 0 ? '…' : '';
  return `${head}${clean.slice(from, at)}<mark>${clean.slice(at, at + query.length)}</mark>${clean.slice(at + query.length, at + query.length + 100)}`;
}

function matches(n: LocalNote, q: string): boolean {
  const needle = q.toLowerCase();
  return (
    n.title.toLowerCase().includes(needle)
    || n.contentText.toLowerCase().includes(needle)
    || n.tags.some((t) => t.toLowerCase().includes(needle))
  );
}

// --- dashboard helpers ----------------------------------------------------------

function localDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** [startISO, endISO) of the current LOCAL day, so "reviewed today" matches the
 *  student's wall clock rather than UTC. Ported from server/src/routes/study.ts. */
function localDayBounds(): [string, string] {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return [start.toISOString(), end.toISOString()];
}

// --- payload builders -----------------------------------------------------------
// One place per entity, because these are the bodies that survive coalescing (see the
// header). A field missing here is a field the server never hears about.

function notePayload(n: LocalNote): Record<string, unknown> {
  return {
    notebookId: n.notebookId,
    title: n.title,
    contentJson: parseDoc(n.contentJson),
    contentText: n.contentText,
    tags: n.tags,
    pinned: n.pinned === 1,
    archived: n.archived === 1,
    kind: n.kind,
  };
}

function notebookPayload(nb: LocalNotebook): Record<string, unknown> {
  return {
    name: nb.name,
    emoji: nb.emoji,
    color: nb.color,
    position: nb.position,
    archived: nb.archived === 1,
  };
}

/**
 * The card body both POST /api/study/cards and PATCH /api/study/cards/:id accept.
 *
 * The SM-2 columns are deliberately absent: the PATCH route does not take them, and the
 * schedule reaches the server through the `review` entry instead, which makes the server
 * recompute it with the same arithmetic sm2.ts uses here.
 */
function cardPayload(c: LocalFlashcard): Record<string, unknown> {
  return { noteId: c.noteId, question: c.question, answer: c.answer, suspended: c.suspended === 1 };
}

// --- the one-time localStorage import -------------------------------------------

/**
 * Guest work written before this store existed lived in localStorage under
 * `unote:guest:v1`. Dropping it on upgrade would delete notes someone was told were
 * theirs, so the first read of the new store brings it across.
 *
 * Ids are carried over UNCHANGED. guestMode.latestNoteId() still reads the old blob to
 * decide which note /try opens, so re-minting them would land that visitor on a 404.
 *
 * Nothing is enqueued. This data has never been on a server and has no account to reach:
 * the guest -> account handover (features/guest/guestMigrate) is what puts it there, and
 * queueing it here as well would create every note twice.
 */
const LEGACY_IMPORT_FLAG = 'unote:guest:v1:importedToLocalDb';

let legacyImportDone = false;
let legacyImportInFlight: Promise<void> | null = null;

function readLegacyFlag(): boolean {
  try {
    return globalThis.localStorage?.getItem(LEGACY_IMPORT_FLAG) === '1';
  } catch {
    return false;
  }
}

function writeLegacyFlag(): void {
  try {
    globalThis.localStorage?.setItem(LEGACY_IMPORT_FLAG, '1');
  } catch {
    // Storage unreachable. hasLocalData() below is the second guard, so a lost flag
    // cannot make the import run twice - it can only make it re-check.
  }
}

/**
 * Bring the legacy blob across, once. Returns how many rows were imported.
 *
 * Exported so the migration can be driven directly by a test; the app reaches it through
 * ready(), which every method below awaits.
 */
export async function importLegacyGuestData(): Promise<number> {
  if (legacyImportDone) return 0;
  if (readLegacyFlag()) {
    legacyImportDone = true;
    return 0;
  }

  const legacy = readData();
  // Nothing there YET, which is not the same as nothing to do: startGuest() seeds its
  // first notebook through guestStore, and that seed arrives after the app's first read.
  // Latching "done" here would strand it.
  if (legacy.notebooks.length === 0 && legacy.notes.length === 0) return 0;

  // A store that already holds rows is not empty, and merging two stores is not a
  // migration - it is a duplicate of everything.
  if (await hasLocalData()) {
    legacyImportDone = true;
    writeLegacyFlag();
    return 0;
  }

  const imported = await localDb.transaction('rw', localDb.notebooks, localDb.notes, async () => {
    for (const nb of legacy.notebooks) {
      await localDb.notebooks.put({
        id: nb.id,
        name: nb.name,
        emoji: nb.emoji,
        color: nb.color,
        position: nb.position,
        archived: nb.archived ? 1 : 0,
        createdAt: nb.createdAt,
        // The blob kept no updatedAt for notebooks; its creation is the only instant
        // this row can honestly claim.
        updatedAt: nb.createdAt,
        deletedAt: null,
        baseUpdatedAt: null,
      });
    }
    for (const n of legacy.notes) {
      await localDb.notes.put({
        id: n.id,
        notebookId: n.notebookId,
        title: n.title,
        contentJson: JSON.stringify(n.contentJson ?? emptyDoc()),
        contentText: n.contentText,
        kind: 'doc',
        pinned: n.pinned ? 1 : 0,
        archived: n.archived ? 1 : 0,
        createdAt: n.createdAt,
        updatedAt: n.updatedAt,
        tags: Array.isArray(n.tags) ? n.tags : [],
        deletedAt: null,
        baseUpdatedAt: null,
      });
    }
    return legacy.notebooks.length + legacy.notes.length;
  });

  legacyImportDone = true;
  writeLegacyFlag();
  return imported;
}

/** Awaited by every method: the import has to finish before the first read answers. */
function ready(): Promise<void> {
  if (legacyImportDone) return Promise.resolve();
  legacyImportInFlight ??= importLegacyGuestData()
    .catch(() => {
      // The blob is untouched, so nothing is lost and the next session tries again.
      // Failing the caller's read instead would take the whole app down with it.
    })
    .then(() => {
      legacyImportInFlight = null;
    });
  return legacyImportInFlight;
}

/** Test-only: forget that this session already ran the import. */
export function resetLegacyImportForTests(): void {
  legacyImportDone = false;
  legacyImportInFlight = null;
}

// --- whole-store operations -----------------------------------------------------

/**
 * Everything in the store, in the shape the guest export and the account handover read.
 *
 * Those two are the only callers that want the store as one value rather than as DTOs,
 * and both of them predate it being a database.
 */
export async function localSnapshot(): Promise<GuestData> {
  await ready();
  const notebooks = await liveNotebooks();
  const notes = sortedByUpdated(await liveNotes());
  return {
    version: 1,
    startedAt: notebooks[0]?.createdAt ?? notes[notes.length - 1]?.createdAt ?? correctedNow(),
    notebooks: notebooks.map((nb) => ({
      id: nb.id,
      name: nb.name,
      emoji: nb.emoji,
      color: nb.color,
      position: nb.position,
      archived: nb.archived === 1,
      createdAt: nb.createdAt,
    })),
    notes: notes.map((n) => ({
      id: n.id,
      notebookId: n.notebookId,
      title: n.title,
      contentJson: parseDoc(n.contentJson),
      contentText: n.contentText,
      pinned: n.pinned === 1,
      archived: n.archived === 1,
      tags: n.tags,
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
    })),
  };
}

/**
 * Drop the local store outright - rows, tombstones and queue.
 *
 * Called when local work has been copied into an account and confirmed there. A hard
 * clear rather than tombstones is right for exactly that case and no other: these rows
 * were never on a server, so there is nobody to tell about the delete, and leaving the
 * outbox populated would push the same notes a SECOND time under new ids.
 */
export async function clearLocalStore(): Promise<void> {
  await localDb.transaction(
    'rw',
    localDb.notebooks,
    localDb.notes,
    localDb.flashcards,
    localDb.reviews,
    localDb.outbox,
    async () => {
      await localDb.notebooks.clear();
      await localDb.notes.clear();
      await localDb.flashcards.clear();
      await localDb.reviews.clear();
      await localDb.outbox.clear();
    },
  );
}

// --- the table ------------------------------------------------------------------

export const localApi = {
  // notebooks
  notebooks: async (): Promise<{ notebooks: Notebook[] }> => {
    await ready();
    const notes = await liveNotes();
    const notebooks = await liveNotebooks();
    return { notebooks: notebooks.map((nb) => toNotebookDto(nb, notes)) };
  },

  createNotebook: async (b: { name: string; emoji?: string; color?: string }): Promise<{ notebook: Notebook }> => {
    await ready();
    const now = correctedNow();
    const created = await localDb.transaction('rw', localDb.notebooks, localDb.outbox, async () => {
      const existing = (await localDb.notebooks.toArray()).filter((nb) => nb.deletedAt === null);
      const nb: LocalNotebook = {
        id: newLocalId(),
        name: b.name.trim() || 'Untitled notebook',
        emoji: b.emoji || '📓',
        color: b.color || '#78716c',
        position: existing.reduce((max, n) => Math.max(max, n.position), -1) + 1,
        archived: 0,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        baseUpdatedAt: null,
      };
      await localDb.notebooks.add(nb);
      await enqueue({
        entity: 'notebook',
        op: 'create',
        recordId: nb.id,
        payload: notebookPayload(nb),
        baseUpdatedAt: null,
        clientUpdatedAt: now,
      });
      return nb;
    });
    return { notebook: toNotebookDto(created, await liveNotes()) };
  },

  updateNotebook: async (id: string, b: Partial<Notebook>): Promise<{ notebook: Notebook }> => {
    await ready();
    const now = correctedNow();
    const updated = await localDb.transaction('rw', localDb.notebooks, localDb.outbox, async () => {
      const existing = await localDb.notebooks.get(id);
      if (!existing || existing.deletedAt !== null) notFound('notebook');

      // Copied field by field rather than spread: the DTO also carries noteCount and
      // lastNoteAt, which are derived, and writing them into the store would persist a
      // stale count that later reads would trust.
      const next: LocalNotebook = { ...existing, updatedAt: now };
      if (b.name !== undefined) next.name = b.name;
      if (b.emoji !== undefined) next.emoji = b.emoji;
      if (b.color !== undefined) next.color = b.color;
      if (b.position !== undefined) next.position = b.position;
      if (b.archived !== undefined) next.archived = b.archived ? 1 : 0;
      await localDb.notebooks.put(next);

      await enqueue({
        entity: 'notebook',
        op: 'update',
        recordId: id,
        payload: notebookPayload(next),
        baseUpdatedAt: existing.baseUpdatedAt,
        clientUpdatedAt: now,
      });
      return next;
    });
    return { notebook: toNotebookDto(updated, await liveNotes()) };
  },

  deleteNotebook: async (id: string): Promise<{ ok: true }> => {
    await ready();
    const now = correctedNow();
    await localDb.transaction('rw', localDb.notebooks, localDb.notes, localDb.outbox, async () => {
      const existing = await localDb.notebooks.get(id);
      if (!existing || existing.deletedAt !== null) return;
      await localDb.notebooks.put({ ...existing, deletedAt: now, updatedAt: now });

      // notes.notebook_id is ON DELETE CASCADE server-side, so the server never reports
      // these notes as tombstones - it simply stops having them. Tombstoning them here is
      // what keeps them from lingering in local lists forever, and it is also why no
      // note:delete is queued: the cascade has already done it.
      const orphans = await localDb.notes.where('notebookId').equals(id).toArray();
      for (const n of orphans) {
        if (n.deletedAt !== null) continue;
        await localDb.notes.put({ ...n, deletedAt: now, updatedAt: now });
      }

      await enqueue({
        entity: 'notebook',
        op: 'delete',
        recordId: id,
        payload: {},
        baseUpdatedAt: existing.baseUpdatedAt,
        clientUpdatedAt: now,
      });
    });
    return { ok: true };
  },

  // notes
  notes: async (
    q: { notebookId?: string; tag?: string; archived?: boolean; sort?: string; limit?: number; offset?: number } = {},
  ): Promise<{ notes: NoteLite[]; total: number }> => {
    await ready();
    const notebooks = await notebookMap();
    let list = (await liveNotes()).filter((n) => (n.archived === 1) === (q.archived ?? false));
    if (q.notebookId) list = list.filter((n) => n.notebookId === q.notebookId);
    if (q.tag) list = list.filter((n) => n.tags.includes(q.tag as string));
    list.sort((a, b) => {
      if (q.sort === 'title') return a.title.localeCompare(b.title);
      if (q.sort === 'created') return a.createdAt < b.createdAt ? 1 : -1;
      return a.updatedAt < b.updatedAt ? 1 : -1;
    });
    const total = list.length;
    const offset = q.offset ?? 0;
    const page = list.slice(offset, offset + (q.limit ?? total));
    return { notes: page.map((n) => toNoteLite(n, notebooks.get(n.notebookId))), total };
  },

  recentNotes: async (limit = 12): Promise<{ notes: NoteLite[] }> => {
    await ready();
    const notebooks = await notebookMap();
    const list = sortedByUpdated((await liveNotes()).filter((n) => n.archived === 0)).slice(0, limit);
    return { notes: list.map((n) => toNoteLite(n, notebooks.get(n.notebookId))) };
  },

  note: async (id: string): Promise<{ note: Note; backlinks: NoteLite[]; outgoingLinks: NoteLite[] }> => {
    await ready();
    const row = await localDb.notes.get(id);
    if (!row || row.deletedAt !== null) notFound('note');
    const n = noteRow(row);
    const nb = await localDb.notebooks.get(n.notebookId);
    // Links are derived server-side from a links table this store does not mirror, so
    // the panels are empty rather than wrong. Stage 1 scope.
    return { note: toNoteDto(n, nb?.deletedAt === null ? nb : undefined), backlinks: [], outgoingLinks: [] };
  },

  createNote: async (b: {
    notebookId: string; title?: string; contentJson?: unknown; contentText?: string; tags?: string[]; kind?: string;
  }): Promise<{ note: Note }> => {
    await ready();
    if (b.kind === 'canvas') {
      throw new GuestFeatureError('Make an account to use boards. Only written notes work without one.');
    }
    const now = correctedNow();
    const created = await localDb.transaction('rw', localDb.notes, localDb.notebooks, localDb.outbox, async () => {
      const nb = await localDb.notebooks.get(b.notebookId);
      if (!nb || nb.deletedAt !== null) notFound('notebook');

      const note: LocalNote = {
        id: newLocalId(),
        notebookId: b.notebookId,
        title: b.title ?? '',
        contentJson: JSON.stringify(b.contentJson ?? emptyDoc()),
        contentText: b.contentText ?? '',
        kind: 'doc',
        pinned: 0,
        archived: 0,
        tags: b.tags ? [...new Set(b.tags)] : [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        baseUpdatedAt: null,
      };
      await localDb.notes.add(note);
      await enqueue({
        entity: 'note',
        op: 'create',
        recordId: note.id,
        payload: notePayload(note),
        baseUpdatedAt: null,
        clientUpdatedAt: now,
      });
      return note;
    });
    const nb = await localDb.notebooks.get(created.notebookId);
    return { note: toNoteDto(created, nb) };
  },

  updateNote: async (
    id: string,
    b: Partial<{
      title: string; contentJson: unknown; contentText: string; pinned: boolean; archived: boolean;
      notebookId: string; tags: string[];
    }>,
  ): Promise<{ note: Note }> => {
    await ready();
    const now = correctedNow();
    const updated = await localDb.transaction('rw', localDb.notes, localDb.outbox, async () => {
      const found = await localDb.notes.get(id);
      if (!found || found.deletedAt !== null) notFound('note');
      const existing = noteRow(found);

      const next: LocalNote = { ...existing, updatedAt: now };
      if (b.title !== undefined) next.title = b.title;
      if (b.contentJson !== undefined) next.contentJson = JSON.stringify(b.contentJson);
      if (b.contentText !== undefined) next.contentText = b.contentText;
      if (b.pinned !== undefined) next.pinned = b.pinned ? 1 : 0;
      if (b.archived !== undefined) next.archived = b.archived ? 1 : 0;
      if (b.notebookId !== undefined) next.notebookId = b.notebookId;
      if (b.tags !== undefined) next.tags = [...new Set(b.tags)];
      // baseUpdatedAt is deliberately NOT touched. It records what the SERVER last showed
      // us; a local edit has not changed that, and advancing it here would make every
      // subsequent push claim a version we never saw.
      await localDb.notes.put(next);

      // Same transaction as the put. A crash between the two would leave an edit stored
      // but unqueued - saved on this device and invisible to every other.
      await enqueue({
        entity: 'note',
        op: 'update',
        recordId: id,
        payload: notePayload(next),
        baseUpdatedAt: existing.baseUpdatedAt,
        clientUpdatedAt: now,
      });
      return next;
    });
    const nb = await localDb.notebooks.get(updated.notebookId);
    return { note: toNoteDto(updated, nb) };
  },

  deleteNote: async (id: string): Promise<{ ok: true }> => {
    await ready();
    const now = correctedNow();
    await localDb.transaction('rw', localDb.notes, localDb.outbox, async () => {
      const existing = await localDb.notes.get(id);
      if (!existing || existing.deletedAt !== null) return;
      await localDb.notes.put({ ...existing, deletedAt: now, updatedAt: now });
      await enqueue({
        entity: 'note',
        op: 'delete',
        recordId: id,
        payload: {},
        baseUpdatedAt: existing.baseUpdatedAt,
        clientUpdatedAt: now,
      });
    });
    return { ok: true };
  },

  // Panels that are simply empty without a server, rather than broken.
  versions: async () => ({ versions: [] }),
  comments: async () => ({ comments: [] }),
  ink: async () => ({ strokes: [] }),
  canvas: async () => ({ items: [], edges: [] }),
  templates: async () => ({ templates: [] }),

  // search + tags
  search: async (q: string, limit = 20): Promise<{ results: SearchResult[] }> => {
    await ready();
    const term = q.trim();
    if (!term) return { results: [] };
    const notebooks = await notebookMap();
    const hits = (await liveNotes()).filter((n) => matches(n, term)).slice(0, limit);
    return {
      results: hits.map((n) => ({
        note: toNoteLite(n, notebooks.get(n.notebookId)),
        snippetHtml: markSnippet(n.contentText || n.title, term),
        score: 1,
      })),
    };
  },

  searchFull: async (q: string, limit = 50) => localApi.search(q, limit),

  searchTitles: async (q: string, limit = 10): Promise<{ results: TitleResult[] }> => {
    await ready();
    const term = q.trim().toLowerCase();
    const notebooks = await notebookMap();
    const hits = sortedByUpdated((await liveNotes()).filter((n) => !term || n.title.toLowerCase().includes(term)))
      .slice(0, limit);
    return {
      results: hits.map((n) => ({
        id: n.id,
        title: n.title,
        notebook: toNotebookLite(notebooks.get(n.notebookId), n.notebookId),
        updatedAt: n.updatedAt,
      })),
    };
  },

  tags: async (): Promise<{ tags: Array<{ tag: string; count: number }> }> => {
    await ready();
    const counts = new Map<string, number>();
    for (const n of await liveNotes()) for (const t of n.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return {
      tags: [...counts]
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
    };
  },

  renameTag: async (tag: string, next: string) => {
    const updated = await rewriteTags((tags) => (tags.includes(tag) ? [...new Set(tags.map((t) => (t === tag ? next : t)))] : null));
    return { ok: true as const, tag: next, updated };
  },

  deleteTag: async (tag: string) => {
    const updated = await rewriteTags((tags) => (tags.includes(tag) ? tags.filter((t) => t !== tag) : null));
    return { ok: true as const, tag, updated };
  },

  mergeTags: async (from: string[], into: string) => {
    const updated = await rewriteTags((tags) =>
      tags.some((t) => from.includes(t)) ? [...new Set(tags.map((t) => (from.includes(t) ? into : t)))] : null);
    return { ok: true as const, tag: into, merged: from, updated };
  },

  // study
  studyQueue: async (limit = 20, notebookId?: string): Promise<{ cards: Flashcard[]; due: number; total: number }> => {
    await ready();
    const { notes, notebooks } = await cardContext();
    const now = correctedNow();
    const inScope = (c: LocalFlashcard) =>
      !notebookId || notes.get(c.noteId ?? '')?.notebookId === notebookId;
    const all = (await liveCards()).filter(inScope);
    const due = all.filter((c) => c.suspended === 0 && c.dueAt <= now);
    const queue = due.slice().sort((a, b) => a.dueAt.localeCompare(b.dueAt)).slice(0, limit);
    return {
      cards: queue.map((c) => cardDto(c, notes, notebooks)),
      due: due.length,
      total: all.length,
    };
  },

  studyCards: async (): Promise<{ cards: Flashcard[] }> => {
    await ready();
    const { notes, notebooks } = await cardContext();
    const cards = (await liveCards()).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return { cards: cards.map((c) => cardDto(c, notes, notebooks)) };
  },

  studyStats: async (): Promise<StudyStats> => {
    await ready();
    const { notes } = await cardContext();
    const now = correctedNow();
    const cards = await liveCards();
    const due = cards.filter((c) => c.suspended === 0 && c.dueAt <= now).length;

    const [dayStart, dayEnd] = localDayBounds();
    const known = new Set((await localDb.flashcards.toArray()).map((c) => c.id));
    const reviewedToday = (await localDb.reviews.toArray())
      .filter((r) => known.has(r.cardId) && r.reviewedAt >= dayStart && r.reviewedAt < dayEnd).length;

    const grouped = new Map<string, { noteId: string; noteTitle: string; total: number; due: number }>();
    for (const c of cards) {
      if (!c.noteId) continue;
      const row = grouped.get(c.noteId)
        ?? { noteId: c.noteId, noteTitle: notes.get(c.noteId)?.title || 'Untitled', total: 0, due: 0 };
      row.total += 1;
      if (c.suspended === 0 && c.dueAt <= now) row.due += 1;
      grouped.set(c.noteId, row);
    }

    return {
      due,
      total: cards.length,
      reviewedToday,
      byNote: [...grouped.values()].sort((a, b) => a.noteTitle.localeCompare(b.noteTitle)),
    };
  },

  createCard: async (b: { noteId?: string; question: string; answer: string }): Promise<{ card: Flashcard }> => {
    await ready();
    const question = typeof b.question === 'string' ? b.question.trim() : '';
    if (!question) throw new GuestFeatureError('A card needs a question.');
    const answer = typeof b.answer === 'string' ? b.answer.trim() : '';
    if (!answer) throw new GuestFeatureError('A card needs an answer.');

    const now = correctedNow();
    const created = await localDb.transaction('rw', localDb.flashcards, localDb.notes, localDb.outbox, async () => {
      let noteId: string | null = null;
      if (b.noteId) {
        const note = await localDb.notes.get(b.noteId);
        if (!note || note.deletedAt !== null) notFound('note');
        noteId = b.noteId;
      }

      // Matching POST /api/study/cards: a new card is due immediately, so it joins the
      // review queue alongside everything else rather than waiting a day to be seen.
      const card: LocalFlashcard = {
        id: newLocalId(),
        noteId,
        question,
        answer,
        dueAt: now,
        intervalDays: 0,
        ease: NEW_CARD_EASE,
        reps: 0,
        lapses: 0,
        suspended: 0,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        baseUpdatedAt: null,
      };
      await localDb.flashcards.add(card);
      await enqueue({
        entity: 'flashcard',
        op: 'create',
        recordId: card.id,
        payload: cardPayload(card),
        baseUpdatedAt: null,
        clientUpdatedAt: now,
      });
      return card;
    });
    const { notes, notebooks } = await cardContext();
    return { card: cardDto(created, notes, notebooks) };
  },

  updateCard: async (
    id: string,
    b: Partial<{ question: string; answer: string; suspended: boolean }>,
  ): Promise<{ card: Flashcard }> => {
    await ready();
    const now = correctedNow();
    const updated = await localDb.transaction('rw', localDb.flashcards, localDb.outbox, async () => {
      const existing = await localDb.flashcards.get(id);
      if (!existing || existing.deletedAt !== null) notFound('card');

      // A blank question keeps the old one, matching PATCH /api/study/cards/:id - an
      // emptied field there is a mis-send, not a request to erase the card's front.
      const next: LocalFlashcard = { ...existing, updatedAt: now };
      if (typeof b.question === 'string' && b.question.trim()) next.question = b.question.trim();
      if (typeof b.answer === 'string' && b.answer.trim()) next.answer = b.answer.trim();
      if (typeof b.suspended === 'boolean') next.suspended = b.suspended ? 1 : 0;
      await localDb.flashcards.put(next);

      await enqueue({
        entity: 'flashcard',
        op: 'update',
        recordId: id,
        payload: cardPayload(next),
        baseUpdatedAt: existing.baseUpdatedAt,
        clientUpdatedAt: now,
      });
      return next;
    });
    const { notes, notebooks } = await cardContext();
    return { card: cardDto(updated, notes, notebooks) };
  },

  deleteCard: async (id: string): Promise<{ ok: true }> => {
    await ready();
    const now = correctedNow();
    await localDb.transaction('rw', localDb.flashcards, localDb.outbox, async () => {
      const existing = await localDb.flashcards.get(id);
      if (!existing || existing.deletedAt !== null) return;
      await localDb.flashcards.put({ ...existing, deletedAt: now, updatedAt: now });
      await enqueue({
        entity: 'flashcard',
        op: 'delete',
        recordId: id,
        payload: {},
        baseUpdatedAt: existing.baseUpdatedAt,
        clientUpdatedAt: now,
      });
    });
    return { ok: true };
  },

  /**
   * One review, scheduled locally.
   *
   * The arithmetic is sm2Step()'s, not a second copy of it - sm2.ts exists so there is
   * exactly one implementation on this side of the wire, pinned against the server's by
   * a differential test.
   *
   * TWO outbox entries, not one. `flashcard:update` carries the card, and `review:create`
   * carries the rating; the server recomputes the schedule from that rating, which is what
   * keeps a card's due date identical on every device instead of racing to write it.
   */
  review: async (cardId: string, rating: Rating): Promise<{ card: Flashcard; nextDueAt: string }> => {
    await ready();
    const now = correctedNow();
    const nowMs = Date.parse(now);
    const updated = await localDb.transaction('rw', localDb.flashcards, localDb.reviews, localDb.outbox, async () => {
      const existing = await localDb.flashcards.get(cardId);
      if (!existing || existing.deletedAt !== null) notFound('card');

      // The most recent rating already logged for this card. Load-bearing: the 'hard'
      // branch reads it to escape the 10-minute relearning step, so dropping it would
      // keep a struggling card in that loop here and graduate it everywhere else.
      const history = await localDb.reviews.where('cardId').equals(cardId).toArray();
      const previous = history.sort((a, b) => a.reviewedAt.localeCompare(b.reviewedAt)).at(-1);

      const step = sm2Step(
        { ease: existing.ease, intervalDays: existing.intervalDays, reps: existing.reps, lapses: existing.lapses },
        rating,
        previous?.rating ?? null,
        nowMs,
      );

      const next: LocalFlashcard = {
        ...existing,
        ease: step.ease,
        intervalDays: step.intervalDays,
        reps: step.reps,
        lapses: step.lapses,
        dueAt: step.dueAt,
        updatedAt: now,
      };
      await localDb.flashcards.put(next);

      // Append-only, and that is what makes this the cheapest offline surface in the
      // project: two devices reviewing one card write two log rows and both survive.
      await localDb.reviews.add({ id: newLocalId(), cardId, rating, reviewedAt: now });

      await enqueue({
        entity: 'flashcard',
        op: 'update',
        recordId: cardId,
        payload: cardPayload(next),
        baseUpdatedAt: existing.baseUpdatedAt,
        clientUpdatedAt: now,
      });
      await enqueue({
        entity: 'review',
        op: 'create',
        recordId: `${cardId}:${now}`,
        payload: { cardId, rating },
        baseUpdatedAt: null,
        clientUpdatedAt: now,
      });
      return next;
    });

    const { notes, notebooks } = await cardContext();
    return { card: cardDto(updated, notes, notebooks), nextDueAt: updated.dueAt };
  },

  /**
   * AI is off without a server, reported through the same health probe every AI control
   * already gates on (lib/aiStatus). That is what makes the AI buttons remove themselves
   * instead of rendering as live controls that always fail.
   */
  aiHealth: async () => ({
    ok: false,
    reason: 'not_configured' as const,
    hint: 'AI needs an account. Make one and it turns on.',
  }),

  dashboard: async (): Promise<DashboardData> => {
    await ready();
    const notebooksById = await notebookMap();
    const notebooks = await liveNotebooks();
    const notes = await liveNotes();
    const now = correctedNow();
    const cards = await liveCards();
    const flashcardsDue = cards.filter((c) => c.suspended === 0 && c.dueAt <= now).length;

    const live = notes.filter((n) => n.archived === 0);
    const byUpdated = sortedByUpdated(live);
    const lite = (n: LocalNote) => toNoteLite(n, notebooksById.get(n.notebookId));

    // Monday-first week, in this machine's own timezone so "today" lines up with the
    // column DashboardPage highlights.
    const today = new Date();
    const monday = new Date(today);
    monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
    const weekKeys = DAY_LABELS.map((_, i) => {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      return localDayKey(d);
    });
    const weekGrid = weekKeys.map((date, i) => {
      const onDay = live.filter((n) => localDayKey(new Date(n.updatedAt)) === date);
      const perNotebook = new Map<string, number>();
      for (const n of onDay) perNotebook.set(n.notebookId, (perNotebook.get(n.notebookId) ?? 0) + 1);
      return {
        date,
        dayLabel: DAY_LABELS[i],
        total: onDay.length,
        byNotebook: [...perNotebook].flatMap(([id, count]) => {
          const nb = notebooksById.get(id);
          return nb ? [{ id, emoji: nb.emoji, color: nb.color, count }] : [];
        }),
      };
    });

    const weekStart = new Date(monday);
    weekStart.setHours(0, 0, 0, 0);
    const editedThisWeek = live.filter((n) => new Date(n.updatedAt) >= weekStart).length;

    // The warning is true of a store that has never synced and false of one that has, so
    // it is asked rather than assumed: the offline desktop app reads this same dashboard
    // for an account whose notes very much are saved.
    const neverSynced = (await readMeta('initialSyncDone')) !== '1';
    const unarchivedNotebooks = notebooks.filter((nb) => nb.archived === 0);

    return {
      recent: byUpdated.slice(0, 12).map(lite),
      pinned: live.filter((n) => n.pinned === 1).map(lite),
      continueNote: byUpdated[0] ? lite(byUpdated[0]) : null,
      stats: {
        notes: live.length,
        notebooks: unarchivedNotebooks.length,
        words: live.reduce((sum, n) => sum + wordCountOf(n.contentText), 0),
        flashcardsDue,
      },
      weekActivity: weekGrid.map((d) => ({ date: d.date, count: d.total })),
      notebooks: unarchivedNotebooks.map((nb) => {
        const full = toNotebookDto(nb, notes);
        return {
          id: full.id, name: full.name, emoji: full.emoji, color: full.color,
          noteCount: full.noteCount, lastNoteAt: full.lastNoteAt,
        };
      }),
      weekGrid,
      weeklyReview: {
        notesEditedThisWeek: editedThisWeek,
        flashcardsDue,
        // Both are derived from tables this store does not mirror (ai_summaries,
        // note_comments), so they are reported as zero rather than guessed at.
        notesWithoutSummary: 0,
        unresolvedComments: 0,
        suggestions: neverSynced ? ['Nothing here is saved. Make an account to keep it.'] : [],
      },
      // The server builds recall from per-notebook review history; Stage 1 does not
      // mirror enough to reproduce it, and an invented one would be worse than none.
      recall: [],
    };
  },

  /** Per-note export is handled in the browser (see guestExport), so there is no URL to
   *  hand the browser. Callers check for local mode before reaching for this. */
  exportUrl: () => '',
};

export type LocalApi = typeof localApi;

// --- shared internals ------------------------------------------------------------

/** toCardDto with the two lookup maps already threaded through. */
function cardDto(
  c: LocalFlashcard,
  notes: Map<string, LocalNote>,
  notebooks: Map<string, LocalNotebook>,
): Flashcard {
  const note = c.noteId ? notes.get(c.noteId) : undefined;
  return toCardDto(c, note, note ? notebooks.get(note.notebookId) : undefined);
}

/**
 * The three tag operations, which are all the same operation: rewrite the tag array on
 * every note it changes, and queue each of those as a note update.
 *
 * `next` returns null for a note it does not touch, so an untouched note is never
 * rewritten - which would bump its updatedAt and move it to the top of every list.
 */
async function rewriteTags(next: (tags: string[]) => string[] | null): Promise<number> {
  await ready();
  const now = correctedNow();
  return localDb.transaction('rw', localDb.notes, localDb.outbox, async () => {
    let updated = 0;
    for (const stored of await localDb.notes.toArray()) {
      if (stored.deletedAt !== null) continue;
      const note = noteRow(stored);
      const tags = next(note.tags);
      if (!tags) continue;
      const rewritten: LocalNote = { ...note, tags, updatedAt: now };
      await localDb.notes.put(rewritten);
      await enqueue({
        entity: 'note',
        op: 'update',
        recordId: note.id,
        payload: notePayload(rewritten),
        baseUpdatedAt: note.baseUpdatedAt,
        clientUpdatedAt: now,
      });
      updated += 1;
    }
    return updated;
  });
}
