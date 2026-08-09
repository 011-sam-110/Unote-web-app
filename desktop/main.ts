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
// electron-updater is CommonJS, and this main process is ESM ("type": "module" at the
// repo root). A named import therefore throws at load:
//   SyntaxError: Named export 'autoUpdater' not found.
// The typecheck does NOT catch it - skipLibCheck plus esModuleInterop make the named
// form look fine - so the only thing that finds this is launching the app.
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;
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
    // No autoHideMenuBar here on purpose. Electron already hides the menu bar in
    // fullscreen, and setting autoHideMenuBar would also hide it in a normal
    // window - a behaviour change nobody asked for.
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
      // The 'error' handler above is NOT enough on its own: checkForUpdatesAndNotify
      // returns a promise that rejects separately, so `void` alone produced a real
      // UnhandledPromiseRejectionWarning in the packaged app the first time it ran -
      // the feed at /desktop/latest.yml does not exist yet, Vercel answered with HTML,
      // and the YAML parser threw.
      //
      // That matters beyond tidiness: an unhandled rejection in the main process is
      // exactly the kind of thing a future Electron version turns into a hard crash,
      // and it would crash on startup, before the window is usable.
      autoUpdater.checkForUpdatesAndNotify().catch(() => {
        // No update feed published yet, or unreachable. Neither is the user's problem.
      });
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
