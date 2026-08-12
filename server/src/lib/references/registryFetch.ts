/**
 * A thin wrapper over global `fetch`, for registry URLs a resolver constructs itself
 * (doi.org, OpenLibrary, Crossref, ...).
 *
 * This is deliberately NOT `safeFetch`. `safeFetch` guards URLs a USER supplied - it resolves
 * and pins addresses, blocks private/link-local ranges, and re-checks every redirect, because
 * the target could be anything, including our own cloud metadata endpoint. A registry URL is
 * one we built from a known host, so there is no SSRF surface to guard here. What a registry
 * lookup still needs, and what plain `fetch` doesn't give you, is a deadline: an endless or
 * half-open stream from a slow registry is a denial of service against our own serverless
 * function, same failure mode `safeFetch.core.ts` defends against for the user-URL path. Do
 * not merge these two modules, and do not reach for this one when the URL came from a user.
 *
 * The timeout is the default, not something a caller opts into - `timeoutMs` only overrides
 * it. Errors (abort, network failure, non-2xx status) are never swallowed here; a resolver
 * needs to tell a timeout/network failure apart from a 404, since those become different
 * verdicts shown to a student.
 */
import { userAgent } from './safeFetch.js';

const DEFAULT_TIMEOUT_MS = 8_000;

export interface RegistryFetchOptions {
  /** Sent as `Accept`. Omit to send no Accept header. */
  accept?: string;
  /** Deadline covering the whole request. Defaults to 8000ms. */
  timeoutMs?: number;
}

export async function registryFetch(url: string, opts: RegistryFetchOptions = {}): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers: Record<string, string> = { 'User-Agent': userAgent() };
  if (opts.accept) headers.Accept = opts.accept;

  try {
    return await fetch(url, { redirect: 'follow', headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
