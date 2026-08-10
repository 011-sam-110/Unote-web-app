// web-shell - the signature was exactly { note, onClick }; `compact` and `controls` are
// additive optional props (backward compatible) so NotebookPage can render pin/⋯ controls
// without NoteCard knowing any business logic about pin/duplicate/move/delete itself.
//
// `href` was added with tabs, and every caller now passes it. The title was a <button>
// that called navigate(), which meant the commonest way to open a note in the whole app -
// clicking a card - was the one way that could not be Ctrl-clicked, middle-clicked, or
// opened in a new tab from the browser's own context menu. None of those are behaviours
// the app can add to a button; they belong to links. `onClick` stays for any caller that
// genuinely has somewhere else to go.
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { NoteLite } from '../lib/types';
import { plural, relativeTime } from '../lib/format';
import Icon from './Icon';

export default function NoteCard({
  note,
  href,
  onClick,
  compact = false,
  controls,
  testId,
}: {
  note: NoteLite;
  /** Where the card goes. Renders the title as a real link when given. */
  href?: string;
  onClick?: () => void;
  compact?: boolean;
  controls?: ReactNode;
  testId?: string;
}) {
  const isCanvas = note.kind === 'canvas';

  const title = (
    <>
      {isCanvas && (
        <span style={{ color: 'var(--accent)', display: 'inline-flex', marginRight: 6, verticalAlign: '-2px' }}>
          <Icon name="canvas" size={13} />
          <span className="folio-visually-hidden">Canvas: </span>
        </span>
      )}
      {note.title || (isCanvas ? 'Untitled canvas' : 'Untitled')}
    </>
  );

  // The card used to be a role="button" wrapper, but it also contains the pin/⋯
  // controls - a focusable descendant inside a button role, which is invalid
  // (axe: nested-interactive) and left screen-reader users with one opaque
  // "button" hiding two more. The card is now a plain container whose TITLE is
  // the real button; `.note-card__open::after` stretches that button's hit area
  // over the whole card, so pointer users keep click-anywhere behaviour while
  // the accessibility tree sees one clean control plus its sibling controls.
  return (
    <div className={`note-card${compact ? ' note-card--compact' : ''}`} data-testid={testId}>
      {!compact && (
        <div className="note-card__top">
          <span className="note-card__notebook-dot" style={{ background: note.notebook?.color }} />
          <span aria-hidden="true">{note.notebook?.emoji}</span>
          <span className="note-card__notebook-name">{note.notebook?.name}</span>
          {note.pinned && (
            <span className="note-card__pin">
              <Icon name="pin-filled" size={12} />
              <span className="folio-visually-hidden">Pinned</span>
            </span>
          )}
        </div>
      )}

      <div className="note-card__main">
        {/* Canvases and documents live in the same lists, so the kind has to be
            readable at a glance - otherwise "open it and find out" is the only
            way to tell them apart. */}
        {href ? (
          <Link to={href} className="note-card__title note-card__open" onClick={onClick}>
            {title}
          </Link>
        ) : (
          <button type="button" className="note-card__title note-card__open" onClick={onClick}>
            {title}
          </button>
        )}
        <div className="note-card__snippet">{note.snippet || (isCanvas ? 'Infinite board' : 'No content yet')}</div>
        <div className="note-card__meta">
          {compact && note.pinned && (
            // aria-label on a plain span is not reliably exposed (no role to carry
            // it); visually-hidden text always is.
            <span style={{ color: 'var(--accent)', display: 'inline-flex' }}>
              <Icon name="pin-filled" size={11} />
              <span className="folio-visually-hidden">Pinned</span>
            </span>
          )}
          <span>{relativeTime(note.updatedAt)}</span>
          {/* A word count on a board is meaningless - it is always zero. */}
          {!isCanvas && <span>{plural(note.wordCount, 'word')}</span>}
          {note.tags.length > 0 && (
            <span className="note-card__tags">
              {note.tags.slice(0, compact ? 3 : 2).map((t) => (
                <span key={t} className="tag-pill">#{t}</span>
              ))}
              {note.tags.length > (compact ? 3 : 2) && (
                <span className="tag-pill">+{note.tags.length - (compact ? 3 : 2)}</span>
              )}
            </span>
          )}
        </div>
      </div>

      {/* No stopPropagation needed any more: the card itself is no longer a click
          target, so these controls cannot bubble into an "open note" action. */}
      {controls && <div className="note-card__controls">{controls}</div>}
    </div>
  );
}
