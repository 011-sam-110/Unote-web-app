// The seam: which side of the app answers a given call, in each of the three modes.
//
// These tests exist because the routing decision is invisible at every call site.
// Pages just call `api.notes()`. If the resolver sends a write to the mirror and
// forgets the outbox, nothing anywhere throws - the edit simply never reaches another
// device, and the user finds out days later on a different laptop.
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const guestFlag = { value: false };
vi.mock('../features/guest/guestMode', () => ({
  isGuest: () => guestFlag.value,
  useGuest: () => guestFlag.value,
}));

// The engine is stubbed so a write-through does not try to reach a server. What is
// under test here is WHICH function the proxy hands back, not what sync does with it.
const syncCalls = { count: 0 };
vi.mock('./sync/engine', () => ({
  syncNow: async () => {
    syncCalls.count += 1;
    return { pulled: 0, pushed: 0, conflicts: 0 };
  },
  startSync: () => () => {},
}));

const { api, getMode } = await import('./api');
const { localApi } = await import('./local/localApi');
const { WRITE_METHODS, MIRRORED_READS } = await import('./sync/methods');
const { noteRequestOutcome } = await import('./sync/connectivity');
const { setMirrorWarm } = await import('./sync/mirrorState');

beforeEach(() => {
  guestFlag.value = false;
  noteRequestOutcome(true);
  setMirrorWarm(false);
  syncCalls.count = 0;
});

describe('the method classification', () => {
  // methods.ts claims a test asserts this pairing. This is that test: a name in
  // WRITE_METHODS with no localApi implementation would fall through to the server
  // in online mode and REJECT offline, which is the opposite of what the list means.
  it('every WRITE_METHODS name exists on localApi', () => {
    const missing = [...WRITE_METHODS].filter(
      (name) => typeof (localApi as Record<string, unknown>)[name] !== 'function',
    );
    expect(missing).toEqual([]);
  });

  it('every MIRRORED_READS name exists on localApi', () => {
    const missing = [...MIRRORED_READS].filter(
      (name) => typeof (localApi as Record<string, unknown>)[name] !== 'function',
    );
    expect(missing).toEqual([]);
  });

  it('no name is both a write and a mirrored read', () => {
    const both = [...WRITE_METHODS].filter((n) => MIRRORED_READS.has(n));
    expect(both).toEqual([]);
  });
});

describe('getMode', () => {
  it('is online when requests are reaching a server', () => {
    expect(getMode()).toBe('online');
  });

  it('is offline after a transport failure', () => {
    noteRequestOutcome(false);
    expect(getMode()).toBe('offline');
  });

  it('is guest regardless of connectivity, because a guest has no account to sync', () => {
    guestFlag.value = true;
    expect(getMode()).toBe('guest');
    noteRequestOutcome(false);
    expect(getMode()).toBe('guest');
  });
});

describe('routing', () => {
  it('guest mode serves reads from the mirror', () => {
    guestFlag.value = true;
    expect(api.notebooks).toBe(localApi.notebooks);
  });

  it('offline serves a mirrored read from the mirror', () => {
    noteRequestOutcome(false);
    expect(api.notes).toBe(localApi.notes);
  });

  it('offline serves boards and ink from the mirror, which were stubs until Stage 2', () => {
    noteRequestOutcome(false);
    expect(api.canvas).toBe(localApi.canvas);
    expect(api.ink).toBe(localApi.ink);
    expect(api.addInk).toBe(localApi.addInk);
    expect(api.createCanvasItem).toBe(localApi.createCanvasItem);
    // Offline an image goes to the blobs table and comes back as a local reference.
    expect(api.uploadImage).toBe(localApi.uploadImage);
  });

  it('guest mode still refuses boards, ink and images, though the mirror could answer', async () => {
    // Stage 2 taught the local store to hold all three. Guest mode is still the capped
    // trial it always was, and "there is a local function for it now" is not a decision
    // to widen it - so guestErrors' table beats the presence of an implementation.
    guestFlag.value = true;
    for (const name of ['createCanvasItem', 'updateCanvasItems', 'addInk', 'clearInk', 'uploadImage'] as const) {
      expect(typeof (localApi as Record<string, unknown>)[name]).toBe('function');
      await expect(
        (api[name] as (...a: never[]) => Promise<unknown>)('n1' as never, [] as never),
      ).rejects.toThrow(/make an account/i);
    }
    // The READS stay as they always were for a guest: a valid empty answer, so the
    // panel renders empty rather than broken. A guest has no boards to read.
    await expect(api.canvas('n1')).resolves.toEqual({ items: [], edges: [] });
    await expect(api.ink('n1')).resolves.toEqual({ strokes: [] });
  });

  it('offline refuses something the mirror cannot answer, and says why', async () => {
    noteRequestOutcome(false);
    // aiChat has no offline meaning at all - there is nothing to run the model on.
    await expect((api.aiChat as (a: string, b: never[]) => Promise<unknown>)('n1', [])).rejects.toThrow(/connection/i);
  });

  it('offline refuses note history rather than serving the empty guest stub', async () => {
    // localApi.versions returns [] so a guest sees an empty panel instead of an
    // error. For a signed-in user who HAS history, [] would be a lie.
    noteRequestOutcome(false);
    await expect((api.versions as (id: string) => Promise<unknown>)('n1')).rejects.toThrow(/connection/i);
  });

  it('online reads come from the SERVER, warm mirror or not', () => {
    // This is the boundary that seven e2e specs moved. Serving online reads from the
    // mirror needs localApi to match the server field for field, and it does not: it
    // ignores kind: 'canvas' and cannot resolve wikilinks, so boards opened as
    // documents and backlinks disappeared.
    //
    // Online behaviour is therefore identical to before offline support existed,
    // which is what makes this feature unable to regress the online app.
    expect(api.notes).not.toBe(localApi.notes);
    setMirrorWarm(true);
    expect(api.notes).not.toBe(localApi.notes);
  });

  it('online never serves auth from the mirror, whatever the mirror state', () => {
    setMirrorWarm(true);
    guestFlag.value = true;
    // Signing in is how guest mode ENDS; it cannot be answered by the thing it ends.
    expect(typeof api.login).toBe('function');
    expect(api.login).not.toBe((localApi as Record<string, unknown>).login);
  });

  it('an online write is NOT served from the mirror', () => {
    // It goes to the server and then kicks a sync, so the mirror has the change
    // ready for the next disconnection. The wrapper is neither the local function
    // nor the bare server function.
    setMirrorWarm(true);
    expect(api.createNotebook).not.toBe(localApi.createNotebook);
  });

  it('an offline write IS served from the mirror, and queues', async () => {
    noteRequestOutcome(false);
    const { notebook } = await api.createNotebook({ name: 'Offline seam test' });
    expect(notebook.id).toMatch(/^[a-z0-9]{14}$/);
    const { notebooks } = await localApi.notebooks();
    expect(notebooks.map((n) => n.name)).toContain('Offline seam test');
    // No sync attempt: there is nothing to reach.
    expect(syncCalls.count).toBe(0);
  });

  it('exportUrl is passed through untouched, being synchronous', () => {
    // It returns a string, not a promise. Wrapping it in any async path breaks it.
    expect(typeof api.exportUrl('n1')).toBe('string');
  });
});
