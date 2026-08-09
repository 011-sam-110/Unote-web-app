// Is the local mirror trustworthy enough to answer reads?
//
// The question needs a SYNCHRONOUS answer: api.ts decides per call inside a Proxy
// `get`, which cannot await. So the flag lives here in memory, primed once on boot
// and updated by the sync engine, rather than being read from IndexedDB per call.
//
// The default is COLD, and that direction matters. On a fresh install an empty
// mirror and a genuinely empty account look identical, so serving the empty mirror
// would show a signed-in user zero notes and invite them to "start writing" over the
// top of a library that already exists. Cold means reads go to the server until the
// first full pull has finished, which is only ever a brief window.
//
// A separate module rather than a flag inside engine.ts, because api.ts would then
// import the engine and the engine already imports api.ts - a cycle.
let warm = false;

export function isMirrorWarmSync(): boolean {
  return warm;
}

/** Called by the engine once a full pull has completed, and by boot priming. */
export function setMirrorWarm(value: boolean): void {
  warm = value;
}
