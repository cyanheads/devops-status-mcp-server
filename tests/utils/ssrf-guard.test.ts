/**
 * @fileoverview Tests for the SSRF guard utility.
 * @module tests/utils/ssrf-guard.test
 */

import * as dnsPromises from 'node:dns/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertSafeDomain, assertSafeResolverIp, assertSafeUrl } from '@/utils/ssrf-guard.js';

/**
 * The guard reads `getServerConfig().allowPrivateTargets`, not `process.env`. Mock the config
 * module so each test drives the parsed flag directly — the real `getServerConfig` caches a
 * singleton, so mutating `process.env` mid-suite would have no effect after the first parse.
 */
vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn(() => ({ allowPrivateTargets })),
}));

let allowPrivateTargets = false;

/** Drive the parsed `allowPrivateTargets` config flag for the current test. */
function setAllowPrivateTargets(value: boolean): void {
  allowPrivateTargets = value;
}

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

afterEach(() => {
  vi.clearAllMocks();
  setAllowPrivateTargets(false);
});

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

  it('blocks the IPv4 unspecified address, which routes to the local host (#29)', () => {
    expect(() => assertSafeResolverIp('0.0.0.0')).toThrow(/unspecified/);
    expect(() => assertSafeResolverIp('0.1.2.3')).toThrow('SSRF_BLOCKED');
  });

  it('blocks the IPv6 unspecified address in both spellings (#29)', () => {
    expect(() => assertSafeResolverIp('::')).toThrow(/unspecified/);
    expect(() => assertSafeResolverIp('0:0:0:0:0:0:0:0')).toThrow(/unspecified/);
  });

  it('blocks a private resolver carrying a :port suffix (#29)', () => {
    // dns.setServers() accepts this form, so the port has to come off before the
    // address is range-checked — otherwise the colon reads as an IPv6 literal.
    expect(() => assertSafeResolverIp('127.0.0.1:53')).toThrow(/loopback/);
    expect(() => assertSafeResolverIp('10.0.0.1:5353')).toThrow(/RFC 1918/);
    expect(() => assertSafeResolverIp('0.0.0.0:53')).toThrow(/unspecified/);
    expect(() => assertSafeResolverIp('[::1]:53')).toThrow(/loopback/);
    expect(() => assertSafeResolverIp('[::]:53')).toThrow(/unspecified/);
  });

  it('still passes public resolvers carrying a :port suffix (#29)', () => {
    expect(() => assertSafeResolverIp('8.8.8.8:53')).not.toThrow();
    expect(() => assertSafeResolverIp('[2001:4860:4860::8888]:53')).not.toThrow();
    expect(() => assertSafeResolverIp('2001:4860:4860::8888')).not.toThrow();
  });

  it('rejects a resolver that is not an IP literal rather than passing it to setServers (#29)', () => {
    expect(() => assertSafeResolverIp('localhost')).toThrow(/not a valid IP address/);
    expect(() => assertSafeResolverIp('dns.internal.corp')).toThrow(/not a valid IP address/);
    expect(() => assertSafeResolverIp('')).toThrow(/not a valid IP address/);
    // Decimal- and hex-shaped near-misses that the octet parser would coerce.
    expect(() => assertSafeResolverIp('0x7f.0.0.1')).toThrow(/not a valid IP address/);
    expect(() => assertSafeResolverIp('8.8.8.8.8')).toThrow(/not a valid IP address/);
  });

  it('blocks IPv6 link-local', () => {
    expect(() => assertSafeResolverIp('fe80::1')).toThrow('SSRF_BLOCKED');
  });

  it('passes for public IPv6', () => {
    expect(() => assertSafeResolverIp('2001:4860:4860::8888')).not.toThrow();
  });

  it('is a no-op when allowPrivateTargets is true (config-driven)', () => {
    setAllowPrivateTargets(true);
    expect(() => assertSafeResolverIp('127.0.0.1')).not.toThrow();
    expect(() => assertSafeResolverIp('10.0.0.1')).not.toThrow();
    expect(() => assertSafeResolverIp('169.254.169.254')).not.toThrow();
  });
});

describe('assertSafeUrl (async, mocked DNS)', () => {
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

  it('blocks a URL resolving to an unspecified address (#29)', async () => {
    mockAddresses([{ address: '0.0.0.0', family: 4 }]);
    await expect(assertSafeUrl('http://0.0.0.0:3013')).rejects.toThrow(/unspecified/);
  });

  it('blocks a URL resolving to the IPv6 unspecified address (#29)', async () => {
    mockAddresses([{ address: '::', family: 6 }]);
    await expect(assertSafeUrl('http://all-interfaces.example')).rejects.toThrow(/unspecified/);
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

  it('passes when allowPrivateTargets is true even for private IP (config-driven)', async () => {
    setAllowPrivateTargets(true);
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

/**
 * A URL carrying an IP literal must be range-checked without DNS. `lookup()` throws on
 * the bracketed IPv6 form a URL hostname carries, and the guard fails open on DNS
 * failure — so a literal routed through resolution skips the check entirely. Every
 * other assertSafeUrl test mocks DNS to return the private address, which is what hid
 * this: the mock answered a lookup that never happens for a real literal.
 */
describe('assertSafeUrl with IP literals (no DNS involved)', () => {
  it.each([
    ['http://[::1]', /loopback/],
    ['http://[::]', /unspecified/],
    ['http://[fe80::1]', /link-local/],
    ['http://[fd00::1]', /unique local/],
    ['http://[::ffff:127.0.0.1]', /IPv4-mapped/],
    ['http://127.0.0.1', /loopback/],
    ['http://10.1.2.3:8080', /private/],
  ])('blocks %s without consulting DNS (#29)', async (url, label) => {
    mockLookup.mockRejectedValue(new Error('lookup must not be reached for an IP literal'));
    await expect(assertSafeUrl(url)).rejects.toThrow(label);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('still allows a public IP literal', async () => {
    mockLookup.mockRejectedValue(new Error('lookup must not be reached for an IP literal'));
    await expect(assertSafeUrl('http://185.199.108.153')).resolves.toBeUndefined();
    await expect(assertSafeUrl('http://[2001:4860:4860::8888]')).resolves.toBeUndefined();
    expect(mockLookup).not.toHaveBeenCalled();
  });
});

describe('assertSafeDomain (async, mocked DNS)', () => {
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

  it('is a no-op when allowPrivateTargets is true (config-driven)', async () => {
    setAllowPrivateTargets(true);
    await expect(assertSafeDomain('localhost')).resolves.toBeUndefined();
    expect(mockLookup).not.toHaveBeenCalled();
  });
});
