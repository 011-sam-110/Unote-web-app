// Keyboard shortcut cheatsheet.
//
// Every binding listed here was read off the code that implements it, not off the
// spec - lib/useShortcuts.ts for the global chords, NotePage.tsx for the note-page
// window listener (Ctrl+S/F/H), SearchPage.tsx for "/", ReviewTab.tsx for the review
// keys, and TipTap's StarterKit defaults for the formatting marks. A cheatsheet that
// lists a shortcut which does not fire is worse than no cheatsheet.
import { useEffect, useState } from 'react';
import Modal from '../../components/Modal';
import { shortcutGroups } from '../editor/shortcutData';
import './onboarding.css';

/** Mac renders the real glyphs; everything else spells the modifiers out, because
 *  "⌘" on a Windows machine is just noise. */
function useIsMac(): boolean {
  const [isMac] = useState(() => /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent));
  return isMac;
}

export default function ShortcutsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const isMac = useIsMac();
  const mod = isMac ? '⌘' : 'Ctrl';
  const shift = isMac ? '⇧' : 'Shift';

  // Pressing "?" again while it is open closes it, so the same key toggles.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === '?') {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <Modal open={open} onClose={onClose} title="Keyboard shortcuts" width={640}>
      <div className="ks-sheet" data-testid="shortcuts-sheet">
        {shortcutGroups(mod, shift).map((group) => (
          <section className="ks-group" key={group.name}>
            <h3 className="ks-group__name">{group.name}</h3>
            <dl className="ks-list">
              {group.rows.map((row) => (
                <div className="ks-row" key={`${group.name}-${row.label}`}>
                  <dt className="ks-row__keys">
                    {row.keys.map((k, i) => (
                      <kbd key={`${k}-${i}`}>{k}</kbd>
                    ))}
                  </dt>
                  <dd className="ks-row__label">{row.label}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
