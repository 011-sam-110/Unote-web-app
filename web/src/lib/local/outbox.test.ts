import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { localDb } from './db';
import { enqueue, drainOrder, pendingCount } from './outbox';

const entry = (over: Partial<Parameters<typeof enqueue>[0]> = {}) => ({
  entity: 'note' as const,
  op: 'update' as const,
  recordId: 'n1',
  payload: { title: 'v1' },
  baseUpdatedAt: null,
  clientUpdatedAt: '2026-08-09T10:00:00.000Z',
  ...over,
});

describe('outbox', () => {
  beforeEach(async () => {
    await localDb.delete();
    await localDb.open();
  });

  it('coalesces repeated updates to one record into a single entry', async () => {
    // A two-hour offline editing session must not queue thousands of PATCHes.
    for (let i = 0; i < 500; i++) {
      await enqueue(entry({ payload: { title: `v${i}` } }));
    }
    expect(await pendingCount()).toBe(1);
    const [only] = await drainOrder();
    expect(only.payload).toEqual({ title: 'v499' });
  });

  it('keeps separate records separate', async () => {
    await enqueue(entry({ recordId: 'n1' }));
    await enqueue(entry({ recordId: 'n2' }));
    expect(await pendingCount()).toBe(2);
  });

  it('a delete supersedes pending updates for that record', async () => {
    await enqueue(entry({ op: 'update', payload: { title: 'edited' } }));
    await enqueue(entry({ op: 'delete', payload: {} }));
    const all = await drainOrder();
    expect(all).toHaveLength(1);
    expect(all[0].op).toBe('delete');
  });

  it('a delete of a record created offline cancels both - it never existed server-side', async () => {
    await enqueue(entry({ op: 'create', payload: { title: 'ghost' } }));
    await enqueue(entry({ op: 'delete', payload: {} }));
    expect(await pendingCount()).toBe(0);
  });

  it('an update after a pending create stays a create, carrying the newest payload', async () => {
    // Pushing an update for a record the server has never seen would 404.
    await enqueue(entry({ op: 'create', payload: { title: 'first' } }));
    await enqueue(entry({ op: 'update', payload: { title: 'second' } }));
    const all = await drainOrder();
    expect(all).toHaveLength(1);
    expect(all[0].op).toBe('create');
    expect(all[0].payload).toEqual({ title: 'second' });
  });

  it('drains notebooks before the notes that reference them', async () => {
    // routes/notes.ts returns 400 for an unknown notebookId, so a note created
    // offline inside an offline notebook must be sent second.
    await enqueue(entry({ entity: 'note', op: 'create', recordId: 'n1' }));
    await enqueue(entry({ entity: 'notebook', op: 'create', recordId: 'nb1' }));
    expect((await drainOrder()).map((e) => e.entity)).toEqual(['notebook', 'note']);
  });
});
