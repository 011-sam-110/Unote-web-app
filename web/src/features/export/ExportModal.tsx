// "Download everything", with the count stated before the click.
//
// The server caps one export (see server/src/routes/export.ts), and a cap you only find
// out about by diffing the zip against your account is not a cap, it is data loss with
// extra steps. So this asks for the summary first and says plainly how many notes the
// archive will hold and how many it will not.
import { useEffect, useState } from 'react';
import Modal from '../../components/Modal';
import Spinner from '../../components/Spinner';
import { toast } from '../../components/Toast';
import { api } from '../../lib/api';
import { errorMessage, plural } from '../../lib/format';
import { downloadGuestExport, guestExportSummary } from '../guest/guestExport';
import { useGuest } from '../guest/guestMode';
import './dataControls.css';

interface Summary {
  notes: number;
  notebooks: number;
  included: number;
  truncated: boolean;
  maxNotes: number;
}

export default function ExportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const guest = useGuest();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSummary(null);
    if (guest) {
      // The local store answers asynchronously now that it is a database, so this branch
      // is a promise like the server one rather than a synchronous read.
      let stale = false;
      void guestExportSummary().then((g) => {
        if (!stale) setSummary({ notes: g.notes, notebooks: g.notebooks, included: g.notes, truncated: false, maxNotes: g.notes });
      });
      return () => {
        stale = true;
      };
    }
    let cancelled = false;
    api
      .exportSummary()
      .then((s) => {
        if (!cancelled) setSummary(s);
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e, 'Could not work out what to export'));
      });
    return () => {
      cancelled = true;
    };
  }, [open, guest]);

  async function downloadForGuest() {
    setBuilding(true);
    try {
      await downloadGuestExport();
      toast('Downloaded', 'ok');
      onClose();
    } catch (e) {
      setError(errorMessage(e, 'Could not build the download'));
    } finally {
      setBuilding(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Export your notes" width={420}>
      <div className="export-modal">
        {!summary && !error && (
          <div className="export-modal__loading">
            <Spinner size={20} />
          </div>
        )}

        {error && (
          <p className="export-modal__error" role="alert">
            {error}
          </p>
        )}

        {summary && (
          <>
            <p className="export-modal__lead">
              A .zip of Markdown files, one folder per notebook. Each file keeps its title and tags at the top,
              so it can be imported straight back in.
            </p>

            {summary.notes === 0 ? (
              <p className="export-modal__empty">There is nothing to export yet. Write a note first.</p>
            ) : (
              <>
                <div className="export-modal__counts">
                  <strong>
                    {plural(summary.included, 'note')} in {plural(summary.notebooks, 'notebook')}
                  </strong>
                  {summary.truncated && (
                    <span className="export-modal__warn">
                      Your account has {plural(summary.notes, 'note')}. One export is capped at {summary.maxNotes} so it
                      finishes in time, so the {summary.notes - summary.included} least recently edited will be left
                      out. Export again after archiving or deleting some to get the rest.
                    </span>
                  )}
                </div>

                <p className="export-modal__note">
                  Attachments, drawings, flashcards and note history are not included. Boards export their text only.
                </p>

                {guest ? (
                  <button type="button" className="btn btn-primary export-modal__go" onClick={downloadForGuest} disabled={building}>
                    {building && <Spinner size={14} />}
                    {building ? 'Building…' : 'Download .zip'}
                  </button>
                ) : (
                  // A plain link, so the browser streams the response to disk rather than
                  // this tab holding the whole archive in memory first.
                  <a className="btn btn-primary export-modal__go" href={api.exportAllUrl()} onClick={onClose}>
                    Download .zip
                  </a>
                )}
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
