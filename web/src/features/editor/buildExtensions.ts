// Central extension list, shared by the live FolioEditor and the read-only HistoryPanel
// preview so both render notes identically.
import type { Editor, Extensions } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder, CharacterCount } from '@tiptap/extensions';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { TableKit } from '@tiptap/extension-table';
import Highlight from '@tiptap/extension-highlight';
import Typography from '@tiptap/extension-typography';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { Details, DetailsSummary, DetailsContent } from '@tiptap/extension-details';
import Mathematics from '@tiptap/extension-mathematics';
import UniqueID from '@tiptap/extension-unique-id';
import { createLowlight, common } from 'lowlight';

import CodeBlockView from './CodeBlockView';
import Callout from './Callout';
import Wikilink from './WikilinkExtension';
import SlashCommand from './SlashCommand';
import { createMathClickHandler } from './mathEdit';
import { Column, ColumnList } from './Columns';
import { createTextColorExtensions } from './TextColor';
import LocalImage from './nodes/LocalImage';
import ChemNode from './nodes/chem/ChemNode';
import Model3d from './nodes/model3d/Model3dNode';
import { SketchNode } from './nodes/sketch';

const lowlight = createLowlight(common);

export interface BuildExtensionsOpts {
  editable: boolean;
  editorBox: { current: Editor | null };
  getNotebookId: () => string;
  /** Override the empty-paragraph placeholder. The default advertises the slash
   *  menu, which is wrong anywhere that menu is not mounted (the shared-link
   *  editor, for one). Pass '' for no placeholder at all. */
  paragraphPlaceholder?: string;
}

const UNIQUE_ID_TYPES = [
  'heading', 'paragraph', 'bulletList', 'orderedList', 'taskList',
  'blockquote', 'codeBlock', 'table', 'image', 'callout', 'details', 'columnList',
  'chem', 'model3d', 'sketch',
];

export function createFolioExtensions(opts: BuildExtensionsOpts): Extensions {
  const CodeBlockWithView = CodeBlockLowlight.extend({
    addNodeView() {
      return ReactNodeViewRenderer(CodeBlockView, { contentDOMElementTag: 'code' });
    },
  });

  const extensions: Extensions = [
    StarterKit.configure({
      codeBlock: false,
      link: {
        openOnClick: false,
        autolink: true,
        HTMLAttributes: { class: 'folio-link', rel: 'noopener noreferrer' },
      },
      heading: { levels: [1, 2, 3] },
    }),
    Placeholder.configure({
      placeholder: ({ node }) => {
        if (node.type.name === 'heading') return `Heading ${(node.attrs.level as number) ?? 1}`;
        if (node.type.name === 'blockquote') return 'Quote';
        if (node.type.name === 'paragraph') return opts.paragraphPlaceholder ?? "Type '/' for commands…";
        return '';
      },
    }),
    CharacterCount,
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: true, lastColumnResizable: true, cellMinWidth: 40 } }),
    // The stock Image node plus a node view that resolves `local-blob:` sources, so an
    // image inserted with no connection renders from IndexedDB rather than as a
    // broken box. Everything else about it is unchanged, including serialisation.
    LocalImage.configure({ HTMLAttributes: { class: 'folio-image' } }),
    Highlight.configure({ multicolor: false }),
    // Smart quotes and ellipsis are welcome; the arrow and dash rules are not.
    // Unconfigured, Typography silently rewrote `1 << 3` to `1 « 3`, `n >> 1` to
    // `n » 1`, and `A --> B` to `A -> B` - including inside backticks, because the
    // input rule fires before the code mark applies. For a computer science
    // notebook that is data loss in the most common thing its user types, and undo
    // does not recover it cleanly.
    Typography.configure({
      laquo: false, // << stays <<  (bit shift, C++ streams)
      raquo: false, // >> stays >>
      leftArrow: false, // <- stays <-
      rightArrow: false, // -> stays ->  (pointers, Rust, type signatures)
      emDash: false, // -- stays --  (CLI flags, and `-->` was becoming `->`)
      notEqual: false, // != stays !=
    }),
    CodeBlockWithView.configure({ lowlight, defaultLanguage: 'plaintext' }),
    Details.configure({
      persist: true,
      HTMLAttributes: { class: 'folio-details' },
      /*
       * The node view's toggle <button> is the only element wired to open a toggle, and
       * it sits INSIDE the ProseMirror contenteditable. ProseMirror's keydown handler
       * calls preventDefault() on Enter (Enter means "split the block" to the editor),
       * which also cancels the browser's implicit activation of a focused button - so
       * Enter on the toggle did nothing at all. Measured before this: Space toggled,
       * Enter was swallowed. Handling both keys here and stopping the event before it
       * reaches the editor makes the control behave like the button it already claims
       * to be, and adds the `aria-expanded` a disclosure widget is supposed to expose
       * (the extension's default only rewrites aria-label).
       *
       * Mutating the element here is the sanctioned path, not a hack: the node view's
       * own `ignoreMutation` returns true for anything inside this button precisely so
       * that `renderToggleButton` can write to it without disturbing ProseMirror.
       */
      renderToggleButton: ({ element, isOpen }) => {
        element.setAttribute('aria-label', isOpen ? 'Collapse toggle' : 'Expand toggle');
        element.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        // Re-run on every render of the node view, so bind the listener exactly once.
        if (element.dataset.folioKeyboard === 'on') return;
        element.dataset.folioKeyboard = 'on';
        element.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          // preventDefault stops Space activating a SECOND time via the browser's own
          // keyup handling; stopPropagation keeps the editor from splitting the block
          // or typing a space into the summary sitting behind the button.
          event.preventDefault();
          event.stopPropagation();
          element.click();
          // When the editor is editable the extension's click handler ends its chain
          // with `.focus()`, which pulls DOM focus off this button and onto the
          // ProseMirror root - a keyboard user would get ONE activation and then find
          // the next Enter splitting a paragraph somewhere else. That steal happens
          // inside a requestAnimationFrame (@tiptap/core's `focus` command), so a
          // synchronous refocus here is silently undone a frame later; queueing ours
          // behind theirs in the same frame is what actually holds. Harmless when
          // read-only, where the extension never refocuses at all.
          requestAnimationFrame(() => element.focus());
        });
      },
    }),
    DetailsSummary,
    DetailsContent,
    Mathematics.configure({
      katexOptions: { throwOnError: false },
      inlineOptions: { onClick: createMathClickHandler(opts.editorBox, 'inline') },
      blockOptions: { onClick: createMathClickHandler(opts.editorBox, 'block') },
    }),
    UniqueID.configure({ types: UNIQUE_ID_TYPES }),
    Callout,
    Wikilink.configure({ getNotebookId: opts.getNotebookId }),
    ColumnList,
    Column,
    ChemNode,
    Model3d,
    SketchNode,
    ...createTextColorExtensions(),
  ];

  if (opts.editable) {
    extensions.push(SlashCommand);
  }

  return extensions;
}
