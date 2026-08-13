// The formatting bar along the bottom of a note.
//
// Deliberately NOT a second copy of the top action bar. That one owns the note as an
// object - Insert, the side panels, Share, save state. This owns how the text looks, which
// is the half Word puts on its Home ribbon and Unote previously only offered through a
// selection bubble. The bubble menu stays: it is a different affordance (act on what you
// just selected, without travelling to a toolbar) and removing it would be a regression.
//
// Two rows, and the split is meaningful rather than a way to fit everything in. The top
// row acts on the SELECTION. The bottom row describes the DOCUMENT - which page you are
// on, how long it is, what shape of paper it is, and how to get it out.

import { useEffect, useState } from 'react';
import type { Editor } from '@tiptap/core';
import Icon from '../../../components/Icon';
import DropdownButton from '../DropdownButton';
import { FONT_FAMILIES, FONT_SIZES, LINE_HEIGHTS, PARAGRAPH_STYLES } from './formatOptions';
import {
  AlignCenter, AlignJustify, AlignLeft, AlignRight,
  BulletList, IndentLess, IndentMore, LineHeight, OrderedList, TaskList,
} from './FormatIcons';
import { PAGE_SIZES, PAGE_SIZE_IDS, type PageSizeId } from '../pagination/pageSizes';
import type { NoteLayout } from '../pagination/layout';
import './formatBar.css';

export interface FormatBarProps {
  editor: Editor;
  layout: NoteLayout;
  onLayoutChange: (next: NoteLayout) => void;
  pageCount: number;
  wordCount: number;
  /** False on a board, in plain mode, or on a phone - the page count hides rather than
   *  reporting a number that does not correspond to anything on screen. */
  paged: boolean;
  onExport: (format: 'pdf' | 'docx' | 'markdown' | 'text') => void;
}

export default function FormatBar(props: FormatBarProps) {
  const { editor, layout, onLayoutChange, pageCount, wordCount, paged, onExport } = props;

  // TipTap mutates the editor in place, so React has no idea a selection moved. Without
  // this subscription every button in the bar would render its state once and then lie:
  // bold would stay unlit inside bold text, and the style dropdown would stay on "Normal"
  // for the whole session.
  const [, force] = useState(0);
  useEffect(() => {
    const bump = () => force(n => n + 1);
    editor.on('selectionUpdate', bump);
    editor.on('transaction', bump);
    return () => {
      editor.off('selectionUpdate', bump);
      editor.off('transaction', bump);
    };
  }, [editor]);

  const currentStyle =
    PARAGRAPH_STYLES.find(style => style.isActive(editor))?.label ?? 'Normal';
  const currentFamily = (editor.getAttributes('textStyle').fontFamily as string) || '';
  const currentSize = (editor.getAttributes('textStyle').fontSize as string) || '';

  return (
    <div className="folio-format-bar" role="toolbar" aria-label="Formatting" data-testid="format-bar">
      <div className="folio-format-bar__row">
        <DropdownButton label={<span className="folio-fmt-value">{currentStyle}</span>}>
          {close =>
            PARAGRAPH_STYLES.map(style => (
              <button
                key={style.label}
                type="button"
                role="menuitemradio"
                aria-checked={style.isActive(editor)}
                onClick={() => {
                  style.apply(editor);
                  close();
                }}
              >
                <span className={`folio-fmt-preview folio-fmt-preview--${style.id}`}>{style.label}</span>
              </button>
            ))
          }
        </DropdownButton>

        <DropdownButton
          label={<span className="folio-fmt-value">{familyLabel(currentFamily)}</span>}
         
        >
          {close =>
            FONT_FAMILIES.map(font => (
              <button
                key={font.label}
                type="button"
                role="menuitemradio"
                aria-checked={currentFamily === font.value}
                onClick={() => {
                  if (font.value) editor.chain().focus().setFontFamily(font.value).run();
                  else editor.chain().focus().unsetFontFamily().run();
                  close();
                }}
              >
                <span style={{ fontFamily: font.value || 'inherit' }}>{font.label}</span>
              </button>
            ))
          }
        </DropdownButton>

        <DropdownButton label={<span className="folio-fmt-value">{currentSize || 'Size'}</span>}>
          {close =>
            FONT_SIZES.map(size => (
              <button
                key={size}
                type="button"
                role="menuitemradio"
                aria-checked={currentSize === size}
                onClick={() => {
                  editor.chain().focus().setFontSize(size).run();
                  close();
                }}
              >
                {size.replace('px', '')}
              </button>
            ))
          }
        </DropdownButton>

        <Sep />

        <Toggle editor={editor} mark="bold" label="Bold" shortcut="Ctrl+B">
          <b>B</b>
        </Toggle>
        <Toggle editor={editor} mark="italic" label="Italic" shortcut="Ctrl+I">
          <i>I</i>
        </Toggle>
        <Toggle editor={editor} mark="underline" label="Underline" shortcut="Ctrl+U">
          <u>U</u>
        </Toggle>
        <Toggle editor={editor} mark="strike" label="Strikethrough">
          <s>S</s>
        </Toggle>
        <Toggle editor={editor} mark="subscript" label="Subscript">
          x<sub>2</sub>
        </Toggle>
        <Toggle editor={editor} mark="superscript" label="Superscript">
          x<sup>2</sup>
        </Toggle>

        <Sep />

        <Toggle editor={editor} mark="highlight" label="Highlight">
          <Icon name="pen" size={14} />
        </Toggle>
        <button
          type="button"
          className="folio-fmt-btn"
          title="Clear formatting"
          aria-label="Clear formatting"
          onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}
        >
          <Icon name="eraser" size={14} />
        </button>

        <Sep />

        <Toggle editor={editor} node="bulletList" label="Bulleted list">
          <BulletList />
        </Toggle>
        <Toggle editor={editor} node="orderedList" label="Numbered list">
          <OrderedList />
        </Toggle>
        <Toggle editor={editor} node="taskList" label="Task list">
          <TaskList />
        </Toggle>

        <button
          type="button"
          className="folio-fmt-btn"
          title="Decrease indent (Ctrl+Shift+M)"
          aria-label="Decrease indent"
          disabled={!editor.can().outdentBlock()}
          onClick={() => editor.chain().focus().outdentBlock().run()}
        >
          <IndentLess />
        </button>
        <button
          type="button"
          className="folio-fmt-btn"
          title="Increase indent (Ctrl+M)"
          aria-label="Increase indent"
          disabled={!editor.can().indentBlock()}
          onClick={() => editor.chain().focus().indentBlock().run()}
        >
          <IndentMore />
        </button>

        <Sep />

        {(['left', 'center', 'right', 'justify'] as const).map(align => (
          <button
            key={align}
            type="button"
            className={'folio-fmt-btn' + (editor.isActive({ textAlign: align }) ? ' on' : '')}
            aria-pressed={editor.isActive({ textAlign: align })}
            title={`Align ${align}`}
            aria-label={`Align ${align}`}
            onClick={() => editor.chain().focus().setTextAlign(align).run()}
          >
            {ALIGN_GLYPHS[align]}
          </button>
        ))}

        <DropdownButton label={<LineHeight />}>
          {close =>
            LINE_HEIGHTS.map(height => (
              <button
                key={height}
                type="button"
                onClick={() => {
                  editor.chain().focus().setLineHeight(height).run();
                  close();
                }}
              >
                {height}
              </button>
            ))
          }
        </DropdownButton>
      </div>

      {/* ---------- the document, rather than the selection ---------- */}
      <div className="folio-format-bar__row folio-format-bar__status">
        {paged && (
          <span className="folio-fmt-stat" data-testid="page-count">
            {pageCount === 1 ? '1 page' : `${pageCount} pages`}
          </span>
        )}
        <span className="folio-fmt-stat">{wordCount.toLocaleString()} words</span>

        <Sep />

        <DropdownButton label={<span className="folio-fmt-value">{sizeLabel(layout)}</span>}>
          {close => (
            <>
              {PAGE_SIZE_IDS.map(id => (
                <button
                  key={id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={layout.pageSize === id}
                  onClick={() => {
                    onLayoutChange({ ...layout, pageSize: id as PageSizeId, mode: 'paged' });
                    close();
                  }}
                >
                  {PAGE_SIZES[id].label}
                  <span className="folio-fmt-dim">
                    {PAGE_SIZES[id].w} &times; {PAGE_SIZES[id].h} mm
                  </span>
                </button>
              ))}
              <hr />
              <button
                type="button"
                role="menuitemradio"
                aria-checked={layout.orientation === 'landscape'}
                onClick={() => {
                  onLayoutChange({
                    ...layout,
                    orientation: layout.orientation === 'landscape' ? 'portrait' : 'landscape',
                  });
                  close();
                }}
              >
                {layout.orientation === 'landscape' ? 'Portrait' : 'Landscape'}
              </button>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={layout.mode === 'plain'}
                onClick={() => {
                  onLayoutChange({ ...layout, mode: layout.mode === 'plain' ? 'paged' : 'plain' });
                  close();
                }}
              >
                {layout.mode === 'plain' ? 'Show pages' : 'No pages (plain)'}
              </button>
            </>
          )}
        </DropdownButton>

        <button
          type="button"
          className={'folio-fmt-btn folio-fmt-btn--wide' + (layout.header.on || layout.footer.on ? ' on' : '')}
          aria-pressed={layout.header.on || layout.footer.on}
          onClick={() => {
            const on = !(layout.header.on || layout.footer.on);
            onLayoutChange({
              ...layout,
              header: { ...layout.header, on },
              footer: { ...layout.footer, on },
            });
          }}
        >
          Header &amp; footer
        </button>

        <span className="folio-format-bar__spacer" />

        <DropdownButton
          align="right"
          label={
            <>
              <Icon name="download" size={14} /> Export
            </>
          }
         
        >
          {close => (
            <>
              <button type="button" onClick={() => { close(); onExport('pdf'); }}>
                PDF
                <span className="folio-fmt-dim">Opens your print dialog</span>
              </button>
              <button type="button" onClick={() => { close(); onExport('docx'); }}>
                Word (.docx)
                <span className="folio-fmt-dim">Keeps page setup and fields</span>
              </button>
              <button type="button" onClick={() => { close(); onExport('markdown'); }}>
                Markdown (.md)
              </button>
              <button type="button" onClick={() => { close(); onExport('text'); }}>
                Plain text (.txt)
              </button>
            </>
          )}
        </DropdownButton>
      </div>
    </div>
  );
}

/** Alignment glyphs by name, so the four buttons stay a loop rather than four copies. */
const ALIGN_GLYPHS = {
  left: <AlignLeft />,
  center: <AlignCenter />,
  right: <AlignRight />,
  justify: <AlignJustify />,
} as const;

function Sep() {
  return <span className="folio-fmt-sep" aria-hidden="true" />;
}

interface ToggleProps {
  editor: Editor;
  /** Exactly one of these. `mark` toggles an inline mark, `node` a block type. */
  mark?: string;
  node?: string;
  label: string;
  shortcut?: string;
  children: React.ReactNode;
}

function Toggle({ editor, mark, node, label, shortcut, children }: ToggleProps) {
  const name = mark ?? node ?? '';
  const active = editor.isActive(name);
  return (
    <button
      type="button"
      className={'folio-fmt-btn' + (active ? ' on' : '')}
      // aria-pressed rather than colour alone: "this text is already bold" has to be
      // available to a screen reader, not just to someone who can see the highlight.
      aria-pressed={active}
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-label={label}
      onClick={() => {
        const chain = editor.chain().focus();
        // toggleBold / toggleBulletList / ... - TipTap's naming is regular enough that a
        // lookup beats twelve near-identical props.
        const command = `toggle${name.charAt(0).toUpperCase()}${name.slice(1)}`;
        const runner = (chain as unknown as Record<string, () => { run: () => void }>)[command];
        if (typeof runner === 'function') runner.call(chain).run();
      }}
    >
      {children}
    </button>
  );
}

function familyLabel(value: string): string {
  if (!value) return 'Default';
  return FONT_FAMILIES.find(f => f.value === value)?.label ?? value.split(',')[0].replace(/["']/g, '');
}

function sizeLabel(layout: NoteLayout): string {
  if (layout.mode === 'plain') return 'No pages';
  const base = layout.pageSize === 'custom' ? 'Custom' : PAGE_SIZES[layout.pageSize].label;
  return layout.orientation === 'landscape' ? `${base} landscape` : base;
}
