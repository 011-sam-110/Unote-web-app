// Pins the same import-cycle load-order invariant as lib/api.loadOrder.test.ts (see that
// file for the full rationale): no module in the guestStore.ts <-> buildReadme.ts <->
// guestApi.ts cycle may evaluate a cross-module binding at module scope. buildReadme.ts is
// the module that actually used to break this (the `genericBlock` comment in buildReadme.ts
// tells the story), and it is also the one entry order the OTHER existing suite
// (buildReadme.test.ts) already happens to exercise via its own static import - which is
// exactly why that suite never caught the bug the other two orders (lib/api.ts,
// guestApi.ts) would have. No lint rule covers this - `.oxlintrc.json` has no import-cycle
// rule.
//
// This file enters via buildReadme.ts through a DYNAMIC import rather than
// buildReadme.test.ts's static one, so it exercises the same "buildReadme.ts first" order
// without depending on that other file's import statement continuing to be the thing that
// produces it.
import { describe, expect, it } from 'vitest';

describe('import-cycle load order: entering via buildReadme.ts', () => {
  it('does not crash when buildReadme.ts is the first module of the cycle to load', async () => {
    const { buildReadme } = await import('./buildReadme');
    const { INSERT_ITEMS } = await import('../editor/insertables');
    expect(() => buildReadme({ guest: true })).not.toThrow();
    expect(INSERT_ITEMS.length).toBeGreaterThan(0);
  });
});
