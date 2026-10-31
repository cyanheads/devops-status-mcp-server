/**
 * @fileoverview Tests for the DnsService per-resolver outcome typing and propagation analysis.
 * @module tests/services/dns/dns-service.test
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import MarkdownIt from 'markdown-it';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { devopsCheckDns } from '@/mcp-server/tools/definitions/devops-check-dns.tool.js';
import type { DnsQueryStatus, DnsResult, RecordType } from '@/services/dns/dns-service.js';
import { DnsService, getDnsService, initDnsService } from '@/services/dns/dns-service.js';
import { queryRecordTypes, type TypeAnswer } from '@/services/dns/dns-wire-client.js';
import { normalizeDomainInput } from '@/utils/domain-input.js';
import { type FakeDnsServer, RCODE, rdata, reply, startFakeDns, TYPE } from './fake-dns-server.js';

/** Run `checkDomains` the way the tool does: each name normalized, with a live signal. */
function checkNames(
  service: DnsService,
  names: string[],
  types: RecordType[],
  resolvers: string[],
  timeoutMs: number,
  signal = new AbortController().signal,
): Promise<DnsResult[]> {
  const entries = names.map((name) => normalizeDomainInput(name, 'dns'));
  return service.checkDomains(entries, types, resolvers, timeoutMs, signal);
}

/** The "No … records found" flags in a result — absence findings, as opposed to condition flags. */
const noRecordsFlags = (flags: string[]) => flags.filter((f) => /^No .+ records found$/.test(f));

/**
 * content[] as a reader sees it: parsed as CommonMark, with escapes resolved and emphasis
 * reduced to its text, one line per source line of a paragraph, heading, or list item.
 */
function readable(markdown: string): string {
  return new MarkdownIt()
    .parse(markdown, {})
    .filter((token) => token.type === 'inline')
    .map((token) =>
      (token.children ?? [])
        .map((child) => (child.type.endsWith('break') ? '\n' : child.content))
        .join(''),
    )
    .join('\n');
}

/** The text of every content[] block of a tool result, read as CommonMark. */
const readableContent = (content: Array<{ type: string; text?: string }>) =>
  readable(content.map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('\n'));

/**
 * SSRF guard mock — the resolver check is a no-op so the loopback fake resolvers can be queried;
 * guard behavior is tested in ssrf-guard.test.ts. `assertSafeDomain` stays a mock so the #89
 * tests can make it refuse names the DNS check must still answer.
 */
vi.mock('@/utils/ssrf-guard.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/ssrf-guard.js')>()),
  assertSafeDomain: vi.fn().mockResolvedValue(undefined),
  assertSafeUrl: vi.fn().mockResolvedValue(undefined),
  assertSafeResolverIp: vi.fn(),
}));

/**
 * The propagation tests script each resolver's per-type outcome at the wire client's seam; the
 * client's own response-code mapping and parsing are covered in dns-wire-client.test.ts, and the
 * "through the wire client" block below runs the real client against a loopback fake server.
 */
vi.mock('@/services/dns/dns-wire-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/dns/dns-wire-client.js')>()),
  queryRecordTypes: vi.fn((resolver: string, _domain: string, types: RecordType[]) =>
    scriptedAnswers(resolver, types),
  ),
}));

const ok = (...values: string[]): TypeAnswer => ({ status: 'ok', values });
const failed = (status: DnsQueryStatus): TypeAnswer => ({ status, values: [] });

/** Per-resolver-IP script consulted by the mock. Unscripted types fall back to DEFAULT_ANSWERS. */
let dnsScript: Record<string, Partial<Record<RecordType, TypeAnswer>>> = {};

/** Baseline answers when a test does not script a resolver/type. */
const DEFAULT_ANSWERS: Record<RecordType, TypeAnswer> = {
  A: ok('1.2.3.4'),
  AAAA: failed('nodata'),
  CNAME: failed('nodata'),
  MX: ok('10 mail.example.com'),
  TXT: failed('nodata'),
  NS: failed('nodata'),
  CAA: failed('nodata'),
  SOA: failed('nodata'),
};

// Answers are resolved through the module-scoped script at call time, never at factory time.
async function scriptedAnswers(
  resolver: string,
  types: RecordType[],
): Promise<Array<[RecordType, TypeAnswer]>> {
  return types.map((type) => [type, dnsScript[resolver]?.[type] ?? DEFAULT_ANSWERS[type]]);
}

describe('DnsService', () => {
  beforeEach(() => {
    dnsScript = {};
    initDnsService();
  });

  afterEach(() => {
    dnsScript = {};
  });

  it('init/accessor pattern works', () => {
    expect(getDnsService()).toBeDefined();
  });

  it('checkDomains returns one result per domain', async () => {
    const results = await checkNames(getDnsService(), ['example.com'], ['A'], ['8.8.8.8'], 1000);
    expect(results).toHaveLength(1);
    expect(results[0]!.domain).toBe('example.com');
  });

  it('records A and MX records from the mock resolver', async () => {
    const results = await checkNames(
      getDnsService(),
      ['example.com'],
      ['A', 'MX'],
      ['8.8.8.8'],
      1000,
    );
    expect(results[0]!.records.A).toContain('1.2.3.4');
    expect(results[0]!.records.MX).toContain('10 mail.example.com');
    expect(results[0]!.records_source).toBe('8.8.8.8');
  });

  it('reports no discrepancy when both resolvers agree', async () => {
    const results = await checkNames(
      getDnsService(),
      ['agree.example.com'],
      ['A'],
      ['8.8.8.8', '1.1.1.1'],
      1000,
    );
    expect(results[0]!.propagation_discrepancies).toHaveLength(0);
    expect(results[0]!.flags).toHaveLength(0);
  });

  it('handles multiple domains in one call', async () => {
    const results = await checkNames(
      getDnsService(),
      ['a.example.com', 'b.example.com'],
      ['A'],
      ['8.8.8.8'],
      1000,
    );
    expect(results).toHaveLength(2);
    expect(results[0]!.domain).toBe('a.example.com');
    expect(results[1]!.domain).toBe('b.example.com');
  });

  it('flags no-MX when the MX query returns an empty answer', async () => {
    dnsScript = { '8.8.8.8': { MX: failed('nodata') } };
    const results = await checkNames(
      getDnsService(),
      ['no-mx.example.com'],
      ['A', 'MX'],
      ['8.8.8.8'],
      1000,
    );
    expect(results[0]!.flags).toContain('No MX records found');
    expect(results[0]!.resolver_results[0]!.status_by_type.MX).toBe('nodata');
  });

  describe('per-resolver outcome typing', () => {
    it('reports NXDOMAIN distinctly instead of "no records found"', async () => {
      const nxdomain = failed('nxdomain');
      dnsScript = {
        '8.8.8.8': { A: nxdomain, AAAA: nxdomain, MX: nxdomain },
        '1.1.1.1': { A: nxdomain, AAAA: nxdomain, MX: nxdomain },
      };
      const results = await checkNames(
        getDnsService(),
        ['gone.example.com'],
        ['A', 'AAAA', 'MX'],
        ['8.8.8.8', '1.1.1.1'],
        1000,
      );
      const result = results[0]!;

      expect(result.resolver_results[0]!.status).toBe('nxdomain');
      expect(result.resolver_results[0]!.status_by_type.A).toBe('nxdomain');
      expect(result.flags.some((f) => f.startsWith('NXDOMAIN from'))).toBe(true);
      expect(result.flags.some((f) => f.includes('the domain does not exist'))).toBe(true);
      // The domain is gone, not missing a record — the old wording misattributed the cause.
      expect(noRecordsFlags(result.flags)).toEqual([]);
      expect(result.error).toContain('8.8.8.8: NXDOMAIN');
      expect(result.error).toContain('1.1.1.1: NXDOMAIN');
    });

    it('reports SERVFAIL distinctly from NXDOMAIN and names the DNSSEC cause', async () => {
      const servfail = failed('servfail');
      dnsScript = { '8.8.8.8': { A: servfail, AAAA: servfail } };
      const results = await checkNames(
        getDnsService(),
        ['dnssec-broken.example.com'],
        ['A', 'AAAA'],
        ['8.8.8.8'],
        1000,
      );
      const result = results[0]!;

      expect(result.resolver_results[0]!.status).toBe('servfail');
      expect(result.resolver_results[0]!.status_by_type.A).toBe('servfail');
      expect(result.resolver_results[0]!.error).toBe('SERVFAIL on A, AAAA');
      expect(result.flags.some((f) => f.includes('DNSSEC'))).toBe(true);
      expect(noRecordsFlags(result.flags)).toEqual([]);
      expect(result.error).toContain('8.8.8.8: SERVFAIL on A, AAAA');
    });

    it('keeps NODATA silent — the domain exists, the record type does not', async () => {
      dnsScript = { '8.8.8.8': { MX: failed('nodata') } };
      const results = await checkNames(
        getDnsService(),
        ['no-mail.example.com'],
        ['A', 'MX'],
        ['8.8.8.8'],
        1000,
      );
      const result = results[0]!;

      expect(result.resolver_results[0]!.status_by_type.MX).toBe('nodata');
      expect(result.resolver_results[0]!.status).toBe('ok');
      expect(result.resolver_results[0]!.error).toBeNull();
      expect(result.error).toBeNull();
      expect(result.flags).toContain('No MX records found');
      expect(result.flags.some((f) => f.startsWith('NXDOMAIN') || f.startsWith('SERVFAIL'))).toBe(
        false,
      );
    });

    it('reports an empty type as nodata alongside a type that resolves', async () => {
      dnsScript = { '8.8.8.8': { A: ok('140.82.116.4'), AAAA: failed('nodata') } };
      const results = await checkNames(
        getDnsService(),
        ['ipv4-only.example.com'],
        ['A', 'AAAA'],
        ['8.8.8.8'],
        1000,
      );
      const result = results[0]!;

      expect(result.resolver_results[0]!.status_by_type.AAAA).toBe('nodata');
      expect(result.resolver_results[0]!.status).toBe('ok');
      expect(result.resolver_results[0]!.error).toBeNull();
      expect(result.flags.some((f) => f.startsWith('NXDOMAIN'))).toBe(false);
    });

    it('keeps a split outcome across resolvers visible on both sides', async () => {
      dnsScript = {
        '8.8.8.8': { A: failed('servfail') },
        '1.1.1.1': { A: failed('nxdomain') },
      };
      const results = await checkNames(
        getDnsService(),
        ['split.example.com'],
        ['A'],
        ['8.8.8.8', '1.1.1.1'],
        1000,
      );
      const result = results[0]!;

      expect(result.resolver_results[0]!.status).toBe('servfail');
      expect(result.resolver_results[1]!.status).toBe('nxdomain');
      expect(result.flags.some((f) => f.startsWith('SERVFAIL from 8.8.8.8'))).toBe(true);
      expect(result.flags.some((f) => f.startsWith('NXDOMAIN from 1.1.1.1'))).toBe(true);
      expect(result.error).toContain('8.8.8.8: SERVFAIL');
      expect(result.error).toContain('1.1.1.1: NXDOMAIN');
    });

    it('derives the no-records flag from every resolver, not just the primary', async () => {
      dnsScript = {
        '8.8.8.8': { A: failed('servfail'), AAAA: failed('servfail') },
        '1.1.1.1': { A: ok('5.6.7.8') },
      };
      const results = await checkNames(
        getDnsService(),
        ['primary-broken.example.com'],
        ['A', 'AAAA'],
        ['8.8.8.8', '1.1.1.1'],
        1000,
      );
      const result = results[0]!;

      // A resolver did answer, so the domain is not record-less and was not "unqueryable".
      expect(noRecordsFlags(result.flags)).toEqual([]);
      expect(result.records.A).toContain('5.6.7.8');
      expect(result.records_source).toBe('1.1.1.1');
      expect(result.error).toBeNull();
      expect(result.flags.some((f) => f.startsWith('SERVFAIL from 8.8.8.8'))).toBe(true);
    });
  });

  describe('address no-records flag (#80)', () => {
    const RESOLVERS = ['8.8.8.8', '1.1.1.1'];
    const flagsFor = async (types: RecordType[]) =>
      (await checkNames(getDnsService(), ['name.example.com'], types, RESOLVERS, 1000))[0]!.flags;

    it.each([
      ['A', 'No A records found'],
      ['AAAA', 'No AAAA records found'],
    ] as const)(
      'names only %s when that is the only address type asked and it is nodata',
      async (type, flag) => {
        dnsScript = {
          '8.8.8.8': { [type]: failed('nodata') },
          '1.1.1.1': { [type]: failed('nodata') },
        };
        expect(await flagsFor([type])).toEqual([flag]);
      },
    );

    it.each([
      [
        'A',
        'No A records found',
        'TIMEOUT from 8.8.8.8 on A — the resolver did not answer within the timeout',
      ],
      [
        'AAAA',
        'No AAAA records found',
        'TIMEOUT from 8.8.8.8 on AAAA — the resolver did not answer within the timeout',
      ],
    ] as const)(
      'keeps the %s flag beside the timeout flag when another resolver times out',
      async (type, flag, timeout) => {
        dnsScript = {
          '8.8.8.8': { [type]: failed('timeout') },
          '1.1.1.1': { [type]: failed('nodata') },
        };
        expect(await flagsFor([type])).toEqual([flag, timeout]);
      },
    );

    it.each([[['A', 'AAAA']], [['AAAA', 'A']]] as const)(
      'names both types when %j are both nodata',
      async (types) => {
        dnsScript = {
          '8.8.8.8': { A: failed('nodata'), AAAA: failed('nodata') },
          '1.1.1.1': { A: failed('nodata'), AAAA: failed('nodata') },
        };
        expect(await flagsFor([...types])).toEqual(['No A or AAAA records found']);
      },
    );

    it.each([
      [
        'AAAA servfails everywhere',
        { A: failed('nodata'), AAAA: failed('servfail') },
        [
          'No A records found',
          'SERVFAIL from 8.8.8.8, 1.1.1.1 on AAAA — the resolver could not complete the query — commonly a DNSSEC validation failure or a broken delegation',
        ],
      ],
      [
        'A times out everywhere',
        { A: failed('timeout'), AAAA: failed('nodata') },
        [
          'No AAAA records found',
          'TIMEOUT from 8.8.8.8, 1.1.1.1 on A — the resolver did not answer within the timeout',
        ],
      ],
    ] as const)('leaves a type out of the flag when %s', async (_case, answers, flags) => {
      dnsScript = { '8.8.8.8': answers, '1.1.1.1': answers };
      expect(await flagsFor(['A', 'AAAA'])).toEqual(flags);
    });

    it('raises no address flag when either address type has records', async () => {
      // Every resolver answers A and returns nodata for AAAA.
      expect(noRecordsFlags(await flagsFor(['A', 'AAAA']))).toEqual([]);

      // Only one resolver answers, and only for AAAA.
      dnsScript = {
        '8.8.8.8': { A: failed('nodata'), AAAA: failed('nodata') },
        '1.1.1.1': { A: failed('nodata'), AAAA: ok('2001:db8::1') },
      };
      expect(await flagsFor(['A', 'AAAA'])).toEqual([
        'Partial resolution on AAAA records — 8.8.8.8 (nodata) returned nothing while 1.1.1.1 answered',
      ]);
    });

    it('raises only the timeout flag when every resolver times out on an A-only query', async () => {
      dnsScript = { '8.8.8.8': { A: failed('timeout') }, '1.1.1.1': { A: failed('timeout') } };
      expect(await flagsFor(['A'])).toEqual([
        'TIMEOUT from 8.8.8.8, 1.1.1.1 on A — the resolver did not answer within the timeout',
      ]);
    });

    it('keeps the MX, CNAME, condition, and partial-resolution wording', async () => {
      dnsScript = {
        '8.8.8.8': { A: ok('1.2.3.4'), MX: failed('nodata'), CNAME: ok('target.example.net') },
        '1.1.1.1': { A: failed('servfail'), MX: failed('nodata'), CNAME: ok('target.example.net') },
      };
      expect(await flagsFor(['A', 'MX', 'CNAME'])).toEqual([
        'No MX records found',
        'CNAME detected — further records resolve via the CNAME target',
        'SERVFAIL from 1.1.1.1 on A — the resolver could not complete the query — commonly a DNSSEC validation failure or a broken delegation',
        'Partial resolution on A records — 1.1.1.1 (servfail) returned nothing while 8.8.8.8 answered',
      ]);
    });

    it('reaches both surfaces of devops_check_dns', async () => {
      dnsScript = { '8.8.8.8': { A: failed('nodata') } };
      const result = await runToolContract(devopsCheckDns, {
        domains: ['ipv6-only.example.com'],
        record_types: ['A'],
        resolvers: ['8.8.8.8'],
        timeout_ms: 1000,
      });

      const structured = result.structuredContent as { results: DnsResult[] };
      expect(structured.results[0]!.flags).toEqual(['No A records found']);
      expect(readableContent(result.content).split('\n')).toContain('Flags: No A records found');
    });
  });

  describe('resolver disagreement classification', () => {
    it('classifies differing non-empty answers as value_variation and does not flag them', async () => {
      dnsScript = {
        '8.8.8.8': { A: ok('20.29.134.23') },
        '9.9.9.9': { A: ok('140.82.116.4') },
      };
      const results = await checkNames(
        getDnsService(),
        ['geo-steered.example.com'],
        ['A'],
        ['8.8.8.8', '9.9.9.9'],
        1000,
      );
      const result = results[0]!;

      expect(result.propagation_discrepancies).toHaveLength(1);
      expect(result.propagation_discrepancies[0]!.kind).toBe('value_variation');
      expect(result.propagation_discrepancies[0]!.resolvers_agree).toBe(false);
      expect(result.propagation_discrepancies[0]!.status_by_resolver).toEqual({
        '8.8.8.8': 'ok',
        '9.9.9.9': 'ok',
      });
      // Both edges are healthy — nothing here establishes an in-flight DNS change.
      expect(result.flags).toHaveLength(0);
    });

    it('classifies some-answered/some-empty as partial_resolution and flags it', async () => {
      dnsScript = {
        '8.8.8.8': { A: ok('1.2.3.4') },
        '1.1.1.1': { A: failed('nodata') },
      };
      const results = await checkNames(
        getDnsService(),
        ['mid-propagation.example.com'],
        ['A'],
        ['8.8.8.8', '1.1.1.1'],
        1000,
      );
      const result = results[0]!;

      expect(result.propagation_discrepancies[0]!.kind).toBe('partial_resolution');
      expect(result.propagation_discrepancies[0]!.status_by_resolver['1.1.1.1']).toBe('nodata');
      expect(result.propagation_discrepancies[0]!.values_by_resolver['1.1.1.1']).toEqual([]);
      expect(
        result.flags.some(
          (f) => f.startsWith('Partial resolution on A records') && f.includes('1.1.1.1 (nodata)'),
        ),
      ).toBe(true);
    });

    it('classifies an errored resolver alongside an answering one as partial_resolution', async () => {
      dnsScript = {
        '8.8.8.8': { A: ok('1.2.3.4') },
        '1.1.1.1': { A: failed('servfail') },
      };
      const results = await checkNames(
        getDnsService(),
        ['one-broken-resolver.example.com'],
        ['A'],
        ['8.8.8.8', '1.1.1.1'],
        1000,
      );
      const result = results[0]!;

      expect(result.propagation_discrepancies[0]!.kind).toBe('partial_resolution');
      expect(result.propagation_discrepancies[0]!.status_by_resolver['1.1.1.1']).toBe('servfail');
      expect(result.flags.some((f) => f.includes('1.1.1.1 (servfail)'))).toBe(true);
    });
  });

  describe('per-resolver record elision (#41)', () => {
    it('elides an agreeing resolver record set and names the type instead', async () => {
      dnsScript = {
        '8.8.8.8': { A: ok('1.2.3.4'), TXT: ok('v=spf1 -all') },
        '1.1.1.1': { A: ok('1.2.3.4'), TXT: ok('v=spf1 -all') },
      };
      const results = await checkNames(
        getDnsService(),
        ['agree.example.com'],
        ['A', 'TXT'],
        ['8.8.8.8', '1.1.1.1'],
        1000,
      );
      const result = results[0]!;

      // The domain-level set still carries every value — nothing was lost.
      expect(result.records.A).toEqual(['1.2.3.4']);
      expect(result.records.TXT).toEqual(['v=spf1 -all']);
      for (const rr of result.resolver_results) {
        expect(rr.records).toEqual({});
        expect(rr.records_same_as_domain).toEqual(['A', 'TXT']);
      }
    });

    it('keeps a divergent record set in full while eliding the agreeing type', async () => {
      dnsScript = {
        '8.8.8.8': { A: ok('1.2.3.4'), TXT: ok('v=spf1 -all') },
        '9.9.9.9': { A: ok('5.6.7.8'), TXT: ok('v=spf1 -all') },
      };
      const results = await checkNames(
        getDnsService(),
        ['steered.example.com'],
        ['A', 'TXT'],
        ['8.8.8.8', '9.9.9.9'],
        1000,
      );
      const result = results[0]!;

      expect(result.resolver_results[0]!.records_same_as_domain).toEqual(['A', 'TXT']);
      expect(result.resolver_results[1]!.records).toEqual({ A: ['5.6.7.8'] });
      expect(result.resolver_results[1]!.records_same_as_domain).toEqual(['TXT']);
      // The disagreement itself is still reported with both sides' values.
      expect(result.propagation_discrepancies[0]!.values_by_resolver).toEqual({
        '8.8.8.8': ['1.2.3.4'],
        '9.9.9.9': ['5.6.7.8'],
      });
    });

    it('leaves a type absent from both maps when the resolver returned nothing', async () => {
      dnsScript = {
        '8.8.8.8': { A: ok('1.2.3.4') },
        '1.1.1.1': { A: failed('nodata') },
      };
      const results = await checkNames(
        getDnsService(),
        ['half.example.com'],
        ['A'],
        ['8.8.8.8', '1.1.1.1'],
        1000,
      );
      const empty = results[0]!.resolver_results[1]!;

      expect(empty.records.A).toBeUndefined();
      expect(empty.records_same_as_domain).toEqual([]);
      // Absence is explained rather than ambiguous.
      expect(empty.status_by_type.A).toBe('nodata');
    });

    it('does not elide against a same-length set with different values', async () => {
      dnsScript = {
        '8.8.8.8': { A: ok('1.2.3.4', '5.6.7.8') },
        '1.1.1.1': { A: ok('1.2.3.4', '9.9.9.9') },
      };
      const results = await checkNames(
        getDnsService(),
        ['partial-overlap.example.com'],
        ['A'],
        ['8.8.8.8', '1.1.1.1'],
        1000,
      );

      expect(results[0]!.resolver_results[1]!.records.A).toEqual(['1.2.3.4', '9.9.9.9']);
      expect(results[0]!.resolver_results[1]!.records_same_as_domain).toEqual([]);
    });
  });

  describe('a domain whose address is private (#89)', () => {
    it('queries names the domain guard refuses, since nothing connects to the domain', async () => {
      const { assertSafeDomain } = await import('@/utils/ssrf-guard.js');
      const actual =
        await vi.importActual<typeof import('@/utils/ssrf-guard.js')>('@/utils/ssrf-guard.js');
      const names = ['localhost'];
      // The real guard refuses it by name, before any lookup.
      for (const name of names) {
        await expect(actual.assertSafeDomain(name)).rejects.toThrow('names a known internal host');
      }
      vi.mocked(assertSafeDomain).mockImplementation(actual.assertSafeDomain);
      dnsScript = { '8.8.8.8': { A: ok('127.0.0.1') } };
      try {
        const results = await checkNames(new DnsService(), names, ['A'], ['8.8.8.8'], 1000);

        expect(results.map((r) => [r.domain, r.error, r.records])).toEqual([
          ['localhost', null, { A: ['127.0.0.1'] }],
        ]);
      } finally {
        vi.mocked(assertSafeDomain).mockReset();
        vi.mocked(assertSafeDomain).mockResolvedValue(undefined);
      }
    });
  });

  describe('a domain rejected before any query (#45)', () => {
    const INVALID_SENTENCE =
      '"user@example.com" has a user name before "@", so it reads as an email address or a credential rather than a host. Pass a domain name ("example.com"); a URL or a host:port is reduced to its host.';

    it('renders the failure once through devops_check_dns', async () => {
      const result = await runToolContract(devopsCheckDns, {
        domains: ['user@example.com'],
        record_types: ['A'],
        timeout_ms: 1000,
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as { results: DnsResult[] };
      expect(structured.results[0]!.flags).toEqual([]);
      expect(structured.results[0]!.error).toBe(INVALID_SENTENCE);

      const text = readableContent(result.content);
      expect(text.split(INVALID_SENTENCE)).toHaveLength(2);
      expect(text).not.toContain('Flags:');
      expect(text).not.toContain('Resolver results:');
    });

    it('queries the default resolvers and record types for empty arrays (#48)', async () => {
      const result = await runToolContract(devopsCheckDns, {
        domains: ['example.com'],
        resolvers: [],
        record_types: [],
        timeout_ms: 1000,
      });

      const [r] = (result.structuredContent as { results: DnsResult[] }).results;
      expect(r!.resolver_results.map((rr) => rr.resolver)).toEqual([
        '8.8.8.8',
        '1.1.1.1',
        '9.9.9.9',
      ]);
      expect(Object.keys(r!.resolver_results[0]!.status_by_type).sort()).toEqual([
        'A',
        'AAAA',
        'MX',
        'TXT',
      ]);
      expect(r!.records.A).toEqual(['1.2.3.4']);
    });

    it('still pairs the all-resolvers-failed error with its explanatory flag (#31)', async () => {
      const nxdomain = failed('nxdomain');
      dnsScript = { '8.8.8.8': { A: nxdomain }, '1.1.1.1': { A: nxdomain } };
      const result = await runToolContract(devopsCheckDns, {
        domains: ['gone.example.com'],
        record_types: ['A'],
        resolvers: ['8.8.8.8', '1.1.1.1'],
        timeout_ms: 1000,
      });

      const structured = result.structuredContent as { results: DnsResult[] };
      expect(structured.results[0]!.error).toBe('8.8.8.8: NXDOMAIN on A; 1.1.1.1: NXDOMAIN on A');
      expect(structured.results[0]!.flags).toEqual([
        'NXDOMAIN from 8.8.8.8, 1.1.1.1 on A — the domain does not exist — check for a typo, an expired registration, or a missing delegation',
      ]);
      const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      expect(text).toContain('**Flags:** NXDOMAIN from 8.8.8.8, 1.1.1.1 on A');
      expect(text).toContain('**Resolver results:**');
    });
  });
});

/**
 * The service end to end over the real wire client, against a loopback resolver that answers
 * the way a public one does: NOERROR with no answer for a type the name lacks, NXDOMAIN for a
 * name that does not exist, and a truncated UDP reply when the answer is too large.
 *
 * The timing cases fake only `setTimeout`/`clearTimeout`, which carry the `timeout_ms` deadline
 * and the UDP resend; the sockets stay real, so a check settles on its own I/O or at the exact
 * deadline step, never on how fast the machine is.
 */
describe('DnsService through the wire client (#64, #70)', () => {
  let server: FakeDnsServer | undefined;
  let second: FakeDnsServer | undefined;
  const fakeDeadline = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  /** Waits on real I/O (node:timers/promises is never faked) until `condition` holds. */
  async function until(condition: () => boolean) {
    while (!condition()) await sleep(5);
  }

  /** Whether `promise` has settled, read without awaiting it. */
  function track(promise: Promise<unknown>) {
    const state = { settled: false };
    promise.then(
      () => {
        state.settled = true;
      },
      () => {
        state.settled = true;
      },
    );
    return state;
  }

  /** Move the fake clock, then let every continuation it released run. */
  async function advance(ms: number) {
    await vi.advanceTimersByTimeAsync(ms);
    await sleep(0);
  }

  beforeEach(async () => {
    initDnsService();
    const actual = await vi.importActual<typeof import('@/services/dns/dns-wire-client.js')>(
      '@/services/dns/dns-wire-client.js',
    );
    vi.mocked(queryRecordTypes).mockImplementation(actual.queryRecordTypes);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.mocked(queryRecordTypes).mockImplementation((resolver, _domain, types) =>
      scriptedAnswers(resolver, types),
    );
    await Promise.all([server?.close(), second?.close()]);
    server = undefined;
    second = undefined;
  });

  const SPF = [
    'v=spf1 ip4:192.0.2.0/24 include:spf.protection.example include:_netblocks.example ip4:62.253.2',
    '27.114 ip4:166.78.69.169 ~all',
  ];

  /** example.com: A only, plus a TXT set too large for UDP. _domainkey.example.com: no records. */
  async function serveZone(): Promise<FakeDnsServer> {
    server = await startFakeDns({
      udp: (q) => {
        if (q.name === 'example.com' && q.qtype === TYPE.TXT) return reply(q, { truncated: true });
        return answerZone(q);
      },
      tcp: answerZone,
    });
    return server;
  }

  function answerZone(q: Parameters<typeof reply>[0]): Buffer {
    if (q.name === '_domainkey.example.com') return reply(q);
    if (q.name !== 'example.com') return reply(q, { rcode: RCODE.NXDOMAIN });
    if (q.qtype === TYPE.A)
      return reply(q, { answers: [{ type: TYPE.A, rdata: rdata.a('192.0.2.1') }] });
    if (q.qtype === TYPE.TXT) {
      return reply(q, {
        answers: [
          { type: TYPE.TXT, rdata: rdata.txt(...SPF) },
          { type: TYPE.TXT, rdata: rdata.txt('google-site-verification=abc') },
        ],
      });
    }
    return reply(q);
  }

  it('reports a missing record type as nodata when it is the only type asked', async () => {
    const s = await serveZone();
    const [result] = await checkNames(
      getDnsService(),
      ['example.com'],
      ['AAAA'],
      [s.address],
      1000,
    );

    expect(result!.resolver_results[0]!.status_by_type.AAAA).toBe('nodata');
    expect(result!.resolver_results[0]!.status).toBe('nodata');
    expect(result!.resolver_results[0]!.error).toBeNull();
    expect(result!.error).toBeNull();
    expect(result!.flags.some((f) => f.startsWith('NXDOMAIN'))).toBe(false);
  });

  it('reports a name with no records of any type as nodata, not nxdomain', async () => {
    const s = await serveZone();
    const [result] = await checkNames(
      getDnsService(),
      ['_domainkey.example.com'],
      ['A', 'AAAA', 'TXT'],
      [s.address],
      1000,
    );

    expect(result!.resolver_results[0]!.status_by_type).toEqual({
      A: 'nodata',
      AAAA: 'nodata',
      TXT: 'nodata',
    });
    expect(result!.error).toBeNull();
    expect(result!.flags).toEqual(['No A or AAAA records found']);
  });

  it('reports a nonexistent name as nxdomain', async () => {
    const s = await serveZone();
    const [result] = await checkNames(
      getDnsService(),
      ['missing.example.com'],
      ['A'],
      [s.address],
      1000,
    );

    expect(result!.resolver_results[0]!.status).toBe('nxdomain');
    expect(result!.error).toBe(`${s.address}: NXDOMAIN on A`);
  });

  it('returns a multi-string TXT record whole after the TCP retry', async () => {
    const s = await serveZone();
    const [result] = await checkNames(getDnsService(), ['example.com'], ['TXT'], [s.address], 1000);

    expect(result!.records.TXT).toEqual([
      'google-site-verification=abc',
      'v=spf1 ip4:192.0.2.0/24 include:spf.protection.example include:_netblocks.example ip4:62.253.227.114 ip4:166.78.69.169 ~all',
    ]);
    expect(s.received.filter((r) => r.qtype === TYPE.TXT).map((r) => r.transport)).toEqual([
      'udp',
      'tcp',
    ]);
  });

  it('holds a silent resolver to timeout_ms for the domain+resolver pair', async () => {
    const s = await startFakeDns({ udp: () => null });
    server = s;
    fakeDeadline();
    const pending = checkNames(
      getDnsService(),
      ['example.com'],
      ['A', 'AAAA', 'MX', 'TXT'],
      [s.address],
      1000,
    );
    const state = track(pending);
    // Every type's first query reached the resolver, so the check is parked on the replies.
    await until(() => s.received.length === 4);

    await advance(999);
    expect(state.settled).toBe(false);
    await advance(1);
    expect(state.settled).toBe(true);
    const [result] = await pending;
    expect(result!.resolver_results[0]!.status).toBe('timeout');
    expect(result!.resolver_results[0]!.error).toBe('TIMEOUT on A, AAAA, MX, TXT');
  });

  it('reports a malformed reply as an error for that type, not a failed row', async () => {
    server = await startFakeDns({
      udp: (q) =>
        q.qtype === TYPE.A
          ? reply(q, { answers: [{ type: TYPE.A, rdata: Buffer.from([192, 0, 2]) }] })
          : reply(q, { answers: [{ type: TYPE.MX, rdata: rdata.mx(10, 'mail.example.com') }] }),
    });
    const [result] = await checkNames(
      getDnsService(),
      ['example.com'],
      ['A', 'MX'],
      [server.address],
      1000,
    );

    expect(result!.records.MX).toEqual(['10 mail.example.com']);
    expect(result!.resolver_results[0]!.status_by_type.A).toBe('error');
    expect(result!.resolver_results[0]!.error).toBe(
      'ERROR on A (malformed response: an A record is not 4 bytes)',
    );
    expect(result!.error).toBeNull();
  });

  it('answers names whose public records are private addresses, on both surfaces (#89)', async () => {
    const s = await startFakeDns({
      udp: (q) => {
        if (q.name === '10.0.0.1.nip.io' && q.qtype === TYPE.A) {
          return reply(q, { answers: [{ type: TYPE.A, rdata: rdata.a('10.0.0.1') }] });
        }
        if (q.name === 'localtest.me' && q.qtype === TYPE.A) {
          return reply(q, { answers: [{ type: TYPE.A, rdata: rdata.a('127.0.0.1') }] });
        }
        if (q.name === 'localtest.me' && q.qtype === TYPE.AAAA) {
          const loopback = rdata.aaaa([0, 0, 0, 0, 0, 0, 0, 1]);
          return reply(q, { answers: [{ type: TYPE.AAAA, rdata: loopback }] });
        }
        return reply(q);
      },
    });
    server = s;
    const { assertSafeDomain } = await import('@/utils/ssrf-guard.js');
    // The domain guard's refusal when the host's resolver answers these names privately.
    vi.mocked(assertSafeDomain).mockImplementation(async (domain) => {
      throw new Error(
        `SSRF_BLOCKED: Domain "${domain}" resolves to a non-public address. Requests to private, loopback, or cloud-metadata addresses are not permitted.`,
      );
    });
    try {
      const result = await runToolContract(devopsCheckDns, {
        domains: ['10.0.0.1.nip.io', 'localtest.me'],
        record_types: ['A', 'AAAA'],
        resolvers: [s.address],
        timeout_ms: 1000,
      });

      expect(result.isError).toBeFalsy();
      const { results } = result.structuredContent as { results: DnsResult[] };
      expect(results.map((r) => [r.domain, r.error, r.records])).toEqual([
        ['10.0.0.1.nip.io', null, { A: ['10.0.0.1'] }],
        ['localtest.me', null, { A: ['127.0.0.1'], AAAA: ['::1'] }],
      ]);
      const lines = readableContent(result.content).split('\n');
      expect(lines).toEqual(expect.arrayContaining(['A: 10.0.0.1', 'A: 127.0.0.1', 'AAAA: ::1']));
      expect(lines.filter((l) => l.includes('resolves to'))).toEqual([]);
      expect(new Set(s.received.map((q) => q.name))).toEqual(
        new Set(['10.0.0.1.nip.io', 'localtest.me']),
      );
    } finally {
      vi.mocked(assertSafeDomain).mockReset();
      vi.mocked(assertSafeDomain).mockResolvedValue(undefined);
    }
  });

  it('rejects a hostname resolver without resolving it, even with private targets allowed', async () => {
    // The guard is mocked to a no-op here — the state it is in when private targets are allowed.
    await expect(
      checkNames(getDnsService(), ['example.com'], ['A'], ['dns.google'], 1000),
    ).rejects.toMatchObject({ data: { reason: 'target_blocked' } });

    const result = await runToolContract(devopsCheckDns, {
      domains: ['example.com'],
      resolvers: ['dns.google'],
      timeout_ms: 1000,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'target_blocked',
          recovery: { hint: expect.stringContaining('pass an address rather than a hostname') },
        },
      },
    });
  });

  /** A zone apex answering SOA with `serial` and CAA with `caa`, in the order given. */
  function apex(serial: number, caa: string[]) {
    return startFakeDns({
      udp: (q) => {
        if (q.name !== 'example.com') return reply(q, { rcode: RCODE.NXDOMAIN });
        if (q.qtype === TYPE.SOA) {
          const soa = rdata.soa(
            'ns1.example.net',
            'hostmaster.example.net',
            serial,
            43200,
            7200,
            1209600,
            3600,
          );
          return reply(q, { answers: [{ type: TYPE.SOA, rdata: soa }] });
        }
        if (q.qtype === TYPE.CAA) {
          return reply(q, {
            answers: caa.map((v) => {
              const [tag = '', value = ''] = v.split(' ');
              return { type: TYPE.CAA, rdata: rdata.caa(0, tag, value) };
            }),
          });
        }
        return reply(q);
      },
    });
  }

  it('reports SOAs differing only in serial as a value_variation, unflagged (#70)', async () => {
    server = await apex(2026101401, ['issue letsencrypt.org']);
    second = await apex(2026101400, ['issue letsencrypt.org']);
    const [result] = await checkNames(
      getDnsService(),
      ['example.com'],
      ['SOA'],
      [server.address, second.address],
      1000,
    );

    expect(result!.propagation_discrepancies).toEqual([
      {
        record_type: 'SOA',
        resolvers_agree: false,
        kind: 'value_variation',
        values_by_resolver: {
          [server.address]: [
            'ns1.example.net hostmaster.example.net 2026101401 43200 7200 1209600 3600',
          ],
          [second.address]: [
            'ns1.example.net hostmaster.example.net 2026101400 43200 7200 1209600 3600',
          ],
        },
        status_by_resolver: { [server.address]: 'ok', [second.address]: 'ok' },
      },
    ]);
    expect(result!.flags).toEqual([]);
  });

  it('sorts CAA values so resolvers returning them in another order agree (#70)', async () => {
    const set = ['issuewild digicert.com', 'issue letsencrypt.org', 'issue digicert.com'];
    server = await apex(1, set);
    second = await apex(1, [...set].reverse());
    const [result] = await checkNames(
      getDnsService(),
      ['example.com'],
      ['CAA'],
      [server.address, second.address],
      1000,
    );

    expect(result!.records.CAA).toEqual([
      '0 issue "digicert.com"',
      '0 issue "letsencrypt.org"',
      '0 issuewild "digicert.com"',
    ]);
    expect(result!.propagation_discrepancies).toEqual([]);
    expect(result!.resolver_results[1]!.records_same_as_domain).toEqual(['CAA']);
  });

  it('reports CAA and SOA below the apex as nodata on every resolver, and a missing name as nxdomain (#70)', async () => {
    server = await startFakeDns({
      udp: (q) => (q.name === 'api.example.com' ? reply(q) : reply(q, { rcode: RCODE.NXDOMAIN })),
    });
    second = await startFakeDns({
      udp: (q) => (q.name === 'api.example.com' ? reply(q) : reply(q, { rcode: RCODE.NXDOMAIN })),
    });
    const [below, missing] = await checkNames(
      getDnsService(),
      ['api.example.com', 'missing.example.com'],
      ['CAA', 'SOA'],
      [server.address, second.address],
      1000,
    );

    for (const rr of below!.resolver_results) {
      expect(rr.status_by_type).toEqual({ CAA: 'nodata', SOA: 'nodata' });
      expect(rr.error).toBeNull();
    }
    expect(below!.error).toBeNull();
    expect(below!.flags).toEqual([]);
    expect(missing!.resolver_results.map((rr) => rr.status_by_type.CAA)).toEqual([
      'nxdomain',
      'nxdomain',
    ]);
  });

  it('fails a name that cannot be encoded in its own row', async () => {
    const s = await serveZone();
    const results = await checkNames(
      getDnsService(),
      ['a..example.com', 'example.com'],
      ['A'],
      [s.address],
      1000,
    );

    expect(results[0]!.domain).toBe('a..example.com');
    expect(results[0]!.error).toContain('"a..example.com" is not a valid host name');
    expect(results[0]!.resolver_results).toEqual([]);
    expect(results[1]!.records.A).toEqual(['192.0.2.1']);
    expect(s.received.every((r) => r.name === 'example.com')).toBe(true);
  });

  it('rejects the whole call when the caller cancels mid-query, rather than reporting timeouts', async () => {
    const s = await startFakeDns({ udp: () => null });
    server = s;
    fakeDeadline();
    const caller = new AbortController();
    const reason = new Error('caller went away');
    const pending = checkNames(
      getDnsService(),
      ['example.com', 'not a name'],
      ['A', 'MX'],
      [s.address],
      2000,
      caller.signal,
    );
    await until(() => s.received.length === 2);
    caller.abort(reason);

    // The deadline never fires here, so only the abort can settle the call.
    await expect(pending).rejects.toBe(reason);
  });

  it('reaches devops_check_dns as a cancelled call, never a result', async () => {
    server = await startFakeDns({ udp: () => null });
    const controller = new AbortController();
    const ctx = createMockContext({ errors: devopsCheckDns.errors, signal: controller.signal });
    const input = devopsCheckDns.input.parse({
      domains: ['example.com'],
      record_types: ['A'],
      resolvers: [server.address],
      timeout_ms: 2000,
    });
    setTimeout(() => controller.abort(), 100);

    await expect(devopsCheckDns.handler(input, ctx)).rejects.toMatchObject({ name: 'AbortError' });
  });

  describe('domains entries through devops_check_dns (#68)', () => {
    /** example.com: A and TXT. _dmarc.example.com: TXT. xn--mnchen-3ya.de: A. Else NXDOMAIN. */
    async function serveEntries(): Promise<FakeDnsServer> {
      server = await startFakeDns({
        udp: (q) => {
          if (q.name === 'example.com' && q.qtype === TYPE.A) {
            return reply(q, { answers: [{ type: TYPE.A, rdata: rdata.a('192.0.2.1') }] });
          }
          if (q.name === 'example.com' && q.qtype === TYPE.TXT) {
            return reply(q, { answers: [{ type: TYPE.TXT, rdata: rdata.txt('v=spf1 -all') }] });
          }
          if (q.name === '_dmarc.example.com' && q.qtype === TYPE.TXT) {
            return reply(q, {
              answers: [{ type: TYPE.TXT, rdata: rdata.txt('v=DMARC1; p=none') }],
            });
          }
          if (q.name === 'xn--mnchen-3ya.de' && q.qtype === TYPE.A) {
            return reply(q, { answers: [{ type: TYPE.A, rdata: rdata.a('192.0.2.9') }] });
          }
          if (q.name === 'example.com' || q.name === '_dmarc.example.com') return reply(q);
          return reply(q, { rcode: RCODE.NXDOMAIN });
        },
      });
      return server;
    }

    async function check(s: FakeDnsServer, domains: string[], recordTypes: RecordType[]) {
      const result = await runToolContract(devopsCheckDns, {
        domains,
        record_types: recordTypes,
        resolvers: [s.address],
        timeout_ms: 1000,
      });
      expect(result.isError).toBeFalsy();
      return (result.structuredContent as { results: DnsResult[] }).results;
    }

    it('answers a plain name, a trailing-dot name, and an underscore label as before', async () => {
      const s = await serveEntries();
      const results = await check(
        s,
        ['example.com', 'example.com.', '_dmarc.example.com'],
        ['A', 'TXT'],
      );

      expect(results.map((r) => r.domain)).toEqual([
        'example.com',
        'example.com.',
        '_dmarc.example.com',
      ]);
      expect(results[0]!.records).toEqual({ A: ['192.0.2.1'], TXT: ['v=spf1 -all'] });
      expect(results[1]!.records).toEqual({ A: ['192.0.2.1'], TXT: ['v=spf1 -all'] });
      expect(results[2]!.records).toEqual({ TXT: ['v=DMARC1; p=none'] });
      expect(results.every((r) => r.error === null)).toBe(true);
    });

    it('reads a host with a port, a path, or a scheme as that host', async () => {
      const s = await serveEntries();
      const results = await check(
        s,
        ['example.com', 'example.com:443', 'example.com/login', 'https://example.com/login'],
        ['A'],
      );

      expect(results).toHaveLength(4);
      for (const r of results) {
        expect(r.domain).toBe('example.com');
        expect(r.records.A).toEqual(['192.0.2.1']);
        expect(r.error).toBeNull();
      }
    });

    it('queries the ASCII form of a Unicode name', async () => {
      const s = await serveEntries();
      const [result] = await check(s, ['münchen.de'], ['A']);

      expect(result!.domain).toBe('xn--mnchen-3ya.de');
      expect(result!.records.A).toEqual(['192.0.2.9']);
      expect(s.received.map((q) => q.name)).toEqual(['xn--mnchen-3ya.de']);
    });

    it('reports each entry with no domain name in its own row and queries the rest', async () => {
      const s = await serveEntries();
      const domains = [
        'example.com',
        'user@example.com',
        ' ',
        '-bad.com',
        'example.com:99999',
        '1.1.1.1',
        'https://10.0.0.1/',
        'https://169.254.169.254/latest/meta-data',
        'http://0x7f.1:8080/',
        '[::1]:443',
      ];
      const results = await check(s, domains, ['A']);

      expect(results).toHaveLength(domains.length);
      expect(results[0]!.records.A).toEqual(['192.0.2.1']);
      for (const [i, raw] of domains.entries()) {
        if (i === 0) continue;
        expect(results[i]).toMatchObject({
          domain: raw,
          records: {},
          records_source: null,
          resolver_results: [],
          propagation_discrepancies: [],
          flags: [],
        });
        expect(results[i]!.error).toContain(JSON.stringify(raw));
        expect(results[i]!.error).toContain('Pass a domain name ("example.com")');
      }
      expect(results[5]!.error).toContain('is an IP address');
      expect(s.received.every((q) => q.name === 'example.com')).toBe(true);
    });
  });
});
