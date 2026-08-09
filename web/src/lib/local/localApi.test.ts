import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { localDb } from './db';
import { importLegacyGuestData, localApi, resetLegacyImportForTests } from './localApi';
import { pendingCount, drainOrder } from './outbox';

describe('localApi', () => {
  beforeEach(async () => {
    await localDb.delete();
    await localDb.open();
    resetLegacyImportForTests();
  });

  it('creates a notebook and lists it', async () => {
    const { notebook } = await localApi.createNotebook({ name: 'Physics' });
    expect(notebook.id).toMatch(/^[a-z0-9]{14}$/);
    const { notebooks } = await localApi.notebooks();
    expect(notebooks.map((n) => n.name)).toEqual(['Physics']);
  });

  it('every mutation queues exactly one outbox entry', async () => {
    const { notebook } = await localApi.createNotebook({ name: 'N' });
    const { note } = await localApi.createNote({ notebookId: notebook.id, title: 'T' });
    await localApi.updateNote(note.id, { title: 'T2', contentJson: {}, contentText: 'T2' });
    // notebook create + note create (the update coalesced into the create)
    expect(await pendingCount()).toBe(2);
    expect((await drainOrder()).map((e) => `${e.entity}:${e.op}`)).toEqual(['notebook:create', 'note:create']);
  });

  it('an update coalesced into a create keeps the fields the create needs', async () => {
    // enqueue() replaces a pending create's payload wholesale, so a partial update payload
    // would push a create with no notebookId - which the server answers 400 to forever.
    const { notebook } = await localApi.createNotebook({ name: 'N' });
    const { note } = await localApi.createNote({ notebookId: notebook.id, title: 'First' });
    await localApi.updateNote(note.id, { title: 'Second' });
    const entry = (await drainOrder()).find((e) => e.entity === 'note');
    expect(entry?.op).toBe('create');
    expect(entry?.payload.notebookId).toBe(notebook.id);
    expect(entry?.payload.title).toBe('Second');
  });

  it('a deleted note disappears from lists but keeps a tombstone', async () => {
    const { notebook } = await localApi.createNotebook({ name: 'N' });
    const { note } = await localApi.createNote({ notebookId: notebook.id, title: 'Bye' });
    await localApi.deleteNote(note.id);
    const { notes } = await localApi.notes({ notebookId: notebook.id });
    expect(notes).toHaveLength(0);
    expect((await localDb.notes.get(note.id))?.deletedAt).not.toBeNull();
  });

  it('search matches title and body without the server', async () => {
    const { notebook } = await localApi.createNotebook({ name: 'N' });
    await localApi.createNote({ notebookId: notebook.id, title: 'Thermodynamics', contentText: 'entropy' });
    await localApi.createNote({ notebookId: notebook.id, title: 'Optics', contentText: 'lenses' });
    expect((await localApi.search('entropy')).results).toHaveLength(1);
    expect((await localApi.search('optics')).results).toHaveLength(1);
  });

  it('reads a note the sync feed wrote without a tags column', async () => {
    // engine.ts merges a pulled record onto the local row, so the FIRST arrival of a note
    // has no `tags` - the feed has no such column. Every read has to survive that.
    await localDb.notebooks.put({
      id: 'bbbbbbbbbbbbbb', name: 'Pulled', emoji: '📓', color: '#000', position: 0, archived: 0,
      createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
      deletedAt: null, baseUpdatedAt: '2026-08-01T00:00:00.000Z',
    });
    await localDb.notes.put({
      id: 'cccccccccccccc', notebookId: 'bbbbbbbbbbbbbb', title: 'From the server',
      contentJson: '{"type":"doc"}', contentText: 'server text', kind: 'doc', pinned: 0, archived: 0,
      createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
      deletedAt: null, baseUpdatedAt: '2026-08-01T00:00:00.000Z',
    } as never);

    expect((await localApi.notes()).notes[0].tags).toEqual([]);
    expect((await localApi.note('cccccccccccccc')).note.tags).toEqual([]);
    expect((await localApi.search('server')).results).toHaveLength(1);
    expect((await localApi.tags()).tags).toEqual([]);
    await localApi.updateNote('cccccccccccccc', { title: 'renamed' });
    expect((await localDb.notes.get('cccccccccccccc'))?.tags).toEqual([]);
  });

  it('a local edit never advances baseUpdatedAt', async () => {
    const { notebook } = await localApi.createNotebook({ name: 'N' });
    const { note } = await localApi.createNote({ notebookId: notebook.id, title: 'T' });
    // Pretend a sync has happened: the server showed us this version.
    await localDb.notes.update(note.id, { baseUpdatedAt: '2026-01-01T00:00:00.000Z' });
    await localDb.outbox.clear();

    await localApi.updateNote(note.id, { title: 'edited' });
    const row = await localDb.notes.get(note.id);
    expect(row?.baseUpdatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(row?.updatedAt).not.toBe('2026-01-01T00:00:00.000Z');
    expect((await drainOrder())[0]?.baseUpdatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('deleting a notebook tombstones its notes and hides them', async () => {
    const { notebook } = await localApi.createNotebook({ name: 'N' });
    const { note } = await localApi.createNote({ notebookId: notebook.id, title: 'Inside' });
    await localApi.deleteNotebook(notebook.id);
    expect((await localApi.notebooks()).notebooks).toHaveLength(0);
    expect((await localApi.notes()).notes).toHaveLength(0);
    expect((await localDb.notes.get(note.id))?.deletedAt).not.toBeNull();
  });

  it('renames a tag across every note that carries it', async () => {
    const { notebook } = await localApi.createNotebook({ name: 'N' });
    await localApi.createNote({ notebookId: notebook.id, title: 'A', tags: ['maths'] });
    await localApi.createNote({ notebookId: notebook.id, title: 'B', tags: ['maths', 'exam'] });
    await localApi.createNote({ notebookId: notebook.id, title: 'C', tags: ['exam'] });

    const result = await localApi.renameTag('maths', 'algebra');
    expect(result).toEqual({ ok: true, tag: 'algebra', updated: 2 });
    expect((await localApi.tags()).tags.map((t) => t.tag).sort()).toEqual(['algebra', 'exam']);
  });

  // --- flashcards: new code here, not a port. guestApi refused all of this. ---------

  it('creates a card that is due immediately', async () => {
    const { notebook } = await localApi.createNotebook({ name: 'N' });
    const { note } = await localApi.createNote({ notebookId: notebook.id, title: 'Cells' });
    const { card } = await localApi.createCard({ noteId: note.id, question: ' What is ATP? ', answer: ' Energy ' });

    expect(card.question).toBe('What is ATP?');
    expect(card.answer).toBe('Energy');
    expect(card.noteTitle).toBe('Cells');
    expect(card.reps).toBe(0);

    const queue = await localApi.studyQueue();
    expect(queue.cards.map((c) => c.id)).toEqual([card.id]);
    expect(queue).toMatchObject({ due: 1, total: 1 });
    expect((await localApi.studyStats()).byNote).toEqual([
      { noteId: note.id, noteTitle: 'Cells', total: 1, due: 1 },
    ]);
  });

  it('review advances the schedule, logs the review and queues two entries', async () => {
    const { notebook } = await localApi.createNotebook({ name: 'N' });
    const { card } = await localApi.createCard({ question: 'Q', answer: 'A' });
    await localDb.outbox.clear();

    const { card: after, nextDueAt } = await localApi.review(card.id, 'good');

    // 'good' on a fresh card is a flat one-day interval (sm2.ts, matching the server).
    const row = await localDb.flashcards.get(card.id);
    expect(row?.intervalDays).toBe(1);
    expect(row?.reps).toBe(1);
    expect(after.reps).toBe(1);
    expect(nextDueAt).toBe(row?.dueAt);
    expect(Date.parse(nextDueAt) - Date.now()).toBeGreaterThan(23 * 3_600_000);

    expect(await localDb.reviews.where('cardId').equals(card.id).count()).toBe(1);

    const queued = (await drainOrder()).map((e) => `${e.entity}:${e.op}`);
    expect(queued).toEqual(['flashcard:update', 'review:create']);
    const reviewEntry = (await drainOrder()).find((e) => e.entity === 'review');
    expect(reviewEntry?.payload).toEqual({ cardId: card.id, rating: 'good' });

    // Reviewed today, and no longer due.
    const stats = await localApi.studyStats();
    expect(stats.reviewedToday).toBe(1);
    expect(stats.due).toBe(0);
    expect(notebook.id).toBeTruthy();
  });

  it('reviewing a card created in the same offline session keeps its create pushable', async () => {
    // review() queues a flashcard:update, which coalesces into the still-pending create by
    // replacing its payload. If that payload were only the schedule, the create would push
    // without a question and the server would 400 it forever.
    const { card } = await localApi.createCard({ question: 'Q', answer: 'A' });
    await localApi.review(card.id, 'good');

    const entries = await drainOrder();
    expect(entries.map((e) => `${e.entity}:${e.op}`)).toEqual(['flashcard:create', 'review:create']);
    expect(entries[0].payload).toMatchObject({ question: 'Q', answer: 'A', noteId: null });
  });

  it('a second consecutive hard graduates the card out of the relearning step', async () => {
    // previousRating is load-bearing: without it a struggling card loops in the
    // 10-minute step here and graduates on every other device.
    const { card } = await localApi.createCard({ question: 'Q', answer: 'A' });
    const first = await localApi.review(card.id, 'hard');
    expect(Date.parse(first.nextDueAt) - Date.now()).toBeLessThan(20 * 60_000);

    const second = await localApi.review(card.id, 'hard');
    expect((await localDb.flashcards.get(card.id))?.intervalDays).toBe(1);
    expect(Date.parse(second.nextDueAt) - Date.now()).toBeGreaterThan(23 * 3_600_000);
    expect(await localDb.reviews.where('cardId').equals(card.id).count()).toBe(2);
  });

  it('suspending a card takes it out of the queue, deleting it leaves a tombstone', async () => {
    const { card } = await localApi.createCard({ question: 'Q', answer: 'A' });
    await localApi.updateCard(card.id, { suspended: true });
    expect((await localApi.studyQueue()).due).toBe(0);
    expect((await localApi.studyCards()).cards[0].suspended).toBe(true);

    // A blank question is a mis-send, not a request to erase the card's front.
    await localApi.updateCard(card.id, { question: '   ' });
    expect((await localDb.flashcards.get(card.id))?.question).toBe('Q');

    await localApi.deleteCard(card.id);
    expect((await localApi.studyCards()).cards).toHaveLength(0);
    expect((await localDb.flashcards.get(card.id))?.deletedAt).not.toBeNull();
  });
});

// --- the one-time localStorage import --------------------------------------------

/** Enough of Storage for guestStore.readData(); Node has no localStorage of its own. */
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
}

describe('legacy guest data', () => {
  const LEGACY = {
    version: 1,
    startedAt: '2026-08-01T09:00:00.000Z',
    notebooks: [{
      id: 'gold-notebook', name: 'Old notes', emoji: '📓', color: '#2563eb',
      position: 0, archived: false, createdAt: '2026-08-01T09:00:00.000Z',
    }],
    notes: [{
      id: 'gold-note', notebookId: 'gold-notebook', title: 'Written before the upgrade',
      contentJson: { type: 'doc', content: [] }, contentText: 'entropy always increases',
      pinned: false, archived: false, tags: ['thermo'],
      createdAt: '2026-08-01T09:00:00.000Z', updatedAt: '2026-08-02T09:00:00.000Z',
    }],
  };

  beforeEach(async () => {
    await localDb.delete();
    await localDb.open();
    resetLegacyImportForTests();
    globalThis.localStorage = new MemoryStorage();
    localStorage.setItem('unote:guest:v1', JSON.stringify(LEGACY));
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it('imports the localStorage blob on first use, keeping ids', async () => {
    // Read through the ordinary surface: the import has to happen without anyone asking.
    const { notes } = await localApi.notes();
    expect(notes.map((n) => n.id)).toEqual(['gold-note']);
    expect(notes[0].title).toBe('Written before the upgrade');
    expect(notes[0].tags).toEqual(['thermo']);
    expect((await localApi.notebooks()).notebooks.map((n) => n.name)).toEqual(['Old notes']);

    // Nothing is queued: this data has never been on a server, and the guest -> account
    // handover is what puts it there.
    expect(await pendingCount()).toBe(0);
  });

  it('cannot run twice, even after the imported notes are deleted', async () => {
    expect(await importLegacyGuestData()).toBe(2);

    await localApi.deleteNote('gold-note');
    resetLegacyImportForTests(); // a fresh session, same browser
    expect(await importLegacyGuestData()).toBe(0);

    expect((await localApi.notes()).notes).toHaveLength(0);
    expect(await localDb.notes.count()).toBe(1); // the tombstone, not a re-import
  });

  it('leaves a store that already holds rows alone', async () => {
    resetLegacyImportForTests();
    localStorage.removeItem('unote:guest:v1:importedToLocalDb');
    await localDb.notebooks.put({
      id: 'aaaaaaaaaaaaaa', name: 'Already here', emoji: '📓', color: '#000', position: 0,
      archived: 0, createdAt: '2026-08-05T09:00:00.000Z', updatedAt: '2026-08-05T09:00:00.000Z',
      deletedAt: null, baseUpdatedAt: null,
    });

    expect(await importLegacyGuestData()).toBe(0);
    expect((await localApi.notebooks()).notebooks.map((n) => n.name)).toEqual(['Already here']);
  });
});
