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
 *  - servername pinned to the ORIGINAL hostname, not the connected IP: TLS operates below
 *    HTTP - the handshake, SNI and certificate identity check all happen before any header
 *    is sent. Node omits SNI for IP literals and no real certificate matches a bare IP, so
 *    connecting-and-presenting-the-IP breaks HTTPS outright. Connecting to the checked
 *    address while presenting the checked hostname to TLS keeps both properties at once.
 *  - one deadline across connect, headers AND body: clearing the timer once headers arrive
 *    leaves body-streaming unbounded - a server that answers promptly then drips bytes
 *    forever hangs the function
 *  - size and time caps: an endless stream is a denial of service against our own function
 *  - no body echo: the verdict text is what the attacker reads, so it must never carry the
 *    response
 *
 * On Vercel the function can reach the cloud metadata endpoint, so the link-local block is
 * not theoretical.
 *
 * This module exports exactly four names - `isBlockedAddress`, `safeFetch`, `SsrfBlocked`,
 * `userAgent` - the whole production interface. The request/redirect machinery those rely on
 * lives in `./safeFetch.core.ts`, which also backs a guard-injection seam used only by tests
 * (`./safeFetch.testing.ts`); neither that seam nor the machinery's internals are reachable
 * from here, so there is nothing a resolver could import to weaken a guard.
 */
import net from 'node:net';
import { runGuardedFetch, SsrfBlocked, userAgent, type SafeResponse } from './safeFetch.core.js';

export { SsrfBlocked, userAgent };

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

/**
 * Expand a valid IPv6 literal (already confirmed by `net.isIP`) to its 8 zero-padded hex
 * groups, resolving `::` compression and a trailing dotted-decimal IPv4 tail. Returns null
 * only for shapes this function doesn't need to handle (`net.isIP` having already rejected
 * anything that isn't a real IPv6 literal) - callers treat null as "no hex-mapped v4 found",
 * never as "allowed".
 */
function expandIPv6Groups(raw: string): string[] | null {
  let ip = raw;
  const dotted = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(ip);
  if (dotted) {
    const octets = dotted[1].split('.').map(Number);
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    ip = ip.slice(0, dotted.index) + hi + ':' + lo;
  }

  const halves = ip.split('::');
  if (halves.length > 2) return null;

  let groups: string[];
  if (halves.length === 1) {
    groups = ip.split(':');
  } else {
    const head = halves[0] ? halves[0].split(':') : [];
    const tail = halves[1] ? halves[1].split(':') : [];
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill('0'), ...tail];
  }
  if (groups.length !== 8 || groups.some((g) => g.length === 0 || g.length > 4)) return null;
  return groups.map((g) => g.padStart(4, '0'));
}

function v6Blocked(raw: string): boolean {
  const ip = raw.toLowerCase();
  if (ip === '::' || ip === '::1') return true;
  if (ip.startsWith('fe80')) return true;             // link-local
  if (/^f[cd]/.test(ip)) return true;                 // unique-local
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) return v4Blocked(mapped[1]);            // v4 smuggled through v6, dotted form

  // Same smuggling, hex form: ::ffff:7f00:1 is 127.0.0.1, ::ffff:a9fe:a9fe is the cloud
  // metadata address. Decompose the last 32 bits and check them as IPv4.
  const groups = expandIPv6Groups(ip);
  if (groups) {
    const isV4Mapped = groups[0] === '0000' && groups[1] === '0000' && groups[2] === '0000' &&
      groups[3] === '0000' && groups[4] === '0000' && groups[5] === 'ffff';
    if (isV4Mapped) {
      const hi = parseInt(groups[6], 16);
      const lo = parseInt(groups[7], 16);
      const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      return v4Blocked(v4);
    }
  }
  return false;
}

export function isBlockedAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return v4Blocked(ip);
  if (kind === 6) return v6Blocked(ip);
  return true; // not an IP at all - fail closed
}

export async function safeFetch(url: string, opts: { maxBytes?: number; timeoutMs?: number } = {}): Promise<SafeResponse> {
  return runGuardedFetch(url, opts, isBlockedAddress);
}
