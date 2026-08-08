// search-tags agent - tag browser: a sized pill grid of every tag in use,
// multi-select filtering (intersection) of an inline note list, and a
// "search notes →" escape hatch into the full search page's tag: operator.
//
// The selection lives in the URL (?tag=a&tag=b) so a tag view is shareable, works
// with the back button, and - the reason it was moved out of local state - can be
// linked to from a note's tag chips (NotePage → /tags?tag=x).
//
// Each pill also carries a manage affordance: rename across all notes, merge into
// another tag, or remove from all notes.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import type { NoteLite } from '../lib/types';
import { errorMessage, plural } from '../lib/format';
import { invalidateTagVocabulary, normalizeTag, normalizeTags, MAX_TAG_LENGTH } from '../lib/tags';
import { toast } from '../components/Toast';
import NoteCard from '../components/NoteCard';
import EmptyState from '../components/EmptyState';
import Skeleton from '../components/Skeleton';
import Modal from '../components/Modal';
import Icon from '../components/Icon';
import './TagsPage.css';

interface TagCount {
  tag: string;
  count: number;
}

export default function TagsPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [tags, setTags] = useState<TagCount[] | null>(null);
  const [tagsLoading, setTagsLoading] = useState(true);
  const [tagsError, setTagsError] = useState<string | null>(null);

  const [notes, setNotes] = useState<NoteLite[] | null>(null);
  const [notesLoading, setNotesLoading] = useState(false);
  const [notesError, setNotesError] = useState<string | null>(null);

  const [managing, setManaging] = useState<string | null>(null);

  // Normalised on the way in so a hand-typed or stale ?tag=Week1 still matches the
  // lowercase vocabulary the server stores.
  const selected = useMemo(() => normalizeTags(searchParams.getAll('tag')), [searchParams]);
  const selectedKey = selected.join(',');

  const setSelected = useCallback(
    (next: string[]) => {
      const p = new URLSearchParams();
      for (const t of next) p.append('tag', t);
      // replace: browsing pill after pill shouldn't bury the previous page under a
      // dozen history entries.
      setSearchParams(p, { replace: true });
    },
    [setSearchParams],
  );

  const loadTags = useCallback(() => {
    setTagsLoading(true);
    setTagsError(null);
    api
      .tags()
      .then((res) => setTags(res.tags))
      .catch((e) => setTagsError(errorMessage(e, 'Could not load tags')))
      .finally(() => setTagsLoading(false));
  }, []);

  useEffect(() => {
    loadTags();
  }, [loadTags]);

  // Multi-select = intersection: fetch by the first selected tag (server-side
  // filter, cheap), then narrow further client-side for any additional tags -
  // a note must carry ALL selected tags to stay in the list.
  useEffect(() => {
    const list = selectedKey ? selectedKey.split(',') : [];
    if (list.length === 0) {
      setNotes(null);
      setNotesError(null);
      return;
    }
    const [first, ...rest] = list;
    setNotesLoading(true);
    setNotesError(null);
    api
      .notes({ tag: first, limit: 200, sort: 'updated' })
      .then((res) => {
        const filtered = rest.length ? res.notes.filter((n) => rest.every((t) => n.tags.includes(t))) : res.notes;
        setNotes(filtered);
      })
      .catch((e) => setNotesError(errorMessage(e, 'Could not load notes')))
      .finally(() => setNotesLoading(false));
  }, [selectedKey]);

  function toggleTag(tag: string) {
    setSelected(selected.includes(tag) ? selected.filter((t) => t !== tag) : [...selected, tag]);
  }

  /** After a rename/merge/delete: refresh the cloud, drop the editor's autocomplete
   *  cache, and carry the current filter across to whatever the tag became. */
  function afterManage(previous: string, replacement: string | null) {
    invalidateTagVocabulary();
    loadTags();
    setManaging(null);
    if (!selected.includes(previous)) return;
    const next = selected.filter((t) => t !== previous);
    if (replacement && !next.includes(replacement)) next.push(replacement);
    setSelected(next);
  }

  const { minCount, maxCount } = useMemo(() => {
    if (!tags || tags.length === 0) return { minCount: 0, maxCount: 0 };
    const counts = tags.map((t) => t.count);
    return { minCount: Math.min(...counts), maxCount: Math.max(...counts) };
  }, [tags]);

  function sizeFor(count: number): number {
    if (maxCount === minCount) return 14;
    const t = (count - minCount) / (maxCount - minCount);
    return 13 + t * 6; // 13px .. 19px - a gentle "cloud" without a handful of tags towering over the rest
  }

  const managingTag = tags?.find((t) => t.tag === managing) ?? null;

  return (
    <div className="tg-page">
      <div className="tg-page__crumb">Tags</div>
      {/* The heading states the size of the collection rather than naming the page - the
          caption above it already says "Tags", so "Browse by tag" was the same word twice. */}
      <div className="tg-page__header">
        <h1 className="tg-page__title">
          {tags && tags.length > 0 ? `${plural(tags.length, 'tag')} across your notes` : 'Tags'}
        </h1>
      </div>
      <p className="tg-page__lead">
        Rename or merge a tag and every note follows. Tags typed as #hashtags in a note body keep their
        own source of truth.
      </p>

      {tagsLoading ? (
        <div className="tg-cloud">
          {Array.from({ length: 10 }, (_, i) => (
            <div key={i} className="tg-row tg-row--skeleton" style={{ width: 120 + (i % 4) * 30 }}>
              <Skeleton lines={1} />
            </div>
          ))}
        </div>
      ) : tagsError ? (
        <EmptyState
          icon="⚠️"
          title="Couldn't load tags"
          hint={tagsError}
          action={
            <button type="button" className="btn btn-primary" onClick={loadTags}>
              Retry
            </button>
          }
        />
      ) : !tags || tags.length === 0 ? (
        <EmptyState
          icon="🏷️"
          title="No tags yet"
          hint="Open a note and add a tag under its title, or just type #revision anywhere in the body. Either way it shows up here as a filterable pill."
          action={
            <button type="button" className="btn btn-primary" onClick={() => navigate('/')}>
              Go to your notes
            </button>
          }
        />
      ) : (
        <>
          <div className="tg-cloud" role="group" aria-label="Filter by tag">
            {tags.map(({ tag, count }) => {
              const active = selected.includes(tag);
              return (
                <div className={`tg-row${active ? ' is-active' : ''}`} key={tag}>
                  <button
                    type="button"
                    className="tg-row__toggle"
                    aria-pressed={active}
                    onClick={() => toggleTag(tag)}
                  >
                    <span className="tg-row__name" style={{ fontSize: sizeFor(count) }}>
                      #{tag}
                    </span>
                    <span className="tg-row__count">{count}</span>
                  </button>
                  <Link
                    className="tg-row__icon-btn"
                    to={`/search?q=${encodeURIComponent(`tag:${tag}`)}`}
                    aria-label={`Search notes tagged ${tag}`}
                    title="Search notes →"
                  >
                    <Icon name="search" size={12} />
                  </Link>
                  <button
                    type="button"
                    className="tg-row__icon-btn"
                    onClick={() => setManaging(tag)}
                    aria-label={`Manage tag ${tag}`}
                    title="Rename, merge or delete →"
                  >
                    <Icon name="pencil" size={12} />
                  </button>
                </div>
              );
            })}
          </div>

          {selected.length > 0 && (
            <div className="tg-active-filters">
              <span className="tg-active-filters__label">Filtered by</span>
              {selected.map((t) => (
                <button key={t} type="button" className="chip active" onClick={() => toggleTag(t)}>
                  #{t} <Icon name="x" size={11} />
                </button>
              ))}
              <button type="button" className="tg-clear" onClick={() => setSelected([])}>
                Clear
              </button>
            </div>
          )}

          <div className="tg-results">
            {selected.length === 0 ? (
              <EmptyState
                icon="👆"
                title="Pick a tag to see its notes"
                hint="Select one or more pills above. With more than one, only notes carrying every selected tag are shown."
              />
            ) : notesLoading ? (
              <div className="note-list">
                {Array.from({ length: 3 }, (_, i) => (
                  <div key={i} style={{ border: '1px solid var(--line)', borderRadius: 'var(--radius-lg)', padding: '12px 14px' }}>
                    <Skeleton lines={2} />
                  </div>
                ))}
              </div>
            ) : notesError ? (
              <EmptyState
                icon="⚠️"
                title="Couldn't load notes"
                hint={notesError}
                action={
                  <button type="button" className="btn btn-primary" onClick={() => setSelected([...selected])}>
                    Retry
                  </button>
                }
              />
            ) : !notes || notes.length === 0 ? (
              <EmptyState
                icon="🔎"
                title="No notes have all of these tags"
                hint="Try removing one of the selected tags."
                action={
                  selected.length > 1 ? (
                    <button type="button" className="btn btn-secondary" onClick={() => setSelected([selected[0]])}>
                      Keep only #{selected[0]}
                    </button>
                  ) : (
                    <button type="button" className="btn btn-secondary" onClick={() => setSelected([])}>
                      Clear filter
                    </button>
                  )
                }
              />
            ) : (
              <div className="note-list">
                {notes.map((n) => (
                  <NoteCard key={n.id} note={n} compact testId="note-row" onClick={() => navigate(`/note/${n.id}`)} />
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {managingTag && (
        <ManageTagDialog
          tag={managingTag}
          allTags={tags ?? []}
          onClose={() => setManaging(null)}
          onDone={afterManage}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Manage dialog
// ---------------------------------------------------------------------------

interface ManageTagDialogProps {
  tag: TagCount;
  allTags: TagCount[];
  onClose: () => void;
  /** (previousTag, replacementTag | null) - null means it was deleted outright. */
  onDone: (previous: string, replacement: string | null) => void;
}

function ManageTagDialog({ tag, allTags, onClose, onDone }: ManageTagDialogProps) {
  const [renameTo, setRenameTo] = useState(tag.tag);
  const [mergeInto, setMergeInto] = useState('');
  const [busy, setBusy] = useState<'rename' | 'merge' | 'delete' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const others = useMemo(() => allTags.filter((t) => t.tag !== tag.tag), [allTags, tag.tag]);
  const renameNormalized = normalizeTag(renameTo);
  const renameChanged = !!renameNormalized && renameNormalized !== tag.tag;
  // Renaming onto a tag that already exists is a merge - say so rather than letting
  // the note count quietly change under the user.
  const renameCollides = !!renameNormalized && others.some((t) => t.tag === renameNormalized);

  async function run(kind: 'rename' | 'merge' | 'delete', fn: () => Promise<unknown>, done: () => void) {
    setBusy(kind);
    try {
      await fn();
      done();
    } catch (e) {
      toast(errorMessage(e, 'That didn’t work, nothing was changed'), 'error');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal open onClose={onClose} title={`Manage #${tag.tag}`} width={460}>
      <div className="tg-manage">
        <p className="tg-manage__lead">
          On {plural(tag.count, 'note')}. Changes here apply to every note carrying this tag, including archived ones.
        </p>

        {/* --- rename --- */}
        <section className="tg-manage__section">
          <label className="field-label" htmlFor="tg-rename">
            Rename
          </label>
          <div className="tg-manage__row">
            <input
              id="tg-rename"
              className="text-input tg-manage__input"
              value={renameTo}
              maxLength={MAX_TAG_LENGTH + 8}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setRenameTo(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && renameChanged && !busy) {
                  e.preventDefault();
                  void run(
                    'rename',
                    () => api.renameTag(tag.tag, renameNormalized),
                    () => {
                      toast(`Renamed to #${renameNormalized}`, 'ok');
                      onDone(tag.tag, renameNormalized);
                    },
                  );
                }
              }}
            />
            <button
              type="button"
              className="btn btn-primary"
              disabled={!renameChanged || busy !== null}
              onClick={() =>
                void run(
                  'rename',
                  () => api.renameTag(tag.tag, renameNormalized as string),
                  () => {
                    toast(`Renamed to #${renameNormalized}`, 'ok');
                    onDone(tag.tag, renameNormalized as string);
                  },
                )
              }
            >
              {busy === 'rename' ? 'Renaming…' : 'Rename'}
            </button>
          </div>
          {renameNormalized && renameNormalized !== renameTo.trim().replace(/^#/, '') && (
            <p className="tg-manage__hint">Will be saved as #{renameNormalized}</p>
          )}
          {renameCollides && (
            <p className="tg-manage__hint tg-manage__hint--warn">
              #{renameNormalized} already exists, so the two will be merged.
            </p>
          )}
        </section>

        {/* --- merge --- */}
        {others.length > 0 && (
          <section className="tg-manage__section">
            <label className="field-label" htmlFor="tg-merge">
              Merge into another tag
            </label>
            <div className="tg-manage__row">
              <select
                id="tg-merge"
                className="select-input tg-manage__input"
                value={mergeInto}
                onChange={(e) => setMergeInto(e.target.value)}
              >
                <option value="">Choose a tag…</option>
                {others.map((t) => (
                  <option key={t.tag} value={t.tag}>
                    #{t.tag} ({t.count})
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={!mergeInto || busy !== null}
                onClick={() =>
                  void run(
                    'merge',
                    () => api.mergeTags([tag.tag], mergeInto),
                    () => {
                      toast(`#${tag.tag} merged into #${mergeInto}`, 'ok');
                      onDone(tag.tag, mergeInto);
                    },
                  )
                }
              >
                {busy === 'merge' ? 'Merging…' : 'Merge'}
              </button>
            </div>
            {/* Named the destination or nothing: the hint used to render "gets #… instead"
                before a target was chosen, which reads as a tag literally called "…". */}
            <p className="tg-manage__hint">
              {mergeInto
                ? `Every note tagged #${tag.tag} gets #${mergeInto} instead. #${tag.tag} disappears.`
                : `Pick a tag above and every note tagged #${tag.tag} moves onto it. #${tag.tag} disappears.`}
            </p>
          </section>
        )}

        {/* --- delete --- */}
        <section className="tg-manage__section tg-manage__section--danger">
          <label className="field-label">Remove from all notes</label>
          {!confirmDelete ? (
            <button type="button" className="btn btn-danger" disabled={busy !== null} onClick={() => setConfirmDelete(true)}>
              <Icon name="trash" size={13} /> Delete #{tag.tag}
            </button>
          ) : (
            // Inline two-step rather than a nested ConfirmDialog - stacking a second
            // modal over this one would double the scrim and steal the focus trap.
            <div className="tg-manage__confirm">
              <span>Remove #{tag.tag} from {plural(tag.count, 'note')}? The notes themselves are kept.</span>
              <div className="tg-manage__row">
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={busy !== null}
                  onClick={() =>
                    void run(
                      'delete',
                      () => api.deleteTag(tag.tag),
                      () => {
                        toast(`#${tag.tag} removed from every note`, 'ok');
                        onDone(tag.tag, null);
                      },
                    )
                  }
                >
                  {busy === 'delete' ? 'Deleting…' : 'Yes, delete'}
                </button>
                <button type="button" className="btn btn-secondary" disabled={busy !== null} onClick={() => setConfirmDelete(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </section>

        <p className="tg-manage__footnote">
          Tags typed straight into a note as <code>#{tag.tag}</code> live in that note&rsquo;s text. Renaming or deleting
          here updates the tag list, but the words in the body stay as they were. Edit those notes to change them for good.
        </p>
      </div>
    </Modal>
  );
}
