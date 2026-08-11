# Referencing, Part 1: Source Library and Verification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the server-side source library — 27 source types, online resolution of DOIs, ISBNs, titles and URLs into CSL-JSON, and deterministic four-state verification — exposed as an authenticated API.

**Architecture:** Sources are stored as CSL-JSON, the format the style engine consumes directly, so no internal citation format is invented. Resolution is a set of small single-registry modules behind one `POST /api/references/resolve` endpoint that sniffs which identifier it was given. Verification is deterministic and evidence-bearing — never a language-model call — following the precedent in `server/src/lib/provenance.ts`.

**Tech Stack:** TypeScript, Express 5, PostgreSQL via `server/src/db.ts`, Zod for input validation, Vitest + Supertest for tests.

**Scope note:** This is Part 1 of two. Part 2 (`citation`/`bibliography` TipTap nodes, citeproc-js, the style picker, verdict badges, AI tools) is a separate plan and consumes the API built here. Part 1 ships working, testable software on its own: a student's sources can be added, resolved and verified via the API before any editor work exists.

## Global Constraints

- **Never fabricate a field.** A resolver returns only what a registry returned. Fields not found are absent, never guessed. This is the whole premise of the feature.
- **No new runtime data files.** `schema.sql` was once not bundled by Vercel and broke production only. Anything the server reads at runtime is either `.ts` or added to `includeFiles` in `vercel.json`.
- **Crossref polite pool.** Every outbound Crossref/OpenLibrary request sends `User-Agent: Unote-Referencing/1.0 (mailto:<FOLIO_REFERENCES_CONTACT>)`. Without a contact, throttling is unpredictable.
- **UTF-8 end to end.** Author names are not ASCII.
- **All outbound fetches of user-supplied URLs go through `safeFetch` (Task 3).** No exceptions, no direct `fetch()` on a user string anywhere in this plan.
- **`server/src/schema.sql` is a SHARED FILE** with a parallel agent (`spellcheck` on bus channel `proj`). Append at the END, inside a fenced comment block naming the feature. Ping before touching (Task 9, Step 1).
- **Do not run `npm run test -w server` without pinging the bus first** — it drops the shared local dev database.
- Branch: `feat/referencing`, already created off `main` at `44ab61c`.

---

### Task 1: Source type registry

The 27 types Sam asked for. Each maps to a CSL item type so the style engine already knows how to format it, and carries the field list its intake form renders. One table drives the picker, the form and the mapping so the three cannot drift — the same structural trick `server/src/lib/checks.ts` uses.

**Files:**
- Create: `server/src/lib/references/sourceTypes.ts`
- Test: `server/test/sourceTypes.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SOURCE_TYPES: SourceType[]`, `sourceTypeById(id: string): SourceType | undefined`, and the types `SourceType`, `SourceField`, `CslType`.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/sourceTypes.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/sourceTypes.test.ts --root server`
Expected: FAIL — `Cannot find module '../src/lib/references/sourceTypes.js'`

- [ ] **Step 3: Write the implementation**

```ts
// server/src/lib/references/sourceTypes.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/sourceTypes.test.ts --root server`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add server/src/lib/references/sourceTypes.ts server/test/sourceTypes.test.ts
git commit -m "feat(references): the 27 source types, mapped onto CSL"
```

---

### Task 2: Identifier sniffing

One input box takes a DOI, ISBN, URL or free text. The server decides which, rather than making the student classify their source before it will help — the one place the incumbent's flow is worse than it needs to be.

**Files:**
- Create: `server/src/lib/references/identify.ts`
- Test: `server/test/identify.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `identify(raw: string): Identified` where `type Identified = { kind: 'doi' | 'isbn' | 'url' | 'query'; value: string }`.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/identify.test.ts
import { describe, it, expect } from 'vitest';
import { identify } from '../src/lib/references/identify.js';

describe('identify', () => {
  it('recognises a bare DOI', () => {
    expect(identify('10.1038/nature12373')).toEqual({ kind: 'doi', value: '10.1038/nature12373' });
  });

  it('strips a doi.org prefix and the doi: scheme', () => {
    expect(identify('https://doi.org/10.1038/nature12373').value).toBe('10.1038/nature12373');
    expect(identify('doi:10.1038/nature12373').value).toBe('10.1038/nature12373');
  });

  it('recognises ISBN-13 and ISBN-10 with or without hyphens', () => {
    expect(identify('978-0-14-044913-6')).toEqual({ kind: 'isbn', value: '9780140449136' });
    expect(identify('9780140449136').kind).toBe('isbn');
    expect(identify('0140449132').kind).toBe('isbn');
  });

  it('rejects an ISBN whose check digit is wrong, treating it as a query', () => {
    expect(identify('9780140449137').kind).toBe('query');
  });

  it('recognises a URL and normalises a bare host', () => {
    expect(identify('https://www.bbc.co.uk/news/abc').kind).toBe('url');
    expect(identify('www.bbc.co.uk/news/abc')).toEqual({ kind: 'url', value: 'https://www.bbc.co.uk/news/abc' });
  });

  it('falls back to a search query for a title', () => {
    expect(identify('working memory capacity executive attention'))
      .toEqual({ kind: 'query', value: 'working memory capacity executive attention' });
  });

  it('trims surrounding whitespace before deciding', () => {
    expect(identify('   10.1038/nature12373  ').kind).toBe('doi');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/identify.test.ts --root server`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// server/src/lib/references/identify.ts
/**
 * Decide what the student pasted.
 *
 * The alternative - making them pick "Website / Book / Journal" first - is what every
 * mainstream citation tool does, and it is the step students get wrong: a PDF of a
 * government report is filed as a website about as often as not. Sniffing removes the
 * question. Where the guess is wrong the resolver still returns something editable, and
 * `query` is the honest fallback rather than a failure.
 */

export type IdentifiedKind = 'doi' | 'isbn' | 'url' | 'query';
export interface Identified {
  kind: IdentifiedKind;
  value: string;
}

/** A DOI is "10." then a registrant code, a slash, and a suffix. Deliberately permissive
 *  on the suffix - DOIs legitimately contain almost anything. */
const DOI_RE = /\b(10\.\d{4,9}\/[-._;()/:a-z0-9]+)\b/i;

/** ISBN-10 check: weighted 10..1 mod 11, where 'X' is 10. */
function isbn10Valid(s: string): boolean {
  if (!/^\d{9}[\dX]$/i.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (10 - i) * Number(s[i]);
  const last = s[9].toUpperCase();
  sum += last === 'X' ? 10 : Number(last);
  return sum % 11 === 0;
}

/** ISBN-13 check: alternating 1/3 weights mod 10. */
function isbn13Valid(s: string): boolean {
  if (!/^\d{13}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += Number(s[i]) * (i % 2 === 0 ? 1 : 3);
  return sum % 10 === 0;
}

export function identify(raw: string): Identified {
  const s = raw.trim();
  if (!s) return { kind: 'query', value: '' };

  // DOI first: a doi.org URL is a DOI, not a webpage, and resolving it as a DOI gets us
  // CSL-JSON directly instead of scraping a landing page.
  const doi = DOI_RE.exec(s);
  if (doi) return { kind: 'doi', value: doi[1].replace(/[.,;]+$/, '') };

  // ISBN: only when the check digit actually validates. A 13-digit number that fails the
  // checksum is far more likely to be a phone number or an ID than a mistyped ISBN, and
  // treating it as a query gets the student a search rather than a confusing 404.
  const digits = s.replace(/[-\s]/g, '');
  if (isbn13Valid(digits) || isbn10Valid(digits)) {
    return { kind: 'isbn', value: digits.toUpperCase() };
  }

  if (/^https?:\/\//i.test(s)) return { kind: 'url', value: s };
  // A bare host with a path or a dotted TLD, no scheme. Must not swallow "Smith, J. 2020".
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/i.test(s) && !/\s/.test(s)) {
    return { kind: 'url', value: `https://${s}` };
  }

  return { kind: 'query', value: s };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/identify.test.ts --root server`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add server/src/lib/references/identify.ts server/test/identify.test.ts
git commit -m "feat(references): sniff DOI, ISBN, URL or free text from one box"
```

---

### Task 3: SSRF-safe fetch

**This is the security gate for the whole feature and must land before any resolver that touches a user-supplied URL.** "Check the link is alive" reads as a UX nicety; it is a server-side request to an attacker-controlled string whose result is reported back to the attacker. On Vercel that reaches the cloud metadata endpoint and any internal address, so an unguarded version turns "verify my source" into an internal port scanner with the verdict text as the exfiltration channel.

**Files:**
- Create: `server/src/lib/references/safeFetch.ts`
- Test: `server/test/safeFetch.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `safeFetch(url: string, opts?: { maxBytes?: number; timeoutMs?: number }): Promise<SafeResponse>` where `interface SafeResponse { ok: boolean; status: number; finalUrl: string; body: string; contentType: string }`; and `isBlockedAddress(ip: string): boolean`; and `class SsrfBlocked extends Error`.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/safeFetch.test.ts
import { describe, it, expect } from 'vitest';
import { isBlockedAddress, safeFetch, SsrfBlocked } from '../src/lib/references/safeFetch.js';

describe('isBlockedAddress', () => {
  it('blocks loopback, private, link-local, CGNAT, multicast and reserved v4', () => {
    for (const ip of [
      '127.0.0.1', '127.9.9.9', '10.0.0.5', '172.16.0.1', '172.31.255.255',
      '192.168.1.1', '169.254.169.254', '100.64.0.1', '224.0.0.1', '0.0.0.0', '255.255.255.255',
    ]) {
      expect(isBlockedAddress(ip), `${ip} should be blocked`).toBe(true);
    }
  });

  it('blocks loopback, link-local, unique-local and mapped-v4 v6', () => {
    for (const ip of ['::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::']) {
      expect(isBlockedAddress(ip), `${ip} should be blocked`).toBe(true);
    }
  });

  it('allows ordinary public addresses', () => {
    for (const ip of ['1.1.1.1', '93.184.216.34', '2606:4700:4700::1111']) {
      expect(isBlockedAddress(ip), `${ip} should be allowed`).toBe(false);
    }
  });

  it('treats 172.32.x as public - the private block ends at 172.31', () => {
    expect(isBlockedAddress('172.32.0.1')).toBe(false);
  });
});

describe('safeFetch', () => {
  it('rejects a non-http scheme', async () => {
    await expect(safeFetch('file:///etc/passwd')).rejects.toBeInstanceOf(SsrfBlocked);
    await expect(safeFetch('gopher://example.com/')).rejects.toBeInstanceOf(SsrfBlocked);
    await expect(safeFetch('data:text/html,hi')).rejects.toBeInstanceOf(SsrfBlocked);
  });

  it('rejects a hostname that resolves to a blocked address', async () => {
    await expect(safeFetch('http://localhost/')).rejects.toBeInstanceOf(SsrfBlocked);
    await expect(safeFetch('http://127.0.0.1:8080/')).rejects.toBeInstanceOf(SsrfBlocked);
  });

  it('names the reason without echoing a response body', async () => {
    await expect(safeFetch('http://169.254.169.254/latest/meta-data/'))
      .rejects.toThrow(/blocked address/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/safeFetch.test.ts --root server`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// server/src/lib/references/safeFetch.ts
/**
 * Fetching a URL the user typed is server-side request forgery unless it is deliberately
 * closed off.
 *
 * Every guard here exists because removing it opens a specific hole:
 *  - scheme allowlist: file:/gopher:/data: read local state or bypass the network entirely
 *  - resolve-then-check: checking the HOSTNAME lets `internal.example.com -> 10.0.0.5` through
 *  - re-check per redirect: hop one is public, hop two is 169.254.169.254
 *  - connect to the CHECKED address: otherwise DNS rebinding changes the answer between the
 *    check and the connection, which is the entire point of that attack
 *  - size and time caps: an endless stream is a denial of service against our own function
 *  - no body echo: the verdict text is what the attacker reads, so it must never carry the
 *    response
 *
 * On Vercel the function can reach the cloud metadata endpoint, so the link-local block is
 * not theoretical.
 */
import dns from 'node:dns/promises';
import net from 'node:net';

export class SsrfBlocked extends Error {}

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_BYTES = 512 * 1024;

function v4Blocked(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p;
  if (a === 0 || a === 127) return true;              // this-network, loopback
  if (a === 10) return true;                          // private
  if (a === 172 && b >= 16 && b <= 31) return true;   // private
  if (a === 192 && b === 168) return true;            // private
  if (a === 169 && b === 254) return true;            // link-local, incl. cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true;  // CGNAT
  if (a === 192 && b === 0) return true;              // IETF protocol assignments
  if (a >= 224) return true;                          // multicast + reserved + broadcast
  return false;
}

function v6Blocked(raw: string): boolean {
  const ip = raw.toLowerCase();
  if (ip === '::' || ip === '::1') return true;
  if (ip.startsWith('fe80')) return true;             // link-local
  if (/^f[cd]/.test(ip)) return true;                 // unique-local
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) return v4Blocked(mapped[1]);            // v4 smuggled through v6
  return false;
}

export function isBlockedAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return v4Blocked(ip);
  if (kind === 6) return v6Blocked(ip);
  return true; // not an IP at all - fail closed
}

export interface SafeResponse {
  ok: boolean;
  status: number;
  finalUrl: string;
  body: string;
  contentType: string;
}

/** Resolve a hostname and return the addresses, all of which must pass. */
async function resolvedAddresses(hostname: string): Promise<string[]> {
  if (net.isIP(hostname)) return [hostname];
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
}

export async function safeFetch(url: string, opts: { maxBytes?: number; timeoutMs?: number } = {}): Promise<SafeResponse> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      throw new SsrfBlocked('not a valid URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new SsrfBlocked(`scheme ${parsed.protocol} is not allowed`);
    }

    let addresses: string[];
    try {
      addresses = await resolvedAddresses(parsed.hostname);
    } catch {
      throw new SsrfBlocked('hostname does not resolve');
    }
    if (!addresses.length || addresses.some(isBlockedAddress)) {
      throw new SsrfBlocked('resolves to a blocked address');
    }

    // Connect to the address we just checked, not to the name - otherwise DNS can change
    // its answer between the check and the request. Host header preserves virtual hosting.
    const pinned = new URL(parsed.toString());
    const literal = net.isIPv6(addresses[0]) ? `[${addresses[0]}]` : addresses[0];
    pinned.hostname = literal;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(pinned.toString(), {
        redirect: 'manual',
        signal: controller.signal,
        headers: { Host: parsed.host, 'User-Agent': userAgent(), Accept: 'text/html,application/xhtml+xml' },
      });
    } catch {
      clearTimeout(timer);
      throw new SsrfBlocked('request failed');
    }
    clearTimeout(timer);

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new SsrfBlocked('redirect with no location');
      current = new URL(location, parsed).toString();
      continue; // re-check the next hop from the top
    }

    const reader = res.body?.getReader();
    let body = '';
    if (reader) {
      const decoder = new TextDecoder('utf-8');
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) { await reader.cancel(); break; }
        body += decoder.decode(value, { stream: true });
      }
    }

    return {
      ok: res.ok,
      status: res.status,
      finalUrl: parsed.toString(),
      body,
      contentType: res.headers.get('content-type') ?? '',
    };
  }
  throw new SsrfBlocked('too many redirects');
}

/** Crossref's polite pool wants a contact address; without one, throttling is unpredictable. */
export function userAgent(): string {
  const contact = process.env.FOLIO_REFERENCES_CONTACT ?? '';
  return contact ? `Unote-Referencing/1.0 (mailto:${contact})` : 'Unote-Referencing/1.0';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/safeFetch.test.ts --root server`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add server/src/lib/references/safeFetch.ts server/test/safeFetch.test.ts
git commit -m "feat(references): close SSRF on user-supplied URLs before any resolver uses one"
```

---

### Task 4: DOI resolver

DOIs return **native CSL-JSON** by content negotiation at `doi.org` — measured, not assumed. That means no mapping layer for any DOI-bearing source, and it covers DataCite and mEDRA as well as Crossref because the negotiation happens at the resolver rather than at one registry. The payload carries no `id`, so we must set one.

**Files:**
- Create: `server/src/lib/references/resolvers/doi.ts`
- Test: `server/test/resolveDoi.test.ts`

**Interfaces:**
- Consumes: `userAgent()` from Task 3.
- Produces: `resolveDoi(doi: string): Promise<ResolveResult>` and the shared type `ResolveResult` (defined here, imported by Tasks 5–7):
  ```ts
  interface ResolveResult {
    found: boolean;
    csl?: Record<string, unknown>;   // CSL-JSON, no `id` guaranteed
    registry: string;                // 'doi.org' | 'openlibrary.org' | 'api.crossref.org' | 'webpage'
    missing: string[];               // CSL variables the registry did not supply
    reason?: string;                 // when found === false
  }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// server/test/resolveDoi.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveDoi } from '../src/lib/references/resolvers/doi.js';

const CSL = {
  type: 'article-journal',
  title: 'Nanometre-scale thermometry in a living cell',
  'container-title': 'Nature',
  issued: { 'date-parts': [[2013, 7, 31]] },
  author: [{ given: 'G.', family: 'Kucsko' }],
  volume: '500',
  page: '54-58',
  DOI: '10.1038/nature12373',
};

afterEach(() => vi.unstubAllGlobals());

describe('resolveDoi', () => {
  it('asks doi.org for CSL-JSON and returns it unchanged', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(CSL), {
      status: 200, headers: { 'content-type': 'application/vnd.citationstyles.csl+json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const out = await resolveDoi('10.1038/nature12373');

    expect(out.found).toBe(true);
    expect(out.registry).toBe('doi.org');
    expect(out.csl?.title).toBe('Nanometre-scale thermometry in a living cell');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://doi.org/10.1038/nature12373');
    expect((init.headers as Record<string, string>).Accept).toContain('vnd.citationstyles.csl+json');
  });

  it('reports a fabricated DOI as not found, with a reason', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Resource not found.', { status: 404 })));
    const out = await resolveDoi('10.1016/j.cell.2019.99999');
    expect(out.found).toBe(false);
    expect(out.reason).toMatch(/did not resolve/i);
  });

  it('lists fields the registry did not supply rather than inventing them', async () => {
    const partial = { type: 'article-journal', title: 'A paper', DOI: '10.1/x' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(partial), { status: 200 })));
    const out = await resolveDoi('10.1/x');
    expect(out.missing).toContain('author');
    expect(out.missing).toContain('issued');
    expect(out.csl?.author).toBeUndefined();
  });

  it('treats a network failure as unreachable, not as not-found', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ENOTFOUND'); }));
    const out = await resolveDoi('10.1/x');
    expect(out.found).toBe(false);
    expect(out.reason).toMatch(/could not reach/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/resolveDoi.test.ts --root server`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// server/src/lib/references/resolvers/doi.ts
/**
 * A DOI resolves to CSL-JSON directly, by content negotiation at doi.org.
 *
 * This was measured before it was designed around: `Accept: application/vnd.citationstyles.csl+json`
 * against https://doi.org/<doi> answers 200 with that content type and a complete CSL item.
 * Two consequences worth stating, because both remove work:
 *   - there is NO mapping layer for any DOI-bearing source; the registry speaks the format
 *     citeproc-js consumes
 *   - it is not Crossref-specific. doi.org fronts DataCite and mEDRA too, so datasets and
 *     theses with DOIs resolve through the same path
 *
 * The payload carries no `id`, which citeproc requires - the caller assigns one.
 */
import { userAgent } from '../safeFetch.js';

export interface ResolveResult {
  found: boolean;
  csl?: Record<string, unknown>;
  registry: string;
  missing: string[];
  reason?: string;
}

/** What a usable reference generally needs. Absent fields are REPORTED, never filled in. */
const WANTED = ['title', 'author', 'issued', 'container-title', 'publisher'];

export function missingFrom(csl: Record<string, unknown>): string[] {
  return WANTED.filter((k) => {
    const v = csl[k];
    return v === undefined || v === null || (Array.isArray(v) && v.length === 0) || v === '';
  });
}

export async function resolveDoi(doi: string): Promise<ResolveResult> {
  const url = `https://doi.org/${doi}`;
  let res: Response;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      headers: { Accept: 'application/vnd.citationstyles.csl+json', 'User-Agent': userAgent() },
    });
  } catch {
    return { found: false, registry: 'doi.org', missing: [], reason: 'could not reach doi.org' };
  }

  if (res.status === 404) {
    return { found: false, registry: 'doi.org', missing: [], reason: 'this DOI did not resolve' };
  }
  if (!res.ok) {
    return { found: false, registry: 'doi.org', missing: [], reason: `could not reach doi.org (${res.status})` };
  }

  let csl: Record<string, unknown>;
  try {
    csl = (await res.json()) as Record<string, unknown>;
  } catch {
    return { found: false, registry: 'doi.org', missing: [], reason: 'doi.org returned something unreadable' };
  }

  return { found: true, csl, registry: 'doi.org', missing: missingFrom(csl) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/resolveDoi.test.ts --root server`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add server/src/lib/references/resolvers/doi.ts server/test/resolveDoi.test.ts
git commit -m "feat(references): resolve DOIs to native CSL-JSON, no mapping layer"
```

---

### Task 5: ISBN resolver

OpenLibrary does **not** return author names — it returns a key. Every book costs an extra round trip per author, or the bibliography silently has no authors at all: a bug a naive implementation ships and nobody notices until a reference list is missing every name. The author record then carries two name fields, and choosing wrong puts a non-Latin script into an English reference list.

**Files:**
- Create: `server/src/lib/references/resolvers/isbn.ts`
- Test: `server/test/resolveIsbn.test.ts`

**Interfaces:**
- Consumes: `ResolveResult`, `missingFrom` (Task 4); `userAgent()` (Task 3).
- Produces: `resolveIsbn(isbn: string): Promise<ResolveResult>`.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/resolveIsbn.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveIsbn } from '../src/lib/references/resolvers/isbn.js';

const BOOK = {
  title: 'Crime and punishment',
  publishers: ['Penguin'],
  publish_date: '2003',
  number_of_pages: 671,
  authors: [{ key: '/authors/OL22242A' }],
};
const AUTHOR = { name: 'Фёдор Достоевский', personal_name: 'Fyodor Mikhaylovich Dostoyevsky' };

function stub(map: Record<string, unknown>, status = 200) {
  return vi.fn(async (url: string) => {
    const body = map[url as string];
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('resolveIsbn', () => {
  it('resolves the author key to a name rather than shipping a bibliography with none', async () => {
    vi.stubGlobal('fetch', stub({
      'https://openlibrary.org/isbn/9780140449136.json': BOOK,
      'https://openlibrary.org/authors/OL22242A.json': AUTHOR,
    }));

    const out = await resolveIsbn('9780140449136');

    expect(out.found).toBe(true);
    expect(out.csl?.author).toEqual([{ literal: 'Fyodor Mikhaylovich Dostoyevsky' }]);
  });

  it('prefers personal_name so an English reference list does not get another script', async () => {
    vi.stubGlobal('fetch', stub({
      'https://openlibrary.org/isbn/9780140449136.json': BOOK,
      'https://openlibrary.org/authors/OL22242A.json': AUTHOR,
    }));
    const out = await resolveIsbn('9780140449136');
    expect(JSON.stringify(out.csl?.author)).not.toContain('Достоевский');
  });

  it('falls back to name when personal_name is absent', async () => {
    vi.stubGlobal('fetch', stub({
      'https://openlibrary.org/isbn/9780140449136.json': BOOK,
      'https://openlibrary.org/authors/OL22242A.json': { name: 'Ursula K. Le Guin' },
    }));
    const out = await resolveIsbn('9780140449136');
    expect(out.csl?.author).toEqual([{ literal: 'Ursula K. Le Guin' }]);
  });

  it('still returns the book when an author lookup fails, and reports author missing', async () => {
    vi.stubGlobal('fetch', stub({ 'https://openlibrary.org/isbn/9780140449136.json': BOOK }));
    const out = await resolveIsbn('9780140449136');
    expect(out.found).toBe(true);
    expect(out.csl?.title).toBe('Crime and punishment');
    expect(out.missing).toContain('author');
  });

  it('reports a fabricated ISBN as not found', async () => {
    vi.stubGlobal('fetch', stub({}));
    const out = await resolveIsbn('9780000000001');
    expect(out.found).toBe(false);
    expect(out.reason).toMatch(/no book/i);
  });

  it('maps publish_date to a CSL issued date-part', async () => {
    vi.stubGlobal('fetch', stub({
      'https://openlibrary.org/isbn/9780140449136.json': BOOK,
      'https://openlibrary.org/authors/OL22242A.json': AUTHOR,
    }));
    const out = await resolveIsbn('9780140449136');
    expect(out.csl?.issued).toEqual({ 'date-parts': [[2003]] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/resolveIsbn.test.ts --root server`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// server/src/lib/references/resolvers/isbn.ts
/**
 * Books, via OpenLibrary.
 *
 * Two things here were found by calling the API rather than reading about it, and both are
 * the kind of bug that ships silently:
 *
 * 1. OpenLibrary DOES NOT RETURN AUTHOR NAMES. `/isbn/<isbn>.json` gives
 *    `authors: [{ key: '/authors/OL22242A' }]`. Skip the second request and every book in
 *    the bibliography has no author at all - and nothing errors, so nobody notices until a
 *    reference list is handed in.
 * 2. THE AUTHOR RECORD HAS TWO NAMES. `name` is in the author's own script (Cyrillic, for
 *    the record this was found on) and `personal_name` is the Latin form. Taking `name`
 *    puts another script into an English Harvard reference list - silently wrong output
 *    rather than a crash, which is the harder failure to catch.
 *
 * Unlike a DOI this is NOT CSL-JSON, so there is a mapping. It is deliberately small: only
 * fields OpenLibrary actually supplies are written, and anything absent is reported through
 * `missing` rather than filled in.
 */
import { userAgent } from '../safeFetch.js';
import { missingFrom, type ResolveResult } from './doi.js';

interface OlBook {
  title?: string;
  subtitle?: string;
  publishers?: string[];
  publish_date?: string;
  publish_places?: string[];
  number_of_pages?: number;
  authors?: { key: string }[];
}

async function getJson<T>(url: string): Promise<T | undefined> {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': userAgent() } });
    if (!res.ok) return undefined;
    return (await res.json()) as T;
  } catch {
    return undefined;
  }
}

/** OpenLibrary dates are free text ("2003", "March 2003", "2003-03-01"). Only the year is
 *  reliable across the corpus, and a year is what every style needs, so that is all we take. */
function issuedFrom(raw?: string): { 'date-parts': number[][] } | undefined {
  if (!raw) return undefined;
  const year = /(\d{4})/.exec(raw);
  return year ? { 'date-parts': [[Number(year[1])]] } : undefined;
}

export async function resolveIsbn(isbn: string): Promise<ResolveResult> {
  const registry = 'openlibrary.org';
  const book = await getJson<OlBook>(`https://openlibrary.org/isbn/${isbn}.json`);
  if (!book) {
    return { found: false, registry, missing: [], reason: 'no book with this ISBN' };
  }

  // One request per author. Sequential would be N round trips on a multi-author book.
  const authors: { literal: string }[] = [];
  for (const ref of book.authors ?? []) {
    const rec = await getJson<{ name?: string; personal_name?: string }>(`https://openlibrary.org${ref.key}.json`);
    const name = rec?.personal_name ?? rec?.name;
    if (name) authors.push({ literal: name });
  }

  const csl: Record<string, unknown> = { type: 'book', ISBN: isbn };
  const title = [book.title, book.subtitle].filter(Boolean).join(': ');
  if (title) csl.title = title;
  if (authors.length) csl.author = authors;
  const issued = issuedFrom(book.publish_date);
  if (issued) csl.issued = issued;
  if (book.publishers?.length) csl.publisher = book.publishers[0];
  if (book.publish_places?.length) csl['publisher-place'] = book.publish_places[0];
  if (book.number_of_pages) csl['number-of-pages'] = String(book.number_of_pages);

  return { found: true, csl, registry, missing: missingFrom(csl) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/resolveIsbn.test.ts --root server`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add server/src/lib/references/resolvers/isbn.ts server/test/resolveIsbn.test.ts
git commit -m "feat(references): resolve ISBNs, including the author names OpenLibrary hides behind a key"
```

---

### Task 6: Title search

A student who has only a title still needs a verifiable source. Crossref's bibliographic search returns candidates with their DOIs, so a title search becomes a DOI — which then verifies like any other.

**Files:**
- Create: `server/src/lib/references/resolvers/search.ts`
- Test: `server/test/resolveSearch.test.ts`

**Interfaces:**
- Consumes: `userAgent()` (Task 3).
- Produces: `searchWorks(query: string, rows?: number): Promise<Candidate[]>` where `interface Candidate { title: string; year?: number; authors: string[]; doi: string; containerTitle?: string }`.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/resolveSearch.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { searchWorks } from '../src/lib/references/resolvers/search.js';

const PAYLOAD = {
  message: {
    'total-results': 1431102,
    items: [
      { DOI: '10.1111/1467-8721.00160', title: ['Working Memory Capacity as Executive Attention'],
        author: [{ given: 'Randall W.', family: 'Engle' }], issued: { 'date-parts': [[2002, 2]] },
        'container-title': ['Current Directions in Psychological Science'] },
      { DOI: '10.21236/ada422215', title: ['Individual Differences in Working Memory Capacity'],
        author: [{ family: 'Engle' }], issued: { 'date-parts': [[2004, 2, 18]] } },
    ],
  },
};

afterEach(() => vi.unstubAllGlobals());

describe('searchWorks', () => {
  it('returns candidates with a DOI so a title becomes verifiable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(PAYLOAD), { status: 200 })));
    const out = await searchWorks('working memory capacity executive attention');
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      title: 'Working Memory Capacity as Executive Attention',
      year: 2002,
      doi: '10.1111/1467-8721.00160',
      containerTitle: 'Current Directions in Psychological Science',
    });
    expect(out[0].authors).toEqual(['Randall W. Engle']);
  });

  it('sends the query as query.bibliographic and caps rows', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(PAYLOAD), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await searchWorks('some title', 5);
    const url = String((fetchMock.mock.calls[0] as [string])[0]);
    expect(url).toContain('query.bibliographic=some+title');
    expect(url).toContain('rows=5');
  });

  it('returns an empty list rather than throwing when the registry is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await searchWorks('anything')).toEqual([]);
  });

  it('drops a candidate with no DOI, since it could never be verified', async () => {
    const noDoi = { message: { items: [{ title: ['Untraceable'], author: [] }] } };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(noDoi), { status: 200 })));
    expect(await searchWorks('x')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/resolveSearch.test.ts --root server`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// server/src/lib/references/resolvers/search.ts
/**
 * Title search, so "I only know what it's called" still ends in a verifiable source.
 *
 * Every candidate MUST carry a DOI. A candidate without one cannot be verified later, and
 * offering it would produce exactly the citation this feature exists to prevent: one that
 * looks confirmed because it came out of a search box. Dropping them is the honest choice.
 */
import { userAgent } from '../safeFetch.js';

export interface Candidate {
  title: string;
  year?: number;
  authors: string[];
  doi: string;
  containerTitle?: string;
}

interface CrossrefItem {
  DOI?: string;
  title?: string[];
  author?: { given?: string; family?: string }[];
  issued?: { 'date-parts'?: number[][] };
  'container-title'?: string[];
}

export async function searchWorks(query: string, rows = 5): Promise<Candidate[]> {
  const url = new URL('https://api.crossref.org/works');
  url.searchParams.set('query.bibliographic', query);
  url.searchParams.set('rows', String(Math.min(Math.max(rows, 1), 20)));
  url.searchParams.set('select', 'DOI,title,author,issued,container-title');

  let payload: { message?: { items?: CrossrefItem[] } };
  try {
    const res = await fetch(url.toString(), { headers: { Accept: 'application/json', 'User-Agent': userAgent() } });
    if (!res.ok) return [];
    payload = (await res.json()) as typeof payload;
  } catch {
    return [];
  }

  return (payload.message?.items ?? [])
    .filter((it): it is CrossrefItem & { DOI: string } => Boolean(it.DOI))
    .map((it) => ({
      title: it.title?.[0] ?? '(untitled)',
      year: it.issued?.['date-parts']?.[0]?.[0],
      authors: (it.author ?? []).map((a) => [a.given, a.family].filter(Boolean).join(' ')).filter(Boolean),
      doi: it.DOI,
      containerTitle: it['container-title']?.[0],
    }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/resolveSearch.test.ts --root server`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add server/src/lib/references/resolvers/search.ts server/test/resolveSearch.test.ts
git commit -m "feat(references): title search that only offers candidates with a DOI"
```

---

### Task 7: Webpage resolver

The type most students cite and the only one with no registry behind it. Metadata comes from the page itself, through `safeFetch` — never a direct `fetch`.

**Files:**
- Create: `server/src/lib/references/resolvers/webpage.ts`
- Test: `server/test/resolveWebpage.test.ts`

**Interfaces:**
- Consumes: `safeFetch`, `SsrfBlocked` (Task 3); `ResolveResult`, `missingFrom` (Task 4).
- Produces: `resolveWebpage(url: string, now?: Date): Promise<ResolveResult>`.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/resolveWebpage.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';

const safeFetchMock = vi.fn();
vi.mock('../src/lib/references/safeFetch.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/references/safeFetch.js')>(
    '../src/lib/references/safeFetch.js',
  );
  return { ...actual, safeFetch: safeFetchMock };
});

const { resolveWebpage } = await import('../src/lib/references/resolvers/webpage.js');
const { SsrfBlocked } = await import('../src/lib/references/safeFetch.js');

const HTML = `<!doctype html><html><head>
  <title>Fallback title</title>
  <meta property="og:title" content="Climate change: the evidence">
  <meta property="og:site_name" content="BBC News">
  <meta property="article:published_time" content="2021-04-22T10:00:00Z">
  <meta name="author" content="Matt McGrath">
</head><body></body></html>`;

afterEach(() => vi.clearAllMocks());

describe('resolveWebpage', () => {
  it('prefers og:title over the document title', async () => {
    safeFetchMock.mockResolvedValue({ ok: true, status: 200, finalUrl: 'https://bbc.co.uk/n', body: HTML, contentType: 'text/html' });
    const out = await resolveWebpage('https://bbc.co.uk/n', new Date('2026-08-12T00:00:00Z'));
    expect(out.found).toBe(true);
    expect(out.csl?.title).toBe('Climate change: the evidence');
    expect(out.csl?.['container-title']).toBe('BBC News');
    expect(out.csl?.author).toEqual([{ literal: 'Matt McGrath' }]);
    expect(out.csl?.issued).toEqual({ 'date-parts': [[2021, 4, 22]] });
  });

  it('always stamps date accessed, because that is a fact about us not the page', async () => {
    safeFetchMock.mockResolvedValue({ ok: true, status: 200, finalUrl: 'https://x.com/', body: '<html></html>', contentType: 'text/html' });
    const out = await resolveWebpage('https://x.com/', new Date('2026-08-12T00:00:00Z'));
    expect(out.csl?.accessed).toEqual({ 'date-parts': [[2026, 8, 12]] });
  });

  it('reports the fields it could not find instead of inventing them', async () => {
    safeFetchMock.mockResolvedValue({ ok: true, status: 200, finalUrl: 'https://x.com/', body: '<html><head><title>Just a title</title></head></html>', contentType: 'text/html' });
    const out = await resolveWebpage('https://x.com/');
    expect(out.csl?.title).toBe('Just a title');
    expect(out.missing).toEqual(expect.arrayContaining(['author', 'issued']));
    expect(out.csl?.author).toBeUndefined();
  });

  it('surfaces an SSRF block as not-found with a safe reason', async () => {
    safeFetchMock.mockRejectedValue(new SsrfBlocked('resolves to a blocked address'));
    const out = await resolveWebpage('http://169.254.169.254/');
    expect(out.found).toBe(false);
    expect(out.reason).toMatch(/cannot be fetched/i);
    expect(out.reason).not.toMatch(/169\.254/);
  });

  it('treats a 404 page as not found', async () => {
    safeFetchMock.mockResolvedValue({ ok: false, status: 404, finalUrl: 'https://x.com/', body: '', contentType: 'text/html' });
    const out = await resolveWebpage('https://x.com/');
    expect(out.found).toBe(false);
    expect(out.reason).toMatch(/404/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/resolveWebpage.test.ts --root server`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// server/src/lib/references/resolvers/webpage.ts
/**
 * Websites: the type students cite most and the only one with no registry behind it.
 *
 * Metadata comes from the page's own head. That makes the quality variable, which is
 * exactly why the "what we found / what we still need" split matters more here than
 * anywhere else - a page that publishes no author gets `author` in `missing`, not a
 * plausible guess.
 *
 * All fetching goes through safeFetch. This module must never call `fetch` directly: the
 * URL is user-supplied by definition, and this is the one resolver where that is true.
 */
import { safeFetch, SsrfBlocked } from '../safeFetch.js';
import { missingFrom, type ResolveResult } from './doi.js';

function meta(html: string, attr: 'property' | 'name', key: string): string | undefined {
  const re = new RegExp(`<meta[^>]+${attr}=["']${key}["'][^>]*content=["']([^"']+)["']`, 'i');
  const alt = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*${attr}=["']${key}["']`, 'i');
  return re.exec(html)?.[1] ?? alt.exec(html)?.[1];
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .trim();
}

function dateParts(d: Date): { 'date-parts': number[][] } {
  return { 'date-parts': [[d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]] };
}

export async function resolveWebpage(url: string, now: Date = new Date()): Promise<ResolveResult> {
  const registry = 'webpage';
  let res;
  try {
    res = await safeFetch(url);
  } catch (err) {
    // Deliberately does NOT include the message: an SSRF reason can name an internal
    // address, and the verdict text is what an attacker reads back.
    if (err instanceof SsrfBlocked) {
      return { found: false, registry, missing: [], reason: 'that link cannot be fetched' };
    }
    return { found: false, registry, missing: [], reason: 'that link cannot be fetched' };
  }

  if (!res.ok) {
    return { found: false, registry, missing: [], reason: `the page returned ${res.status}` };
  }

  const html = res.body;
  const title =
    meta(html, 'property', 'og:title') ??
    meta(html, 'name', 'twitter:title') ??
    /<title[^>]*>([^<]+)<\/title>/i.exec(html)?.[1];
  const site = meta(html, 'property', 'og:site_name');
  const author = meta(html, 'name', 'author') ?? meta(html, 'property', 'article:author');
  const published =
    meta(html, 'property', 'article:published_time') ??
    meta(html, 'name', 'date') ??
    meta(html, 'property', 'og:published_time');

  const csl: Record<string, unknown> = { type: 'webpage', URL: res.finalUrl };
  if (title) csl.title = decodeEntities(title);
  if (site) csl['container-title'] = decodeEntities(site);
  if (author) csl.author = [{ literal: decodeEntities(author) }];
  if (published) {
    const d = new Date(published);
    if (!Number.isNaN(d.getTime())) csl.issued = dateParts(d);
  }
  // Accessed is a fact about US, not about the page, so it is always known and always set.
  csl.accessed = dateParts(now);

  return { found: true, csl, registry, missing: missingFrom(csl) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/resolveWebpage.test.ts --root server`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add server/src/lib/references/resolvers/webpage.ts server/test/resolveWebpage.test.ts
git commit -m "feat(references): read webpage metadata through the SSRF guard"
```

---

### Task 8: The verdict engine

The four states. This is the module that must never guess: it compares what the student has against what a registry returned, and says which of four things is true, with the evidence attached.

**Files:**
- Create: `server/src/lib/references/verify.ts`
- Test: `server/test/verifyCitation.test.ts`

**Interfaces:**
- Consumes: `resolveDoi` (Task 4), `resolveIsbn` (Task 5), `resolveWebpage` (Task 7).
- Produces: `verifySource(csl: Record<string, unknown>, now?: Date): Promise<Verdict>` where
  ```ts
  type VerdictState = 'verified' | 'unconfirmed' | 'refuted' | 'unreachable';
  interface Verdict { state: VerdictState; registry: string | null; evidence: string; checkedAt: string }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// server/test/verifyCitation.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const resolveDoi = vi.fn();
const resolveIsbn = vi.fn();
const resolveWebpage = vi.fn();
vi.mock('../src/lib/references/resolvers/doi.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/references/resolvers/doi.js')>(
    '../src/lib/references/resolvers/doi.js',
  );
  return { ...actual, resolveDoi };
});
vi.mock('../src/lib/references/resolvers/isbn.js', () => ({ resolveIsbn }));
vi.mock('../src/lib/references/resolvers/webpage.js', () => ({ resolveWebpage }));

const { verifySource } = await import('../src/lib/references/verify.js');

beforeEach(() => vi.clearAllMocks());

describe('verifySource', () => {
  it('is UNCONFIRMED when there is no identifier to resolve against', async () => {
    const v = await verifySource({ type: 'book', title: 'Some lecture handout' });
    expect(v.state).toBe('unconfirmed');
    expect(v.registry).toBeNull();
    expect(v.evidence).toMatch(/nothing to check against/i);
    expect(resolveDoi).not.toHaveBeenCalled();
  });

  it('is VERIFIED when the DOI resolves and the title agrees', async () => {
    resolveDoi.mockResolvedValue({ found: true, registry: 'doi.org', missing: [],
      csl: { title: 'Nanometre-scale thermometry in a living cell', issued: { 'date-parts': [[2013]] } } });
    const v = await verifySource({ DOI: '10.1038/nature12373', title: 'Nanometre-scale thermometry in a living cell' });
    expect(v.state).toBe('verified');
    expect(v.registry).toBe('doi.org');
  });

  it('is REFUTED when the DOI does not resolve', async () => {
    resolveDoi.mockResolvedValue({ found: false, registry: 'doi.org', missing: [], reason: 'this DOI did not resolve' });
    const v = await verifySource({ DOI: '10.1016/j.cell.2019.99999', title: 'Anything' });
    expect(v.state).toBe('refuted');
    expect(v.evidence).toMatch(/did not resolve/i);
  });

  it('is REFUTED when the registry record contradicts the title', async () => {
    resolveDoi.mockResolvedValue({ found: true, registry: 'doi.org', missing: [],
      csl: { title: 'A completely different paper about geology' } });
    const v = await verifySource({ DOI: '10.1/x', title: 'Working memory capacity as executive attention' });
    expect(v.state).toBe('refuted');
    expect(v.evidence).toMatch(/different title/i);
  });

  it('is UNREACHABLE, never REFUTED, when the registry could not be reached', async () => {
    resolveDoi.mockResolvedValue({ found: false, registry: 'doi.org', missing: [], reason: 'could not reach doi.org' });
    const v = await verifySource({ DOI: '10.1/x', title: 'Anything' });
    expect(v.state).toBe('unreachable');
    expect(v.state).not.toBe('refuted');
  });

  it('tolerates punctuation, case and subtitle differences in the title', async () => {
    resolveDoi.mockResolvedValue({ found: true, registry: 'doi.org', missing: [],
      csl: { title: 'Working Memory Capacity as Executive Attention' } });
    const v = await verifySource({ DOI: '10.1/x', title: 'working memory capacity as executive attention.' });
    expect(v.state).toBe('verified');
  });

  it('stamps checkedAt as an ISO instant so a stored verdict states its own age', async () => {
    const v = await verifySource({ title: 'no identifier' }, new Date('2026-08-12T09:30:00Z'));
    expect(v.checkedAt).toBe('2026-08-12T09:30:00.000Z');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/verifyCitation.test.ts --root server`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// server/src/lib/references/verify.ts
/**
 * Is this source real?
 *
 * DELIBERATELY NOT A LANGUAGE-MODEL CHECK. `server/src/lib/checks.ts` runs one model request
 * per family, so putting a citation check in that catalogue would ask a language model
 * whether a reference exists - asking the fabrication engine to audit its own output, and
 * rendering the answer in a rail students already trust. It would clear invented papers and
 * flag real ones, confidently, in both directions. This resolves against registries instead,
 * following server/src/lib/provenance.ts, which already validates citations deterministically.
 *
 * Four states, and the distinctions between them are the feature:
 *   VERIFIED    a registry answered and its record agrees
 *   UNCONFIRMED nothing to check against, or nothing to compare. NOT an error, and the most
 *               common state by far - most student sources carry no DOI or ISBN
 *   REFUTED     the registry actively contradicts it. The only state that asserts a problem
 *   UNREACHABLE we could not ask. NEVER downgrade this to REFUTED: "your source is fake" and
 *               "I have no signal" are different claims, and conflating them tells a student
 *               their real source is invented because a train went into a tunnel
 */
import { resolveDoi } from './resolvers/doi.js';
import { resolveIsbn } from './resolvers/isbn.js';
import { resolveWebpage } from './resolvers/webpage.js';

export type VerdictState = 'verified' | 'unconfirmed' | 'refuted' | 'unreachable';

export interface Verdict {
  state: VerdictState;
  /** Which registry answered, or null when none was asked. */
  registry: string | null;
  /** Human-readable, falsifiable, and safe to show. Never contains a response body. */
  evidence: string;
  checkedAt: string;
}

/** A reason that means "we could not ask", as opposed to "the answer was no". */
function isUnreachableReason(reason?: string): boolean {
  return Boolean(reason && /could not reach|cannot be fetched|unreadable/i.test(reason));
}

/** Compare titles the way a human would: ignore case, punctuation, and a trailing subtitle. */
function titlesAgree(a: string, b: string): boolean {
  const norm = (s: string) =>
    s.toLowerCase().split(':')[0].replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return true; // nothing to disagree about
  if (x === y) return true;
  // One being a prefix of the other covers "Title" vs "Title: A Subtitle".
  return x.startsWith(y) || y.startsWith(x);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

export async function verifySource(csl: Record<string, unknown>, now: Date = new Date()): Promise<Verdict> {
  const checkedAt = now.toISOString();
  const doi = str(csl.DOI);
  const isbn = str(csl.ISBN);
  const url = str(csl.URL);
  const claimedTitle = str(csl.title);

  if (!doi && !isbn && !url) {
    return {
      state: 'unconfirmed',
      registry: null,
      evidence: 'No DOI, ISBN or link on this source, so there is nothing to check against.',
      checkedAt,
    };
  }

  const result = doi
    ? await resolveDoi(doi)
    : isbn
      ? await resolveIsbn(isbn)
      : await resolveWebpage(url!, now);

  if (!result.found) {
    if (isUnreachableReason(result.reason)) {
      return {
        state: 'unreachable',
        registry: result.registry,
        evidence: `Could not check this source: ${result.reason}.`,
        checkedAt,
      };
    }
    return {
      state: 'refuted',
      registry: result.registry,
      evidence: `${result.registry}: ${result.reason ?? 'no record found'}.`,
      checkedAt,
    };
  }

  const foundTitle = str(result.csl?.title);
  if (claimedTitle && foundTitle && !titlesAgree(claimedTitle, foundTitle)) {
    return {
      state: 'refuted',
      registry: result.registry,
      evidence: `${result.registry} has this identifier under a different title: "${foundTitle}".`,
      checkedAt,
    };
  }

  // Found, and nothing contradicts it. If there was no title to compare we still only got
  // here because an identifier resolved, which is a real check.
  return {
    state: 'verified',
    registry: result.registry,
    evidence: foundTitle
      ? `${result.registry} confirms this record: "${foundTitle}".`
      : `${result.registry} has a record for this identifier.`,
    checkedAt,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/verifyCitation.test.ts --root server`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add server/src/lib/references/verify.ts server/test/verifyCitation.test.ts
git commit -m "feat(references): four-state deterministic verification with evidence"
```

---

### Task 9: Schema

**`server/src/schema.sql` is shared with the parallel `spellcheck` agent.** Announce before editing, append at the very end inside a fenced block.

**Files:**
- Modify: `server/src/schema.sql` (append at end only)
- Test: `server/test/referencesSchema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: tables `sources`, `citations`, `source_verdicts`.

- [ ] **Step 1: Announce on the bus BEFORE editing**

```bash
python "$HOME/.claude/bus/bus.py" --channel proj send --from b --to spellcheck \
  "B: about to append the references block to the END of server/src/schema.sql (tables sources, citations, source_verdicts). Fenced comment block, nothing above it touched. Shout now if you are mid-edit."
```

- [ ] **Step 2: Write the failing test**

```ts
// server/test/referencesSchema.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '../src/db.js';
import { resetDatabase, closeDatabase } from './helpers.js';

beforeAll(async () => { await resetDatabase(); });
afterAll(async () => { await closeDatabase(); });

async function columns(table: string): Promise<string[]> {
  const rows = await db
    .prepare(`SELECT column_name FROM information_schema.columns WHERE table_name = ?`)
    .all<{ column_name: string }>(table);
  return rows.map((r) => r.column_name).sort();
}

describe('references schema', () => {
  it('creates sources with CSL-JSON storage owned by a user', async () => {
    expect(await columns('sources')).toEqual(
      ['created_at', 'csl_json', 'id', 'kind', 'updated_at', 'user_id'],
    );
  });

  it('creates citations linking a note to a source, with a locator', async () => {
    const cols = await columns('citations');
    expect(cols).toEqual(
      ['created_at', 'id', 'locator', 'note_id', 'prefix', 'source_id', 'suffix', 'user_id'],
    );
  });

  it('creates source_verdicts keyed one-to-one on the source', async () => {
    expect(await columns('source_verdicts')).toEqual(
      ['checked_at', 'evidence', 'registry', 'source_id', 'state'],
    );
  });

  it('cascades citations away when their source is deleted', async () => {
    const rows = await db.prepare(`
      SELECT rc.delete_rule FROM information_schema.referential_constraints rc
      JOIN information_schema.table_constraints tc ON tc.constraint_name = rc.constraint_name
      WHERE tc.table_name = 'citations'
    `).all<{ delete_rule: string }>();
    expect(rows.every((r) => r.delete_rule === 'CASCADE')).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/referencesSchema.test.ts --root server`
Expected: FAIL — `sources` has no columns (empty array)

- [ ] **Step 4: Append to `server/src/schema.sql`**

Append **at the very end of the file**, nothing above it modified:

```sql
-- ===========================================================================
-- REFERENCING (feature: references) - appended block, see
-- docs/superpowers/specs/2026-08-12-referencing-design.md
-- Append-only convention agreed with the parallel spellcheck work so two
-- features can add tables without tangling with each other's edits.
-- ===========================================================================

-- A source is stored as CSL-JSON, the format citeproc-js consumes directly, so no
-- internal citation format is invented and a DOI lookup can be stored verbatim.
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- One of sourceTypes.ts ids ('website', 'journal', ...). The CSL type lives inside
  -- csl_json; this is what the intake form was filled in as.
  kind TEXT NOT NULL,
  csl_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS sources_user_idx ON sources(user_id, updated_at DESC);

-- A citation is a note pointing at a library source. The note NEVER stores formatted
-- text: switching Harvard to APA has to re-render every citation without editing the
-- student's prose, which is only possible if the rendered form is derived, not stored.
CREATE TABLE IF NOT EXISTS citations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  -- "p. 14", "ch. 2" - the page or chapter inside the source.
  locator TEXT NOT NULL DEFAULT '',
  prefix TEXT NOT NULL DEFAULT '',
  suffix TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS citations_note_idx ON citations(note_id);
CREATE INDEX IF NOT EXISTS citations_source_idx ON citations(source_id);

-- One verdict per source, replaced on each check. checked_at is load-bearing rather than
-- audit noise: a stored verdict must state its own age, so an offline student sees
-- "checked 9 Aug" instead of a claim implying it was confirmed just now.
CREATE TABLE IF NOT EXISTS source_verdicts (
  source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('verified', 'unconfirmed', 'refuted', 'unreachable')),
  registry TEXT,
  evidence TEXT NOT NULL DEFAULT '',
  checked_at TEXT NOT NULL
);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/referencesSchema.test.ts --root server`
Expected: PASS, 4 tests

- [ ] **Step 6: Commit and announce**

```bash
git add server/src/schema.sql server/test/referencesSchema.test.ts
git commit -m "feat(references): sources, citations and verdicts tables"
python "$HOME/.claude/bus/bus.py" --channel proj send --from b --to spellcheck \
  "B: schema.sql append LANDED. Three tables at the end of the file in a fenced block. Nothing above it touched. schema.sql is free."
```

---

### Task 10: The API

Ties it together: one resolve endpoint that sniffs, library CRUD, and verification. Ownership is filtered on `user_id` in every statement — this router carries a student's entire reading list.

**Files:**
- Create: `server/src/routes/references.ts`
- Modify: `server/src/app.ts` (add import and one `app.use` line)
- Test: `server/test/references.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–9.
- Produces: `POST /api/references/resolve`, `GET /api/references/sources`, `POST /api/references/sources`, `PATCH /api/references/sources/:id`, `DELETE /api/references/sources/:id`, `POST /api/references/sources/:id/verify`, `GET /api/references/types`.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/references.test.ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { resetDatabase, resetData, makeUser, closeDatabase, type TestUser } from './helpers.js';

const app = buildApp();
let alice: TestUser;
let bob: TestUser;

beforeAll(async () => { await resetDatabase(); });
beforeEach(async () => {
  await resetData();
  alice = await makeUser(app);
  bob = await makeUser(app, 'bob@example.com');
  vi.unstubAllGlobals();
});
afterAll(async () => { await closeDatabase(); });

const CSL = { type: 'article-journal', title: 'A paper', DOI: '10.1/x' };

describe('GET /api/references/types', () => {
  it('serves all 27 source types so the client never bundles its own copy', async () => {
    const res = await request(app).get('/api/references/types').set('Cookie', alice.cookie);
    expect(res.status).toBe(200);
    expect(res.body.types).toHaveLength(27);
  });
});

describe('POST /api/references/resolve', () => {
  it('sniffs a DOI and returns what was found and what is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(CSL), { status: 200 })));
    const res = await request(app).post('/api/references/resolve')
      .set('Cookie', alice.cookie).send({ query: '10.1/x' });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('doi');
    expect(res.body.found).toBe(true);
    expect(res.body.missing).toContain('author');
  });

  it('returns search candidates for free text', async () => {
    const payload = { message: { items: [{ DOI: '10.1/y', title: ['Found it'], author: [], issued: { 'date-parts': [[2020]] } }] } };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })));
    const res = await request(app).post('/api/references/resolve')
      .set('Cookie', alice.cookie).send({ query: 'some paper title' });
    expect(res.body.kind).toBe('query');
    expect(res.body.candidates[0].doi).toBe('10.1/y');
  });

  it('rejects an empty query', async () => {
    const res = await request(app).post('/api/references/resolve')
      .set('Cookie', alice.cookie).send({ query: '   ' });
    expect(res.status).toBe(400);
  });

  it('requires auth', async () => {
    const res = await request(app).post('/api/references/resolve').send({ query: '10.1/x' });
    expect(res.status).toBe(401);
  });
});

describe('sources CRUD', () => {
  it('creates a source and returns it with an unconfirmed verdict', async () => {
    const res = await request(app).post('/api/references/sources')
      .set('Cookie', alice.cookie).send({ kind: 'book', csl: { type: 'book', title: 'A book' } });
    expect(res.status).toBe(201);
    expect(res.body.source.csl.title).toBe('A book');
    expect(res.body.source.verdict.state).toBe('unconfirmed');
  });

  it('rejects an unknown source kind', async () => {
    const res = await request(app).post('/api/references/sources')
      .set('Cookie', alice.cookie).send({ kind: 'nonsense', csl: { title: 'x' } });
    expect(res.status).toBe(400);
  });

  it('lists only the calling user\'s sources', async () => {
    await request(app).post('/api/references/sources')
      .set('Cookie', alice.cookie).send({ kind: 'book', csl: { type: 'book', title: 'Alice book' } });
    const res = await request(app).get('/api/references/sources').set('Cookie', bob.cookie);
    expect(res.status).toBe(200);
    expect(res.body.sources).toEqual([]);
  });

  it('will not let another user read, edit or delete a source', async () => {
    const created = await request(app).post('/api/references/sources')
      .set('Cookie', alice.cookie).send({ kind: 'book', csl: { type: 'book', title: 'Alice book' } });
    const id = created.body.source.id;
    expect((await request(app).patch(`/api/references/sources/${id}`)
      .set('Cookie', bob.cookie).send({ csl: { title: 'hijacked' } })).status).toBe(404);
    expect((await request(app).delete(`/api/references/sources/${id}`)
      .set('Cookie', bob.cookie)).status).toBe(404);
  });

  it('deletes a source', async () => {
    const created = await request(app).post('/api/references/sources')
      .set('Cookie', alice.cookie).send({ kind: 'book', csl: { type: 'book', title: 'Gone' } });
    expect((await request(app).delete(`/api/references/sources/${created.body.source.id}`)
      .set('Cookie', alice.cookie)).status).toBe(204);
    const list = await request(app).get('/api/references/sources').set('Cookie', alice.cookie);
    expect(list.body.sources).toEqual([]);
  });
});

describe('POST /api/references/sources/:id/verify', () => {
  it('stores a refuted verdict with its evidence when the DOI does not resolve', async () => {
    const created = await request(app).post('/api/references/sources')
      .set('Cookie', alice.cookie).send({ kind: 'journal', csl: { type: 'article-journal', title: 'Ghost', DOI: '10.1/nope' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Resource not found.', { status: 404 })));

    const res = await request(app).post(`/api/references/sources/${created.body.source.id}/verify`)
      .set('Cookie', alice.cookie).send({});

    expect(res.status).toBe(200);
    expect(res.body.verdict.state).toBe('refuted');
    expect(res.body.verdict.evidence).toMatch(/did not resolve/i);
    expect(res.body.verdict.checkedAt).toBeTruthy();
  });

  it('404s for a source the caller does not own', async () => {
    const created = await request(app).post('/api/references/sources')
      .set('Cookie', alice.cookie).send({ kind: 'book', csl: { type: 'book', title: 'Alice book' } });
    const res = await request(app).post(`/api/references/sources/${created.body.source.id}/verify`)
      .set('Cookie', bob.cookie).send({});
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/references.test.ts --root server`
Expected: FAIL — 404 on every route

- [ ] **Step 3: Write the router**

```ts
// server/src/routes/references.ts
/**
 * The source library.
 *
 * Auth is mounted once in app.ts, so this router adds no guard of its own - but EVERY
 * statement below filters on userId(req). A reading list is personal data and this router
 * is the one that could leak a whole account's worth of it.
 *
 * Note what is NOT here: nothing formats a citation. Formatting is the client's job, from
 * CSL-JSON, because switching style has to re-render without a round trip and has to keep
 * working offline.
 */
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db } from '../db.js';
import { userId } from '../auth/middleware.js';
import { SOURCE_TYPES, sourceTypeById } from '../lib/references/sourceTypes.js';
import { identify } from '../lib/references/identify.js';
import { resolveDoi } from '../lib/references/resolvers/doi.js';
import { resolveIsbn } from '../lib/references/resolvers/isbn.js';
import { resolveWebpage } from '../lib/references/resolvers/webpage.js';
import { searchWorks } from '../lib/references/resolvers/search.js';
import { verifySource, type Verdict } from '../lib/references/verify.js';

const router = Router();

const CslSchema = z.record(z.unknown());
const CreateSchema = z.object({ kind: z.string().min(1), csl: CslSchema });
const PatchSchema = z.object({ csl: CslSchema });
const ResolveSchema = z.object({ query: z.string() });

interface SourceRow {
  id: string; kind: string; csl_json: string; created_at: string; updated_at: string;
  state?: string | null; registry?: string | null; evidence?: string | null; checked_at?: string | null;
}

const UNCONFIRMED: Verdict = {
  state: 'unconfirmed',
  registry: null,
  evidence: 'Not checked yet.',
  checkedAt: '',
};

function shape(row: SourceRow) {
  return {
    id: row.id,
    kind: row.kind,
    csl: JSON.parse(row.csl_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    verdict: row.state
      ? { state: row.state, registry: row.registry, evidence: row.evidence ?? '', checkedAt: row.checked_at ?? '' }
      : UNCONFIRMED,
  };
}

const SELECT = `
  SELECT s.id, s.kind, s.csl_json, s.created_at, s.updated_at,
         v.state, v.registry, v.evidence, v.checked_at
  FROM sources s
  LEFT JOIN source_verdicts v ON v.source_id = s.id
`;

/** The catalogue, fetched rather than bundled, so the picker and the server cannot disagree. */
router.get('/types', (_req, res) => {
  res.json({ types: SOURCE_TYPES });
});

/**
 * One box, any identifier. Sniffing here rather than in the client keeps the rules in one
 * place and means the client never has to know what a DOI looks like.
 */
router.post('/resolve', async (req, res) => {
  const parsed = ResolveSchema.safeParse(req.body);
  if (!parsed.success || !parsed.data.query.trim()) {
    res.status(400).json({ error: 'query is required' });
    return;
  }

  const id = identify(parsed.data.query);
  if (id.kind === 'query') {
    res.json({ kind: 'query', found: false, candidates: await searchWorks(id.value), missing: [] });
    return;
  }

  const result =
    id.kind === 'doi' ? await resolveDoi(id.value)
    : id.kind === 'isbn' ? await resolveIsbn(id.value)
    : await resolveWebpage(id.value);

  res.json({
    kind: id.kind,
    found: result.found,
    csl: result.csl ?? null,
    registry: result.registry,
    // The honest half of the response: what we could not find, so the client can ask the
    // student for it rather than us inventing it.
    missing: result.missing,
    reason: result.reason ?? null,
    candidates: [],
  });
});

router.get('/sources', async (req, res) => {
  const rows = await db.prepare(`${SELECT} WHERE s.user_id = ? ORDER BY s.updated_at DESC`)
    .all<SourceRow>(userId(req));
  res.json({ sources: rows.map(shape) });
});

router.post('/sources', async (req, res) => {
  const parsed = CreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'kind and csl are required' });
    return;
  }
  if (!sourceTypeById(parsed.data.kind)) {
    res.status(400).json({ error: 'unknown source kind' });
    return;
  }

  const id = randomUUID();
  await db.prepare(`INSERT INTO sources (id, user_id, kind, csl_json) VALUES (?, ?, ?, ?)`)
    .run(id, userId(req), parsed.data.kind, JSON.stringify(parsed.data.csl));

  const row = await db.prepare(`${SELECT} WHERE s.id = ? AND s.user_id = ?`)
    .get<SourceRow>(id, userId(req));
  res.status(201).json({ source: shape(row!) });
});

router.patch('/sources/:id', async (req, res) => {
  const parsed = PatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'csl is required' });
    return;
  }
  const { changes } = await db
    .prepare(`UPDATE sources SET csl_json = ?, updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') WHERE id = ? AND user_id = ?`)
    .run(JSON.stringify(parsed.data.csl), req.params.id, userId(req));
  if (!changes) {
    res.status(404).json({ error: 'source not found' });
    return;
  }
  // Editing the metadata invalidates any verdict about it - the thing that was checked is
  // no longer the thing that is stored.
  await db.prepare(`DELETE FROM source_verdicts WHERE source_id = ?`).run(req.params.id);
  const row = await db.prepare(`${SELECT} WHERE s.id = ? AND s.user_id = ?`)
    .get<SourceRow>(req.params.id, userId(req));
  res.json({ source: shape(row!) });
});

router.delete('/sources/:id', async (req, res) => {
  const { changes } = await db.prepare(`DELETE FROM sources WHERE id = ? AND user_id = ?`)
    .run(req.params.id, userId(req));
  res.status(changes ? 204 : 404).end();
});

router.post('/sources/:id/verify', async (req, res) => {
  const row = await db.prepare(`SELECT id, csl_json FROM sources WHERE id = ? AND user_id = ?`)
    .get<{ id: string; csl_json: string }>(req.params.id, userId(req));
  if (!row) {
    res.status(404).json({ error: 'source not found' });
    return;
  }

  const verdict = await verifySource(JSON.parse(row.csl_json) as Record<string, unknown>);
  await db.prepare(`
    INSERT INTO source_verdicts (source_id, state, registry, evidence, checked_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (source_id) DO UPDATE
      SET state = EXCLUDED.state, registry = EXCLUDED.registry,
          evidence = EXCLUDED.evidence, checked_at = EXCLUDED.checked_at
  `).run(row.id, verdict.state, verdict.registry, verdict.evidence, verdict.checkedAt);

  res.json({ verdict });
});

export default router;
```

- [ ] **Step 4: Mount the router in `server/src/app.ts`**

Add the import beside the other route imports (near line 27):

```ts
import referencesRouter from './routes/references.js';
```

Add the mount immediately after the `app.use('/api/templates', ...)` line (near line 179):

```ts
  app.use('/api/references', requireAuth, referencesRouter);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/references.test.ts --root server`
Expected: PASS, 12 tests

- [ ] **Step 6: Run the whole server suite**

**Ping the bus first — this drops the shared dev database:**

```bash
python "$HOME/.claude/bus/bus.py" --channel proj send --from b --to spellcheck \
  "B: about to run 'npm run test -w server'. It DROPS the local dev DB and will log you out. Shout in the next minute if you are mid browser-check."
```

Then: `npm run test -w server`
Expected: all pre-existing tests still pass, plus the new suites.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/references.ts server/src/app.ts server/test/references.test.ts
git commit -m "feat(references): the source library API"
```

---

## Self-Review

**Spec coverage.** §2 four states → Task 8. §3 data model → Task 9. §3.1 27 types → Task 1. §6 intake/sniffing → Tasks 2, 10. §6.1 resolvers → Tasks 4–7. §6.2 SSRF → Task 3. §9 coordination → Tasks 9, 10 bus steps. §4 CSL engine, §5 editor nodes, §6.3 cadence, §7 AI tools and §8 offline are **Part 2** — deliberately out of scope here and listed in Next Steps below.

**Placeholders.** None: every step carries runnable code or an exact command.

**Type consistency.** `ResolveResult` and `missingFrom` are defined once in Task 4 and imported by Tasks 5 and 7. `Verdict`/`VerdictState` are defined in Task 8 and consumed in Task 10. `userAgent()` is defined in Task 3 (`safeFetch.ts`) and used in Tasks 4, 5, 6. `sourceTypeById` from Task 1 is used in Task 10.

**One deliberate deviation from the spec**, worth a reviewer's attention: the spec's §6.3 cadence table includes a 7-day staleness sweep. That sweep is a **client** behaviour (it fires on note open) and so belongs in Part 2. The server endpoint it calls — `POST /api/references/sources/:id/verify` — is built here, and `checked_at` is stored, so Part 2 has everything it needs.

## Next steps (Part 2, separate plan)

CSL engine with styles **and locales** compiled to `.ts`; `citation` and `bibliography` inline/block atoms; the intake and library UI; verdict badges with glyph-before-hue in `tokens.css`; the two AI tools; the offline cache and the staleness sweep.
