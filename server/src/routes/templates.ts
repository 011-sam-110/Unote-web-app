// templates-nb - GET/POST/DELETE /api/templates + built-in template seeding.
// Mounting is the integration captain's job (a one-liner in app.ts).
//
// Ownership model (see schema.sql): a built-in has a NULL user_id and is shared by every
// account; anything a user creates is owned by them. Reads return the caller's own rows
// plus the built-ins; writes and deletes only ever touch rows the caller owns.
//
// Seeding can no longer happen synchronously at import time - the Postgres layer is async
// and the table does not exist until migrate() has run - so it is a memoised promise the
// router awaits before handling its first request.
import { Router } from 'express';
import { db, migrate, newId, nowIso, tx } from '../db.js';
import { userId } from '../auth/middleware.js';

const router = Router();

// Auth is mounted once, in app.ts (`app.use('/api/templates', requireAuth, ...)`), so this
// router does not add its own guard - one layer means one place to audit and one session
// lookup per request. `userId(req)` throws if that mount ever loses the guard, so the
// failure mode is a loud 500, never an unscoped query.

interface TemplateRow {
  id: string;
  user_id: string | null; // NULL = built-in, shared by all users
  name: string;
  emoji: string;
  description: string;
  content_json: string;
  builtin: number;
  created_at: string;
}

function templateDto(row: TemplateRow) {
  return {
    id: row.id,
    name: row.name,
    emoji: row.emoji,
    description: row.description,
    contentJson: JSON.parse(row.content_json) as Record<string, unknown>,
    builtin: Boolean(row.builtin),
    createdAt: row.created_at,
  };
}

/** Same structural bar as notes.ts's validator: a minimally-valid TipTap doc, so a
 *  template can never brick the note created from it. Unlike notes (where contentJson is
 *  optional on PATCH), it's REQUIRED here - there's no other field to fall back to. */
function validateContentJson(value: unknown): string | null {
  if (value === undefined) return 'contentJson is required';
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return 'contentJson must be a TipTap document object';
  }
  const doc = value as { type?: unknown; content?: unknown };
  if (doc.type !== 'doc') return "contentJson must have type: 'doc'";
  if (!Array.isArray(doc.content)) return 'contentJson.content must be an array';
  if (hasEmptyTextNode(doc)) return 'contentJson must not contain empty text nodes';
  return null;
}

/**
 * Find `{ type: 'text', text: '' }` anywhere in the tree.
 *
 * ProseMirror refuses to build a document containing one, and it refuses the WHOLE
 * document rather than the offending node - so a single blank table cell means the editor
 * silently loads nothing and the user gets an empty page where their template should be.
 * Structural validation alone did not catch that: the JSON is perfectly well-shaped, and
 * both the API and its tests were happy with a template no editor could ever open.
 */
function hasEmptyTextNode(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  const n = node as { type?: unknown; text?: unknown; content?: unknown };
  if (n.type === 'text' && (typeof n.text !== 'string' || n.text.length === 0)) return true;
  return Array.isArray(n.content) && n.content.some(hasEmptyTextNode);
}

// --- Small TipTap JSON builders, used only to assemble the built-in templates below.
// Kept local (not exported) - this is purely a content-authoring convenience, not a
// general-purpose doc builder other routes should depend on. ------------------------
type TTNode = Record<string, unknown>;

const t = (text: string, marks?: TTNode[]): TTNode => (marks ? { type: 'text', text, marks } : { type: 'text', text });
const bold = (text: string): TTNode => t(text, [{ type: 'bold' }]);
const italic = (text: string): TTNode => t(text, [{ type: 'italic' }]);

/**
 * Drop empty text nodes.
 *
 * `{ type: 'text', text: '' }` is not a valid ProseMirror node - the schema throws
 * "Empty text nodes are not allowed" and REJECTS THE WHOLE DOCUMENT, so one blank cell in
 * a table takes the entire template down with it. `t('')` is the natural way to write "a
 * row for the reader to fill in", and every template below does it, so the filter lives
 * here rather than in eight separate call sites. An empty paragraph, list item or cell is
 * expressed by having no content at all, which is what this produces.
 */
const withoutEmptyText = (content: TTNode[]): TTNode[] =>
  content.filter((node) => !(node.type === 'text' && !node.text));

const paragraph = (...content: TTNode[]): TTNode => {
  const kept = withoutEmptyText(content);
  return kept.length ? { type: 'paragraph', content: kept } : { type: 'paragraph' };
};
const heading = (level: number, text: string): TTNode => ({ type: 'heading', attrs: { level }, content: [t(text)] });
const listItem = (...content: TTNode[]): TTNode => ({ type: 'listItem', content: [paragraph(...content)] });
const bulletList = (...items: TTNode[]): TTNode => ({ type: 'bulletList', content: items });
const taskItem = (text: string): TTNode => ({ type: 'taskItem', attrs: { checked: false }, content: [paragraph(t(text))] });
const taskList = (...items: TTNode[]): TTNode => ({ type: 'taskList', content: items });
/** A collapsible "toggle" block (native `@tiptap/extension-details`, persisted open state). */
const toggle = (summary: string, ...content: TTNode[]): TTNode => ({
  type: 'details',
  attrs: { open: true },
  content: [
    { type: 'detailsSummary', content: [t(summary)] },
    { type: 'detailsContent', content },
  ],
});
const callout = (emoji: string, tone: string, ...content: TTNode[]): TTNode => ({ type: 'callout', attrs: { emoji, tone }, content });
const orderedItem = (...content: TTNode[]): TTNode => ({ type: 'listItem', content: [paragraph(...content)] });
const orderedList = (...items: TTNode[]): TTNode => ({ type: 'orderedList', attrs: { start: 1 }, content: items });
const blockquote = (...content: TTNode[]): TTNode => ({ type: 'blockquote', content });
const hr = (): TTNode => ({ type: 'horizontalRule' });
const th = (text: string): TTNode => ({ type: 'tableHeader', content: [paragraph(bold(text))] });
const td = (...content: TTNode[]): TTNode => ({ type: 'tableCell', content: [paragraph(...content)] });
const row = (...cells: TTNode[]): TTNode => ({ type: 'tableRow', content: cells });
const table = (...rows: TTNode[]): TTNode => ({ type: 'table', content: rows });
// Cross-agent contract (ITER2-PLAN.md): columnList/column, 2-4 columns, attrs.width nullable.
// `width` is a percentage of the row and is honoured by the editor (web Columns.ts); null
// means "share the space equally". `divider` draws a hairline down each boundary.
const column = (content: TTNode[], width: number | null = null): TTNode => ({ type: 'column', attrs: { width }, content });
const columnList = (columns: TTNode[], divider = false): TTNode => ({ type: 'columnList', attrs: { divider }, content: columns });
const doc = (...content: TTNode[]): TTNode => ({ type: 'doc', content });

/** The strip of "who/what/when" fields most of these templates open with, as one row of
 *  equal columns rather than three stacked lines - it is the same information in a third
 *  of the vertical space, and it stacks by itself on a phone. */
const fieldRow = (...fields: Array<[string, string]>): TTNode =>
  columnList(fields.map(([label, hint]) => column([paragraph(bold(`${label}: `), italic(hint))])));

/**
 * The Cornell method, laid out the way the method actually specifies it, because the
 * layout IS the method: a narrow cue column down the left (about a quarter of the page),
 * a wide note-taking column beside it, and a summary band across the bottom. An equal
 * 50/50 split - which is what this template rendered as before `width` was honoured - is
 * a two-column note, not a Cornell note; the cue column is meant to be too narrow to
 * write prose in, so that it collects questions instead.
 *
 * Each section's prompt names WHEN it is filled in (during / after / at review), since
 * the staging is the other half of what makes the method work.
 */
function cornellNotesDoc(): TTNode {
  return doc(
    fieldRow(['Course', 'e.g. Algorithms'], ['Topic', 'e.g. Balancing a BST'], ['Date', 'e.g. 14 Oct']),
    hr(),
    columnList(
      [
        column(
          [
            heading(3, 'Cue column'),
            paragraph(italic('After class: one question per block of notes.')),
            bulletList(
              listItem(t('What problem does this solve?')),
              listItem(t('When does it break?')),
              listItem(t('How is it different from…?')),
            ),
          ],
          28,
        ),
        column(
          [
            heading(3, 'Notes'),
            paragraph(italic('During class: one idea per line, in your own words. Leave a gap when the topic changes - the cue on the left lines up with it.')),
            bulletList(listItem(t('')), listItem(t('')), listItem(t(''))),
          ],
          72,
        ),
      ],
      true,
    ),
    hr(),
    callout(
      '📝',
      'info',
      paragraph(bold('Summary')),
      paragraph(italic('At review: cover the notes, answer the cues from memory, then write the page here in two or three sentences. What you cannot summarise is what to go back over.')),
    ),
  );
}

function lectureNoteDoc(): TTNode {
  return doc(
    fieldRow(['Module', 'e.g. COMP2211'], ['Lecture', 'e.g. 7 - Hash tables'], ['Date', 'e.g. 14 Oct 2026']),
    toggle(
      'Key terms',
      bulletList(
        listItem(bold('Term - '), italic('short definition, in your own words')),
        listItem(bold('Term - '), italic('short definition, in your own words')),
        listItem(bold('Term - '), italic('short definition, in your own words')),
      ),
    ),
    heading(2, 'The thread'),
    paragraph(italic('The argument of the lecture in order, one step per line. If you cannot number it, you have notes but not an explanation.')),
    orderedList(orderedItem(t('')), orderedItem(t('')), orderedItem(t(''))),
    heading(2, 'Worked example'),
    paragraph(italic('One example, all the way through, including the steps the lecturer did in their head. This is the part you will actually reread before an exam.')),
    heading(2, 'Questions to review'),
    taskList(
      taskItem('What didn’t fully make sense?'),
      taskItem('Follow up with the lecturer / textbook on…'),
    ),
    callout(
      '🃏',
      'ok',
      paragraph(bold('Before you close this: '), italic('select the two or three lines you would lose sleep over forgetting and turn them into flashcards. A note you never test yourself on is a note you have only read.')),
    ),
  );
}

function readingNotesDoc(): TTNode {
  return doc(
    fieldRow(['Author & year', 'e.g. Dijkstra, 1968'], ['Source', 'e.g. CACM 11(3)'], ['Read for', 'e.g. Week 4 seminar']),
    callout('🎯', 'info', paragraph(bold('In one sentence: '), italic('what is this actually claiming? Write it before you take any other notes.'))),
    heading(2, 'The argument'),
    paragraph(italic('The claim, then the steps it rests on. Distinguish what the author demonstrates from what they assert.')),
    heading(2, 'Evidence and method'),
    bulletList(
      listItem(bold('Evidence - '), italic('what is the claim actually built on?')),
      listItem(bold('Method - '), italic('how was it gathered, and over what?')),
      listItem(bold('Limits - '), italic('what would have to be true for this to be wrong?')),
    ),
    heading(2, 'Quotes worth keeping'),
    blockquote(paragraph(italic('Quote, exactly as written.')), paragraph(bold('p. '), italic('page number - you will need it for the citation and you will not remember it'))),
    heading(2, 'My response'),
    paragraph(italic('Where you agree, where you don’t, and what it changes about something else you have read. This section is the only part of the note nobody else could have written.')),
    heading(2, 'Follow up'),
    taskList(taskItem('Chase reference: …'), taskItem('Read against: …')),
  );
}

function essayPlanDoc(): TTNode {
  return doc(
    heading(2, 'The question'),
    blockquote(paragraph(italic('Paste the question exactly as set. Every row below has to answer this one, and paraphrasing it is how essays drift.'))),
    callout('🧭', 'info', paragraph(bold('Thesis: '), italic('your answer in one sentence, arguable enough that a reasonable person could disagree with it.'))),
    heading(2, 'The case, section by section'),
    paragraph(italic('One row per paragraph. If the "So what?" column is empty, that paragraph is description, not argument.')),
    table(
      row(th('Section'), th('Point'), th('Evidence'), th('So what?')),
      row(td(italic('Intro')), td(t('')), td(t('')), td(t(''))),
      row(td(italic('1')), td(t('')), td(t('')), td(t(''))),
      row(td(italic('2')), td(t('')), td(t('')), td(t(''))),
      row(td(italic('3')), td(t('')), td(t('')), td(t(''))),
      row(td(italic('Conclusion')), td(t('')), td(t('')), td(t(''))),
    ),
    toggle(
      'The strongest case against me',
      paragraph(italic('Write the best version of the opposing argument, not the easiest one, then say why your thesis survives it. Marks live here.')),
    ),
    heading(2, 'Before submitting'),
    taskList(
      taskItem('Every paragraph answers the question as set, not a nearby one'),
      taskItem('The counterargument is addressed, not just named'),
      taskItem('Every citation in the text is in the reference list, and vice versa'),
      taskItem('Read the intro and conclusion back to back - do they agree?'),
    ),
  );
}

function problemSetDoc(): TTNode {
  return doc(
    fieldRow(['Paper / sheet', 'e.g. 2024 Paper 2'], ['Conditions', 'e.g. closed book, 90 min'], ['Date', 'e.g. 14 Oct 2026']),
    callout('⏱️', 'warn', paragraph(italic('Attempt every question before you look at a single answer. A worked solution you read feels like understanding and is not.'))),
    heading(2, 'Q1'),
    toggle('My attempt', paragraph(italic('Your working, including the wrong turns. The wrong turns are the useful bit.'))),
    toggle('Where I got stuck', paragraph(italic('The exact step you could not take - not "this question", but "converting the recurrence".'))),
    toggle('The approach that works', paragraph(italic('Filled in after marking, in your own words rather than copied.'))),
    hr(),
    heading(2, 'Mistake log'),
    paragraph(italic('The point of the whole sheet. Sort by the "Type" column before an exam and you get your own revision list.')),
    table(
      row(th('Q'), th('What went wrong'), th('Type'), th('What to do instead')),
      row(td(italic('1')), td(t('')), td(italic('careless / method / didn’t know')), td(t(''))),
      row(td(t('')), td(t('')), td(t('')), td(t(''))),
    ),
  );
}

function labReportDoc(): TTNode {
  return doc(
    fieldRow(['Experiment', 'e.g. Determining g by pendulum'], ['Partner(s)', 'e.g. —'], ['Date', 'e.g. 14 Oct 2026']),
    heading(2, 'Aim'),
    paragraph(italic('What is being measured, and to what precision.')),
    heading(2, 'Hypothesis'),
    paragraph(italic('What you expect and why - written before the results, so it can still be wrong.')),
    heading(2, 'Apparatus'),
    bulletList(listItem(italic('Item - and its resolution, e.g. metre rule ± 1 mm'))),
    heading(2, 'Method'),
    paragraph(italic('Numbered, past tense, reproducible by someone who was not there.')),
    orderedList(orderedItem(t('')), orderedItem(t('')), orderedItem(t(''))),
    heading(2, 'Results'),
    table(
      row(th('Trial'), th('Measured'), th('Uncertainty'), th('Notes')),
      row(td(t('1')), td(t('')), td(t('')), td(t(''))),
      row(td(t('2')), td(t('')), td(t('')), td(t(''))),
      row(td(t('3')), td(t('')), td(t('')), td(t(''))),
    ),
    heading(2, 'Analysis'),
    paragraph(italic('The calculation, then the propagated uncertainty. State the result to the precision the uncertainty actually justifies.')),
    heading(2, 'Sources of error'),
    bulletList(
      listItem(bold('Systematic - '), italic('what would shift every reading the same way?')),
      listItem(bold('Random - '), italic('what would scatter them?')),
      listItem(bold('Fix - '), italic('what you would change if you ran it again')),
    ),
    heading(2, 'Conclusion'),
    callout('📊', 'info', paragraph(italic('The number, its uncertainty, and whether it agrees with the accepted value within that uncertainty. Say so plainly either way.'))),
  );
}

function seminarNotesDoc(): TTNode {
  return doc(
    fieldRow(['Meeting', 'e.g. Supervision - group project'], ['Present', 'e.g. —'], ['Date', 'e.g. 14 Oct 2026']),
    heading(2, 'Agenda'),
    taskList(taskItem(''), taskItem(''), taskItem('')),
    heading(2, 'Discussion'),
    paragraph(italic('What was actually said, not a transcript. One line per point that changed somebody’s mind.')),
    callout('✅', 'ok', paragraph(bold('Decisions')), bulletList(listItem(italic('Decided … because …')))),
    heading(2, 'Actions'),
    paragraph(italic('An action with no name and no date is a wish.')),
    table(
      row(th('Action'), th('Who'), th('By when')),
      row(td(t('')), td(t('')), td(t(''))),
      row(td(t('')), td(t('')), td(t(''))),
    ),
    heading(2, 'Next time'),
    paragraph(italic('Date, and the one thing that has to be ready for it.')),
  );
}

function weeklyReviewDoc(): TTNode {
  return doc(
    paragraph(bold('Week of: '), italic('e.g. 14-20 Oct 2026')),
    columnList([
      column([heading(3, 'Went well'), bulletList(listItem(t('')))]),
      column([heading(3, 'Didn’t'), bulletList(listItem(t('')))]),
      column([heading(3, 'Learned'), bulletList(listItem(t('')))]),
    ]),
    hr(),
    heading(2, 'Still open'),
    paragraph(italic('Everything you told someone you would do and haven’t. Getting it out of your head and onto the page is most of the value of this note.')),
    taskList(taskItem(''), taskItem('')),
    heading(2, 'Next week’s three'),
    paragraph(italic('Three. Not a list of everything - three things that, if they happen, make the week a good one.')),
    orderedList(orderedItem(t('')), orderedItem(t('')), orderedItem(t(''))),
    callout('🔁', 'info', paragraph(bold('One thing to change: '), italic('a single adjustment for next week, small enough that you will actually do it.'))),
  );
}

/** The built-ins are one shared set for the whole install (user_id NULL), not a per-account
 *  copy, so their ids are fixed rather than generated by newId(). Fixed ids are what make
 *  the seed idempotent via ON CONFLICT: two cold serverless instances booting at once can
 *  both run it without inserting duplicates, which a "is the table empty?" guard could not
 *  guarantee. The numeric prefix sets the order they are listed in, under the `id` tiebreak
 *  in the list query (Postgres has no rowid to fall back on). */
const BUILTIN_TEMPLATES: Array<{ id: string; name: string; emoji: string; description: string; doc: () => TTNode }> = [
  {
    id: 'builtin-01-cornell-notes',
    name: 'Cornell notes',
    emoji: '📐',
    description: 'The real layout: narrow cue column, wide notes column, summary band underneath.',
    doc: cornellNotesDoc,
  },
  {
    id: 'builtin-02-lecture-note',
    name: 'Lecture note',
    emoji: '🎓',
    description: 'Key terms, the lecture’s argument in order, one worked example, questions to chase.',
    doc: lectureNoteDoc,
  },
  {
    id: 'builtin-03-reading-notes',
    name: 'Reading notes',
    emoji: '📖',
    description: 'Citation header, the argument and its limits, quotes with page numbers, your own response.',
    doc: readingNotesDoc,
  },
  {
    id: 'builtin-04-essay-plan',
    name: 'Essay plan',
    emoji: '✍️',
    description: 'Thesis in one line, a point/evidence/so-what table per paragraph, and the case against you.',
    doc: essayPlanDoc,
  },
  {
    id: 'builtin-05-problem-set',
    name: 'Problem set / past paper',
    emoji: '🧮',
    description: 'Attempt, sticking point and correct approach per question - plus a mistake log to revise from.',
    doc: problemSetDoc,
  },
  {
    id: 'builtin-06-lab-report',
    name: 'Lab report',
    emoji: '🔬',
    description: 'Aim, method, a results table with uncertainties, analysis and sources of error.',
    doc: labReportDoc,
  },
  {
    id: 'builtin-07-seminar-notes',
    name: 'Meeting & seminar notes',
    emoji: '🗣️',
    description: 'Agenda, what was said, decisions called out, and actions with a name and a date.',
    doc: seminarNotesDoc,
  },
  {
    id: 'builtin-08-weekly-review',
    name: 'Weekly review',
    emoji: '🔁',
    description: 'Went well / didn’t / learned side by side, open loops, and next week’s three.',
    doc: weeklyReviewDoc,
  },
];

let seeded: Promise<void> | null = null;

/**
 * Bring the shared built-in templates in line with the list above. Idempotent and
 * de-duplicated per process, so the concurrent requests that hit a cold serverless
 * instance run it once rather than racing each other.
 *
 * This UPDATES on conflict rather than doing nothing, which is a deliberate change from
 * the original insert-once seed: with DO NOTHING, editing a built-in shipped the new
 * wording to fresh installs only, and every existing account kept the old body forever
 * with no way to ever see the fix. Overwriting is safe precisely because these rows are
 * shared and unowned - a user's own copy of a template is a note, made at insert time,
 * and nothing here touches notes. `created_at` is left alone so the listing order does
 * not shuffle on every deploy.
 *
 * The DELETE then removes built-ins that no longer exist in the list (renamed ids, dropped
 * templates), scoped to `user_id IS NULL` so it can never reach a template a user made.
 *
 * Exported so a boot path can warm it eagerly; the router awaits it either way.
 */
export function seedBuiltinTemplates(): Promise<void> {
  seeded ??= applyBuiltinTemplates().catch((err) => {
    seeded = null; // let a later request retry rather than caching the failure
    throw err;
  });
  return seeded;
}

/**
 * The seed itself, without the per-process memo.
 *
 * Separated so its two properties can be tested by running it twice - which the memoised
 * entry point makes impossible, since the second call returns the first one's promise and
 * touches no SQL at all.
 */
export async function applyBuiltinTemplates(): Promise<void> {
  // migrate() is itself idempotent and memoised - this just guarantees the templates
  // table exists before the insert, without depending on app.ts's boot order.
  await migrate();
  const now = nowIso();
  await tx(async (conn) => {
    for (const tpl of BUILTIN_TEMPLATES) {
      // `conn`, not the module-level `db`: `db` would draw a different pooled
      // connection and silently run outside this transaction.
      await conn
        .prepare(
          `INSERT INTO templates (id, user_id, name, emoji, description, content_json, builtin, created_at)
           VALUES (?, NULL, ?, ?, ?, ?, 1, ?)
           ON CONFLICT (id) DO UPDATE
             SET name = EXCLUDED.name,
                 emoji = EXCLUDED.emoji,
                 description = EXCLUDED.description,
                 content_json = EXCLUDED.content_json`,
        )
        .run(tpl.id, tpl.name, tpl.emoji, tpl.description, JSON.stringify(tpl.doc()), now);
    }
    const placeholders = BUILTIN_TEMPLATES.map(() => '?').join(', ');
    await conn
      .prepare(`DELETE FROM templates WHERE user_id IS NULL AND builtin = 1 AND id NOT IN (${placeholders})`)
      .run(...BUILTIN_TEMPLATES.map((tpl) => tpl.id));
  });
}

// Seeding used to run at import time; it now runs on the first request through this router,
// because it needs the schema applied and the DB calls are async.
router.use((_req, _res, next) => {
  seedBuiltinTemplates().then(() => next(), next);
});

// GET /api/templates - the caller's own templates plus the shared built-ins, builtin first,
// then newest.
router.get('/', async (req, res) => {
  const uid = userId(req);
  // `user_id IS NULL` is the built-in row, deliberately visible to everyone; every other
  // row must belong to the caller. Ordering tie-breaks on `id` - the old `rowid ASC` has no
  // Postgres equivalent, and `id` is the real primary key.
  const rows = await db
    .prepare(
      `SELECT * FROM templates
        WHERE user_id = ? OR user_id IS NULL
        ORDER BY builtin DESC, created_at DESC, id ASC`,
    )
    .all<TemplateRow>(uid);
  res.json({ templates: rows.map(templateDto) });
});

// POST /api/templates { name, emoji?, description?, contentJson }
router.post('/', async (req, res) => {
  const uid = userId(req);
  const b = (req.body ?? {}) as { name?: unknown; emoji?: unknown; description?: unknown; contentJson?: unknown };
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  const contentJsonError = validateContentJson(b.contentJson);
  if (contentJsonError) {
    res.status(400).json({ error: contentJsonError });
    return;
  }

  const id = newId();
  const now = nowIso();
  const emoji = typeof b.emoji === 'string' && b.emoji.trim() ? b.emoji.trim() : '📄';
  const description = typeof b.description === 'string' ? b.description.trim() : '';

  // Owner comes from the session only - never from the body, which the client controls.
  await db
    .prepare(
      `INSERT INTO templates (id, user_id, name, emoji, description, content_json, builtin, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    .run(id, uid, name, emoji, description, JSON.stringify(b.contentJson), now);

  const row = await db
    .prepare('SELECT * FROM templates WHERE id = ? AND user_id = ?')
    .get<TemplateRow>(id, uid);
  res.status(201).json({ template: templateDto(row!) });
});

// DELETE /api/templates/:id - the caller's own templates only. Built-ins are no longer
// deletable: they have a NULL user_id, so `user_id = ?` never matches one, and deleting a
// shared row would remove it for every other account too. Another user's template falls
// through to the same 404 as a nonexistent id, so ids stay unenumerable.
router.delete('/:id', async (req, res) => {
  const uid = userId(req);
  const result = await db
    .prepare('DELETE FROM templates WHERE id = ? AND user_id = ?')
    .run(req.params.id, uid);
  if (result.changes === 0) {
    res.status(404).json({ error: 'template not found' });
    return;
  }
  res.json({ ok: true });
});

export default router;
