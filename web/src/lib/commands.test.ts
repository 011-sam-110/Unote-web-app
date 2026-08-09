// GLOBAL_COMMANDS was the one `needs`-carrying registry with no guard.
//
// paletteCatalog, featureCatalog and shortcutData each assert their `needs` values name
// real BLOCKED keys; this file closes the last gap. It matters because the generated
// README derives every "needs an account" mark from those values, and guestBlockedMessage
// answers an unknown method with a generic sentence rather than failing - so a typo here
// would quietly present an account-only command to a guest as something they can use.
import { describe, expect, it } from 'vitest';
import { GLOBAL_COMMANDS } from './commands';
import { guestBlockedMessage } from '../features/guest/guestApi';

describe('GLOBAL_COMMANDS', () => {
  it('has no duplicate ids', () => {
    const ids = GLOBAL_COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(0);
  });

  it('gives every command a title and a section', () => {
    for (const c of GLOBAL_COMMANDS) {
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.section.length).toBeGreaterThan(0);
    }
  });

  it('names a real BLOCKED key wherever it claims a command needs an account', () => {
    const generic = guestBlockedMessage('__definitely_not_a_method__');
    for (const c of GLOBAL_COMMANDS) {
      if (!c.needs) continue;
      expect(guestBlockedMessage(c.needs), `${c.id} -> ${c.needs}`).not.toBe(generic);
    }
  });
});
