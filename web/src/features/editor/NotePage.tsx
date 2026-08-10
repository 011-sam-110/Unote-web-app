// The editor page (`/note/:noteId`) - the crown jewel. Loads the note, then hands off
// to NoteWorkspace (keyed by note id) which owns the title, TipTap editor, autosave,
// history/AI/import affordances and the backlinks sections.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Editor } from '@tiptap/core';
import { api, ApiError } from '../../lib/api';
import type { AiSuggestResult, Note, NoteLite, Attachment } from '../../lib/types';
import { relativeTime, plural, formatBytes, errorMessage } from '../../lib/format';
import { toast } from '../../components/Toast';
import { setActiveNotebook, clearActiveNotebook } from '../../lib/notebookContext';
import EmptyState from '../../components/EmptyState';
import Skeleton from '../../components/Skeleton';
import Icon from '../../components/Icon';
import NoteCard from '../../components/NoteCard';
import FolioEditor from './FolioEditor';
import TagEditor from './TagEditor';
import OutlinePane from './OutlinePane';
import HistoryPanel from './HistoryPanel';
import AssistantPanel from './AssistantPanel';
import type { ToolOutcome } from './assistantActions';
import AiPreviewModal from './AiPreviewModal';
import NoteActionBar from './NoteActionBar';
import InsertMenuPopover from './InsertMenuPopover';
import ImportModal from '../import/ImportModal';
import { useAiAvailable } from '../../lib/aiStatus';
import { isGuest } from '../guest/guestMode';
import { downloadGuestNote } from '../guest/guestExport';
import { useAutosave } from './useAutosave';
import { clearActiveFlushKey, registerFlush, setActiveFlushKey, SOLO_KEY } from './autosaveBus';
import { useIsActiveTab, useTabPane, useTabParams } from '../tabs/tabLocation';
import { useTabsOptional } from '../tabs/TabsContext';
import { markdownToSafeHtml } from './markdown';
import type { OutlineItem } from './outline';
import CommentsPanel from '../comments/CommentsPanel';
import CanvasBoard from '../canvas/CanvasBoard';
import NoteInkOverlay from '../canvas/NoteInkOverlay';
import FindReplaceBar, { type FindReplaceMode } from './FindReplaceBar';
import { createFindReplacePlugin, FindReplacePluginKey } from './FindReplace';
import { createHashtagPlugin, HashtagPluginKey } from './HashtagExtension';
import CheckPicker from './CheckPicker';
import { AiReviewPluginKey, createAiReviewPlugin, setReviewEdits } from './AiReviewPlugin';
import { fetchCheckCatalogue, resolveFamilies } from '../../lib/checksApi';
import { extractHashtags, normalizeTags, unionTags, invalidateTagVocabulary } from '../../lib/tags';
import './notePage.css';

/** Where the reader's writing-column width lives. Absent means full width. */
const WIDTH_KEY = 'folio.noteWidth';

export default function NotePage() {
  // Not useParams: several note pages are mounted at once, one per open tab, and the
  // router answers for the URL - which belongs to whichever tab is on screen. A hidden
  // note asking the router for its id would be handed the VISIBLE note's id and quietly
  // refetch itself into a second copy of it.
  const { noteId } = useTabParams<{ noteId: string }>('/note/:noteId');
  const [state, setState] = useState<{ note: Note; backlinks: NoteLite[] } | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'notfound' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState('');

  // Monotonic request id guards against the note-load race: rapid A→B→A navigation could
  // otherwise let a stale GET resolve LAST and swap the editor to a different note's content
  // (the root cause of the "caret jumps to start mid-typing" bug). Only the latest request
  // is allowed to commit its result.
  const loadSeq = useRef(0);

  const load = useCallback((id: string) => {
    const seq = ++loadSeq.current;
    setStatus('loading');
    api
      .note(id)
      .then(({ note, backlinks }) => {
        if (loadSeq.current !== seq) return; // superseded by a newer navigation
        setState({ note, backlinks });
        setStatus('ready');
      })
      .catch((e: unknown) => {
        if (loadSeq.current !== seq) return;
        if (e instanceof ApiError && e.status === 404) setStatus('notfound');
        else {
          setErrorMsg(e instanceof Error ? e.message : 'Failed to load note');
          setStatus('error');
        }
      });
  }, []);

  useEffect(() => {
    if (noteId) load(noteId);
    return () => {
      // Invalidate any in-flight load when the note id changes / component unmounts.
      loadSeq.current++;
    };
  }, [noteId, load]);

  if (status === 'loading') {
    return (
      <div className="folio-note-page">
        <div className="folio-note-main">
          <div className="folio-note-shell">
            <Skeleton lines={1} />
            <div style={{ height: 40 }} />
            <Skeleton lines={8} />
          </div>
        </div>
      </div>
    );
  }

  if (status === 'notfound') {
    return (
      <div className="folio-note-missing">
        <EmptyState
          icon="🔍"
          title="Note not found"
          hint="It may have been deleted, or the link is broken."
          action={
            <Link className="folio-btn-primary" to="/">
              ← Back to dashboard
            </Link>
          }
        />
      </div>
    );
  }

  if (status === 'error' || !state) {
    return (
      <div className="folio-note-missing">
        <EmptyState
          icon="⚠️"
          title="Couldn't load this note"
          hint={errorMsg}
          action={
            <button type="button" className="folio-btn-primary" onClick={() => noteId && load(noteId)}>
              Retry
            </button>
          }
        />
      </div>
    );
  }

  // A canvas is still a note (same id space, same notebook, same trash), but its
  // content lives in canvas_items/canvas_edges rather than content_json - so the
  // whole TipTap workspace below is the wrong surface for it. Branch before
  // mounting NoteWorkspace rather than inside it: the editor, autosave, outline
  // and comments machinery all assume a document and none of it applies here.
  if (state.note.kind === 'canvas') {
    return <CanvasBoard key={state.note.id} note={state.note} />;
  }

  return (
    <NoteWorkspace
      key={state.note.id}
      initialNote={state.note}
      initialBacklinks={state.backlinks}
    />
  );
}

interface NoteWorkspaceProps {
  initialNote: Note;
  initialBacklinks: NoteLite[];
}

/**
 * Split a note's persisted tags into the two authoring routes that produced them.
 * Anything currently written as a #hashtag in the body belongs to the body (its
 * chip is read-only); everything else was added explicitly in the chip editor.
 * Doing this on load is what stops a hashtag from "graduating" into an explicit
 * chip that the user could remove but the next save would resurrect.
 */
function splitTags(tags: readonly string[], contentText: string) {
  const fromBody = extractHashtags(contentText);
  const explicit = normalizeTags(tags).filter((t) => !fromBody.includes(t));
  return { explicit, fromBody };
}

function NoteWorkspace({ initialNote, initialBacklinks }: NoteWorkspaceProps) {
  const navigate = useNavigate();
  // Everything this page does to the world OUTSIDE itself is guarded on being the visible
  // tab: the document title, the "which notebook am I in" pointer, the window key
  // listener, the drawer inset. Each of those is singular, and up to four note pages are
  // mounted at once, so an unguarded one means three background notes writing over the
  // one being read.
  const pane = useTabPane();
  const isActive = useIsActiveTab();
  const tabKey = pane?.tabId ?? SOLO_KEY;
  const tabs = useTabsOptional();
  const [note, setNote] = useState(initialNote);
  const [backlinks, setBacklinks] = useState(initialBacklinks);
  const [unlinked, setUnlinked] = useState<NoteLite[] | null>(null);
  const [title, setTitle] = useState(initialNote.title);
  // Lazy initialisers - splitTags re-scans the whole body, so it must run once per
  // mounted note, not on every render.
  const [tags, setTags] = useState<string[]>(() => splitTags(initialNote.tags, initialNote.contentText).explicit);
  const [bodyTags, setBodyTags] = useState<string[]>(() => extractHashtags(initialNote.contentText));
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  // The outline rail used to render unconditionally, visible only at ≥1200px via a
  // media query - so it was a panel with no control. It is a toggle in the action bar
  // now, defaulting to on so wide screens behave exactly as they did before. The media
  // query still decides whether there is ROOM for it; this decides whether it exists.
  const [outlineOpen, setOutlineOpen] = useState(true);
  // Full width by default - the note used to be capped at 760px inside a 1400px page, which
  // on any normal laptop left more empty page than note. A reader who wants a book measure
  // back can have it, and the choice is a property of the reader rather than of the note,
  // so it lives in localStorage and applies to every note they open.
  const [focusedWidth, setFocusedWidth] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(WIDTH_KEY) === 'focused';
    } catch {
      return false;
    }
  });
  const [historyOpen, setHistoryOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [unresolvedComments, setUnresolvedComments] = useState(0);
  const [findMode, setFindMode] = useState<FindReplaceMode | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importKind, setImportKind] = useState<'photo' | 'slides' | 'transcript'>('photo');
  const [aiBusy, setAiBusy] = useState<string | null>(null);
  // Availability, not just preference - see lib/aiStatus. With no reachable gateway
  // the AI menu and assistant panel would render as live controls that always fail.
  const aiOn = useAiAvailable();
  const [flashcardBanner, setFlashcardBanner] = useState<number | null>(null);
  // Summarise is the ONLY AI action left that previews a whole-note result. It inserts a
  // callout rather than rewriting the note, so there is nothing to diff and nothing to
  // review per change; Improve and Clean both go through the review rail instead.
  const [summaryResult, setSummaryResult] = useState<{ model: string; markdown: string } | null>(null);
  // Whether the review rail is on screen. The suggestions themselves live in the editor's
  // own plugin state (AiReviewPlugin.ts), not here: they are positional, and positions
  // belong to the document, not to a React render.
  const [reviewOpen, setReviewOpen] = useState(false);
  const [checksOpen, setChecksOpen] = useState(false);
  const [wordCount, setWordCount] = useState(0);
  const [charCount, setCharCount] = useState(0);
  // Stylus annotation layer over this document. Off by default: it swallows
  // pointer input over the note, so it must always be a deliberate choice.
  const [inkOpen, setInkOpen] = useState(false);

  const editorRef = useRef<Editor | null>(null);
  // The restore point for the review currently on screen: one per RUN, not one per approval.
  // Null means "this run has not written anything yet"; a run reaching its first approval
  // fills it in and every later approval reuses it. See `snapshotBeforeReview`.
  const reviewSnapshotRef = useRef<Promise<void> | null>(null);
  const insertBtnRef = useRef<HTMLButtonElement>(null);
  const [insertMenuOpen, setInsertMenuOpen] = useState(false);
  // Ink is stored relative to THIS element's top-left, so annotations stay pinned
  // to the text they mark up as the page scrolls or the window is resized.
  const shellRef = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef(title);
  titleRef.current = title;
  // Mirrors of the tag state, for the same reason titleRef exists: capturePending is a
  // stable callback (empty deps) and must read the LATEST tags without being rebuilt.
  const tagsRef = useRef(tags);
  tagsRef.current = tags;
  const bodyTagsRef = useRef(bodyTags);
  bodyTagsRef.current = bodyTags;
  // Read from the keydown handler below, which is bound once (empty dep array) - a ref keeps
  // it seeing the latest findMode without re-subscribing the window listener every toggle.
  const findModeRef = useRef<FindReplaceMode | null>(findMode);
  findModeRef.current = findMode;

  // Snapshot of the latest editable content, refreshed on every title/doc change.
  // The autosave flush reads THIS (not the live editor) so a pending save still
  // completes on blur/unmount even after the editor instance has been torn down
  // (e.g. the user inserts a wikilink and immediately clicks it to navigate away).
  const pendingRef = useRef<{ title: string; contentJson: unknown; contentText: string; tags: string[] } | null>(null);

  const capturePending = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const contentText = ed.getText({ blockSeparator: '\n' });
    // Inline #hashtags are real tags, so they are re-parsed from the body on every
    // capture and unioned with the explicit chips here - at the single point where
    // the autosave payload is built. That is what makes the two authoring routes
    // ("type #revision" / "add a chip") converge on one tags array, saved by the
    // debounce, retry and beforeunload machinery that already exists.
    const fromBody = extractHashtags(contentText);
    // Only touch React state when the set actually changed: this runs on every
    // keystroke, and a fresh array each time would re-render the chip row constantly.
    if (fromBody.join('\u0000') !== bodyTagsRef.current.join('\u0000')) {
      bodyTagsRef.current = fromBody;
      setBodyTags(fromBody);
    }
    pendingRef.current = {
      title: titleRef.current,
      contentJson: ed.getJSON(),
      contentText,
      tags: unionTags(tagsRef.current, fromBody),
    };
  }, []);

  const autosave = useAutosave(
    note.id,
    () => pendingRef.current,
    (savedNote) => {
      setNote((prev) => {
        // A save that changed the tag set changed the app-wide vocabulary too, so
        // drop the autocomplete cache - otherwise a tag you just invented stays
        // missing from the suggestions for up to its TTL.
        if (prev.tags.join(' ') !== savedNote.tags.join(' ')) invalidateTagVocabulary();
        return { ...prev, updatedAt: savedNote.updatedAt, tags: savedNote.tags };
      });
    },
  );

  // Expose this note's flush so in-editor navigation (wikilink clicks) can persist
  // pending edits before leaving. Registered whether or not this tab is on screen: a
  // background note is still autosaving, and closing its tab has to be able to flush it.
  useEffect(() => {
    registerFlush(tabKey, autosave.flush);
    return () => registerFlush(tabKey, null);
  }, [tabKey, autosave.flush]);

  // Which of the registered flushers a wikilink click means. Only the visible one.
  useEffect(() => {
    if (!isActive) return;
    setActiveFlushKey(tabKey);
    return () => clearActiveFlushKey(tabKey);
  }, [isActive, tabKey]);

  // Publish this note's notebook so Ctrl+N / '+' / quick-switcher-create file new notes
  // into the notebook you're actually reading (fix 14) - which is the notebook of the note
  // on SCREEN, not of any of the three that happen to be mounted behind it.
  useEffect(() => {
    if (!isActive) return;
    setActiveNotebook(initialNote.notebookId);
    return () => clearActiveNotebook();
  }, [isActive, initialNote.notebookId]);

  // Name this note's tab, and colour it with its notebook. The title follows the field as
  // it is typed, so the strip renames itself live.
  const notebookColor = note.notebook?.color;
  const tabId = pane?.tabId;
  useEffect(() => {
    if (!tabId) return;
    tabs?.setIdentity(tabId, { label: title.trim() || 'Untitled', dot: notebookColor });
  }, [tabId, tabs, title, notebookColor]);

  /**
   * Put the caret in the title of a brand-new note.
   *
   * Creating a note left focus on <body>, so the first thing typed after "New note"
   * went nowhere - no caret, no feedback, no text. That is the single most common
   * action in the app, and it failed in exactly the moment someone is mid-lecture.
   * It also caused its own follow-on: typing produced nothing, so people clicked
   * New note again and accumulated empty notes.
   *
   * Guarded on the note actually being empty. Focusing on every open would yank the
   * caret away from someone who came to read, and would scroll a long note back to
   * the top on mobile.
   */
  const titleInputRef = useRef<HTMLTextAreaElement | null>(null);
  const focusedNoteRef = useRef<string | null>(null);
  useEffect(() => {
    if (focusedNoteRef.current === initialNote.id) return; // don't re-grab on re-render
    // Never from a background tab. An empty note reloaded into an evicted pane would
    // otherwise pull the caret out of whatever the user is actually typing in.
    if (!isActive) return;
    const isUntouched = !initialNote.title.trim() && !initialNote.contentText?.trim();
    if (!isUntouched) return;
    focusedNoteRef.current = initialNote.id;
    // After paint, so the input exists and TipTap has finished claiming focus itself.
    const raf = requestAnimationFrame(() => titleInputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [isActive, initialNote.id, initialNote.title, initialNote.contentText]);

  /* Auto-grow the title. A textarea has no intrinsic height, so it is reset to one row and
     re-measured on every change - and on width changes too, since opening the AI drawer
     narrows the column and can push a one-line title onto two.
     The observer watches the COLUMN, not the textarea, and only re-fits when the column's
     width actually changes: observing the textarea would have it react to the height this
     effect just set, which is the classic "ResizeObserver loop" warning. */
  useLayoutEffect(() => {
    const el = titleInputRef.current;
    if (!el) return;
    const fit = () => {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    };
    fit();

    const column = el.parentElement;
    if (!column || typeof ResizeObserver === 'undefined') return;
    let lastWidth = column.clientWidth;
    const ro = new ResizeObserver(() => {
      if (column.clientWidth === lastWidth) return;
      lastWidth = column.clientWidth;
      fit();
    });
    ro.observe(column);
    return () => ro.disconnect();
  }, [title]);

  // Pull fresh server content into the LIVE editor after a history restore or an import that
  // targets this open note, killing any pending/stale autosave first so it can't revert the
  // change on the next keystroke (fix 4). Without this, the toast says "restored"/"ready"
  // while the editor keeps the pre-change doc and the next autosave silently undoes it.
  const resyncFromServer = useCallback(async () => {
    await autosave.settle(); // let any in-flight save land first so the fetch sees the truth
    autosave.markClean(); // then cancel pending + failed saves before we overwrite the doc
    try {
      const { note: fresh, backlinks: bl } = await api.note(note.id);
      setNote(fresh);
      setBacklinks(bl);
      setTitle(fresh.title);
      titleRef.current = fresh.title;
      const ed = editorRef.current;
      if (ed && !ed.isDestroyed) {
        ed.commands.setContent(fresh.contentJson as Record<string, unknown>, { emitUpdate: false });
      }
      // Re-seed the autosave snapshot from the fresh content so a later flush sends this,
      // not the stale pre-restore doc. Tags are re-split from the restored body for the
      // same reason: a restore can add or remove #hashtags, and the chip row must follow.
      const split = splitTags(fresh.tags, fresh.contentText);
      tagsRef.current = split.explicit;
      setTags(split.explicit);
      bodyTagsRef.current = split.fromBody;
      setBodyTags(split.fromBody);
      pendingRef.current = {
        title: fresh.title,
        contentJson: fresh.contentJson,
        contentText: fresh.contentText,
        tags: unionTags(split.explicit, split.fromBody),
      };
      api.unlinkedMentions(note.id).then((r) => setUnlinked(r.notes)).catch(() => {});
    } catch {
      toast('Could not refresh the note. Reload to see the latest', 'error');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id]);

  useEffect(() => {
    api
      .unlinkedMentions(note.id)
      .then((r) => setUnlinked(r.notes))
      .catch(() => setUnlinked([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id]);

  // There is one document title and up to four mounted notes. The one on screen names it.
  useEffect(() => {
    if (!isActive) return;
    document.title = `${title || 'Untitled'} · Unote`;
  }, [isActive, title]);

  useEffect(() => {
    // A window listener is global by definition, so an unguarded one meant Ctrl+F opening
    // Find in every mounted note at once - three of them invisible, all three decorating
    // their documents with match highlights nobody asked for.
    if (!isActive) return;
    function onKeyDown(e: globalThis.KeyboardEvent) {
      // Esc closes the find bar even when focus isn't inside its own input (e.g. the user
      // clicked back into the editor while it was open).
      if (findModeRef.current && e.key === 'Escape') {
        e.preventDefault();
        setFindMode(null);
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === 's') {
        e.preventDefault();
        void manualSnapshot();
        return;
      }
      // Ctrl/Cmd+F and +H are bound HERE (window-scoped, only while this note page is
      // mounted) rather than in buildExtensions.ts/FolioEditor.tsx's editorProps/keymap -
      // those are editor-blocks' files this wave, not ours. A page-level listener also
      // naturally satisfies "editor focused-or-page" (e.g. focus sitting in the title
      // input still opens find) without touching lib/useShortcuts.ts.
      if (key === 'f') {
        e.preventDefault();
        setFindMode('find');
        return;
      }
      if (key === 'h') {
        e.preventDefault();
        setFindMode('replace');
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);

  async function manualSnapshot() {
    await autosave.flush();
    try {
      await api.snapshot(note.id);
      toast('Snapshot saved', 'ok');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Snapshot failed', 'error');
    }
  }

  function handleEditorReady(editor: Editor) {
    editorRef.current = editor;
    // Attach the find/replace ProseMirror plugin directly to this editor instance -
    // registerPlugin() is how we add it without needing a slot in buildExtensions.ts's
    // shared extensions array (editor-blocks' file). Guard against double-registration:
    // React 18 StrictMode's mount→cleanup→mount can call this twice for the same editor.
    if (!FindReplacePluginKey.get(editor.state)) {
      editor.registerPlugin(createFindReplacePlugin());
    }
    // Same registerPlugin route (and the same StrictMode double-mount guard) for the
    // inline #hashtag decorations - see HashtagExtension.ts for why it lives here
    // rather than in buildExtensions.ts's shared array.
    if (!HashtagPluginKey.get(editor.state)) {
      editor.registerPlugin(createHashtagPlugin(openTag));
    }
    // And the AI review decorations, third of the same kind. Registered unconditionally
    // (not only when a review starts) so the plugin is already in the editor's state when
    // `setReviewEdits` dispatches - and behind the same StrictMode guard, because a second
    // registration would replace the plugin instance and take a review in progress with it.
    if (!AiReviewPluginKey.get(editor.state)) {
      editor.registerPlugin(createAiReviewPlugin());
    }
    capturePending();
    setWordCount(editor.storage.characterCount?.words() ?? 0);
    setCharCount(editor.storage.characterCount?.characters() ?? 0);
  }
  function handleEditorDestroy() {
    editorRef.current = null;
  }
  function handleDocChange() {
    capturePending();
    autosave.schedule();
    const ed = editorRef.current;
    if (ed) {
      setWordCount(ed.storage.characterCount?.words() ?? 0);
      setCharCount(ed.storage.characterCount?.characters() ?? 0);
    }
  }

  function handleTitleChange(e: ChangeEvent<HTMLTextAreaElement>) {
    /* A pasted multi-line title collapses to one line here rather than being stored with
       newlines the tab title, share dialog and search results would all render as spaces. */
    const value = e.target.value.replace(/[\r\n]+/g, ' ');
    setTitle(value);
    titleRef.current = value;
    capturePending();
    autosave.schedule();
  }
  function handleTitleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      editorRef.current?.commands.focus('start');
    }
  }

  /** A chip was added or removed - same dirty/debounce path a keystroke takes, so
   *  tag edits inherit the retry, the flush-on-blur and the beforeunload keepalive
   *  instead of racing them with a PATCH of their own. */
  function handleTagsChange(next: string[]) {
    tagsRef.current = next; // set before capturePending, which reads the ref
    setTags(next);
    capturePending();
    autosave.schedule();
  }

  /** Chip / Ctrl+clicked #hashtag → that tag's filtered view on the tags page. */
  function openTag(tag: string) {
    navigate(`/tags?tag=${encodeURIComponent(tag)}`);
  }

  async function togglePin() {
    const next = !note.pinned;
    setNote((n) => ({ ...n, pinned: next }));
    try {
      await api.updateNote(note.id, { pinned: next });
    } catch {
      setNote((n) => ({ ...n, pinned: !next }));
      toast('Could not update pin', 'error');
    }
  }

  function aiError(e: unknown) {
    if (e instanceof ApiError && e.status === 502) toast('AI offline. Is the gateway running?', 'error');
    else toast(e instanceof Error ? e.message : 'AI request failed', 'error');
  }

  async function handleSummarize(close: () => void) {
    close();
    setAiBusy('summarize');
    try {
      const res = await api.aiSummarize(note.id);
      setSummaryResult({ model: res.model, markdown: res.markdown });
    } catch (e) {
      aiError(e);
    } finally {
      setAiBusy(null);
    }
  }
  async function handleTitleSuggest(close: () => void) {
    close();
    setAiBusy('title');
    try {
      const res = await api.aiTitle(note.id);
      setTitle(res.title);
      titleRef.current = res.title;
      capturePending();
      autosave.schedule();
      toast('Title updated', 'ok');
    } catch (e) {
      aiError(e);
    } finally {
      setAiBusy(null);
    }
  }
  /**
   * Run the tool the assistant chose, and answer in the terms the conversation shows.
   *
   * This is the ONLY place a tool call becomes an effect, and it deliberately goes through
   * the same functions the buttons always called: the review flow, the flashcard write, the
   * title rename. A model choosing `improve_writing` gets the identical run a menu item got,
   * with the same restore point, the same per-family fan-out and the same approval step. It
   * cannot reach anything the student could not already do from this page, and it still
   * cannot write a character into the note without an approval.
   *
   * Nothing here throws. A failed tool is part of the conversation - the panel renders it on
   * the turn that asked for it, where the student is looking - rather than a toast that has
   * faded by the time they scroll back to see what they asked.
   */
  async function runAssistantTool(tool: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    // Held for the whole run, not just the request: the action bar's own AI items (Summarise,
    // Suggest a title) read this to disable themselves, and the page runs one AI request at a
    // time. Without it a tool started from the conversation would leave those buttons live.
    setAiBusy(tool);
    try {
      switch (tool) {
        case 'improve_writing':
        case 'clean_formatting': {
          const catalogue = await fetchCheckCatalogue();
          const families = resolveFamilies(note.notebookId, catalogue);
          if (families.length === 0) {
            return { kind: 'error', message: 'No checks are enabled for this notebook.' };
          }
          return stageReview(await api.aiSuggest(note.id, families), families.length);
        }
        case 'find_missing_from_uploads':
          return stageReview(await api.aiGapEdits(note.id), 1);
        case 'generate_flashcards': {
          const count = Math.min(20, Math.max(1, Math.trunc(Number(args.count) || 8)));
          const res = await api.aiFlashcards(note.id, count);
          setFlashcardBanner(res.cards.length);
          window.setTimeout(() => setFlashcardBanner(null), 7000);
          return {
            kind: 'done',
            message: `${res.cards.length} ${res.cards.length === 1 ? 'card' : 'cards'} added to your deck`,
          };
        }
        case 'summarise_note': {
          const res = await api.aiSummarize(note.id);
          return { kind: 'prose', markdown: res.markdown };
        }
        case 'gap_report': {
          const res = await api.aiGaps(note.id);
          return { kind: 'prose', markdown: res.markdown, sources: res.sources.map((s) => s.name) };
        }
        case 'suggest_title': {
          const res = await api.aiTitle(note.id);
          setTitle(res.title);
          titleRef.current = res.title;
          capturePending();
          autosave.schedule();
          return { kind: 'done', message: `Renamed to "${res.title}"` };
        }
        default:
          // A tool the server offered and this build cannot run. Says so instead of leaving
          // the turn spinning - see the note on AiChatTurn's `tool` being a plain string.
          return { kind: 'error', message: "That isn't something I can do from this note." };
      }
    } catch (e) {
      return { kind: 'error', message: errorMessage(e, 'That did not work.') };
    } finally {
      setAiBusy(null);
    }
  }

  /**
   * Put a finished run in front of the reader, reporting the outcome back into the
   * conversation rather than to a toast.
   *
   * "Nothing to suggest" is an `empty`, not an error: the run worked and the note reads well,
   * which is a result and not a failure. Families that did not run are still reported,
   * because "no suggestions" and "we did not actually look" are different sentences and the
   * student cannot tell them apart from the outside.
   */
  function stageReview(res: AiSuggestResult, requested: number): ToolOutcome {
    const ed = editorRef.current;
    if (!ed || ed.isDestroyed) return { kind: 'error', message: 'The editor closed before the suggestions arrived.' };

    const missed = requested - res.ranFamilies.length;
    const caveat = missed > 0 ? ` (${missed} of ${requested} checks didn't run)` : '';

    if (res.edits.length === 0) {
      return { kind: 'empty', message: `Nothing to suggest, this note reads well${caveat}` };
    }
    // A new run is a new undo point. Cleared here rather than when the review closes, so the
    // snapshot belongs to the run about to be reviewed whatever ended the previous one.
    reviewSnapshotRef.current = null;
    setReviewEdits(ed.view, res.edits);
    setReviewOpen(true);
    return { kind: 'review', count: res.edits.length, edits: res.edits };
  }

  /**
   * The undo path for a whole review.
   *
   * A review has no Undo of its own: approvals go into the document one at a time, autosave
   * persists them, and by the time a student decides they preferred their own wording there
   * is nothing left to press. History is the answer, and this is what puts an entry in it -
   * ONE entry, taken before the first approval of a run writes anything, so restoring it
   * rewinds the entire review rather than one arbitrary suggestion.
   *
   * Three things this has to get right, all of them load-bearing:
   *
   *  • ONCE PER RUN. The promise is cached in a ref, so eight approvals await the same
   *    request and History gets one restore point instead of eight indistinguishable ones.
   *  • BEFORE THE FIRST MUTATION. The rail awaits this before it dispatches an approval
   *    (see AiReviewRail's `beforeApply`). A snapshot taken after the edit records the
   *    reviewed note and is worse than no snapshot at all, because History would then
   *    offer an entry that restores nothing.
   *  • FLUSHED FIRST. `api.snapshot` copies what the SERVER holds, not what is on screen,
   *    so a pending autosave has to land first or the restore point would be missing
   *    whatever the student typed since the last save - and restoring it would lose their
   *    typing along with the review.
   *
   * A failed snapshot does not block the approval - refusing to apply a suggestion because
   * a history write failed would be a strange thing to do to someone mid-review - but it is
   * said out loud, and the ref is cleared so the next approval tries again rather than
   * leaving the run permanently un-undoable on one transient failure.
   */
  function snapshotBeforeReview(): Promise<void> {
    if (!reviewSnapshotRef.current) {
      reviewSnapshotRef.current = autosave
        .flush()
        .then(() => api.snapshot(note.id, 'Before AI review'))
        .then(() => undefined)
        .catch(() => {
          reviewSnapshotRef.current = null;
          toast("Couldn't save a restore point, so History won't have an undo for this review", 'error');
        });
    }
    return reviewSnapshotRef.current;
  }

  /** Assistant "Add to note": append the gap analysis as a callout at the end -
   *  the ONLY way the assistant ever writes into a note, and the student clicked it. */
  function insertAssistantNotes(markdown: string) {
    const ed = editorRef.current;
    if (!ed || ed.isDestroyed) return;
    const bodyHtml = markdownToSafeHtml(markdown);
    const calloutHtml = `<div data-type="callout" data-emoji="🧭" data-tone="info"><h2>Assistant: gaps to fill</h2>${bodyHtml}</div>`;
    ed.chain().focus('end').insertContent(calloutHtml).run();
  }
  function applySummary() {
    if (!summaryResult || !editorRef.current) return;
    const bodyHtml = markdownToSafeHtml(summaryResult.markdown);
    const calloutHtml = `<div data-type="callout" data-emoji="🧭" data-tone="info"><h2>Summary</h2>${bodyHtml}</div>`;
    editorRef.current.chain().focus().insertContentAt(0, calloutHtml).run();
    setSummaryResult(null);
    toast('Summary added to top of note', 'ok');
  }

  function openImport(kind: 'photo' | 'slides' | 'transcript', close: () => void) {
    close();
    setImportKind(kind);
    setImportOpen(true);
  }

  /**
   * Drop a built-in template into an empty note.
   *
   * Templates were previously reachable only from the notebook page's "New note ▾", so a
   * note you had already opened - the blank page you are actually staring at - had no way
   * to become a structured one. Matched by the server's stable builtin id rather than by
   * name, because a user can rename their own copy.
   */
  /**
   * Apply a built-in template to this (empty) note.
   *
   * Resolved by id first and by NAME as a fallback, which is not belt-and-braces: the
   * built-in ids carry a numeric prefix that sets their order in the picker, so reordering
   * the set renumbers them - and when that happened, both buttons here silently stopped
   * working, because an id this file hard-codes had quietly become somebody else's. The
   * name is the stable half of the pair.
   */
  async function applyTemplate(builtinId: string, label: string) {
    const ed = editorRef.current;
    if (!ed || ed.isDestroyed) return;
    try {
      const { templates } = await api.templates();
      const tpl =
        templates.find((t) => t.id === builtinId) ??
        templates.find((t) => t.builtin && t.name.toLowerCase() === label.toLowerCase());
      if (!tpl) {
        toast(`The ${label} template is not available`, 'error');
        return;
      }
      ed.chain().focus().setContent(tpl.contentJson as Record<string, unknown>).run();
      capturePending();
      autosave.schedule();
      toast(`${label} template applied`, 'ok');
    } catch (e) {
      toast(errorMessage(e, 'Could not load templates'), 'error');
    }
  }

  /* "Nothing written yet" - driven by the LIVE word count rather than the loaded note, so
     the starters vanish on the first keystroke instead of lingering until the next save.
     A canvas has no prose body, so it is never "empty" in this sense. */
  const isEmptyNote = note.kind !== 'canvas' && wordCount === 0 && !title.trim();

  const notebook = note.notebook;
  const savedLabel =
    autosave.status === 'saving'
      ? 'Saving…'
      : autosave.status === 'error'
        ? 'Save failed'
        : autosave.savedAt
          ? `Saved · ${relativeTime(autosave.savedAt.toISOString())}`
          : '';

  return (
    <div
      className="folio-note-page"
      data-width={focusedWidth ? 'focused' : 'wide'}
      // The Find popover is fixed to the same top-right corner the outline rail hangs from;
      // this lets the rail drop below it rather than sit underneath it (notePage.css).
      data-find={findMode !== null ? 'open' : undefined}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) void autosave.flush();
      }}
    >
      <div className="folio-note-main">
        <div className="folio-note-shell" ref={shellRef}>
          {/* The bar comes FIRST in the document, not after the breadcrumb: it is sticky
              chrome that the whole article scrolls under, and anything above it inside the
              same scroll box is permanently hidden behind it. The breadcrumb belongs to
              the article, so it sits below with the title it names. */}
          <NoteActionBar
            note={note}
            title={title}
            wordCount={wordCount}
            charCount={charCount}
            backlinkCount={backlinks.length}
            insertButtonRef={insertBtnRef}
            insertMenuOpen={insertMenuOpen}
            onToggleInsertMenu={() => setInsertMenuOpen((v) => !v)}
            aiOn={aiOn}
            aiBusy={aiBusy}
            onSummarize={handleSummarize}
            onSuggestTitle={handleTitleSuggest}
            outlineOpen={outlineOpen}
            onToggleOutline={() => {
              // A wide right-hand drawer stands the rail down (see drawerInset.ts), and a
              // toggle that leaves nothing on screen reads as a broken button. Say why
              // instead, and leave the toggle where it was.
              if (!outlineOpen && document.documentElement.hasAttribute('data-drawer-crowds-rail')) {
                toast('Not enough room beside the panel. Narrow it and the outline comes back', 'info');
                return;
              }
              setOutlineOpen((v) => !v);
            }}
            focusedWidth={focusedWidth}
            onToggleWidth={() =>
              setFocusedWidth((v) => {
                const next = !v;
                try {
                  window.localStorage.setItem(WIDTH_KEY, next ? 'focused' : 'wide');
                } catch {
                  // Private mode. The width still applies for this session.
                }
                return next;
              })
            }
            commentsOpen={commentsOpen}
            onToggleComments={() => setCommentsOpen((v) => !v)}
            unresolvedComments={unresolvedComments}
            inkOpen={inkOpen}
            onToggleInk={() => setInkOpen((v) => !v)}
            // The Ctrl/Cmd+F and +H shortcuts below still own this state; the button is
            // an additional route to it, and closing from the button unmounts
            // FindReplaceBar, whose cleanup clears the match decorations.
            findOpen={findMode !== null}
            onToggleFind={() => setFindMode((m) => (m ? null : 'find'))}
            assistantOpen={assistantOpen}
            onToggleAssistant={() => setAssistantOpen((v) => !v)}
            onOpenHistory={() => setHistoryOpen(true)}
            onImport={openImport}
            // A guest has no session for /api/notes/:id/export to authorise, and the note
            // only exists in this browser anyway, so it is rendered here instead.
            onExport={() => (isGuest() ? downloadGuestNote(note.id) : window.open(api.exportUrl(note.id), '_blank'))}
            onTogglePin={togglePin}
            infoOpen={infoOpen}
            onToggleInfo={() => setInfoOpen((v) => !v)}
            saveStatus={autosave.status}
            savedLabel={savedLabel}
            onRetrySave={() => void autosave.flush()}
          />

          {/* The notebook's colour leads the trail, the same dot the sidebar uses, so
              "which module am I in" is answered before the word is read. */}
          <div className="folio-breadcrumb">
            <span
              className="folio-breadcrumb-dot"
              aria-hidden="true"
              style={notebook.color ? { background: notebook.color } : undefined}
            />
            <Link to={`/notebook/${notebook.id}`} className="folio-breadcrumb-notebook">
              {notebook.name}
            </Link>
            <span className="folio-breadcrumb-sep" aria-hidden="true">/</span>
            <span className="folio-breadcrumb-title">{title || 'Untitled'}</span>
          </div>

          {/* A textarea, not an input, because at 46px a real note title ("Lecture 9:
              B-trees and B+ trees") is wider than the column and an input can only scroll
              it out of sight - you would be typing a heading you cannot read. It wraps and
              auto-grows instead; Enter is still swallowed below, so it never holds a
              newline and stays a single-line value everywhere else in the app.
              Placeholder is not a label - it disappears on first keystroke and is not
              reliably exposed. This is the highest-traffic input in the product. */}
          <textarea
            ref={titleInputRef}
            className="folio-title-input"
            aria-label="Note title"
            rows={1}
            value={title}
            placeholder="Untitled"
            spellCheck={false}
            onChange={handleTitleChange}
            onKeyDown={handleTitleKeyDown}
          />

          <TagEditor
            tags={tags}
            autoTags={bodyTags}
            onChange={handleTagsChange}
            onOpenTag={openTag}
            wordCount={wordCount}
          />

          <AttachmentStrip attachments={note.attachments} />

          {/* A blank note used to be a blank page with nothing on it but a caret, while
              every way to start from something you already have (templates, slide import,
              a photo of your handwriting) lived behind a menu somewhere else. This is the
              one moment those are worth offering, so it shows only while the note is
              genuinely empty and disappears on the first keystroke. */}
          {isEmptyNote && (
            <div className="folio-note-blank" data-testid="blank-note-starters">
              <p className="folio-note-blank__title">A blank page, but not a cold start.</p>
              <p className="folio-note-blank__lead">
                Start typing, or begin from something you already have. Slash commands work anywhere
                in the note.
              </p>
              <div className="folio-note-blank__actions">
                <button
                  type="button"
                  className="folio-note-blank__btn"
                  onClick={() => void applyTemplate('builtin-02-lecture-note', 'Lecture note')}
                >
                  Lecture note template
                </button>
                <button
                  type="button"
                  className="folio-note-blank__btn"
                  onClick={() => void applyTemplate('builtin-01-cornell-notes', 'Cornell notes')}
                >
                  Cornell layout
                </button>
                <button
                  type="button"
                  className="folio-note-blank__btn"
                  onClick={() => openImport('slides', () => {})}
                >
                  Import slides or a recording
                </button>
                <button
                  type="button"
                  className="folio-note-blank__btn"
                  onClick={() => openImport('photo', () => {})}
                >
                  Photo of handwritten notes
                </button>
              </div>
            </div>
          )}

          <FolioEditor
            content={note.contentJson}
            notebookId={note.notebookId}
            onReady={handleEditorReady}
            onDestroy={handleEditorDestroy}
            onDocChange={handleDocChange}
            onOutline={setOutline}
          />

          <section className="folio-links-section" data-testid="backlinks-section">
            <h4>Linked from {plural(backlinks.length, 'note')}</h4>
            {backlinks.length === 0 ? (
              <p className="folio-links-empty">No notes link here yet.</p>
            ) : (
              <div className="folio-links-grid">
                {backlinks.map((n) => (
                  <NoteCard key={n.id} note={n} href={`/note/${n.id}`} />
                ))}
              </div>
            )}
          </section>

          {unlinked != null && unlinked.length > 0 && (
            <section className="folio-links-section">
              <h4>Unlinked mentions</h4>
              <div className="folio-links-grid">
                {unlinked.map((n) => (
                  <NoteCard key={n.id} note={n} href={`/note/${n.id}`} />
                ))}
              </div>
            </section>
          )}
        </div>
      </div>

      <NoteInkOverlay noteId={note.id} anchorRef={shellRef} open={inkOpen} onClose={() => setInkOpen(false)} />

      {insertMenuOpen && editorRef.current && (
        <InsertMenuPopover editor={editorRef.current} anchor={insertBtnRef.current} onClose={() => setInsertMenuOpen(false)} />
      )}

      {outlineOpen && <OutlinePane items={outline} editor={editorRef.current} />}

      {/* The rail is no longer mounted here. It renders inside AssistantPanel, which
          switches to it while `reviewOpen` - see the comment on that component above.
          Two right-hand panels would have rebuilt, a few inches over, exactly the
          crowding this redesign removed from the toolbar. */}

      {/* Per notebook, not per note: a chemistry notebook and an essay notebook want
          different checks, and every note in one of them wants the same ones. */}
      <CheckPicker notebookId={note.notebookId} open={checksOpen} onClose={() => setChecksOpen(false)} />

      <HistoryPanel noteId={note.id} open={historyOpen} onClose={() => setHistoryOpen(false)} onRestored={resyncFromServer} />

      <CommentsPanel
        noteId={note.id}
        open={commentsOpen}
        onClose={() => setCommentsOpen(false)}
        editor={editorRef.current}
        onUnresolvedCountChange={setUnresolvedComments}
      />

      {findMode && editorRef.current && (
        <FindReplaceBar
          key={note.id}
          editor={editorRef.current}
          mode={findMode}
          onModeChange={setFindMode}
          onClose={() => setFindMode(null)}
        />
      )}

      {/* The single AI surface: a conversation scoped to this note, with the old dropdown's
          actions as shortcuts that send a message, and each run's suggestion cards rendered
          in the thread under the turn that asked for them. One panel rather than an
          assistant and a rail competing for the same edge of the screen. */}
      <AssistantPanel
        noteId={note.id}
        attachments={note.attachments}
        open={assistantOpen}
        onClose={() => setAssistantOpen(false)}
        onInsert={insertAssistantNotes}
        aiBusy={aiBusy}
        runTool={runAssistantTool}
        onOpenChecks={() => setChecksOpen(true)}
        editor={editorRef.current}
        reviewOpen={reviewOpen}
        beforeApply={snapshotBeforeReview}
        onReviewDone={() => setReviewOpen(false)}
      />

      {/* The last whole-note preview, and the only one that was ever right: a summary is
          new text going in at the top, so there is no "before" to diff it against and
          nothing to approve change by change. Improve and Clean used to share this modal
          and a `before` truncated to 600 characters - a comparison that was silently
          incomplete for any note longer than a paragraph. Both go through the review rail
          now, and the truncation went with them. */}
      {summaryResult && (
        <AiPreviewModal
          open
          onClose={() => setSummaryResult(null)}
          heading="AI: Summarize"
          model={summaryResult.model}
          afterMarkdown={summaryResult.markdown}
          actions={[{ label: 'Insert summary', primary: true, onClick: applySummary }]}
        />
      )}

      {flashcardBanner != null && (
        <div className="folio-flashcard-banner">
          {flashcardBanner} flashcards added.{' '}
          <Link to="/study" onClick={() => setFlashcardBanner(null)}>
            Study now →
          </Link>
        </div>
      )}

      <ImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        noteId={note.id}
        defaultKind={importKind}
        onImported={(resultNoteId) => {
          // The import merged/appended into THIS open note - pull the server's new content
          // into the live editor so the next autosave doesn't revert it (fix 4).
          if (resultNoteId === note.id) void resyncFromServer();
        }}
      />
    </div>
  );
}

function AttachmentStrip({ attachments }: { attachments?: Attachment[] }) {
  const items = (attachments ?? []).filter((a) => a.status !== 'failed');
  if (items.length === 0) return null;
  const isImage = (a: Attachment) => a.mime.startsWith('image/') || a.kind === 'photo' || a.kind === 'image';
  return (
    <div className="folio-attachments" aria-label="Original source files">
      {items.map((a) =>
        isImage(a) ? (
          <a key={a.id} className="folio-attachment folio-attachment--photo" href={a.url} target="_blank" rel="noopener noreferrer" title={`Open original: ${a.originalName}`}>
            <img src={a.url} alt={a.originalName} loading="lazy" />
          </a>
        ) : (
          <a key={a.id} className="folio-attachment folio-attachment--file" href={a.url} target="_blank" rel="noopener noreferrer" title={`Open original: ${a.originalName}`}>
            <Icon name="file-text" size={16} />
            <span className="folio-attachment__name">{a.originalName}</span>
            <span className="folio-attachment__size">{formatBytes(a.size)}</span>
          </a>
        ),
      )}
    </div>
  );
}
