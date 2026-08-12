// Worked examples, not snapshots.
//
// Each expectation below is a reference formatted by hand from the style's own rules for a
// source whose metadata is real, so a change to the formatter that breaks a convention
// fails here rather than in somebody's coursework. Snapshots would have recorded whatever
// the code did on the day it was written, including the mistakes.
import { describe, expect, it } from 'vitest';
import { DEFAULT_STYLE, formatInText, formatReference, missingFor, renderNames, shapeOf, STYLES } from './styles';
import type { Csl } from './types';

/** Real record, as doi.org returns it for 10.1038/nature12373 (trimmed). */
const ARTICLE: Csl = {
  type: 'journal-article',
  title: 'Nanometre-scale thermometry in a living cell',
  author: [
    { family: 'Kucsko', given: 'G.' },
    { family: 'Maurer', given: 'P. C.' },
    { family: 'Yao', given: 'N. Y.' },
    { family: 'Kubo', given: 'M.' },
  ],
  'container-title': 'Nature',
  volume: '500',
  issue: '7460',
  page: '54-58',
  issued: { 'date-parts': [[2013, 7, 31]] },
  DOI: '10.1038/nature12373',
};

/** Real record, as openlibrary.org returns it for 9780140449136 (trimmed). */
const BOOK: Csl = {
  type: 'book',
  title: 'Crime and punishment',
  author: [{ family: 'Dostoyevsky', given: 'Fyodor' }],
  publisher: 'Penguin',
  'publisher-place': 'London',
  issued: { 'date-parts': [[2003]] },
};

const WEBPAGE: Csl = {
  type: 'webpage',
  title: 'Climate change: the evidence',
  author: [{ family: 'Rowlatt', given: 'Justin' }],
  'container-title': 'BBC News',
  URL: 'https://www.bbc.co.uk/news/science-environment-56837908',
  issued: { 'date-parts': [[2021, 4, 22]] },
  accessed: { 'date-parts': [[2026, 8, 12]] },
};

const TWO_AUTHORS: Csl = {
  ...ARTICLE,
  author: [
    { family: 'Watson', given: 'James D.' },
    { family: 'Crick', given: 'Francis H. C.' },
  ],
};

describe('the style list', () => {
  it('offers the five a UK student is actually set, Harvard first', () => {
    expect(STYLES.map((s) => s.id)).toEqual(['harvard', 'apa', 'mla', 'vancouver', 'chicago']);
    expect(DEFAULT_STYLE).toBe('harvard');
  });
});

describe('names', () => {
  it('writes an organisation as it is written, never inverted into initials', () => {
    // "Organization, W. H." is how a citation tool tells a marker it was generated badly.
    const org = [{ literal: 'World Health Organization' }];
    for (const style of STYLES) expect(renderNames(org, style.id)).toBe('World Health Organization');
  });

  it('Harvard: surname then initials with no spaces, "and" before the last', () => {
    expect(renderNames(TWO_AUTHORS.author, 'harvard')).toBe('Watson, J.D. and Crick, F.H.C.');
  });

  it('Harvard: four or more authors is the first plus et al.', () => {
    expect(renderNames(ARTICLE.author, 'harvard')).toBe('Kucsko, G. et al.');
  });

  it('APA: spaced initials and an ampersand', () => {
    expect(renderNames(TWO_AUTHORS.author, 'apa')).toBe('Watson, J. D., & Crick, F. H. C.');
  });

  it('APA lists four authors rather than cutting to et al. at four', () => {
    expect(renderNames(ARTICLE.author, 'apa')).toBe('Kucsko, G., Maurer, P. C., Yao, N. Y., & Kubo, M.');
  });

  it('MLA: only the first author is inverted, and et al. arrives at three', () => {
    expect(renderNames(TWO_AUTHORS.author, 'mla')).toBe('Watson, James D., and Francis H. C. Crick');
    expect(renderNames(ARTICLE.author, 'mla')).toBe('Kucsko, G., et al.');
  });

  it('Vancouver: no full stops in initials, six before et al.', () => {
    expect(renderNames(TWO_AUTHORS.author, 'vancouver')).toBe('Watson JD, Crick FHC');
    const seven = Array.from({ length: 7 }, (_, i) => ({ family: `Author${i}`, given: 'A' }));
    expect(renderNames(seven, 'vancouver')).toBe('Author0 A, Author1 A, Author2 A, Author3 A, Author4 A, Author5 A, et al.');
  });

  it('Chicago: first inverted, "and" before the last', () => {
    expect(renderNames(TWO_AUTHORS.author, 'chicago')).toBe('Watson, James D., and Francis H. C. Crick');
  });
});

describe('shapeOf', () => {
  it("recognises Crossref's own vocabulary, not just CSL's", () => {
    expect(shapeOf({ type: 'journal-article' })).toBe('journal');
    expect(shapeOf({ type: 'article-journal' })).toBe('journal');
    expect(shapeOf({ type: 'book-chapter' })).toBe('chapter');
  });

  it('falls back on what a source HAS when the type says nothing useful', () => {
    expect(shapeOf({ 'container-title': 'Nature', volume: '500' })).toBe('journal');
    expect(shapeOf({ publisher: 'Penguin' })).toBe('book');
    expect(shapeOf({ URL: 'https://example.com' })).toBe('webpage');
  });
});

describe('reference-list entries', () => {
  it('Harvard, journal article', () => {
    expect(formatReference(ARTICLE, 'harvard')).toBe(
      "Kucsko, G. et al. (2013) 'Nanometre-scale thermometry in a living cell', Nature, 500(7460), pp. 54-58. doi: 10.1038/nature12373.",
    );
  });

  it('Harvard, book', () => {
    expect(formatReference(BOOK, 'harvard')).toBe('Dostoyevsky, F. (2003) Crime and punishment. London: Penguin.');
  });

  it('Harvard, webpage - keeps "Available at" and the accessed date', () => {
    expect(formatReference(WEBPAGE, 'harvard')).toBe(
      'Rowlatt, J. (2021) Climate change: the evidence. BBC News. Available at: https://www.bbc.co.uk/news/science-environment-56837908 (Accessed: 12 August 2026).',
    );
  });

  it('APA, journal article - DOI as a URL', () => {
    expect(formatReference(ARTICLE, 'apa')).toBe(
      'Kucsko, G., Maurer, P. C., Yao, N. Y., & Kubo, M. (2013). Nanometre-scale thermometry in a living cell. Nature, 500(7460), 54-58. https://doi.org/10.1038/nature12373',
    );
  });

  it('APA, book', () => {
    expect(formatReference(BOOK, 'apa')).toBe('Dostoyevsky, F. (2003). Crime and punishment. Penguin.');
  });

  it('MLA, journal article', () => {
    expect(formatReference(ARTICLE, 'mla')).toBe(
      'Kucsko, G., et al. "Nanometre-scale thermometry in a living cell." Nature, vol. 500, no. 7460, 2013, pp. 54-58.',
    );
  });

  it('Vancouver, journal article - no brackets on the year', () => {
    expect(formatReference(ARTICLE, 'vancouver')).toBe(
      'Kucsko G, Maurer PC, Yao NY, Kubo M. Nanometre-scale thermometry in a living cell. Nature. 2013;500(7460):54-58.',
    );
  });

  it('Chicago author-date, journal article', () => {
    expect(formatReference(ARTICLE, 'chicago')).toBe(
      'Kucsko, G. et al. 2013. "Nanometre-scale thermometry in a living cell." Nature 500 (7460): 54-58.',
    );
  });

  it('renders what it has rather than refusing, when fields are absent', () => {
    const bare: Csl = { type: 'book', title: 'A lecture nobody published' };
    const out = formatReference(bare, 'harvard');
    expect(out).toContain('A lecture nobody published');
    // No empty brackets, no stray separators, no doubled full stops.
    expect(out).not.toMatch(/\(\s*\)|,\s*,|\.\./);
  });

  it('uses each style\'s OWN convention for a missing year instead of inventing one', () => {
    const undated: Csl = { ...BOOK, issued: undefined };
    expect(formatReference(undated, 'harvard')).toContain('(no date)');
    expect(formatReference(undated, 'apa')).toContain('(n.d.)');
    expect(formatReference(undated, 'chicago')).toContain('n.d.');
  });

  it('never leaves a dangling separator for a field it does not have', () => {
    const partial: Csl = { type: 'journal-article', title: 'Something', 'container-title': 'Nature' };
    for (const style of STYLES) {
      const out = formatReference(partial, style.id);
      expect(out).not.toMatch(/,\s*,|,\s*$|\(\s*\)|\s{2,}/);
    }
  });
});

describe('in-text citations', () => {
  it('Harvard and APA differ on the ampersand', () => {
    expect(formatInText(TWO_AUTHORS, 'harvard')).toBe('(Watson and Crick, 2013)');
    expect(formatInText(TWO_AUTHORS, 'apa')).toBe('(Watson & Crick, 2013)');
  });

  it('three or more authors is et al. in the sentence', () => {
    expect(formatInText(ARTICLE, 'harvard')).toBe('(Kucsko et al., 2013)');
  });

  it('MLA carries no year, Chicago carries no comma', () => {
    expect(formatInText(TWO_AUTHORS, 'mla')).toBe('(Watson and Crick)');
    expect(formatInText(TWO_AUTHORS, 'chicago')).toBe('(Watson and Crick 2013)');
  });

  it('Vancouver is numeric, and says so rather than guessing a number', () => {
    // The number is the source's POSITION in the reference list, which one source cannot
    // know. A confident wrong number is worse than a visible gap.
    expect(formatInText(ARTICLE, 'vancouver', 4)).toBe('[4]');
    expect(formatInText(ARTICLE, 'vancouver')).toBe('[?]');
  });

  it('falls back to the title rather than to a fabricated author', () => {
    expect(formatInText({ title: 'Untitled report', issued: { 'date-parts': [[2020]] } }, 'harvard')).toBe(
      '(Untitled report, 2020)',
    );
  });
});

describe('missingFor', () => {
  it('says nothing is missing from a complete record', () => {
    expect(missingFor(ARTICLE)).toEqual([]);
    expect(missingFor(BOOK)).toEqual([]);
  });

  it('names what a reference is short of, so a tidy line cannot look finished', () => {
    expect(missingFor({ type: 'journal-article', title: 'x' })).toEqual(['author', 'journal', 'year']);
    expect(missingFor({ type: 'book', title: 'x', author: [{ family: 'a' }] })).toEqual(['year', 'publisher']);
  });

  it('asks a webpage for a link and not for a publisher', () => {
    expect(missingFor({ type: 'webpage', title: 'x' })).toEqual(['link', 'year']);
  });
});
