// The handover: a guest just signed in, and their browser still holds notes nothing has
// ever saved. This asks what to do with them before anything can lose them.
//
// Mounted next to the routes (main.tsx) rather than on a page, because the sign-in can
// land on /login, /signup, or a redirect back from an OAuth provider, and all three end
// with the same question.
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import Modal from '../../components/Modal';
import Spinner from '../../components/Spinner';
import { toast } from '../../components/Toast';
import { errorMessage } from '../../lib/format';
import { useAuth } from '../auth/AuthContext';
import { downloadGuestExport } from './guestExport';
import { clearLocalStore, localSnapshot } from '../../lib/local/localApi';
import { clearData } from './guestStore';
import { deferHandover, endGuest, handoverPending, isGuest } from './guestMode';
import { migrateGuestWork, type MigrationProgress } from './guestMigrate';
import './guest.css';

/**
 * The auth screens are not somewhere to put this dialog.
 *
 * Signup sets the session BEFORE the user has cleared the one-time recovery key, which is
 * the one screen in the app that deliberately offers no way out - and a modal opening over
 * it steals focus from the only render of a credential that cannot be reissued. Waiting
 * for a route inside the app also puts the question where its answer makes sense, next to
 * the notes it is about.
 */
const AUTH_PATHS = ['/login', '/signup', '/recover', '/try'];

export default function GuestMigrationHost() {
  const { user } = useAuth();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<MigrationProgress | null>(null);
  const [counts, setCounts] = useState({ notes: 0, notebooks: 0 });

  useEffect(() => {
    if (!user) return;
    // AuthContext already turned guest mode off the moment the session appeared, before
    // any of the shell re-rendered. This is a belt-and-braces repeat for any future route
    // into a session that does not pass through those callbacks.
    if (isGuest()) endGuest({ keepWork: true });
    if (AUTH_PATHS.some((p) => pathname.startsWith(p))) return;
    if (!handoverPending()) return;
    // The dialog opens on the synchronous check and fills its counts when the store
    // answers: waiting for the read would let a route change land first, and the numbers
    // are a sentence in the copy rather than the decision to show it.
    setOpen(true);
    let cancelled = false;
    void localSnapshot().then((data) => {
      if (!cancelled) setCounts({ notes: data.notes.length, notebooks: data.notebooks.length });
    });
    return () => {
      cancelled = true;
    };
  }, [user, pathname]);

  if (!open || !user) return null;

  async function bringThemIn() {
    setBusy(true);
    try {
      const res = await migrateGuestWork(setProgress);
      if (res.complete) {
        toast(`${res.notesCreated} note${res.notesCreated === 1 ? '' : 's'} added to your account`, 'ok');
        setOpen(false);
      } else {
        toast(`${res.failed} could not be copied. Your unsaved copy is still here`, 'error');
      }
    } catch (e) {
      toast(errorMessage(e, 'Could not copy your notes across'), 'error');
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function downloadThem() {
    try {
      await downloadGuestExport();
      toast('Downloaded. Your notes are still here until you delete them', 'ok');
    } catch (e) {
      toast(errorMessage(e, 'Could not build the download'), 'error');
    }
  }

  async function discard() {
    // Both stores: the local rows the notes actually live in, and the pre-upgrade
    // localStorage blob guestMode reads to decide whether any work is present. Leaving
    // either behind would make the toast below untrue.
    await clearLocalStore();
    clearData();
    setOpen(false);
    toast('Unsaved notes deleted from this browser', 'ok');
  }

  function notNow() {
    deferHandover();
    setOpen(false);
  }

  return (
    <Modal open onClose={notNow} title="Bring your notes with you?" width={440}>
      <div className="guest-migrate">
        <p className="guest-migrate__lead">
          You wrote {counts.notes} note{counts.notes === 1 ? '' : 's'} in {counts.notebooks} notebook
          {counts.notebooks === 1 ? '' : 's'} before making this account. None of it has been saved anywhere
          except this browser.
        </p>

        {progress && (
          <p className="guest-migrate__progress" role="status">
            Copying {progress.done} of {progress.total}…
          </p>
        )}

        <div className="guest-migrate__actions">
          <button type="button" className="btn btn-primary" onClick={bringThemIn} disabled={busy}>
            {busy && <Spinner size={14} />}
            {busy ? 'Copying…' : 'Copy them into my account'}
          </button>
          <button type="button" className="btn btn-secondary" onClick={downloadThem} disabled={busy}>
            Download them instead
          </button>
        </div>

        <div className="guest-migrate__minor">
          <button type="button" className="guest-link" onClick={notNow} disabled={busy}>
            Not now
          </button>
          <button type="button" className="guest-link guest-link--danger" onClick={discard} disabled={busy}>
            Delete them
          </button>
        </div>

        <p className="guest-migrate__foot">
          "Not now" keeps them in this browser and asks again next time. Clearing your browser data removes
          them for good.
        </p>
      </div>
    </Modal>
  );
}
