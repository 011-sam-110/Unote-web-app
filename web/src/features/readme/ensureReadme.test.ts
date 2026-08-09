import { beforeEach, describe, expect, it, vi } from 'vitest';

const notebooks = vi.fn();
const notes = vi.fn();
const createNote = vi.fn();
const updateNote = vi.fn();

vi.mock('../../lib/api', () => ({
  api: {
    notebooks: () => notebooks(),
    notes: (q: unknown) => notes(q),
    createNote: (b: unknown) => createNote(b),
    updateNote: (id: string, b: unknown) => updateNote(id, b),
  },
}));

const { ensureReadme } = await import('./ensureReadme');

describe('ensureReadme', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    notebooks.mockResolvedValue({ notebooks: [{ id: 'nb1', name: 'My notes' }] });
    notes.mockResolvedValue({ notes: [], total: 0 });
    createNote.mockResolvedValue({ note: { id: 'n1' } });
    updateNote.mockResolvedValue({ note: { id: 'n1' } });
  });

  it('creates the account build of the README, pinned', async () => {
    const id = await ensureReadme();
    expect(id).toBe('n1');
    const body = createNote.mock.calls[0][0];
    expect(body.title).toBe('README');
    expect(body.notebookId).toBe('nb1');
    expect(body.contentText).not.toContain('needs an account');
    expect(updateNote).toHaveBeenCalledWith('n1', { pinned: true });
  });

  it('returns the existing note and writes nothing when one is already there', async () => {
    notes.mockResolvedValue({ notes: [{ id: 'existing', title: 'README' }], total: 1 });
    expect(await ensureReadme()).toBe('existing');
    expect(createNote).not.toHaveBeenCalled();
  });

  it('ignores a note whose title merely contains README', async () => {
    notes.mockResolvedValue({ notes: [{ id: 'x', title: 'README notes from 2024' }], total: 1 });
    await ensureReadme();
    expect(createNote).toHaveBeenCalled();
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
});
