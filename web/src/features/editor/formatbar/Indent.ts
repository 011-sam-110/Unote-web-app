// Block indent / outdent, as Word's increase- and decrease-indent buttons do it.
//
// The one control in the formatting bar with no TipTap extension behind it. Indentation of
// a *list* is already handled - Tab and Shift-Tab nest list items, which is a structural
// change, not a visual one. This is the other kind: pushing a paragraph, heading or quote
// in from the margin without changing what it is.
//
// Stored as a numeric `indent` attribute rather than a margin string, so the value survives
// a copy/paste round trip through HTML and cannot smuggle arbitrary CSS into the document.

import { Extension } from '@tiptap/core';
import type { EditorState, Transaction } from '@tiptap/pm/state';

/** The shape TipTap hands a command: succeed and dispatch, or return false and do nothing.
 *  `dispatch` is undefined when the editor is only asking whether the command *could* run
 *  (editor.can()), which is what drives the disabled state on the two buttons. */
type CommandFn = (props: {
  state: EditorState;
  tr: Transaction;
  dispatch: ((tr: Transaction) => void) | undefined;
}) => boolean;

/** One step, in em. Matches Word's default half-inch closely enough at the note's body
 *  size, and being relative means it scales when the reader changes the font size. */
export const INDENT_STEP_EM = 2;

/** Deliberately shallow. Word allows more, but past this the text column on A4 is
 *  narrower than the indent that produced it, which is never what anyone meant. */
export const MAX_INDENT = 8;

/** The blocks it makes sense to push in. Lists are excluded on purpose: Tab already nests
 *  them, and having two different indent behaviours on one block is how you get a list
 *  that looks nested and does not export as one. */
const INDENTABLE = ['paragraph', 'heading', 'blockquote', 'codeBlock'];

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    folioIndent: {
      indentBlock: () => ReturnType;
      outdentBlock: () => ReturnType;
    };
  }
}

export const Indent = Extension.create({
  name: 'folioIndent',

  addGlobalAttributes() {
    return [
      {
        types: INDENTABLE,
        attributes: {
          indent: {
            default: 0,
            parseHTML: element => {
              const raw = Number(element.getAttribute('data-indent'));
              return Number.isFinite(raw) ? Math.min(Math.max(raw, 0), MAX_INDENT) : 0;
            },
            renderHTML: attributes => {
              const level = Number(attributes.indent) || 0;
              if (level <= 0) return {};
              // Both an attribute and a style: the attribute is what parses back in, the
              // style is what makes it visible without a stylesheet rule per level - which
              // matters because this HTML is also what the DOCX and print paths read.
              return {
                'data-indent': String(level),
                style: `margin-inline-start: ${level * INDENT_STEP_EM}em`,
              };
            },
          },
        },
      },
    ];
  },

  addCommands() {
    const shift =
      (delta: number): (() => CommandFn) =>
      () =>
      ({ state, tr, dispatch }) => {
        const { from, to } = state.selection;
        let changed = false;

        state.doc.nodesBetween(from, to, (node, pos) => {
          if (!INDENTABLE.includes(node.type.name)) return;
          const current = Number(node.attrs.indent) || 0;
          const next = Math.min(Math.max(current + delta, 0), MAX_INDENT);
          if (next === current) return;
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: next });
          changed = true;
        });

        // Returning false when nothing moved is what lets the buttons disable themselves
        // at the margin and at the maximum, through editor.can().
        if (!changed) return false;
        dispatch?.(tr);
        return true;
      };

    return {
      indentBlock: shift(1),
      outdentBlock: shift(-1),
    };
  },

  addKeyboardShortcuts() {
    return {
      // Ctrl+M is Word's own binding for this, and it avoids Tab, which already belongs to
      // list nesting and to moving between table cells.
      'Mod-m': () => this.editor.commands.indentBlock(),
      'Shift-Mod-m': () => this.editor.commands.outdentBlock(),
    };
  },
});
