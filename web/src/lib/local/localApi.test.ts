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

  // --- boards and ink: Stage 2, and new code rather than a port ---------------------

  /** A board plus two stickies on it, which most of the cases below start from. */
  async function makeBoard(): Promise<{ noteId: string; a: string; b: string }> {
    const { notebook } = await localApi.createNotebook({ name: 'N' });
    const { note } = await localApi.createNote({ notebookId: notebook.id, title: 'Board', kind: 'canvas' });
    const { item: a } = await localApi.createCanvasItem(note.id, { kind: 'sticky', x: 0, y: 0, width: 220, height: 160, data: { text: 'A' } });
    const { item: b } = await localApi.createCanvasItem(note.id, { kind: 'sticky', x: 400, y: 0, width: 220, height: 160, data: { text: 'B' } });
    return { noteId: note.id, a: a.id, b: b.id };
  }

  it('creates a board offline, which guest mode refuses', async () => {
    // The refusal moved: localApi now allows kind='canvas' for anyone who is not a
    // guest, because a signed-in user on a train is exactly who Stage 2 is for.
    const { notebook } = await localApi.createNotebook({ name: 'N' });
    const { note } = await localApi.createNote({ notebookId: notebook.id, title: 'Board', kind: 'canvas' });
    expect(note.kind).toBe('canvas');
    expect((await localApi.note(note.id)).note.kind).toBe('canvas');
    expect((await drainOrder()).find((e) => e.entity === 'note')?.payload.kind).toBe('canvas');
  });

  it('a board item keeps the id its connectors use, and carries its note in the payload', async () => {
    const { noteId, a, b } = await makeBoard();
    const { edge } = await localApi.createCanvasEdge(noteId, { from: a, to: b });

    const entries = await drainOrder();
    // Dependency order: the note before its items, and the items before the connector
    // that names them. A connector pushed first is a 400 the server cannot resolve.
    expect(entries.map((e) => e.entity)).toEqual(['notebook', 'note', 'canvasItem', 'canvasItem', 'canvasEdge']);

    const created = entries.find((e) => e.entity === 'canvasEdge');
    expect(created?.recordId).toBe(edge.id);
    // The push builds /api/canvas/:noteId/... out of this, and the outbox knows only
    // the record's own id - so a payload without it cannot be sent anywhere.
    expect(created?.payload).toMatchObject({ noteId, from: a, to: b });
    expect(entries.filter((e) => e.entity === 'canvasItem').every((e) => e.payload.noteId === noteId)).toBe(true);
  });

  it('a long drag collapses to one queued write per item', async () => {
    const { noteId, a } = await makeBoard();
    await localDb.outbox.clear();

    for (let i = 0; i < 200; i++) await localApi.updateCanvasItems(noteId, [{ id: a, x: i, y: i * 2 }]);

    const entries = await drainOrder();
    expect(entries).toHaveLength(1);
    expect(entries[0].payload).toMatchObject({ x: 199, y: 398 });
    expect((await localApi.canvas(noteId)).items.find((i) => i.id === a)).toMatchObject({ x: 199, y: 398 });
  });

  it('deleting an item takes its connectors with it', async () => {
    const { noteId, a, b } = await makeBoard();
    await localApi.createCanvasEdge(noteId, { from: a, to: b });
    await localDb.outbox.clear();

    await localApi.deleteCanvasItem(noteId, a);

    const board = await localApi.canvas(noteId);
    expect(board.items.map((i) => i.id)).toEqual([b]);
    // A connector left behind renders as a stub pointing at a card that is gone.
    expect(board.edges).toHaveLength(0);
    expect((await drainOrder()).map((e) => `${e.entity}:${e.op}`))
      .toEqual(['canvasItem:delete', 'canvasEdge:delete']);
  });

  it('refuses a connector between anything but two distinct live cards', async () => {
    const { noteId, a, b } = await makeBoard();
    await expect(localApi.createCanvasEdge(noteId, { from: a, to: a })).rejects.toThrow(/two different/i);
    await localApi.deleteCanvasItem(noteId, b);
    await expect(localApi.createCanvasEdge(noteId, { from: a, to: b })).rejects.toThrow(/two different/i);
  });

  it('appends ink and hands the ids back in the order the strokes were drawn', async () => {
    const { notebook } = await localApi.createNotebook({ name: 'N' });
    const { note } = await localApi.createNote({ notebookId: notebook.id, title: 'Lecture' });
    await localDb.outbox.clear();

    const { ids } = await localApi.addInk(note.id, [
      { points: [[0, 0, 0.5]], color: '#111', width: 3, tool: 'pen' },
      { points: [[9, 9, 0.5]], color: '#ff0', width: 12, tool: 'highlighter' },
    ]);

    // useInkLayer maps ids[i] onto batch[i] to replace its temporary ids, so the
    // order is load-bearing rather than incidental.
    expect(ids).toHaveLength(2);
    const { strokes } = await localApi.ink(note.id);
    expect(strokes.map((s) => s.id)).toEqual(ids);
    expect(strokes[1]).toMatchObject({ color: '#ff0', width: 12, tool: 'highlighter' });

    // One entry per stroke, because that is the unit the server accepts an id for.
    expect((await drainOrder()).map((e) => `${e.entity}:${e.op}`)).toEqual(['ink:create', 'ink:create']);
  });

  it('erasing a stroke tombstones it rather than removing the row', async () => {
    const { notebook } = await localApi.createNotebook({ name: 'N' });
    const { note } = await localApi.createNote({ notebookId: notebook.id, title: 'Lecture' });
    const { ids } = await localApi.addInk(note.id, [{ points: [[0, 0, 1]], color: '#111', width: 3, tool: 'pen' }]);
    // Pretend the stroke has been pushed, so the delete has something to tell the
    // server about rather than cancelling a create that never left.
    await localDb.ink.update(ids[0], { baseUpdatedAt: '2026-01-01T00:00:00.000Z' });
    await localDb.outbox.clear();

    await localApi.deleteInk(note.id, ids[0]);
    expect((await localApi.ink(note.id)).strokes).toHaveLength(0);
    expect((await localDb.ink.get(ids[0]))?.deletedAt).not.toBeNull();
    expect((await drainOrder()).map((e) => `${e.entity}:${e.op}`)).toEqual(['ink:delete']);
  });

  it('clearing a layer queues ONE entry, not one per stroke', async () => {
    const { notebook } = await localApi.createNotebook({ name: 'N' });
    const { note } = await localApi.createNote({ notebookId: notebook.id, title: 'Lecture' });
    const strokes = Array.from({ length: 40 }, (_, i) => ({
      points: [[i, i, 0.5]] as Array<[number, number, number]>, color: '#111', width: 3, tool: 'pen' as const,
    }));
    await localApi.addInk(note.id, strokes);
    await localDb.outbox.clear();
    // A second batch, so there are per-stroke entries for the clear to supersede.
    await localApi.addInk(note.id, strokes);

    const { removed } = await localApi.clearInk(note.id);
    expect(removed).toBe(80);
    expect((await localApi.ink(note.id)).strokes).toHaveLength(0);

    // Forty queued creates plus forty deletes would be eighty requests to reproduce
    // one the API already expresses in a single call.
    const entries = await drainOrder();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ entity: 'ink', op: 'delete', recordId: `layer:${note.id}` });
  });

  it('deleting a note drops the board and ink writes queued against it', async () => {
    // Every canvas route is scoped through the note and answers 404 once it is a
    // tombstone, and the note delete is pushed FIRST. Anything left queued here would
    // be refused and retried on every sync from then on.
    const { noteId, a, b } = await makeBoard();
    await localApi.createCanvasEdge(noteId, { from: a, to: b });
    await localApi.addInk(noteId, [{ points: [[0, 0, 1]], color: '#111', width: 3, tool: 'pen' }]);
    await localDb.notes.update(noteId, { baseUpdatedAt: '2026-01-01T00:00:00.000Z' });
    await localDb.outbox.clear();

    await localApi.deleteNote(noteId);
    expect((await drainOrder()).map((e) => `${e.entity}:${e.op}`)).toEqual(['note:delete']);
  });

  it('a board pulled from the server reads back through the same DTOs', async () => {
    // The feed writes rows directly, with `data` and `stroke` as the JSON TEXT the
    // server's columns hold. Every read has to survive that shape.
    const noteId = 'dddddddddddddd';
    await localDb.notes.put({
      id: noteId, notebookId: 'nb', title: 'Pulled board', contentJson: '{}', contentText: '',
      kind: 'canvas', pinned: 0, archived: 0, createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z', deletedAt: null, baseUpdatedAt: '2026-08-01T00:00:00.000Z',
    } as never);
    await localDb.canvasItems.bulkPut([
      {
        id: 'eeeeeeeeeeeeee', noteId, kind: 'sticky', x: 1, y: 2, width: 3, height: 4, rotation: 0, z: 2,
        data: '{"text":"top"}', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
        deletedAt: null, baseUpdatedAt: '2026-08-01T00:00:00.000Z',
      },
      {
        id: 'ffffffffffffff', noteId, kind: 'sticky', x: 1, y: 2, width: 3, height: 4, rotation: 0, z: 1,
        data: 'not json at all', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
        deletedAt: '2026-08-02T00:00:00.000Z', baseUpdatedAt: '2026-08-01T00:00:00.000Z',
      },
    ]);
    await localDb.ink.put({
      id: 'gggggggggggggg', noteId, stroke: '{"points":[[1,1,0.5]],"color":"#abc","width":5,"tool":"pen"}',
      createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
      deletedAt: null, baseUpdatedAt: '2026-08-01T00:00:00.000Z',
    });

    const board = await localApi.canvas(noteId);
    // The tombstoned item is filtered in code: IndexedDB cannot index a null check.
    expect(board.items.map((i) => i.id)).toEqual(['eeeeeeeeeeeeee']);
    expect(board.items[0].data).toEqual({ text: 'top' });
    expect((await localApi.ink(noteId)).strokes[0]).toMatchObject({ color: '#abc', width: 5 });
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
