// Shared helper: upload an image file to the server and insert it into the editor.
//
// The upload itself - shrink, send, report - lives in features/import/uploadImageWithProgress,
// because the canvas board's image drop needs exactly the same thing and used to get none of
// it. This file is only the editor half: where the resulting image goes, and what to say when
// it cannot get there.
import type { Editor } from '@tiptap/core';
import { toast } from '../../components/Toast';
import { uploadImageWithProgress } from '../import/uploadImageWithProgress';

export async function uploadAndInsertImage(editor: Editor, file: File): Promise<void> {
  try {
    const { url } = await uploadImageWithProgress(file);
    editor.chain().focus().setImage({ src: url, alt: file.name }).run();
  } catch (e) {
    // The progress card has already reported the phase it died in; the toast is the
    // diagnosis, and stays the app's single failure channel.
    toast(e instanceof Error ? e.message : 'Image upload failed', 'error');
  }
}

export function pickAndInsertImage(editor: Editor) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.style.display = 'none';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) void uploadAndInsertImage(editor, file);
    input.remove();
  });
  document.body.appendChild(input);
  input.click();
}
