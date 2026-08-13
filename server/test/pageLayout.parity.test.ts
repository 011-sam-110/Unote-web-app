// The client and the server each carry their own copy of the page-size table, because the
// server's tsc build cannot reach into the web workspace. This test is what makes that
// duplication safe.
//
// Worth stating the failure it prevents, because it is not obvious: if the two tables ever
// disagree, the note paginates to one page count on screen and a different one in the
// exported DOCX. Nobody debugging that would think to suspect a constant, and both files
// would look correct in isolation.

import { describe, expect, it } from 'vitest';
import {
  PAGE_SIZES as SERVER_SIZES,
  DEFAULT_MARGIN_MM as SERVER_MARGIN,
  MIN_PAGE_MM as SERVER_MIN,
  MAX_PAGE_MM as SERVER_MAX,
  defaultLayout as serverDefaultLayout,
  parseLayout as serverParseLayout,
  resolvePageDims as serverResolve,
  mmToTwip,
} from '../src/lib/pageLayout.js';
import {
  PAGE_SIZES as WEB_SIZES,
  MIN_PAGE_MM as WEB_MIN,
  MAX_PAGE_MM as WEB_MAX,
  resolvePageDims as webResolve,
} from '../../web/src/features/editor/pagination/pageSizes';
import {
  DEFAULT_MARGIN_MM as WEB_MARGIN,
  defaultLayout as webDefaultLayout,
  parseLayout as webParseLayout,
} from '../../web/src/features/editor/pagination/layout';

describe('page size tables agree across the two workspaces', () => {
  it('has the same set of sizes', () => {
    expect(Object.keys(SERVER_SIZES).sort()).toEqual(Object.keys(WEB_SIZES).sort());
  });

  it('has identical dimensions for every size', () => {
    expect(SERVER_SIZES).toEqual(WEB_SIZES);
  });

  it('agrees on the bounds and the default margin', () => {
    expect(SERVER_MARGIN).toBe(WEB_MARGIN);
    expect(SERVER_MIN).toBe(WEB_MIN);
    expect(SERVER_MAX).toBe(WEB_MAX);
  });

  it('resolves orientation the same way', () => {
    for (const id of Object.keys(WEB_SIZES) as Array<keyof typeof WEB_SIZES>) {
      for (const o of ['portrait', 'landscape'] as const) {
        expect(serverResolve(id, o)).toEqual(webResolve(id, o));
      }
    }
  });

  it('produces the same default layout', () => {
    expect(serverDefaultLayout()).toEqual(webDefaultLayout());
  });

  it('parses the same stored layouts the same way', () => {
    const cases = [
      null,
      '',
      'not json at all',
      '[]',
      '{}',
      '{"mode":"plain"}',
      '{"pageSize":"letter","orientation":"landscape"}',
      '{"pageSize":"nonsense"}',
      '{"pageSize":"custom","custom":{"w":100,"h":150}}',
      '{"margins":{"top":-5,"left":"12","right":null}}',
      '{"header":{"on":true,"zones":{"left":"Lecture 4","right":"{{page}}"}}}',
    ];
    for (const raw of cases) {
      expect(serverParseLayout(raw), `disagreed on: ${String(raw)}`).toEqual(webParseLayout(raw));
    }
  });
});

describe('mmToTwip', () => {
  it('converts an inch to 1440 twips', () => {
    expect(mmToTwip(25.4)).toBe(1440);
  });

  it('gives A4 the values Word writes for it', () => {
    expect(mmToTwip(210)).toBe(11906);
    expect(mmToTwip(297)).toBe(16838);
  });

  it('always returns a whole number, because Word silently ignores fractional twips', () => {
    for (const mm of [1, 3.7, 184.15, 215.9, 266.7]) {
      expect(Number.isInteger(mmToTwip(mm))).toBe(true);
    }
  });
});
