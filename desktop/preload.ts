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
