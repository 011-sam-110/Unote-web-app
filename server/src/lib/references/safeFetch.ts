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
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

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
 * @internal Exported only so tests can exercise the redirect/size-cap/timeout machinery
 * against a local plaintext server, which `isBlockedAddress` would otherwise refuse to
 * connect to (127.0.0.1 is loopback, by design). `isBlocked` defaults to the real guard -
 * a caller that passes nothing gets full protection. Production code must always go through
 * `safeFetch`, whose signature gives callers no way to weaken it.
 */
export async function safeFetchWithGuard(
  url: string,
  opts: { maxBytes?: number; timeoutMs?: number } = {},
  isBlocked: (ip: string) => boolean = isBlockedAddress,
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

export async function safeFetch(url: string, opts: { maxBytes?: number; timeoutMs?: number } = {}): Promise<SafeResponse> {
  return safeFetchWithGuard(url, opts);
}

/** Crossref's polite pool wants a contact address; without one, throttling is unpredictable. */
export function userAgent(): string {
  const contact = process.env.FOLIO_REFERENCES_CONTACT ?? '';
  return contact ? `Unote-Referencing/1.0 (mailto:${contact})` : 'Unote-Referencing/1.0';
}
