import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, UPLOADS_DIR, IS_SERVERLESS, config } from './config.js';
import { migrate } from './db.js';
import { requireAuth } from './auth/middleware.js';
import { CSP } from './lib/csp.js';

import authRouter from './routes/auth.js';
import oauthRouter from './routes/oauth.js';
import notebooksRouter from './routes/notebooks.js';
import notesRouter from './routes/notes.js';
import searchRouter from './routes/search.js';
import tagsRouter from './routes/tags.js';
import dashboardRouter from './routes/dashboard.js';
import aiRouter from './routes/ai.js';
import importsRouter from './routes/imports.js';
import studyRouter from './routes/study.js';
import templatesRouter from './routes/templates.js';
import canvasRouter from './routes/canvas.js';
import shareRouter from './routes/share.js';
import commentsRouter from './routes/comments.js';
import metaRouter from './routes/meta.js';
import uploadsRouter from './routes/uploads.js';
import exportRouter from './routes/export.js';
import syncRouter from './routes/sync.js';
import referencesRouter from './routes/references.js';

/**
 * The app is multi-user and cookie-authenticated, which makes a permissive CORS policy
 * strictly worse than it was under the old LAN-only trust model: the session cookie would
 * ride along on any cross-origin request, so any website the student visits in the same
 * browser could read and write their notes. Restrict Origin to what actually serves this
 * app, while still allowing same-origin/no-Origin requests (curl, mobile PWA served from
 * the API itself).
 *
 * The localhost and private-LAN allowance is gated on `!IS_SERVERLESS`, and that gate is the
 * security-relevant part. Paired with `credentials: true`, an unconditional allowance means a
 * page running on the victim's OWN machine or LAN can make credentialed cross-origin requests
 * against production: a random `http://localhost:3000` dev server, anything on the coffee-shop
 * or halls-of-residence subnet the laptop is joined to, or any host resolving under `.local`.
 * None of those are related to this deployment, and none of them should ever have been able to
 * read a signed-in user's notes off the deployed site.
 *
 * It stays on for local and self-hosted runs, where it is what makes those addresses reachable
 * at all and where the same origins are the operator's own machine rather than an attacker's.
 *
 * Worth being honest about the scope of the fix: phone capture over LAN does NOT depend on this
 * branch. In single-port mode Express serves web/dist and the API from the same host:port, and
 * under `npm run dev` Vite proxies /api server-side, so in both cases the phone's requests are
 * same-origin and never CORS-checked. The allowance only ever covered a split-origin setup
 * (SPA on one LAN host, API on another), which is why keeping it costs nothing locally and
 * removing it on serverless breaks nothing.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // no Origin header (same-origin nav, curl, native app), allow
  if (config.extraCorsOrigins.includes(origin)) return true;
  if (config.deployedOrigins.includes(origin)) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

  // Deployed: the only allowed origins are the ones named above, this deployment's own
  // hostnames and whatever FOLIO_CORS_ORIGINS lists. No host-shape guessing.
  if (IS_SERVERLESS) return false;

  const host = url.hostname;
  const isLocalhost = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  // Private-LAN ranges a phone/tablet on the same network would use.
  const isPrivateLan =
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
    host.endsWith('.local');
  return isLocalhost || isPrivateLan;
}

export function buildApp(): express.Express {
  const app = express();

  /**
   * Trust exactly one proxy hop, so `req.ip` is the address that proxy observed rather
   * than whatever the client wrote in `X-Forwarded-For`.
   *
   * A security review found this was never configured, despite a comment in rateLimit.ts
   * asserting it was. Without it Express leaves `req.ip` as the socket address, and the
   * limiter's own header parsing was reading the client-supplied hop, which made every
   * auth throttle bypassable by varying a header.
   *
   * `1`, not `true`: trusting every hop means trusting the whole chain, which is the same
   * forgeable value again. One hop matches the deployment, a single platform proxy in
   * front of the app. See lib/clientIp.ts, which prefers Vercel's own header when running
   * there and falls back to this.
   */
  app.set('trust proxy', 1);

  /**
   * CSP on every response, not just the HTML document.
   *
   * The document is the point of it, but two other response types need the same header for
   * their own reasons. A dedicated worker takes its policy from the headers on the worker
   * SCRIPT's response, not from the page that spawned it, so the transcription worker only
   * gets 'wasm-unsafe-eval' and the huggingface connect-src if /assets/*.js carries the
   * policy too. And /uploads serves user-uploaded bytes: if one is ever opened directly in a
   * tab it becomes a same-origin document, and this is what constrains it.
   *
   * Applying it to JSON API responses as well is a no-op, which is a fair price for having
   * one rule with no path matching to get wrong. This mirrors the blanket source in
   * vercel.json, where the CDN serves the static SPA and Express is never reached at all.
   */
  app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', CSP);
    next();
  });

  app.use(
    cors({
      origin(origin, cb) {
        cb(null, isAllowedOrigin(origin));
      },
      // Session auth is cookie-based, so the browser only attaches the cookie to
      // cross-origin requests when the response allows credentials.
      credentials: true,
    }),
  );
  // 20mb: a photo import posts the image inline. Lowering this breaks photo capture.
  app.use(express.json({ limit: '20mb' }));

  // Liveness only - no DB, no session, so it stays useful when either is broken.
  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  // Apply the schema before any route touches the database. `migrate()` memoises its own
  // promise, so this is a single settled-promise await per request after the first - but
  // it has to be a request-time gate, not just a boot step: on Vercel there is no boot
  // hook, and a cold instance's first request would otherwise hit missing tables.
  app.use('/api', (_req, _res, next) => {
    migrate().then(() => next(), next);
  });

  // Unauthenticated by necessity: signup/login/logout/me are how a session is obtained
  // in the first place. This router guards its own one privileged route (/password).
  app.use('/api/auth', authRouter);

  // Social sign-in shares the /api/auth prefix and is likewise unauthenticated - the
  // provider redirect + callback ARE how the session is obtained. Also serves
  // GET /api/auth/providers, which the signed-out login page reads to gate its buttons.
  app.use('/api/auth', oauthRouter);

  // Public share links: guests have no account, so this router cannot sit behind
  // requireAuth. It guards each route individually instead - the owner-only routes
  // (/notes/:id/shares, /shares/:id) with requireAuth, and the guest routes with
  // requireShareAccess, which validates the share token and password gate.
  // Mounted before the routers below so /api/notes/:noteId/shares resolves here.
  app.use('/api', shareRouter);

  // Everything below is user-owned data. requireAuth is applied here, once, rather than
  // inside each router: one place to audit, and one session lookup per request.
  // `userId(req)` inside these routers throws if the guard is ever removed, so a
  // mis-mount fails loudly with a 500 rather than silently querying `undefined`.
  // Paths are /notes/:id/comments and /comments/:id, so this mounts at /api -
  // before /api/notes so the nested route resolves.
  app.use('/api', requireAuth, commentsRouter);
  app.use('/api/notebooks', requireAuth, notebooksRouter);
  app.use('/api/notes', requireAuth, notesRouter);
  // Whole-account export. Its own mount rather than a route inside notesRouter: there,
  // any path it claimed would have to be registered ahead of `/:id` to avoid being read
  // as a note id, which is an ordering trap the next person to add a route would inherit.
  app.use('/api/export', requireAuth, exportRouter);
  app.use('/api/search', requireAuth, searchRouter);
  app.use('/api/tags', requireAuth, tagsRouter);
  app.use('/api/dashboard', requireAuth, dashboardRouter);
  app.use('/api/ai', requireAuth, aiRouter);
  app.use('/api/import', requireAuth, importsRouter);
  app.use('/api/study', requireAuth, studyRouter);
  app.use('/api/templates', requireAuth, templatesRouter);
  app.use('/api/references', requireAuth, referencesRouter);
  app.use('/api/canvas', requireAuth, canvasRouter);
  // The offline client's delta feed. Owner-scoped throughout, like everything above.
  app.use('/api/sync', requireAuth, syncRouter);
  // /api/meta reports LAN addresses and AI configuration. That is deployment detail
  // about the host, not public information, so it is signed-in-only like the rest.
  app.use('/api/meta', requireAuth, metaRouter);

  // Attachment payloads live in Postgres and are served from there - the database is the
  // source of truth, and the only storage that exists at all on a serverless host.
  // Mounted BEFORE the static handler so the row always wins over a stale local file.
  //
  // The static mount is kept behind it for local development, where uploads written by an
  // older build (or by the seed script) may still be sitting in data/uploads/. It only ever
  // sees requests the database could not answer. It is skipped entirely on serverless,
  // where UPLOADS_DIR does not exist.
  app.use('/uploads', uploadsRouter);
  if (!IS_SERVERLESS) app.use('/uploads', express.static(UPLOADS_DIR));

  // JSON 404 for unknown API routes. Must precede the SPA catch-all, or an unknown
  // /api path would be answered with index.html.
  app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));

  // Serve the built SPA when web/dist exists (single-port mode, used for phone-on-LAN).
  const dist = path.join(ROOT, 'web', 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    // Express 5 removed the bare '*' path pattern - a named wildcard ('/*splat') is
    // now required, and '*' throws a path-to-regexp parse error at mount time.
    app.get('/*splat', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return next();
      res.sendFile(path.join(dist, 'index.html'));
    });
  }

  // Central error handler: always JSON, never HTML stack pages.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = err instanceof Error ? err.message : String(err);
    const status = (err as { status?: number })?.status ?? 500;
    if (status >= 500) console.error('[folio]', err);
    res.status(status).json({ error: message });
  });

  return app;
}
