/**
 * Fetching a URL the user typed is server-side request forgery unless it is deliberately
 * closed off.
 *
 * Every guard here exists because removing it opens a specific hole:
 *  - scheme allowlist: file:/gopher:/data: read local state or bypass the network entirely
 *  - resolve-then-check: checking the HOSTNAME lets `internal.example.com -> 10.0.0.5` through
 *  - re-check per redirect: hop one is public, hop two is 169.254.169.254
 *  - connect to the CHECKED address: otherwise DNS rebinding changes the answer between the
 *    check and the connection, which is the entire point of that attack
 *  - size and time caps: an endless stream is a denial of service against our own function
 *  - no body echo: the verdict text is what the attacker reads, so it must never carry the
 *    response
 *
 * On Vercel the function can reach the cloud metadata endpoint, so the link-local block is
 * not theoretical.
 */
import dns from 'node:dns/promises';
import net from 'node:net';

export class SsrfBlocked extends Error {}

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_BYTES = 512 * 1024;

function v4Blocked(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p;
  if (a === 0 || a === 127) return true;              // this-network, loopback
  if (a === 10) return true;                          // private
  if (a === 172 && b >= 16 && b <= 31) return true;   // private
  if (a === 192 && b === 168) return true;            // private
  if (a === 169 && b === 254) return true;            // link-local, incl. cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true;  // CGNAT
  if (a === 192 && b === 0) return true;              // IETF protocol assignments
  if (a >= 224) return true;                          // multicast + reserved + broadcast
  return false;
}

function v6Blocked(raw: string): boolean {
  const ip = raw.toLowerCase();
  if (ip === '::' || ip === '::1') return true;
  if (ip.startsWith('fe80')) return true;             // link-local
  if (/^f[cd]/.test(ip)) return true;                 // unique-local
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) return v4Blocked(mapped[1]);            // v4 smuggled through v6
  return false;
}

export function isBlockedAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return v4Blocked(ip);
  if (kind === 6) return v6Blocked(ip);
  return true; // not an IP at all - fail closed
}

export interface SafeResponse {
  ok: boolean;
  status: number;
  finalUrl: string;
  body: string;
  contentType: string;
}

/** Resolve a hostname and return the addresses, all of which must pass. */
async function resolvedAddresses(hostname: string): Promise<string[]> {
  if (net.isIP(hostname)) return [hostname];
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
}

export async function safeFetch(url: string, opts: { maxBytes?: number; timeoutMs?: number } = {}): Promise<SafeResponse> {
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
    if (!addresses.length || addresses.some(isBlockedAddress)) {
      throw new SsrfBlocked('resolves to a blocked address');
    }

    // Connect to the address we just checked, not to the name - otherwise DNS can change
    // its answer between the check and the request. Host header preserves virtual hosting.
    const pinned = new URL(parsed.toString());
    const literal = net.isIPv6(addresses[0]) ? `[${addresses[0]}]` : addresses[0];
    pinned.hostname = literal;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(pinned.toString(), {
        redirect: 'manual',
        signal: controller.signal,
        headers: { Host: parsed.host, 'User-Agent': userAgent(), Accept: 'text/html,application/xhtml+xml' },
      });
    } catch {
      clearTimeout(timer);
      throw new SsrfBlocked('request failed');
    }
    clearTimeout(timer);

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new SsrfBlocked('redirect with no location');
      current = new URL(location, parsed).toString();
      continue; // re-check the next hop from the top
    }

    const reader = res.body?.getReader();
    let body = '';
    if (reader) {
      const decoder = new TextDecoder('utf-8');
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) { await reader.cancel(); break; }
        body += decoder.decode(value, { stream: true });
      }
    }

    return {
      ok: res.ok,
      status: res.status,
      finalUrl: parsed.toString(),
      body,
      contentType: res.headers.get('content-type') ?? '',
    };
  }
  throw new SsrfBlocked('too many redirects');
}

/** Crossref's polite pool wants a contact address; without one, throttling is unpredictable. */
export function userAgent(): string {
  const contact = process.env.FOLIO_REFERENCES_CONTACT ?? '';
  return contact ? `Unote-Referencing/1.0 (mailto:${contact})` : 'Unote-Referencing/1.0';
}
