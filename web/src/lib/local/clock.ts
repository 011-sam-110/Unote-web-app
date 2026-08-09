// The client's clock, corrected toward the server's.
//
// An offline edit carries only this machine's claim about when it happened. A
// laptop an hour fast would win every conflict and one an hour slow would lose
// every one, so every timestamp that will ever be compared against a server value
// goes through here.
//
// The offset is refreshed from every sync response (engine.ts) and cached in
// memory because this is called on every keystroke batch.
let offsetMs = 0;

/** Set from a sync response: Date.now() - Date.parse(serverNow). */
export function setClockOffset(ms: number): void {
  offsetMs = Number.isFinite(ms) ? ms : 0;
}

export function getClockOffset(): number {
  return offsetMs;
}

/** Now, in the server's frame of reference. */
export function correctedNow(): string {
  return new Date(Date.now() - offsetMs).toISOString();
}
