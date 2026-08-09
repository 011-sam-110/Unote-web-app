// Pins the same import-cycle load-order invariant as lib/api.loadOrder.test.ts (see that
// file for the full rationale): no module in the guestStore.ts <-> buildReadme.ts <->
// insertables.ts <-> imageUpload.ts <-> lib/api.ts <-> guestApi.ts cycle may evaluate a
// cross-module binding at module scope. The other three load-order files enter via
// lib/api.ts, guestApi.ts and buildReadme.ts; none of them enters via insertables.ts,
// which is the order every note page actually produces (main.tsx -> NotePage -> the
// editor -> insertables.ts, all before anything imports guestStore.ts or buildReadme.ts
// at all) and the module holding the only remaining module-scope cross-module reads left
// anywhere in the cycle: `INSERT_ITEMS`'s `chemInsertable`, `model3dInsertable` and
// `...sketchInsertables` entries are read straight into the array literal at
// module-evaluation time, not deferred behind a function call the way buildReadme.ts's own
// `genericBlock` now is. No lint rule covers this - `.oxlintrc.json` has no import-cycle
// rule.
//
// This file enters via insertables.ts. The first non-vitest import below MUST stay a
// dynamic import, or insertables.ts would not genuinely be first.
import { describe, expect, it } from 'vitest';

describe('import-cycle load order: entering via insertables.ts', () => {
  it('does not crash when insertables.ts is the first module of the cycle to load', async () => {
    const { INSERT_ITEMS } = await import('./insertables');
    const { buildReadme } = await import('../readme/buildReadme');
    expect(INSERT_ITEMS.length).toBeGreaterThan(0);
    expect(() => buildReadme({ guest: true })).not.toThrow();
  });
});
