// The note page's action bar. Extracted from NotePage.tsx, which had grown to ~925
// lines with this bar's twelve flat, ungrouped controls inline in the middle of it.
//
// The bar is organised into three zones, left to right, because the twelve controls
// were not twelve equal things:
//
//   Write   - what you reach for constantly while writing (Insert).
//   Panels  - a segmented control of side surfaces you TOGGLE (Outline, Comments,
//             Ink, Find, AI). These are stateful, so they read as one group of
//             switches rather than five unrelated buttons, and each carries
//             aria-pressed so the on/off state is exposed, not just coloured.
//
// The `✦ AI ▾` dropdown that used to sit beside Insert is GONE. Everything in it
// (Improve writing, Clean up formatting, Find missing content from uploads, Generate
// flashcards, Choose what to check…) moved into the AI panel, which is the same surface
// the review itself renders in - see AssistantPanel.tsx. A menu whose every item opened
// a right-hand panel was a layer of hiding in front of that panel. Summarise and Suggest
// a title stay in `⋯ More`: they insert a callout / retitle rather than proposing changes
// to the body, so they are note actions rather than AI-panel work.
//   Actions - things you do to the note as an object (Share, and the rarities behind
//             `⋯ More`), plus the autosave chip. Export .md and History are used once
//             a week; they no longer sit at the same visual weight as Insert.
//
// Every control has a visible text label. Pin, Comments, Ink and Note info were
// icon-only, which meant four of the twelve controls could only be identified by
// hovering. Their titles and aria-labels are preserved on top of the new labels.
//
// State stays in NotePage (it owns the note, autosave and every panel flag); this
// component is passed the values and callbacks and renders them.
import type { ReactNode, RefObject } from 'react';
import Icon from '../../components/Icon';
import { plural, formatDate } from '../../lib/format';
import DropdownButton from './DropdownButton';
import ShareButton from '../share/ShareButton';
import type { Note } from '../../lib/types';
import type { SaveStatus } from './useAutosave';

export interface NoteActionBarProps {
  note: Note;
  /** The LIVE title (NotePage's input state), not note.title - the share dialog and
   *  link copy should say what the user has typed, not what was last persisted. */
  title: string;
  wordCount: number;
  charCount: number;
  backlinkCount: number;

  // --- Write zone ---
  insertButtonRef: RefObject<HTMLButtonElement | null>;
  insertMenuOpen: boolean;
  onToggleInsertMenu: () => void;

  /** Availability, not preference - see lib/aiStatus. Gates the AI panel toggle AND the
   *  AI items inside More: with no reachable gateway they would be live-looking controls
   *  that always fail. */
  aiOn: boolean;
  /** Non-null while an AI call is in flight; the More menu's AI items reflect it. */
  aiBusy: string | null;
  onSummarize: (close: () => void) => void;
  onSuggestTitle: (close: () => void) => void;

  // --- Panels zone (all toggles) ---
  outlineOpen: boolean;
  onToggleOutline: () => void;
  commentsOpen: boolean;
  onToggleComments: () => void;
  unresolvedComments: number;
  inkOpen: boolean;
  onToggleInk: () => void;
  findOpen: boolean;
  onToggleFind: () => void;
  assistantOpen: boolean;
  onToggleAssistant: () => void;

  /** True while the writing column is held to a book measure instead of filling the page.
   *  A view preference rather than a panel, so it lives in More rather than the toggle row. */
  focusedWidth: boolean;
  onToggleWidth: () => void;

  // --- Note actions zone ---
  onOpenHistory: () => void;
  onImport: (kind: 'photo' | 'slides' | 'transcript', close: () => void) => void;
  onExport: () => void;
  onTogglePin: () => void;
  infoOpen: boolean;
  onToggleInfo: () => void;

  // --- Autosave chip ---
  saveStatus: SaveStatus;
  savedLabel: string;
  onRetrySave: () => void;
}

export default function NoteActionBar(props: NoteActionBarProps) {
  const {
    note,
    title,
    wordCount,
    charCount,
    backlinkCount,
    insertButtonRef,
    insertMenuOpen,
    onToggleInsertMenu,
    aiOn,
    aiBusy,
    onSummarize,
    onSuggestTitle,
    outlineOpen,
    onToggleOutline,
    commentsOpen,
    onToggleComments,
    unresolvedComments,
    inkOpen,
    onToggleInk,
    findOpen,
    onToggleFind,
    assistantOpen,
    onToggleAssistant,
    focusedWidth,
    onToggleWidth,
    onOpenHistory,
    onImport,
    onExport,
    onTogglePin,
    infoOpen,
    onToggleInfo,
    saveStatus,
    savedLabel,
    onRetrySave,
  } = props;

  // "Find missing content from uploads" compares the note against the source files it was
  // built from, so with nothing uploaded there is nothing to compare against.

  return (
    <div className="folio-action-bar">
      {/* ---------- Write: the two things you reach for while writing ---------- */}
      <div className="folio-action-zone">
        {/* Insert is the single most-used control on the page and the only filled
            button in the bar - it is the bar's one primary action. */}
        <button
          ref={insertButtonRef}
          type="button"
          className={'folio-btn-primary folio-action-insert' + (insertMenuOpen ? ' is-open' : '')}
          aria-haspopup="menu"
          aria-expanded={insertMenuOpen}
          onClick={onToggleInsertMenu}
        >
          <Icon name="plus" size={14} /> Insert
          <span aria-hidden="true"> ▾</span>
        </button>

        {/* There is deliberately no AI button here. Every AI action - improve, clean,
            find gaps from uploads, flashcards, and the check picker - now lives inside
            the AI panel, reached from the Panels segment below. A menu you pull down and
            lose is the wrong shape for something you converse with. */}
      </div>

      {/* ---------- Panels: one segmented control of side-surface toggles ----------
          Grouped into a single bordered pill with hairline dividers because these five
          share a behaviour (each opens/closes a surface beside the note) that five
          separate buttons in a flat row did nothing to convey. */}
      <div className="folio-segmented" role="group" aria-label="Note panels">
        {/* The outline rail is a ≥1280px affordance (see .folio-outline in
            notePage.css) - the toggle governs whether it renders at all, the media
            query still governs whether there is room to show it. */}
        <SegButton
          on={outlineOpen}
          onClick={onToggleOutline}
          title={outlineOpen ? 'Hide the outline rail' : 'Show the outline rail'}
        >
          Outline
        </SegButton>

        <SegButton on={commentsOpen} onClick={onToggleComments} title="Comments" ariaLabel="Comments">
          Comments
          {unresolvedComments > 0 && <span className="folio-comments-badge">{unresolvedComments}</span>}
        </SegButton>

        {/* The aria-label leads with the visible word so the accessible name still
            contains the label a speech-input user would say (WCAG 2.5.3), while
            keeping the longer explanation this control has always carried. */}
        <SegButton
          on={inkOpen}
          onClick={onToggleInk}
          title={inkOpen ? 'Close the ink layer' : 'Annotate with a pen or Apple Pencil'}
          ariaLabel={inkOpen ? 'Ink: close the ink layer' : 'Ink: annotate with a pen or Apple Pencil'}
        >
          Ink
        </SegButton>

        <SegButton on={findOpen} onClick={onToggleFind} title="Find in note (Ctrl+F)">
          Find
        </SegButton>

        {/* The assistant is a side panel you keep open while you work, so it belongs
            with the other panel toggles rather than among the AI transforms - those
            change the document, this one only answers questions about it. Gated on
            aiOn for the same reason the AI menu is. */}
        {aiOn && (
          <SegButton
            on={assistantOpen}
            onClick={onToggleAssistant}
            title="Ask a question about this note"
            testId="assistant-open"
          >
            <Icon name="sparkles" size={12} />
            Assistant
          </SegButton>
        )}
      </div>

      {/* Collapses to nothing when the bar is crowded (flex-basis 0), so it pushes the
          note actions right without ever forcing a wrap of its own. */}
      <div className="folio-action-spacer" aria-hidden="true" />

      {/* ---------- Note actions: the note as an object ---------- */}
      <div className="folio-action-zone">
        <ShareButton noteId={note.id} noteTitle={title} kind={note.kind} />

        <DropdownButton
          align="right"
          label={
            <>
              <Icon name="more" size={14} /> More
            </>
          }
        >
          {(close) => (
            <>
              {/* Every item in this group carries an icon so the labels line up in one
                  column - a half-iconed list reads as two ragged columns. */}
              <MenuGroup label="This note">
                <button type="button" onClick={() => { close(); onOpenHistory(); }}>
                  <Icon name="rotate-ccw" size={14} /> History
                </button>
                <button type="button" onClick={() => { close(); onExport(); }}>
                  <Icon name="download" size={14} /> Export .md
                </button>
                <button
                  type="button"
                  title={note.pinned ? 'Unpin' : 'Pin'}
                  aria-label={note.pinned ? 'Unpin' : 'Pin'}
                  onClick={() => { close(); onTogglePin(); }}
                >
                  <Icon name={note.pinned ? 'pin-filled' : 'pin'} size={14} />
                  {note.pinned ? 'Unpin' : 'Pin'}
                </button>
                {/* Note info expands in place instead of opening a second floating
                    layer over the first. The menu is already a popover; stacking a
                    popover on a popover to show four read-only lines is not worth it. */}
                <button
                  type="button"
                  aria-label="Note info"
                  aria-expanded={infoOpen}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleInfo();
                  }}
                >
                  <Icon name="info" size={14} /> Note info
                </button>
                {infoOpen && (
                  <div className="folio-menu-info">
                    <div>
                      {plural(wordCount, 'word')} · {plural(charCount, 'character')}
                    </div>
                    <div>Created {formatDate(note.createdAt)}</div>
                    <div>Updated {formatDate(note.updatedAt)}</div>
                    <div>{plural(backlinkCount, 'backlink')}</div>
                  </div>
                )}
              </MenuGroup>

              {/* The note fills the page by default. This puts the old book measure back
                  for anyone who finds a 1500px line hard to read, and it is a property of
                  the reader, not of this note - it applies to every note they open. It
                  sits in More rather than the toggle row because it changes how the page
                  is read rather than opening a panel. */}
              <MenuGroup label="View">
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={focusedWidth}
                  onClick={() => { close(); onToggleWidth(); }}
                >
                  <Icon name="maximize" size={14} /> Focused width
                  {focusedWidth && (
                    <span className="folio-menu-item__check" aria-hidden="true">
                      <Icon name="check" size={14} />
                    </span>
                  )}
                </button>
              </MenuGroup>

              {/* Both go through the same one-at-a-time AI queue as the AI menu, so
                  they disable while a call is in flight - the AI menu's own trigger
                  already does that for itself, and firing a second request from here
                  would race the first. Summarise lives here rather than in the AI menu
                  because it inserts a callout instead of rewriting the text; Suggest a
                  title touches the title, not the body. */}
              {aiOn && (
                <MenuGroup label="AI">
                  <button type="button" disabled={!!aiBusy} onClick={() => onSummarize(close)}>
                    Summarise
                  </button>
                  <button type="button" disabled={!!aiBusy} onClick={() => onSuggestTitle(close)}>
                    Suggest a title
                  </button>
                </MenuGroup>
              )}

              {/* The three import kinds keep their own labels; the group heading supplies
                  the "into note" that the old standalone dropdown's trigger carried. */}
              <MenuGroup label="Import into note">
                <button type="button" onClick={() => onImport('photo', close)}>
                  <Icon name="camera" size={14} /> Photo of notes
                </button>
                <button type="button" onClick={() => onImport('slides', close)}>
                  <Icon name="layers" size={14} /> Slides
                </button>
                <button type="button" onClick={() => onImport('transcript', close)}>
                  <Icon name="file-text" size={14} /> Transcript
                </button>
              </MenuGroup>
            </>
          )}
        </DropdownButton>

        {/* Autosave is the only signal that a note's edits reached the server, and
            it was previously conveyed by colour and text alone. A failed save is
            assertive (the user needs to know NOW, before navigating away and
            losing work); saving/saved are polite so they don't interrupt typing. */}
        <span
          className={`folio-save-chip folio-save-${saveStatus}`}
          data-testid="autosave-status"
          role={saveStatus === 'error' ? 'alert' : 'status'}
          aria-live={saveStatus === 'error' ? 'assertive' : 'polite'}
        >
          {saveStatus === 'error' ? (
            <>
              <span className="folio-save-chip__dot" aria-hidden="true" />
              Save failed
              <button type="button" onClick={onRetrySave}>
                Retry
              </button>
            </>
          ) : (
            savedLabel && (
              <>
                <span className="folio-save-chip__dot" aria-hidden="true" />
                {savedLabel}
              </>
            )
          )}
        </span>
      </div>
    </div>
  );
}

/** One switch in the Panels segmented control. `aria-pressed` (not just a colour) is
 *  what makes "this panel is open" available to a screen reader. */
function SegButton({
  on,
  onClick,
  title,
  ariaLabel,
  testId,
  children,
}: {
  on: boolean;
  onClick: () => void;
  title: string;
  ariaLabel?: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={'folio-seg' + (on ? ' on' : '')}
      aria-pressed={on}
      title={title}
      aria-label={ariaLabel}
      data-testid={testId}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** A hairline-separated section of the More menu. The heading is aria-hidden and
 *  repeated as the group's accessible name, so it is announced once as context for
 *  the buttons rather than twice as a stray line of text. */
function MenuGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="folio-menu-group" role="group" aria-label={label}>
      <div className="folio-menu-label" aria-hidden="true">
        {label}
      </div>
      {children}
    </div>
  );
}
