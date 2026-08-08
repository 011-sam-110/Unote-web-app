// web-shell - generic dropdown menu (the "⋯" menus, "Import ▾", "Move to
// notebook" submenu, etc). Bespoke dual-panel positioning (menu + one level
// of submenu) rather than the shared useFloatingPanel hook, since it has to
// keep both panels open together and treat clicks inside either as "inside".
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { computePosition, offset, flip, shift, autoUpdate } from '@floating-ui/dom';
import Icon, { type IconName } from './Icon';

export interface MenuItemEntry {
  kind: 'item';
  key: string;
  label: string;
  icon?: IconName;
  /** Renders a small colored dot instead of an icon (palette rows). */
  colorDot?: string;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
  submenu?: MenuEntry[];
}
export interface MenuDividerEntry {
  kind: 'divider';
  key: string;
}
export interface MenuLabelEntry {
  kind: 'label';
  key: string;
  label: string;
}
export type MenuEntry = MenuItemEntry | MenuDividerEntry | MenuLabelEntry;

export function menuItem(item: Omit<MenuItemEntry, 'kind'>): MenuItemEntry {
  return { kind: 'item', ...item };
}
export function menuDivider(key: string): MenuDividerEntry {
  return { kind: 'divider', key };
}
export function menuLabel(key: string, label: string): MenuLabelEntry {
  return { kind: 'label', key, label };
}

export default function ContextMenu({
  trigger,
  items,
  align = 'start',
  triggerClassName = 'icon-btn',
  ariaLabel = 'Open menu',
  onOpenChange,
}: {
  trigger: ReactNode;
  items: MenuEntry[];
  align?: 'start' | 'end';
  triggerClassName?: string;
  ariaLabel?: string;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpenState] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [submenuKey, setSubmenuKey] = useState<string | null>(null);
  const [submenuPos, setSubmenuPos] = useState({ x: 0, y: 0 });

  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const submenuAnchorRef = useRef<HTMLElement | null>(null);
  const submenuRef = useRef<HTMLDivElement | null>(null);

  function setOpen(v: boolean) {
    setOpenState(v);
    onOpenChange?.(v);
    if (!v) setSubmenuKey(null);
  }

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      const t = e.target as Node;
      if (
        menuRef.current?.contains(t) ||
        submenuRef.current?.contains(t) ||
        btnRef.current?.contains(t)
      ) {
        return;
      }
      setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        btnRef.current?.focus();
      }
    }
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || !btnRef.current || !menuRef.current) return;
    return autoUpdate(btnRef.current, menuRef.current, () => {
      if (!btnRef.current || !menuRef.current) return;
      computePosition(btnRef.current, menuRef.current, {
        placement: align === 'end' ? 'bottom-end' : 'bottom-start',
        middleware: [offset(6), flip(), shift({ padding: 8 })],
      }).then(({ x, y }) => setPos({ x, y }));
    });
  }, [open, align]);

  useEffect(() => {
    if (!submenuKey || !submenuAnchorRef.current || !submenuRef.current) return;
    return autoUpdate(submenuAnchorRef.current, submenuRef.current, () => {
      if (!submenuAnchorRef.current || !submenuRef.current) return;
      computePosition(submenuAnchorRef.current, submenuRef.current, {
        placement: 'right-start',
        middleware: [offset(4), flip(), shift({ padding: 8 })],
      }).then(({ x, y }) => setSubmenuPos({ x, y }));
    });
  }, [submenuKey]);

  function select(entry: MenuItemEntry) {
    if (entry.disabled) return;
    entry.onSelect?.();
    setOpen(false);
  }

  function renderEntries(entries: MenuEntry[]) {
    return entries.map((entry) => {
      if (entry.kind === 'divider') return <div key={entry.key} className="folio-menu__divider" role="separator" />;
      if (entry.kind === 'label') return <div key={entry.key} className="folio-menu__label">{entry.label}</div>;
      const hasSubmenu = !!entry.submenu?.length;
      return (
        <button
          key={entry.key}
          type="button"
          role="menuitem"
          className={`folio-menu__item${entry.danger ? ' danger' : ''}${submenuKey === entry.key ? ' is-active' : ''}`}
          disabled={entry.disabled}
          onMouseEnter={(e) => {
            if (hasSubmenu) {
              submenuAnchorRef.current = e.currentTarget;
              setSubmenuKey(entry.key);
            } else if (submenuKey) {
              setSubmenuKey(null);
            }
          }}
          onClick={(e) => {
            e.stopPropagation();
            if (hasSubmenu) {
              submenuAnchorRef.current = e.currentTarget;
              // Open, never toggle. The pointer is by definition already hovering this
              // item, so onMouseEnter has just opened the submenu - a toggle here shut
              // it again on the way in, and "Color" looked like a dead menu item to
              // anyone who clicked it rather than hovering and sliding right.
              setSubmenuKey(entry.key);
              return;
            }
            select(entry);
          }}
        >
          {entry.colorDot ? (
            <span className="folio-menu__item-icon">
              <span className="chip-dot" style={{ background: entry.colorDot, width: 11, height: 11, display: 'inline-block', borderRadius: '50%' }} />
            </span>
          ) : entry.icon ? (
            <span className="folio-menu__item-icon">
              <Icon name={entry.icon} size={14} />
            </span>
          ) : null}
          <span>{entry.label}</span>
          {hasSubmenu && (
            <span className="folio-menu__item-arrow">
              <Icon name="chevron-right" size={13} />
            </span>
          )}
        </button>
      );
    });
  }

  const activeSubmenu = submenuKey
    ? (items.find((i) => i.kind === 'item' && i.key === submenuKey) as MenuItemEntry | undefined)?.submenu
    : undefined;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={triggerClassName}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
      >
        {trigger}
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            className="folio-menu"
            style={{ position: 'fixed', top: pos.y, left: pos.x }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {renderEntries(items)}
          </div>,
          document.body,
        )}
      {open &&
        activeSubmenu &&
        createPortal(
          <div
            ref={submenuRef}
            role="menu"
            className="folio-menu"
            style={{ position: 'fixed', top: submenuPos.y, left: submenuPos.x }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {renderEntries(activeSubmenu)}
          </div>,
          document.body,
        )}
    </>
  );
}
