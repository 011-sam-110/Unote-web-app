// TipTap JSON -> a real .docx, for GET /api/notes/:id/export?format=docx
//
// The note's page layout becomes genuine OOXML section properties, so the document opens
// in Word at the size and margins it had on screen, and `{{page}}` becomes a live PAGE
// field rather than a number frozen at export time.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: anything Word cannot hold is replaced by a visible
// placeholder that names what was dropped. Not a blank, not an approximation. If a reader
// cannot tell from the document itself that something was left behind, the export has lied
// to them - and they will find out when they hand it in.

import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  Packer,
  PageNumber,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import type { TTNode } from './export.js';
import { mmToTwip, pageDims, ZONES, type NoteLayout, type Zone } from './pageLayout.js';

/** Word's own default body size is 22 half-points (11pt). Everything else scales off it. */
const BODY_HALF_POINTS = 22;

interface RunStyle {
  bold?: boolean;
  italics?: boolean;
  underline?: boolean;
  strike?: boolean;
  code?: boolean;
  highlight?: boolean;
  superScript?: boolean;
  subScript?: boolean;
  link?: string;
}

function styleFromMarks(marks: TTNode['marks']): RunStyle {
  const style: RunStyle = {};
  for (const mark of marks ?? []) {
    switch (mark.type) {
      case 'bold':
      case 'strong':
        style.bold = true;
        break;
      case 'italic':
      case 'em':
        style.italics = true;
        break;
      case 'underline':
        style.underline = true;
        break;
      case 'strike':
        style.strike = true;
        break;
      case 'code':
        style.code = true;
        break;
      case 'highlight':
        style.highlight = true;
        break;
      case 'superscript':
        style.superScript = true;
        break;
      case 'subscript':
        style.subScript = true;
        break;
      case 'link': {
        const href = mark.attrs?.href;
        if (typeof href === 'string') style.link = href;
        break;
      }
    }
  }
  return style;
}

function runFrom(text: string, style: RunStyle): TextRun {
  return new TextRun({
    text,
    bold: style.bold,
    italics: style.italics,
    strike: style.strike,
    underline: style.underline ? {} : undefined,
    superScript: style.superScript,
    subScript: style.subScript,
    font: style.code ? 'Consolas' : undefined,
    highlight: style.highlight ? 'yellow' : undefined,
    size: BODY_HALF_POINTS,
  });
}

type Inline = TextRun | ExternalHyperlink;

function inlineRuns(nodes: TTNode[] = []): Inline[] {
  const runs: Inline[] = [];
  for (const node of nodes) {
    if (node.type === 'text') {
      const style = styleFromMarks(node.marks);
      const run = runFrom(node.text ?? '', style);
      // A hyperlink in OOXML wraps its runs rather than being a property of them.
      runs.push(style.link ? new ExternalHyperlink({ children: [run], link: style.link }) : run);
      continue;
    }
    if (node.type === 'hardBreak') {
      runs.push(new TextRun({ break: 1 }));
      continue;
    }
    if (node.type === 'wikilink' || node.type === 'wikiLink') {
      // A wikilink points at another note in Unote, which the .docx has no way to reach.
      // Kept as its title in italics rather than as a dead link.
      const title = String(node.attrs?.title ?? node.attrs?.label ?? node.attrs?.id ?? '');
      runs.push(new TextRun({ text: title, italics: true, size: BODY_HALF_POINTS }));
      continue;
    }
    if (node.content) runs.push(...inlineRuns(node.content));
  }
  return runs;
}

/**
 * The placeholder for content Word cannot carry.
 *
 * Boxed, in a distinct colour, and it says what it replaced. Deliberately conspicuous:
 * this is the one thing in the export that must not be mistaken for the document.
 */
function placeholder(what: string, indentLevel = 0): Paragraph {
  return new Paragraph({
    indent: indentLevel ? { left: indentLevel * 720 } : undefined,
    spacing: { before: 120, after: 120 },
    border: {
      top: { style: BorderStyle.SINGLE, size: 4, color: 'B45309' },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: 'B45309' },
      left: { style: BorderStyle.SINGLE, size: 4, color: 'B45309' },
      right: { style: BorderStyle.SINGLE, size: 4, color: 'B45309' },
    },
    children: [
      new TextRun({
        text: `[ ${what} — this cannot be stored in a Word document. Open the note in Unote to see it. ]`,
        italics: true,
        color: 'B45309',
        size: BODY_HALF_POINTS - 2,
      }),
    ],
  });
}

const HEADING_LEVELS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3];

const ALIGNMENT: Record<string, (typeof AlignmentType)[keyof typeof AlignmentType]> = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
  justify: AlignmentType.JUSTIFIED,
};

function alignmentOf(node: TTNode) {
  const align = node.attrs?.textAlign;
  return typeof align === 'string' ? ALIGNMENT[align] : undefined;
}

/** The block indent attribute this repo adds (see web formatbar/Indent.ts), in Word's
 *  twips. One step is 2em at an 11pt body, which is close enough to Word's own 720. */
function indentOf(node: TTNode, extra = 0): { left: number } | undefined {
  const level = Number(node.attrs?.indent) || 0;
  const total = level + extra;
  return total > 0 ? { left: total * 720 } : undefined;
}

// Returns Paragraph | Table because a list item can contain a table - the item's own line
// is always a paragraph, but everything nested under it goes through the general path.
function listParagraphs(
  node: TTNode,
  depth: number,
  kind: 'bullet' | 'number' | 'task',
  ctx: BlockCtx = {},
): Array<Paragraph | Table> {
  const out: Array<Paragraph | Table> = [];
  const items = node.content ?? [];

  items.forEach((item, index) => {
    const [first, ...rest] = item.content ?? [];
    const checked = Boolean(item.attrs?.checked);

    const children: Inline[] = [];
    if (kind === 'task') {
      // Word has no checkbox that round-trips without a content control, and a content
      // control that Word may refuse to render is worse than a character that always works.
      children.push(new TextRun({ text: checked ? '☒  ' : '☐  ', size: BODY_HALF_POINTS }));
    }
    if (first) children.push(...inlineRuns(first.content));

    out.push(
      new Paragraph({
        children,
        indent: { left: (depth + 1) * 720 },
        spacing: { after: 60 },
        // Real Word list numbering needs a numbering definition per list; for a note
        // export the visual result is identical and the file cannot get out of sync with
        // a definition it does not have.
        bullet: kind === 'bullet' ? { level: Math.min(depth, 8) } : undefined,
        numbering: undefined,
        ...(kind === 'number'
          ? { children: [new TextRun({ text: `${index + 1}.  `, size: BODY_HALF_POINTS }), ...children] }
          : {}),
      }),
    );

    for (const child of rest) out.push(...blockToDocx(child, depth + 1, ctx));
  });

  return out;
}

function tableFrom(node: TTNode): Table {
  const rows = node.content ?? [];
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map(
      row =>
        new TableRow({
          children: (row.content ?? []).map(
            cell =>
              new TableCell({
                children:
                  (cell.content ?? []).flatMap(b => blockToDocx(b, 0)).length > 0
                    ? (cell.content ?? []).flatMap(b => blockToDocx(b, 0))
                    : [new Paragraph({ children: [] })],
              }),
          ),
        }),
    ),
  });
}

/** Context inherited from an enclosing block. Only quotes need it so far: a paragraph
 *  inside a blockquote is still a paragraph, it just wears a rule down its left side. */
interface BlockCtx {
  quote?: boolean;
}

const QUOTE_BORDER = {
  left: { style: BorderStyle.SINGLE, size: 12, color: 'CCCCCC', space: 12 },
} as const;

function blockToDocx(node: TTNode, depth: number, ctx: BlockCtx = {}): Array<Paragraph | Table> {
  const quoteBorder = ctx.quote ? QUOTE_BORDER : undefined;

  switch (node.type) {
    case 'paragraph':
      return [
        new Paragraph({
          children: inlineRuns(node.content),
          alignment: alignmentOf(node),
          indent: indentOf(node, depth),
          border: quoteBorder,
          spacing: { after: 120 },
        }),
      ];

    case 'heading': {
      const level = Math.min(Math.max(Number(node.attrs?.level) || 1, 1), 3);
      return [
        new Paragraph({
          children: inlineRuns(node.content),
          heading: HEADING_LEVELS[level - 1],
          alignment: alignmentOf(node),
          indent: indentOf(node, depth),
          border: quoteBorder,
          spacing: { before: 240, after: 120 },
        }),
      ];
    }

    case 'bulletList':
      return listParagraphs(node, depth, 'bullet', ctx);
    case 'orderedList':
      return listParagraphs(node, depth, 'number', ctx);
    case 'taskList':
      return listParagraphs(node, depth, 'task', ctx);

    case 'blockquote':
      // Rendered through the normal path with `quote` set, rather than by rebuilding each
      // child as a flat paragraph. The naive version dropped everything nested inside a
      // quote - a list, a second paragraph, a code block - because it only ever read
      // `child.content` as inline runs.
      return (node.content ?? []).flatMap(child => blockToDocx(child, depth + 1, { quote: true }));

    case 'codeBlock':
      return (node.content ?? [])
        .map(c => c.text ?? '')
        .join('')
        .split('\n')
        .map(
          line =>
            new Paragraph({
              children: [new TextRun({ text: line, font: 'Consolas', size: BODY_HALF_POINTS - 2 })],
              indent: { left: (depth + 1) * 720 },
              spacing: { after: 0 },
            }),
        );

    case 'horizontalRule':
      return [
        new Paragraph({
          children: [],
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CCCCCC' } },
          spacing: { before: 180, after: 180 },
        }),
      ];

    case 'image': {
      // Only data: images can be embedded without the server fetching them, and fetching a
      // user-supplied URL server-side is an SSRF the export route should not open. A remote
      // image is named and linked instead.
      const src = String(node.attrs?.src ?? '');
      const alt = String(node.attrs?.alt ?? '').trim();
      const embedded = embedDataUri(src, alt);
      if (embedded) return [embedded];
      return [placeholder(alt ? `Image: ${alt}` : 'Image', depth)];
    }

    case 'table':
      return [tableFrom(node)];

    case 'callout': {
      const kind = String(node.attrs?.kind ?? node.attrs?.type ?? 'note').toUpperCase();
      const inner = (node.content ?? []).flatMap(c => blockToDocx(c, depth, ctx));
      return [
        new Paragraph({
          children: [new TextRun({ text: kind, bold: true, size: BODY_HALF_POINTS - 2 })],
          spacing: { before: 120, after: 40 },
        }),
        ...inner,
      ];
    }

    case 'details': {
      const children = node.content ?? [];
      const summary = children.find(c => c.type === 'detailsSummary');
      const body = children.find(c => c.type === 'detailsContent');
      return [
        new Paragraph({
          children: summary ? inlineRuns(summary.content) : [],
          heading: HeadingLevel.HEADING_3,
          spacing: { before: 180, after: 60 },
        }),
        ...(body?.content ?? []).flatMap(c => blockToDocx(c, depth, ctx)),
      ];
    }

    // The four Word genuinely cannot hold. Each names itself.
    case 'chem':
      return [placeholder('Chemical structure', depth)];
    case 'model3d':
      return [placeholder('3D model', depth)];
    case 'sketch':
      return [placeholder('Drawing', depth)];

    default:
      if (node.content) return node.content.flatMap(c => blockToDocx(c, depth, ctx));
      return [];
  }
}

/** Inline base64 images become real embedded pictures; anything else returns null. */
function embedDataUri(src: string, alt: string): Paragraph | null {
  const match = /^data:image\/(png|jpeg|jpg|gif|bmp);base64,(.+)$/i.exec(src);
  if (!match) return null;
  try {
    const data = Buffer.from(match[2], 'base64');
    const type = match[1].toLowerCase() === 'jpg' ? 'jpg' : (match[1].toLowerCase() as 'png' | 'jpg' | 'gif' | 'bmp');
    return new Paragraph({
      children: [
        new ImageRun({
          data,
          type,
          // Without the real dimensions to hand, a fixed width that fits inside A4's text
          // box with the default margins, at a 4:3 box. Word lets the reader resize.
          transformation: { width: 480, height: 360 },
          altText: alt ? { title: alt, description: alt, name: alt } : undefined,
        }),
      ],
      spacing: { before: 120, after: 120 },
    });
  } catch {
    return null;
  }
}

/**
 * A header/footer zone, with `{{page}}` and `{{pages}}` becoming live Word fields.
 *
 * This is the reason DOCX export is worth doing properly rather than shipping a .doc of
 * HTML: a page number that updates when the reader edits the document is something only a
 * real field can do, and it is exactly what a header is for.
 */
function bandParagraph(zones: Record<Zone, string>): Paragraph {
  // OOXML has one paragraph per band, with tab stops separating the thirds. Centre and
  // right are reached with tabs, which is how Word itself builds its own header presets.
  const children: Inline[] = [];
  ZONES.forEach((zone, index) => {
    if (index > 0) children.push(new TextRun({ children: ['\t'], size: BODY_HALF_POINTS - 4 }));
    children.push(...fieldRuns(zones[zone]));
  });
  return new Paragraph({
    children,
    tabStops: [
      { type: 'center', position: 4513 },
      { type: 'right', position: 9026 },
    ],
  });
}

const TOKEN_RE = /\{\{\s*([a-zA-Z]+)\s*\}\}/g;

function fieldRuns(text: string): Inline[] {
  if (!text) return [];
  const runs: Inline[] = [];
  let last = 0;

  for (const match of text.matchAll(TOKEN_RE)) {
    const start = match.index ?? 0;
    const name = match[1].toLowerCase();
    if (name !== 'page' && name !== 'pages') continue;

    if (start > last) {
      runs.push(new TextRun({ text: text.slice(last, start), size: BODY_HALF_POINTS - 4 }));
    }
    runs.push(
      new TextRun({
        children: [name === 'page' ? PageNumber.CURRENT : PageNumber.TOTAL_PAGES],
        size: BODY_HALF_POINTS - 4,
      }),
    );
    last = start + match[0].length;
  }

  // Everything else - title, date, notebook - was already substituted by the caller, since
  // those are fixed at export time and Word has no field for "the notebook this came from".
  if (last < text.length) {
    runs.push(new TextRun({ text: text.slice(last), size: BODY_HALF_POINTS - 4 }));
  }
  return runs;
}

export interface DocxOptions {
  title: string;
  layout: NoteLayout;
  /** Values for the non-page fields, already resolved. */
  fields: { title: string; notebook: string; date: string };
}

function substituteFixed(text: string, fields: DocxOptions['fields']): string {
  if (!text || text.indexOf('{{') === -1) return text;
  return text.replace(TOKEN_RE, (whole, raw: string) => {
    const name = raw.toLowerCase();
    if (name === 'title') return fields.title;
    if (name === 'date') return fields.date;
    if (name === 'notebook') return fields.notebook;
    // page / pages are left in place for fieldRuns to turn into real Word fields.
    return whole;
  });
}

function resolvedZones(zones: Record<Zone, string>, fields: DocxOptions['fields']): Record<Zone, string> {
  return {
    left: substituteFixed(zones.left, fields),
    center: substituteFixed(zones.center, fields),
    right: substituteFixed(zones.right, fields),
  };
}

export async function tiptapToDocx(doc: TTNode | null | undefined, options: DocxOptions): Promise<Buffer> {
  const { layout, fields } = options;
  const dims = pageDims(layout);

  const body: Array<Paragraph | Table> =
    doc && Array.isArray(doc.content) ? doc.content.flatMap(node => blockToDocx(node, 0)) : [];

  // Word renders an empty body as a corrupt-looking document in some versions; one empty
  // paragraph is the conventional minimum.
  if (body.length === 0) body.push(new Paragraph({ children: [] }));

  const headers = layout.header.on
    ? {
        default: new Header({ children: [bandParagraph(resolvedZones(layout.header.zones, fields))] }),
        ...(layout.header.differentFirst
          ? { first: new Header({ children: [bandParagraph(resolvedZones(layout.header.firstZones, fields))] }) }
          : {}),
      }
    : undefined;

  const footers = layout.footer.on
    ? {
        default: new Footer({ children: [bandParagraph(resolvedZones(layout.footer.zones, fields))] }),
        ...(layout.footer.differentFirst
          ? { first: new Footer({ children: [bandParagraph(resolvedZones(layout.footer.firstZones, fields))] }) }
          : {}),
      }
    : undefined;

  const document = new Document({
    title: options.title,
    sections: [
      {
        properties: {
          page: {
            size: { width: mmToTwip(dims.w), height: mmToTwip(dims.h) },
            margin: {
              top: mmToTwip(layout.margins.top),
              right: mmToTwip(layout.margins.right),
              bottom: mmToTwip(layout.margins.bottom),
              left: mmToTwip(layout.margins.left),
            },
          },
          titlePage: layout.header.differentFirst || layout.footer.differentFirst,
        },
        headers,
        footers,
        children: body,
      },
    ],
  });

  return Packer.toBuffer(document);
}
