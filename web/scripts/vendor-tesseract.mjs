// Copy the tesseract.js runtime assets into public/ so they are served from OUR origin.
//
// This is not an optimisation, it is the difference between OCR working and not working.
// tesseract.js defaults every asset path to cdn.jsdelivr.net, and the worker loads them with
// `importScripts()`. The production CSP is `script-src 'self' 'wasm-unsafe-eval' 'sha256-...'`
// - jsdelivr appears only in `connect-src` - so those importScripts calls are blocked, the
// worker never boots, and every photo silently OCRs to an empty string. Serving the same
// files from /tesseract/ satisfies 'self' and needs no CSP change.
//
// Copied at build time rather than committed: ~7MB of binaries do not belong in git, and
// copying keeps the worker/core/data versions locked to whatever npm actually installed.
import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'tesseract');

/** Resolve a file inside an installed package, wherever npm workspaces hoisted it to. */
function inPackage(pkg, ...segments) {
  return join(dirname(require.resolve(`${pkg}/package.json`)), ...segments);
}

// Only the LSTM cores are ever requested: createWorker('eng') uses OEM.DEFAULT, which makes
// tesseract's getCore ask for `-lstm` variants. It picks the SIMD build when the device
// supports it and falls back to the plain one, so both have to be here.
const assets = [
  ['worker.min.js', inPackage('tesseract.js', 'dist', 'worker.min.js')],
  ['tesseract-core-simd-lstm.wasm.js', inPackage('tesseract.js-core', 'tesseract-core-simd-lstm.wasm.js')],
  ['tesseract-core-lstm.wasm.js', inPackage('tesseract.js-core', 'tesseract-core-lstm.wasm.js')],
  // 4.0.0_best_int is the integerised LSTM model - the one lstmOnly workers expect, and about
  // a third the size of the full 4.0.0 data.
  ['eng.traineddata.gz', inPackage('@tesseract.js-data/eng', '4.0.0_best_int', 'eng.traineddata.gz')],
];

mkdirSync(outDir, { recursive: true });

let copied = 0;
let bytes = 0;
for (const [name, src] of assets) {
  const dest = join(outDir, name);
  const srcStat = statSync(src); // throws loudly if a dependency moved - better than a silent no-OCR build
  bytes += srcStat.size;
  let destStat = null;
  try {
    destStat = statSync(dest);
  } catch {
    /* not copied yet */
  }
  if (destStat && destStat.size === srcStat.size && destStat.mtimeMs >= srcStat.mtimeMs) continue;
  copyFileSync(src, dest);
  copied++;
}

const mb = (bytes / 1024 / 1024).toFixed(1);
console.log(
  copied === 0
    ? `tesseract assets already current in public/tesseract (${mb}MB)`
    : `tesseract: copied ${copied}/${assets.length} asset(s) into public/tesseract (${mb}MB total)`,
);
