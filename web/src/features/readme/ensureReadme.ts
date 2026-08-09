// Create the README note for an account, at most once.
//
// Two guards, because one is not enough. The onboarding record is per-browser
// localStorage, so it would let a second device create a second README; and a title
// search alone would re-create the note for someone who deliberately deleted theirs on
// every page load. OnboardingHost supplies the first guard (status 'unseen'), this
// module supplies the second.
//
// The lookup goes through api.searchTitles rather than api.notes: notes() caps at 200
// and sorts by updated_at DESC, so an account with more than 200 live notes whose README
// has gone stale would fall out of that window and get a second one created underneath
// it. searchTitles ranks an exact/prefix match first regardless of recency, which keeps
// this working past the 200-note cap. The exact-title check below still runs against
// whatever it returns, because the query is a substring match server-side ("README
// notes from 2024" would otherwise suppress the guide for someone who never got one).
//
// Every failure path except a failed pin returns null rather than throwing. This runs on
// first login, next to the tutorial - a network blip must not take the app down, and a
// student who never sees the guide has lost a convenience, not their notes. A failed pin
// is different: the note was already created, so returning null there would orphan it
// and send "Open the guide" nowhere for a note that genuinely exists.
import { api } from '../../lib/api';
import { isGuest } from '../guest/guestMode';
import { README_TITLE, buildReadme } from './buildReadme';

export async function ensureReadme(): Promise<string | null> {
  try {
    const { results } = await api.searchTitles(README_TITLE);
    const existing = results.find((r) => r.title === README_TITLE);
    if (existing) return existing.id;

    const { notebooks } = await api.notebooks();
    const target = notebooks.find((n) => !n.archived) ?? notebooks[0];
    if (!target) return null;

    // isGuest() is read here, inside the function, never at module scope - this module
    // sits in the guestStore.ts <-> buildReadme.ts <-> guestApi.ts import cycle (via
    // guestMode.ts, which lib/api.ts also imports), and a module-scope read of a
    // cross-module binding is exactly what breaks that cycle depending on which module
    // happens to load it first. See the five *.loadOrder.test.ts files.
    const built = buildReadme({ guest: isGuest() });
    const { note } = await api.createNote({
      notebookId: target.id,
      title: built.title,
      contentJson: built.contentJson,
      contentText: built.contentText,
      tags: built.tags,
    });
    try {
      await api.updateNote(note.id, { pinned: true });
    } catch {
      // The note exists even though pinning didn't - leave it unpinned rather than
      // discarding it. A future ensureReadme() call will find it by title and can try
      // the pin again; it will not create a second note.
    }
    return note.id;
  } catch {
    return null;
  }
}
