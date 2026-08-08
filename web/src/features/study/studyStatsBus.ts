// Lets the study screens tell the sidebar that the due count has moved.
//
// The sidebar's "Study" badge is fed by its own poll of GET /api/study/stats on a
// 60-second timer. That is fine for a number that drifts on its own (cards falling due
// while you write), but it is wrong for the one case where the user CHANGES the number
// themselves: grading a card. You could sit on /study having reviewed the whole queue,
// with the page saying "Nothing due" and the sidebar three inches away still insisting
// there were two - and it only corrected itself when you navigated, which read as the
// badge being broken rather than merely late.
//
// Same shape as autosaveBus / commentsBus: a module-level set of listeners, no context
// and no provider, because the publisher and the subscriber are on opposite sides of the
// tree and neither owns the other.
type Listener = () => void;

const listeners = new Set<Listener>();

/** Subscribe to "the due count may have changed". Returns an unsubscribe function. */
export function onStudyStatsChanged(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Call after anything that grades, creates, deletes, suspends or restores a card. */
export function studyStatsChanged(): void {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      // One bad subscriber must not stop the others from refreshing.
    }
  }
}
