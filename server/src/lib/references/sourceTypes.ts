/**
 * What a student can cite, and how each maps onto CSL.
 *
 * 27 types, matching what the mainstream web citation tools offer. This list is affordable
 * only because of the CSL decision: the style engine already knows the formatting rules for
 * every CSL item type, so a type here is a FIELD LIST plus a MAPPING, not new formatting
 * code. Hand-rolled, 27 types across ~10 styles would have been roughly 190 rules.
 *
 * One table drives three things that would otherwise drift: the type picker, the intake form,
 * and the CSL conversion. Adding a type is an edit here and nowhere else.
 */

/** CSL item types we actually target. Not the full CSL vocabulary - only what these 27 need. */
export type CslType =
  | 'article-journal' | 'article-magazine' | 'article-newspaper' | 'book' | 'chapter'
  | 'paper-conference' | 'thesis' | 'report' | 'webpage' | 'post-weblog' | 'speech'
  | 'broadcast' | 'motion_picture' | 'song' | 'graphic' | 'interview' | 'personal_communication'
  | 'legal_case' | 'legislation' | 'entry-dictionary' | 'entry-encyclopedia' | 'manuscript'
  | 'software' | 'document';

export type FieldKind = 'text' | 'date' | 'url' | 'number' | 'contributors';

export interface SourceField {
  /** The CSL variable this field writes to. */
  csl: string;
  label: string;
  kind: FieldKind;
  /** Shown to the student as "we recommend filling this in" - never auto-filled by us. */
  recommended?: boolean;
}

export interface SourceType {
  id: string;
  label: string;
  cslType: CslType;
  fields: SourceField[];
}

/** Fields nearly every type carries. Spread, not inherited, so a type can drop one. */
const TITLE: SourceField = { csl: 'title', label: 'Title', kind: 'text', recommended: true };
const AUTHORS: SourceField = { csl: 'author', label: 'Contributors', kind: 'contributors', recommended: true };
const ISSUED: SourceField = { csl: 'issued', label: 'Date published', kind: 'date', recommended: true };
const URL_F: SourceField = { csl: 'URL', label: 'URL', kind: 'url' };
const ACCESSED: SourceField = { csl: 'accessed', label: 'Date accessed', kind: 'date' };
const PUBLISHER: SourceField = { csl: 'publisher', label: 'Publisher', kind: 'text', recommended: true };

const base = (...extra: SourceField[]): SourceField[] => [TITLE, AUTHORS, ISSUED, ...extra];
const online = (...extra: SourceField[]): SourceField[] => [...base(...extra), URL_F, ACCESSED];

export const SOURCE_TYPES: SourceType[] = [
  { id: 'website', label: 'Website', cslType: 'webpage',
    fields: online({ csl: 'container-title', label: 'Website name', kind: 'text', recommended: true },
                   { csl: 'publisher', label: 'Publisher or sponsor', kind: 'text' }) },
  { id: 'book', label: 'Book', cslType: 'book',
    fields: base(PUBLISHER, { csl: 'publisher-place', label: 'Place of publication', kind: 'text' },
                 { csl: 'edition', label: 'Edition', kind: 'text' },
                 { csl: 'ISBN', label: 'ISBN', kind: 'text' }) },
  { id: 'chapter', label: 'Chapter of an edited book', cslType: 'chapter',
    fields: base({ csl: 'container-title', label: 'Book title', kind: 'text', recommended: true },
                 { csl: 'editor', label: 'Editors', kind: 'contributors' },
                 PUBLISHER, { csl: 'page', label: 'Pages', kind: 'text' }) },
  { id: 'edited-book', label: 'Edited book', cslType: 'book',
    fields: base({ csl: 'editor', label: 'Editors', kind: 'contributors', recommended: true }, PUBLISHER) },
  { id: 'journal', label: 'Journal article', cslType: 'article-journal',
    fields: online({ csl: 'container-title', label: 'Journal', kind: 'text', recommended: true },
                   { csl: 'volume', label: 'Volume', kind: 'text' },
                   { csl: 'issue', label: 'Issue', kind: 'text' },
                   { csl: 'page', label: 'Pages', kind: 'text' },
                   { csl: 'DOI', label: 'DOI', kind: 'text' }) },
  { id: 'magazine', label: 'Magazine', cslType: 'article-magazine',
    fields: online({ csl: 'container-title', label: 'Magazine', kind: 'text', recommended: true },
                   { csl: 'page', label: 'Pages', kind: 'text' }) },
  { id: 'newspaper', label: 'Newspaper', cslType: 'article-newspaper',
    fields: online({ csl: 'container-title', label: 'Newspaper', kind: 'text', recommended: true },
                   { csl: 'page', label: 'Pages', kind: 'text' }) },
  { id: 'blog', label: 'Blog', cslType: 'post-weblog',
    fields: online({ csl: 'container-title', label: 'Blog name', kind: 'text', recommended: true }) },
  { id: 'conference', label: 'Conference proceedings', cslType: 'paper-conference',
    fields: base({ csl: 'container-title', label: 'Proceedings title', kind: 'text', recommended: true },
                 { csl: 'event-place', label: 'Location', kind: 'text' }, PUBLISHER) },
  { id: 'dissertation', label: 'Dissertation or thesis', cslType: 'thesis',
    fields: base({ csl: 'publisher', label: 'Institution', kind: 'text', recommended: true },
                 { csl: 'genre', label: 'Type (PhD, MSc)', kind: 'text' }) },
  { id: 'report', label: 'Report', cslType: 'report',
    fields: online({ csl: 'publisher', label: 'Institution', kind: 'text', recommended: true },
                   { csl: 'number', label: 'Report number', kind: 'text' }) },
  { id: 'government', label: 'Government publication', cslType: 'report',
    fields: online({ csl: 'publisher', label: 'Department', kind: 'text', recommended: true }) },
  { id: 'ebook', label: 'E-book or PDF', cslType: 'book',
    fields: online(PUBLISHER, { csl: 'ISBN', label: 'ISBN', kind: 'text' }) },
  { id: 'encyclopedia', label: 'Encyclopedia article', cslType: 'entry-encyclopedia',
    fields: online({ csl: 'container-title', label: 'Encyclopedia', kind: 'text', recommended: true }, PUBLISHER) },
  { id: 'dictionary', label: 'Dictionary entry', cslType: 'entry-dictionary',
    fields: online({ csl: 'container-title', label: 'Dictionary', kind: 'text', recommended: true }, PUBLISHER) },
  { id: 'archive', label: 'Archive material', cslType: 'manuscript',
    fields: base({ csl: 'archive', label: 'Archive', kind: 'text', recommended: true },
                 { csl: 'archive_location', label: 'Collection or reference', kind: 'text' }) },
  { id: 'artwork', label: 'Artwork', cslType: 'graphic',
    fields: base({ csl: 'archive', label: 'Gallery or collection', kind: 'text', recommended: true },
                 { csl: 'medium', label: 'Medium', kind: 'text' }) },
  { id: 'broadcast', label: 'Broadcast', cslType: 'broadcast',
    fields: base({ csl: 'container-title', label: 'Programme or series', kind: 'text', recommended: true },
                 { csl: 'publisher', label: 'Channel', kind: 'text' }) },
  { id: 'film', label: 'DVD, video or film', cslType: 'motion_picture',
    fields: online({ csl: 'director', label: 'Director', kind: 'contributors' },
                   { csl: 'publisher', label: 'Studio or distributor', kind: 'text' }) },
  { id: 'music', label: 'Music or recording', cslType: 'song',
    fields: online({ csl: 'container-title', label: 'Album', kind: 'text' },
                   { csl: 'publisher', label: 'Label', kind: 'text' }) },
  { id: 'podcast', label: 'Podcast', cslType: 'broadcast',
    fields: online({ csl: 'container-title', label: 'Podcast', kind: 'text', recommended: true }) },
  { id: 'presentation', label: 'Presentation or lecture', cslType: 'speech',
    fields: online({ csl: 'event', label: 'Event', kind: 'text' },
                   { csl: 'event-place', label: 'Location', kind: 'text' }) },
  { id: 'interview', label: 'Interview', cslType: 'interview',
    fields: base({ csl: 'container-title', label: 'Published in', kind: 'text' },
                 { csl: 'medium', label: 'Medium', kind: 'text' }) },
  { id: 'email', label: 'Email or personal communication', cslType: 'personal_communication',
    fields: [TITLE, AUTHORS, ISSUED, { csl: 'medium', label: 'Medium', kind: 'text' }] },
  { id: 'court-case', label: 'Court case', cslType: 'legal_case',
    fields: base({ csl: 'authority', label: 'Court', kind: 'text', recommended: true },
                 { csl: 'number', label: 'Case number', kind: 'text' }) },
  { id: 'software', label: 'Software', cslType: 'software',
    fields: online({ csl: 'publisher', label: 'Publisher', kind: 'text' },
                   { csl: 'version', label: 'Version', kind: 'text' }) },
  { id: 'other', label: 'Other', cslType: 'document', fields: online() },
];

const BY_ID = new Map(SOURCE_TYPES.map((t) => [t.id, t]));

export function sourceTypeById(id: string): SourceType | undefined {
  return BY_ID.get(id);
}
