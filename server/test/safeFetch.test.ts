// server/test/safeFetch.test.ts
import { describe, it, expect } from 'vitest';
import { isBlockedAddress, safeFetch, SsrfBlocked } from '../src/lib/references/safeFetch.js';

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
