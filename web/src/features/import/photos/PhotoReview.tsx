// The review screen for a bulk photo import: a contact sheet of every frame, grouped into the
// notes they are about to become.
//
// This screen is not optional and is not a confirmation dialog. Grouping is a GUESS - by capture
// time for free, or by one AI call - and a guess the user cannot inspect or correct is worse than
// no guess at all, because a wrong split becomes invisible until they find half a handout in the
// wrong note a week later. So every group states WHY it exists ("4 photos over 41s · 28 min gap
// before"), and every correction is one click.
import { useMemo, useState } from 'react';
import Icon from '../../../components/Icon';
import type { ImportItem, ImportGroupInput, NotebookLite } from '../../../lib/types';
import './photo-review.css';

export interface PhotoReviewProps {
  items: ImportItem[];
  notebooks: NotebookLite[];
  /** Which grouper produced the current arrangement - 'capture-time' | 'ai' | 'manual'. */
  grouper: string;
  /** True while a regroup request is in flight. */
  busy?: boolean;
  aiError?: string | null;
  ocrAvailable?: boolean;
  onRegroup: (groups: ImportGroupInput[], grouper: string) => void;
  /** Recompute the capture-time clustering from scratch (the free grouper). */
  onRegroupByTime: () => void;
  onRegroupWithAi: () => void;
  onCommit: (groups: ImportGroupInput[]) => void;
  onDiscard: () => void;
}

interface Group {
  key: string;
  title: string;
  rationale: string | null;
  notebookId: string | null;
  items: ImportItem[];
}

/** Rebuild the visible groups from the staged items. The server is the source of truth for
 *  grouping, so this derives rather than duplicating state that could drift out of step. */
function toGroups(items: ImportItem[]): Group[] {
  const byKey = new Map<string, Group>();
  const order: Group[] = [];
  for (const item of items) {
    if (item.status === 'committed' || item.status === 'rejected') continue;
    // A null groupKey means "its own note", so it gets a group of one keyed on the item itself.
    const key = item.groupKey ?? `solo-${item.id}`;
    let g = byKey.get(key);
    if (!g) {
      g = {
        key,
        title: item.title || 'Untitled note',
        rationale: item.rationale,
        notebookId: item.decidedNotebookId ?? item.suggestedNotebookId ?? null,
        items: [],
      };
      byKey.set(key, g);
      order.push(g);
    }
    g.items.push(item);
  }
  for (const g of order) {
    g.items.sort((a, b) => a.groupIndex - b.groupIndex || a.createdAt.localeCompare(b.createdAt));
    g.title = g.items[0]?.title || g.title;
    g.rationale = g.items[0]?.rationale ?? g.rationale;
  }
  return order;
}

function toInput(groups: Group[]): ImportGroupInput[] {
  return groups.map((g) => ({
    key: g.key,
    itemIds: g.items.map((i) => i.id),
    title: g.title,
    rationale: g.rationale ?? undefined,
    notebookId: g.notebookId,
  }));
}

function clockTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export default function PhotoReview({
  items,
  notebooks,
  grouper,
  busy = false,
  aiError = null,
  ocrAvailable = true,
  onRegroup,
  onRegroupByTime,
  onRegroupWithAi,
  onCommit,
  onDiscard,
}: PhotoReviewProps) {
  const serverGroups = useMemo(() => toGroups(items), [items]);
  /** Local edits layered over the server's arrangement; null means "nothing edited yet". */
  const [edited, setEdited] = useState<Group[] | null>(null);
  const [moving, setMoving] = useState<{ itemId: string; from: string } | null>(null);

  const groups = edited ?? serverGroups;
  const photoCount = groups.reduce((n, g) => n + g.items.length, 0);
  const noTextCount = groups.reduce((n, g) => n + g.items.filter((i) => !i.preview.trim()).length, 0);

  function update(next: Group[]) {
    // Drop groups whose last photo moved out, and renumber nothing else - order is positional.
    setEdited(next.filter((g) => g.items.length > 0));
  }

  function renameGroup(key: string, title: string) {
    update(groups.map((g) => (g.key === key ? { ...g, title } : g)));
  }

  function setGroupNotebook(key: string, notebookId: string | null) {
    update(groups.map((g) => (g.key === key ? { ...g, notebookId } : g)));
  }

  /** Notebook names for the footer count - a group with no choice lands in "Unsorted". */
  function notebookLabel(id: string | null): string {
    return notebooks.find((n) => n.id === id)?.name ?? 'Unsorted';
  }

  /** Split a group in two at the given page, so pages 3..n become a note of their own. */
  function splitAt(key: string, index: number) {
    const next: Group[] = [];
    for (const g of groups) {
      if (g.key !== key || index <= 0 || index >= g.items.length) {
        next.push(g);
        continue;
      }
      const head = g.items.slice(0, index);
      const tail = g.items.slice(index);
      next.push({ ...g, items: head, rationale: 'split by hand' });
      next.push({
        key: `split-${tail[0].id}`,
        title: tail[0].title || 'Untitled note',
        rationale: 'split by hand',
        notebookId: g.notebookId,
        items: tail,
      });
    }
    update(next);
  }

  /** Merge a group into the one before it - the fix for a gap the clustering read as a boundary. */
  function mergeUp(key: string) {
    const idx = groups.findIndex((g) => g.key === key);
    if (idx <= 0) return;
    const next = groups.slice();
    const prev = next[idx - 1];
    next[idx - 1] = { ...prev, items: [...prev.items, ...next[idx].items], rationale: 'merged by hand' };
    next.splice(idx, 1);
    update(next);
  }

  function moveTo(targetKey: string) {
    if (!moving) return;
    const { itemId, from } = moving;
    setMoving(null);
    if (from === targetKey) return;
    const item = groups.find((g) => g.key === from)?.items.find((i) => i.id === itemId);
    if (!item) return;
    update(
      groups.map((g) => {
        if (g.key === from) return { ...g, items: g.items.filter((i) => i.id !== itemId) };
        if (g.key === targetKey) return { ...g, items: [...g.items, item], rationale: 'moved by hand' };
        return g;
      }),
    );
  }

  function newGroupFrom(itemId: string, from: string) {
    const item = groups.find((g) => g.key === from)?.items.find((i) => i.id === itemId);
    if (!item) return;
    setMoving(null);
    update([
      ...groups.map((g) => (g.key === from ? { ...g, items: g.items.filter((i) => i.id !== itemId) } : g)),
      { key: `new-${item.id}`, title: item.title || 'Untitled note', rationale: 'pulled out by hand', notebookId: null, items: [item] },
    ]);
  }

  function saveArrangement() {
    onRegroup(toInput(groups), 'manual');
    setEdited(null);
  }

  return (
    <div className="pr-root">
      <div className="pr-bar">
        <div className="pr-bar-main">
          <h3 className="pr-h">
            {photoCount} photo{photoCount === 1 ? '' : 's'} → {groups.length} note{groups.length === 1 ? '' : 's'}
          </h3>
          <p className="pr-sub">
            {grouper === 'ai' ? 'Grouped with AI' : grouper === 'manual' ? 'Your grouping' : 'Grouped by when they were taken'}
            {noTextCount > 0 && ` · ${noTextCount} with no text`}
          </p>
        </div>
        <div className="pr-bar-actions">
          <div className="pr-seg" role="group" aria-label="How to group these photos">
            <button
              type="button"
              className={`pr-seg-btn${grouper !== 'ai' ? ' is-on' : ''}`}
              disabled={busy}
              onClick={() => { setEdited(null); onRegroupByTime(); }}
            >
              By time
            </button>
            <button
              type="button"
              className={`pr-seg-btn${grouper === 'ai' ? ' is-on' : ''}`}
              disabled={busy || photoCount < 2}
              onClick={() => { setEdited(null); onRegroupWithAi(); }}
              title="One AI call for the whole batch, over the text only"
            >
              With AI
            </button>
          </div>
        </div>
      </div>

      {!ocrAvailable && (
        <p className="pr-warn" role="status">
          <Icon name="alert-circle" size={14} />
          The text reader didn&apos;t load, so these are importing as pictures without text. They will still
          be saved, and grouping falls back to when each photo was taken.
        </p>
      )}
      {aiError && <p className="pr-warn is-err" role="alert"><Icon name="alert-circle" size={14} />{aiError}</p>}
      {edited && (
        <p className="pr-warn is-edit" role="status">
          <Icon name="pencil" size={14} />
          You&apos;ve changed the grouping.
          <button type="button" className="iw-btn iw-btn-primary pr-inline-btn" onClick={saveArrangement}>Save grouping</button>
          <button type="button" className="iw-btn pr-inline-btn" onClick={() => setEdited(null)}>Undo changes</button>
        </p>
      )}

      <div className="pr-groups">
        {groups.map((group, gi) => (
          <section className="pr-group" key={group.key} aria-label={group.title}>
            <header className="pr-group-head">
              <input
                className="pr-title"
                value={group.title}
                aria-label={`Title for note ${gi + 1}`}
                onChange={(e) => renameGroup(group.key, e.target.value)}
                placeholder="Untitled note"
              />
              <select
                className="pr-nb"
                value={group.notebookId ?? ''}
                aria-label={`Notebook for ${group.title}`}
                onChange={(e) => setGroupNotebook(group.key, e.target.value || null)}
              >
                <option value="">Unsorted</option>
                {notebooks.map((n) => (
                  <option key={n.id} value={n.id}>{n.name}</option>
                ))}
              </select>
              <span className="pr-count">{group.items.length} page{group.items.length === 1 ? '' : 's'}</span>
              {gi > 0 && (
                <button type="button" className="pr-link" onClick={() => mergeUp(group.key)}>
                  Merge into above
                </button>
              )}
            </header>

            {/* The reason the grouper drew this boundary. Stated plainly so a wrong guess is
                obvious at a glance rather than something the user has to reverse-engineer. */}
            {group.rationale && <p className="pr-why">{group.rationale}</p>}

            <ul className="pr-frames">
              {group.items.map((item, pi) => {
                const time = clockTime(item.capturedAt);
                const empty = !item.preview.trim();
                return (
                  <li className={`pr-frame${moving?.itemId === item.id ? ' is-moving' : ''}`} key={item.id}>
                    {item.imageUrl ? (
                      <img className="pr-plate" src={item.imageUrl} alt={`Page ${pi + 1}: ${item.originalName}`} loading="lazy" />
                    ) : (
                      <div className="pr-plate pr-plate--none" aria-hidden="true"><Icon name="camera" size={18} /></div>
                    )}
                    <div className="pr-cap">
                      <span className="pr-page">{pi + 1}</span>
                      <span className="pr-time">{time ?? 'no time'}</span>
                    </div>
                    {empty && <span className="pr-notext">no text</span>}
                    <div className="pr-frame-actions">
                      {moving?.itemId === item.id ? (
                        <button type="button" className="pr-link" onClick={() => setMoving(null)}>Cancel</button>
                      ) : (
                        <button type="button" className="pr-link" onClick={() => setMoving({ itemId: item.id, from: group.key })}>Move</button>
                      )}
                      {pi > 0 && !moving && (
                        <button type="button" className="pr-link" onClick={() => splitAt(group.key, pi)}>Split here</button>
                      )}
                      {moving?.itemId === item.id && (
                        <button type="button" className="pr-link" onClick={() => newGroupFrom(item.id, group.key)}>To new note</button>
                      )}
                    </div>
                  </li>
                );
              })}
              {moving && moving.from !== group.key && (
                <li className="pr-frame pr-frame--drop">
                  <button type="button" className="pr-drop" onClick={() => moveTo(group.key)}>
                    <Icon name="plus" size={16} />
                    <span>Move here</span>
                  </button>
                </li>
              )}
            </ul>
          </section>
        ))}
      </div>

      <footer className="pr-foot">
        <span className="pr-foot-status">
          {groups.length} note{groups.length === 1 ? '' : 's'} will be created in {
            new Set(groups.map((g) => notebookLabel(g.notebookId))).size
          } notebook{new Set(groups.map((g) => notebookLabel(g.notebookId))).size === 1 ? '' : 's'}
        </span>
        <div className="pr-foot-actions">
          <button type="button" className="iw-btn" onClick={onDiscard} disabled={busy}>Discard</button>
          <button
            type="button"
            className="iw-btn iw-btn-primary"
            disabled={busy || photoCount === 0}
            onClick={() => onCommit(toInput(groups))}
          >
            Create {groups.length} note{groups.length === 1 ? '' : 's'}
          </button>
        </div>
      </footer>
    </div>
  );
}
