// Floating bar over a selected image: where it sits, and whether text wraps around it.
// The size itself is set by dragging a corner (LocalImage.ts); this bar only offers the
// way back to the picture's own size.
import { BubbleMenu } from '@tiptap/react/menus';
import { useEditorState } from '@tiptap/react';
import { NodeSelection } from '@tiptap/pm/state';
import type { Editor } from '@tiptap/core';
import type { ImageAlign } from './nodes/LocalImage';

const LAYOUTS: { align: ImageAlign; label: string; title: string }[] = [
  { align: 'left', label: 'Wrap left', title: 'Image on the left, text wraps down its right side' },
  { align: null, label: 'No wrap', title: 'Image on its own line, no text beside it' },
  { align: 'center', label: 'Centre', title: 'Image centred on its own line' },
  { align: 'right', label: 'Wrap right', title: 'Image on the right, text wraps down its left side' },
];

function selectedImage(editor: Editor) {
  const { selection } = editor.state;
  return selection instanceof NodeSelection && selection.node.type.name === 'image' ? selection.node : null;
}

export default function ImageToolbar({ editor }: { editor: Editor }) {
  const image = useEditorState({
    editor,
    selector: ({ editor }) => {
      const node = selectedImage(editor);
      return node ? { align: (node.attrs.align ?? null) as ImageAlign, sized: !!node.attrs.width } : null;
    },
  });

  return (
    <BubbleMenu
      editor={editor}
      pluginKey="folioImageMenu"
      shouldShow={({ editor }) => editor.isEditable && !!selectedImage(editor)}
      options={{ placement: 'top', offset: 10 }}
    >
      <div className="folio-bubble folio-image-bubble" role="toolbar" aria-label="Image layout" data-testid="image-toolbar">
        {LAYOUTS.map(({ align, label, title }) => {
          const active = image?.align === align;
          return (
            <button
              key={label}
              type="button"
              title={title}
              aria-pressed={active}
              className={active ? 'active' : undefined}
              onClick={() => editor.chain().focus().updateAttributes('image', { align }).run()}
            >
              {label}
            </button>
          );
        })}
        {image?.sized && (
          <>
            <span className="folio-bubble-sep" role="separator" aria-orientation="vertical" />
            <button
              type="button"
              title="Back to the picture's own size"
              onClick={() => editor.chain().focus().updateAttributes('image', { width: null, height: null }).run()}
            >
              Reset size
            </button>
          </>
        )}
      </div>
    </BubbleMenu>
  );
}
