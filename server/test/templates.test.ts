import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { db } from '../src/db.js';
import { applyBuiltinTemplates } from '../src/routes/templates.js';
import { resetDatabase, makeUser, closeDatabase, type TestUser } from './helpers.js';

// Built via the real app rather than a standalone router mount: /api/templates is wired
// in app.ts now, and mounting the router bare would skip the requireAuth layer that
// `userId(req)` depends on.
const app = buildApp();

// This file deliberately shares one account and one database across its tests: the
// built-in templates are seeded once, install-wide, on the router's first request, and
// `seedBuiltinTemplates()` memoises that promise. A per-test TRUNCATE would delete the
// built-ins without any way to bring them back, so the schema is reset once here and the
// ordering-sensitive assertions below are kept in their original order.
let user: TestUser;
let api: TestUser['agent'];

beforeAll(async () => {
  await resetDatabase();
  user = await makeUser(app);
  api = user.agent;
});

afterAll(async () => {
  await closeDatabase();
});

interface TemplateDto {
  id: string;
  name: string;
  emoji: string;
  description: string;
  contentJson: { type: string; content: unknown[] };
  builtin: boolean;
  createdAt: string;
}

function findNodes(node: unknown, type: string, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (!node || typeof node !== 'object') return out;
  const n = node as { type?: string; content?: unknown[] };
  if (n.type === type) out.push(n as Record<string, unknown>);
  if (Array.isArray(n.content)) for (const c of n.content) findNodes(c, type, out);
  return out;
}

// Run first, against the pristine (import-time-seeded) DB, so seeding assertions aren't
// polluted by templates other tests create later in the file.
describe('boot seeding (runs first, before other tests add templates)', () => {
  const BUILTIN_NAMES = [
    'Cornell notes',
    'Lecture note',
    'Reading notes',
    'Essay plan',
    'Problem set / past paper',
    'Lab report',
    'Meeting & seminar notes',
    'Weekly review',
  ];

  it('seeds exactly the builtin templates when the table starts empty', async () => {
    const res = await api.get('/api/templates');
    expect(res.status).toBe(200);
    const templates = res.body.templates as TemplateDto[];
    expect(templates).toHaveLength(BUILTIN_NAMES.length);
    expect(templates.every((tpl) => tpl.builtin)).toBe(true);
    // Order matters: the picker shows them in this sequence, and Cornell leads.
    expect(templates.map((tpl) => tpl.name)).toEqual(BUILTIN_NAMES);
    for (const tpl of templates) {
      expect(tpl.emoji).toBeTruthy();
      expect(tpl.description.length).toBeGreaterThan(0);
      expect(tpl.contentJson.type).toBe('doc');
      expect(Array.isArray(tpl.contentJson.content)).toBe(true);
      expect(tpl.contentJson.content.length).toBeGreaterThan(0);
    }
  });

  it('re-seeding overwrites a stale builtin instead of leaving the old body behind', async () => {
    // Guards the change from ON CONFLICT DO NOTHING to DO UPDATE. Under the old statement,
    // editing a built-in reached fresh installs only: every existing account kept the
    // original body forever, with no path to the fix. Run against the un-memoised seed,
    // because the memoised entry point returns the first call's promise and touches no SQL.
    await db
      .prepare('UPDATE templates SET name = ?, description = ?, content_json = ? WHERE id = ?')
      .run('Stale name', 'stale description', '{"type":"doc","content":[]}', 'builtin-01-cornell-notes');

    await applyBuiltinTemplates();

    const row = await db
      .prepare('SELECT name, description, content_json FROM templates WHERE id = ?')
      .get<{ name: string; description: string; content_json: string }>('builtin-01-cornell-notes');
    expect(row?.name).toBe('Cornell notes');
    expect(row?.description).not.toBe('stale description');
    expect(JSON.parse(row!.content_json).content.length).toBeGreaterThan(0);
  });

  it('re-seeding drops a builtin that is no longer in the list, and never a user’s own', async () => {
    const mine = await api
      .post('/api/templates')
      .send({ name: 'Mine', contentJson: { type: 'doc', content: [{ type: 'paragraph' }] } });
    const mineId = mine.body.template.id as string;

    // A built-in from an earlier release, left behind by a rename.
    await db
      .prepare(
        `INSERT INTO templates (id, user_id, name, emoji, description, content_json, builtin, created_at)
         VALUES (?, NULL, ?, ?, ?, ?, 1, ?)`,
      )
      .run('builtin-99-retired', 'Retired', '🗑️', 'gone in this release', '{"type":"doc","content":[]}', new Date().toISOString());

    await applyBuiltinTemplates();

    const retired = await db.prepare('SELECT id FROM templates WHERE id = ?').get<{ id: string }>('builtin-99-retired');
    expect(retired).toBeFalsy();
    const survived = await db.prepare('SELECT id FROM templates WHERE id = ?').get<{ id: string }>(mineId);
    expect(survived?.id).toBe(mineId);

    await api.delete(`/api/templates/${mineId}`);
  });

  it('builds "Lecture note" with a key-terms toggle, a worked example and review questions', async () => {
    const res = await api.get('/api/templates');
    const lecture = (res.body.templates as TemplateDto[]).find((tpl) => tpl.name === 'Lecture note')!;
    expect(lecture).toBeTruthy();

    const toggles = findNodes(lecture.contentJson, 'details');
    expect(toggles).toHaveLength(1);
    const summaryText = findNodes(toggles[0], 'detailsSummary')[0]?.content as Array<{ text?: string }> | undefined;
    expect(summaryText?.[0]?.text).toBe('Key terms');
    expect(findNodes(toggles[0], 'detailsContent')).toHaveLength(1);

    const headings = findNodes(lecture.contentJson, 'heading').map(
      (h) => (h.content as Array<{ text?: string }>)?.[0]?.text,
    );
    expect(headings).toContain('Worked example');
    expect(headings).toContain('Questions to review');

    expect(findNodes(lecture.contentJson, 'taskList')).toHaveLength(1);
    expect(findNodes(lecture.contentJson, 'taskItem').length).toBeGreaterThan(0);
  });

  it('lays "Cornell notes" out as an actual Cornell page, not two equal columns', async () => {
    const res = await api.get('/api/templates');
    const cornell = (res.body.templates as TemplateDto[]).find((tpl) => tpl.name === 'Cornell notes')!;
    expect(cornell).toBeTruthy();

    // Two rows of columns: the field strip along the top, then the cue/notes body.
    const columnLists = findNodes(cornell.contentJson, 'columnList');
    expect(columnLists).toHaveLength(2);

    const body = columnLists[1];
    expect((body.attrs as { divider: boolean }).divider).toBe(true);
    const columns = findNodes(body, 'column');
    expect(columns).toHaveLength(2);

    // The defining property of the layout: the cue column is materially narrower than the
    // notes column. Equal widths would render a two-column note, not a Cornell one.
    const widths = columns.map((c) => (c.attrs as { width: number }).width);
    expect(widths.every((w) => typeof w === 'number')).toBe(true);
    expect(widths[0]).toBeLessThan(widths[1]);
    expect(widths[0] + widths[1]).toBe(100);
    expect(widths[0]).toBeLessThanOrEqual(35);

    const headings = columns.map((c) => (findNodes(c, 'heading')[0]?.content as Array<{ text?: string }>)?.[0]?.text);
    expect(headings).toEqual(['Cue column', 'Notes']);

    // ...and the summary band across the bottom.
    const callouts = findNodes(cornell.contentJson, 'callout');
    expect(callouts).toHaveLength(1);
    expect((callouts[0].attrs as { emoji: string; tone: string }).tone).toBeTruthy();
    const summaryText = JSON.stringify(callouts[0]);
    expect(summaryText).toContain('Summary');
  });

  it('builds every builtin as a document ProseMirror will actually accept', async () => {
    // The bug this pins: `{ type: 'text', text: '' }` - the obvious way to write a blank
    // cell for the reader to fill in - makes ProseMirror throw "Empty text nodes are not
    // allowed" and discard the ENTIRE document. Every structural assertion in this file
    // passed while Cornell notes loaded as a blank page, because the JSON was well-formed
    // and simply unopenable. Only clicking the button in a browser showed it.
    const res = await api.get('/api/templates');
    for (const tpl of res.body.templates as TemplateDto[]) {
      const empties = findNodes(tpl.contentJson, 'text').filter((n) => !(n as { text?: string }).text);
      expect(empties, `${tpl.name} contains ${empties.length} empty text node(s)`).toHaveLength(0);
    }
  });

  it('gives every builtin a body that is structured, not just a stack of headings', async () => {
    const res = await api.get('/api/templates');
    for (const tpl of res.body.templates as TemplateDto[]) {
      // "Useful" here means the template carries at least one block a blank page does not
      // give you for free - a table, a toggle, a task list, a callout or a column layout.
      const structural = ['table', 'details', 'taskList', 'callout', 'columnList'].filter(
        (type) => findNodes(tpl.contentJson, type).length > 0,
      );
      expect(structural.length, `${tpl.name} has no structural blocks`).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('POST /api/templates', () => {
  const validDoc = { type: 'doc', content: [{ type: 'paragraph' }] };

  it('creates a custom template and it shows up in the list', async () => {
    const res = await api
      .post('/api/templates')
      .send({ name: 'Meeting minutes', emoji: '🗒️', description: 'Attendees, decisions, actions.', contentJson: validDoc });
    expect(res.status).toBe(201);
    expect(res.body.template.builtin).toBe(false);
    expect(res.body.template.name).toBe('Meeting minutes');
    expect(res.body.template.id).toBeTruthy();

    const list = await api.get('/api/templates');
    expect((list.body.templates as TemplateDto[]).some((tpl) => tpl.id === res.body.template.id)).toBe(true);
  });

  it('defaults emoji to 📄 and description to "" when omitted', async () => {
    const res = await api.post('/api/templates').send({ name: 'Bare template', contentJson: validDoc });
    expect(res.status).toBe(201);
    expect(res.body.template.emoji).toBe('📄');
    expect(res.body.template.description).toBe('');
  });

  it('rejects an empty/whitespace name', async () => {
    const empty = await api.post('/api/templates').send({ name: '', contentJson: validDoc });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toBeTruthy();

    const whitespace = await api.post('/api/templates').send({ name: '   ', contentJson: validDoc });
    expect(whitespace.status).toBe(400);
  });

  it('rejects a doc containing an empty text node', async () => {
    // Not pedantry: ProseMirror throws on the whole document, so accepting one here means
    // storing a template that opens as a blank page.
    const res = await api.post('/api/templates').send({
      name: 'Blank cell',
      contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '' }] }] },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/empty text/i);
  });

  it('rejects a missing contentJson', async () => {
    const res = await api.post('/api/templates').send({ name: 'No content' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/contentJson/);
  });

  it.each([
    ['a string', 'not a doc'],
    ['null', null],
    ['a doc missing content', { type: 'doc' }],
    ['a doc with non-array content', { type: 'doc', content: 'nope' }],
    ['wrong type', { type: 'paragraph', content: [] }],
  ])('rejects invalid contentJson: %s', async (_label, contentJson) => {
    const res = await api.post('/api/templates').send({ name: 'Bad', contentJson });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/templates/:id', () => {
  it('404s for an unknown id', async () => {
    const res = await api.delete('/api/templates/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('deletes a custom template', async () => {
    const created = await api
      .post('/api/templates')
      .send({ name: 'Throwaway', contentJson: { type: 'doc', content: [{ type: 'paragraph' }] } });
    const id = created.body.template.id as string;

    const del = await api.delete(`/api/templates/${id}`);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ ok: true });

    const list = await api.get('/api/templates');
    expect((list.body.templates as TemplateDto[]).some((tpl) => tpl.id === id)).toBe(false);
  });

  // Behaviour change from the single-user build, not a weakened assertion: docs/API.md
  // said a user could delete a built-in, which was harmless when there was exactly one
  // account. Built-ins are now ONE shared row set (user_id NULL, see schema.sql), so
  // honouring that delete would remove the template for every other account on the
  // install. The route scopes its DELETE with `AND user_id = ?`, which can never match a
  // NULL-owner row, so the attempt falls through to the same 404 as an unknown id.
  it('refuses to delete a shared builtin template, since it belongs to every account', async () => {
    const before = await api.get('/api/templates');
    const builtin = (before.body.templates as TemplateDto[]).find((tpl) => tpl.builtin)!;
    expect(builtin).toBeTruthy();

    const del = await api.delete(`/api/templates/${builtin.id}`);
    expect(del.status).toBe(404);

    const after = await api.get('/api/templates');
    expect((after.body.templates as TemplateDto[]).some((tpl) => tpl.id === builtin.id)).toBe(true);
  });
});

describe('template ownership', () => {
  it("shows a user their own templates plus the shared builtins, never another account's", async () => {
    const other = await makeUser(app);
    const mine = await api
      .post('/api/templates')
      .send({ name: 'Mine only', contentJson: { type: 'doc', content: [{ type: 'paragraph' }] } });
    expect(mine.status).toBe(201);

    const theirList = await other.agent.get('/api/templates');
    expect(theirList.status).toBe(200);
    const names = (theirList.body.templates as TemplateDto[]).map((tpl) => tpl.name);
    expect(names).not.toContain('Mine only');
    // ...but the shared built-ins are still visible to them.
    expect(names).toContain('Lecture note');
  });

  it("404s rather than deleting another account's template", async () => {
    const other = await makeUser(app);
    const created = await api
      .post('/api/templates')
      .send({ name: 'Not yours', contentJson: { type: 'doc', content: [{ type: 'paragraph' }] } });
    const id = created.body.template.id as string;

    const del = await other.agent.delete(`/api/templates/${id}`);
    expect(del.status).toBe(404);

    // Still there for the real owner.
    const list = await api.get('/api/templates');
    expect((list.body.templates as TemplateDto[]).some((tpl) => tpl.id === id)).toBe(true);
  });
});
