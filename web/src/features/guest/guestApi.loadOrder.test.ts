// Pins the same import-cycle load-order invariant as lib/api.loadOrder.test.ts (see that
// file for the full rationale): no module in the guestStore.ts <-> buildReadme.ts <->
// guestApi.ts cycle may evaluate a cross-module binding at module scope, because a module
// only finishes initialising before it's asked for a binding when this module is the one
// through which the app entered the cycle - and guestApi.ts is a real production entry
// (lib/api.ts imports it directly, before it ever imports guestStore.ts). No lint rule
// covers this - `.oxlintrc.json` has no import-cycle rule, and even one would flag the
// cycle's existence rather than any particular module's safety as an entry point.
//
// This file enters via guestApi.ts. The first non-vitest import below MUST stay a dynamic
// import, or guestApi.ts would not genuinely be first.
import { describe, expect, it } from 'vitest';

describe('import-cycle load order: entering via guestApi.ts', () => {
  it('does not crash when guestApi.ts is the first module of the cycle to load', async () => {
    await import('./guestApi');
    const { buildReadme } = await import('../readme/buildReadme');
    const { INSERT_ITEMS } = await import('../editor/insertables');
    expect(() => buildReadme({ guest: true })).not.toThrow();
    expect(INSERT_ITEMS.length).toBeGreaterThan(0);
  });
});
