import { describe, expect, it } from 'vitest';
import {
  bylineFrom,
  extraFacts,
  formatContributors,
  formatDate,
  hasValue,
  parseContributors,
  parseDate,
  readField,
  splitFields,
  summaryLine,
  typeForCsl,
  writeField,
  yearOf,
} from './csl';
import type { SourceField, SourceType } from './types';

const TITLE: SourceField = { csl: 'title', label: 'Title', kind: 'text', recommended: true };
const AUTHORS: SourceField = { csl: 'author', label: 'Contributors', kind: 'contributors', recommended: true };
const ISSUED: SourceField = { csl: 'issued', label: 'Date published', kind: 'date', recommended: true };
const VOLUME: SourceField = { csl: 'volume', label: 'Volume', kind: 'text' };

const JOURNAL: SourceType = {
  id: 'journal',
  label: 'Journal article',
  cslType: 'article-journal',
  fields: [TITLE, AUTHORS, ISSUED, { csl: 'container-title', label: 'Journal', kind: 'text', recommended: true }, VOLUME],
};
const BOOK: SourceType = { id: 'book', label: 'Book', cslType: 'book', fields: [TITLE, AUTHORS, ISSUED] };
const WEBSITE: SourceType = { id: 'website', label: 'Website', cslType: 'webpage', fields: [TITLE, AUTHORS, ISSUED] };
const OTHER: SourceType = { id: 'other', label: 'Other', cslType: 'document', fields: [TITLE, AUTHORS, ISSUED] };
const TYPES = [WEBSITE, BOOK, JOURNAL, OTHER];

describe('contributors', () => {
  it('splits a personal name on the comma', () => {
    expect(parseContributors('Watson, James D.')).toEqual([{ family: 'Watson', given: 'James D.' }]);
  });

  it('keeps a name with NO comma as a literal, not as a bare family name', () => {
    // The difference between "World Health Organization" citing as itself and citing as
    // "Organization, W. H." under an author-date style.
    expect(parseContributors('World Health Organization')).toEqual([{ literal: 'World Health Organization' }]);
  });

  it('takes one contributor per line and drops blank lines', () => {
    expect(parseContributors('Watson, James\n\nCrick, Francis\n  ')).toEqual([
      { family: 'Watson', given: 'James' },
      { family: 'Crick', given: 'Francis' },
    ]);
  });

  it('round-trips: format(parse(x)) === x', () => {
    const text = 'Watson, James D.\nWorld Health Organization\nCrick, Francis';
    expect(formatContributors(parseContributors(text))).toBe(text);
  });

  it('formats a family-only entry without a trailing comma', () => {
    expect(formatContributors([{ family: 'Dostoyevsky' }])).toBe('Dostoyevsky');
  });

  it('makes a byline of surnames', () => {
    expect(bylineFrom([{ family: 'Watson' }])).toBe('Watson');
    expect(bylineFrom([{ family: 'Watson' }, { family: 'Crick' }])).toBe('Watson and Crick');
    expect(bylineFrom([{ family: 'Kucsko' }, { family: 'Maurer' }, { family: 'Yao' }])).toBe('Kucsko et al.');
    expect(bylineFrom(undefined)).toBe('');
  });
});

describe('dates', () => {
  it('parses year, year-month and full dates into date-parts', () => {
    expect(parseDate('2013')).toEqual({ 'date-parts': [[2013]] });
    expect(parseDate('2013-07')).toEqual({ 'date-parts': [[2013, 7]] });
    expect(parseDate('2013-07-25')).toEqual({ 'date-parts': [[2013, 7, 25]] });
  });

  it('keeps anything it cannot parse verbatim rather than dropping it', () => {
    expect(parseDate('Michaelmas term 2026')).toEqual({ raw: 'Michaelmas term 2026' });
  });

  it('treats an empty box as unknown', () => {
    expect(parseDate('   ')).toBeUndefined();
  });

  it('round-trips through date-parts', () => {
    for (const text of ['2013', '2013-07', '2013-07-25']) {
      expect(formatDate(parseDate(text))).toBe(text);
    }
  });

  it('reads a raw or literal date a registry supplied', () => {
    expect(formatDate({ raw: '2013-07-25' })).toBe('2013-07-25');
    expect(formatDate({ literal: 'in press' })).toBe('in press');
    expect(formatDate(undefined)).toBe('');
  });

  it('pulls the year out for the library list', () => {
    expect(yearOf({ issued: { 'date-parts': [[2013, 7, 25]] } })).toBe('2013');
    expect(yearOf({})).toBe('');
  });
});

describe('fields', () => {
  it('reads a number a registry sent for a text field', () => {
    expect(readField({ volume: 500 }, VOLUME)).toBe('500');
  });

  it('DELETES the key when a box is emptied, rather than storing an empty string', () => {
    // Load-bearing: verify.ts branches on whether a DOI is PRESENT, and an empty-string
    // title would defeat the title comparison that produces `refuted`.
    const next = writeField({ title: 'Something' }, TITLE, '   ');
    expect('title' in next).toBe(false);
  });

  it('does not mutate the object it was given', () => {
    const before = { title: 'Original' };
    writeField(before, TITLE, 'Changed');
    expect(before.title).toBe('Original');
  });

  it('writes contributors and dates in their CSL shapes', () => {
    expect(writeField({}, AUTHORS, 'Watson, James')).toEqual({ author: [{ family: 'Watson', given: 'James' }] });
    expect(writeField({}, ISSUED, '2013')).toEqual({ issued: { 'date-parts': [[2013]] } });
  });

  it('trims a text value on the way in', () => {
    expect(writeField({}, TITLE, '  Crime and punishment  ')).toEqual({ title: 'Crime and punishment' });
  });

  it('knows an empty field from a filled one', () => {
    expect(hasValue({ title: 'x' }, TITLE)).toBe(true);
    expect(hasValue({ title: '   ' }, TITLE)).toBe(false);
    expect(hasValue({}, TITLE)).toBe(false);
  });
});

describe('splitFields - the found / needed split', () => {
  it('puts supplied fields in found and absent ones in needed', () => {
    const { found, needed } = splitFields(JOURNAL, { title: 'A paper', volume: '500' });
    expect(found.map((f) => f.csl)).toEqual(['title', 'volume']);
    expect(needed.map((f) => f.csl).sort()).toEqual(['author', 'container-title', 'issued']);
  });

  it('sorts recommended fields to the top of needed', () => {
    const { needed } = splitFields(JOURNAL, { title: 'A paper' });
    // volume is the only non-recommended field of the four that are missing.
    expect(needed[needed.length - 1].csl).toBe('volume');
  });

  it('IGNORES a server-reported missing field this type does not cite', () => {
    // The server checks one fixed list of five variables for every type, so a journal
    // article always reports `publisher` missing. Asking a student for a journal's
    // publisher is a question with no right answer, and teaches them to ignore the panel.
    const { needed, reportedMissing } = splitFields(JOURNAL, { title: 'A paper' }, ['publisher', 'author']);
    expect(needed.some((f) => f.csl === 'publisher')).toBe(false);
    expect(reportedMissing.has('publisher')).toBe(false);
    expect(reportedMissing.has('author')).toBe(true);
  });

  it('reports nothing needed when the type is fully supplied', () => {
    const { needed } = splitFields(BOOK, {
      title: 'Crime and punishment',
      author: [{ literal: 'Dostoyevsky' }],
      issued: { 'date-parts': [[2003]] },
    });
    expect(needed).toEqual([]);
  });
});

describe('typeForCsl', () => {
  it("maps Crossref's `journal-article` onto the journal type", () => {
    // THE REGRESSION THIS TEST EXISTS FOR. doi.org content-negotiates through Crossref's
    // own transform, which emits Crossref's vocabulary, not CSL's: a real Nature article
    // comes back as `journal-article`, which is NOT a CSL item type. Without the alias
    // table every DOI-resolved article fell through to "Other", whose field list is
    // title/author/date/URL - so the journal, volume, issue, pages and the DOI itself were
    // stored but named nowhere on screen, and the lookup still LOOKED like it worked.
    expect(typeForCsl({ type: 'journal-article' }, TYPES)).toBe('journal');
  });

  it('maps the other registry vocabularies that are not CSL either', () => {
    expect(typeForCsl({ type: 'book-chapter' }, [...TYPES, { id: 'chapter', label: 'Chapter', cslType: 'chapter', fields: [] }])).toBe('chapter');
    expect(typeForCsl({ type: 'posted-content' }, TYPES)).toBe('journal');
  });

  it('matches a genuine CSL type directly', () => {
    expect(typeForCsl({ type: 'article-journal' }, TYPES)).toBe('journal');
    expect(typeForCsl({ type: 'webpage' }, TYPES)).toBe('website');
    expect(typeForCsl({ type: 'book' }, TYPES)).toBe('book');
  });

  it('falls back to `other` when the type is unknown or absent', () => {
    expect(typeForCsl({ type: 'chemical-substance' }, TYPES)).toBe('other');
    expect(typeForCsl({}, TYPES)).toBe('other');
  });
});

describe('extraFacts', () => {
  it('surfaces registry values the chosen type has no box for', () => {
    const facts = extraFacts(BOOK, { title: 'x', 'container-title': 'Nature', volume: '500', DOI: '10.1/x' });
    expect(facts.map((f) => f.key)).toEqual(['container-title', 'volume', 'DOI']);
    expect(facts[0].label).toBe('Published in');
  });

  it('does not repeat a field the type already shows', () => {
    const facts = extraFacts(JOURNAL, { 'container-title': 'Nature', volume: '500' });
    expect(facts).toEqual([]);
  });

  it('leaves out Crossref bulk that is not citation metadata', () => {
    const facts = extraFacts(BOOK, { reference: [{ key: 'a' }], license: [{ URL: 'x' }], score: 42 });
    expect(facts).toEqual([]);
  });

  it('joins a string array and formats a name array', () => {
    const facts = extraFacts(BOOK, { ISSN: ['0028-0836', '1476-4687'], editor: [{ family: 'Lee', given: 'Ada' }] });
    expect(facts.find((f) => f.key === 'ISSN')?.value).toBe('0028-0836, 1476-4687');
    expect(facts.find((f) => f.key === 'editor')?.value).toBe('Lee, Ada');
  });
});

describe('summaryLine', () => {
  it('reads who, where and when', () => {
    expect(
      summaryLine({
        author: [{ family: 'Kucsko' }, { family: 'Maurer' }, { family: 'Yao' }],
        'container-title': 'Nature',
        issued: { 'date-parts': [[2013, 7, 31]] },
      }),
    ).toBe('Kucsko et al. · Nature · 2013');
  });

  it('falls back to the editors when there is no author', () => {
    expect(summaryLine({ editor: [{ family: 'Lee' }] })).toBe('Lee');
  });

  it('is empty rather than a row of separators when nothing is known', () => {
    expect(summaryLine({})).toBe('');
  });
});
