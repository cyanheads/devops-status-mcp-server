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
  resolver_results: [
    {
      resolver: '8.8.8.8',
      latency_ms: 42,
      records: { A: ['93.184.216.34'], MX: ['10 mail.example.com'] },
      error: null,
    },
    {
      resolver: '1.1.1.1',
      latency_ms: 38,
      records: { A: ['93.184.216.34'], MX: ['10 mail.example.com'] },
      error: null,
    },
  ],
  propagation_discrepancies: [],
  flags: [],
  error: null,
};

const DISCREPANCY_DNS_RESULT: DnsResult = {
  domain: 'migrating.example.com',
  records: { A: ['1.2.3.4'] },
  resolver_results: [
    {
      resolver: '8.8.8.8',
      latency_ms: 55,
      records: { A: ['1.2.3.4'] },
      error: null,
    },
    {
      resolver: '1.1.1.1',
      latency_ms: 60,
      records: { A: ['5.6.7.8'] },
      error: null,
    },
  ],
  propagation_discrepancies: [
    {
      record_type: 'A',
      resolvers_agree: false,
      values_by_resolver: { '8.8.8.8': ['1.2.3.4'], '1.1.1.1': ['5.6.7.8'] },
    },
  ],
  flags: ['Propagation mismatch on A records'],
  error: null,
};

const ERROR_DNS_RESULT: DnsResult = {
  domain: 'invalid-.domain',
  records: {},
  resolver_results: [],
  propagation_discrepancies: [],
  flags: ['Unexpected error: ENOTFOUND'],
  error: 'ENOTFOUND',
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

  it('returns discrepancy when resolvers disagree', async () => {
    const { _mockCheckDomains } = (await import('@/services/dns/dns-service.js')) as {
      _mockCheckDomains: ReturnType<typeof vi.fn>;
    };
    _mockCheckDomains.mockResolvedValue([DISCREPANCY_DNS_RESULT]);

    const ctx = createMockContext({ errors: devopsCheckDns.errors });
    const input = devopsCheckDns.input.parse({ domains: ['migrating.example.com'] });
    const result = await devopsCheckDns.handler(input, ctx);

    expect(result.results[0]!.propagation_discrepancies).toHaveLength(1);
    expect(result.results[0]!.propagation_discrepancies[0]!.record_type).toBe('A');
    expect(result.results[0]!.propagation_discrepancies[0]!.resolvers_agree).toBe(false);
    expect(result.results[0]!.flags).toContain('Propagation mismatch on A records');
  });

  it('throws invalid_domain for protocol-prefixed input', async () => {
    const ctx = createMockContext({ errors: devopsCheckDns.errors });
    const input = devopsCheckDns.input.parse({ domains: ['https://example.com'] });
    await expect(devopsCheckDns.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_domain' },
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

  it('formats output with latency_ms and resolver records', async () => {
    const result = { results: [CLEAN_DNS_RESULT] };
    const blocks = devopsCheckDns.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('example.com');
    expect(text).toContain('8.8.8.8');
    expect(text).toContain('42');
    expect(text).toContain('A:');
    expect(text).toContain('93.184.216.34');
  });

  it('formats discrepancy with resolvers_agree field', () => {
    const result = { results: [DISCREPANCY_DNS_RESULT] };
    const blocks = devopsCheckDns.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('resolvers_agree');
    expect(text).toContain('false');
    expect(text).toContain('1.2.3.4');
    expect(text).toContain('5.6.7.8');
  });

  it('formats error domain gracefully', () => {
    const result = { results: [ERROR_DNS_RESULT] };
    const blocks = devopsCheckDns.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('invalid-.domain');
    expect(text).toContain('ENOTFOUND');
  });
});
