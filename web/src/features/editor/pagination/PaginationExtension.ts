// TipTap wrapper around paginationPlugin.
//
// The options are read through a mutable box rather than passed by value, following the
// same pattern as `editorBox` in buildExtensions.ts and for the same reason: the extension
// list is built once per note and must stay referentially stable, but the geometry changes
// every time the reader picks a different paper size. Passing the geometry directly would
// mean rebuilding the extension list, which tears down and rebuilds the whole editor -
// losing the caret, the undo stack and any open menu.

import { Extension } from '@tiptap/core';
import { paginationPlugin, type PaginationOptions } from './paginationPlugin';

export interface PaginationBox {
  current: PaginationOptions | null;
}

export function createPaginationExtension(box: PaginationBox): Extension {
  return Extension.create({
    name: 'folioPagination',
    addProseMirrorPlugins() {
      return [
        paginationPlugin({
          // Null geometry means "not paginated" - plain mode, a phone, or a board. The
          // plugin treats that as a instruction to clear its plan, so switching a note to
          // plain removes the sheets rather than freezing the last ones drawn.
          getGeometry: () => box.current?.getGeometry() ?? null,
          onPlan: (plan, geometry) => box.current?.onPlan?.(plan, geometry),
        }),
      ];
    },
  });
}
