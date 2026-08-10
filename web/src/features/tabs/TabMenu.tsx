// A menu that opens where the pointer is, rather than under a button.
//
// components/ContextMenu.tsx renders its own trigger and anchors to it, which is right for
// the "⋯" menus it was built for and wrong for a right-click: there is no button, and the
// menu belongs at the pointer. It reuses that component's markup and classes verbatim, so
// the two are the same menu to look at and only differ in what they hang off.
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface TabMenuItem {
  key: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}

export interface TabMenuState {
  x: number;
  y: number;
  items: TabMenuItem[];
}

/** Keeps the menu off the viewport edges without needing a measure-then-reposition pass. */
const EDGE = 8;
const EST_WIDTH = 190;

export default function TabMenu({ state, onClose }: { state: TabMenuState | null; onClose: () => void }): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!state) return;
    function onDown(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onClose);
    };
  }, [state, onClose]);

  useEffect(() => {
    if (state) ref.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
  }, [state]);

  if (!state) return null;

  const left = Math.min(state.x, window.innerWidth - EST_WIDTH - EDGE);
  const top = Math.min(state.y, window.innerHeight - state.items.length * 32 - EDGE);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="folio-menu"
      style={{ position: 'fixed', top: Math.max(EDGE, top), left: Math.max(EDGE, left), minWidth: EST_WIDTH }}
    >
      {state.items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="menuitem"
          className="folio-menu__item"
          disabled={item.disabled}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
        >
          <span>{item.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
