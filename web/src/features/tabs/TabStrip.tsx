// The strip itself.
//
// It sits above the note's action bar rather than below it, which is not where it was
// first sketched. That bar belongs to a note - Insert, Outline, Comments, Ink, Find - and
// a Search or Study tab has nothing to sit under, so once every route gets a tab the
// strip has to be the outer chrome of the two.
import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from '../../components/Icon';
import HashGlyph from '../../components/HashGlyph';
import { useNotebooks } from '../../components/NotebooksContext';
import { routeMeta } from './routeMeta';
import { useTabs } from './TabsContext';
import TabMenu, { type TabMenuState } from './TabMenu';
import './tabs.css';

/** How far the pointer travels before a press becomes a drag rather than a click. */
const DRAG_SLOP = 6;

export default function TabStrip() {
  const tabs = useTabs();
  const { notebooks } = useNotebooks();
  const [menu, setMenu] = useState<TabMenuState | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  // Activating a tab that is scrolled out of the strip has to bring it into view, or the
  // command palette's "Next tab" appears to do nothing.
  useEffect(() => {
    stripRef.current
      ?.querySelector<HTMLElement>('[data-tab-active="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [tabs.activeId]);

  const drag = useRef<{ id: string; startX: number; moved: boolean } | null>(null);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>, id: string) {
    if (e.button !== 0) return;
    drag.current = { id, startX: e.clientX, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.abs(e.clientX - d.startX) < DRAG_SLOP) return;
    d.moved = true;

    // Reorder live rather than dragging a ghost: the strip is a single row of small
    // targets, so the tab under the pointer IS the drop position and a preview would only
    // say the same thing twice.
    const els = Array.from(stripRef.current?.querySelectorAll<HTMLElement>('[data-tab-id]') ?? []);
    const over = els.findIndex((el) => {
      const r = el.getBoundingClientRect();
      return e.clientX < r.left + r.width / 2;
    });
    const to = over < 0 ? els.length - 1 : over;
    tabs.move(d.id, to);
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>, id: string) {
    const d = drag.current;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!d || d.moved) return;
    tabs.activate(id);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>, id: string, index: number) {
    const els = Array.from(stripRef.current?.querySelectorAll<HTMLElement>('[data-tab-id]') ?? []);
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const next = els[(index + (e.key === 'ArrowRight' ? 1 : -1) + els.length) % els.length];
      next?.focus();
      const nextId = next?.dataset.tabId;
      if (nextId) tabs.activate(nextId);
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      tabs.activate(id);
      return;
    }
    // Delete closes the focused tab. Safe to bind here in a way Ctrl+W is not: it only
    // fires while a tab has keyboard focus, so it can never reach a note being written in.
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      tabs.close(id);
    }
  }

  function menuFor(id: string, e: React.MouseEvent) {
    e.preventDefault();
    const index = tabs.tabs.findIndex((t) => t.id === id);
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { key: 'close', label: 'Close', onSelect: () => tabs.close(id) },
        {
          key: 'others',
          label: 'Close others',
          disabled: tabs.tabs.length < 2,
          onSelect: () => tabs.closeOthers(id),
        },
        {
          key: 'right',
          label: 'Close to the right',
          disabled: index === tabs.tabs.length - 1,
          onSelect: () => tabs.closeToRight(id),
        },
        {
          key: 'copy',
          label: 'Copy link',
          onSelect: () => {
            const tab = tabs.tabs.find((t) => t.id === id);
            if (tab) void navigator.clipboard?.writeText(new URL(tab.path, window.location.origin).toString());
          },
        },
      ],
    });
  }

  return (
    <>
      <div className="folio-tabstrip" ref={stripRef} role="tablist" aria-label="Open tabs">
        {tabs.tabs.map((tab, index) => {
          const meta = routeMeta(tab.path, notebooks);
          const label = tab.label || meta.label;
          const dot = tab.dot ?? meta.dot;
          const active = tab.id === tabs.activeId;
          return (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              data-tab-active={active}
              className="folio-tab"
              role="tab"
              id={`folio-tab-${tab.id}`}
              aria-selected={active}
              aria-controls={`folio-tabpanel-${tab.id}`}
              // Roving tabindex: one stop for the whole strip, then arrow keys within it.
              tabIndex={active ? 0 : -1}
              title={label}
              onPointerDown={(e) => onPointerDown(e, tab.id)}
              onPointerMove={onPointerMove}
              onPointerUp={(e) => onPointerUp(e, tab.id)}
              onKeyDown={(e) => onKeyDown(e, tab.id, index)}
              onContextMenu={(e) => menuFor(tab.id, e)}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  tabs.close(tab.id);
                }
              }}
            >
              <span className="folio-tab__lead" aria-hidden="true">
                {dot ? (
                  <span className="folio-tab__dot" style={{ background: dot }} />
                ) : meta.hash ? (
                  <HashGlyph size={13} />
                ) : meta.icon ? (
                  <Icon name={meta.icon} size={13} />
                ) : null}
              </span>
              <span className="folio-tab__label">{label}</span>
              <button
                type="button"
                className="folio-tab__close"
                aria-label={`Close ${label}`}
                // Not a tab stop. A focusable control inside an element with an interactive
                // role is the nested-interactive problem NoteCard.tsx already documents, and
                // it would also put a second stop inside a strip whose whole point is one
                // stop plus arrow keys. Keyboard users close with Delete on the focused tab
                // (see onKeyDown); the pointer still has its button.
                tabIndex={-1}
                // The tab's own pointer handlers would otherwise read this as a press on
                // the tab and activate it on the way out.
                onPointerDown={(e) => e.stopPropagation()}
                onPointerUp={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  tabs.close(tab.id);
                }}
              >
                <Icon name="x" size={12} />
              </button>
            </div>
          );
        })}

        <button
          type="button"
          className="folio-tabstrip__add"
          aria-label="New tab"
          title="New tab"
          onClick={() => tabs.open('/', 'new')}
        >
          <Icon name="plus" size={14} />
        </button>
      </div>
      <TabMenu state={menu} onClose={closeMenu} />
    </>
  );
}
