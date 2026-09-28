// The image node, taught to render bytes that are still only on this device, to resize
// from its corners and to let text wrap around it.
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
//
// Resizing works like Word: select the image, drag a corner, and the proportions hold.
// Only the WIDTH drives the layout (height is auto), so an image sized on a desktop page
// still fits a phone: max-width wins and the height follows. The height is stored too,
// for exports that need a box rather than a width.
import Image from '@tiptap/extension-image';
import type { Node as PMNode } from '@tiptap/pm/model';
import { blobIdFromRef, isBlobRef, readBlob } from '../../../lib/local/blobs';

/** Where the image sits. Null is the original layout: on its own line, left edge, no wrap. */
export type ImageAlign = 'left' | 'center' | 'right' | null;

const ALIGNS = new Set(['left', 'center', 'right']);
const CORNERS = ['nw', 'ne', 'sw', 'se'] as const;
type Corner = (typeof CORNERS)[number];

/** Small enough to tuck beside a paragraph, big enough that the handles don't overlap. */
export const MIN_IMAGE_WIDTH = 48;

function parseAlign(value: unknown): ImageAlign {
  return typeof value === 'string' && ALIGNS.has(value) ? (value as ImageAlign) : null;
}

function positiveInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

export const LocalImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (el) => positiveInt(el.getAttribute('width')),
        renderHTML: (attrs) => (attrs.width ? { width: attrs.width } : {}),
      },
      height: {
        default: null,
        parseHTML: (el) => positiveInt(el.getAttribute('height')),
        renderHTML: (attrs) => (attrs.height ? { height: attrs.height } : {}),
      },
      align: {
        default: null,
        parseHTML: (el) => parseAlign(el.getAttribute('data-align')),
        renderHTML: (attrs) => (attrs.align ? { 'data-align': attrs.align } : {}),
      },
    };
  },

  addNodeView() {
    return ({ node: initialNode, HTMLAttributes, editor, getPos }) => {
      let node: PMNode = initialNode;

      const block = document.createElement('div');
      block.className = 'folio-image-block';
      const frame = document.createElement('span');
      frame.className = 'folio-image-frame';
      const img = document.createElement('img');
      img.draggable = false;
      frame.appendChild(img);
      block.appendChild(frame);

      for (const [key, value] of Object.entries({ ...this.options.HTMLAttributes, ...HTMLAttributes })) {
        // Size and placement are applied as styles below, from the node, so an update can
        // change them in place without rebuilding the view.
        if (key === 'width' || key === 'height' || key === 'data-align') continue;
        if (value !== null && value !== undefined) img.setAttribute(key, String(value));
      }

      const applyLayout = () => {
        const width = positiveInt(node.attrs.width);
        img.style.width = width ? `${width}px` : '';
        const align = parseAlign(node.attrs.align);
        if (align) block.dataset.align = align;
        else delete block.dataset.align;
      };
      applyLayout();

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

      // ---- corner resize ----
      let drag: {
        corner: Corner;
        pointerId: number;
        startX: number;
        startY: number;
        startWidth: number;
        ratio: number;
        scale: number;
        maxWidth: number;
        handle: HTMLElement;
      } | null = null;

      const maxWidthFor = (): number => {
        // The text column, not the viewport: the ProseMirror root's content box.
        const root = editor.view.dom as HTMLElement;
        const cs = getComputedStyle(root);
        const inner = root.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        return Math.max(MIN_IMAGE_WIDTH, Math.floor(inner));
      };

      const onPointerMove = (event: PointerEvent) => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        event.preventDefault();
        // Screen pixels to CSS pixels: the paged editor is scaled with a transform.
        const dx = (event.clientX - drag.startX) / drag.scale;
        const dy = (event.clientY - drag.startY) / drag.scale;
        const east = drag.corner.endsWith('e');
        const south = drag.corner.startsWith('s');
        // A centred image grows from its middle, so the corner moves half as far as the
        // width changes. Doubling keeps the corner under the pointer.
        const factor = parseAlign(node.attrs.align) === 'center' ? 2 : 1;
        const fromX = drag.startWidth + (east ? dx : -dx) * factor;
        const fromY = drag.startWidth + (south ? dy : -dy) * drag.ratio * factor;
        // Follow whichever axis moved further, so a diagonal, a sideways and an up/down
        // drag all do what the hand expects.
        const next =
          Math.abs(fromX - drag.startWidth) >= Math.abs(fromY - drag.startWidth) ? fromX : fromY;
        const width = Math.round(Math.min(drag.maxWidth, Math.max(MIN_IMAGE_WIDTH, next)));
        img.style.width = `${width}px`;
      };

      const endDrag = (commit: boolean) => {
        if (!drag) return;
        const { handle, pointerId, startWidth } = drag;
        drag = null;
        block.classList.remove('is-resizing');
        handle.removeEventListener('pointermove', onPointerMove);
        handle.removeEventListener('pointerup', onPointerUp);
        handle.removeEventListener('pointercancel', onPointerCancel);
        window.removeEventListener('keydown', onKeyDown, true);
        if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);

        const width = Math.round(img.getBoundingClientRect().width / (frameScale() || 1));
        if (!commit || width === startWidth) {
          applyLayout();
          return;
        }
        const height = Math.round(img.offsetHeight);
        const pos = typeof getPos === 'function' ? getPos() : undefined;
        if (typeof pos !== 'number') {
          applyLayout();
          return;
        }
        editor
          .chain()
          .setNodeSelection(pos)
          .updateAttributes(this.name, { width, height: height > 0 ? height : null })
          .run();
      };

      const onPointerUp = (event: PointerEvent) => {
        if (drag && event.pointerId === drag.pointerId) endDrag(true);
      };
      const onPointerCancel = (event: PointerEvent) => {
        if (drag && event.pointerId === drag.pointerId) endDrag(false);
      };
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key !== 'Escape' || !drag) return;
        event.preventDefault();
        event.stopPropagation();
        endDrag(false);
      };

      const frameScale = () => {
        const w = frame.offsetWidth;
        return w > 0 ? frame.getBoundingClientRect().width / w : 1;
      };

      const handles = CORNERS.map((corner) => {
        const handle = document.createElement('span');
        handle.className = 'folio-image-handle';
        handle.dataset.corner = corner;
        handle.setAttribute('aria-hidden', 'true');
        handle.addEventListener('pointerdown', (event) => {
          if (!editor.isEditable || event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          const rect = img.getBoundingClientRect();
          const scale = frameScale() || 1;
          const startWidth = rect.width / scale;
          if (startWidth <= 0) return;
          drag = {
            corner,
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            startWidth,
            // Width per unit of height, from what is on screen now - the stored height can
            // be stale, and an image that has not loaded has none.
            ratio: rect.height > 0 ? rect.width / rect.height : 1,
            scale,
            maxWidth: maxWidthFor(),
            handle,
          };
          block.classList.add('is-resizing');
          handle.setPointerCapture(event.pointerId);
          handle.addEventListener('pointermove', onPointerMove);
          handle.addEventListener('pointerup', onPointerUp);
          handle.addEventListener('pointercancel', onPointerCancel);
          window.addEventListener('keydown', onKeyDown, true);
        });
        frame.appendChild(handle);
        return handle;
      });

      return {
        dom: block,
        update(updated) {
          if (updated.type !== node.type) return false;
          // A new source is a new image: rebuild, which also re-resolves a blob ref.
          if (updated.attrs.src !== node.attrs.src) return false;
          node = updated;
          if (!drag) applyLayout();
          if (typeof updated.attrs.alt === 'string') img.alt = updated.attrs.alt;
          else img.removeAttribute('alt');
          return true;
        },
        selectNode() {
          block.classList.add('ProseMirror-selectednode');
        },
        deselectNode() {
          block.classList.remove('ProseMirror-selectednode');
        },
        // The handles own their pointer events; ProseMirror must not turn a corner drag
        // into a text selection or a node drag.
        stopEvent(event) {
          return handles.includes(event.target as HTMLElement);
        },
        ignoreMutation() {
          return true;
        },
        destroy() {
          destroyed = true;
          if (drag) endDrag(false);
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          objectUrl = null;
        },
      };
    };
  },
});

export default LocalImage;
