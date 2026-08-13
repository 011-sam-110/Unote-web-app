// One menu on right-click, instead of two.
//
// The reported bug was the browser's spelling menu and our formatting toolbar appearing
// together. Suppressing our toolbar (nativeMenuSuppression) stopped them colliding; this is
// the other half - over a misspelling we take the menu over entirely, so corrections and
// formatting live in one place instead of one being reachable only from Chrome's menu.
//
// Anywhere else in the document we do NOT preventDefault. Right-click on ordinary prose must
// still give the native menu, because copy, paste, translate and inspect all live there and
// replacing them with a worse menu would be a regression dressed as a feature.
import { useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { issueAt } from './SpellPlugin';
import type { SpellIssue } from './types';
import { addCustomWord } from './dictionary';
import './spell.css';

interface MenuState {
  x: number;
  y: number;
  issue: SpellIssue;
  from: number;
  to: number;
  word: string;
}

const MAX_SUGGESTIONS = 5;

export default function SpellContextMenu({ editor }: { editor: Editor }) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const dom = editor.view.dom;

    function onContextMenu(e: MouseEvent) {
      const pos = editor.view.posAtCoords({ left: e.clientX, top: e.clientY });
      if (!pos) return;
      const hit = issueAt(editor.view, pos.pos);
      if (!hit) return; // ordinary prose - the native menu is the right menu
      e.preventDefault();
      setMenu({
        x: e.clientX,
        y: e.clientY,
        issue: hit.issue,
        from: hit.from,
        to: hit.to,
        word: editor.state.doc.textBetween(hit.from, hit.to),
      });
    }

    dom.addEventListener('contextmenu', onContextMenu);
    return () => dom.removeEventListener('contextmenu', onContextMenu);
  }, [editor]);

  useEffect(() => {
    if (!menu) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenu(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenu(null);
    }
    // Capture: a click inside the editor would otherwise move the caret before we close.
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', () => setMenu(null), { once: true });
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  if (!menu) return null;

  const suggestions = menu.issue.suggestions.slice(0, MAX_SUGGESTIONS);

  function apply(replacement: string) {
    if (!menu) return;
    editor.chain().focus().insertContentAt({ from: menu.from, to: menu.to }, replacement).run();
    setMenu(null);
  }

  async function learn() {
    if (!menu) return;
    await addCustomWord(menu.word);
    // Force a re-lint so the squiggle clears immediately rather than on the next keystroke.
    editor.commands.focus();
    setMenu(null);
  }

  // Clamp into the viewport: a menu opened near the right edge would otherwise render
  // half off-screen, which is where a right-click most often lands in a narrow tab pane.
  const style: React.CSSProperties = {
    left: Math.min(menu.x, window.innerWidth - 240),
    top: Math.min(menu.y, window.innerHeight - 220),
  };

  return (
    <div className="folio-spell-menu" style={style} ref={ref} role="menu" aria-label="Spelling">
      {suggestions.length > 0 ? (
        suggestions.map((s) => (
          <button key={s} type="button" role="menuitem" className="folio-spell-suggestion" onClick={() => apply(s)}>
            {s}
          </button>
        ))
      ) : (
        <span className="folio-spell-empty">No suggestions</span>
      )}
      <span className="folio-spell-sep" />
      <button type="button" role="menuitem" onClick={learn}>
        Add “{menu.word}” to dictionary
      </button>
      <span className="folio-spell-sep" />
      <button type="button" role="menuitem" onClick={() => { editor.chain().focus().toggleBold().run(); setMenu(null); }}>
        Bold
      </button>
      <button type="button" role="menuitem" onClick={() => { editor.chain().focus().toggleItalic().run(); setMenu(null); }}>
        Italic
      </button>
    </div>
  );
}
