/**
 * @fileoverview Tests for the SSRF guard utility.
 * @module tests/utils/ssrf-guard.test
 */

import * as dnsPromises from 'node:dns/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertSafeDomain, assertSafeResolverIp, assertSafeUrl } from '@/utils/ssrf-guard.js';

// We mock dns.lookup so tests run offline and are deterministic.
vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof dnsPromises>();
  return { ...actual, lookup: vi.fn() };
});

const mockLookup = vi.mocked(dnsPromises.lookup);

/** Make lookup return the given addresses (family 4 or 6). */
function mockAddresses(addresses: Array<{ address: string; family: 4 | 6 }>) {
  // The `all: true` overload returns an array, but the mock covers both.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockLookup.mockResolvedValue(addresses as any);
}

describe('assertSafeResolverIp (synchronous, no DNS)', () => {
  it('passes for public IPv4', () => {
    expect(() => assertSafeResolverIp('8.8.8.8')).not.toThrow();
    expect(() => assertSafeResolverIp('1.1.1.1')).not.toThrow();
    expect(() => assertSafeResolverIp('9.9.9.9')).not.toThrow();
  });

  it('blocks loopback (127.x.x.x)', () => {
    expect(() => assertSafeResolverIp('127.0.0.1')).toThrow('SSRF_BLOCKED');
    expect(() => assertSafeResolverIp('127.255.255.254')).toThrow('SSRF_BLOCKED');
  });

  it('blocks RFC 1918 private ranges', () => {
    expect(() => assertSafeResolverIp('10.0.0.1')).toThrow('SSRF_BLOCKED');
    expect(() => assertSafeResolverIp('172.16.0.1')).toThrow('SSRF_BLOCKED');
    expect(() => assertSafeResolverIp('172.31.255.255')).toThrow('SSRF_BLOCKED');
    expect(() => assertSafeResolverIp('192.168.1.1')).toThrow('SSRF_BLOCKED');
  });

  it('blocks cloud-metadata link-local (169.254.x.x)', () => {
    expect(() => assertSafeResolverIp('169.254.169.254')).toThrow('SSRF_BLOCKED');
    expect(() => assertSafeResolverIp('169.254.0.1')).toThrow('SSRF_BLOCKED');
  });

  it('blocks IPv6 loopback', () => {
    expect(() => assertSafeResolverIp('::1')).toThrow('SSRF_BLOCKED');
  });

  it('blocks IPv6 link-local', () => {
    expect(() => assertSafeResolverIp('fe80::1')).toThrow('SSRF_BLOCKED');
  });

  it('passes for public IPv6', () => {
    expect(() => assertSafeResolverIp('2001:4860:4860::8888')).not.toThrow();
  });

  it('is a no-op when STATUS_ALLOW_PRIVATE_TARGETS=true', () => {
    process.env.STATUS_ALLOW_PRIVATE_TARGETS = 'true';
    try {
      expect(() => assertSafeResolverIp('127.0.0.1')).not.toThrow();
      expect(() => assertSafeResolverIp('10.0.0.1')).not.toThrow();
      expect(() => assertSafeResolverIp('169.254.169.254')).not.toThrow();
    } finally {
      delete process.env.STATUS_ALLOW_PRIVATE_TARGETS;
    }
  });
});

describe('assertSafeUrl (async, mocked DNS)', () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.STATUS_ALLOW_PRIVATE_TARGETS;
  });

  it('passes for a URL resolving to a public IP', async () => {
    mockAddresses([{ address: '185.199.108.153', family: 4 }]);
    await expect(assertSafeUrl('https://www.githubstatus.com')).resolves.toBeUndefined();
  });

  it('blocks a URL resolving to loopback', async () => {
    mockAddresses([{ address: '127.0.0.1', family: 4 }]);
    await expect(assertSafeUrl('http://internal-service')).rejects.toThrow('SSRF_BLOCKED');
  });

  it('blocks cloud-metadata URL (169.254.169.254)', async () => {
    mockAddresses([{ address: '169.254.169.254', family: 4 }]);
    await expect(assertSafeUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      'SSRF_BLOCKED',
    );
  });

  it('blocks a URL resolving to RFC 1918 private IP', async () => {
    mockAddresses([{ address: '10.0.0.50', family: 4 }]);
    await expect(assertSafeUrl('https://internal.corp')).rejects.toThrow('SSRF_BLOCKED');
  });

  it('blocks non-http/https schemes', async () => {
    await expect(assertSafeUrl('file:///etc/passwd')).rejects.toThrow('SSRF_BLOCKED');
    await expect(assertSafeUrl('ftp://10.0.0.1/file')).rejects.toThrow('SSRF_BLOCKED');
  });

  it('blocks malformed URL', async () => {
    await expect(assertSafeUrl('not a url')).rejects.toThrow('SSRF_BLOCKED');
  });

  it('passes when STATUS_ALLOW_PRIVATE_TARGETS=true even for private IP', async () => {
    process.env.STATUS_ALLOW_PRIVATE_TARGETS = 'true';
    // lookup should NOT be called when guards are disabled
    await expect(assertSafeUrl('http://10.0.0.1/api/v2/summary.json')).resolves.toBeUndefined();
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('proceeds normally when DNS lookup fails (network failure is not a security block)', async () => {
    mockLookup.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(assertSafeUrl('https://somepublic.example.com')).resolves.toBeUndefined();
  });

  it('blocks when any resolved address is private (even if others are public)', async () => {
    mockAddresses([
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.1', family: 4 }, // attacker-controlled DNS returns a private addr too
    ]);
    await expect(assertSafeUrl('https://attacker-controlled.example')).rejects.toThrow(
      'SSRF_BLOCKED',
    );
  });
});

describe('assertSafeDomain (async, mocked DNS)', () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.STATUS_ALLOW_PRIVATE_TARGETS;
  });

  it('passes for a public domain', async () => {
    mockAddresses([{ address: '93.184.216.34', family: 4 }]);
    await expect(assertSafeDomain('example.com')).resolves.toBeUndefined();
  });

  it('blocks a domain resolving to loopback', async () => {
    mockAddresses([{ address: '127.0.0.1', family: 4 }]);
    await expect(assertSafeDomain('localhost')).rejects.toThrow('SSRF_BLOCKED');
  });

  it('blocks a domain resolving to cloud-metadata IP', async () => {
    mockAddresses([{ address: '169.254.169.254', family: 4 }]);
    await expect(assertSafeDomain('metadata.internal')).rejects.toThrow('SSRF_BLOCKED');
  });

  it('blocks a domain resolving to private RFC 1918 range', async () => {
    mockAddresses([{ address: '192.168.100.50', family: 4 }]);
    await expect(assertSafeDomain('intranet.corp')).rejects.toThrow('SSRF_BLOCKED');
  });

  it('is a no-op when STATUS_ALLOW_PRIVATE_TARGETS=true', async () => {
    process.env.STATUS_ALLOW_PRIVATE_TARGETS = 'true';
    await expect(assertSafeDomain('localhost')).resolves.toBeUndefined();
    expect(mockLookup).not.toHaveBeenCalled();
  });
});
