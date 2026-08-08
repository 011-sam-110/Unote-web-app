// Persistent right-rail table of contents (≥1280px, see notePage.css). Reflects the
// live heading tree; clicking scrolls to and flashes the target heading, and the entry
// for whatever heading you are currently under is marked as you scroll.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import type { OutlineItem } from './outline';

/* Where in the viewport a heading counts as "the one you are reading under". It sits
   just below the sticky action bar, so a heading scrolled up behind the bar has already
   handed over to the next one. */
const ACTIVE_LINE_PX = 140;

export default function OutlinePane({ items, editor }: { items: OutlineItem[]; editor: Editor | null }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const navRef = useRef<HTMLElement | null>(null);

  const resolve = useCallback(
    (item: OutlineItem): HTMLElement | null => {
      if (!editor) return null;
      return (
        editor.view.dom.querySelector<HTMLElement>(`[data-id="${cssEscape(item.id)}"]`) ??
        (editor.view.nodeDOM(item.pos) as HTMLElement | null)
      );
    },
    [editor],
  );

  /* Scroll spy. A listener on the scroll container rather than an IntersectionObserver:
     the headings are re-created by ProseMirror on almost every edit, so a set of observed
     targets would need re-registering constantly, while a position read is always current.
     Throttled to one measurement per frame - scroll fires far more often than that. */
  useEffect(() => {
    if (!editor || items.length === 0) return;
    const scroller = navRef.current?.closest<HTMLElement>('.app-main') ?? null;
    const target: HTMLElement | Window = scroller ?? window;

    let frame = 0;
    const measure = () => {
      frame = 0;
      let next = 0;
      for (let i = 0; i < items.length; i += 1) {
        const el = resolve(items[i]);
        if (!el) continue;
        if (el.getBoundingClientRect().top <= ACTIVE_LINE_PX) next = i;
        else break;
      }
      setActiveIndex(next);
    };
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(measure);
    };

    measure();
    target.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      target.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [editor, items, resolve]);

  if (!items.length) return null;

  function go(item: OutlineItem) {
    const dom = resolve(item);
    if (!dom) return;
    dom.scrollIntoView({ behavior: 'smooth', block: 'center' });
    dom.classList.add('folio-flash');
    window.setTimeout(() => dom.classList.remove('folio-flash'), 1200);
  }

  return (
    <nav className="folio-outline" aria-label="Note outline" ref={navRef}>
      <div className="folio-outline-label">On this page</div>
      <ul>
        {items.map((it, i) => (
          <li key={`${it.id}-${i}`} style={{ paddingLeft: (it.level - 1) * 12 }}>
            <button
              type="button"
              className={i === activeIndex ? 'is-active' : undefined}
              // The rail is decoration for a sighted reader tracking their position; the
              // state that matters to a screen reader is which link is current.
              aria-current={i === activeIndex ? 'true' : undefined}
              onClick={() => go(it)}
            >
              {it.text}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function cssEscape(s: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s);
  return s.replace(/["\\]/g, '\\$&');
}
