/**
 * @fileoverview Tests for the DnsService per-resolver outcome typing and propagation analysis.
 * @module tests/services/dns/dns-service.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordType } from '@/services/dns/dns-service.js';
import { DnsService, getDnsService, initDnsService } from '@/services/dns/dns-service.js';

// SSRF guard mock — unit tests for DNS propagation logic; guard behavior tested in ssrf-guard.test.ts
vi.mock('@/utils/ssrf-guard.js', () => ({
  assertSafeDomain: vi.fn().mockResolvedValue(undefined),
  assertSafeUrl: vi.fn().mockResolvedValue(undefined),
  assertSafeResolverIp: vi.fn(),
}));

/**
 * What one resolver answers for one record type: `ok` carries the raw value the node:dns API
 * returns for that type, `code` rejects with a node:dns error code (ENODATA, ENOTFOUND, …).
 */
type Answer = { code: string } | { ok: unknown };

/** Per-resolver-IP script consulted by the mock. Unscripted types fall back to DEFAULT_ANSWERS. */
let dnsScript: Record<string, Partial<Record<RecordType, Answer>>> = {};

vi.mock('node:dns/promises', () => ({
  // Answers are resolved through the module-scoped script at call time, never at factory time.
  Resolver: class {
    private server = '';

    setServers(servers: string[]) {
      this.server = servers[0] ?? '';
    }

    private answer(type: RecordType): Promise<unknown> {
      const scripted = dnsScript[this.server]?.[type] ?? DEFAULT_ANSWERS[type];
      if ('code' in scripted) {
        const err = new Error(
          `query${type} ${scripted.code} test.example.com`,
        ) as NodeJS.ErrnoException;
        err.code = scripted.code;
        return Promise.reject(err);
      }
      return Promise.resolve(scripted.ok);
    }

    resolve4() {
      return this.answer('A') as Promise<string[]>;
    }
    resolve6() {
      return this.answer('AAAA') as Promise<string[]>;
    }
    resolveCname() {
      return this.answer('CNAME') as Promise<string[]>;
    }
    resolveMx() {
      return this.answer('MX') as Promise<{ exchange: string; priority: number }[]>;
    }
    resolveTxt() {
      return this.answer('TXT') as Promise<string[][]>;
    }
    resolveNs() {
      return this.answer('NS') as Promise<string[]>;
    }
  },
}));

/** Baseline answers when a test does not script a resolver/type. */
const DEFAULT_ANSWERS: Record<RecordType, Answer> = {
  A: { ok: ['1.2.3.4'] },
  AAAA: { ok: [] },
  CNAME: { ok: [] },
  MX: { ok: [{ priority: 10, exchange: 'mail.example.com' }] },
  TXT: { ok: [] },
  NS: { ok: [] },
};

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
    const results = await getDnsService().checkDomains(['example.com'], ['A'], ['8.8.8.8'], 1000);
    expect(results).toHaveLength(1);
    expect(results[0]!.domain).toBe('example.com');
  });

  it('records A and MX records from the mock resolver', async () => {
    const results = await getDnsService().checkDomains(
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
    const results = await getDnsService().checkDomains(
      ['agree.example.com'],
      ['A'],
      ['8.8.8.8', '1.1.1.1'],
      1000,
    );
    expect(results[0]!.propagation_discrepancies).toHaveLength(0);
    expect(results[0]!.flags).toHaveLength(0);
  });

  it('handles multiple domains in one call', async () => {
    const results = await getDnsService().checkDomains(
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
    dnsScript = { '8.8.8.8': { MX: { ok: [] } } };
    const results = await getDnsService().checkDomains(
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
      const nxdomain = { code: 'ENOTFOUND' } as const;
      dnsScript = {
        '8.8.8.8': { A: nxdomain, AAAA: nxdomain, MX: nxdomain },
        '1.1.1.1': { A: nxdomain, AAAA: nxdomain, MX: nxdomain },
      };
      const results = await getDnsService().checkDomains(
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
      expect(result.flags).not.toContain('No A or AAAA records found');
      expect(result.error).toContain('8.8.8.8: NXDOMAIN');
      expect(result.error).toContain('1.1.1.1: NXDOMAIN');
    });

    it('reports SERVFAIL distinctly from NXDOMAIN and names the DNSSEC cause', async () => {
      const servfail = { code: 'ESERVFAIL' } as const;
      dnsScript = { '8.8.8.8': { A: servfail, AAAA: servfail } };
      const results = await getDnsService().checkDomains(
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
      expect(result.flags).not.toContain('No A or AAAA records found');
      expect(result.error).toContain('8.8.8.8: SERVFAIL on A, AAAA');
    });

    it('keeps NODATA silent — the domain exists, the record type does not', async () => {
      dnsScript = { '8.8.8.8': { MX: { code: 'ENODATA' } } };
      const results = await getDnsService().checkDomains(
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

    it('treats ENOTFOUND on one type as nodata when another type resolves', async () => {
      // c-ares raises ENOTFOUND for an empty AAAA answer on names that plainly exist.
      dnsScript = { '8.8.8.8': { A: { ok: ['140.82.116.4'] }, AAAA: { code: 'ENOTFOUND' } } };
      const results = await getDnsService().checkDomains(
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
        '8.8.8.8': { A: { code: 'ESERVFAIL' } },
        '1.1.1.1': { A: { code: 'ENOTFOUND' } },
      };
      const results = await getDnsService().checkDomains(
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
        '8.8.8.8': { A: { code: 'ESERVFAIL' }, AAAA: { code: 'ESERVFAIL' } },
        '1.1.1.1': { A: { ok: ['5.6.7.8'] } },
      };
      const results = await getDnsService().checkDomains(
        ['primary-broken.example.com'],
        ['A', 'AAAA'],
        ['8.8.8.8', '1.1.1.1'],
        1000,
      );
      const result = results[0]!;

      // A resolver did answer, so the domain is not record-less and was not "unqueryable".
      expect(result.flags).not.toContain('No A or AAAA records found');
      expect(result.records.A).toContain('5.6.7.8');
      expect(result.records_source).toBe('1.1.1.1');
      expect(result.error).toBeNull();
      expect(result.flags.some((f) => f.startsWith('SERVFAIL from 8.8.8.8'))).toBe(true);
    });
  });

  describe('resolver disagreement classification', () => {
    it('classifies differing non-empty answers as value_variation and does not flag them', async () => {
      dnsScript = {
        '8.8.8.8': { A: { ok: ['20.29.134.23'] } },
        '9.9.9.9': { A: { ok: ['140.82.116.4'] } },
      };
      const results = await getDnsService().checkDomains(
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
        '8.8.8.8': { A: { ok: ['1.2.3.4'] } },
        '1.1.1.1': { A: { code: 'ENODATA' } },
      };
      const results = await getDnsService().checkDomains(
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
        '8.8.8.8': { A: { ok: ['1.2.3.4'] } },
        '1.1.1.1': { A: { code: 'ESERVFAIL' } },
      };
      const results = await getDnsService().checkDomains(
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

  it('surfaces a per-domain rejection as an error result', async () => {
    const { assertSafeDomain } = await import('@/utils/ssrf-guard.js');
    vi.mocked(assertSafeDomain).mockRejectedValueOnce(new Error('SSRF_BLOCKED: private range'));

    const results = await new DnsService().checkDomains(
      ['internal.example.com'],
      ['A'],
      ['8.8.8.8'],
      1000,
    );
    expect(results[0]!.error).toContain('SSRF_BLOCKED');
    expect(results[0]!.records_source).toBeNull();
    expect(results[0]!.resolver_results).toHaveLength(0);
  });
});
