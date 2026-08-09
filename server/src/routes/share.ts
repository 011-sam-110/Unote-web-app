import { createHmac, randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { db, newId, nowIso } from '../db.js';
import { SESSION_SECRET, IS_SERVERLESS } from '../config.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { requireAuth, userId } from '../auth/middleware.js';
import { plainTextFromDoc } from '../lib/plainText.js';
import { syncLinksForNote } from '../lib/links.js';
import { rateLimit } from '../auth/rateLimit.js';
import { claimAttachmentsForNote } from '../lib/attachments.js';
import { COOKIE_NAME, readCookie, resolveSession } from '../auth/session.js';

const router = Router();

const GUEST_COOKIE_PREFIX = 'folio_guest_';
const GUEST_DAYS = 7;

/** Share tokens and guest tokens are stored hashed, never in the clear. */
function hashToken(token: string): string {
  return createHmac('sha256', SESSION_SECRET).update(token).digest('hex');
}

interface ShareRow {
  id: string;
  note_id: string;
  password_hash: string | null;
  password_salt: string | null;
  permission: string;
  created_by: string;
  expires_at: string | null;
  revoked: number;
  created_at: string;
}

const GUEST_COLORS = [
  '#6366f1', '#0891b2', '#db2777', '#b45309', '#7c3aed', '#059669', '#dc2626',
];

async function loadShareByToken(token: string): Promise<ShareRow | undefined> {
  const row = await db
    .prepare('SELECT * FROM note_shares WHERE token_hash = ?')
    .get<ShareRow>(hashToken(token));
  if (!row) return undefined;
  if (row.revoked === 1) return undefined;
  if (row.expires_at && row.expires_at <= nowIso()) return undefined;
  return row;
}

// ---------------------------------------------------------------------------
// Owner-side management. All of these require an account and note ownership.
// ---------------------------------------------------------------------------

router.get('/notes/:noteId/shares', requireAuth, async (req, res) => {
  const uid = userId(req);
  const { noteId } = req.params;
  const owned = await db
    .prepare('SELECT id FROM notes WHERE id = ? AND user_id = ?')
    .get<{ id: string }>(noteId, uid);
  if (!owned) {
    res.status(404).json({ error: 'Note not found' });
    return;
  }
  const rows = await db
    .prepare(
      `SELECT id, permission, expires_at, revoked, created_at,
              (password_hash IS NOT NULL) AS has_password
         FROM note_shares WHERE note_id = ? AND revoked = 0 ORDER BY created_at DESC`,
    )
    .all<ShareRow & { has_password: boolean }>(noteId);
  res.json({
    shares: rows.map((r) => ({
      id: r.id,
      permission: r.permission,
      hasPassword: Boolean(r.has_password),
      expiresAt: r.expires_at,
      createdAt: r.created_at,
    })),
  });
});

router.post('/notes/:noteId/shares', requireAuth, async (req, res) => {
  const uid = userId(req);
  const { noteId } = req.params;
  const owned = await db
    .prepare('SELECT id, content_json FROM notes WHERE id = ? AND user_id = ?')
    .get<{ id: string; content_json: string }>(noteId, uid);
  if (!owned) {
    res.status(404).json({ error: 'Note not found' });
    return;
  }

  // Attachment reads below are authorised purely by attachments.note_id. Notes written
  // before that column was populated on save still embed images whose rows have note_id
  // NULL, and they would go blank the moment they were shared. This is the last
  // owner-authenticated point before any guest exists, so file them here too.
  // `owned.id`, not the raw path param: it comes from the owner-scoped lookup above.
  await claimAttachmentsForNote(uid, owned.id, owned.content_json ?? '');

  const b = (req.body ?? {}) as Record<string, unknown>;
  const permission = b.permission === 'view' ? 'view' : 'edit';
  const password = typeof b.password === 'string' && b.password ? b.password : null;
  // Was 4. A share link is a bearer credential on a public URL, so its password is
  // the only thing standing between a leaked link and the note behind it - and four
  // characters is inside brute-force range even with the join throttle in place.
  if (password && password.length < 8) {
    res.status(400).json({ error: 'Share password must be at least 8 characters' });
    return;
  }

  // 32 random bytes: the link itself is the credential, so it must be far beyond
  // guessing range even though it travels in a URL.
  const token = randomBytes(32).toString('base64url');
  const creds = password ? await hashPassword(password) : null;
  const id = newId();
  const expiresAt = typeof b.expiresAt === 'string' && b.expiresAt ? b.expiresAt : null;

  await db
    .prepare(
      `INSERT INTO note_shares
         (id, note_id, token_hash, password_hash, password_salt, permission, created_by, expires_at, revoked, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    .run(
      id,
      noteId,
      hashToken(token),
      creds?.hash ?? null,
      creds?.salt ?? null,
      permission,
      uid,
      expiresAt,
      nowIso(),
    );

  // The raw token is returned exactly once, here - it is unrecoverable afterwards
  // because only its hash was stored.
  res.status(201).json({
    share: { id, permission, hasPassword: Boolean(password), expiresAt },
    token,
    url: `/join/${token}`,
  });
});

router.delete('/shares/:shareId', requireAuth, async (req, res) => {
  const uid = userId(req);
  const r = await db
    .prepare('UPDATE note_shares SET revoked = 1 WHERE id = ? AND created_by = ?')
    .run(req.params.shareId, uid);
  if (r.changes === 0) {
    res.status(404).json({ error: 'Share link not found' });
    return;
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Guest-side join flow. No account required.
// ---------------------------------------------------------------------------

/** What a visitor is told before they authenticate - deliberately minimal. */
router.get('/share/:token', async (req, res) => {
  const share = await loadShareByToken(String(req.params.token));
  if (!share) {
    res.status(404).json({ error: 'This link is invalid, expired, or has been revoked' });
    return;
  }
  const note = await db
    .prepare('SELECT title, kind FROM notes WHERE id = ?')
    .get<{ title: string; kind: string }>(share.note_id);
  res.json({
    // Title is shown so the visitor knows what they are joining; nothing else
    // about the note or its owner is exposed before the gate is cleared.
    title: note?.title || 'Untitled',
    kind: note?.kind ?? 'doc',
    permission: share.permission,
    needsPassword: Boolean(share.password_hash),
  });
});

router.post('/share/:token/join', rateLimit({ limit: 12, windowMs: 5 * 60_000, message: 'Too many attempts on this link. Please wait a few minutes and try again.' }), async (req, res) => {
  // Express types a bare Request's params as string | string[]; :token is always a
  // single path segment.
  const share = await loadShareByToken(String(req.params.token));
  if (!share) {
    res.status(404).json({ error: 'This link is invalid, expired, or has been revoked' });
    return;
  }

  if (share.password_hash && share.password_salt) {
    const supplied = String((req.body as Record<string, unknown>)?.password ?? '');
    const ok = await verifyPassword(supplied, {
      hash: share.password_hash,
      salt: share.password_salt,
    });
    if (!ok) {
      res.status(401).json({ error: 'Incorrect password' });
      return;
    }
  }

  const displayName =
    String((req.body as Record<string, unknown>)?.displayName ?? '').trim().slice(0, 40) || 'Guest';
  const guestToken = randomBytes(24).toString('base64url');
  const id = hashToken(guestToken);
  const color = GUEST_COLORS[Math.floor(Math.random() * GUEST_COLORS.length)];

  await db
    .prepare(
      `INSERT INTO share_guests (id, share_id, display_name, color, last_seen_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      share.id,
      displayName,
      color,
      nowIso(),
      new Date(Date.now() + GUEST_DAYS * 864e5).toISOString(),
    );

  // Scoped per share token so joining a second board does not evict the first.
  res.cookie(GUEST_COOKIE_PREFIX + share.id, guestToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_SERVERLESS,
    path: '/',
    maxAge: GUEST_DAYS * 864e5,
  });

  res.json({ guest: { displayName, color }, permission: share.permission });
});

/**
 * Resolve who is acting on a shared note.
 *
 * Two routes in: the note's signed-in owner, or a guest who cleared the gate.
 * Everyone else is rejected. Sets `req.shareContext` for the handlers below.
 */
export interface ShareContext {
  share: ShareRow;
  noteId: string;
  canEdit: boolean;
  actor: string;
  displayName: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      shareContext?: ShareContext;
    }
  }
}

async function requireShareAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // Express 5 types a bare Request's params as string | string[]; this middleware
    // is only ever mounted on single-segment :token routes.
    const share = await loadShareByToken(String(req.params.token));
    if (!share) {
      res.status(404).json({ error: 'This link is invalid, expired, or has been revoked' });
      return;
    }

    const accountId = await resolveSession(readCookie(req, COOKIE_NAME));
    if (accountId) {
      const owned = await db
        .prepare('SELECT id FROM notes WHERE id = ? AND user_id = ?')
        .get<{ id: string }>(share.note_id, accountId);
      if (owned) {
        const user = await db
          .prepare('SELECT display_name FROM users WHERE id = ?')
          .get<{ display_name: string }>(accountId);
        req.shareContext = {
          share,
          noteId: share.note_id,
          canEdit: true, // the owner is never restricted by their own share link
          actor: accountId,
          displayName: user?.display_name ?? 'Owner',
        };
        next();
        return;
      }
    }

    const guestToken = readCookie(req, GUEST_COOKIE_PREFIX + share.id);
    if (!guestToken) {
      res.status(401).json({ error: 'Join this link before opening it' });
      return;
    }
    const guest = await db
      .prepare('SELECT id, display_name, expires_at FROM share_guests WHERE id = ? AND share_id = ?')
      .get<{ id: string; display_name: string; expires_at: string }>(
        hashToken(guestToken),
        share.id,
      );
    if (!guest || guest.expires_at <= nowIso()) {
      res.status(401).json({ error: 'Your access to this link has expired' });
      return;
    }

    await db
      .prepare('UPDATE share_guests SET last_seen_at = ? WHERE id = ?')
      .run(nowIso(), guest.id);

    req.shareContext = {
      share,
      noteId: share.note_id,
      canEdit: share.permission === 'edit',
      actor: guest.id,
      displayName: guest.display_name,
    };
    next();
  } catch (err) {
    next(err);
  }
}

function ctx(req: Request): ShareContext {
  if (!req.shareContext) throw new Error('route requires requireShareAccess middleware');
  return req.shareContext;
}

/**
 * May this request read the attachment stored as `storedName`?
 *
 * Images embedded in a note are fetched by the browser as plain `<img src="/uploads/…">`
 * requests. Those carry no share token - the token lives in the page URL, not in the
 * image URL - so a guest viewing a shared note would get a 404 for every figure if
 * attachment reads were scoped to the owner alone.
 *
 * The cookies a guest received at join time are the credential we do have, so this walks
 * them: for each `folio_guest_<shareId>` cookie, confirm the guest row is live and the
 * share is neither revoked nor expired, then confirm the attachment is filed against the
 * shared note. That last check is what keeps this narrow - holding a share link grants the
 * images in *that* note, not the run of every attachment in the database.
 *
 * The membership test is `attachments.note_id`, and only that, because it is a column no
 * requester can write. A previous version also allowed the read when the note's
 * `content_json` contained the `/uploads/<stored_name>` URL, which was not access control
 * at all: `PATCH /share/:token/note` lets any edit-permission guest put arbitrary content
 * into that same note, so an attacker could share a note with themselves, join it, paste a
 * victim's attachment URL into the body and have the server serve back another user's file.
 * Authorisation must never be derived from data the requester supplied.
 *
 * Editor uploads used to depend on that branch, because they are stored with note_id NULL
 * (the image is posted before it is placed). They are now filed against the note on the
 * owner's own write instead - see claimAttachmentsForNote in lib/attachments.ts.
 */
export async function shareGrantsAttachmentAccess(req: Request, storedName: string): Promise<boolean> {
  const header = req.headers.cookie;
  if (!header) return false;

  const now = nowIso();
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name.startsWith(GUEST_COOKIE_PREFIX)) continue;

    const shareId = name.slice(GUEST_COOKIE_PREFIX.length);
    let guestToken: string;
    try {
      guestToken = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      continue; // malformed cookie value - not a credential
    }

    const guest = await db
      .prepare('SELECT id, expires_at FROM share_guests WHERE id = ? AND share_id = ?')
      .get<{ id: string; expires_at: string }>(hashToken(guestToken), shareId);
    if (!guest || guest.expires_at <= now) continue;

    const share = await db
      .prepare('SELECT id, note_id, revoked, expires_at FROM note_shares WHERE id = ?')
      .get<{ id: string; note_id: string; revoked: number; expires_at: string | null }>(shareId);
    if (!share || share.revoked === 1) continue;
    if (share.expires_at && share.expires_at <= now) continue;

    // The one way an attachment belongs to the shared note: it is filed against it.
    const owned = await db
      .prepare(
        `SELECT 1 AS ok FROM attachments
          WHERE stored_name = ? AND note_id = ? LIMIT 1`,
      )
      .get<{ ok: number }>(storedName, share.note_id);
    if (owned) return true;
  }

  return false;
}

/** The shared document itself. */
router.get('/share/:token/note', requireShareAccess, async (req, res) => {
  const { noteId, canEdit, displayName } = ctx(req);
  const note = await db
    .prepare('SELECT id, title, content_json, kind, updated_at FROM notes WHERE id = ?')
    .get<{ id: string; title: string; content_json: string; kind: string; updated_at: string }>(
      noteId,
    );
  if (!note) {
    res.status(404).json({ error: 'Note not found' });
    return;
  }
  const latest = await db
    .prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM note_events WHERE note_id = ?')
    .get<{ seq: number }>(noteId);
  res.json({
    note: {
      id: note.id,
      title: note.title,
      contentJson: JSON.parse(note.content_json),
      kind: note.kind,
      updatedAt: note.updated_at,
    },
    canEdit,
    you: displayName,
    revision: Number(latest?.seq ?? 0),
  });
});

router.patch('/share/:token/note', requireShareAccess, async (req, res) => {
  const { noteId, canEdit, actor } = ctx(req);
  if (!canEdit) {
    res.status(403).json({ error: 'This link is read-only' });
    return;
  }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const now = nowIso();

  if (typeof b.title === 'string') {
    await db.prepare('UPDATE notes SET title = ?, updated_at = ? WHERE id = ?').run(b.title, now, noteId);
  }
  if (b.contentJson && typeof b.contentJson === 'object') {
    // content_text must be derived here, exactly as the owner's PATCH does. It backs
    // full-text search, note snippets and the AI endpoints - writing content_json
    // alone left everything a guest typed permanently unsearchable, behind a snippet
    // frozen at whatever the note said before they joined.
    const contentText =
      typeof b.contentText === 'string' ? b.contentText : plainTextFromDoc(b.contentJson);
    await db
      .prepare('UPDATE notes SET content_json = ?, content_text = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(b.contentJson), contentText, now, noteId);
    // Wikilinks a guest writes should resolve like anyone else's. Scoped to the
    // note's owner, since the link graph belongs to them, not to the guest.
    const owner = await db
      .prepare('SELECT user_id FROM notes WHERE id = ?')
      .get<{ user_id: string }>(noteId);
    if (owner) await syncLinksForNote(owner.user_id, noteId, contentText);
  }
  await db
    .prepare('INSERT INTO note_events (note_id, kind, payload, actor, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(noteId, 'doc', JSON.stringify({ title: b.title ?? null }), actor, now);

  res.json({ ok: true });
});

/**
 * Delta feed. Serverless functions cannot hold a WebSocket open, so collaborators
 * poll this with the highest revision they have seen and get only what is newer.
 * `actor` lets a client discard the echo of its own writes.
 */
router.get('/share/:token/events', requireShareAccess, async (req, res) => {
  const { noteId } = ctx(req);
  const since = Number(req.query.since ?? 0) || 0;
  const rows = await db
    .prepare(
      'SELECT seq, kind, payload, actor, created_at FROM note_events WHERE note_id = ? AND seq > ? ORDER BY seq ASC LIMIT 500',
    )
    .all<{ seq: number; kind: string; payload: string; actor: string; created_at: string }>(
      noteId,
      since,
    );

  const presence = await db
    .prepare(
      `SELECT display_name, color FROM share_guests
        WHERE share_id = ? AND last_seen_at > ? ORDER BY last_seen_at DESC LIMIT 20`,
    )
    .all<{ display_name: string; color: string }>(
      ctx(req).share.id,
      new Date(Date.now() - 60_000).toISOString(),
    );

  res.json({
    events: rows.map((r) => ({
      seq: Number(r.seq),
      kind: r.kind,
      payload: JSON.parse(r.payload),
      actor: r.actor,
      at: r.created_at,
    })),
    revision: rows.length ? Number(rows[rows.length - 1].seq) : since,
    presence: presence.map((p) => ({ name: p.display_name, color: p.color })),
  });
});

/** Ink strokes on a shared whiteboard. Append-only, same as the owner-side route. */
router.post('/share/:token/ink', requireShareAccess, async (req, res) => {
  const { noteId, canEdit, actor } = ctx(req);
  if (!canEdit) {
    res.status(403).json({ error: 'This link is read-only' });
    return;
  }
  const strokes = Array.isArray((req.body as Record<string, unknown>)?.strokes)
    ? ((req.body as Record<string, unknown>).strokes as unknown[])
    : [];
  const now = nowIso();
  const ids: string[] = [];
  for (const s of strokes) {
    const id = newId();
    await db
      // updated_at written explicitly rather than left to the column default. The
      // default is the DATABASE clock and `now` is the APP clock; the delta feed
      // pages on updated_at, so a guest's stroke stamped by the wrong clock can land
      // BEHIND the owner's cursor and never reach their offline copy of the note.
      .prepare('INSERT INTO note_ink (id, note_id, stroke, author_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, noteId, JSON.stringify(s), null, now, now);
    ids.push(id);
  }
  if (ids.length) {
    await db
      .prepare('INSERT INTO note_events (note_id, kind, payload, actor, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(noteId, 'ink', JSON.stringify({ ids }), actor, now);
  }
  res.status(201).json({ ids });
});

router.get('/share/:token/ink', requireShareAccess, async (req, res) => {
  const { noteId } = ctx(req);
  const rows = await db
    .prepare('SELECT id, stroke FROM note_ink WHERE note_id = ? AND deleted_at IS NULL ORDER BY created_at ASC')
    .all<{ id: string; stroke: string }>(noteId);
  res.json({
    strokes: rows.map((r) => {
      try {
        return { id: r.id, ...JSON.parse(r.stroke) };
      } catch {
        return { id: r.id };
      }
    }),
  });
});

export default router;
export { requireShareAccess };
