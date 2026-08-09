// Create the README note for an account, at most once.
//
// Two guards, because one is not enough. The onboarding record is per-browser
// localStorage, so it would let a second device create a second README; and a title
// search alone would re-create the note for someone who deliberately deleted theirs on
// every page load. OnboardingHost supplies the first guard (status 'unseen'), this
// module supplies the second.
//
// Every failure path returns null rather than throwing. This runs on first login, next
// to the tutorial - a network blip must not take the app down, and a student who never
// sees the guide has lost a convenience, not their notes.
import { api } from '../../lib/api';
import { README_TITLE, buildReadme } from './buildReadme';

export async function ensureReadme(): Promise<string | null> {
  try {
    const { notes } = await api.notes({ limit: 200 });
    const existing = notes.find((n) => n.title === README_TITLE);
    if (existing) return existing.id;

    const { notebooks } = await api.notebooks();
    const target = notebooks.find((n) => !n.archived) ?? notebooks[0];
    if (!target) return null;

    const built = buildReadme({ guest: false });
    const { note } = await api.createNote({
      notebookId: target.id,
      title: built.title,
      contentJson: built.contentJson,
      contentText: built.contentText,
      tags: built.tags,
    });
    await api.updateNote(note.id, { pinned: true });
    return note.id;
  } catch {
    return null;
  }
}
