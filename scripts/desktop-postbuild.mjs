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

// main.js resolves the offline page relative to its OWN directory, but tsc only
// emits .ts files - so without this copy dist-desktop has no offline.html, and
// the loadFile for it fails. That failure re-enters the same did-fail-load
// handler, which calls loadFile again: an infinite reload loop, in exactly the
// first-launch-offline case the page exists to handle. Copying it here also means
// electron-builder ships it via the dist-desktop/**/* glob.
const html = path.resolve('desktop', 'offline.html');
if (!fs.existsSync(html)) {
  console.error(`desktop-postbuild: expected ${html} to exist.`);
  process.exit(1);
}
fs.copyFileSync(html, path.join(out, 'offline.html'));
console.log('desktop-postbuild: copied offline.html');
