import { beforeEach, describe, expect, it, vi } from 'vitest';

const notebooks = vi.fn();
const searchTitles = vi.fn();
const createNote = vi.fn();
const updateNote = vi.fn();
const isGuestMock = vi.fn(() => false);

vi.mock('../../lib/api', () => ({
  api: {
    notebooks: () => notebooks(),
    searchTitles: (q: string) => searchTitles(q),
    createNote: (b: unknown) => createNote(b),
    updateNote: (id: string, b: unknown) => updateNote(id, b),
  },
}));

vi.mock('../guest/guestMode', () => ({
  isGuest: () => isGuestMock(),
}));

const { ensureReadme } = await import('./ensureReadme');

describe('ensureReadme', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isGuestMock.mockReturnValue(false);
    notebooks.mockResolvedValue({ notebooks: [{ id: 'nb1', name: 'My notes' }] });
    searchTitles.mockResolvedValue({ results: [] });
    createNote.mockResolvedValue({ note: { id: 'n1' } });
    updateNote.mockResolvedValue({ note: { id: 'n1' } });
  });

  it('creates the account build of the README, pinned, in the target notebook', async () => {
    const id = await ensureReadme();
    expect(id).toBe('n1');
    const body = createNote.mock.calls[0][0];
    expect(body.title).toBe('README');
    expect(body.notebookId).toBe('nb1');
    expect(body.contentText).not.toContain('needs an account');
    expect(updateNote).toHaveBeenCalledWith('n1', { pinned: true });
  });

  // Fix 5: tags and content actually get forwarded to createNote, not silently dropped.
  it('carries the built tags and the built document into createNote', async () => {
    await ensureReadme();
    const body = createNote.mock.calls[0][0];
    expect(body.tags).toEqual(['unote', 'guide']);
    expect(body.contentJson).toMatchObject({ type: 'doc' });
    expect(Array.isArray(body.contentJson.content)).toBe(true);
    expect(body.contentJson.content.length).toBeGreaterThan(0);
  });

  // Fix 1: the command palette's "Open the guide" is reachable without an account, so the
  // build has to follow the real guest flag rather than being hardcoded to the account build.
  it('builds the guest guide, with "needs an account" marks, when isGuest() is true', async () => {
    isGuestMock.mockReturnValue(true);
    await ensureReadme();
    const body = createNote.mock.calls[0][0];
    expect(body.contentText).toContain('needs an account');
  });

  it('builds the account guide, with no "needs an account" marks, when isGuest() is false', async () => {
    isGuestMock.mockReturnValue(false);
    await ensureReadme();
    const body = createNote.mock.calls[0][0];
    expect(body.contentText).not.toContain('needs an account');
  });

  it('returns the existing note and writes nothing when one is already there', async () => {
    searchTitles.mockResolvedValue({ results: [{ id: 'existing', title: 'README' }] });
    expect(await ensureReadme()).toBe('existing');
    expect(createNote).not.toHaveBeenCalled();
  });

  // Fix 3: the lookup now goes through searchTitles (a substring match server-side), so
  // the exact-title filter has to keep doing its job through the new lookup too.
  it('ignores a note whose title merely contains README as a substring', async () => {
    searchTitles.mockResolvedValue({ results: [{ id: 'x', title: 'README notes from 2024' }] });
    await ensureReadme();
    expect(createNote).toHaveBeenCalled();
  });

  it('looks the existing README up by searchTitles, not by listing notes', async () => {
    await ensureReadme();
    expect(searchTitles).toHaveBeenCalledWith('README');
  });

  it('returns null rather than throwing when there is no notebook', async () => {
    notebooks.mockResolvedValue({ notebooks: [] });
    expect(await ensureReadme()).toBeNull();
    expect(createNote).not.toHaveBeenCalled();
  });

  it('returns null rather than throwing when the API fails', async () => {
    createNote.mockRejectedValue(new Error('offline'));
    expect(await ensureReadme()).toBeNull();
  });

  // Fix 4: a note that was created must not be thrown away just because the follow-up
  // pin failed - "Open the guide" needs somewhere to navigate to.
  it('returns the created note id even when pinning it fails', async () => {
    updateNote.mockRejectedValue(new Error('offline'));
    expect(await ensureReadme()).toBe('n1');
    expect(createNote).toHaveBeenCalled();
  });
});
