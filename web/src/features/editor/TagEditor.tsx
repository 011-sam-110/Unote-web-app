// The note header's tag editor - the missing authoring surface for tags.
//
// Before this existed the whole tag feature was write-only from the seed script:
// the server stored note_tags, PATCH /api/notes/:id accepted `tags`, search had a
// `tag:` operator and TagsPage browsed them, but nothing in the UI could put a tag
// on a note.
//
// Two kinds of chip are rendered side by side, and the difference matters:
//   • explicit chips - added here, removable here (they are this component's value)
//   • auto chips     - parsed from #hashtags in the note body (read-only here,
//                      because the body is their source of truth; offering an "×"
//                      that the next keystroke undoes would be a lie)
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import Icon from '../../components/Icon';
import HashGlyph from '../../components/HashGlyph';
import { loadTagVocabulary, normalizeTag, MAX_TAG_LENGTH, type TagCount } from '../../lib/tags';
import './tagEditor.css';

export interface TagEditorProps {
  /** Explicit chips - the editable value. */
  tags: string[];
  /** Tags discovered in the body as #hashtags; shown as read-only companions. */
  autoTags: string[];
  onChange: (next: string[]) => void;
  /** Open a tag's filtered view (chip body click). */
  onOpenTag: (tag: string) => void;
  /** Live word count, rendered as "N words · M min" at the right end of the row.
   *  Omitted (rather than shown as "0 words") while the note is still empty. */
  wordCount?: number;
}

const MAX_SUGGESTIONS = 7;

export default function TagEditor({ tags, autoTags, onChange, onOpenTag, wordCount = 0 }: TagEditorProps) {
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [vocabulary, setVocabulary] = useState<TagCount[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Vocabulary is fetched once per mount (cached module-level for a minute) rather
  // than per keystroke - the list is small and filtering it locally keeps the
  // suggestion popup instant.
  useEffect(() => {
    let alive = true;
    loadTagVocabulary()
      .then((v) => {
        if (alive) setVocabulary(v);
      })
      .catch(() => {
        // Autocomplete is a convenience; typing a tag by hand still works offline.
      });
    return () => {
      alive = false;
    };
  }, []);

  // Tags already on this note (either kind) are not worth suggesting again.
  const applied = useMemo(() => new Set([...tags, ...autoTags]), [tags, autoTags]);

  const suggestions = useMemo(() => {
    const q = normalizeTag(draft) ?? '';
    const pool = vocabulary.filter((v) => !applied.has(v.tag));
    if (!q) return pool.slice(0, MAX_SUGGESTIONS);
    // Prefix matches first - they are what the user is most likely reaching for -
    // then any other substring hit, each group keeping the server's count ordering.
    const prefix = pool.filter((v) => v.tag.startsWith(q));
    const rest = pool.filter((v) => !v.tag.startsWith(q) && v.tag.includes(q));
    return [...prefix, ...rest].slice(0, MAX_SUGGESTIONS);
  }, [draft, vocabulary, applied]);

  // Keep the highlighted row in range as the list narrows under the cursor.
  useEffect(() => {
    setActiveIndex(0);
  }, [draft]);

  // Click-away closes the popup. Bound only while it is open so the app isn't
  // carrying a document listener for every note the user opens.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  function commit(raw: string): boolean {
    const tag = normalizeTag(raw);
    setDraft('');
    if (!tag) return false;
    // A duplicate isn't an error worth shouting about - the tag is already there,
    // so clearing the input is the whole correct response.
    if (applied.has(tag)) return false;
    onChange([...tags, tag]);
    return true;
  }

  function removeAt(index: number) {
    onChange(tags.filter((_, i) => i !== index));
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
      // Tab only commits when there is something to commit, so an empty tag input
      // still tabs onward to the next control as expected.
      if (e.key === 'Tab' && !draft.trim() && activeIndex >= suggestions.length) return;
      const picked = open && suggestions[activeIndex] ? suggestions[activeIndex].tag : draft;
      if (!picked.trim()) return;
      e.preventDefault();
      commit(picked);
      setOpen(true);
      return;
    }
    if (e.key === 'Backspace' && draft === '' && tags.length > 0) {
      e.preventDefault();
      removeAt(tags.length - 1);
      return;
    }
    if (e.key === 'ArrowDown' && suggestions.length > 0) {
      e.preventDefault();
      setOpen(true);
      setActiveIndex((i) => (i + 1) % suggestions.length);
      return;
    }
    if (e.key === 'ArrowUp' && suggestions.length > 0) {
      e.preventDefault();
      setOpen(true);
      setActiveIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
      return;
    }
    if (e.key === 'Escape' && open) {
      // Swallowed only when the popup is open, so Esc keeps its usual meaning
      // (close the find bar, blur) the rest of the time.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  }

  return (
    <div className="folio-tags" ref={wrapRef} data-testid="tag-editor">
      <span className="folio-tags__icon" aria-hidden="true">
        <HashGlyph size={13} />
      </span>

      <ul className="folio-tags__list">
        {tags.map((tag, i) => (
          <li key={`t-${tag}`} className="folio-tag-chip">
            <button
              type="button"
              className="folio-tag-chip__label"
              onClick={() => onOpenTag(tag)}
              title={`Browse notes tagged #${tag}`}
            >
              #{tag}
            </button>
            <button
              type="button"
              className="folio-tag-chip__remove"
              onClick={() => removeAt(i)}
              aria-label={`Remove tag ${tag}`}
              title={`Remove #${tag}`}
            >
              <Icon name="x" size={11} />
            </button>
          </li>
        ))}

        {autoTags.map((tag) => (
          <li key={`a-${tag}`} className="folio-tag-chip folio-tag-chip--auto">
            <button
              type="button"
              className="folio-tag-chip__label"
              onClick={() => onOpenTag(tag)}
              title={`From #${tag} in the note body (edit the text to change it)`}
            >
              #{tag}
            </button>
          </li>
        ))}

        <li className="folio-tags__input-wrap">
          <input
            ref={inputRef}
            className="folio-tags__input"
            value={draft}
            maxLength={MAX_TAG_LENGTH + 8 /* headroom for the '#' and spaces we strip */}
            placeholder={tags.length + autoTags.length === 0 ? 'Add a tag…' : 'Add another…'}
            aria-label="Add a tag"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setDraft(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={handleKeyDown}
            onBlur={() => {
              // Commit a half-typed tag rather than silently discarding it - losing
              // work on a stray click is the worst outcome for a field like this.
              if (draft.trim()) commit(draft);
            }}
          />

          {/* Inside the input's own <li>, so the popup opens under the caret. Anchored to
              the row (its previous home) it opened under the CHIPS, a couple of hundred
              pixels to the left of where the user was typing. */}
          {open && suggestions.length > 0 && (
            <div className="folio-tags__menu" role="listbox" aria-label="Tag suggestions">
              {suggestions.map((s, i) => (
                <button
                  key={s.tag}
                  type="button"
                  role="option"
                  aria-selected={i === activeIndex}
                  className={`folio-tags__option${i === activeIndex ? ' is-active' : ''}`}
                  // pointerdown, not click: the input's blur would otherwise fire first
                  // and commit the raw draft before the click ever lands.
                  onPointerDown={(e) => {
                    e.preventDefault();
                    commit(s.tag);
                    inputRef.current?.focus();
                  }}
                  onMouseEnter={() => setActiveIndex(i)}
                >
                  <span className="folio-tags__option-name">#{s.tag}</span>
                  <span className="folio-tags__option-count">{s.count}</span>
                </button>
              ))}
            </div>
          )}
        </li>
      </ul>

      {/* 200 wpm is the usual silent-reading figure, and the minute is rounded UP so a
          40-word note reads "1 min" rather than "0 min". */}
      {wordCount > 0 && (
        <span className="folio-tags__stats">
          {wordCount.toLocaleString()} {wordCount === 1 ? 'word' : 'words'} ·{' '}
          {Math.max(1, Math.ceil(wordCount / 200))} min
        </span>
      )}
    </div>
  );
}
