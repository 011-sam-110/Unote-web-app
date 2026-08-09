// Are we actually reachable?
//
// `navigator.onLine` is not the answer on its own. It reports link state, so a
// captive portal, a dead VPN tunnel, a laptop that just woke, and a server that is
// simply down all read as "online". Treating it as truth is how an app ends up
// queueing writes it could have sent, or worse, sending writes it cannot.
//
// So real request outcomes are the ground truth here, and `navigator.onLine` is
// used only as a fast NEGATIVE: if the OS says there is no link, believe it, because
// there is no point attempting a request to find out.

let reachable = true;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Best current answer to "can we reach the server". */
export function isOnline(): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  return reachable;
}

/**
 * Report the outcome of a real request. Called by the API layer on every response
 * and every transport-level throw.
 *
 * Only a TRANSPORT failure counts as offline. An HTTP error response - a 400, a
 * 404, a 500 - proves the opposite: something answered. Conflating the two is how
 * a validation bug turns into a phantom offline state that queues every write.
 */
export function noteRequestOutcome(reachedServer: boolean): void {
  if (reachable === reachedServer) return;
  reachable = reachedServer;
  emit();
}

/** Subscribe to reachability changes. Returns an unsubscribe. */
export function subscribeConnectivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    // The OS says the link is back. Assume reachable and let the next real request
    // correct us if it is wrong. The optimism is deliberate: this is the event that
    // triggers the reconnect sync, and waiting for proof first would mean nothing
    // ever tries.
    reachable = true;
    emit();
  });

  window.addEventListener('offline', () => {
    reachable = false;
    emit();
  });
}
