import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // happy-dom rather than node: importing INSERT_ITEMS pulls in the sketch module,
    // which imports react-dom/client and a TipTap ReactNodeViewRenderer. Neither
    // touches the DOM at module scope today, but a plain node environment makes that
    // an accident away from a red suite, and this is a browser app.
    environment: 'happy-dom',
    // The default `isolate: true` (a fresh module registry per test file) is what makes
    // the *.loadOrder.test.ts files mean anything: each one relies on being the ONLY test
    // in its file that has ever imported the cycle, so its dynamic `await import()` is
    // genuinely the first load of every module in it. Set `isolate: false` for speed and
    // those files would share a module registry with whatever else already warmed the
    // cycle up first - they'd still pass, but only because the very ordering property they
    // exist to pin was disabled to get them there.
    // The offline tests bring their own IndexedDB - each imports 'fake-indexeddb/auto',
    // which assigns onto globalThis. happy-dom ships no indexedDB of its own, so the two
    // do not fight; if a future happy-dom adds one, these tests are where it will show.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
