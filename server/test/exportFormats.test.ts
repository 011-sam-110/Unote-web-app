// Pure renderer tests - no database, no app, no beforeAll reset. Safe to run on its own
// against a live dev database, which the DB-backed suites in this directory are not.

import { describe, expect, it } from 'vitest';
import { tiptapToPlainText } from '../src/lib/plainTextExport.js';
import { tiptapToDocx } from '../src/lib/docx.js';
import { defaultLayout, PAGE_SIZES, mmToTwip } from '../src/lib/pageLayout.js';
import type { TTNode } from '../src/lib/export.js';
import { unzipSync, strFromU8 } from 'fflate';

function doc(...content: TTNode[]): TTNode {
  return { type: 'doc', content };
}

const p = (text: string): TTNode => ({ type: 'paragraph', content: [{ type: 'text', text }] });

describe('tiptapToPlainText', () => {
  it('underlines headings rather than prefixing them with hashes', () => {
    const out = tiptapToPlainText(doc({ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Photosynthesis' }] }));
    expect(out).toContain('Photosynthesis\n==============');
    expect(out).not.toContain('#');
  });

  it('keeps list markers, because a list without them is just sentences', () => {
    const out = tiptapToPlainText(
      doc({
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [p('light stage')] },
          { type: 'listItem', content: [p('dark stage')] },
        ],
      }),
    );
    expect(out).toContain('• light stage');
    expect(out).toContain('• dark stage');
  });

  it('keeps a task list checkable', () => {
    const out = tiptapToPlainText(
      doc({
        type: 'taskList',
        content: [
          { type: 'taskItem', attrs: { checked: true }, content: [p('read chapter 4')] },
          { type: 'taskItem', attrs: { checked: false }, content: [p('write up')] },
        ],
      }),
    );
    expect(out).toContain('[x] read chapter 4');
    expect(out).toContain('[ ] write up');
  });

  it('pads table cells into columns that line up', () => {
    const cell = (text: string): TTNode => ({ type: 'tableCell', content: [p(text)] });
    const out = tiptapToPlainText(
      doc({
        type: 'table',
        content: [
          { type: 'tableRow', content: [cell('Stage'), cell('Location')] },
          { type: 'tableRow', content: [cell('Light-dependent'), cell('Thylakoid')] },
        ],
      }),
    );
    const [head, body] = out.trim().split('\n');
    // Both rows start their second column at the same offset - the whole point of the
    // padding, and the thing a naive join(' ') gets wrong.
    expect(head.indexOf('Location')).toBe(body.indexOf('Thylakoid'));
  });

  it('names content it cannot carry instead of dropping it', () => {
    const out = tiptapToPlainText(doc({ type: 'model3d', attrs: { src: 'x.glb' } }, { type: 'chem' }, { type: 'sketch' }));
    expect(out).toContain('[3D model');
    expect(out).toContain('[chemical structure');
    expect(out).toContain('[drawing');
  });

  it('returns empty string for an empty document rather than throwing', () => {
    expect(tiptapToPlainText(null)).toBe('');
    expect(tiptapToPlainText({ type: 'doc', content: [] })).toBe('');
  });
});

/** Unzip a .docx and return the main document part as a string. */
function documentXml(buffer: Buffer): string {
  const files = unzipSync(new Uint8Array(buffer));
  return strFromU8(files['word/document.xml']);
}

function partNames(buffer: Buffer): string[] {
  return Object.keys(unzipSync(new Uint8Array(buffer)));
}

const DOCX_OPTS = {
  title: 'Lecture 4',
  layout: defaultLayout(),
  fields: { title: 'Lecture 4', notebook: 'BIO2011', date: '2026-08-13' },
};

describe('tiptapToDocx', () => {
  it('produces a real zip with the parts Word requires', async () => {
    const buffer = await tiptapToDocx(doc(p('Hello')), DOCX_OPTS);
    const names = partNames(buffer);
    expect(names).toContain('word/document.xml');
    expect(names).toContain('[Content_Types].xml');
    expect(documentXml(buffer)).toContain('Hello');
  });

  it('writes the page size into the section properties, in twips', async () => {
    const layout = { ...defaultLayout(), pageSize: 'a4' as const };
    const xml = documentXml(await tiptapToDocx(doc(p('x')), { ...DOCX_OPTS, layout }));
    expect(xml).toContain(`w:w="${mmToTwip(PAGE_SIZES.a4.w)}"`);
    expect(xml).toContain(`w:h="${mmToTwip(PAGE_SIZES.a4.h)}"`);
  });

  it('swaps the axes for landscape', async () => {
    const layout = { ...defaultLayout(), orientation: 'landscape' as const };
    const xml = documentXml(await tiptapToDocx(doc(p('x')), { ...DOCX_OPTS, layout }));
    expect(xml).toContain(`w:w="${mmToTwip(PAGE_SIZES.a4.h)}"`);
    expect(xml).toContain(`w:h="${mmToTwip(PAGE_SIZES.a4.w)}"`);
  });

  it('carries an unmistakable placeholder for content Word cannot hold', async () => {
    const buffer = await tiptapToDocx(doc(p('before'), { type: 'chem' }, p('after')), DOCX_OPTS);
    const xml = documentXml(buffer);
    // The surrounding text survives...
    expect(xml).toContain('before');
    expect(xml).toContain('after');
    // ...and the gap between them SAYS it is a gap. This is the assertion that stops a
    // future refactor quietly turning a dropped node into an empty paragraph.
    expect(xml).toContain('Chemical structure');
    expect(xml).toContain('cannot be stored in a Word document');
  });

  it('emits a live PAGE field for {{page}} rather than a frozen number', async () => {
    const layout = defaultLayout();
    layout.footer.on = true;
    layout.footer.zones.right = 'Page {{page}} of {{pages}}';
    const buffer = await tiptapToDocx(doc(p('x')), { ...DOCX_OPTS, layout });

    expect(partNames(buffer).some(n => /word\/footer\d*\.xml/.test(n))).toBe(true);
    const footer = strFromU8(
      unzipSync(new Uint8Array(buffer))[partNames(buffer).find(n => /word\/footer\d*\.xml/.test(n))!],
    );
    // PAGE and NUMPAGES are Word field instructions; a number here would mean the footer
    // said "Page 1" on every page of the exported document.
    expect(footer).toContain('PAGE');
    expect(footer).toContain('NUMPAGES');
    expect(footer).toContain('Page ');
  });

  it('substitutes the fixed fields, which Word has no equivalent for', async () => {
    const layout = defaultLayout();
    layout.header.on = true;
    layout.header.zones.left = '{{title}} - {{notebook}}';
    const buffer = await tiptapToDocx(doc(p('x')), { ...DOCX_OPTS, layout });
    const headerName = partNames(buffer).find(n => /word\/header\d*\.xml/.test(n))!;
    const header = strFromU8(unzipSync(new Uint8Array(buffer))[headerName]);
    expect(header).toContain('Lecture 4');
    expect(header).toContain('BIO2011');
    expect(header).not.toContain('{{');
  });

  it('keeps content nested inside a blockquote', async () => {
    // The shape that the first implementation silently dropped: a quote whose second child
    // is a list rather than a paragraph.
    const xml = documentXml(
      await tiptapToDocx(
        doc({
          type: 'blockquote',
          content: [
            p('As Calvin put it:'),
            { type: 'bulletList', content: [{ type: 'listItem', content: [p('carbon fixation')] }] },
          ],
        }),
        DOCX_OPTS,
      ),
    );
    expect(xml).toContain('As Calvin put it:');
    expect(xml).toContain('carbon fixation');
  });

  it('survives an empty document', async () => {
    const buffer = await tiptapToDocx(doc(), DOCX_OPTS);
    expect(partNames(buffer)).toContain('word/document.xml');
  });
});
