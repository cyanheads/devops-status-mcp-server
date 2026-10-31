/**
 * @fileoverview Tests for the devops_check_dns tool.
 * @module tests/mcp-server/tools/definitions/devops-check-dns.tool.test
 */

import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import MarkdownIt from 'markdown-it';
import { describe, expect, it, vi } from 'vitest';
import { devopsCheckDns } from '@/mcp-server/tools/definitions/devops-check-dns.tool.js';
import type { DnsResult } from '@/services/dns/dns-service.js';

/** A CommonMark parser with raw HTML on, as a GFM client parses content[]. */
const commonMark = new MarkdownIt('default', { html: true });

/**
 * The whole content[] text parsed once and read back one source line at a time: text as a
 * reader gets it, every other node named in place (`⟨code_inline:…⟩`, `⟨strong⟩…⟨/strong⟩`,
 * `⟨em⟩`, `⟨html_inline:…⟩`), so an expectation written as text and spans fails on any live
 * syntax. A list item reads without its marker.
 */
function readLines(text: string): string[] {
  const lines: string[] = [];
  for (const token of commonMark.parse(text, {})) {
    if (token.type !== 'inline') continue;
    let line = '';
    for (const child of token.children ?? []) {
      if (child.type === 'softbreak' || child.type === 'hardbreak') {
        lines.push(line);
        line = '';
      } else if (child.type === 'text' || child.type === 'text_special') line += child.content;
      else if (child.nesting === 1) line += `⟨${child.tag}⟩`;
      else if (child.nesting === -1) line += `⟨/${child.tag}⟩`;
      else line += `⟨${child.type}:${child.content}⟩`;
    }
    lines.push(line);
  }
  return lines;
}

/** content[] of a tool result as one string. */
const contentText = (content: Array<{ type: string; text?: string }>) =>
  content.map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('\n');

/** A value that reads back byte-identical as its own code span. */
const exact = (value: string): [sent: string, readBack: string] => [
  value,
  `⟨code_inline:${value}⟩`,
];

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

/** An entry rejected before any resolver was queried: an IP address passed as a domain. */
const REJECTED_DNS_RESULT: DnsResult = {
  domain: '10.0.0.1',
  records: {},
  records_source: null,
  resolver_results: [],
  propagation_discrepancies: [],
  flags: [],
  error: '"10.0.0.1" is an IP address — DNS records are looked up by domain name, not by address.',
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
    expect(text).toContain('A: ok → `5.6.7.8`');
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
      '"10.0.0.1" is an IP address — DNS records are looked up by domain name, not by address. Pass a domain name ("example.com"); a URL or a host:port is reduced to its host.';
    const text = (
      devopsCheckDns.format!({
        ...NOTHING_DEFERRED,
        results: [{ ...REJECTED_DNS_RESULT, error: message }],
      })[0] as { text: string }
    ).text;

    expect(text).toContain('### ❌ `10.0.0.1`');
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
      expect(text).toContain('- CAA: `0 issue "letsencrypt.org"`, `0 issuewild "digicert.com"`');
      expect(text).toContain(
        '- SOA: `ns1.example.net hostmaster.example.net 2026101401 43200 7200 1209600 3600`',
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
      expect(text).toContain('**Deferred domains (not queried):** `later.example.com`');
      expect(text).toContain('**Deferred resolvers (not queried):** `8.8.4.4`');
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
   * Record values are whatever the queried domain publishes, so content[] renders each one as
   * its own code span that a CommonMark parse reads back as resolved, joined with ", " outside
   * the spans. structuredContent keeps them exactly as resolved (#75).
   */
  describe('record values in content[] (#75)', () => {
    /** Each value as resolved, and what its slot in a content[] line reads back as. */
    const VALUES: Array<[sent: string, readBack: string]> = [
      exact('*literal* _under_ [text](https://example.com) <b>x</b>'),
      exact('a `tick` and ``two`` inside'),
      exact('```'),
      exact('`'),
      exact('&amp; &#60; &copy; & bare'),
      exact('a\\.b\\\\c\\032d.example.com'),
      exact('0 iodef "mailto:a\\"b@example.com"'),
      exact('v=spf1 include:_spf.example.com ~all, second'),
      exact(' leading'),
      exact('trailing '),
      exact(' both '),
      exact('  two each  '),
      exact('   '),
      exact('tab\tinside'),
      ['line\nbreak', '⟨code_inline:line break⟩'],
      ['crlf\r\n\r\nbreaks', '⟨code_inline:crlf breaks⟩'],
      // CommonMark replaces NUL on input, under any renderer.
      ['nul\u0000byte', '⟨code_inline:nul�byte⟩'],
      ['', '(empty)'],
    ];
    const DOMAIN_VALUES = VALUES.map(([sent]) => sent);
    const RESOLVER_VALUES = [...DOMAIN_VALUES].reverse();
    const readBackOf = (values: Array<[string, string]>) => values.map(([, r]) => r).join(', ');
    const DOMAIN_READ_BACK = readBackOf(VALUES);
    const RESOLVER_READ_BACK = readBackOf([...VALUES].reverse());

    const VALUES_RESULT: DnsResult = {
      domain: 'markup.example.com',
      records: { TXT: DOMAIN_VALUES },
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
          records: { TXT: RESOLVER_VALUES },
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
          values_by_resolver: { '8.8.8.8': DOMAIN_VALUES, '1.1.1.1': RESOLVER_VALUES },
          status_by_resolver: { '8.8.8.8': 'ok', '1.1.1.1': 'ok' },
        },
      ],
      flags: [],
      error: null,
    };

    async function serve(results: DnsResult[]) {
      const { _mockCheckDomains } = (await import('@/services/dns/dns-service.js')) as unknown as {
        _mockCheckDomains: ReturnType<typeof vi.fn>;
      };
      _mockCheckDomains.mockReset();
      _mockCheckDomains.mockResolvedValue(results);
    }

    it('reads each value back from its own code span on every line, structuredContent as resolved', async () => {
      await serve([VALUES_RESULT]);
      const result = await runToolContract(devopsCheckDns, {
        domains: ['markup.example.com'],
        record_types: ['TXT'],
        resolvers: ['8.8.8.8', '1.1.1.1'],
      });
      expect(result.isError).toBeFalsy();
      const [row] = (result.structuredContent as { results: DnsResult[] }).results;
      expect(row!.records).toEqual({ TXT: DOMAIN_VALUES });
      expect(row!.resolver_results[1]!.records).toEqual({ TXT: RESOLVER_VALUES });
      expect(row!.propagation_discrepancies[0]!.values_by_resolver).toEqual({
        '8.8.8.8': DOMAIN_VALUES,
        '1.1.1.1': RESOLVER_VALUES,
      });

      const lines = readLines(contentText(result.content));
      expect(lines).toContain(`TXT: ${DOMAIN_READ_BACK}`);
      expect(lines).toContain(`TXT: ok → ${RESOLVER_READ_BACK}`);
      expect(lines).toContain(`8.8.8.8 (ok): ${DOMAIN_READ_BACK}`);
      expect(lines).toContain(`1.1.1.1 (ok): ${RESOLVER_READ_BACK}`);
      // No value opened a line of its own: the agreeing resolver keeps its one sub-line.
      expect(lines).toContain('TXT: ok → same values as the domain-level TXT records above');
    });

    it('renders two TXT values as exactly two spans, a ", " inside one included', async () => {
      const values = ['v=spf1 include:_spf.example.com ~all, second', 'second'];
      await serve([{ ...CLEAN_DNS_RESULT, records: { TXT: values } }]);
      const result = await runToolContract(devopsCheckDns, {
        domains: ['example.com'],
        record_types: ['TXT'],
      });

      const line = readLines(contentText(result.content)).find((l) => l.startsWith('TXT: '));
      expect(line).toBe(
        'TXT: ⟨code_inline:v=spf1 include:_spf.example.com ~all, second⟩, ⟨code_inline:second⟩',
      );
      expect(line!.split('⟨code_inline:')).toHaveLength(3);
    });

    it("reads the caller's own entries back as sent: heading, error, and deferred lists", async () => {
      type Entry =
        | { kind: 'host'; host: string }
        | { kind: 'invalid'; input: string; error: string };
      const { _mockCheckDomains } = (await import('@/services/dns/dns-service.js')) as unknown as {
        _mockCheckDomains: ReturnType<typeof vi.fn>;
      };
      _mockCheckDomains.mockReset();
      _mockCheckDomains.mockImplementation(async (entries: Entry[]) =>
        entries.map((e) =>
          e.kind === 'host'
            ? { ...CLEAN_DNS_RESULT, domain: e.host }
            : { ...REJECTED_DNS_RESULT, domain: e.input, error: e.error },
        ),
      );
      const rejected = '*a* [l](https://e.x) b';
      const deferred = ['*deferred* `x`', ' both ', '[x](y) <b>'];
      const result = await runToolContract(devopsCheckDns, {
        domains: [
          rejected,
          '_x_.example.com',
          ...Array.from({ length: 8 }, (_, i) => `d${i}.example.com`),
          ...deferred,
        ],
        resolvers: ['8.8.8.8', '1.1.1.1', '9.9.9.9', '8.8.4.4', '1.0.0.1', '*r* `x`'],
      });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as {
        results: DnsResult[];
        deferred_domains: string[];
        deferred_resolvers: string[];
      };
      expect(structured.results[0]!.domain).toBe(rejected);
      expect(structured.deferred_domains).toEqual(deferred);
      expect(structured.deferred_resolvers).toEqual(['*r* `x`']);
      const error = structured.results[0]!.error!;
      expect(error).toContain(rejected);

      const lines = readLines(contentText(result.content));
      expect(lines).toContain(`❌ ⟨code_inline:${rejected}⟩`);
      expect(lines).toContain(`⟨strong⟩Error:⟨/strong⟩ ${error}`);
      expect(lines).toContain('✅ ⟨code_inline:_x_.example.com⟩');
      expect(lines).toContain(
        `⟨strong⟩Deferred domains (not queried):⟨/strong⟩ ${deferred.map((d) => `⟨code_inline:${d}⟩`).join(', ')}`,
      );
      expect(lines).toContain(
        '⟨strong⟩Deferred resolvers (not queried):⟨/strong⟩ ⟨code_inline:*r* `x`⟩',
      );
    });

    /**
     * Line breaks are flattened before the span is built, so the pass is timed over the two
     * line-break shapes and a backtick run (the span's fence outgrows it), each in its own
     * thread's CPU time across a 64× span of value lengths.
     */
    it.each([
      ['one long line ending in a break', (n: number) => `${'§1 x'.repeat(n / 4)}\ny`],
      ['line breaks throughout', (n: number) => '  \r\n'.repeat(n / 4)],
      ['one backtick run', (n: number) => '`'.repeat(n)],
    ])('renders a record value in time linear in its length: %s', (_label, build) => {
      const timings = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000].map((size) => {
        const result = {
          ...NOTHING_DEFERRED,
          results: [{ ...CLEAN_DNS_RESULT, records: { TXT: [build(size)] } }],
        };
        devopsCheckDns.format!(result);
        let best = Number.POSITIVE_INFINITY;
        for (let i = 0; i < 3; i++) {
          const start = process.threadCpuUsage();
          devopsCheckDns.format!(result);
          const used = process.threadCpuUsage(start);
          best = Math.min(best, used.user + used.system);
        }
        // Absolute bound at this size, before the next (200 ms of this thread's CPU time).
        expect(best).toBeLessThan(200_000);
        return best;
      });
      // A floor on the smallest run keeps timer granularity from inflating the ratio.
      expect(timings.at(-1)! / Math.max(timings[0]!, 50)).toBeLessThan(256);
    });
  });
});
