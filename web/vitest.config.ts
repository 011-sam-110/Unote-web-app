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
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // The *.loadOrder.test.ts files each dynamically import a whole module cycle - TipTap
    // extensions, the API client, the command registry - from a cold registry, and were
    // already logging 2.8-4.1s against the 5s default. That is not a slow test, it is what
    // the test measures; the margin was simply too thin, and adding two more test files to
    // the run was enough to start timing them out at random. A different subset failed on
    // every run and every one of them passed in isolation, which is the signature to
    // recognise: a flake that moves is a resource limit, not a bug. The server config makes
    // the same call for the same reason (scrypt + real Postgres round trips).
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
