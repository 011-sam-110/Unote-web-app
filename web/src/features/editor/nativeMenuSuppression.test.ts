import { describe, it, expect, afterEach } from 'vitest';
import { bindNativeMenuSuppression, type NativeMenuSuppression } from './nativeMenuSuppression';

// Mirrors what the browser dispatches. `button: 2` is the right button; note that a
// right-click sends mousedown BEFORE the browser moves the selection, which is the whole
// reason the gate keys on mousedown rather than on contextmenu.
function mouseDown(el: HTMLElement, button: number) {
  el.dispatchEvent(new MouseEvent('mousedown', { button, bubbles: true }));
}
function contextMenu(el: HTMLElement) {
  el.dispatchEvent(new MouseEvent('contextmenu', { button: 2, bubbles: true }));
}
function keyDown(el: HTMLElement, key: string) {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

const bindings: NativeMenuSuppression[] = [];
function bind(el: HTMLElement) {
  const b = bindNativeMenuSuppression(el);
  bindings.push(b);
  return b;
}

afterEach(() => {
  while (bindings.length) bindings.pop()!.dispose();
  document.body.innerHTML = '';
});

function editorDom() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

describe('native context-menu suppression', () => {
  it('is not suppressed before anything happens', () => {
    expect(bind(editorDom()).isSuppressed()).toBe(false);
  });

  it('suppresses on right mousedown - before the browser moves the selection', () => {
    const el = editorDom();
    const s = bind(el);
    mouseDown(el, 2);
    expect(s.isSuppressed()).toBe(true);
  });

  it('does not suppress on an ordinary left click', () => {
    const el = editorDom();
    const s = bind(el);
    mouseDown(el, 0);
    expect(s.isSuppressed()).toBe(false);
  });

  it('releases on the next left click, so the toolbar comes back', () => {
    const el = editorDom();
    const s = bind(el);
    mouseDown(el, 2);
    contextMenu(el);
    expect(s.isSuppressed()).toBe(true);
    mouseDown(el, 0);
    expect(s.isSuppressed()).toBe(false);
  });

  it('suppresses for a keyboard-invoked menu, which sends no mousedown at all', () => {
    const el = editorDom();
    const s = bind(el);
    // Menu key: keydown lands first and clears, then contextmenu must set it again.
    keyDown(el, 'ContextMenu');
    contextMenu(el);
    expect(s.isSuppressed()).toBe(true);
  });

  it('releases when the native menu is dismissed with Escape', () => {
    const el = editorDom();
    const s = bind(el);
    mouseDown(el, 2);
    contextMenu(el);
    keyDown(el, 'Escape');
    expect(s.isSuppressed()).toBe(false);
  });

  it('releases when the user resumes typing', () => {
    const el = editorDom();
    const s = bind(el);
    mouseDown(el, 2);
    keyDown(el, 'a');
    expect(s.isSuppressed()).toBe(false);
  });

  // The tabs guarantee: since 44ab61c several editors are mounted at once, so suppression
  // must be per-editor. A right-click in one pane muting another pane's toolbar would be a
  // new bug of exactly the kind this fix exists to remove.
  it('is per-editor - a right-click in one pane does not mute another', () => {
    const a = editorDom();
    const b = editorDom();
    const sa = bind(a);
    const sb = bind(b);
    mouseDown(a, 2);
    contextMenu(a);
    expect(sa.isSuppressed()).toBe(true);
    expect(sb.isSuppressed()).toBe(false);
  });

  it('stops listening after dispose, so an unmounted pane leaks nothing', () => {
    const el = editorDom();
    const s = bind(el);
    s.dispose();
    mouseDown(el, 2);
    contextMenu(el);
    expect(s.isSuppressed()).toBe(false);
  });

  // Guards the property the fix actually delivers: the two scenarios the user reported as
  // "inconsistent" must now behave identically. Chrome only auto-selects the misspelled
  // word in the caret-outside case, but the gate closes before either selection lands.
  it('behaves identically whether or not the caret was already in the word', () => {
    const outside = editorDom();
    const inside = editorDom();
    const sOutside = bind(outside);
    const sInside = bind(inside);

    // caret elsewhere, then right-click the word: Chrome selects it (non-empty selection)
    mouseDown(outside, 2);
    contextMenu(outside);

    // caret already inside the word, then right-click: Chrome leaves a collapsed caret
    mouseDown(inside, 0);
    mouseDown(inside, 2);
    contextMenu(inside);

    expect(sOutside.isSuppressed()).toBe(sInside.isSuppressed());
    expect(sOutside.isSuppressed()).toBe(true);
  });
});
