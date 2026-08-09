// Is this browser being used without an account, and how does it get in and out of that.
//
// The flag is read synchronously (localStorage, not React state) because lib/api.ts routes
// every call on it and RequireAuth decides on it during the first render, both of which
// happen before any effect could have loaded it.
import { useEffect, useState } from 'react';
import { clearData, hasGuestWork, latestNoteId, seedGuestWorkspace, storageAvailable, subscribeGuestData } from './guestStore';

const ACTIVE_KEY = 'unote:guest:active';

const listeners = new Set<() => void>();
let active = readFlag();

function readFlag(): boolean {
  try {
    return localStorage.getItem(ACTIVE_KEY) === '1';
  } catch {
    return false;
  }
}

function emit(): void {
  listeners.forEach((l) => l());
}

/** True when the app is running on browser-local data with no account behind it. */
export function isGuest(): boolean {
  return active;
}

/** Guest mode cannot be offered where the browser refuses to persist anything. */
export function guestModeSupported(): boolean {
  return storageAvailable();
}

/**
 * Enter guest mode, seeding a notebook and one empty note on the first visit so the
 * caller has somewhere to send the person. Returns the note to open.
 *
 * Idempotent, and that is load-bearing rather than tidiness: the caller is a React effect,
 * which StrictMode runs twice in development. A version that only reported a note id when
 * it had just seeded one answered "nothing to open" on the second pass and dropped the
 * visitor on the dashboard. Reporting the most recent note either way also gives the right
 * answer for someone returning to /try with work already here.
 */
export function startGuest(): { noteId: string | null } {
  try {
    localStorage.setItem(ACTIVE_KEY, '1');
  } catch {
    return { noteId: null };
  }
  active = true;
  if (!hasGuestWork()) {
    try {
      seedGuestWorkspace();
    } catch {
      // Storage filled between the probe and the write. The shell still opens; the
      // dashboard's empty state is a survivable landing.
    }
  }
  emit();
  return { noteId: latestNoteId() };
}

/**
 * Leave guest mode. `keepWork` is the difference between signing in (the notes have
 * either been copied across or deliberately abandoned) and simply closing the trial.
 */
export function endGuest(options: { keepWork: boolean }): void {
  try {
    localStorage.removeItem(ACTIVE_KEY);
  } catch {
    // Nothing persisted, nothing to remove.
  }
  active = false;
  if (!options.keepWork) {
    clearData();
    // The notes themselves live in IndexedDB now, not in the localStorage blob
    // clearData() removes. Without this, "discard my trial work" would leave every
    // row and every queued outbox entry in place - and the next sign-in would push
    // work the user explicitly deleted straight into their new account.
    //
    // The app's discard button (GuestMigrationHost) already clears both, so this is
    // belt-and-braces for any future caller of endGuest. Deliberately not awaited:
    // this function is synchronous because api.ts and RequireAuth read the guest flag
    // during render, and making it async would mean the flag lags a frame behind.
    void import('../../lib/local/localApi').then((m) => m.clearLocalStore()).catch(() => {
      // Nothing to clear, or storage unavailable. The flag is already off.
    });
  }
  emit();
}

/** Live guest flag for components. */
export function useGuest(): boolean {
  const [value, setValue] = useState(active);
  useEffect(() => {
    const l = () => setValue(active);
    listeners.add(l);
    l();
    return () => {
      listeners.delete(l);
    };
  }, []);
  return value;
}

/** Live count of what would be lost, for the banner and the migration prompt. */
export function useGuestWorkPresent(): boolean {
  const [present, setPresent] = useState(hasGuestWork);
  useEffect(() => subscribeGuestData(() => setPresent(hasGuestWork())), []);
  return present;
}

// --- the handover question ------------------------------------------------------
// Session-scoped, so "not now" defers the question to the next visit rather than
// answering it forever. A silent forever-dismiss is how work gets lost.

const DEFERRED_KEY = 'unote:guest:migrationDeferred';

function isDeferred(): boolean {
  try {
    return sessionStorage.getItem(DEFERRED_KEY) === '1';
  } catch {
    return false;
  }
}

export function deferHandover(): void {
  try {
    sessionStorage.setItem(DEFERRED_KEY, '1');
  } catch {
    // Nothing to remember it with; the question reappears, which is the safe direction.
  }
  emit();
}

/** Is there unsaved guest work whose fate this session has not decided yet? */
export function handoverPending(): boolean {
  return hasGuestWork() && !isDeferred();
}

/**
 * Live version, so anything that would talk over the handover can wait for it.
 *
 * The onboarding tour is the reason this is exported: a brand-new account opens the
 * tutorial by itself, and a tutorial offer is not the thing to put in front of someone
 * whose unsaved notes are one click from being orphaned.
 */
export function useGuestHandoverPending(): boolean {
  const [pending, setPending] = useState(handoverPending);
  useEffect(() => {
    const sync = () => setPending(handoverPending());
    listeners.add(sync);
    const unsubscribe = subscribeGuestData(sync);
    sync();
    return () => {
      listeners.delete(sync);
      unsubscribe();
    };
  }, []);
  return pending;
}
