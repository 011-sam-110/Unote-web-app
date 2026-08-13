// The TipTap editor wrapper: extensions, selection/table bubble menus, drag handle,
// the gutter "+" insert menu, image paste/drop, and outline reporting. Content is only
// used to seed the editor - callers should `key={note.id}` this component to fully
// reinitialize on note switch.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor, type Editor, type JSONContent } from '@tiptap/react';
import type { Node as PMNode } from '@tiptap/pm/model';
import DragHandle from '@tiptap/extension-drag-handle-react';
import { createFolioExtensions } from './buildExtensions';
import SelectionToolbar from './SelectionToolbar';
import TableToolbar from './TableToolbar';
import InsertMenuPopover from './InsertMenuPopover';
import Icon from '../../components/Icon';
import { uploadAndInsertImage } from './imageUpload';
import { computeOutline, type OutlineItem } from './outline';
import SheetLayer from './pagination/SheetLayer';
import { usePagedSurface, type PagedSurfaceProps } from './pagination/usePagedSurface';
import './editor.css';
import './pagination/pagination.css';

export interface FolioEditorProps {
  content: JSONContent | Record<string, unknown> | string | null | undefined;
  notebookId: string;
  onReady: (editor: Editor) => void;
  onDestroy: () => void;
  onDocChange: () => void;
  onOutline: (items: OutlineItem[]) => void;
  /** Page layout and its callbacks. Omit entirely to render the note as one continuous
   *  column - which is what every non-note surface (history preview, share view) wants. */
  paged?: PagedSurfaceProps;
}

export default function FolioEditor({ content, notebookId, onReady, onDestroy, onDocChange, onOutline, paged }: FolioEditorProps) {
  const editorBox = useRef<Editor | null>(null);
  const notebookIdRef = useRef(notebookId);
  notebookIdRef.current = notebookId;

  // Owns the geometry box the pagination plugin reads, the published page plan, and the
  // phone breakpoint at which pages switch off. Always called - hooks cannot be
  // conditional - and returns `active: false` when there is nothing to paginate.
  const surface = usePagedSurface(paged);

  // The block the drag handle is currently sitting beside, tracked live so the "+" knows
  // where to insert. `pendingBlock` snapshots it at click time (the handle can move while
  // the menu is open).
  const hoveredBlock = useRef<{ node: PMNode | null; pos: number }>({ node: null, pos: -1 });
  const pendingBlock = useRef<{ node: PMNode | null; pos: number }>({ node: null, pos: -1 });
  const plusRef = useRef<HTMLButtonElement>(null);
  const [insertOpen, setInsertOpen] = useState(false);

  // MUST be stable: @tiptap's <DragHandle> lists onNodeChange in the deps of the effect
  // that registers/unregisters its ProseMirror plugin. An inline handler is a new
  // reference every render, so on each keystroke DragHandle would re-register its plugin,
  // reconfiguring the editor and destroying any open suggestion popup (the "/" and
  // wikilink menus) the instant it appeared. It only writes a ref, so deps are [].
  const handleNodeChange = useCallback(({ node, pos }: { node: PMNode | null; pos: number }) => {
    hoveredBlock.current = { node, pos };
  }, []);

  // Stable for this component's lifetime - remount (key={note.id}) to rebuild for a new note.
  const extensions = useMemo(
    () =>
      createFolioExtensions({
        editable: true,
        editorBox,
        getNotebookId: () => notebookIdRef.current,
        paginationBox: surface.box,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const editor = useEditor({
    extensions,
    content: (content ?? '') as JSONContent,
    editorProps: {
      attributes: { class: 'folio-prosemirror', spellcheck: 'true', 'data-testid': 'note-editor' },
      handleClick(_view, _pos, event) {
        const target = event.target as HTMLElement;
        const link = target.closest?.('a.folio-link') as HTMLAnchorElement | null;
        if (link && (event.ctrlKey || event.metaKey)) {
          window.open(link.href, '_blank', 'noopener,noreferrer');
          return true;
        }
        return false;
      },
      handleDrop(_view, event) {
        const file = event.dataTransfer?.files?.[0];
        if (file && file.type.startsWith('image/')) {
          event.preventDefault();
          if (editorBox.current) uploadAndInsertImage(editorBox.current, file);
          return true;
        }
        return false;
      },
      handlePaste(_view, event) {
        const file = Array.from(event.clipboardData?.files ?? []).find((f) => f.type.startsWith('image/'));
        if (file) {
          event.preventDefault();
          if (editorBox.current) uploadAndInsertImage(editorBox.current, file);
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor, transaction }) => {
      if (transaction.docChanged) {
        onDocChange();
        onOutline(computeOutline(editor));
      }
    },
  });

  // Report the live editor to the parent through React's own effect lifecycle
  // rather than TipTap's onCreate/onDestroy. Under React 18 StrictMode the editor
  // is created, torn down, and re-attached, and the raw create/destroy callbacks
  // can fire in an order that leaves the parent's editor ref pointing at a
  // destroyed instance (or null) - which silently breaks autosave. Keying this
  // effect on `editor` makes ref handoff deterministic: cleanup always runs before
  // the next setup, so the ref ends on the current live editor.
  useEffect(() => {
    if (!editor) return;
    editorBox.current = editor;
    onReady(editor);
    onOutline(computeOutline(editor));
    return () => {
      editorBox.current = null;
      onDestroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // Re-paginate when the PAGE changes rather than when the text does.
  //
  // The plugin re-measures on doc changes, on a ResizeObserver over the editor, and on
  // late-loading node views. None of those fire for a geometry change that does not alter
  // the editor's width - turning a header on is the clearest case: it shortens every text
  // box on every sheet while the editor's own box stays exactly the same size. The result
  // was blocks laid out for the old geometry sitting under newly drawn bands until
  // something unrelated happened to trigger a measure.
  //
  // Any transaction makes the plugin's view.update run, so an empty one is enough. It is
  // kept out of the undo stack: repagination is not an edit.
  const geometrySignature = surface.active
    ? `${surface.geometry.contentHeightPx}x${surface.geometry.contentWidthPx}x${surface.geometry.interPageSkipPx}`
    : 'none';
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.view.dispatch(editor.state.tr.setMeta('addToHistory', false));
  }, [editor, geometrySignature]);

  // A table wide enough to scroll must be reachable by keyboard, or a keyboard-only
  // user simply cannot see the off-screen columns (axe: scrollable-region-focusable).
  // TipTap builds .tableWrapper itself, so the attributes are applied to whatever it
  // renders - via an observer, because the wrapper is recreated on document changes.
  useEffect(() => {
    if (!editor) return;
    const root = editor.view.dom;
    function label() {
      // Array.from rather than for..of: the project's TS lib target does not
      // expose NodeList's iterator.
      for (const w of Array.from(root.querySelectorAll<HTMLElement>('.tableWrapper'))) {
        if (w.tabIndex === 0) continue;
        w.tabIndex = 0;
        w.setAttribute('role', 'region');
        w.setAttribute('aria-label', 'Table, scrollable');
      }
    }
    label();
    const mo = new MutationObserver(label);
    mo.observe(root, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [editor]);

  if (!editor) return null;

  // Drop the caret into the block the "+" is sitting beside so the chosen item inserts
  // there rather than wherever focus last was. Best-effort: a stale position falls back
  // to the live selection.
  function caretIntoPending(ed: Editor) {
    const { node, pos } = pendingBlock.current;
    if (!node || pos < 0) return;
    try {
      const end = Math.min(ed.state.doc.content.size - 1, pos + node.nodeSize - 1);
      ed.chain().setTextSelection(Math.max(1, end)).run();
    } catch {
      /* position no longer valid - leave the selection as-is */
    }
  }

  return (
    <div className="folio-editor">
      <SelectionToolbar editor={editor} />
      <TableToolbar editor={editor} />
      <DragHandle editor={editor} onNodeChange={handleNodeChange}>
        <div className="folio-block-gutter">
          <button
            ref={plusRef}
            type="button"
            className="folio-gutter-add"
            aria-label="Insert block"
            aria-haspopup="menu"
            aria-expanded={insertOpen}
            onClick={() => {
              pendingBlock.current = hoveredBlock.current;
              setInsertOpen(true);
            }}
          >
            <Icon name="plus" size={15} />
          </button>
          <span className="folio-drag-handle" aria-hidden="true">
            ⠿
          </span>
        </div>
      </DragHandle>
      {insertOpen && (
        <InsertMenuPopover editor={editor} anchor={plusRef.current} onClose={() => setInsertOpen(false)} prepare={caretIntoPending} />
      )}
      {surface.active ? (
        <div className="folio-zoom" style={surface.zoomStyle}>
        <div className="folio-paged" style={surface.style}>
          <SheetLayer
            pages={surface.pages}
            geometry={surface.geometry}
            layout={surface.layout}
            fields={surface.fields}
            onEditBand={surface.onEditBand}
          />
          <div className="folio-page-content">
            <EditorContent editor={editor} />
          </div>
        </div>
        </div>
      ) : (
        <EditorContent editor={editor} />
      )}
    </div>
  );
}
