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
import './editor.css';

export interface FolioEditorProps {
  content: JSONContent | Record<string, unknown> | string | null | undefined;
  notebookId: string;
  onReady: (editor: Editor) => void;
  onDestroy: () => void;
  onDocChange: () => void;
  onOutline: (items: OutlineItem[]) => void;
}

export default function FolioEditor({ content, notebookId, onReady, onDestroy, onDocChange, onOutline }: FolioEditorProps) {
  const editorBox = useRef<Editor | null>(null);
  const notebookIdRef = useRef(notebookId);
  notebookIdRef.current = notebookId;

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
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const editor = useEditor({
    extensions,
    content: (content ?? '') as JSONContent,
    editorProps: {
      // Harper owns spelling now (spell/SpellExtension). Leaving the browser's checker on
      // would draw a second, unstyleable squiggle under the same words - and its suggestions
      // are reachable only from Chrome's own menu, which is the reason it is not the engine.
      attributes: { class: 'folio-prosemirror', spellcheck: 'false', 'data-testid': 'note-editor' },
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
      <EditorContent editor={editor} />
    </div>
  );
}
