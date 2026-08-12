/**
 * Test-only guard-injection seam for `safeFetch`'s request machinery.
 *
 * `safeFetch.ts` exports exactly `isBlockedAddress`, `safeFetch`, `SsrfBlocked`, `userAgent` -
 * the address-guard predicate is never configurable from there, so production code has no way
 * to import a permissive guard by accident. This file exists purely so tests can exercise the
 * shared redirect/timeout/size-cap machinery (`safeFetch.core.ts`) against a real local
 * plaintext server, which the real `isBlockedAddress` would otherwise correctly refuse to
 * connect to (127.0.0.1 is loopback, by design).
 *
 * Import this only from test files. It is not part of the production interface and ships
 * nothing that isn't already reachable through `safeFetch` with the real guard.
 */
import { runGuardedFetch, type SafeResponse } from './safeFetch.core.js';
import { isBlockedAddress } from './safeFetch.js';

/**
 * Same behavior as `safeFetch`, plus a third parameter tests can use to swap in a permissive
 * predicate. Defaults to the real guard - a caller (i.e. a test) that omits the third argument
 * gets exactly `safeFetch`'s protection, which is itself covered by the "defaults to the real
 * address guard" test below.
 */
export async function safeFetchWithGuard(
  url: string,
  opts: { maxBytes?: number; timeoutMs?: number } = {},
  isBlocked: (ip: string) => boolean = isBlockedAddress,
): Promise<SafeResponse> {
  return runGuardedFetch(url, opts, isBlocked);
}
