import { describe, it, expect } from 'vitest';
import { SOURCE_TYPES, sourceTypeById } from '../src/lib/references/sourceTypes.js';

describe('source type registry', () => {
  it('carries all 27 types', () => {
    expect(SOURCE_TYPES).toHaveLength(27);
  });

  it('gives every type a unique id', () => {
    const ids = SOURCE_TYPES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('maps every type to a CSL item type', () => {
    for (const t of SOURCE_TYPES) {
      expect(t.cslType, `${t.id} has no cslType`).toBeTruthy();
    }
  });

  it('gives every type at least a title field', () => {
    for (const t of SOURCE_TYPES) {
      expect(t.fields.some((f) => f.csl === 'title'), `${t.id} has no title field`).toBe(true);
    }
  });

  it('marks contributors structured, never a free-text author string', () => {
    for (const t of SOURCE_TYPES) {
      expect(t.fields.some((f) => f.csl === 'author' && f.kind === 'contributors') || t.id === 'other')
        .toBe(true);
    }
  });

  it('finds a type by id and returns undefined for an unknown one', () => {
    expect(sourceTypeById('website')?.cslType).toBe('webpage');
    expect(sourceTypeById('journal')?.cslType).toBe('article-journal');
    expect(sourceTypeById('court-case')?.cslType).toBe('legal_case');
    expect(sourceTypeById('nope')).toBeUndefined();
  });
});
