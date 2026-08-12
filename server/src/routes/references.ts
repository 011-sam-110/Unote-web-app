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
