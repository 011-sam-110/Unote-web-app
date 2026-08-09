// The image node, taught to render bytes that are still only on this device.
//
// An image inserted with no connection has nowhere to be served from, so the note's
// content carries `local-blob:<id>` and the bytes sit in IndexedDB (lib/local/blobs).
// A plain <img src="local-blob:..."> is a broken image, so this node view resolves the
// reference to an object URL at render time.
//
// The reference, not the object URL, is what the document stores. An object URL lives
// only as long as the page that created it, so writing one into the note would leave a
// permanently broken image the next time the app is opened - and it would be pushed to
// the server in that state.
//
// EVERY createObjectURL HERE HAS A MATCHING revoke IN destroy(). Node views are
// destroyed and rebuilt as the user edits around them, so a leak is not one URL per
// image but one per re-render: a long session scrolling a note full of screenshots
// would hold every version of every one of them until the tab closed.
import Image from '@tiptap/extension-image';
import { blobIdFromRef, isBlobRef, readBlob } from '../../../lib/local/blobs';

export const LocalImage = Image.extend({
  addNodeView() {
    return ({ node, HTMLAttributes }) => {
      const img = document.createElement('img');
      for (const [key, value] of Object.entries({ ...this.options.HTMLAttributes, ...HTMLAttributes })) {
        if (value !== null && value !== undefined) img.setAttribute(key, String(value));
      }

      const src = typeof node.attrs.src === 'string' ? node.attrs.src : '';
      let objectUrl: string | null = null;
      let destroyed = false;

      if (isBlobRef(src)) {
        // Nothing to show until the read resolves. The attribute is removed rather
        // than left pointing at the reference, so the browser shows an empty box
        // instead of a broken-image icon for the frame or two this takes.
        img.removeAttribute('src');
        void readBlob(blobIdFromRef(src)).then((bytes) => {
          // The node can be torn down while the read is in flight, and creating a URL
          // after that is a leak with nothing left to revoke it.
          if (destroyed || !bytes) return;
          objectUrl = URL.createObjectURL(bytes);
          img.src = objectUrl;
        });
      }

      return {
        dom: img,
        destroy() {
          destroyed = true;
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          objectUrl = null;
        },
      };
    };
  },
});

export default LocalImage;
