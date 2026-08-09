// Client-supplied ids, for records created while offline.
//
// The rule is deliberately narrow: accept ONLY the exact shape newId() produces,
// and silently mint a replacement for anything else. Minting rather than
// rejecting means a client on a future version cannot wedge its own outbox on a
// 400 it does not understand - it just loses id stability for that one record,
// which costs an inbound wikilink, not the note.
import { newId } from '../db.js';

const SHAPE = /^[a-z0-9]{14}$/;

export function resolveId(supplied: unknown): string {
  return typeof supplied === 'string' && SHAPE.test(supplied) ? supplied : newId();
}
