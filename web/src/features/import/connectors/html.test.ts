// The fixtures here are shaped like a real Google Docs HTML export: a stylesheet at the
// top defining `.cN` classes, then spans that carry emphasis only through those classes.
// That is the case a generic HTML-to-text pass gets wrong, and losing every bold word in
// an imported essay is not a difference anyone would call cosmetic.
import { describe, it, expect } from 'vitest';
import { htmlToMarkdown, classStyleFlags } from './html';

const GOOGLE_STYLE = `<style>.c1{font-weight:400}.c3{font-weight:700}.c4{font-style:italic}.c9{color:#000}</style>`;

function gdoc(body: string, title = 'Essay draft'): string {
  return `<html><head><title>${title}</title>${GOOGLE_STYLE}</head><body class="c9"><div class="doc-content">${body}</div></body></html>`;
}

describe('classStyleFlags', () => {
  it('collects the classes a stylesheet declares bold or italic', () => {
    const doc = new DOMParser().parseFromString(gdoc(''), 'text/html');
    const flags = classStyleFlags(doc);
    expect(flags.bold.has('c3')).toBe(true);
    expect(flags.bold.has('c1')).toBe(false);
    expect(flags.italic.has('c4')).toBe(true);
  });

  it('treats a numeric weight of 600 or more as bold', () => {
    const doc = new DOMParser().parseFromString('<style>.a{font-weight:600}.b{font-weight:500}</style>', 'text/html');
    const flags = classStyleFlags(doc);
    expect(flags.bold.has('a')).toBe(true);
    expect(flags.bold.has('b')).toBe(false);
  });
});

describe('htmlToMarkdown', () => {
  it('keeps emphasis that exists only in the stylesheet', () => {
    const { markdown } = htmlToMarkdown(gdoc('<p class="c1"><span class="c1">A </span><span class="c3">bold</span><span class="c1"> claim.</span></p>'));
    expect(markdown).toBe('A **bold** claim.');
  });

  it('does not double-wrap nested spans carrying the same class', () => {
    const { markdown } = htmlToMarkdown(gdoc('<p class="c3"><span class="c3">All bold</span></p>'));
    expect(markdown).toBe('**All bold**');
  });

  it('converts headings, and does not leave a fully bold heading as ## **Title**', () => {
    const { markdown } = htmlToMarkdown(gdoc('<h1 class="c3"><span class="c3">Introduction</span></h1><h2><span class="c1">Background</span></h2>'));
    expect(markdown).toBe('# Introduction\n\n## Background');
  });

  it('converts nested lists with the right markers and indentation', () => {
    const { markdown } = htmlToMarkdown(
      gdoc('<ul><li><span class="c1">One</span><ol><li><span class="c1">Sub</span></li></ol></li><li><span class="c1">Two</span></li></ul>'),
    );
    expect(markdown).toBe('- One\n  1. Sub\n- Two');
  });

  it('converts a table to a markdown table and escapes a pipe inside a cell', () => {
    const { markdown } = htmlToMarkdown(gdoc('<table><tr><td>A</td><td>B|C</td></tr><tr><td>1</td><td>2</td></tr></table>'));
    expect(markdown).toBe('| A | B\\|C |\n| --- | --- |\n| 1 | 2 |');
  });

  it('unwraps the google.com/url redirector links are exported behind', () => {
    const { markdown } = htmlToMarkdown(
      gdoc('<p><a href="https://www.google.com/url?q=https%3A%2F%2Fexample.org%2Fpaper&amp;sa=D">the paper</a></p>'),
    );
    expect(markdown).toBe('[the paper](https://example.org/paper)');
  });

  it('reads the title from <title>', () => {
    expect(htmlToMarkdown(gdoc('<p>x</p>', 'Dissertation ch. 2')).title).toBe('Dissertation ch. 2');
  });

  it('escapes markdown syntax characters in ordinary prose', () => {
    const { markdown } = htmlToMarkdown(gdoc('<p>Use snake_case and a * for the wildcard.</p>'));
    expect(markdown).toBe('Use snake\\_case and a \\* for the wildcard.');
  });

  it('drops script and style content instead of importing it as text', () => {
    const { markdown } = htmlToMarkdown(gdoc('<p>Kept</p><script>const secret = 1;</script>'));
    expect(markdown).toBe('Kept');
  });

  it('returns empty markdown rather than throwing on input with no content', () => {
    expect(htmlToMarkdown('').markdown).toBe('');
    expect(htmlToMarkdown('<html><body></body></html>').markdown).toBe('');
  });

  it('keeps blockquotes and horizontal rules', () => {
    const { markdown } = htmlToMarkdown(gdoc('<blockquote><p>Quoted.</p></blockquote><hr><p>After.</p>'));
    expect(markdown).toBe('> Quoted.\n\n---\n\nAfter.');
  });
});
