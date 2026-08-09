import { beforeEach, describe, expect, it } from 'vitest';
import { clearData, readData, seedGuestWorkspace } from './guestStore';

describe('seedGuestWorkspace', () => {
  beforeEach(() => clearData());

  it('creates one notebook and two notes', () => {
    seedGuestWorkspace();
    const data = readData();
    expect(data.notebooks).toHaveLength(1);
    expect(data.notes).toHaveLength(2);
  });

  it('writes the README first, pinned and tagged', () => {
    const { readme } = seedGuestWorkspace();
    const stored = readData().notes[0];
    expect(stored.id).toBe(readme.id);
    expect(stored.title).toBe('README');
    expect(stored.pinned).toBe(true);
    expect(stored.tags).toEqual(['unote', 'guide']);
  });

  it('leaves a blank note to type into, after the README', () => {
    const { note } = seedGuestWorkspace();
    const stored = readData().notes[1];
    expect(stored.id).toBe(note.id);
    expect(stored.title).toBe('');
  });

  it('seeds the guest build of the README, not the account build', () => {
    seedGuestWorkspace();
    expect(readData().notes[0].contentText).toContain('needs an account');
  });

  it('gives the README searchable body text', () => {
    seedGuestWorkspace();
    expect(readData().notes[0].contentText.length).toBeGreaterThan(500);
  });
});
