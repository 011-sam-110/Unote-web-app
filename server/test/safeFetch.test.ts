// server/test/safeFetch.test.ts
import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, vi } from 'vitest';
import { isBlockedAddress, safeFetch, SsrfBlocked } from '../src/lib/references/safeFetch.js';
import { safeFetchWithGuard } from '../src/lib/references/safeFetch.testing.js';

/**
 * `dns.lookup` is mocked for exactly one hostname (`safe-fetch-test.example`, used only by the
 * TLS-options test below) so that test can exercise a real public-address code path without a
 * real DNS round trip. Every other hostname - `localhost`, `127.0.0.1`, etc. - falls through to
 * the real resolver, unchanged from before this file started mocking anything.
 */
const MOCKED_HOSTNAME = 'safe-fetch-test.example';
const MOCKED_RESOLVED_IP = '93.184.216.34'; // public, non-blocked (also used in the allow-list test above)

vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>();
  return {
    ...actual,
    default: {
      ...actual.default,
      lookup: async (hostname: string, opts?: unknown) => {
        if (hostname === MOCKED_HOSTNAME) return [{ address: MOCKED_RESOLVED_IP, family: 4 }];
        return (actual.default.lookup as (h: string, o?: unknown) => Promise<unknown>)(hostname, opts);
      },
    },
  };
});

/**
 * `safeFetch` correctly refuses to connect to 127.0.0.1 - that's the whole point of it. To
 * exercise the request machinery itself (redirects, the size cap, the timeout, the happy
 * path) we need a real socket, so these tests talk to a real `node:http` server bound to
 * loopback through `safeFetchWithGuard` with a permissive predicate injected in its place.
 * No test here weakens or bypasses `isBlockedAddress` - the default guard used by production
 * callers is covered separately, in the `safeFetch` block above.
 */
function startServer(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

const allowAll = () => false; // permissive test-only predicate: nothing is blocked

describe('isBlockedAddress', () => {
  it('blocks loopback, private, link-local, CGNAT, multicast and reserved v4', () => {
    for (const ip of [
      '127.0.0.1', '127.9.9.9', '10.0.0.5', '172.16.0.1', '172.31.255.255',
      '192.168.1.1', '169.254.169.254', '100.64.0.1', '224.0.0.1', '0.0.0.0', '255.255.255.255',
    ]) {
      expect(isBlockedAddress(ip), `${ip} should be blocked`).toBe(true);
    }
  });

  it('blocks loopback, link-local, unique-local and mapped-v4 v6', () => {
    for (const ip of ['::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::']) {
      expect(isBlockedAddress(ip), `${ip} should be blocked`).toBe(true);
    }
  });

  it('blocks the hex form of IPv4-mapped IPv6 addresses, not just the dotted form', () => {
    // ::ffff:7f00:1 is 127.0.0.1; ::ffff:a9fe:a9fe is 169.254.169.254 (cloud metadata).
    // Both are valid IPv6 literal spellings of blocked v4 addresses that the dotted-only
    // regex (`::ffff:(\d+\.\d+\.\d+\.\d+)`) never matches.
    for (const ip of ['::ffff:7f00:1', '::ffff:a9fe:a9fe']) {
      expect(isBlockedAddress(ip), `${ip} should be blocked`).toBe(true);
    }
  });

  it('allows ordinary public addresses', () => {
    for (const ip of ['1.1.1.1', '93.184.216.34', '2606:4700:4700::1111']) {
      expect(isBlockedAddress(ip), `${ip} should be allowed`).toBe(false);
    }
  });

  it('treats 172.32.x as public - the private block ends at 172.31', () => {
    expect(isBlockedAddress('172.32.0.1')).toBe(false);
  });
});

describe('safeFetch', () => {
  it('rejects a non-http scheme', async () => {
    await expect(safeFetch('file:///etc/passwd')).rejects.toBeInstanceOf(SsrfBlocked);
    await expect(safeFetch('gopher://example.com/')).rejects.toBeInstanceOf(SsrfBlocked);
    await expect(safeFetch('data:text/html,hi')).rejects.toBeInstanceOf(SsrfBlocked);
  });

  it('rejects a hostname that resolves to a blocked address', async () => {
    await expect(safeFetch('http://localhost/')).rejects.toBeInstanceOf(SsrfBlocked);
    await expect(safeFetch('http://127.0.0.1:8080/')).rejects.toBeInstanceOf(SsrfBlocked);
  });

  it('names the reason without echoing a response body', async () => {
    await expect(safeFetch('http://169.254.169.254/latest/meta-data/'))
      .rejects.toThrow(/blocked address/i);
  });

  it('pins TLS servername to the original hostname, never to the connected IP, and never disables cert checks', async () => {
    // Real SNI and certificate verification can only be proven against a real TLS stack and a
    // real CA-issued cert - a local plaintext server proves nothing about that, and that's an
    // accepted limit. What IS cheap to lock in, decoupled from any network call: the *options
    // object* handed to `https.request` sets `servername` to the hostname (never the pinned
    // IP) and never disables `rejectUnauthorized`. A refactor that silently dropped
    // `servername` would pass every other test here while breaking every real HTTPS fetch.
    let captured: (https.RequestOptions & { servername?: string }) | undefined;
    const requestSpy = vi.spyOn(https, 'request').mockImplementation((options: unknown) => {
      captured = options as https.RequestOptions & { servername?: string };
      // No real connection: fail the hop immediately so `safeFetch` settles without ever
      // touching the network. We only care about the options this call was made with.
      const req = new EventEmitter() as unknown as ReturnType<typeof https.request>;
      (req as unknown as { end: () => void }).end = () => {
        queueMicrotask(() => req.emit('error', new Error('test double: no real network call')));
      };
      (req as unknown as { destroy: () => void }).destroy = () => {};
      return req;
    });

    try {
      await expect(safeFetch(`https://${MOCKED_HOSTNAME}/reference`)).rejects.toBeInstanceOf(SsrfBlocked);
      expect(captured).toBeDefined();
      // Connects to the pinned (resolved) IP address, not the hostname...
      expect(captured!.host).toBe(MOCKED_RESOLVED_IP);
      // ...while SNI/certificate-identity is checked against the ORIGINAL hostname, never the IP.
      expect(captured!.servername).toBe(MOCKED_HOSTNAME);
      expect(captured!.servername).not.toBe(MOCKED_RESOLVED_IP);
      expect(captured!.rejectUnauthorized).toBe(true);
    } finally {
      requestSpy.mockRestore();
    }
  });
});

describe('safeFetchWithGuard (request machinery, permissive guard against a local server)', () => {
  it('defaults to the real address guard when no predicate is injected', async () => {
    // Proves the seam is safe: call it the way a caller who forgot the third argument would,
    // and confirm it behaves exactly like `safeFetch` - still blocked, no connection made.
    await expect(safeFetchWithGuard('http://127.0.0.1:1/', {})).rejects.toBeInstanceOf(SsrfBlocked);
  });

  it('performs a successful fetch through the real machinery', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('hello world');
    });
    try {
      const result = await safeFetchWithGuard(`${server.url}/ok`, {}, allowAll);
      expect(result.ok).toBe(true);
      expect(result.status).toBe(200);
      expect(result.body).toBe('hello world');
      expect(result.contentType).toBe('text/plain');
      expect(result.finalUrl).toBe(`${server.url}/ok`);
    } finally {
      await server.close();
    }
  });

  it('follows a redirect and re-validates the address on the new hop', async () => {
    const checked: string[] = [];
    const guard = (ip: string) => { checked.push(ip); return false; };
    const server = await startServer((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { Location: '/target' });
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('landed');
      }
    });
    try {
      const result = await safeFetchWithGuard(`${server.url}/start`, {}, guard);
      expect(result.body).toBe('landed');
      expect(result.finalUrl).toBe(`${server.url}/target`);
      // One address check per hop - the redirect target was validated independently,
      // not just trusted because hop one passed.
      expect(checked.length).toBeGreaterThanOrEqual(2);
    } finally {
      await server.close();
    }
  });

  it('throws SsrfBlocked, not a raw error, when a redirect Location is unparseable', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(302, { Location: 'http://' }); // `new URL('http://', base)` throws
      res.end();
    });
    try {
      await expect(safeFetchWithGuard(`${server.url}/start`, {}, allowAll))
        .rejects.toBeInstanceOf(SsrfBlocked);
    } finally {
      await server.close();
    }
  });

  it('throws SsrfBlocked when a redirect chain exceeds the cap', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(302, { Location: '/next' }); // redirects forever, never lands
      res.end();
    });
    try {
      await expect(safeFetchWithGuard(`${server.url}/start`, {}, allowAll))
        .rejects.toThrow(/too many redirects/i);
    } finally {
      await server.close();
    }
  });

  it('stops reading once the size cap is hit, instead of buffering the whole body', async () => {
    const chunk = 'x'.repeat(100);
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      for (let i = 0; i < 50; i++) res.write(chunk); // 5000 bytes total, far past the cap
      res.end();
    });
    try {
      const result = await safeFetchWithGuard(`${server.url}/big`, { maxBytes: 250 }, allowAll);
      expect(result.body.length).toBeGreaterThan(0);
      expect(result.body.length).toBeLessThanOrEqual(250);
      expect(result.body.length).toBeLessThan(5000); // proves the cap actually stopped the read
    } finally {
      await server.close();
    }
  });

  it('fires the timeout while the body is still streaming, not just at connect', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('headers arrived, then nothing else ever comes'); // never calls res.end()
    });
    try {
      const start = Date.now();
      await expect(safeFetchWithGuard(`${server.url}/slow`, { timeoutMs: 50 }, allowAll))
        .rejects.toThrow(/timed out/i);
      // Generous bound for CI jitter - the point is "bounded", not "instant".
      expect(Date.now() - start).toBeLessThan(3000);
    } finally {
      await server.close();
    }
  });
});
