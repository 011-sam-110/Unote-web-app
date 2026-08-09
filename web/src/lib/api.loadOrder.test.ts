// Pins an import-cycle load-order invariant.
//
// guestStore.ts -> buildReadme.ts -> guestApi.ts -> guestStore.ts is one cycle, and
// guestStore.ts -> buildReadme.ts -> insertables.ts -> imageUpload.ts -> lib/api.ts ->
// guestApi.ts -> guestStore.ts is a second, wider one that lib/api.ts sits in. The safety
// property both depend on: NO module in the cycle evaluates a cross-module binding at
// module scope. Whichever module the app happens to enter the cycle through finishes
// initialising FIRST, and that varies by page - a note page reaches the cycle through
// insertables.ts's imageUpload -> lib/api chain; guest seeding reaches it through
// guestStore.ts directly. A binding read at module scope is only actually initialised for
// SOME of those entry orders.
//
// buildReadme.ts used to violate this: it called `guestBlockedMessage('__unknown__')` at
// module scope to compute a comparison constant, which threw "Cannot access 'BLOCKED'
// before initialization" whenever anything other than guestStore.ts entered the cycle
// first (see the `genericBlock` comment in buildReadme.ts for the full mechanics). No
// existing suite caught it: every one of them happened to enter through guestStore.ts or
// through buildReadme.ts's own static imports, which are exactly the entry orders that
// don't crash.
//
// No lint rule covers this. `.oxlintrc.json` - the only linter configured for `web` - only
// enables the react/typescript/oxc plugins; there is no import-cycle rule at all. Even one
// (e.g. eslint-plugin-import's no-cycle) would flag the cycle's mere existence, which the
// task that introduced it explicitly chose to keep (extracting `BLOCKED` into a leaf module
// removes one edge; insertables.ts -> imageUpload.ts -> lib/api.ts closes the cycle
// independently, and lib/api.ts is a hub every editor module reaches). It would not tell
// you whether any particular module's top level is actually safe to run first.
//
// This file enters via lib/api.ts - one of the two entry points that used to crash before
// the fix (the other is guestApi.ts, covered by its own load-order file next to it). The
// first non-vitest import below MUST stay a dynamic import: a static one would make THIS
// FILE, not lib/api.ts, whichever the bundler decides to initialise first.
import { describe, expect, it } from 'vitest';

describe('import-cycle load order: entering via lib/api.ts', () => {
  it('does not crash when lib/api.ts is the first module of the cycle to load', async () => {
    await import('./api');
    const { buildReadme } = await import('../features/readme/buildReadme');
    const { INSERT_ITEMS } = await import('../features/editor/insertables');
    expect(() => buildReadme({ guest: true })).not.toThrow();
    expect(INSERT_ITEMS.length).toBeGreaterThan(0);
  });
});
