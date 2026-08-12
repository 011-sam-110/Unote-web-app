// server/test/safeFetch.test.ts
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect } from 'vitest';
import { isBlockedAddress, safeFetch, safeFetchWithGuard, SsrfBlocked } from '../src/lib/references/safeFetch.js';

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
