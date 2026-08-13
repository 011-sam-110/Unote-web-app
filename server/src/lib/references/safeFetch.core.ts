/**
 * Shared request/redirect machinery behind `safeFetch.ts`'s public entry point.
 *
 * This module is deliberately NOT the production interface. `safeFetch.ts` re-exports only
 * what production code should ever touch (`isBlockedAddress`, `safeFetch`, `SsrfBlocked`,
 * `userAgent`) - the address-guard predicate below (`isBlocked`) is a required parameter here,
 * not something `safeFetch.ts` exposes a way to override. `safeFetch.testing.ts` (imported by
 * tests only) is the one place allowed to supply anything other than the real guard. See the
 * file-level comment in `safeFetch.ts` for the full SSRF threat model every guard here defends
 * against - nothing here changes that model, this file only relocates the plumbing so the
 * guard-injection seam can't leak into `safeFetch.ts`'s exports.
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

export class SsrfBlocked extends Error {}

export const MAX_REDIRECTS = 5;
export const DEFAULT_TIMEOUT_MS = 8_000;
export const DEFAULT_MAX_BYTES = 512 * 1024;

export interface SafeResponse {
  ok: boolean;
  status: number;
  finalUrl: string;
  body: string;
  contentType: string;
}

/** Crossref's polite pool wants a contact address; without one, throttling is unpredictable. */
export function userAgent(): string {
  const contact = process.env.FOLIO_REFERENCES_CONTACT ?? '';
  return contact ? `Unote-Referencing/1.0 (mailto:${contact})` : 'Unote-Referencing/1.0';
}

/** Resolve a hostname and return the addresses, all of which must pass. */
async function resolvedAddresses(hostname: string): Promise<string[]> {
  if (net.isIP(hostname)) return [hostname];
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
}

function firstHeaderValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

interface HopResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * Perform exactly one HTTP(S) request to a pre-validated address, on a single deadline that
 * covers connect, headers and body together. `pinnedAddress` is what we connect to (the
 * checked IP literal - this is what closes DNS rebinding). `parsed` is the original request
 * URL: its hostname goes to TLS as `servername` (SNI + certificate identity) and to the
 * `Host` header (virtual hosting), never to the socket. Every failure - connect, timeout,
 * or a body read gone wrong - is normalized to `SsrfBlocked` here so nothing raw escapes.
 */
function requestOneHop(
  pinnedAddress: string,
  parsed: URL,
  timeoutMs: number,
  maxBytes: number,
): Promise<HopResult> {
  const isHttps = parsed.protocol === 'https:';
  const port = parsed.port ? Number(parsed.port) : (isHttps ? 443 : 80);
  const transport = isHttps ? https : http;

  const options: https.RequestOptions = {
    host: pinnedAddress, // connect here - the address we just validated
    port,
    path: parsed.pathname + parsed.search,
    method: 'GET',
    headers: { Host: parsed.host, 'User-Agent': userAgent(), Accept: 'text/html,application/xhtml+xml' },
    // Secure default, never disabled - the whole point of `servername` below is to make
    // real certificate verification actually pass, not to bypass it.
    rejectUnauthorized: true,
  };
  if (isHttps) {
    options.servername = parsed.hostname; // SNI + cert identity checked against the NAME
  }

  return new Promise<HopResult>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      fail(new SsrfBlocked('request timed out'));
    }, timeoutMs);

    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      reject(err instanceof SsrfBlocked ? err : new SsrfBlocked('request failed'));
    };
    const succeed = (value: HopResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const req = transport.request(options, (res) => {
      const chunks: Buffer[] = [];
      let total = 0;
      res.on('data', (chunk: Buffer) => {
        if (settled) return;
        total += chunk.length;
        if (total > maxBytes) {
          // Stop reading - what we already have is enough. Destroying the response is
          // what actually frees the socket instead of buffering an endless stream.
          succeed({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') });
          res.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        succeed({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') });
      });
      res.on('error', fail);
    });

    req.on('error', fail);
    req.end();
  });
}

/**
 * The redirect-following core behind `safeFetch`. `isBlocked` is a required parameter, not
 * defaulted, here: the "defaults to the real guard" ergonomics belong to the test-only
 * wrapper in `safeFetch.testing.ts`, not to this shared module, so this function carries no
 * opinion about what "safe" means and there is nothing a caller could forget to pass.
 */
export async function runGuardedFetch(
  url: string,
  opts: { maxBytes?: number; timeoutMs?: number },
  isBlocked: (ip: string) => boolean,
): Promise<SafeResponse> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      throw new SsrfBlocked('not a valid URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new SsrfBlocked(`scheme ${parsed.protocol} is not allowed`);
    }

    let addresses: string[];
    try {
      addresses = await resolvedAddresses(parsed.hostname);
    } catch {
      throw new SsrfBlocked('hostname does not resolve');
    }
    if (!addresses.length || addresses.some(isBlocked)) {
      throw new SsrfBlocked('resolves to a blocked address');
    }

    // Connect to the address we just checked, not to the name - otherwise DNS can change
    // its answer between the check and the request. `parsed` (the name) still goes to TLS
    // servername and the Host header, so certificates and virtual hosting both keep working.
    let res: HopResult;
    try {
      res = await requestOneHop(addresses[0], parsed, timeoutMs, maxBytes);
    } catch (err) {
      throw err instanceof SsrfBlocked ? err : new SsrfBlocked('request failed');
    }

    if (res.status >= 300 && res.status < 400) {
      const location = firstHeaderValue(res.headers.location);
      if (!location) throw new SsrfBlocked('redirect with no location');
      try {
        current = new URL(location, parsed).toString();
      } catch {
        throw new SsrfBlocked('redirect location is not a valid URL');
      }
      continue; // re-check the next hop from the top
    }

    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      finalUrl: parsed.toString(),
      body: res.body,
      contentType: firstHeaderValue(res.headers['content-type']) ?? '',
    };
  }
  throw new SsrfBlocked('too many redirects');
}
