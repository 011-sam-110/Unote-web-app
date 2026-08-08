// Export and Import, in the sidebar footer directly under the account row.
//
// Both were reachable before only from inside menus - per-note export from the editor's
// toolbar, the import wizard from the command palette and one dashboard button - which
// meant "get my notes out" had no answer anybody could find. These are two labelled
// buttons in the place people already look for their own stuff.
import { useState } from 'react';
import Icon from '../../components/Icon';
import Tooltip from '../../components/Tooltip';
import { openImportWizard } from '../import/importWizardBus';
import { useGuest } from '../guest/guestMode';
import ExportModal from './ExportModal';
import GuestImportModal from './GuestImportModal';
import './dataControls.css';

export default function DataControls() {
  const guest = useGuest();
  const [exportOpen, setExportOpen] = useState(false);
  const [guestImportOpen, setGuestImportOpen] = useState(false);

  return (
    <div className="data-controls">
      {/* Right, not the default above: these sit on the sidebar's bottom row, directly under
          the account identity. See the note on that row in Sidebar.tsx. */}
      <Tooltip content="Export. Download every note as Markdown" placement="right">
        <button
          type="button"
          className="data-controls__btn"
          data-testid="export-button"
          aria-label="Export notes"
          onClick={() => setExportOpen(true)}
        >
          <Icon name="download" size={15} />
        </button>
      </Tooltip>
      <Tooltip content="Import. Phone photos, files, or a Unote export" placement="right">
        <button
          type="button"
          className="data-controls__btn"
          data-testid="import-button"
          aria-label="Import notes"
          // The wizard stages everything server-side, so a guest gets the browser-local
          // path instead of a dialog that would fail on its first request.
          onClick={() => (guest ? setGuestImportOpen(true) : openImportWizard())}
        >
          <Icon name="upload" size={15} />
        </button>
      </Tooltip>

      <ExportModal open={exportOpen} onClose={() => setExportOpen(false)} />
      <GuestImportModal open={guestImportOpen} onClose={() => setGuestImportOpen(false)} />
    </div>
  );
}
