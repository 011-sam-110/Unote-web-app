// Starts and stops the sync loop in step with the session.
//
// A component rather than a call in main.tsx, because when to sync is a question
// about the session and main.tsx runs before there is one. Three conditions have to
// hold, and each has a concrete failure behind it:
//
//   * There must be a signed-in user. Syncing while signed out 401s every request,
//     and the engine reads a failed request as "offline" - so the app would sit in a
//     permanent offline state on the login screen.
//   * The scope must be 'full'. A capture-scoped session is a phone paired by QR;
//     the server admits it to the capture flow only, so /api/sync/changes answers
//     403 and the same false-offline state follows.
//   * Guest mode must be off. A guest has no account to sync with, and its records
//     carry no server identity at all.
//
// Renders nothing.
import { useEffect } from 'react';
import { useAuth } from '../../features/auth/AuthContext';
import { useGuest } from '../../features/guest/guestMode';
import { startSync } from './engine';

export default function SyncRunner(): null {
  const { user, scope, loading } = useAuth();
  const guest = useGuest();

  const shouldSync = !loading && Boolean(user) && scope === 'full' && !guest;

  useEffect(() => {
    if (!shouldSync) return;
    // startSync runs a cycle immediately, then on every reconnect and on a slow
    // poll. Its returned function tears all of that down, so signing out stops the
    // loop rather than leaving a timer firing 401s at the login screen.
    return startSync();
  }, [shouldSync]);

  return null;
}
