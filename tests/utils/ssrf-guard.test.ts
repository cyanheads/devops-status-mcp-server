/**
 * @fileoverview Tests for the SSRF guard utility.
 * @module tests/utils/ssrf-guard.test
 */

import * as dnsPromises from 'node:dns/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertSafeDomain,
  assertSafeResolverIp,
  assertSafeUrl,
  ssrfRejectionMessage,
} from '@/utils/ssrf-guard.js';

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

  /** IPv4 space that is reserved or non-routable without being RFC 1918 private. */
  it('blocks the remaining non-global IPv4 ranges', () => {
    expect(() => assertSafeResolverIp('192.88.99.1')).toThrow(/6to4 relay anycast/);
    expect(() => assertSafeResolverIp('198.18.0.1')).toThrow(/benchmarking/);
    expect(() => assertSafeResolverIp('198.19.255.254')).toThrow(/benchmarking/);
    expect(() => assertSafeResolverIp('224.0.0.1')).toThrow(/multicast/);
    expect(() => assertSafeResolverIp('239.255.255.250')).toThrow(/multicast/);
    expect(() => assertSafeResolverIp('240.0.0.1')).toThrow(/reserved/);
    expect(() => assertSafeResolverIp('255.255.255.255')).toThrow(/reserved/);
    expect(() => assertSafeResolverIp('192.0.2.1')).toThrow(/TEST-NET-1/);
    expect(() => assertSafeResolverIp('203.0.113.1')).toThrow(/TEST-NET-3/);
    expect(() => assertSafeResolverIp('100.64.0.1')).toThrow(/shared address space/);
  });

  it('leaves the routable addresses bordering those ranges alone', () => {
    for (const ip of [
      '192.88.98.255',
      '192.88.100.1',
      '198.17.255.255',
      '198.20.0.1',
      '223.255.255.255',
    ]) {
      expect(() => assertSafeResolverIp(ip)).not.toThrow();
    }
  });

  it('passes for public IPv6', () => {
    expect(() => assertSafeResolverIp('2001:4860:4860::8888')).not.toThrow();
  });

  /**
   * The IPv6 ranges are matched by prefix length over the parsed 128-bit value, not by
   * string prefix. A string prefix fails in both directions: it swallows every address
   * that merely starts with the text, and it covers only the part of a range whose
   * spelling happens to share those characters.
   */
  describe('IPv6 range matching (#38)', () => {
    it('classifies an IPv4-mapped address by the IPv4 it embeds, in both encodings', () => {
      expect(() => assertSafeResolverIp('::ffff:8.8.8.8')).not.toThrow();
      expect(() => assertSafeResolverIp('::ffff:808:808')).not.toThrow();
      expect(() => assertSafeResolverIp('::ffff:127.0.0.1')).toThrow(/IPv4-mapped loopback/);
      expect(() => assertSafeResolverIp('::ffff:7f00:1')).toThrow(/IPv4-mapped loopback/);
      expect(() => assertSafeResolverIp('::ffff:10.0.0.1')).toThrow(/IPv4-mapped private/);
      expect(() => assertSafeResolverIp('::ffff:a00:1')).toThrow(/IPv4-mapped private/);
    });

    it('covers the whole fe80::/10 link-local span, not just the fe80: spelling', () => {
      for (const ip of ['fe80::1', 'fe90::1', 'fea0::1', 'febf::1', 'febf:ffff::1']) {
        expect(() => assertSafeResolverIp(ip)).toThrow(/link-local/);
      }
      // febf::/16 is the last link-local block; fec0:: is the deprecated site-local range.
      expect(() => assertSafeResolverIp('fec0::1')).toThrow(/site-local/);
    });

    it('blocks multicast (ff00::/8)', () => {
      expect(() => assertSafeResolverIp('ff02::1')).toThrow(/multicast/);
      expect(() => assertSafeResolverIp('ff00::')).toThrow(/multicast/);
      expect(() => assertSafeResolverIp('ffff::1')).toThrow(/multicast/);
    });

    it('reports IPv4-compatible IPv6 as its own category rather than loopback', () => {
      const thrown = (ip: string) => {
        try {
          assertSafeResolverIp(ip);
        } catch (err) {
          return (err as Error).message;
        }
        return '';
      };
      expect(thrown('::1234:5678')).toMatch(/IPv4-compatible/);
      expect(thrown('::1234:5678')).not.toMatch(/loopback/);
      // ::1 and :: sit inside ::/96 but are their own, more specific ranges.
      expect(thrown('::1')).toMatch(/loopback/);
      expect(thrown('::')).toMatch(/unspecified/);
    });

    it('blocks the documentation range (2001:db8::/32)', () => {
      expect(() => assertSafeResolverIp('2001:db8::1')).toThrow(/documentation/);
      expect(() => assertSafeResolverIp('2001:db8:ffff::1')).toThrow(/documentation/);
      expect(() => assertSafeResolverIp('2001:db9::1')).not.toThrow();
    });

    it('blocks unique-local by the fc00::/7 range, not by the leading characters', () => {
      const thrown = (ip: string) => {
        try {
          assertSafeResolverIp(ip);
        } catch (err) {
          return (err as Error).message;
        }
        return '';
      };
      expect(thrown('fc00::1')).toMatch(/unique local/);
      expect(thrown('fd00::1')).toMatch(/unique local/);
      expect(thrown('fdff:ffff::1')).toMatch(/unique local/);
      /**
       * fb00::/8 and 00fc:0001:: are outside fc00::/7 — a string-prefix match would
       * label them unique-local. They are still blocked, by the global-unicast test
       * rather than by the ULA range, so the label is what separates the two.
       */
      expect(thrown('fb00::1')).toMatch(/outside the allocated global unicast block/);
      expect(thrown('fb00::1')).not.toMatch(/unique local/);
      expect(thrown('fc:1::')).not.toMatch(/unique local/);
      expect(thrown('fd:1::')).not.toMatch(/unique local/);
    });

    /**
     * Only 2000::/3 is allocated to global unicast, so an address outside it is not
     * routable whether or not it has an entry in the named-range table. Classifying
     * by exclusion is what keeps a range IANA reserves later from reading as public.
     */
    it('blocks every address outside the allocated global unicast block (2000::/3)', () => {
      for (const ip of [
        '0100::1',
        '64:ff9b:1::1.2.3.4',
        '0200::1',
        '4000::1',
        '8000::1',
        'c000::1',
      ]) {
        expect(() => assertSafeResolverIp(ip)).toThrow(
          /outside the allocated global unicast block/,
        );
      }
    });

    /**
     * A DNS64 resolver answers for every IPv4-only host with a synthesized address in
     * the well-known NAT64 prefix, so `dns.lookup` returns one on an IPv6-only network
     * for domains that are perfectly public. Classifying by the embedded IPv4 — the
     * same treatment `::ffff:0:0/96` gets — is what keeps the guard from turning the
     * whole public internet away there without letting a synthesized private target in.
     */
    describe('NAT64 (64:ff9b::/96) is classified by its embedded IPv4', () => {
      const thrown = (ip: string) => {
        try {
          assertSafeResolverIp(ip);
        } catch (err) {
          return (err as Error).message;
        }
        return '';
      };

      it('allows a synthesized address embedding a public IPv4', () => {
        expect(() => assertSafeResolverIp('64:ff9b::1.2.3.4')).not.toThrow();
        expect(() => assertSafeResolverIp('64:ff9b::8.8.8.8')).not.toThrow();
        // Same address in its all-hex spelling.
        expect(() => assertSafeResolverIp('64:ff9b::808:808')).not.toThrow();
      });

      it('blocks a synthesized address embedding a private or metadata IPv4', () => {
        expect(thrown('64:ff9b::169.254.169.254')).toMatch(/NAT64 link-local \/ cloud-metadata/);
        expect(thrown('64:ff9b::a9fe:a9fe')).toMatch(/NAT64 link-local \/ cloud-metadata/);
        expect(thrown('64:ff9b::10.0.0.1')).toMatch(/NAT64 private \(RFC 1918\)/);
        expect(thrown('64:ff9b::127.0.0.1')).toMatch(/NAT64 loopback/);
      });

      /**
       * The local-use prefix puts the embedded address at a deployment-chosen offset,
       * so it is not decoded — exclusion blocks it, and the label proves which path ran.
       */
      it('leaves the local-use prefix 64:ff9b:1::/48 to the exclusion test', () => {
        expect(thrown('64:ff9b:1::1.2.3.4')).toMatch(/outside the allocated global unicast block/);
      });
    });

    /** Non-global carve-outs that sit inside 2000::/3, so exclusion alone cannot reach them. */
    it('blocks the non-global ranges carved out of 2000::/3', () => {
      expect(() => assertSafeResolverIp('2001::1')).toThrow(/Teredo/);
      expect(() => assertSafeResolverIp('2001:0:ffff::1')).toThrow(/Teredo/);
      expect(() => assertSafeResolverIp('2001:2::1')).toThrow(/benchmarking/);
      expect(() => assertSafeResolverIp('2001:10::1')).toThrow(/ORCHID \(deprecated/);
      expect(() => assertSafeResolverIp('2001:20::1')).toThrow(/ORCHIDv2/);
      expect(() => assertSafeResolverIp('2002::1')).toThrow(/6to4/);
      expect(() => assertSafeResolverIp('2002:ffff:ffff::1')).toThrow(/6to4/);
      expect(() => assertSafeResolverIp('3fff::1')).toThrow(/documentation \(RFC 9637\)/);
      expect(() => assertSafeResolverIp('3fff:fff::1')).toThrow(/documentation \(RFC 9637\)/);
    });

    it('still passes globally routable addresses adjacent to those carve-outs', () => {
      for (const ip of ['2001:4860:4860::8888', '2001:3::1', '2003::1', '2600::1', '3ffe::1']) {
        expect(() => assertSafeResolverIp(ip)).not.toThrow();
      }
    });
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

  it('blocks a URL whose host is a known internal hostname even when DNS cannot answer', async () => {
    mockLookup.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(assertSafeUrl('http://localhost:3013/api/v2/summary.json')).rejects.toThrow(
      /known internal host/,
    );
    await expect(assertSafeUrl('http://metadata.google.internal/')).rejects.toThrow(
      /known internal host/,
    );
    expect(mockLookup).not.toHaveBeenCalled();
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

  /**
   * A resolved address reaches the range check without passing through `isIP`, so the
   * IPv6 parser is the only thing standing between malformed text and a pass. It fails
   * closed: text it cannot parse is blocked rather than assumed public.
   */
  it.each(['::ffff:zzzz', '::ffff:1.2.3.999', '::ffff:256.0.0.1', '1::2::3', '12345::1', ':::'])(
    'blocks the unparsable resolved address %j rather than passing it (#38)',
    async (address) => {
      mockAddresses([{ address, family: 6 }]);
      await expect(assertSafeUrl('http://malformed-answer.example')).rejects.toThrow(
        'SSRF_BLOCKED',
      );
    },
  );

  it('resolves an IPv4-mapped public address to a pass (#38)', async () => {
    mockAddresses([{ address: '::ffff:8.8.8.8', family: 6 }]);
    await expect(assertSafeUrl('http://mapped-public.example')).resolves.toBeUndefined();
  });

  it('blocks a resolved IPv4-mapped private address by the embedded IPv4 (#38)', async () => {
    mockAddresses([{ address: '::ffff:169.254.169.254', family: 6 }]);
    await expect(assertSafeUrl('http://mapped-metadata.example')).rejects.toThrow(
      /IPv4-mapped link-local \/ cloud-metadata/,
    );
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

  /**
   * DNS failure falls through to the downstream connect on purpose, so a name that
   * only ever resolves inside the deployment would otherwise pass the guard whenever
   * the resolver could not answer it. These names are rejected before DNS is consulted.
   */
  it('blocks a known internal hostname without consulting DNS', async () => {
    mockLookup.mockRejectedValue(new Error('ENOTFOUND'));
    for (const host of [
      'localhost',
      'LOCALHOST',
      'metadata.google.internal',
      'metadata.internal',
    ]) {
      await expect(assertSafeDomain(host)).rejects.toThrow(/known internal host/);
    }
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('is a no-op when allowPrivateTargets is true (config-driven)', async () => {
    setAllowPrivateTargets(true);
    await expect(assertSafeDomain('localhost')).resolves.toBeUndefined();
    expect(mockLookup).not.toHaveBeenCalled();
  });
});

describe('ssrfRejectionMessage', () => {
  /** The error a real guard rejection throws, or a failure if the guard passed. */
  async function rejectionOf(check: () => unknown): Promise<unknown> {
    try {
      await check();
    } catch (err) {
      return err;
    }
    throw new Error('the guard did not reject');
  }

  it('recognizes every guard rejection path and returns its sentence, with nothing before it', async () => {
    mockAddresses([{ address: '10.0.0.5', family: 4 }]);
    const cases: Array<[() => unknown, string]> = [
      [() => assertSafeUrl('not a url'), 'Invalid URL "not a url".'],
      [
        () => assertSafeUrl('ftp://example.com/file'),
        'Scheme "ftp:" is not permitted. Only http:// and https:// are allowed.',
      ],
      [
        () => assertSafeUrl('https://intranet.example'),
        'URL "https://intranet.example" resolves to 10.0.0.5 (private (RFC 1918)). Requests to private, loopback, or cloud-metadata addresses are not permitted. Set DEVOPS_STATUS_ALLOW_PRIVATE_TARGETS=true to allow internal-network monitoring.',
      ],
      [
        () => assertSafeDomain('localhost'),
        'Domain "localhost" names a known internal host ("localhost"). Requests to private, loopback, or cloud-metadata addresses are not permitted. Set DEVOPS_STATUS_ALLOW_PRIVATE_TARGETS=true to allow internal-network monitoring.',
      ],
      [
        () => assertSafeResolverIp('dns.example'),
        'Resolver "dns.example" is not a valid IP address. Pass a public DNS resolver as an IPv4 or IPv6 literal, optionally with a port (e.g. "8.8.8.8", "1.1.1.1:53", "[2001:4860:4860::8888]:53").',
      ],
      [
        () => assertSafeResolverIp('127.0.0.1:53'),
        'Resolver IP "127.0.0.1:53" is in a private range (loopback). Only public DNS resolvers are permitted. Set DEVOPS_STATUS_ALLOW_PRIVATE_TARGETS=true to allow private resolvers.',
      ],
    ];
    for (const [check, sentence] of cases) {
      const err = await rejectionOf(check);
      expect((err as Error).message).toBe(`SSRF_BLOCKED: ${sentence}`);
      expect(ssrfRejectionMessage(err)).toBe(sentence);
    }
  });

  it('returns null for an error the guard did not raise', () => {
    expect(ssrfRejectionMessage(new Error('getaddrinfo ENOTFOUND a.example'))).toBeNull();
    expect(ssrfRejectionMessage(new Error(''))).toBeNull();
    expect(ssrfRejectionMessage('SSRF_BLOCKED: not an Error')).toBeNull();
    expect(ssrfRejectionMessage(undefined)).toBeNull();
  });

  it('recognizes the sentinel only at the start of the message, and strips it once', () => {
    expect(ssrfRejectionMessage(new Error('upstream said: SSRF_BLOCKED: x'))).toBeNull();
    expect(ssrfRejectionMessage(new Error('SSRF_BLOCKED: SSRF_BLOCKED: x'))).toBe(
      'SSRF_BLOCKED: x',
    );
  });
});
