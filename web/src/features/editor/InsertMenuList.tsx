// InsertMenuList.tsx - the one list rendered by all three Insert surfaces (the "/" menu,
// the gutter "+" and the toolbar). Presentational and controlled: the parent owns the
// selected index (so the "/" plugin and the popover can each drive it their own way) and
// this component draws the sections, options and ARIA. useInsertNavigation packages the
// shared Arrow / Enter / Tab handling that both parents reuse.
import { useCallback, useEffect, useRef, useState } from 'react';
import Icon, { isIconName } from '../../components/Icon';
import { type InsertItem } from './insertables';

/** Arrow/Enter/Tab handling shared by the "/" menu and the "+"/toolbar popover. */
export function useInsertNavigation(items: InsertItem[], choose: (item: InsertItem) => void) {
  const [selected, setSelected] = useState(0);
  // Reset to the top whenever the result set changes (a new query), not on plain re-renders.
  useEffect(() => setSelected(0), [items]);
  const onKeyDown = useCallback(
    ({ event }: { event: KeyboardEvent }): boolean => {
      if (!items.length) return false;
      if (event.key === 'ArrowDown') {
        setSelected((i) => (i + 1) % items.length);
        return true;
      }
      if (event.key === 'ArrowUp') {
        setSelected((i) => (i - 1 + items.length) % items.length);
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const item = items[selected];
        if (item) choose(item);
        return true;
      }
      return false;
    },
    [items, selected, choose],
  );
  return { selected, setSelected, onKeyDown };
}

interface InsertMenuListProps {
  items: InsertItem[];
  selected: number;
  onHover: (index: number) => void;
  onChoose: (item: InsertItem) => void;
  /** Base id for the listbox and its option ids (drives aria-activedescendant on the parent). */
  listId: string;
  testId?: string;
  itemTestId?: string;
  emptyLabel?: string;
}

export default function InsertMenuList({
  items,
  selected,
  onHover,
  onChoose,
  listId,
  testId,
  itemTestId,
  emptyLabel = 'No matching blocks',
}: InsertMenuListProps) {
  const activeRef = useRef<HTMLButtonElement | null>(null);
  // Keep the keyboard selection in view as it moves through a scrolled list.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selected, items]);

  if (!items.length) {
    return (
      <div className="folio-insert-list folio-insert-empty" data-testid={testId}>
        {emptyLabel}
      </div>
    );
  }

  // Grouped in the order the items arrive rather than in a fixed section order. Unfiltered,
  // the catalog is already written section by section, so browsing looks exactly as before;
  // filtered, getInsertItems has ranked the results, and honouring that ranking is what puts
  // the best match first in the DOM - which is where the initial selection, and therefore
  // Enter, lands. Re-sorting into section order here would have quietly undone it.
  // A section takes its place from its best-ranked member, so the very first row rendered is
  // the best match overall; later matches join the group they belong to instead of opening a
  // second heading with the same name.
  const groups: { section: InsertItem['section']; rows: InsertItem[] }[] = [];
  for (const item of items) {
    const group = groups.find((g) => g.section === item.section);
    if (group) group.rows.push(item);
    else groups.push({ section: item.section, rows: [item] });
  }

  let flat = -1;
  return (
    <div className="folio-insert-list" id={listId} role="listbox" aria-label="Insert a block" data-testid={testId}>
      {groups.map((g) => (
        <div key={g.section} className="folio-insert-group" role="group" aria-label={g.section}>
          <div className="folio-insert-group-label">{g.section}</div>
          {g.rows.map((item) => {
            flat += 1;
            const idx = flat;
            const active = idx === selected;
            return (
              <button
                key={item.id}
                ref={active ? activeRef : undefined}
                id={`${listId}-opt-${idx}`}
                type="button"
                role="option"
                aria-selected={active}
                className={`folio-insert-item${active ? ' is-active' : ''}`}
                data-testid={itemTestId}
                onMouseEnter={() => onHover(idx)}
                // Keep focus where it is (editor / search field) so choosing still lands the insert.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onChoose(item)}
              >
                <span className="folio-insert-item-icon" aria-hidden="true">
                  {isIconName(item.icon) ? <Icon name={item.icon} size={16} /> : item.icon}
                </span>
                <span className="folio-insert-item-text">
                  <span className="folio-insert-item-title">{item.title}</span>
                  <span className="folio-insert-item-desc">{item.description}</span>
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
