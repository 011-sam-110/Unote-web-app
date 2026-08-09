// Pins the same import-cycle load-order invariant as api.loadOrder.test.ts (see that file
// for the full rationale), extended by a new edge: lib/commands.ts now imports
// features/readme/ensureReadme.ts (for the "Open the guide" command), which imports
// features/readme/buildReadme.ts - and buildReadme.ts already imports GLOBAL_COMMANDS and
// SECTION_ORDER back from lib/commands.ts. That closes commands.ts -> ensureReadme.ts ->
// buildReadme.ts -> commands.ts on top of the existing guestStore.ts <-> buildReadme.ts <->
// guestApi.ts cycle (ensureReadme.ts also imports lib/api.ts, which is already in that
// cycle), so commands.ts is now reachable from every other entry order too. The same rule
// applies: no module in the cycle may evaluate a cross-module binding at module scope.
// commands.ts holds the line by calling `registerCommands(GLOBAL_COMMANDS)` at module scope
// with an array of plain command objects - the new "Open the guide" command's `run` is a
// function value, not a call, so importing commands.ts never touches ensureReadme's or
// buildReadme's internals until a user actually invokes the command. No lint rule covers
// this - `.oxlintrc.json` has no import-cycle rule.
//
// This file enters via lib/commands.ts, which is new with this task - nothing else exercises
// this entry order. The first non-vitest import below MUST stay a dynamic import, or
// commands.ts would not genuinely be first.
import { describe, expect, it } from 'vitest';

describe('import-cycle load order: entering via lib/commands.ts', () => {
  it('does not crash when lib/commands.ts is the first module of the cycle to load', async () => {
    await import('./commands');
    const { buildReadme } = await import('../features/readme/buildReadme');
    expect(() => buildReadme({ guest: true })).not.toThrow();
  });
});
