# Offline Desktop App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an Electron desktop app for Windows and macOS that loads the live Unote site, keeps working with no connection, and picks up every web deploy without a new binary.

**Architecture:** The Electron window loads the production origin directly, so the httpOnly same-origin cookie session keeps working untouched. A service worker caches the built assets for offline code delivery and auto-updates on deploy. Data offline comes from a Dexie/IndexedDB mirror behind the `Proxy` seam that already exists in `web/src/lib/api.ts`, with an outbox for writes made offline and a delta-sync engine reconciling against the server on reconnect.

**Tech Stack:** Electron 33, electron-builder 25, electron-updater 6, vite-plugin-pwa 0.21 (Workbox), Dexie 4, Express + Postgres (Neon) server, React 19 + TipTap web app, Vitest (server), Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-08-09-offline-desktop-design.md`

## Global Constraints

- **Scope is Stage 0 and Stage 1 only.** Ink, canvas, images/attachments (Stage 2), offline search (Stage 3) and Yjs bodies (Stage 4) are out of scope. Do not implement them.
- **Never edit the inline `<script>` in `web/index.html`.** Its sha256 digest is pinned in `server/src/lib/csp.ts:27` and `vercel.json:22`. Editing even a comment inside it silently breaks CSP in production. Service worker registration goes in a separate module.
- **No CSP change is needed.** `worker-src 'self' blob:` is already present in `server/src/lib/csp.ts:82` and `vercel.json:22`. Do not add directives.
- **Timestamps are TEXT, ISO-8601 UTC.** Booleans are `INTEGER` 0/1. Follow the existing schema conventions (`server/src/schema.sql:1-10`).
- **SQL uses `?` placeholders.** `server/src/db.ts` rewrites them to `$1..$n`. Never write `$1` by hand.
- **Schema changes are additive and idempotent.** `schema.sql` is re-applied on every boot (`db.ts` `migrate()`). Use `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, matching `schema.sql:28-30`.
- **IDs are 14 characters of the alphabet `abcdefghijklmnopqrstuvwxyz0123456789`** (`db.ts:248`). Client-supplied IDs must match exactly that shape.
- **Never run `git add -A`.** Stage explicit paths only. This repo tree contains untracked local files.
- **Never write to a non-local `DATABASE_URL`.** `.env.local` may hold the production connection string.
- **Branch:** all work lands on `feat/offline-desktop`.
- Every task ends with a commit. Commit messages use the existing style: lowercase `type(scope): summary`, body explaining *why*.

## File Structure

**Created — Electron shell (Stage 0), owned by Stream A:**
- `desktop/main.ts` — BrowserWindow lifecycle, origin allowlist, offline fallback, updater wiring
- `desktop/preload.ts` — the only bridge; exposes `window.unoteDesktop`
- `desktop/offline.html` — bundled first-run-offline page
- `desktop/tsconfig.json`, `desktop/package.json`, `electron-builder.yml`

**Created — sync contract, owned by me (integration), consumed by B and C:**
- `web/src/lib/sync/contract.ts` — wire types shared by client and server

**Created — server (Stage 1), owned by Stream B:**
- `server/src/routes/sync.ts` — `GET /api/sync/changes`
- `server/src/lib/syncCursor.ts` — composite cursor encode/decode
- `server/src/lib/conflict.ts` — conflict detection and version demotion
- `server/test/sync.test.ts`, `server/test/conflict.test.ts`, `server/test/clientIds.test.ts`

**Created — local store (Stage 1), owned by Stream C:**
- `web/src/lib/local/db.ts` — Dexie schema
- `web/src/lib/local/records.ts` — record types and mappers
- `web/src/lib/local/outbox.ts` — queue, coalescing, dependency ordering
- `web/src/lib/local/localApi.ts` — `guestApi` promoted onto Dexie
- `web/src/lib/local/localApi.test.ts`, `web/src/lib/local/outbox.test.ts`

**Created — sync engine (Stage 1), owned by me:**
- `web/src/lib/sync/engine.ts` — pull/push loop, cursor, clock offset
- `web/src/lib/sync/connectivity.ts` — online/offline state from real request outcomes
- `web/src/lib/sync/engine.test.ts`, `web/src/lib/sync/convergence.test.ts`

**Created — UI:**
- `web/src/components/ConnectionStatus.tsx` + `.css`

**Modified:**
- `server/src/schema.sql` — additive columns and indexes
- `server/src/db.ts` — purge covers new tombstones
- `server/src/app.ts` — mount sync router
- `server/src/routes/notes.ts`, `notebooks.ts`, `study.ts` — accept client IDs, `baseUpdatedAt`
- `web/vite.config.ts` — vite-plugin-pwa
- `web/src/lib/api.ts` — three-state resolver
- `web/src/features/guest/*` — repoint at the shared local store
- `package.json` (root) — desktop scripts; **I own this file, no stream edits it**

---

# STAGE 0 — The shell

## Task 1: Service worker for offline app code

**Files:**
- Modify: `web/vite.config.ts`
- Create: `web/src/registerSW.ts`
- Modify: `web/src/main.tsx` (import the registration module)
- Test: `server/test/csp.test.ts` (must still pass, unchanged)

**Interfaces:**
- Consumes: nothing
- Produces: `registerServiceWorker(): void` from `web/src/registerSW.ts`

- [ ] **Step 1: Install the plugin**

```bash
npm install -D vite-plugin-pwa@^0.21.0 -w web
```

- [ ] **Step 2: Confirm the CSP test passes BEFORE touching anything**

Run: `npx vitest run test/csp.test.ts --root server`
Expected: PASS. If it fails now, stop — something else is already broken and this task would be blamed for it.

- [ ] **Step 3: Add the plugin to the Vite config**

Replace the contents of `web/vite.config.ts` with:

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

const apiPort = process.env.FOLIO_PORT ?? '4780'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // autoUpdate: a new deploy installs in the background and activates on the
      // next launch. No update prompt - the desktop shell has its own, and two
      // competing update notices is one too many.
      registerType: 'autoUpdate',
      injectRegister: null, // registration is ours, in src/registerSW.ts
      workbox: {
        // The app shell only. Model weights and wasm are fetched from
        // huggingface.co / jsdelivr at runtime and must not be precached: they
        // are tens of megabytes and are already allowed by connect-src.
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        // tesseract ships its own worker + training data under /tesseract.
        globIgnores: ['**/tesseract/**', '**/*.wasm'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        // SPA deep links resolve to index.html when offline, EXCEPT /api and
        // /uploads which must always hit the network (or fail honestly).
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/uploads\//],
        cleanupOutdatedCaches: true,
      },
      manifest: {
        name: 'Unote',
        short_name: 'Unote',
        description: 'A student notebook.',
        theme_color: '#1c1917',
        background_color: '#faf9f7',
        display: 'standalone',
        start_url: '/',
        icons: [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
    }),
  ],
  server: {
    host: true,
    port: Number(process.env.FOLIO_WEB_PORT ?? 5173),
    strictPort: true,
    proxy: {
      '/api': `http://localhost:${apiPort}`,
      '/uploads': `http://localhost:${apiPort}`,
    },
  },
})
```

- [ ] **Step 4: Create the registration module**

Create `web/src/registerSW.ts`:

```ts
// Service worker registration.
//
// This lives in its own module rather than inline in index.html on purpose: that
// file's inline <script> is allowed by a pinned sha256 hash (server/src/lib/csp.ts,
// vercel.json), so adding a character to it breaks the CSP in production with no
// symptom but a wrong-theme first paint.
//
// Registration is deliberately quiet. A failure here costs offline support, not
// the session, so it must never surface as an error to someone taking notes.
import { registerSW } from 'virtual:pwa-register';

export function registerServiceWorker(): void {
  if (import.meta.env.DEV) return; // the dev server has no built assets to cache
  try {
    registerSW({ immediate: true });
  } catch {
    // No offline support this session. Nothing else changes.
  }
}
```

- [ ] **Step 5: Add the vite-plugin-pwa client types**

Add to `web/src/vite-env.d.ts` (create the file if absent):

```ts
/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />
```

- [ ] **Step 6: Call it from the app entry**

In `web/src/main.tsx`, add the import at the top of the import block and call it immediately before the `createRoot` call:

```ts
import { registerServiceWorker } from './registerSW';
```

```ts
registerServiceWorker();
```

- [ ] **Step 7: Verify the CSP test STILL passes**

Run: `npx vitest run test/csp.test.ts --root server`
Expected: PASS, 4 tests. This proves `index.html` was not touched.

- [ ] **Step 8: Verify the build emits a service worker**

Run: `npm run build -w web`
Expected: exit 0, and `web/dist/sw.js` plus `web/dist/manifest.webmanifest` exist.

Run: `ls web/dist/sw.js web/dist/manifest.webmanifest`
Expected: both listed.

- [ ] **Step 9: Confirm no model weights were precached**

Run: `node -e "const s=require('fs').readFileSync('web/dist/sw.js','utf8'); const n=(s.match(/\.wasm/g)||[]).length; console.log('wasm refs:', n); process.exit(n>0?1:0)"`
Expected: `wasm refs: 0`, exit 0.

- [ ] **Step 10: Commit**

```bash
git add web/vite.config.ts web/src/registerSW.ts web/src/vite-env.d.ts web/src/main.tsx web/package.json package-lock.json
git commit -m "feat(pwa): cache the app shell in a service worker

Offline app-code delivery, and the mechanism by which a web deploy reaches the
desktop app without a new binary. autoUpdate installs a new build in the
background and activates it on next launch.

Registration lives in its own module because the inline script in index.html is
allowed by a pinned sha256 hash - editing it breaks CSP in production with no
symptom but a wrong-theme first paint.

Model weights and wasm are excluded from precache: tens of megabytes, fetched
from huggingface.co at runtime, already allowed by connect-src."
```

---

## Task 2: Electron shell

**Files:**
- Create: `desktop/main.ts`, `desktop/preload.ts`, `desktop/offline.html`, `desktop/tsconfig.json`
- Modify: `package.json` (root) — **coordinate with the integrator, do not edit in parallel**

**Interfaces:**
- Consumes: nothing
- Produces: `window.unoteDesktop: { version: string; platform: string; isDesktop: true }` in the renderer

- [ ] **Step 1: Install Electron**

```bash
npm install -D electron@^33.0.0 electron-builder@^25.1.8 electron-updater@^6.3.9
```

- [ ] **Step 2: Write the preload bridge**

Create `desktop/preload.ts`:

```ts
// The ONLY bridge between the web app and Node. Everything here is reachable by
// any script the page loads, so it exposes facts and nothing that acts.
//
// contextIsolation is on and nodeIntegration off (see main.ts), so the renderer
// cannot reach require() even though this file can.
import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('unoteDesktop', {
  isDesktop: true,
  version: process.env.UNOTE_APP_VERSION ?? '0.0.0',
  platform: process.platform,
});
```

- [ ] **Step 3: Write the offline fallback page**

Create `desktop/offline.html`. This is only ever shown when the service worker has never installed — that is, a genuine first launch with no connection.

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Unote — no connection</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0; min-height: 100vh; display: grid; place-items: center;
      font: 16px/1.6 system-ui, sans-serif; background: #faf9f7; color: #1c1917;
      padding: 2rem;
    }
    @media (prefers-color-scheme: dark) { body { background: #1c1917; color: #f5f5f4; } }
    main { max-width: 30rem; text-align: left; }
    h1 { font-size: 1.4rem; margin: 0 0 .75rem; }
    p { margin: 0 0 1rem; }
    button {
      font: inherit; padding: .55rem 1.1rem; border-radius: 6px;
      border: 1px solid currentColor; background: transparent; color: inherit; cursor: pointer;
    }
    button:focus-visible { outline: 2px solid #0e7490; outline-offset: 2px; }
  </style>
</head>
<body>
  <main>
    <h1>Unote needs the internet once</h1>
    <p>The first time Unote runs it downloads itself so it can work offline afterwards. It looks like there is no connection right now.</p>
    <p>Connect and try again — this only happens once.</p>
    <button id="retry" type="button">Try again</button>
  </main>
  <script>
    document.getElementById('retry').addEventListener('click', () => {
      window.location.replace('unote-retry://reload');
    });
  </script>
</body>
</html>
```

- [ ] **Step 4: Write the main process**

Create `desktop/main.ts`:

```ts
// Electron shell for Unote.
//
// The window loads the PRODUCTION ORIGIN rather than bundled assets. That is the
// load-bearing decision in this file: Unote's session is an httpOnly, same-origin
// cookie, so serving the app from file:// or a custom protocol would make every
// API call cross-origin, stop the cookie being attached, and require CORS plus
// SameSite=None cookies or a whole token auth path server-side.
//
// Offline therefore depends on the service worker, which serves loadURL from cache
// once installed. The one case it cannot cover is a first launch with no network -
// nothing is cached yet - and that is what offline.html is for.
import { app, BrowserWindow, shell, session } from 'electron';
import { autoUpdater } from 'electron-updater';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const APP_ORIGIN = process.env.UNOTE_ORIGIN ?? 'https://unote-six.vercel.app';
const RETRY_SCHEME = 'unote-retry';

let mainWindow: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 680,
    minHeight: 520,
    backgroundColor: '#faf9f7',
    title: 'Unote',
    autoHideMenuBarOnFullScreen: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Anything that is not the app itself opens in the real browser. Without this a
  // share link or an external doc would open a chromeless Electron window with no
  // address bar - the user could not tell what site they were on.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== APP_ORIGIN) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  // did-fail-load fires for the retry pseudo-navigation too; only a real failure
  // to reach the app origin should swap in the offline page.
  win.webContents.on('did-fail-load', (_e, errorCode, _desc, failedUrl, isMainFrame) => {
    if (!isMainFrame) return;
    if (errorCode === -3) return; // ERR_ABORTED: a navigation we replaced ourselves
    if (failedUrl.startsWith(`${RETRY_SCHEME}:`)) {
      void win.loadURL(APP_ORIGIN);
      return;
    }
    void win.loadFile(path.join(__dirname, 'offline.html'));
  });

  void win.loadURL(APP_ORIGIN);
  return win;
}

// One instance only. A second copy would hold its own IndexedDB lock and the two
// would fight over the outbox.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(() => {
    process.env.UNOTE_APP_VERSION = app.getVersion();

    // The renderer is remote content. Refuse every permission request it makes:
    // nothing in Stage 0 or Stage 1 needs camera, mic, geolocation or notifications,
    // so the safe default is a blanket no rather than a per-permission allowlist
    // that grows by accident.
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

    mainWindow = createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });

    // Updates for the SHELL only. Web code updates itself through the service
    // worker, so this fires rarely - an Electron bump, a change in this file.
    if (app.isPackaged) {
      autoUpdater.autoDownload = true;
      autoUpdater.on('error', () => {
        // A failed update check must never interrupt note-taking.
      });
      void autoUpdater.checkForUpdatesAndNotify();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
```

- [ ] **Step 5: Add the desktop TypeScript config**

Create `desktop/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "../dist-desktop",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["*.ts"]
}
```

- [ ] **Step 6: Verify it compiles**

Run: `npx tsc -p desktop/tsconfig.json --noEmit`
Expected: exit 0, no output.

- [ ] **Step 7: Commit**

```bash
git add desktop/main.ts desktop/preload.ts desktop/offline.html desktop/tsconfig.json package.json package-lock.json
git commit -m "feat(desktop): Electron shell loading the production origin

Loads the live site rather than bundled assets, because the session is an
httpOnly same-origin cookie - serving from file:// would make every API call
cross-origin and require CORS plus SameSite=None or a token auth path.

Offline therefore rides on the service worker. The one gap it cannot cover is a
first launch with no network, which is what offline.html handles.

Renderer is treated as remote content: contextIsolation on, nodeIntegration off,
sandbox on, all permission requests refused, off-origin navigation handed to the
system browser."
```

---

## Task 3: Package the desktop app

**Files:**
- Create: `electron-builder.yml`
- Modify: `package.json` (root)

**Interfaces:**
- Consumes: `desktop/main.ts` compiled output from Task 2
- Produces: `npm run desktop:dev`, `npm run desktop:build`

- [ ] **Step 1: Write the builder config**

Create `electron-builder.yml`:

```yaml
appId: com.unote.desktop
productName: Unote
copyright: Unote

directories:
  output: release
  buildResources: desktop/build

files:
  - dist-desktop/**/*
  - desktop/offline.html

# The web app is fetched from the origin at runtime, so no renderer assets ship
# here. That is what keeps a web deploy reaching the app without a new binary.
publish:
  provider: generic
  url: https://unote-six.vercel.app/desktop
  channel: latest

win:
  target: [nsis]
  artifactName: Unote-Setup-${version}.${ext}

nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true

mac:
  target: [dmg, zip]   # zip is required for electron-updater on macOS
  category: public.app-category.productivity
  hardenedRuntime: true
  gatekeeperAssess: false
  artifactName: Unote-${version}-${arch}.${ext}

linux:
  target: []   # out of scope
```

- [ ] **Step 2: Add the scripts and build metadata to the root package.json**

Add to `scripts` in `package.json`:

```json
"desktop:compile": "tsc -p desktop/tsconfig.json && node scripts/desktop-postbuild.mjs",
"desktop:dev": "npm run desktop:compile && electron dist-desktop/main.js",
"desktop:build": "npm run desktop:compile && electron-builder --config electron-builder.yml"
```

Add at the top level of `package.json`:

```json
"main": "dist-desktop/main.js",
```

- [ ] **Step 3: Write the postbuild step**

Electron loads preload scripts as CommonJS regardless of the package `type`, so the compiled preload must be renamed to `.cjs` — which is exactly the path `main.ts` references.

Create `scripts/desktop-postbuild.mjs`:

```js
// Electron requires preload scripts to be CommonJS, but this package is "type":
// "module", so a .js preload is parsed as ESM and fails with "require is not
// defined" at window creation. Renaming to .cjs is the whole fix, and main.ts
// already points at preload.cjs.
import fs from 'node:fs';
import path from 'node:path';

const out = path.resolve('dist-desktop');
const from = path.join(out, 'preload.js');
const to = path.join(out, 'preload.cjs');

if (!fs.existsSync(from)) {
  console.error(`desktop-postbuild: expected ${from} to exist. Did tsc run?`);
  process.exit(1);
}

let source = fs.readFileSync(from, 'utf8');
// tsc emits ESM import syntax; the preload is tiny and needs exactly one require.
source = source.replace(/^import\s*\{\s*contextBridge\s*\}\s*from\s*['"]electron['"];?\s*$/m,
  "const { contextBridge } = require('electron');");
fs.writeFileSync(to, source);
fs.rmSync(from);
console.log('desktop-postbuild: wrote preload.cjs');
```

- [ ] **Step 4: Compile and check the artifacts**

Run: `npm run desktop:compile`
Expected: exit 0, printing `desktop-postbuild: wrote preload.cjs`.

Run: `ls dist-desktop/`
Expected: `main.js` and `preload.cjs` present, `preload.js` absent.

- [ ] **Step 5: Launch it against the live site**

Run: `npm run desktop:dev`
Expected: a window opens showing Unote's marketing landing page or dashboard. Close it.

If the window is blank, check the terminal for a CSP or load error before proceeding.

- [ ] **Step 6: Commit**

```bash
git add electron-builder.yml package.json scripts/desktop-postbuild.mjs package-lock.json
git commit -m "build(desktop): package with electron-builder, generic update feed

No renderer assets are bundled - the app fetches the web build from the origin,
which is what lets a web deploy reach it without a new binary. The updater feed
is a static path on the same Vercel project, so no GitHub token ships inside
the app.

macOS needs the zip target alongside dmg: electron-updater cannot apply a dmg."
```

---

# STAGE 1 — The offline data layer

## Task 4: Schema prerequisites

**Files:**
- Modify: `server/src/schema.sql`
- Modify: `server/src/db.ts` (purge)
- Test: `server/test/schemaSync.test.ts` (create)

**Interfaces:**
- Consumes: nothing
- Produces: `updated_at` and `deleted_at` on the mirrored tables; `purgeExpiredDeleted(days?: number): Promise<Record<string, number>>` exported from `db.ts`

- [ ] **Step 1: Write the failing test**

Create `server/test/schemaSync.test.ts`:

```ts
// Every table the offline client mirrors must be able to answer two questions:
// "what changed since X" and "what was deleted". Without updated_at the first is
// unanswerable; without deleted_at a delete cannot be replicated to a client that
// was offline when it happened, so that client's outbox resurrects the record.
import { describe, it, expect, beforeAll } from 'vitest';
import { db, migrate } from '../src/db.js';

const MIRRORED = ['notebooks', 'notes', 'canvas_items', 'canvas_edges', 'note_ink', 'flashcards'] as const;

async function columns(table: string): Promise<string[]> {
  const rows = await db
    .prepare('SELECT column_name FROM information_schema.columns WHERE table_name = ?')
    .all<{ column_name: string }>(table);
  return rows.map((r) => r.column_name);
}

describe('sync schema prerequisites', () => {
  beforeAll(async () => {
    await migrate();
  });

  for (const table of MIRRORED) {
    it(`${table} has updated_at`, async () => {
      expect(await columns(table)).toContain('updated_at');
    });

    it(`${table} has deleted_at`, async () => {
      expect(await columns(table)).toContain('deleted_at');
    });
  }

  it('review_log has neither, being append-only', async () => {
    const cols = await columns('review_log');
    expect(cols).not.toContain('deleted_at');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/schemaSync.test.ts --root server`
Expected: FAIL — 9 of 12 assertions fail (only `notes` has both; `canvas_items` has `updated_at` only).

- [ ] **Step 3: Add the columns to schema.sql**

Append to `server/src/schema.sql`, immediately after the existing `ALTER TABLE` block for `users` so all additive columns sit together:

```sql
-- Additive columns for delta sync (offline desktop app).
--
-- Two separate needs, both unmeetable before this block:
--   * updated_at answers "what changed since <cursor>". Only notes and
--     canvas_items had one, so the other four tables could not be synced at all.
--   * deleted_at is a tombstone. A hard DELETE cannot be replicated to a client
--     that was offline when it happened - that client's outbox re-uploads the row
--     and RESURRECTS it, silently. Every mirrored table needs one.
--
-- Defaults are the row's created_at where available so pre-existing rows sort
-- correctly on first sync rather than all arriving at the epoch.
ALTER TABLE notebooks    ADD COLUMN IF NOT EXISTS updated_at TEXT;
ALTER TABLE canvas_edges ADD COLUMN IF NOT EXISTS updated_at TEXT;
ALTER TABLE note_ink     ADD COLUMN IF NOT EXISTS updated_at TEXT;
ALTER TABLE flashcards   ADD COLUMN IF NOT EXISTS updated_at TEXT;

UPDATE notebooks    SET updated_at = created_at WHERE updated_at IS NULL;
UPDATE canvas_edges SET updated_at = created_at WHERE updated_at IS NULL;
UPDATE note_ink     SET updated_at = created_at WHERE updated_at IS NULL;
UPDATE flashcards   SET updated_at = created_at WHERE updated_at IS NULL;

ALTER TABLE notebooks    ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE canvas_edges ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE note_ink     ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE flashcards   ALTER COLUMN updated_at SET NOT NULL;

ALTER TABLE notebooks    ADD COLUMN IF NOT EXISTS deleted_at TEXT;
ALTER TABLE canvas_items ADD COLUMN IF NOT EXISTS deleted_at TEXT;
ALTER TABLE canvas_edges ADD COLUMN IF NOT EXISTS deleted_at TEXT;
ALTER TABLE note_ink     ADD COLUMN IF NOT EXISTS deleted_at TEXT;
ALTER TABLE flashcards   ADD COLUMN IF NOT EXISTS deleted_at TEXT;

-- Delta-sync covering indexes. The cursor is composite (updated_at, id), so the
-- index must be too or every sync page becomes a sort.
--
-- canvas_items, canvas_edges and note_ink carry no user_id: they are scoped by
-- note_id and the sync query joins through notes. Their index therefore leads on
-- note_id, and notes' own idx_notes_user_updated covers the join side.
CREATE INDEX IF NOT EXISTS idx_notebooks_sync    ON notebooks(user_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_notes_sync        ON notes(user_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_flashcards_sync   ON flashcards(user_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_canvas_items_sync ON canvas_items(note_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_canvas_edges_sync ON canvas_edges(note_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_note_ink_sync     ON note_ink(note_id, updated_at, id);
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run test/schemaSync.test.ts --root server`
Expected: PASS, 13 tests.

- [ ] **Step 5: Extend the purge to the new tombstones**

In `server/src/db.ts`, replace `purgeExpiredDeletedNotes` with a version covering every tombstoned table, keeping the old name as a thin wrapper so existing callers are untouched:

```ts
/** Tables carrying a `deleted_at` tombstone, purged on the same 30-day clock. */
const TOMBSTONED = ['notes', 'notebooks', 'canvas_items', 'canvas_edges', 'note_ink', 'flashcards'] as const;

/**
 * Purge rows soft-deleted more than `days` ago, across every tombstoned table.
 *
 * Tombstones exist so an offline client learns about a delete it missed. They are
 * therefore garbage the moment no client could still be that far behind - but they
 * are NOT optional before then, so the window has to outlast a plausible offline
 * stretch. 30 days matches what notes already used.
 */
export async function purgeExpiredDeleted(days = 30): Promise<Record<string, number>> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const out: Record<string, number> = {};
  for (const table of TOMBSTONED) {
    const r = await db
      .prepare(`DELETE FROM ${table} WHERE deleted_at IS NOT NULL AND deleted_at < ?`)
      .run(cutoff);
    out[table] = r.changes;
  }
  return out;
}

/** @deprecated use purgeExpiredDeleted. Kept so existing boot code is untouched. */
export async function purgeExpiredDeletedNotes(days = 30): Promise<number> {
  const counts = await purgeExpiredDeleted(days);
  return counts.notes ?? 0;
}
```

- [ ] **Step 6: Run the whole server suite for regressions**

Run: `npm run test -w server`
Expected: all tests pass. Record the count in the commit message.

- [ ] **Step 7: Commit**

```bash
git add server/src/schema.sql server/src/db.ts server/test/schemaSync.test.ts
git commit -m "feat(sync): updated_at and deleted_at on every mirrored table

Two prerequisites for delta sync, both silent-data-loss class.

updated_at existed only on notes and canvas_items, so there was no way to ask
what changed on notebooks, canvas_edges, note_ink or flashcards - delta sync
could not exist for them. Backfilled from created_at so pre-existing rows sort
correctly on a client's first sync.

deleted_at existed only on notes. A hard delete cannot be replicated to a client
that was offline when it happened: that client's outbox re-uploads the row and
resurrects it, with no error anywhere. The purge job now covers all six tables
on the same 30-day clock, which has to outlast a plausible offline stretch."
```

---

## Task 5: The sync wire contract

**Files:**
- Create: `web/src/lib/sync/contract.ts`
- Test: none (types only; consumers' tests cover it)

**Interfaces:**
- Consumes: nothing
- Produces: every type below. Tasks 6, 9, 10, 11, 12 and 13 all import from here. **This is the fixed interface — do not change it without telling the integrator.**

- [ ] **Step 1: Write the contract**

Create `web/src/lib/sync/contract.ts`:

```ts
// The wire contract between the local store and the server, and the single
// source of truth for both sides of sync. The server imports these types too
// (via a relative path from server/src) so a change cannot land on one side only.

/** Tables the offline client mirrors. Order matters: see OUTBOX_ORDER. */
export const SYNC_ENTITIES = [
  'notebook', 'note', 'canvasItem', 'canvasEdge', 'ink', 'flashcard', 'review',
] as const;
export type SyncEntity = (typeof SYNC_ENTITIES)[number];

/**
 * Push order. The server validates references - routes/notes.ts returns 400 for
 * an unknown notebookId - so a note created offline inside a notebook created
 * offline must be sent after it. Reviews go last: they reference flashcards.
 */
export const OUTBOX_ORDER: readonly SyncEntity[] = [
  'notebook', 'note', 'flashcard', 'canvasItem', 'canvasEdge', 'ink', 'review',
];

/** Every synced record carries these three, whatever else it holds. */
export interface SyncedRecord {
  id: string;
  updatedAt: string;
  /** Non-null means tombstoned. The record still arrives; it is a delete notice. */
  deletedAt: string | null;
}

/**
 * A composite cursor, NOT a bare timestamp.
 *
 * With a bare timestamp `>` silently skips every record sharing the boundary
 * instant and `>=` returns them forever. Both failures are invisible until a user
 * loses a note. The id breaks the tie and makes the ordering total.
 */
export interface SyncCursor {
  updatedAt: string;
  id: string;
}

/** Opaque on the wire so the client never constructs one by hand. */
export type EncodedCursor = string;

export interface SyncChangesRequest {
  since?: EncodedCursor;
  limit?: number;
}

export interface SyncChangesResponse {
  /** Feed straight back as `since` on the next page. Null means fully caught up. */
  cursor: EncodedCursor | null;
  hasMore: boolean;
  /**
   * The server's clock at the moment it answered. The client stores the offset
   * and corrects its own timestamps before pushing, because an offline edit
   * carries only the client's claim about when it happened - a machine an hour
   * fast would otherwise win every conflict.
   */
  serverNow: string;
  changes: SyncChangeSet;
}

export type SyncChangeSet = {
  [K in SyncEntity]?: SyncedRecord[];
};

export const DEFAULT_SYNC_LIMIT = 500;
export const MAX_SYNC_LIMIT = 2000;

// --- push -------------------------------------------------------------------

export type OutboxOp = 'create' | 'update' | 'delete';

export interface WriteEnvelope<T = unknown> {
  /**
   * The server `updated_at` the client last saw for this record. A mismatch
   * against the row's current value is a conflict. Absent for creates, and absent
   * from the website's own writes - which is why the check is opt-in server-side
   * and existing callers are unaffected.
   */
  baseUpdatedAt?: string | null;
  /**
   * When the client believes the edit happened, already corrected for clock
   * offset. The server clamps it to between the row's created_at and its own now,
   * rather than rejecting - rejecting would strand the edit in the outbox over
   * something the user cannot fix.
   */
  clientUpdatedAt?: string;
  payload: T;
}

/** Returned by any write that took a WriteEnvelope. */
export interface WriteResult<T = unknown> {
  record: T;
  /** True when the server resolved a conflict. The losing copy went to history. */
  conflicted: boolean;
  /** Set when `conflicted` and the entity keeps history (notes only). */
  versionId?: number;
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `npx tsc --noEmit -p web/tsconfig.json`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add web/src/lib/sync/contract.ts
git commit -m "feat(sync): the wire contract, shared by client and server

Fixed interface both sides import, so a change cannot land on one side only.

Two decisions are encoded here rather than left to implementers. The cursor is
composite (updatedAt, id) because a bare timestamp either skips records sharing
the boundary instant or returns them forever. And every response carries the
server's clock, because an offline edit carries only the client's claim about
when it happened - without correction a machine an hour fast wins every
conflict and one an hour slow loses every one."
```

---

## Task 6: The delta-sync endpoint

**Files:**
- Create: `server/src/lib/syncCursor.ts`, `server/src/routes/sync.ts`
- Modify: `server/src/app.ts`
- Test: `server/test/sync.test.ts`

**Interfaces:**
- Consumes: `SyncCursor`, `SyncChangesResponse`, `DEFAULT_SYNC_LIMIT`, `MAX_SYNC_LIMIT` from `web/src/lib/sync/contract.ts` (import path `../../../web/src/lib/sync/contract.js`)
- Produces: `GET /api/sync/changes?since=&limit=` → `SyncChangesResponse`; `encodeCursor(c: SyncCursor): string`, `decodeCursor(s: string): SyncCursor | null`

- [ ] **Step 1: Write the failing cursor test**

Create `server/test/sync.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor } from '../src/lib/syncCursor.js';

describe('sync cursor', () => {
  it('round-trips', () => {
    const c = { updatedAt: '2026-08-09T10:00:00.000Z', id: 'abc123def456gh' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it('rejects malformed input rather than throwing', () => {
    expect(decodeCursor('not-a-cursor')).toBeNull();
    expect(decodeCursor('')).toBeNull();
    // A cursor whose timestamp is not ISO-8601 would silently order wrongly.
    expect(decodeCursor(Buffer.from('nope|abc123def456gh').toString('base64url'))).toBeNull();
  });

  it('survives an id containing the separator', () => {
    // Defensive: ids are [a-z0-9] today, but a cursor that can be forged into a
    // different (updatedAt, id) pair is a sync-skipping bug waiting to happen.
    const c = { updatedAt: '2026-08-09T10:00:00.000Z', id: 'a|b|c' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/sync.test.ts --root server`
Expected: FAIL — cannot resolve `../src/lib/syncCursor.js`.

- [ ] **Step 3: Implement the cursor**

Create `server/src/lib/syncCursor.ts`:

```ts
// Composite sync cursor. See contract.ts for why it is not a bare timestamp.
import type { SyncCursor } from '../../../web/src/lib/sync/contract.js';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * JSON inside base64url rather than a delimiter-joined string, so an id that
 * happens to contain the delimiter cannot be forged into a different
 * (updatedAt, id) pair - which would make the server skip real records.
 */
export function encodeCursor(cursor: SyncCursor): string {
  return Buffer.from(JSON.stringify([cursor.updatedAt, cursor.id]), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): SyncCursor | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [updatedAt, id] = parsed;
    if (typeof updatedAt !== 'string' || typeof id !== 'string') return null;
    if (!ISO.test(updatedAt)) return null;
    return { updatedAt, id };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the cursor tests**

Run: `npx vitest run test/sync.test.ts --root server`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write the endpoint**

Create `server/src/routes/sync.ts`:

```ts
// GET /api/sync/changes - the delta feed the offline client pulls.
//
// One endpoint for every mirrored table rather than six, because the client needs
// them advanced by ONE cursor: six independent cursors can be individually
// correct and jointly inconsistent (a note arriving before the notebook it lives
// in), and reconciling that on the client is strictly harder than serving it
// consistently here.
import { Router } from 'express';
import { db } from '../db.js';
import { userId } from '../lib/session.js';
import { encodeCursor, decodeCursor } from '../lib/syncCursor.js';
import {
  DEFAULT_SYNC_LIMIT, MAX_SYNC_LIMIT,
  type SyncChangeSet, type SyncCursor, type SyncEntity,
} from '../../../web/src/lib/sync/contract.js';

const router = Router();

/**
 * How each entity is read. Tables carrying user_id filter on it directly; the
 * canvas and ink tables carry only note_id and must join through notes, which is
 * also what keeps another user's rows unreachable.
 */
/**
 * `alias` is the table prefix the cursor predicate and ORDER BY must use. The
 * joined tables need it because `notes` also has updated_at and id, and an
 * unqualified reference there is ambiguous - Postgres would reject the query.
 */
const SOURCES: Array<{ entity: SyncEntity; alias: string; sql: string }> = [
  {
    entity: 'notebook',
    alias: '',
    sql: `SELECT id, updated_at, deleted_at, name, emoji, color, position, archived, created_at
          FROM notebooks WHERE user_id = ?`,
  },
  {
    entity: 'note',
    alias: '',
    sql: `SELECT id, updated_at, deleted_at, notebook_id, title, content_json, content_text,
                 kind, pinned, archived, created_at
          FROM notes WHERE user_id = ?`,
  },
  {
    entity: 'flashcard',
    alias: '',
    sql: `SELECT id, updated_at, deleted_at, note_id, question, answer, due_at, interval_days,
                 ease, reps, lapses, suspended, created_at
          FROM flashcards WHERE user_id = ?`,
  },
  {
    entity: 'canvasItem',
    alias: 'ci.',
    sql: `SELECT ci.id, ci.updated_at, ci.deleted_at, ci.note_id, ci.kind, ci.data,
                 ci.x, ci.y, ci.w, ci.h, ci.created_at
          FROM canvas_items ci JOIN notes n ON n.id = ci.note_id WHERE n.user_id = ?`,
  },
  {
    entity: 'canvasEdge',
    alias: 'ce.',
    sql: `SELECT ce.id, ce.updated_at, ce.deleted_at, ce.note_id, ce.from_item_id,
                 ce.to_item_id, ce.created_at
          FROM canvas_edges ce JOIN notes n ON n.id = ce.note_id WHERE n.user_id = ?`,
  },
  {
    entity: 'ink',
    alias: 'i.',
    sql: `SELECT i.id, i.updated_at, i.deleted_at, i.note_id, i.stroke, i.created_at
          FROM note_ink i JOIN notes n ON n.id = i.note_id WHERE n.user_id = ?`,
  },
];

interface Row {
  id: string;
  updated_at: string;
  deleted_at: string | null;
  [k: string]: unknown;
}

/** snake_case columns to the camelCase the client store speaks. */
function camel(row: Row): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase())] = v;
  }
  return out;
}

router.get('/changes', async (req, res) => {
  const uid = userId(req);

  const rawSince = typeof req.query.since === 'string' ? req.query.since : '';
  // A malformed cursor is treated as "start from the beginning" rather than an
  // error: the alternative is a client wedged forever on a cursor it cannot fix.
  const since: SyncCursor = decodeCursor(rawSince) ?? { updatedAt: '', id: '' };

  const requested = Number(req.query.limit ?? DEFAULT_SYNC_LIMIT);
  const limit = Number.isFinite(requested)
    ? Math.min(Math.max(Math.trunc(requested), 1), MAX_SYNC_LIMIT)
    : DEFAULT_SYNC_LIMIT;

  // One extra row tells us whether another page exists without a second query.
  const perTable = limit + 1;
  const changes: SyncChangeSet = {};
  const flat: Array<{ entity: SyncEntity; row: Row }> = [];

  for (const source of SOURCES) {
    const a = source.alias;
    const rows = await db
      .prepare(
        `${source.sql}
           AND (${a}updated_at > ? OR (${a}updated_at = ? AND ${a}id > ?))
         ORDER BY ${a}updated_at ASC, ${a}id ASC
         LIMIT ?`,
      )
      .all<Row>(uid, since.updatedAt, since.updatedAt, since.id, perTable);
    for (const row of rows) flat.push({ entity: source.entity, row });
  }

  // Merge every table into ONE ordered stream and cut at `limit`, so the cursor
  // returned is a single position all tables share. Cutting per-table instead
  // would advance some tables past others and lose whatever fell in the gap.
  flat.sort((a, b) =>
    a.row.updated_at < b.row.updated_at ? -1
    : a.row.updated_at > b.row.updated_at ? 1
    : a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0,
  );

  const page = flat.slice(0, limit);
  const hasMore = flat.length > limit;

  for (const { entity, row } of page) {
    (changes[entity] ??= []).push(camel(row) as never);
  }

  const last = page.at(-1);
  res.json({
    cursor: last ? encodeCursor({ updatedAt: last.row.updated_at, id: last.row.id }) : null,
    hasMore,
    serverNow: new Date().toISOString(),
    changes,
  });
});

export default router;
```

- [ ] **Step 6: Write the endpoint test**

Add to `server/test/sync.test.ts`:

```ts
import { app } from '../src/app.js';
import request from 'supertest';
import { signUpAndLogin } from './helpers.js'; // use whatever the existing suite uses

describe('GET /api/sync/changes', () => {
  it('returns a notebook and note the caller owns, and a usable cursor', async () => {
    const agent = await signUpAndLogin();
    const nb = await agent.post('/api/notebooks').send({ name: 'Sync' });
    await agent.post('/api/notes').send({ notebookId: nb.body.notebook.id, title: 'One' });

    const first = await agent.get('/api/sync/changes?limit=1');
    expect(first.status).toBe(200);
    expect(first.body.hasMore).toBe(true);
    expect(first.body.cursor).toBeTruthy();
    expect(typeof first.body.serverNow).toBe('string');

    const second = await agent.get(`/api/sync/changes?since=${encodeURIComponent(first.body.cursor)}`);
    expect(second.status).toBe(200);

    const ids = [
      ...(first.body.changes.notebook ?? []), ...(first.body.changes.note ?? []),
      ...(second.body.changes.notebook ?? []), ...(second.body.changes.note ?? []),
    ].map((r: { id: string }) => r.id);
    // Paging must not duplicate or drop.
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(2);
  });

  it('never returns another account\'s rows', async () => {
    const a = await signUpAndLogin();
    const b = await signUpAndLogin();
    const nb = await a.post('/api/notebooks').send({ name: 'Private' });
    await a.post('/api/notes').send({ notebookId: nb.body.notebook.id, title: 'Secret' });

    const res = await b.get('/api/sync/changes');
    const titles = (res.body.changes.note ?? []).map((n: { title: string }) => n.title);
    expect(titles).not.toContain('Secret');
  });

  it('a malformed cursor starts from the beginning rather than erroring', async () => {
    const agent = await signUpAndLogin();
    const res = await agent.get('/api/sync/changes?since=garbage');
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 7: Mount the router**

In `server/src/app.ts`, beside the other authed routers:

```ts
app.use('/api/sync', requireAuth, syncRouter);
```

- [ ] **Step 8: Run the tests**

Run: `npx vitest run test/sync.test.ts --root server`
Expected: PASS, 6 tests.

- [ ] **Step 9: Commit**

```bash
git add server/src/lib/syncCursor.ts server/src/routes/sync.ts server/src/app.ts server/test/sync.test.ts
git commit -m "feat(sync): GET /api/sync/changes delta feed

One endpoint for all six mirrored tables, not six. The client needs them
advanced by ONE cursor: independent per-table cursors can each be correct and
jointly inconsistent - a note arriving before the notebook it lives in - and
reconciling that client-side is strictly harder than serving it consistently.

All tables merge into one ordered stream that is then cut at the limit, so the
cursor returned is a position every table shares. Cutting per-table would
advance some past others and lose whatever fell in the gap.

A malformed cursor restarts from the beginning rather than 400ing, because the
alternative is a client wedged forever on a cursor it cannot fix."
```

---

## Task 7: Accept client-supplied IDs

**Files:**
- Create: `server/src/lib/clientId.ts`
- Modify: `server/src/routes/notes.ts`, `server/src/routes/notebooks.ts`
- Test: `server/test/clientIds.test.ts`

**Interfaces:**
- Consumes: `newId` from `db.ts`
- Produces: `resolveId(supplied: unknown): string` from `server/src/lib/clientId.ts` — returns the supplied ID when it is well-formed, otherwise mints one

- [ ] **Step 1: Write the failing test**

Create `server/test/clientIds.test.ts`:

```ts
// An offline-created note must keep the id the client gave it. If the server
// re-mints, every [[wikilink]] and backlink pointing at that note breaks on first
// sync - the link resolves by title, but the id stored in `links` does not.
import { describe, it, expect } from 'vitest';
import { resolveId } from '../src/lib/clientId.js';

describe('resolveId', () => {
  it('accepts an id of exactly newId shape', () => {
    expect(resolveId('abc123def456gh')).toBe('abc123def456gh');
  });

  it('mints when absent', () => {
    expect(resolveId(undefined)).toMatch(/^[a-z0-9]{14}$/);
    expect(resolveId(null)).toMatch(/^[a-z0-9]{14}$/);
  });

  it('mints rather than trusting a malformed id', () => {
    // Wrong length, wrong alphabet, and the two that would matter most:
    // path traversal and SQL-ish payloads must never reach a query as an id.
    for (const bad of ['short', 'ABC123DEF456GH', 'abc-123-def456', '../../etc/passwd', "a' OR 1=1--", 'a'.repeat(64), 42, {}]) {
      expect(resolveId(bad)).toMatch(/^[a-z0-9]{14}$/);
      expect(resolveId(bad)).not.toBe(bad);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/clientIds.test.ts --root server`
Expected: FAIL — cannot resolve `../src/lib/clientId.js`.

- [ ] **Step 3: Implement it**

Create `server/src/lib/clientId.ts`:

```ts
// Client-supplied ids, for records created while offline.
//
// The rule is deliberately narrow: accept ONLY the exact shape newId() produces,
// and silently mint a replacement for anything else. Minting rather than
// rejecting means a client on a future version cannot wedge its own outbox on a
// 400 it does not understand - it just loses id stability for that one record,
// which costs an inbound wikilink, not the note.
import { newId } from '../db.js';

const SHAPE = /^[a-z0-9]{14}$/;

export function resolveId(supplied: unknown): string {
  return typeof supplied === 'string' && SHAPE.test(supplied) ? supplied : newId();
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run test/clientIds.test.ts --root server`
Expected: PASS, 3 tests.

- [ ] **Step 5: Use it in the note create route**

In `server/src/routes/notes.ts`, in the `router.post('/')` handler (around line 193), replace the `newId()` call that generates the note id with:

```ts
const id = resolveId(b.id);
```

Add the import at the top: `import { resolveId } from '../lib/clientId.js';`

Then wrap the INSERT so a collision is reported honestly rather than as a 500. Immediately before the insert:

```ts
// A collision means this client already created the record and is retrying a push
// whose response it never saw. Report it so the outbox can treat it as success
// rather than retrying forever.
const clash = await db.prepare('SELECT id FROM notes WHERE id = ?').get<{ id: string }>(id);
if (clash) {
  res.status(409).json({ error: 'id already exists', id });
  return;
}
```

- [ ] **Step 6: Do the same in the notebook create route**

Apply the identical change to `server/src/routes/notebooks.ts`'s POST handler, against the `notebooks` table.

- [ ] **Step 7: Add the route-level test**

Append to `server/test/clientIds.test.ts`:

```ts
describe('create with a client id', () => {
  it('keeps the id the client supplied', async () => {
    const agent = await signUpAndLogin();
    const nb = await agent.post('/api/notebooks').send({ name: 'N', id: 'aaaaaaaaaaaaaa' });
    expect(nb.body.notebook.id).toBe('aaaaaaaaaaaaaa');

    const note = await agent.post('/api/notes').send({ notebookId: 'aaaaaaaaaaaaaa', id: 'bbbbbbbbbbbbbb' });
    expect(note.body.note.id).toBe('bbbbbbbbbbbbbb');
  });

  it('409s a duplicate rather than 500ing', async () => {
    const agent = await signUpAndLogin();
    await agent.post('/api/notebooks').send({ name: 'N', id: 'cccccccccccccc' });
    const again = await agent.post('/api/notebooks').send({ name: 'N', id: 'cccccccccccccc' });
    expect(again.status).toBe(409);
  });

  it('cannot address another account\'s row', async () => {
    const a = await signUpAndLogin();
    const b = await signUpAndLogin();
    await a.post('/api/notebooks').send({ name: 'Mine', id: 'dddddddddddddd' });
    const attempt = await b.post('/api/notebooks').send({ name: 'Theirs', id: 'dddddddddddddd' });
    // The id is taken globally, so this is a 409 - crucially NOT a success that
    // overwrites, and NOT a leak of what the other row contains.
    expect(attempt.status).toBe(409);
    expect(JSON.stringify(attempt.body)).not.toContain('Mine');
  });
});
```

- [ ] **Step 8: Run the tests**

Run: `npx vitest run test/clientIds.test.ts --root server`
Expected: PASS, 6 tests.

- [ ] **Step 9: Commit**

```bash
git add server/src/lib/clientId.ts server/src/routes/notes.ts server/src/routes/notebooks.ts server/test/clientIds.test.ts
git commit -m "feat(sync): accept client-supplied ids on create

An offline-created note has to keep the id the client gave it. Re-minting
server-side breaks every wikilink and backlink aimed at it - links resolve by
title, but the id stored in \`links\` does not survive the change.

Only the exact shape newId() produces is accepted; anything else is silently
replaced. Minting rather than rejecting means a client on a future version
cannot wedge its outbox on a 400 it does not understand: it loses id stability
for one record, not the record.

A duplicate is a 409, which the outbox reads as \"this push already landed and I
never saw the response\" - not an error to retry forever."
```

---

## Task 8: Conflict resolution on write

**Files:**
- Create: `server/src/lib/conflict.ts`
- Modify: `server/src/schema.sql` (version cause comment), `server/src/routes/notes.ts` (PATCH)
- Test: `server/test/conflict.test.ts`

**Interfaces:**
- Consumes: `WriteEnvelope`, `WriteResult` from `contract.ts`
- Produces, all from `server/src/lib/conflict.ts`:
  - `clampEditTime(claimed: string | undefined, createdAt: string, serverNow: string): string`
  - `resolve(args: ResolveArgs): Resolution` where `Resolution = { conflicted: boolean; winner: 'client' | 'server' }`
  - `demoteToVersion(noteId: string, title: string, contentJson: string): Promise<number>`

- [ ] **Step 1: Write the failing clamp test**

Create `server/test/conflict.test.ts`:

```ts
// Clock skew decides conflicts unless it is contained. An offline edit carries
// only the client's CLAIM about when it happened, so a machine an hour fast wins
// every conflict and one an hour slow loses every one.
import { describe, it, expect } from 'vitest';
import { clampEditTime } from '../src/lib/conflict.js';

const CREATED = '2026-08-09T10:00:00.000Z';
const NOW = '2026-08-09T12:00:00.000Z';

describe('clampEditTime', () => {
  it('passes a plausible time through', () => {
    expect(clampEditTime('2026-08-09T11:00:00.000Z', CREATED, NOW)).toBe('2026-08-09T11:00:00.000Z');
  });

  it('clamps a future claim to the server now', () => {
    expect(clampEditTime('2026-08-09T18:00:00.000Z', CREATED, NOW)).toBe(NOW);
  });

  it('clamps a claim older than the row itself to created_at', () => {
    expect(clampEditTime('2020-01-01T00:00:00.000Z', CREATED, NOW)).toBe(CREATED);
  });

  it('falls back to the server now when the claim is absent or unparseable', () => {
    expect(clampEditTime(undefined, CREATED, NOW)).toBe(NOW);
    expect(clampEditTime('yesterday', CREATED, NOW)).toBe(NOW);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/conflict.test.ts --root server`
Expected: FAIL — cannot resolve `../src/lib/conflict.js`.

- [ ] **Step 3: Implement the clamp and the resolver**

Create `server/src/lib/conflict.ts`:

```ts
// Conflict resolution, server-side and nowhere else.
//
// The server is the sole authority on purpose. A client that resolved conflicts
// itself would need this logic in two places, and two copies of a merge rule drift
// - at which point two devices disagree about which edit won and both are certain.
import { db } from '../db.js';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

/**
 * Bound a client's claimed edit time to something the row's own history allows:
 * never later than the server's now, never earlier than the row's created_at.
 *
 * Clamps rather than rejects. Rejecting would strand the user's edit in the outbox
 * over a wrong system clock they may not be able to change.
 */
export function clampEditTime(claimed: string | undefined, createdAt: string, serverNow: string): string {
  if (!claimed || !ISO.test(claimed)) return serverNow;
  if (claimed > serverNow) return serverNow;
  if (claimed < createdAt) return createdAt;
  return claimed;
}

export interface ResolveArgs {
  /** The server's current updated_at for the row. */
  currentUpdatedAt: string;
  /** What the client last saw. Undefined/null means "no opinion, do not check". */
  baseUpdatedAt: string | null | undefined;
  /** The client's clamped edit time. */
  clientUpdatedAt: string;
}

export interface Resolution {
  conflicted: boolean;
  winner: 'client' | 'server';
}

/**
 * Decide a single write.
 *
 * No baseUpdatedAt means the caller is the website writing normally - there is
 * nothing to compare, so the write proceeds. That is what keeps this change
 * invisible to every existing caller.
 */
export function resolve(args: ResolveArgs): Resolution {
  const { currentUpdatedAt, baseUpdatedAt, clientUpdatedAt } = args;
  if (baseUpdatedAt == null) return { conflicted: false, winner: 'client' };
  if (baseUpdatedAt === currentUpdatedAt) return { conflicted: false, winner: 'client' };
  // Both sides moved. Newest wins; a tie goes to the server, because the server's
  // copy is the one other clients have already pulled.
  return { conflicted: true, winner: clientUpdatedAt > currentUpdatedAt ? 'client' : 'server' };
}

/**
 * Preserve a note body that lost a conflict. Notes are the only entity with a
 * history table, so this is where "nothing is destroyed" is actually true - see
 * the spec's accepted limitation for the others.
 */
export async function demoteToVersion(noteId: string, title: string, contentJson: string): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO note_versions (note_id, title, content_json, cause)
       VALUES (?, ?, ?, 'conflict') RETURNING id`,
    )
    .get<{ id: number }>(noteId, title, contentJson);
  return row!.id;
}
```

- [ ] **Step 4: Run the clamp tests**

Run: `npx vitest run test/conflict.test.ts --root server`
Expected: PASS, 4 tests.

- [ ] **Step 5: Add resolve() unit tests**

Append to `server/test/conflict.test.ts`:

```ts
import { resolve } from '../src/lib/conflict.js';

describe('resolve', () => {
  const base = { currentUpdatedAt: '2026-08-09T11:00:00.000Z' };

  it('does not check when the caller gave no base - the website\'s path', () => {
    expect(resolve({ ...base, baseUpdatedAt: undefined, clientUpdatedAt: '2026-08-09T10:00:00.000Z' }))
      .toEqual({ conflicted: false, winner: 'client' });
  });

  it('is not a conflict when the base still matches', () => {
    expect(resolve({ ...base, baseUpdatedAt: base.currentUpdatedAt, clientUpdatedAt: '2026-08-09T11:30:00.000Z' }))
      .toEqual({ conflicted: false, winner: 'client' });
  });

  it('newer client edit wins', () => {
    expect(resolve({ ...base, baseUpdatedAt: '2026-08-09T09:00:00.000Z', clientUpdatedAt: '2026-08-09T11:30:00.000Z' }))
      .toEqual({ conflicted: true, winner: 'client' });
  });

  it('newer server edit wins', () => {
    expect(resolve({ ...base, baseUpdatedAt: '2026-08-09T09:00:00.000Z', clientUpdatedAt: '2026-08-09T10:30:00.000Z' }))
      .toEqual({ conflicted: true, winner: 'server' });
  });

  it('a tie goes to the server, whose copy others have already pulled', () => {
    expect(resolve({ ...base, baseUpdatedAt: '2026-08-09T09:00:00.000Z', clientUpdatedAt: base.currentUpdatedAt }))
      .toEqual({ conflicted: true, winner: 'server' });
  });
});
```

- [ ] **Step 6: Wire it into the note PATCH route**

In `server/src/routes/notes.ts`'s PATCH handler: read `baseUpdatedAt` and `clientUpdatedAt` from the body, load the row's `created_at`, `updated_at`, `title` and `content_json`, then:

```ts
const editedAt = clampEditTime(b.clientUpdatedAt, existing.created_at, nowIso());
const decision = resolve({
  currentUpdatedAt: existing.updated_at,
  baseUpdatedAt: b.baseUpdatedAt,
  clientUpdatedAt: editedAt,
});

let versionId: number | undefined;
if (decision.conflicted) {
  // Whichever side loses is preserved before anything is overwritten. Doing this
  // BEFORE the update is what makes the guarantee true if the update then fails.
  versionId = decision.winner === 'client'
    ? await demoteToVersion(id, existing.title, existing.content_json)
    : await demoteToVersion(id, String(b.title ?? existing.title), JSON.stringify(b.contentJson ?? JSON.parse(existing.content_json)));
}

if (decision.winner === 'server') {
  // The client's edit lost. Hand back the server's record so the client can
  // apply it and stop retrying; its own copy is safe in history.
  res.json({ note: await readNote(id, uid), conflicted: true, versionId });
  return;
}
```

Then let the existing update path run, and include `conflicted: decision.conflicted, versionId` in its response.

Update the cause comment in `server/src/schema.sql:103` to read:
```sql
  cause TEXT NOT NULL DEFAULT 'autosave', -- autosave | manual | ai | restore | import | conflict
```

- [ ] **Step 7: Add the round-trip conflict test**

Append to `server/test/conflict.test.ts`:

```ts
describe('PATCH /api/notes/:id with a stale base', () => {
  it('keeps the newer edit and files the loser in history', async () => {
    const agent = await signUpAndLogin();
    const nb = await agent.post('/api/notebooks').send({ name: 'C' });
    const created = await agent.post('/api/notes').send({ notebookId: nb.body.notebook.id, title: 'Start' });
    const id = created.body.note.id;
    const base = created.body.note.updatedAt;

    // Another device edits first.
    await agent.patch(`/api/notes/${id}`).send({ title: 'From the browser' });

    // Our offline edit arrives with the now-stale base, claiming a LATER time.
    const later = new Date(Date.now() + 60_000).toISOString();
    const res = await agent.patch(`/api/notes/${id}`)
      .send({ title: 'From offline', baseUpdatedAt: base, clientUpdatedAt: later });

    expect(res.status).toBe(200);
    expect(res.body.conflicted).toBe(true);
    expect(res.body.note.title).toBe('From offline');

    const history = await agent.get(`/api/notes/${id}/versions`);
    const causes = history.body.versions.map((v: { cause: string }) => v.cause);
    expect(causes).toContain('conflict');
  });

  it('an unqualified PATCH is unaffected - the website\'s own path', async () => {
    const agent = await signUpAndLogin();
    const nb = await agent.post('/api/notebooks').send({ name: 'C2' });
    const created = await agent.post('/api/notes').send({ notebookId: nb.body.notebook.id });
    const res = await agent.patch(`/api/notes/${created.body.note.id}`).send({ title: 'Plain' });
    expect(res.status).toBe(200);
    expect(res.body.conflicted).toBeFalsy();
  });
});
```

- [ ] **Step 8: Run the tests, then the whole suite**

Run: `npx vitest run test/conflict.test.ts --root server`
Expected: PASS, 11 tests.

Run: `npm run test -w server`
Expected: all pass. The unqualified-PATCH test above is the regression guard for every existing caller.

- [ ] **Step 9: Commit**

```bash
git add server/src/lib/conflict.ts server/src/routes/notes.ts server/src/schema.sql server/test/conflict.test.ts
git commit -m "feat(sync): server-authoritative conflict resolution

The server decides every conflict, and the client only applies what it is given.
A client that resolved conflicts itself would need this rule in two places, and
two copies of a merge rule drift - at which point two devices disagree about
which edit won and both are certain.

Newest wins; a tie goes to the server, whose copy other clients have already
pulled. The losing note body is written to note_versions with cause 'conflict'
BEFORE anything is overwritten, so the guarantee holds even if the update fails.

Clock skew is contained by clamping the client's claimed edit time to between
the row's created_at and the server's now. Clamped, not rejected: rejecting
strands the edit in the outbox over a wrong system clock the user may not be
able to change.

Absent baseUpdatedAt means no check, so every existing caller is unaffected."
```

---

## Task 9: The Dexie local store

**Files:**
- Create: `web/src/lib/local/db.ts`, `web/src/lib/local/records.ts`
- Test: `web/src/lib/local/db.test.ts`

**Interfaces:**
- Consumes: `SyncEntity`, `SyncedRecord` from `../sync/contract`
- Produces: `localDb` (Dexie instance), `LocalNote`, `LocalNotebook`, `LocalFlashcard`, `OutboxEntry`, `SyncMetaRow`, `newLocalId(): string`

- [ ] **Step 1: Install Dexie and a fake IndexedDB for tests**

```bash
npm install dexie@^4.0.11 -w web
npm install -D fake-indexeddb@^6.0.0 vitest@^2.1.8 -w web
```

- [ ] **Step 2: Write the corrected clock**

Create `web/src/lib/local/clock.ts`. It lives here rather than in the sync engine so `localApi` can stamp edits without importing the engine (which imports `localApi` — a cycle).

```ts
// The client's clock, corrected toward the server's.
//
// An offline edit carries only this machine's claim about when it happened. A
// laptop an hour fast would win every conflict and one an hour slow would lose
// every one, so every timestamp that will ever be compared against a server value
// goes through here.
//
// The offset is refreshed from every sync response (engine.ts) and cached in
// memory because this is called on every keystroke batch.
let offsetMs = 0;

/** Set from a sync response: Date.now() - Date.parse(serverNow). */
export function setClockOffset(ms: number): void {
  offsetMs = Number.isFinite(ms) ? ms : 0;
}

export function getClockOffset(): number {
  return offsetMs;
}

/** Now, in the server's frame of reference. */
export function correctedNow(): string {
  return new Date(Date.now() - offsetMs).toISOString();
}
```

- [ ] **Step 3: Write the record types**

Create `web/src/lib/local/records.ts`:

```ts
// Local record shapes.
//
// Every mirrored record carries `baseUpdatedAt`: the server updated_at this client
// last saw for it. It is the entire basis of conflict detection, and it must be
// written ONLY when applying a server record - never by a local edit, or the
// client would claim to have seen a version it invented.
//
// OutboxOp is imported rather than redeclared: two definitions of the same union
// in two modules is how one of them silently gains a member the other rejects.
import type { SyncEntity, OutboxOp } from '../sync/contract';

export type { OutboxOp };

export interface LocalBase {
  id: string;
  updatedAt: string;
  deletedAt: string | null;
  /** Server's updated_at as last observed. Null for a record never pushed. */
  baseUpdatedAt: string | null;
}

export interface LocalNotebook extends LocalBase {
  name: string;
  emoji: string;
  color: string;
  position: number;
  archived: number;
  createdAt: string;
}

export interface LocalNote extends LocalBase {
  notebookId: string;
  title: string;
  contentJson: string;
  contentText: string;
  kind: string;
  pinned: number;
  archived: number;
  createdAt: string;
  tags: string[];
}

/** Column names match the server's `flashcards` table: question/answer, not front/back. */
export interface LocalFlashcard extends LocalBase {
  noteId: string | null;
  question: string;
  answer: string;
  dueAt: string;
  intervalDays: number;
  ease: number;
  reps: number;
  lapses: number;
  suspended: number;
  createdAt: string;
}

/** Append-only, so it needs no base and never conflicts. */
export interface LocalReview {
  /** Client-side id. The server's review_log PK is a BIGINT identity it owns. */
  id: string;
  cardId: string;
  rating: 'again' | 'hard' | 'good' | 'easy';
  reviewedAt: string;
}

export interface OutboxEntry {
  /** Dexie auto-increment. Drain order within an entity is insertion order. */
  seq?: number;
  entity: SyncEntity;
  op: OutboxOp;
  recordId: string;
  /** The write body. Coalescing replaces this wholesale with the newest. */
  payload: Record<string, unknown>;
  baseUpdatedAt: string | null;
  clientUpdatedAt: string;
  attempts: number;
  lastError: string | null;
}

export interface SyncMetaRow {
  key: 'cursor' | 'clockOffsetMs' | 'lastSyncAt';
  value: string;
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Ids generated here must be indistinguishable from the server's newId(), because
 * the server accepts only that exact shape and silently re-mints anything else -
 * which would cost this record its inbound wikilinks.
 */
export function newLocalId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  let id = '';
  for (const b of bytes) id += ALPHABET[b % ALPHABET.length];
  return id;
}
```

- [ ] **Step 4: Write the failing store test**

Create `web/src/lib/local/db.test.ts`:

```ts
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { localDb } from './db';
import { newLocalId } from './records';

describe('local store', () => {
  beforeEach(async () => {
    await localDb.delete();
    await localDb.open();
  });

  it('generates ids the server will accept unchanged', () => {
    for (let i = 0; i < 50; i++) expect(newLocalId()).toMatch(/^[a-z0-9]{14}$/);
  });

  it('round-trips a note', async () => {
    const id = newLocalId();
    await localDb.notes.put({
      id, notebookId: 'nb', title: 'Hello', contentJson: '{}', contentText: 'Hello',
      kind: 'doc', pinned: 0, archived: 0, tags: [], createdAt: '2026-08-09T10:00:00.000Z',
      updatedAt: '2026-08-09T10:00:00.000Z', deletedAt: null, baseUpdatedAt: null,
    });
    expect((await localDb.notes.get(id))?.title).toBe('Hello');
  });

  it('indexes notes by notebook and excludes tombstones by hand', async () => {
    // Dexie cannot index "deletedAt IS NULL", so every read path has to filter it.
    // Asserting it here is what stops a deleted note reappearing in a list.
    const live = newLocalId();
    const dead = newLocalId();
    const common = {
      notebookId: 'nb', contentJson: '{}', contentText: '', kind: 'doc', pinned: 0,
      archived: 0, tags: [], createdAt: '2026-08-09T10:00:00.000Z',
      updatedAt: '2026-08-09T10:00:00.000Z', baseUpdatedAt: null,
    };
    await localDb.notes.bulkPut([
      { ...common, id: live, title: 'Live', deletedAt: null },
      { ...common, id: dead, title: 'Dead', deletedAt: '2026-08-09T11:00:00.000Z' },
    ]);
    const rows = await localDb.notes.where('notebookId').equals('nb').toArray();
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.deletedAt === null).map((r) => r.title)).toEqual(['Live']);
  });
});
```

- [ ] **Step 5: Run it and watch it fail**

Run: `npx vitest run src/lib/local/db.test.ts --root web`
Expected: FAIL — cannot resolve `./db`.

- [ ] **Step 6: Implement the Dexie schema**

Create `web/src/lib/local/db.ts`:

```ts
// The local mirror. Dexie over IndexedDB.
//
// IndexedDB rather than the localStorage guest mode used: the ~4MB origin quota
// could hold plain-text trial notes but not a real library, and IndexedDB has no
// synchronous-write cliff on a large put.
//
// Indexes are chosen for the reads the app actually performs. deletedAt is NOT
// indexable as a null check, so every list read filters tombstones in code - the
// db.test.ts case for that is a guard, not a formality.
import Dexie, { type EntityTable } from 'dexie';
import type {
  LocalFlashcard, LocalNote, LocalNotebook, LocalReview, OutboxEntry, SyncMetaRow,
} from './records';

export class LocalDb extends Dexie {
  notebooks!: EntityTable<LocalNotebook, 'id'>;
  notes!: EntityTable<LocalNote, 'id'>;
  flashcards!: EntityTable<LocalFlashcard, 'id'>;
  reviews!: EntityTable<LocalReview, 'id'>;
  outbox!: EntityTable<OutboxEntry, 'seq'>;
  meta!: EntityTable<SyncMetaRow, 'key'>;

  /**
   * `dbName` is parameterised for one reason: the convergence harness (Task 14)
   * runs two independent clients in one process, and fake-indexeddb is
   * process-global - two clients on one database name would silently be ONE
   * store, and every convergence assertion would pass for the wrong reason.
   */
  constructor(dbName = 'unote') {
    super(dbName);
    this.version(1).stores({
      notebooks: 'id, position, updatedAt',
      notes: 'id, notebookId, updatedAt, title, *tags',
      flashcards: 'id, noteId, dueAt, updatedAt',
      reviews: 'id, cardId, reviewedAt',
      // [entity+recordId] is the coalescing key: finding the pending entry for a
      // record must be one index hit, since it happens on every keystroke batch.
      outbox: '++seq, [entity+recordId], entity',
      meta: 'key',
    });
  }
}

export const localDb = new LocalDb();

/** Has this browser got a mirror yet? Decides first-sync vs delta on boot. */
export async function hasLocalData(): Promise<boolean> {
  return (await localDb.notes.count()) > 0 || (await localDb.notebooks.count()) > 0;
}

export async function readMeta(key: SyncMetaRow['key']): Promise<string | null> {
  return (await localDb.meta.get(key))?.value ?? null;
}

export async function writeMeta(key: SyncMetaRow['key'], value: string): Promise<void> {
  await localDb.meta.put({ key, value });
}
```

- [ ] **Step 7: Add a Vitest config for the web workspace if none exists**

Check for `web/vitest.config.ts`. If absent, create it:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
```

Add to `web/package.json` scripts: `"test": "vitest run"`.

- [ ] **Step 8: Run the tests**

Run: `npx vitest run src/lib/local/db.test.ts --root web`
Expected: PASS, 3 tests.

- [ ] **Step 9: Commit**

```bash
git add web/src/lib/local/db.ts web/src/lib/local/records.ts web/src/lib/local/db.test.ts web/vitest.config.ts web/package.json package-lock.json
git commit -m "feat(local): Dexie mirror of the synced tables

IndexedDB rather than the localStorage guest mode used: the ~4MB origin quota
holds trial notes, not a real library.

Every record carries baseUpdatedAt - the server updated_at last observed - which
is the whole basis of conflict detection. It is written only when applying a
server record, never by a local edit, or the client would claim to have seen a
version it invented.

Local ids match newId()'s exact shape, because the server silently re-mints
anything else and that would cost the record its inbound wikilinks."
```

---

## Task 10: The outbox

**Files:**
- Create: `web/src/lib/local/outbox.ts`
- Test: `web/src/lib/local/outbox.test.ts`

**Interfaces:**
- Consumes: `localDb` from `./db`, `OUTBOX_ORDER` from `../sync/contract`
- Produces: `enqueue(entry): Promise<void>`, `drainOrder(): Promise<OutboxEntry[]>`, `settle(seq): Promise<void>`, `fail(seq, error): Promise<void>`, `pendingCount(): Promise<number>`

- [ ] **Step 1: Write the failing tests**

Create `web/src/lib/local/outbox.test.ts`:

```ts
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { localDb } from './db';
import { enqueue, drainOrder, pendingCount } from './outbox';

const entry = (over: Partial<Parameters<typeof enqueue>[0]> = {}) => ({
  entity: 'note' as const,
  op: 'update' as const,
  recordId: 'n1',
  payload: { title: 'v1' },
  baseUpdatedAt: null,
  clientUpdatedAt: '2026-08-09T10:00:00.000Z',
  ...over,
});

describe('outbox', () => {
  beforeEach(async () => {
    await localDb.delete();
    await localDb.open();
  });

  it('coalesces repeated updates to one record into a single entry', async () => {
    // A two-hour offline editing session must not queue thousands of PATCHes.
    for (let i = 0; i < 500; i++) {
      await enqueue(entry({ payload: { title: `v${i}` } }));
    }
    expect(await pendingCount()).toBe(1);
    const [only] = await drainOrder();
    expect(only.payload).toEqual({ title: 'v499' });
  });

  it('keeps separate records separate', async () => {
    await enqueue(entry({ recordId: 'n1' }));
    await enqueue(entry({ recordId: 'n2' }));
    expect(await pendingCount()).toBe(2);
  });

  it('a delete supersedes pending updates for that record', async () => {
    await enqueue(entry({ op: 'update', payload: { title: 'edited' } }));
    await enqueue(entry({ op: 'delete', payload: {} }));
    const all = await drainOrder();
    expect(all).toHaveLength(1);
    expect(all[0].op).toBe('delete');
  });

  it('a delete of a record created offline cancels both - it never existed server-side', async () => {
    await enqueue(entry({ op: 'create', payload: { title: 'ghost' } }));
    await enqueue(entry({ op: 'delete', payload: {} }));
    expect(await pendingCount()).toBe(0);
  });

  it('an update after a pending create stays a create, carrying the newest payload', async () => {
    // Pushing an update for a record the server has never seen would 404.
    await enqueue(entry({ op: 'create', payload: { title: 'first' } }));
    await enqueue(entry({ op: 'update', payload: { title: 'second' } }));
    const all = await drainOrder();
    expect(all).toHaveLength(1);
    expect(all[0].op).toBe('create');
    expect(all[0].payload).toEqual({ title: 'second' });
  });

  it('drains notebooks before the notes that reference them', async () => {
    // routes/notes.ts returns 400 for an unknown notebookId, so a note created
    // offline inside an offline notebook must be sent second.
    await enqueue(entry({ entity: 'note', op: 'create', recordId: 'n1' }));
    await enqueue(entry({ entity: 'notebook', op: 'create', recordId: 'nb1' }));
    expect((await drainOrder()).map((e) => e.entity)).toEqual(['notebook', 'note']);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/lib/local/outbox.test.ts --root web`
Expected: FAIL — cannot resolve `./outbox`.

- [ ] **Step 3: Implement it**

Create `web/src/lib/local/outbox.ts`:

```ts
// The write queue for edits made offline.
//
// Two coalescing rules carry real weight, and both exist because the naive queue
// breaks in production rather than in theory:
//
//   * Repeated updates to one record collapse. Without this a long offline
//     session queues one PATCH per debounce tick and the reconnect storms the
//     server with thousands of writes that all lose to the last one anyway.
//   * A delete supersedes pending updates, and CANCELS a pending create outright.
//     Pushing a create the user has since deleted resurrects it; pushing an
//     update for a record the server never saw 404s and wedges the queue.
import { localDb } from './db';
import type { OutboxEntry } from './records';
import { OUTBOX_ORDER } from '../sync/contract';

export type NewEntry = Omit<OutboxEntry, 'seq' | 'attempts' | 'lastError'>;

export async function enqueue(next: NewEntry): Promise<void> {
  await localDb.transaction('rw', localDb.outbox, async () => {
    const existing = await localDb.outbox
      .where('[entity+recordId]')
      .equals([next.entity, next.recordId])
      .first();

    if (!existing) {
      await localDb.outbox.add({ ...next, attempts: 0, lastError: null });
      return;
    }

    if (next.op === 'delete') {
      // Never created server-side, so there is nothing to delete there either.
      if (existing.op === 'create') {
        await localDb.outbox.delete(existing.seq!);
        return;
      }
      await localDb.outbox.update(existing.seq!, {
        op: 'delete',
        payload: next.payload,
        clientUpdatedAt: next.clientUpdatedAt,
        attempts: 0,
        lastError: null,
      });
      return;
    }

    // A create still pending stays a create - the server has never seen this row.
    // Only the payload advances.
    await localDb.outbox.update(existing.seq!, {
      op: existing.op === 'create' ? 'create' : next.op,
      payload: next.payload,
      clientUpdatedAt: next.clientUpdatedAt,
      // baseUpdatedAt must NOT advance here. It records what the server last
      // showed us, and a local edit has not changed that.
      attempts: 0,
      lastError: null,
    });
  });
}

/**
 * Everything pending, in the order it is safe to push: entity by entity per
 * OUTBOX_ORDER, and insertion order within each entity.
 */
export async function drainOrder(): Promise<OutboxEntry[]> {
  const all = await localDb.outbox.toArray();
  const rank = new Map(OUTBOX_ORDER.map((e, i) => [e, i]));
  return all.sort((a, b) => {
    const ra = rank.get(a.entity) ?? 99;
    const rb = rank.get(b.entity) ?? 99;
    return ra !== rb ? ra - rb : (a.seq ?? 0) - (b.seq ?? 0);
  });
}

/** A push landed. */
export async function settle(seq: number): Promise<void> {
  await localDb.outbox.delete(seq);
}

/**
 * A push failed. The entry stays queued; `attempts` drives the caller's backoff.
 * Nothing is ever dropped for failing - a dropped entry is a lost edit.
 */
export async function fail(seq: number, error: string): Promise<void> {
  const row = await localDb.outbox.get(seq);
  if (!row) return;
  await localDb.outbox.update(seq, { attempts: row.attempts + 1, lastError: error });
}

export async function pendingCount(): Promise<number> {
  return localDb.outbox.count();
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/local/outbox.test.ts --root web`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/local/outbox.ts web/src/lib/local/outbox.test.ts
git commit -m "feat(local): outbox with coalescing and dependency ordering

Both coalescing rules exist because the naive queue breaks in production, not in
theory. Repeated updates to one record collapse, or a long offline session
queues one PATCH per debounce tick and reconnect storms the server with writes
that all lose to the last one anyway. A delete supersedes pending updates and
cancels a pending create outright: pushing a create the user has since deleted
resurrects it, and pushing an update for a row the server never saw 404s and
wedges the queue.

Drain order follows OUTBOX_ORDER because the server validates references -
routes/notes.ts 400s on an unknown notebookId, so an offline note inside an
offline notebook must go second.

A failed entry is never dropped. A dropped entry is a lost edit."
```

---

## Task 11: localApi — guest mode promoted onto Dexie

**Files:**
- Create: `web/src/lib/local/localApi.ts`
- Modify: `web/src/features/guest/guestApi.ts` (re-export shim), `web/src/features/guest/guestStore.ts` (delegate reads to Dexie)
- Test: `web/src/lib/local/localApi.test.ts`

**Interfaces:**
- Consumes: `localDb`, `enqueue`, `newLocalId`
- Produces: `localApi` — an object whose method names and return shapes match the corresponding members of `Api` in `web/src/lib/api.ts` exactly

- [ ] **Step 1: Read the existing surface before writing anything**

Run: `grep -n "^  [a-zA-Z]*:" web/src/features/guest/guestApi.ts`

Two different jobs hide in this task, and conflating them is the trap:

**Ported.** Notebooks, notes, tags and naive search already exist in `guestApi.ts`. These move from the localStorage blob to Dexie and gain outbox writes. Return shapes must not change.

**New.** Flashcards are **not** a port — `guestApi.ts` *blocks* them (`createCard`, `updateCard`, `deleteCard`, `review` all raise `GuestFeatureError`), because a localStorage trial had nowhere durable to keep an SM-2 schedule. The spec puts them in Stage 1, so they are written fresh here:

| Method | Signature (must match `lib/api.ts` exactly) |
| --- | --- |
| `createCard` | `(b: { noteId?: string; question: string; answer: string }) => Promise<{ card: Flashcard }>` |
| `updateCard` | `(id: string, b: Partial<{ question: string; answer: string; suspended: boolean }>) => Promise<{ card: Flashcard }>` |
| `deleteCard` | `(id: string) => Promise<{ ok: true }>` |
| `studyCards` | `() => Promise<{ cards: Flashcard[] }>` |
| `studyQueue` | `(...) => Promise<{ cards: Flashcard[]; due: number; total: number }>` |
| `review` | `(cardId: string, rating: 'again'\|'hard'\|'good'\|'easy') => Promise<{ card: Flashcard; nextDueAt: string }>` |
| `studyStats` | `() => Promise<StudyStats>` |

`review` runs the SM-2 step **locally** and writes both the updated card and an append-only `reviews` row. The review row is what makes this the cheapest offline surface in the whole project: `review_log` is append-only server-side, so two devices reviewing the same card produce two log rows that both survive — there is no conflict to resolve, only the card's derived schedule to last-write-wins.

Read the server's SM-2 implementation in `server/src/routes/study.ts` and reproduce its arithmetic exactly. A local schedule that drifts from the server's would change a card's due date every time the user switched device.

**Still refused.** Ink, canvas, comments, versions/snapshot/restore, templates, shares, imports and AI keep raising `GuestFeatureError` with their existing messages. Ink and canvas are Stage 2; the rest are permanently server-side.

- [ ] **Step 2: Write the failing test**

Create `web/src/lib/local/localApi.test.ts`:

```ts
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { localDb } from './db';
import { localApi } from './localApi';
import { pendingCount, drainOrder } from './outbox';

describe('localApi', () => {
  beforeEach(async () => {
    await localDb.delete();
    await localDb.open();
  });

  it('creates a notebook and lists it', async () => {
    const { notebook } = await localApi.createNotebook({ name: 'Physics' });
    expect(notebook.id).toMatch(/^[a-z0-9]{14}$/);
    const { notebooks } = await localApi.notebooks();
    expect(notebooks.map((n) => n.name)).toEqual(['Physics']);
  });

  it('every mutation queues exactly one outbox entry', async () => {
    const { notebook } = await localApi.createNotebook({ name: 'N' });
    const { note } = await localApi.createNote({ notebookId: notebook.id, title: 'T' });
    await localApi.updateNote(note.id, { title: 'T2', contentJson: {}, contentText: 'T2' });
    // notebook create + note create (the update coalesced into the create)
    expect(await pendingCount()).toBe(2);
    expect((await drainOrder()).map((e) => `${e.entity}:${e.op}`)).toEqual(['notebook:create', 'note:create']);
  });

  it('a deleted note disappears from lists but keeps a tombstone', async () => {
    const { notebook } = await localApi.createNotebook({ name: 'N' });
    const { note } = await localApi.createNote({ notebookId: notebook.id, title: 'Bye' });
    await localApi.deleteNote(note.id);
    const { notes } = await localApi.notes({ notebookId: notebook.id });
    expect(notes).toHaveLength(0);
    expect((await localDb.notes.get(note.id))?.deletedAt).not.toBeNull();
  });

  it('search matches title and body without the server', async () => {
    const { notebook } = await localApi.createNotebook({ name: 'N' });
    await localApi.createNote({ notebookId: notebook.id, title: 'Thermodynamics', contentText: 'entropy' });
    await localApi.createNote({ notebookId: notebook.id, title: 'Optics', contentText: 'lenses' });
    expect((await localApi.search('entropy')).results).toHaveLength(1);
    expect((await localApi.search('optics')).results).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run and watch it fail**

Run: `npx vitest run src/lib/local/localApi.test.ts --root web`
Expected: FAIL — cannot resolve `./localApi`.

- [ ] **Step 4: Implement localApi**

Port each method from `guestApi.ts` onto `localDb`. Rules for every method:

- Reads filter `deletedAt === null` in code (Dexie cannot index a null check).
- Every mutation writes the local record **and** calls `enqueue(...)` in the *same* Dexie transaction, so a crash between the two is impossible.
- `updatedAt` on a local edit comes from `correctedNow()` in `./clock` (Task 9).
- `baseUpdatedAt` is never touched by a local edit.
- Delete is a tombstone write (`deletedAt = now`), never a Dexie `.delete()`.

`updateNote` is the pattern every other mutation follows — write it first and copy its shape:

```ts
async updateNote(id: string, body: { title: string; contentJson: unknown; contentText: string; tags?: string[] }) {
  const now = correctedNow();
  const note = await localDb.transaction('rw', localDb.notes, localDb.outbox, async () => {
    const existing = await localDb.notes.get(id);
    if (!existing) throw new GuestFeatureError('That note is not on this device.');

    const updated: LocalNote = {
      ...existing,
      title: body.title,
      contentJson: JSON.stringify(body.contentJson),
      contentText: body.contentText,
      tags: body.tags ?? existing.tags,
      updatedAt: now,
      // baseUpdatedAt is deliberately NOT touched. It records what the SERVER
      // last showed us; a local edit has not changed that, and advancing it here
      // would make every subsequent push claim a version we never saw.
    };
    await localDb.notes.put(updated);

    // Same transaction as the put. A crash between the two would leave an edit
    // stored but unqueued - saved on this device and invisible to every other.
    await enqueue({
      entity: 'note',
      op: 'update',
      recordId: id,
      payload: { title: body.title, contentJson: body.contentJson, contentText: body.contentText, tags: updated.tags },
      baseUpdatedAt: existing.baseUpdatedAt,
      clientUpdatedAt: now,
    });
    return updated;
  });
  return { note: toApiNote(note) };
},
```

`toApiNote` maps a `LocalNote` to the `Note` shape `lib/types.ts` declares — parsing `contentJson` back to an object, since the API returns it parsed while the store keeps it as text.

Keep `guestApi.ts` as a two-line re-export so no page import changes:

```ts
export { localApi as guestApi } from '../../lib/local/localApi';
export { GuestFeatureError, guestBlockedMessage } from './guestErrors';
```

Move `GuestFeatureError` and `guestBlockedMessage` into a new `web/src/features/guest/guestErrors.ts` so the shim has something to re-export without a cycle.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/lib/local/localApi.test.ts --root web`
Expected: PASS, 4 tests.

- [ ] **Step 6: Verify guest mode still works end to end**

Run: `npm run build -w web`
Expected: exit 0.

Run: `npx tsc --noEmit -p web/tsconfig.json`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add web/src/lib/local/localApi.ts web/src/lib/local/localApi.test.ts web/src/features/guest/
git commit -m "feat(local): promote guestApi to localApi on the Dexie store

Guest mode stops being a separate system and becomes local-first with no account
attached - the same code path, sync disabled. guestApi.ts is now a re-export, so
no page import changed.

Every mutation writes the record and queues its outbox entry inside ONE Dexie
transaction, so there is no window in which an edit is stored but unqueued.

Deletes write a tombstone rather than removing the row: a client that deletes
locally still has to be able to tell the server, and a removed row has nothing
left to tell it with."
```

---

## Task 12: The three-state resolver

**Files:**
- Modify: `web/src/lib/api.ts`
- Create: `web/src/lib/sync/connectivity.ts`
- Test: `web/src/lib/api.test.ts`

**Interfaces:**
- Consumes: `localApi`, `isGuest()`
- Produces: `getMode(): 'guest' | 'online' | 'offline'`, `isOnline(): boolean`, `subscribeConnectivity(fn): () => void`

- [ ] **Step 1: Write connectivity**

Create `web/src/lib/sync/connectivity.ts`:

```ts
// Are we actually reachable?
//
// navigator.onLine is not the answer on its own: it reports link state, so a
// captive portal, a dead VPN tunnel or a sleeping laptop all read as "online".
// Real request outcomes are the ground truth, and navigator.onLine is used only
// as a fast negative - if the OS says there is no link, there is no link.
let reachable = true;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((l) => l());
}

export function isOnline(): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  return reachable;
}

/** Called by the API layer on every request outcome. */
export function noteRequestOutcome(ok: boolean): void {
  if (reachable === ok) return;
  reachable = ok;
  emit();
}

export function subscribeConnectivity(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    // The OS says the link is back. Assume reachable and let the next real
    // request correct us - optimism here is what triggers the reconnect sync.
    reachable = true;
    emit();
  });
  window.addEventListener('offline', emit);
}
```

- [ ] **Step 2: Write the resolver test**

Create `web/src/lib/api.test.ts`:

```ts
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getMode } from './api';
import { noteRequestOutcome } from './sync/connectivity';

vi.mock('../features/guest/guestMode', () => ({ isGuest: () => false }));

describe('the three-state resolver', () => {
  beforeEach(() => noteRequestOutcome(true));

  it('is online when requests are succeeding', () => {
    expect(getMode()).toBe('online');
  });

  it('is offline after a request fails at the transport level', () => {
    noteRequestOutcome(false);
    expect(getMode()).toBe('offline');
  });
});
```

- [ ] **Step 3: Modify the Proxy in `web/src/lib/api.ts`**

Replace the `isGuest()`-only branch with the three-state resolver. The `ALWAYS_SERVER` set and the refusal default both stay exactly as they are.

```ts
export type ApiMode = 'guest' | 'online' | 'offline';

export function getMode(): ApiMode {
  if (isGuest()) return 'guest';
  return isOnline() ? 'online' : 'offline';
}

/**
 * Reads come from the local mirror in every mode, so nothing the user looks at
 * ever waits on the network. Writes go local-first and then either straight to
 * the server or into the outbox.
 *
 * Online writes still go through the local store rather than the server alone. A
 * single path for both connection states is the point: an online write that
 * bypassed the mirror would leave it stale and reintroduce exactly the
 * two-sources-of-truth problem this design exists to remove.
 */
export const api: Api = new Proxy(serverApi, {
  get(target, prop, receiver) {
    const key = String(prop);
    if (ALWAYS_SERVER.has(key)) return Reflect.get(target, prop, receiver);

    const mode = getMode();
    const local = (localApi as Record<string, unknown>)[key];

    if (mode === 'guest' || mode === 'offline') {
      if (typeof local === 'function') return local;
      return () => Promise.reject(new GuestFeatureError(guestBlockedMessage(key)));
    }

    // Online. Local-first, then the server, then reconcile the returned record.
    if (typeof local === 'function') return writeThrough(key, local as ApiFn, Reflect.get(target, prop, receiver) as ApiFn);
    return Reflect.get(target, prop, receiver);
  },
}) as Api;
```

Implement `writeThrough` in the same file: call the local function, then the server function; on success apply the server record's `updatedAt` to the mirror as `baseUpdatedAt` and settle the outbox entry; on a transport failure call `noteRequestOutcome(false)` and leave the entry queued. Wrap `http()` so every response and every thrown `TypeError` reports through `noteRequestOutcome`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/api.test.ts --root web`
Expected: PASS, 2 tests.

- [ ] **Step 5: Typecheck and build**

Run: `npx tsc --noEmit -p web/tsconfig.json && npm run build -w web`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/api.ts web/src/lib/api.test.ts web/src/lib/sync/connectivity.ts
git commit -m "feat(sync): three-state resolver at the api seam

isGuest() was a boolean; it becomes guest | online | offline. Reads come from
the local mirror in every state, so nothing the user looks at waits on the
network - which is also why the desktop app will feel faster than the site even
when both are online.

Online writes still go local-first. One path for both connection states is the
point: an online write that bypassed the mirror would leave it stale and
reintroduce the two-sources-of-truth problem this design removes.

Reachability comes from real request outcomes, not navigator.onLine alone - a
captive portal, a dead VPN tunnel and a sleeping laptop all report online.

No page component changed."
```

---

## Task 13: The sync engine

**Files:**
- Create: `web/src/lib/sync/engine.ts`
- Test: `web/src/lib/sync/engine.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 5, 9, 10, 12
- Produces: `syncNow(): Promise<SyncOutcome>`, `startSync(): () => void`, `correctedNow(): string`, `type SyncOutcome = { pulled: number; pushed: number; conflicts: number; error?: string }`

- [ ] **Step 1: Write the failing tests**

Create `web/src/lib/sync/engine.test.ts` covering, with a stubbed `fetch`:

```ts
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { localDb } from '../local/db';
import { syncNow, correctedNow } from './engine';
import { writeMeta } from '../local/db';

function pageOnce(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  });
}

describe('sync engine', () => {
  beforeEach(async () => {
    await localDb.delete();
    await localDb.open();
  });

  it('applies a pulled note and records its baseUpdatedAt', async () => {
    globalThis.fetch = pageOnce({
      cursor: null, hasMore: false, serverNow: '2026-08-09T12:00:00.000Z',
      changes: { note: [{
        id: 'aaaaaaaaaaaaaa', updatedAt: '2026-08-09T11:00:00.000Z', deletedAt: null,
        notebookId: 'nb', title: 'Pulled', contentJson: '{}', contentText: '', kind: 'doc',
        pinned: 0, archived: 0, createdAt: '2026-08-09T10:00:00.000Z',
      }] },
    }) as never;

    const out = await syncNow();
    expect(out.pulled).toBe(1);
    const row = await localDb.notes.get('aaaaaaaaaaaaaa');
    expect(row?.title).toBe('Pulled');
    // The base must equal what the server showed, or the next push claims a
    // version this client never saw and every write reads as a conflict.
    expect(row?.baseUpdatedAt).toBe('2026-08-09T11:00:00.000Z');
  });

  it('a tombstone in the feed removes the record from lists', async () => {
    await localDb.notes.put({
      id: 'bbbbbbbbbbbbbb', notebookId: 'nb', title: 'Doomed', contentJson: '{}', contentText: '',
      kind: 'doc', pinned: 0, archived: 0, tags: [], createdAt: '2026-08-09T10:00:00.000Z',
      updatedAt: '2026-08-09T10:00:00.000Z', deletedAt: null, baseUpdatedAt: '2026-08-09T10:00:00.000Z',
    });
    globalThis.fetch = pageOnce({
      cursor: null, hasMore: false, serverNow: '2026-08-09T12:00:00.000Z',
      changes: { note: [{ id: 'bbbbbbbbbbbbbb', updatedAt: '2026-08-09T11:00:00.000Z', deletedAt: '2026-08-09T11:00:00.000Z' }] },
    }) as never;

    await syncNow();
    expect((await localDb.notes.get('bbbbbbbbbbbbbb'))?.deletedAt).toBe('2026-08-09T11:00:00.000Z');
  });

  it('does not apply a server record older than the local copy', async () => {
    await localDb.notes.put({
      id: 'cccccccccccccc', notebookId: 'nb', title: 'Local newer', contentJson: '{}', contentText: '',
      kind: 'doc', pinned: 0, archived: 0, tags: [], createdAt: '2026-08-09T10:00:00.000Z',
      updatedAt: '2026-08-09T11:30:00.000Z', deletedAt: null, baseUpdatedAt: '2026-08-09T10:00:00.000Z',
    });
    globalThis.fetch = pageOnce({
      cursor: null, hasMore: false, serverNow: '2026-08-09T12:00:00.000Z',
      changes: { note: [{ id: 'cccccccccccccc', updatedAt: '2026-08-09T11:00:00.000Z', deletedAt: null, title: 'Server older' }] },
    }) as never;

    await syncNow();
    expect((await localDb.notes.get('cccccccccccccc'))?.title).toBe('Local newer');
  });

  it('corrects its clock from the server', async () => {
    await writeMeta('clockOffsetMs', '3600000'); // this machine is an hour fast
    const corrected = correctedNow();
    expect(new Date(corrected).getTime()).toBeLessThan(Date.now());
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/lib/sync/engine.test.ts --root web`
Expected: FAIL — cannot resolve `./engine`.

- [ ] **Step 3: Implement the engine**

Create `web/src/lib/sync/engine.ts` implementing:

1. **`correctedNow()`** — `new Date(Date.now() - offsetMs).toISOString()`, offset read from `syncMeta.clockOffsetMs` (cached in a module variable, refreshed on every pull).
2. **`pull()`** — loop `GET /api/sync/changes?since=<cursor>&limit=500` while `hasMore`; per page, in ONE Dexie transaction: apply each record where `serverRecord.updatedAt > local.updatedAt` (or the local row is absent), set `baseUpdatedAt` from the server value, write the new cursor, and update `clockOffsetMs` from `Date.now() - Date.parse(serverNow)`. Committing records and cursor together is what makes an interrupted first sync resumable instead of restartable.
3. **`push()`** — `drainOrder()`, then per entry call the corresponding `serverApi` method with `baseUpdatedAt` and `clientUpdatedAt`; on success `settle(seq)` and apply the returned record; on `409` from a create, treat as success (the push already landed); on a 4xx other than 409, `fail()` and stop that entity; on transport failure `noteRequestOutcome(false)` and abort the whole push.
4. **`syncNow()`** — `push()` then `pull()`, in that order. Pushing first means our own writes are already on the server before we ask what changed, so we never pull a stale copy over an edit we are about to send.
5. **`startSync()`** — run on boot, on `subscribeConnectivity` transitions to online, and every 60s while online. Returns an unsubscribe.

Then remove the `// TODO(task-13)` marker from `localApi.ts` and use `correctedNow()`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/sync/engine.test.ts --root web`
Expected: PASS, 4 tests.

- [ ] **Step 5: Start it from the app entry**

In `web/src/main.tsx`, call `startSync()` after `registerServiceWorker()`.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/sync/engine.ts web/src/lib/sync/engine.test.ts web/src/lib/local/localApi.ts web/src/main.tsx
git commit -m "feat(sync): pull/push engine with a resumable cursor

Push runs before pull. Our own writes reach the server before we ask what
changed, so a stale server copy is never pulled over an edit we were about to
send.

Each pulled page commits its records AND its cursor in one Dexie transaction,
which is what makes an interrupted first sync resume instead of restart.

A 409 on a create is treated as success: it means the push already landed and
this client never saw the response. Retrying it forever would wedge the queue.

Clock offset is refreshed from every pull, so an offline edit's timestamp is
already in server time before it is sent."
```

---

## Task 14: Two-client convergence harness

**Files:**
- Create: `web/src/lib/sync/convergence.test.ts`

**Interfaces:**
- Consumes: the whole stack
- Produces: nothing; this task's deliverable is the tests

- [ ] **Step 1: Write the harness**

Create `web/src/lib/sync/convergence.test.ts`. It builds a fake server holding records in a Map, and two independent local stores, then drives divergence and asserts convergence.

```ts
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import type { SyncEntity } from './contract';

/**
 * A fake server: just enough of /api/sync/changes and the write routes to make two
 * clients disagree and then agree.
 *
 * It applies the SAME resolution rule as server/src/lib/conflict.ts - newest wins,
 * a tie goes to the server - so the two implementations drifting apart surfaces
 * here as a failing test rather than as a support ticket.
 */
interface ServerRow {
  entity: SyncEntity;
  id: string;
  updatedAt: string;
  deletedAt: string | null;
  data: Record<string, unknown>;
}

export class FakeServer {
  rows = new Map<string, ServerRow>();
  /** Every conflict-demoted copy, standing in for note_versions. */
  history: Array<{ id: string; data: Record<string, unknown>; cause: 'conflict' }> = [];
  private tick = 0;

  /** Monotonic server clock. Deterministic, so tests never race. */
  now(): string {
    this.tick += 1000;
    return new Date(Date.UTC(2026, 7, 9, 12, 0, 0) + this.tick).toISOString();
  }

  private key(entity: SyncEntity, id: string): string {
    return `${entity}:${id}`;
  }

  changesSince(cursor: { updatedAt: string; id: string } | null, limit = 500) {
    const since = cursor ?? { updatedAt: '', id: '' };
    const ordered = [...this.rows.values()]
      .filter((r) => r.updatedAt > since.updatedAt || (r.updatedAt === since.updatedAt && r.id > since.id))
      .sort((a, b) => (a.updatedAt === b.updatedAt ? a.id.localeCompare(b.id) : a.updatedAt.localeCompare(b.updatedAt)));

    const page = ordered.slice(0, limit);
    const last = page.at(-1);
    const changes: Record<string, unknown[]> = {};
    for (const r of page) {
      (changes[r.entity] ??= []).push({ id: r.id, updatedAt: r.updatedAt, deletedAt: r.deletedAt, ...r.data });
    }
    return {
      cursor: last ? { updatedAt: last.updatedAt, id: last.id } : null,
      hasMore: ordered.length > limit,
      serverNow: this.now(),
      changes,
    };
  }

  write(args: {
    entity: SyncEntity;
    op: 'create' | 'update' | 'delete';
    id: string;
    data: Record<string, unknown>;
    baseUpdatedAt: string | null;
    clientUpdatedAt: string;
  }): { conflicted: boolean; row: ServerRow } {
    const k = this.key(args.entity, args.id);
    const existing = this.rows.get(k);
    const serverNow = this.now();

    // Same clamp as server/src/lib/conflict.ts.
    const createdAt = String(existing?.data.createdAt ?? args.data.createdAt ?? serverNow);
    let edited = args.clientUpdatedAt;
    if (edited > serverNow) edited = serverNow;
    if (edited < createdAt) edited = createdAt;

    if (!existing) {
      const row: ServerRow = {
        entity: args.entity, id: args.id, updatedAt: edited,
        deletedAt: args.op === 'delete' ? edited : null, data: args.data,
      };
      this.rows.set(k, row);
      return { conflicted: false, row };
    }

    const conflicted = args.baseUpdatedAt != null && args.baseUpdatedAt !== existing.updatedAt;
    const clientWins = !conflicted || edited > existing.updatedAt;

    if (conflicted) {
      this.history.push({
        id: args.id,
        data: clientWins ? existing.data : args.data,
        cause: 'conflict',
      });
    }

    if (!clientWins) return { conflicted: true, row: existing };

    const row: ServerRow = {
      ...existing,
      updatedAt: edited,
      deletedAt: args.op === 'delete' ? edited : existing.deletedAt,
      data: { ...existing.data, ...args.data },
    };
    this.rows.set(k, row);
    return { conflicted, row };
  }
}
```

Then a client factory, using the `dbName` parameter Task 9 put on `LocalDb`:

```ts
import { LocalDb } from '../local/db';

/**
 * A client is its own IndexedDB database plus its own cursor and clock offset.
 * The offset is the point of the `skewMs` argument: it lets a test put one client
 * an hour fast and another an hour slow and assert they still win and lose on the
 * merits rather than on whose clock is wrong.
 */
async function makeClient(name: string, server: FakeServer, skewMs = 0) {
  const db = new LocalDb(`unote-${name}`);
  await db.delete();
  await db.open();

  let cursor: { updatedAt: string; id: string } | null = null;
  let offsetMs = skewMs;

  const clientNow = () => new Date(Date.now() + skewMs - offsetMs).toISOString();

  return {
    name,
    db,
    /** Pull one full feed, applying newest-wins per record. */
    async pull() {
      for (;;) {
        const page = server.changesSince(cursor);
        offsetMs = Date.now() + skewMs - Date.parse(page.serverNow);
        for (const [entity, records] of Object.entries(page.changes)) {
          const table = entity === 'note' ? db.notes : entity === 'notebook' ? db.notebooks : db.flashcards;
          for (const rec of records as Array<Record<string, unknown>>) {
            const local = await table.get(rec.id as string);
            if (local && String(local.updatedAt) >= String(rec.updatedAt)) continue;
            await table.put({ ...(local ?? {}), ...rec, baseUpdatedAt: rec.updatedAt } as never);
          }
        }
        cursor = page.cursor;
        if (!page.hasMore) break;
      }
    },
    async push() {
      const { drainOrder, settle } = await import('../local/outbox');
      for (const entry of await drainOrder()) {
        const res = server.write({
          entity: entry.entity, op: entry.op, id: entry.recordId,
          data: entry.payload, baseUpdatedAt: entry.baseUpdatedAt,
          clientUpdatedAt: entry.clientUpdatedAt,
        });
        const table = entry.entity === 'note' ? db.notes : entry.entity === 'notebook' ? db.notebooks : db.flashcards;
        await table.put({ ...res.row.data, id: res.row.id, updatedAt: res.row.updatedAt,
          deletedAt: res.row.deletedAt, baseUpdatedAt: res.row.updatedAt } as never);
        await settle(entry.seq!);
      }
    },
    async sync() { await this.push(); await this.pull(); },
    clientNow,
  };
}
```

Cases each client pair must satisfy — every one of these is a real failure mode, not a formality:

- [ ] **Step 2: Both clients edit different notes offline; both land, neither is lost**
- [ ] **Step 3: Both clients edit the SAME note offline; the newer wins and the loser is in history**
- [ ] **Step 4: The resurrection case, per table.** Client A edits a record offline; client B deletes it; A reconnects. Assert the record stays deleted on A, B and the server. Run it for `notebook`, `note` and `flashcard`.
- [ ] **Step 5: A creates a notebook and a note inside it offline; both arrive and the note is in the right notebook** (proves dependency ordering)
- [ ] **Step 6: A client an hour fast and a client an hour slow both win and lose on the merits**
- [ ] **Step 7: An interrupted first sync resumes** — fail the second page, re-run, assert no duplicates and nothing missing
- [ ] **Step 8: Run it**

Run: `npx vitest run src/lib/sync/convergence.test.ts --root web`
Expected: PASS, all cases.

- [ ] **Step 9: Run every suite**

```bash
npm run test -w server
npx vitest run --root web
npm run build -w web
npx tsc --noEmit -p web/tsconfig.json
npx tsc --noEmit -p desktop/tsconfig.json
```
Expected: all exit 0.

- [ ] **Step 10: Commit**

```bash
git add web/src/lib/sync/convergence.test.ts
git commit -m "test(sync): two-client convergence harness

Drives two independent local stores against one fake server through scripted
divergence and asserts final state on both clients AND the server - content, not
call counts. A capture harness on this project once reported 78 screenshots, 0
failed, when all 78 were the login form; a green count is not evidence.

The fake server applies the same resolution rule as server/src/lib/conflict.ts,
so the two implementations drifting apart surfaces here as a failure.

The resurrection case gets a run per table: A edits offline, B deletes, A
reconnects, and the record must stay deleted. That is the exact bug the missing
tombstones would have caused."
```

---

## Task 15: Connection status in the UI

**Files:**
- Create: `web/src/components/ConnectionStatus.tsx`, `web/src/components/connection-status.css`
- Modify: the app shell that renders global chrome (find it: `grep -rln "GuestBanner" web/src`)

**Interfaces:**
- Consumes: `subscribeConnectivity`, `isOnline`, `pendingCount`
- Produces: `<ConnectionStatus />`

- [ ] **Step 1: Build the component**

Offline is a normal state here, not an error, so it reads as information rather than a warning. Three states:

- online, nothing pending → render nothing
- offline → "Offline — your notes are saved on this device" (+ pending count when > 0)
- online with pending > 0 → "Syncing N changes"

Copy rules: say what is true of the user's data, never "connection lost". Poll `pendingCount()` on connectivity change and on a 5s interval while pending > 0. Respect `prefers-reduced-motion`.

- [ ] **Step 2: Render it in the app shell beside the guest banner**

- [ ] **Step 3: Verify in a real browser**

```bash
npm run dev
```
Open the app, sign in, then in DevTools set Network to Offline. Expected: the indicator appears; typing in a note still saves; the note survives a reload while still offline. Set Network back to Online. Expected: the indicator reports syncing, then disappears, and the edit is on the server (check from another browser).

- [ ] **Step 4: Commit**

```bash
git add web/src/components/ConnectionStatus.tsx web/src/components/connection-status.css web/src/
git commit -m "feat(ui): connection and sync status

Offline is a normal state for this app, not an error, so it reads as
information: 'Offline - your notes are saved on this device' rather than
'connection lost'. The count of pending changes is the reassuring part, and the
indicator disappears entirely once nothing is waiting."
```

---

## Verification before calling this done

Run all of these and report the actual output, not a summary:

```bash
npm run test -w server
npx vitest run --root web
npm run e2e
node scripts/smoke-api.mjs
node scripts/smoke-sync.mjs
npm run build -w web
npx tsc --noEmit -p web/tsconfig.json
npx tsc --noEmit -p desktop/tsconfig.json
npm run desktop:compile
npx vitest run test/csp.test.ts --root server
```

The last one is not optional. It is the only thing standing between an accidental
`index.html` edit and a production CSP break whose only symptom is a wrong-theme
first paint.
