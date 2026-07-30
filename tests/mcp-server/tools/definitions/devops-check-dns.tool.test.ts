/**
 * @fileoverview Tests for the devops_check_dns tool.
 * @module tests/mcp-server/tools/definitions/devops-check-dns.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { devopsCheckDns } from '@/mcp-server/tools/definitions/devops-check-dns.tool.js';
import type { DnsResult } from '@/services/dns/dns-service.js';

vi.mock('@/services/dns/dns-service.js', () => {
  const mockCheckDomains = vi.fn();
  return {
    getDnsService: () => ({ checkDomains: mockCheckDomains }),
    initDnsService: vi.fn(),
    // The tool builds its output schema from these enums, so the mock must carry them.
    DNS_QUERY_STATUSES: ['ok', 'nodata', 'nxdomain', 'servfail', 'refused', 'timeout', 'error'],
    DISCREPANCY_KINDS: ['value_variation', 'partial_resolution'],
    _mockCheckDomains: mockCheckDomains,
  };
});

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    certTimeoutMs: 5000,
    dnsTimeoutMs: 3000,
    cacheTtlMs: 60000,
    fetchTimeoutMs: 10000,
  }),
}));

const CLEAN_DNS_RESULT: DnsResult = {
  domain: 'example.com',
  records: { A: ['93.184.216.34'], MX: ['10 mail.example.com'] },
  records_source: '8.8.8.8',
  resolver_results: [
    {
      resolver: '8.8.8.8',
      latency_ms: 42,
      records: { A: ['93.184.216.34'], MX: ['10 mail.example.com'] },
      status: 'ok',
      status_by_type: { A: 'ok', MX: 'ok' },
      error: null,
    },
    {
      resolver: '1.1.1.1',
      latency_ms: 38,
      records: { A: ['93.184.216.34'], MX: ['10 mail.example.com'] },
      status: 'ok',
      status_by_type: { A: 'ok', MX: 'ok' },
      error: null,
    },
  ],
  propagation_discrepancies: [],
  flags: [],
  error: null,
};

/** Every resolver answered, with different values — the anycast/geo-steering steady state. */
const GEO_VARIATION_DNS_RESULT: DnsResult = {
  domain: 'geo-steered.example.com',
  records: { A: ['1.2.3.4'] },
  records_source: '8.8.8.8',
  resolver_results: [
    {
      resolver: '8.8.8.8',
      latency_ms: 55,
      records: { A: ['1.2.3.4'] },
      status: 'ok',
      status_by_type: { A: 'ok' },
      error: null,
    },
    {
      resolver: '1.1.1.1',
      latency_ms: 60,
      records: { A: ['5.6.7.8'] },
      status: 'ok',
      status_by_type: { A: 'ok' },
      error: null,
    },
  ],
  propagation_discrepancies: [
    {
      record_type: 'A',
      resolvers_agree: false,
      kind: 'value_variation',
      values_by_resolver: { '8.8.8.8': ['1.2.3.4'], '1.1.1.1': ['5.6.7.8'] },
      status_by_resolver: { '8.8.8.8': 'ok', '1.1.1.1': 'ok' },
    },
  ],
  flags: [],
  error: null,
};

/** One resolver answered and one did not — the disagreement worth investigating. */
const PARTIAL_DNS_RESULT: DnsResult = {
  domain: 'migrating.example.com',
  records: { A: ['1.2.3.4'] },
  records_source: '8.8.8.8',
  resolver_results: [
    {
      resolver: '8.8.8.8',
      latency_ms: 55,
      records: { A: ['1.2.3.4'] },
      status: 'ok',
      status_by_type: { A: 'ok' },
      error: null,
    },
    {
      resolver: '1.1.1.1',
      latency_ms: 60,
      records: {},
      status: 'nodata',
      status_by_type: { A: 'nodata' },
      error: null,
    },
  ],
  propagation_discrepancies: [
    {
      record_type: 'A',
      resolvers_agree: false,
      kind: 'partial_resolution',
      values_by_resolver: { '8.8.8.8': ['1.2.3.4'], '1.1.1.1': [] },
      status_by_resolver: { '8.8.8.8': 'ok', '1.1.1.1': 'nodata' },
    },
  ],
  flags: [
    'Partial resolution on A records — 1.1.1.1 (nodata) returned nothing while 8.8.8.8 answered',
  ],
  error: null,
};

const NXDOMAIN_DNS_RESULT: DnsResult = {
  domain: 'gone.example.com',
  records: {},
  records_source: '8.8.8.8',
  resolver_results: [
    {
      resolver: '8.8.8.8',
      latency_ms: 12,
      records: {},
      status: 'nxdomain',
      status_by_type: { A: 'nxdomain' },
      error: 'NXDOMAIN on A',
    },
  ],
  propagation_discrepancies: [],
  flags: [
    'NXDOMAIN from 8.8.8.8 on A — the domain does not exist — check for a typo, an expired registration, or a missing delegation',
  ],
  error: '8.8.8.8: NXDOMAIN on A',
};

describe('devopsCheckDns', () => {
  it('returns clean results for a well-propagated domain', async () => {
    const { _mockCheckDomains } = (await import('@/services/dns/dns-service.js')) as {
      _mockCheckDomains: ReturnType<typeof vi.fn>;
    };
    _mockCheckDomains.mockResolvedValue([CLEAN_DNS_RESULT]);

    const ctx = createMockContext({ errors: devopsCheckDns.errors });
    const input = devopsCheckDns.input.parse({ domains: ['example.com'] });
    const result = await devopsCheckDns.handler(input, ctx);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.domain).toBe('example.com');
    expect(result.results[0]!.propagation_discrepancies).toHaveLength(0);
    expect(result.results[0]!.resolver_results).toHaveLength(2);
    expect(result.results[0]!.resolver_results[0]!.latency_ms).toBe(42);
    expect(result.results[0]!.error).toBeNull();
  });

  it('throws invalid_domain for protocol-prefixed input', async () => {
    const ctx = createMockContext({ errors: devopsCheckDns.errors });
    const input = devopsCheckDns.input.parse({ domains: ['https://example.com'] });
    await expect(devopsCheckDns.handler(input, ctx)).rejects.toMatchObject({
      data: {
        reason: 'invalid_domain',
        recovery: { hint: expect.stringContaining('bare hostname') },
      },
    });
  });

  it('throws target_blocked for a blocked resolver IP', async () => {
    const { _mockCheckDomains } = (await import('@/services/dns/dns-service.js')) as {
      _mockCheckDomains: ReturnType<typeof vi.fn>;
    };
    // The real checkDomains runs assertSafeResolverIp before resolving; a private resolver IP
    // throws an SSRF_BLOCKED-prefixed error out of the call. The mocked service stands in for
    // that throw so the handler's translation to the target_blocked contract is what's exercised.
    _mockCheckDomains.mockRejectedValueOnce(
      new Error(
        'SSRF_BLOCKED: Resolver IP "127.0.0.1" is in a private range (loopback). ' +
          'Only public DNS resolvers are permitted. ' +
          'Set DEVOPS_STATUS_ALLOW_PRIVATE_TARGETS=true to allow private resolvers.',
      ),
    );

    const ctx = createMockContext({ errors: devopsCheckDns.errors });
    const input = devopsCheckDns.input.parse({ domains: ['github.com'], resolvers: ['127.0.0.1'] });
    await expect(devopsCheckDns.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'target_blocked' },
    });
  });

  it('passes custom timeout to service', async () => {
    const { _mockCheckDomains } = (await import('@/services/dns/dns-service.js')) as {
      _mockCheckDomains: ReturnType<typeof vi.fn>;
    };
    _mockCheckDomains.mockResolvedValue([CLEAN_DNS_RESULT]);

    const ctx = createMockContext({ errors: devopsCheckDns.errors });
    const input = devopsCheckDns.input.parse({ domains: ['example.com'], timeout_ms: 5000 });
    await devopsCheckDns.handler(input, ctx);

    expect(_mockCheckDomains).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Array),
      expect.any(Array),
      5000,
    );
  });

  it('formats output with latency_ms, the resolver records, and their source', async () => {
    const result = { results: [CLEAN_DNS_RESULT] };
    const blocks = devopsCheckDns.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('example.com');
    expect(text).toContain('8.8.8.8');
    expect(text).toContain('42');
    expect(text).toContain('A:');
    expect(text).toContain('93.184.216.34');
    expect(text).toContain('Records (from 8.8.8.8)');
  });

  it('formats a value_variation as expected steering rather than a problem', () => {
    const result = { results: [GEO_VARIATION_DNS_RESULT] };
    const blocks = devopsCheckDns.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('value_variation');
    expect(text).toContain('normal for anycast or geo-steered domains');
    expect(text).toContain('resolvers_agree');
    expect(text).toContain('1.2.3.4');
    expect(text).toContain('5.6.7.8');
    // No flags and no partial resolution, so the domain does not read as unhealthy.
    expect(text).toContain('✅');
  });

  it('formats a partial_resolution as needing attention', () => {
    const result = { results: [PARTIAL_DNS_RESULT] };
    const blocks = devopsCheckDns.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('partial_resolution');
    expect(text).toContain('some resolvers answered and some did not');
    expect(text).toContain('1.1.1.1 (nodata)');
    expect(text).toContain('⚠️');
  });

  it('formats an NXDOMAIN domain with the per-resolver outcome', () => {
    const result = { results: [NXDOMAIN_DNS_RESULT] };
    const blocks = devopsCheckDns.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('gone.example.com');
    expect(text).toContain('nxdomain');
    expect(text).toContain('the domain does not exist');
    expect(text).toContain('8.8.8.8: NXDOMAIN on A');
  });
});
