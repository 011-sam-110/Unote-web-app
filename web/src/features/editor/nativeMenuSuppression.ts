// Keeps our own menus out of the way while the BROWSER's context menu is open.
//
// The bug this exists for: Chrome selects a misspelled word on right-click, but only when
// the caret was not already inside it. TipTap's BubbleMenu shows on any non-empty
// selection, so that browser-made selection raised the formatting toolbar on top of the
// native spelling menu - and only in the caret-outside case, which is why it read as
// inconsistent rather than as a rule.
//
// The predicate is deliberately selection-type-agnostic. It asks "did the user just invoke
// the browser's menu here", not "what kind of selection is this", so a right-clicked inline
// atom (which produces a non-empty NodeSelection) is covered by the same gate as a
// right-clicked misspelling.
import { useCallback, useEffect, useRef } from 'react';

export interface NativeMenuSuppression {
  /** True while the browser's own menu is open, or about to be, over this element. */
  isSuppressed(): boolean;
  dispose(): void;
}

/** Binds to one element's own event stream, so with several editors mounted at once a
 *  right-click in one pane cannot mute another pane's toolbar. */
export function bindNativeMenuSuppression(dom: HTMLElement): NativeMenuSuppression {
  let suppressed = false;

  // mousedown lands BEFORE the browser moves the selection, so the flag is already set by
  // the time that selection change triggers a re-evaluation. Listening for `contextmenu`
  // alone is too late - the selection has changed and the menu has already been shown.
  function onMouseDown(e: MouseEvent) {
    suppressed = e.button === 2;
  }

  // Keyboard-invoked menus (Menu key, Shift+F10) never send a mousedown.
  function onContextMenu() {
    suppressed = true;
  }

  // Covers dismissing the native menu with Escape, and any resumption of typing. Ordering
  // is safe for the Menu key: its keydown clears the flag, then the contextmenu event it
  // produces sets it again.
  function onKeyDown() {
    suppressed = false;
  }

  dom.addEventListener('mousedown', onMouseDown, true);
  dom.addEventListener('contextmenu', onContextMenu, true);
  dom.addEventListener('keydown', onKeyDown, true);

  return {
    isSuppressed: () => suppressed,
    dispose() {
      dom.removeEventListener('mousedown', onMouseDown, true);
      dom.removeEventListener('contextmenu', onContextMenu, true);
      dom.removeEventListener('keydown', onKeyDown, true);
    },
  };
}

/** React wrapper. Returns a stable getter to call inside a `shouldShow`-style callback -
 *  the flag is set from a DOM listener and deliberately does not trigger a re-render, so
 *  it must be read at decision time rather than captured during render. */
export function useNativeMenuSuppressed(dom: HTMLElement | null | undefined) {
  const binding = useRef<NativeMenuSuppression | null>(null);
  useEffect(() => {
    if (!dom) return;
    const bound = bindNativeMenuSuppression(dom);
    binding.current = bound;
    return () => {
      bound.dispose();
      binding.current = null;
    };
  }, [dom]);
  return useCallback(() => binding.current?.isSuppressed() ?? false, []);
}
