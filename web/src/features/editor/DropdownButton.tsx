// Small self-contained anchored dropdown used by the note action bar (AI ▾, Import ▾).
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

export interface DropdownButtonProps {
  label: ReactNode;
  disabled?: boolean;
  align?: 'left' | 'right';
  children: (close: () => void) => ReactNode;
}

export default function DropdownButton({ label, disabled, align = 'left', children }: DropdownButtonProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  // A menu that scrolls opens on its ticked entry - the font size menu is seventeen rows
  // in a box that shows nine, and "you are at 28" is no help below the fold. The menu's
  // own scrollTop, not scrollIntoView, which would also scroll the note behind it.
  useEffect(() => {
    const menu = menuRef.current;
    if (!open || !menu) return;
    const ticked = menu.querySelector<HTMLElement>('[aria-checked="true"]');
    if (!ticked || menu.scrollHeight <= menu.clientHeight) return;
    menu.scrollTop = ticked.offsetTop - (menu.clientHeight - ticked.offsetHeight) / 2;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        // Escape must hand focus back to the trigger, otherwise a keyboard user is
        // dropped at the top of the document with no way back to where they were.
        triggerRef.current?.focus();
      }
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="folio-dropdown" ref={ref}>
      <button
        ref={triggerRef}
        type="button"
        className="folio-btn"
        disabled={disabled}
        // "true" (a generic popup), NOT "menu": the panel holds ordinary buttons
        // with no roving-tabindex arrow navigation, and claiming role="menu" over
        // plain buttons is an invalid parent/child pairing (aria-required-children).
        // As a plain group these are fully Tab-operable and announce accurately.
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
        {/* Decorative: the chevron says "this opens a menu", which the menu itself
            already conveys. Left exposed it became part of the accessible name, so
            this button announced as "AI down-triangle" rather than "AI". */}
        <span aria-hidden="true"> ▾</span>
      </button>
      {open && (
        <div id={menuId} ref={menuRef} className={`folio-dropdown-menu folio-dropdown-${align}`}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
