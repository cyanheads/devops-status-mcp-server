/**
 * @fileoverview Tests for the devops_check_dns tool.
 * @module tests/mcp-server/tools/definitions/devops-check-dns.tool.test
 */

import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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

/**
 * Both resolvers returned the domain-level set, so the service elided both copies and
 * named the types in `records_same_as_domain` — the shape the tool actually receives
 * when resolvers agree, which is the common case.
 */
const CLEAN_DNS_RESULT: DnsResult = {
  domain: 'example.com',
  records: { A: ['93.184.216.34'], MX: ['10 mail.example.com'] },
  records_source: '8.8.8.8',
  resolver_results: [
    {
      resolver: '8.8.8.8',
      latency_ms: 42,
      records: {},
      records_same_as_domain: ['A', 'MX'],
      status: 'ok',
      status_by_type: { A: 'ok', MX: 'ok' },
      error: null,
    },
    {
      resolver: '1.1.1.1',
      latency_ms: 38,
      records: {},
      records_same_as_domain: ['A', 'MX'],
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
      records: {},
      records_same_as_domain: ['A'],
      status: 'ok',
      status_by_type: { A: 'ok' },
      error: null,
    },
    {
      // Divergent from the domain-level set, so the values are kept in full.
      resolver: '1.1.1.1',
      latency_ms: 60,
      records: { A: ['5.6.7.8'] },
      records_same_as_domain: [],
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
      records: {},
      records_same_as_domain: ['A'],
      status: 'ok',
      status_by_type: { A: 'ok' },
      error: null,
    },
    {
      // Returned nothing, so the type is in neither map — status_by_type carries the why.
      resolver: '1.1.1.1',
      latency_ms: 60,
      records: {},
      records_same_as_domain: [],
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
      records_same_as_domain: [],
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

/** The deferral fields of a call at or under every cap, for format() inputs. */
const NOTHING_DEFERRED = { deferred_domains: [], deferred_resolvers: [] };

/** A domain the SSRF guard rejected before any resolver was queried. */
const REJECTED_DNS_RESULT: DnsResult = {
  domain: 'localhost',
  records: {},
  records_source: null,
  resolver_results: [],
  propagation_discrepancies: [],
  flags: [],
  error: 'Domain "localhost" names a known internal host ("localhost").',
};

describe('devopsCheckDns', () => {
  it('returns clean results for a well-propagated domain', async () => {
    const { _mockCheckDomains } = (await import('@/services/dns/dns-service.js')) as unknown as {
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

  it('hands the service each entry read as one name, never failing the call (#68)', async () => {
    const { _mockCheckDomains } = (await import('@/services/dns/dns-service.js')) as unknown as {
      _mockCheckDomains: ReturnType<typeof vi.fn>;
    };
    _mockCheckDomains.mockResolvedValue([CLEAN_DNS_RESULT, CLEAN_DNS_RESULT, CLEAN_DNS_RESULT]);

    const result = await runToolContract(devopsCheckDns, {
      domains: ['https://example.com/login', 'Example.com:443', '1.1.1.1'],
    });
    expect(result.isError).toBeFalsy();
    const [entries] = _mockCheckDomains.mock.lastCall as [Array<Record<string, unknown>>];
    expect(entries.slice(0, 2)).toEqual([
      { kind: 'host', input: 'https://example.com/login', host: 'example.com', port: null },
      { kind: 'host', input: 'Example.com:443', host: 'example.com', port: null },
    ]);
    expect(entries[2]).toMatchObject({ kind: 'invalid', input: '1.1.1.1' });
  });

  it('declares no invalid_domain error, since no entry fails the call (#68)', () => {
    expect(devopsCheckDns.errors?.map((e) => e.reason)).toEqual(['target_blocked']);
  });

  it('describes the accepted entry shapes (#68)', () => {
    const domains = devopsCheckDns.input.shape.domains.description ?? '';
    expect(domains).toContain('a scheme, port, path, query, or fragment is dropped');
    expect(domains).toContain('a trailing dot and underscore labels are kept');
    expect(domains).toContain('gets its own result with "error" set and is never queried');
  });

  it('throws target_blocked for a blocked resolver IP', async () => {
    const { _mockCheckDomains } = (await import('@/services/dns/dns-service.js')) as unknown as {
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
      // The guard's sentence reaches the caller whole, with the internal sentinel stripped.
      message:
        'Resolver IP "127.0.0.1" is in a private range (loopback). Only public DNS resolvers are permitted. Set DEVOPS_STATUS_ALLOW_PRIVATE_TARGETS=true to allow private resolvers.',
    });
  });

  it('passes custom timeout to service', async () => {
    const { _mockCheckDomains } = (await import('@/services/dns/dns-service.js')) as unknown as {
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
      ctx.signal,
    );
  });

  it('describes timeout_ms as one limit per domain+resolver pair, TCP retry included (#64)', () => {
    const description = devopsCheckDns.input.shape.timeout_ms.description ?? '';
    expect(description).toContain('for each domain+resolver pair');
    expect(description).toContain('every requested record type and any retry over TCP');
    expect(description).toContain('Defaults to 3000');
    expect(description).not.toContain('DEVOPS_STATUS');
  });

  it('formats output with latency_ms, the resolver records, and their source', async () => {
    const result = { ...NOTHING_DEFERRED, results: [CLEAN_DNS_RESULT] };
    const blocks = devopsCheckDns.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('example.com');
    expect(text).toContain('8.8.8.8');
    expect(text).toContain('42');
    expect(text).toContain('A:');
    expect(text).toContain('93.184.216.34');
    expect(text).toContain('Records (from 8.8.8.8)');
  });

  it('states resolver agreement rather than rendering an elided set as nothing (#41)', () => {
    const result = { ...NOTHING_DEFERRED, results: [CLEAN_DNS_RESULT] };
    const blocks = devopsCheckDns.format!(result);
    const text = (blocks[0] as { text: string }).text;
    // A bare "A: ok" would read as "this resolver returned no records".
    expect(text).toContain('agreed with the domain-level records on A, MX');
    expect(text).toContain('A: ok → same values as the domain-level A records above');
    expect(text).toContain('MX: ok → same values as the domain-level MX records above');

    // Agreement is claimed only where it happened: a resolver that returned nothing
    // keeps its bare status line.
    const partial = devopsCheckDns.format!({ ...NOTHING_DEFERRED, results: [PARTIAL_DNS_RESULT] });
    const partialText = (partial[0] as { text: string }).text;
    expect(partialText).toContain('A: nodata');
    expect(partialText).not.toContain('A: nodata → same values');
  });

  it('renders divergent per-resolver values in full while eliding the agreeing side (#41)', () => {
    const result = { ...NOTHING_DEFERRED, results: [GEO_VARIATION_DNS_RESULT] };
    const blocks = devopsCheckDns.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('- 8.8.8.8: ok in 55 ms');
    expect(text).toContain('A: ok → same values as the domain-level A records above');
    expect(text).toContain('A: ok → 5.6.7.8');
  });

  it('formats a value_variation as expected steering rather than a problem', () => {
    const result = { ...NOTHING_DEFERRED, results: [GEO_VARIATION_DNS_RESULT] };
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
    const result = { ...NOTHING_DEFERRED, results: [PARTIAL_DNS_RESULT] };
    const blocks = devopsCheckDns.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('partial_resolution');
    expect(text).toContain('some resolvers answered and some did not');
    expect(text).toContain('1.1.1.1 (nodata)');
    expect(text).toContain('⚠️');
  });

  it('formats an NXDOMAIN domain with the per-resolver outcome', () => {
    const result = { ...NOTHING_DEFERRED, results: [NXDOMAIN_DNS_RESULT] };
    const blocks = devopsCheckDns.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('gone.example.com');
    expect(text).toContain('nxdomain');
    expect(text).toContain('the domain does not exist');
    expect(text).toContain('8.8.8.8: NXDOMAIN on A');
    // All resolvers failed: the error and the explanatory flag both carry information (#31).
    expect(text).toContain('**Error:** 8.8.8.8: NXDOMAIN on A');
    expect(text).toContain('**Flags:** NXDOMAIN from 8.8.8.8 on A');
    expect(text).toContain('**Resolver results:**');
  });

  it('states a rejected domain once, with no empty resolver header (#45)', () => {
    const message =
      'Domain "localhost" names a known internal host ("localhost"). Requests to private, loopback, or cloud-metadata addresses are not permitted.';
    const text = (
      devopsCheckDns.format!({
        ...NOTHING_DEFERRED,
        results: [{ ...REJECTED_DNS_RESULT, error: message }],
      })[0] as { text: string }
    ).text;

    expect(text).toContain('### ❌ localhost');
    expect(text.split(message)).toHaveLength(2);
    expect(text).not.toContain('**Flags:**');
    expect(text).not.toContain('**Resolver results:**');
  });

  describe('CAA and SOA record types (#70)', () => {
    const CAA_SOA_RESULT: DnsResult = {
      domain: 'example.com',
      records: {
        CAA: ['0 issue "letsencrypt.org"', '0 issuewild "digicert.com"'],
        SOA: ['ns1.example.net hostmaster.example.net 2026101401 43200 7200 1209600 3600'],
      },
      records_source: '8.8.8.8',
      resolver_results: [
        {
          resolver: '8.8.8.8',
          latency_ms: 12,
          records: {},
          records_same_as_domain: ['CAA', 'SOA'],
          status: 'ok',
          status_by_type: { CAA: 'ok', SOA: 'ok' },
          error: null,
        },
      ],
      propagation_discrepancies: [],
      flags: [],
      error: null,
    };

    it('accepts CAA and SOA and keeps the defaults at A, AAAA, MX, TXT', () => {
      const parsed = devopsCheckDns.input.parse({
        domains: ['example.com'],
        record_types: ['CAA', 'SOA'],
      });
      expect(parsed.record_types).toEqual(['CAA', 'SOA']);
      expect(devopsCheckDns.input.parse({ domains: ['example.com'] }).record_types).toEqual([
        'A',
        'AAAA',
        'MX',
        'TXT',
      ]);
    });

    it('carries CAA and SOA values through structuredContent and the rendered text', async () => {
      const { _mockCheckDomains } = (await import('@/services/dns/dns-service.js')) as unknown as {
        _mockCheckDomains: ReturnType<typeof vi.fn>;
      };
      _mockCheckDomains.mockResolvedValue([CAA_SOA_RESULT]);

      const result = await runToolContract(devopsCheckDns, {
        domains: ['example.com'],
        record_types: ['CAA', 'SOA'],
      });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as { results: DnsResult[] };
      expect(structured.results[0]!.records).toEqual(CAA_SOA_RESULT.records);
      const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      expect(text).toContain('- CAA: 0 issue "letsencrypt.org", 0 issuewild "digicert.com"');
      expect(text).toContain(
        '- SOA: ns1.example.net hostmaster.example.net 2026101401 43200 7200 1209600 3600',
      );
      expect(text).toContain('CAA: ok → same values as the domain-level CAA records above');
    });

    it('states the CAA and SOA boundaries in the record_types description', () => {
      const description = devopsCheckDns.input.shape.record_types.description ?? '';
      expect(description).toContain('SOA answers only at a zone apex');
      expect(description).toContain('report the same primary nameserver');
      expect(description).toContain('more than one DNS provider serves the zone');
      expect(description).toContain('CAA is reported for the exact name only');
      expect(description).toContain('checks the parent domains');
      expect(devopsCheckDns.description).toContain('A/AAAA/CNAME/MX/TXT/NS/CAA/SOA');
    });

    it('names the CAA and SOA render formats in the records description', () => {
      const records = devopsCheckDns.output.shape.results.element.shape.records.description ?? '';
      expect(records).toContain('CAA as \'<flags> <tag> "<value>"\'');
      expect(records).toContain(
        'SOA as "<primary nameserver> <hostmaster> <serial> <refresh> <retry> <expire> <minimum>"',
      );
    });
  });

  describe('empty resolvers / record_types (#48)', () => {
    const DEFAULT_TYPES = ['A', 'AAAA', 'MX', 'TXT'];
    const DEFAULT_RESOLVERS = ['8.8.8.8', '1.1.1.1', '9.9.9.9'];
    const GITHUB = [{ kind: 'host', input: 'github.com', host: 'github.com', port: null }];
    const LIVE = expect.any(AbortSignal);

    async function callWith(args: Record<string, unknown>) {
      const { _mockCheckDomains } = (await import('@/services/dns/dns-service.js')) as unknown as {
        _mockCheckDomains: ReturnType<typeof vi.fn>;
      };
      _mockCheckDomains.mockResolvedValue([CLEAN_DNS_RESULT]);
      const ctx = createMockContext({ errors: devopsCheckDns.errors });
      await devopsCheckDns.handler(
        devopsCheckDns.input.parse({ domains: ['github.com'], ...args }),
        ctx,
      );
      return _mockCheckDomains;
    }

    it('passes non-empty arrays through unchanged', async () => {
      const mock = await callWith({ resolvers: ['1.1.1.1:53'], record_types: ['NS', 'CNAME'] });
      expect(mock).toHaveBeenLastCalledWith(GITHUB, ['NS', 'CNAME'], ['1.1.1.1:53'], 3000, LIVE);
    });

    it('queries the defaults when both fields are omitted', async () => {
      const mock = await callWith({});
      expect(mock).toHaveBeenLastCalledWith(GITHUB, DEFAULT_TYPES, DEFAULT_RESOLVERS, 3000, LIVE);
    });

    it('queries the default resolvers when resolvers is an empty array', async () => {
      const mock = await callWith({ resolvers: [], record_types: ['A'] });
      expect(mock).toHaveBeenLastCalledWith(GITHUB, ['A'], DEFAULT_RESOLVERS, 3000, LIVE);
    });

    it('queries the default record types when record_types is an empty array', async () => {
      const mock = await callWith({ record_types: [], resolvers: ['8.8.8.8'] });
      expect(mock).toHaveBeenLastCalledWith(GITHUB, DEFAULT_TYPES, ['8.8.8.8'], 3000, LIVE);
    });

    it('queries both defaults when both fields are empty arrays', async () => {
      const mock = await callWith({ resolvers: [], record_types: [] });
      expect(mock).toHaveBeenLastCalledWith(GITHUB, DEFAULT_TYPES, DEFAULT_RESOLVERS, 3000, LIVE);
    });

    it('documents the empty-array default on both fields', () => {
      expect(devopsCheckDns.input.shape.resolvers.description).toContain('An empty array');
      expect(devopsCheckDns.input.shape.record_types.description).toContain('An empty array');
    });
  });

  describe('input bounds (#69)', () => {
    type Entry = { kind: 'host'; host: string } | { kind: 'invalid'; input: string };
    type Structured = {
      results: DnsResult[];
      deferred_domains: string[];
      deferred_resolvers: string[];
      notice?: string;
    };

    /** One row per entry, named as the service names it, so the rows mirror what was queried. */
    async function serveRows() {
      const { _mockCheckDomains } = (await import('@/services/dns/dns-service.js')) as unknown as {
        _mockCheckDomains: ReturnType<typeof vi.fn>;
      };
      _mockCheckDomains.mockImplementation(async (entries: Entry[]) =>
        entries.map((e) => ({
          ...CLEAN_DNS_RESULT,
          domain: e.kind === 'host' ? e.host : e.input,
        })),
      );
      return _mockCheckDomains;
    }

    async function call(args: Record<string, unknown>) {
      const mock = await serveRows();
      mock.mockClear();
      const result = await runToolContract(devopsCheckDns, args as never);
      const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      const [entries, types, resolvers, timeout] = (mock.mock.lastCall ?? []) as [
        Entry[],
        string[],
        string[],
        number,
      ];
      return {
        result,
        text,
        structured: result.structuredContent as Structured,
        entries,
        types,
        resolvers,
        timeout,
      };
    }

    const names = (count: number, from = 1) =>
      Array.from({ length: count }, (_, i) => `d${from + i}.example.com`);

    it('queries the first 10 domains and returns the rest verbatim in deferred_domains', async () => {
      const domains = [...names(10), ' D11.Example.com/path '];
      const { result, structured, entries, text } = await call({ domains });

      expect(result.isError).toBeFalsy();
      expect(entries.map((e) => (e.kind === 'host' ? e.host : e.input))).toEqual(names(10));
      expect(structured.results.map((r) => r.domain)).toEqual(names(10));
      expect(structured.deferred_domains).toEqual([' D11.Example.com/path ']);
      const notice =
        'Only the first 10 of 11 domains were queried (10 per call); resend the 1 in deferred_domains in another call.';
      expect(structured.notice).toBe(notice);
      expect(text.split(notice)).toHaveLength(2);
      expect(text).toContain(' D11.Example.com/path ');
    });

    it('lets an invalid entry within the first 10 take a slot as its own row', async () => {
      const domains = ['1.1.1.1', ...names(9), 'd10.example.com'];
      const { structured, entries } = await call({ domains });

      expect(entries).toHaveLength(10);
      expect(entries[0]).toMatchObject({ kind: 'invalid', input: '1.1.1.1' });
      expect(structured.results[0]!.domain).toBe('1.1.1.1');
      expect(structured.deferred_domains).toEqual(['d10.example.com']);
    });

    it('accepts 100 domains and rejects 101, naming 100', async () => {
      const hundred = await call({ domains: names(100) });
      expect(hundred.result.isError).toBeFalsy();
      expect(hundred.entries).toHaveLength(10);
      expect(hundred.structured.deferred_domains).toEqual(names(90, 11));

      const over = await call({ domains: names(101) });
      expect(over.result.isError).toBe(true);
      expect(over.entries).toBeUndefined();
      expect(
        (over.result.structuredContent as { error: { message: string } }).error.message,
      ).toContain('<=100 items');
    });

    it('queries a resolver written several ways once, and defers past the first 5 distinct', async () => {
      const resolvers = [
        '8.8.8.8',
        '1.1.1.1',
        '8.8.8.8:53',
        '9.9.9.9',
        '[2001:4860:4860::8888]:53',
        '2001:4860:4860:0:0:0:0:8888',
        '208.67.222.222',
        '8.8.4.4',
      ];
      const {
        structured,
        resolvers: queried,
        text,
      } = await call({
        domains: ['example.com'],
        resolvers,
      });

      expect(queried).toEqual([
        '8.8.8.8',
        '1.1.1.1',
        '9.9.9.9',
        '[2001:4860:4860::8888]:53',
        '208.67.222.222',
      ]);
      expect(structured.deferred_resolvers).toEqual(['8.8.4.4']);
      const notice =
        'Only the first 5 of 6 resolvers were queried (5 per call); resend the 1 in deferred_resolvers in another call.';
      expect(structured.notice).toBe(notice);
      expect(text.split(notice)).toHaveLength(2);
      expect(structured.deferred_domains).toEqual([]);
    });

    it('keeps the same address on another port as a separate resolver', async () => {
      const { resolvers, structured } = await call({
        domains: ['example.com'],
        resolvers: ['8.8.8.8', '8.8.8.8:5353', '[2001:4860:4860::8888]', '2001:4860:4860::8888'],
      });
      expect(resolvers).toEqual(['8.8.8.8', '8.8.8.8:5353', '[2001:4860:4860::8888]']);
      expect(structured.notice).toBeUndefined();
    });

    it('accepts 20 resolver entries and rejects 21, naming 20', async () => {
      const twenty = Array.from({ length: 20 }, (_, i) => `8.8.${i}.8`);
      const accepted = await call({ domains: ['example.com'], resolvers: twenty });
      expect(accepted.result.isError).toBeFalsy();
      expect(accepted.resolvers).toEqual(twenty.slice(0, 5));
      expect(accepted.structured.deferred_resolvers).toEqual(twenty.slice(5));

      const over = await call({ domains: ['example.com'], resolvers: [...twenty, '8.8.20.8'] });
      expect(over.result.isError).toBe(true);
      expect(over.entries).toBeUndefined();
      expect(
        (over.result.structuredContent as { error: { message: string } }).error.message,
      ).toContain('<=20 items');
    });

    it('queries a repeated record type once', async () => {
      const { types, structured } = await call({
        domains: ['example.com'],
        record_types: ['A', 'MX', 'A', 'TXT', 'MX'],
      });
      expect(types).toEqual(['A', 'MX', 'TXT']);
      expect(structured.notice).toBeUndefined();
    });

    it('serves a timeout_ms over 10000 at 10000 and says so, keeping the 1000 floor', async () => {
      const { timeout, structured, text } = await call({
        domains: ['example.com'],
        timeout_ms: 60000,
      });
      expect(timeout).toBe(10000);
      const notice = 'timeout_ms 60000 is past the maximum of 10000; 10000 was used.';
      expect(structured.notice).toBe(notice);
      expect(text.split(notice)).toHaveLength(2);

      const floor = await call({ domains: ['example.com'], timeout_ms: 999 });
      expect(floor.result.isError).toBe(true);
      expect(floor.entries).toBeUndefined();
    });

    it('joins every bound that applied into one notice', async () => {
      const { structured } = await call({
        domains: names(12),
        resolvers: ['8.8.8.8', '8.8.4.4', '1.1.1.1', '1.0.0.1', '9.9.9.9', '149.112.112.112'],
        timeout_ms: 10001,
      });
      expect(structured.notice).toBe(
        'Only the first 10 of 12 domains were queried (10 per call); resend the 2 in deferred_domains in another call. ' +
          'Only the first 5 of 6 resolvers were queried (5 per call); resend the 1 in deferred_resolvers in another call. ' +
          'timeout_ms 10001 is past the maximum of 10000; 10000 was used.',
      );
    });

    it('serves a call at every cap unchanged, with empty deferred lists and no notice', async () => {
      const resolvers = ['8.8.8.8', '8.8.4.4', '1.1.1.1', '1.0.0.1', '9.9.9.9'];
      const {
        result,
        structured,
        entries,
        resolvers: queried,
        timeout,
        text,
      } = await call({
        domains: names(10),
        resolvers,
        timeout_ms: 10000,
      });

      expect(result.isError).toBeFalsy();
      expect(entries).toHaveLength(10);
      expect(queried).toEqual(resolvers);
      expect(timeout).toBe(10000);
      expect(structured.results.map((r) => r.domain)).toEqual(names(10));
      expect(structured).not.toHaveProperty('notice');
      expect(text).not.toContain('per call');
      expect(text).not.toContain('Deferred');
      expect(structured.deferred_domains).toEqual([]);
      expect(structured.deferred_resolvers).toEqual([]);
    });

    it('renders both deferred lists in content[]', () => {
      const text = (
        devopsCheckDns.format!({
          results: [CLEAN_DNS_RESULT],
          deferred_domains: ['later.example.com'],
          deferred_resolvers: ['8.8.4.4'],
        })[0] as { text: string }
      ).text;
      expect(text).toContain('**Deferred domains (not queried):** later.example.com');
      expect(text).toContain('**Deferred resolvers (not queried):** 8.8.4.4');
    });

    it('states the caps in the input descriptions', () => {
      const { domains, resolvers, record_types, timeout_ms } = devopsCheckDns.input.shape;
      expect(domains.description).toContain('deferred_domains');
      expect(domains.description).toContain('up to 100 are accepted');
      expect(resolvers.description).toContain('deferred_resolvers');
      expect(resolvers.description).toContain('queried once');
      expect(resolvers.description).toContain(
        'The first 5 distinct resolvers are queried; up to 20 entries are accepted',
      );
      expect(record_types.description).toContain('queried once');
      expect(timeout_ms.description).toContain('a value over 10000 is served as 10000');
    });
  });

  /**
   * TXT and CAA values are whatever the named domain publishes, so content[] renders them
   * the way it renders vendor text: one line each, `<` and entity-starting `&` escaped.
   * structuredContent keeps them exactly as resolved (#75).
   */
  describe('record values in content[] (#75)', () => {
    const MARKUP_DOMAIN = '[text](https://example.com) <b>';
    const MARKUP_LINE_BREAK = 'v=spf1 &amp; ok\n# not a heading';
    const MARKUP_RESOLVER = '<img src=x> &#60;';
    const MARKUP_RESULT: DnsResult = {
      domain: 'markup.example.com',
      records: { TXT: [MARKUP_DOMAIN, MARKUP_LINE_BREAK] },
      records_source: '8.8.8.8',
      resolver_results: [
        {
          resolver: '8.8.8.8',
          latency_ms: 20,
          records: {},
          records_same_as_domain: ['TXT'],
          status: 'ok',
          status_by_type: { TXT: 'ok' },
          error: null,
        },
        {
          resolver: '1.1.1.1',
          latency_ms: 21,
          records: { TXT: [MARKUP_RESOLVER] },
          records_same_as_domain: [],
          status: 'ok',
          status_by_type: { TXT: 'ok' },
          error: null,
        },
      ],
      propagation_discrepancies: [
        {
          record_type: 'TXT',
          resolvers_agree: false,
          kind: 'value_variation',
          values_by_resolver: {
            '8.8.8.8': [MARKUP_DOMAIN, MARKUP_LINE_BREAK],
            '1.1.1.1': [MARKUP_RESOLVER],
          },
          status_by_resolver: { '8.8.8.8': 'ok', '1.1.1.1': 'ok' },
        },
      ],
      flags: [],
      error: null,
    };

    it('escapes record values on every content[] line and keeps structuredContent as resolved', async () => {
      const { _mockCheckDomains } = (await import('@/services/dns/dns-service.js')) as unknown as {
        _mockCheckDomains: ReturnType<typeof vi.fn>;
      };
      _mockCheckDomains.mockResolvedValue([MARKUP_RESULT]);

      const result = await runToolContract(devopsCheckDns, {
        domains: ['markup.example.com'],
        record_types: ['TXT'],
        resolvers: ['8.8.8.8', '1.1.1.1'],
      });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as { results: DnsResult[] };
      expect(structured.results[0]!.records).toEqual(MARKUP_RESULT.records);
      expect(structured.results[0]!.resolver_results[1]!.records).toEqual({
        TXT: [MARKUP_RESOLVER],
      });
      expect(structured.results[0]!.propagation_discrepancies[0]!.values_by_resolver).toEqual(
        MARKUP_RESULT.propagation_discrepancies[0]!.values_by_resolver,
      );

      const lines = result.content
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('\n')
        .split('\n');
      const domainValues =
        '[text](https://example.com) &lt;b>, v=spf1 &amp;amp; ok # not a heading';
      const resolverValues = '&lt;img src=x> &amp;#60;';
      expect(lines).toContain(`- TXT: ${domainValues}`);
      expect(lines).toContain(`  - TXT: ok → ${resolverValues}`);
      expect(lines).toContain(`  - 8.8.8.8 (ok): ${domainValues}`);
      expect(lines).toContain(`  - 1.1.1.1 (ok): ${resolverValues}`);
      // No value opens a line of its own or carries raw markup.
      expect(lines).not.toContain('# not a heading');
      expect(lines.some((l) => l.includes('<b>') || l.includes('<img'))).toBe(false);
    });
  });
});
