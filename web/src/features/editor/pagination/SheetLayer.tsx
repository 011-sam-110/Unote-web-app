// The paper, drawn behind the text.
//
// One absolutely-positioned sheet per page, sitting underneath the single contenteditable
// that holds the whole note. Nothing in here is part of the document: the sheets are
// decoration and the header/footer bands are inputs bound to the note's layout, not to its
// content. That separation is why a header can repeat on 40 sheets without appearing 40
// times in the note, in the word count, or in a Markdown export.

import { useState } from 'react';
import type { PagePlan } from './placeBreaks';
import { sheetOffsets } from './placeBreaks';
import type { PageGeometry } from './geometry';
import { ZONES, type BandLayout, type NoteLayout, type Zone } from './layout';
import { resolveFields, type FieldValues } from './fields';

export interface SheetLayerProps {
  pages: PagePlan[];
  geometry: PageGeometry;
  layout: NoteLayout;
  /** Title, notebook and date for field resolution. Page numbers come from the loop. */
  fields: Omit<FieldValues, 'page' | 'pages'>;
  /** Null when the note is read-only (a share link, history preview): bands still render,
   *  they just are not editable. */
  onEditBand: ((band: 'header' | 'footer', zone: Zone, first: boolean, value: string) => void) | null;
}

export default function SheetLayer({ pages, geometry, layout, fields, onEditBand }: SheetLayerProps) {
  const tops = sheetOffsets(pages, geometry.pageHeightPx, geometry.gapPx);

  return (
    <div className="folio-sheet-layer">
      {pages.map((page, index) => (
        <div
          key={index}
          className={'folio-sheet' + (page.overflowPx > 0 ? ' is-overflowing' : '')}
          style={{
            top: `${tops[index]}px`,
            width: `${geometry.pageWidthPx}px`,
            height: `${geometry.pageHeightPx + page.overflowPx}px`,
          }}
        >
          {/* The paper itself carries no information, so it is hidden from the
              accessibility tree entirely - a screen reader announcing "page 1 of 40"
              forty times between paragraphs would make the note unreadable. */}
          <div className="folio-sheet__paper" aria-hidden="true" />

          {layout.header.on && (
            <Band
              kind="header"
              band={layout.header}
              geometry={geometry}
              pageNumber={index + 1}
              pageCount={pages.length}
              fields={fields}
              onEdit={onEditBand}
            />
          )}

          {layout.footer.on && (
            <Band
              kind="footer"
              band={layout.footer}
              geometry={geometry}
              pageNumber={index + 1}
              pageCount={pages.length}
              fields={fields}
              onEdit={onEditBand}
            />
          )}

          {page.overflowPx > 0 && (
            <p className="folio-sheet__overflow">
              This block is taller than one page, so it runs past the bottom.
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

interface BandProps {
  kind: 'header' | 'footer';
  band: BandLayout;
  geometry: PageGeometry;
  pageNumber: number;
  pageCount: number;
  fields: Omit<FieldValues, 'page' | 'pages'>;
  onEdit: SheetLayerProps['onEditBand'];
}

function Band({ kind, band, geometry, pageNumber, pageCount, fields, onEdit }: BandProps) {
  const isFirst = pageNumber === 1;
  const useFirst = band.differentFirst && isFirst;
  const zones = useFirst ? band.firstZones : band.zones;

  const style =
    kind === 'header'
      ? { top: `${geometry.marginTopPx}px`, height: `${geometry.headerBandPx}px` }
      : { bottom: `${geometry.marginBottomPx}px`, height: `${geometry.footerBandPx}px` };

  return (
    <div
      className={`folio-band folio-band--${kind}`}
      style={{
        ...style,
        left: `${geometry.marginLeftPx}px`,
        right: `${geometry.marginRightPx}px`,
      }}
    >
      {ZONES.map(zone => (
        <BandZone
          key={zone}
          zone={zone}
          label={`${kind === 'header' ? 'Header' : 'Footer'}, ${zone === 'center' ? 'centre' : zone}`}
          text={zones[zone]}
          values={{ ...fields, page: pageNumber, pages: pageCount }}
          onCommit={onEdit ? value => onEdit(kind, zone, useFirst, value) : null}
        />
      ))}
    </div>
  );
}

interface BandZoneProps {
  zone: Zone;
  /** Accessible name, e.g. "Footer, centre" - the visible text is the resolved value,
   *  which on an empty zone is nothing at all and on a page-number field is a bare digit. */
  label: string;
  text: string;
  values: FieldValues;
  onCommit: ((value: string) => void) | null;
}

/**
 * One third of a band.
 *
 * Shows the RESOLVED text normally and the RAW text while focused, the way a spreadsheet
 * shows a value in the cell and a formula in the bar. Without that switch, clicking into
 * the footer on sheet 3 would put the caret in the literal characters "Page 3 of 7" and
 * typing would edit a number the user cannot actually change - the field would be silently
 * replaced by whatever it happened to say on the sheet they clicked.
 */
function BandZone({ zone, label, text, values, onCommit }: BandZoneProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const resolved = resolveFields(text, values);

  if (!onCommit) {
    return <span className={`folio-band__zone folio-band__zone--${zone}`}>{resolved}</span>;
  }

  if (editing) {
    return (
      <input
        className={`folio-band__zone folio-band__zone--${zone} is-editing`}
        value={draft}
        autoFocus
        aria-label={label}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false);
          if (draft !== text) onCommit(draft);
        }}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            setDraft(text);
            setEditing(false);
          }
          // The editor below listens for plenty of single-key shortcuts; without this a
          // slash typed into a header opens the insert menu over the note.
          e.stopPropagation();
        }}
      />
    );
  }

  return (
    <button
      type="button"
      className={`folio-band__zone folio-band__zone--${zone}`}
      aria-label={resolved ? undefined : `${label} (empty)`}
      title={label}
      onClick={() => {
        setDraft(text);
        setEditing(true);
      }}
    >
      {resolved || <span className="folio-band__hint">&nbsp;</span>}
    </button>
  );
}
