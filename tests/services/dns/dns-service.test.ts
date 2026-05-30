/**
 * @fileoverview Tests for the DnsService propagation analysis logic.
 * @module tests/services/dns/dns-service.test
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DnsService, getDnsService, initDnsService } from '@/services/dns/dns-service.js';

// SSRF guard mock — unit tests for DNS propagation logic; guard behavior tested in ssrf-guard.test.ts
vi.mock('@/utils/ssrf-guard.js', () => ({
  assertSafeDomain: vi.fn().mockResolvedValue(undefined),
  assertSafeUrl: vi.fn().mockResolvedValue(undefined),
  assertSafeResolverIp: vi.fn(),
}));

vi.mock('node:dns/promises', () => ({
  // The module-level mock always returns a resolver with A=['1.2.3.4'] by default.
  // Individual tests override via vi.mocked where needed.
  Resolver: class {
    setServers() {
      return;
    }
    resolve4() {
      return Promise.resolve(['1.2.3.4']);
    }
    resolve6() {
      return Promise.resolve([]);
    }
    resolveCname() {
      return Promise.resolve([]);
    }
    resolveMx() {
      return Promise.resolve([{ priority: 10, exchange: 'mail.example.com' }]);
    }
    resolveTxt() {
      return Promise.resolve([]);
    }
    resolveNs() {
      return Promise.resolve([]);
    }
  },
}));

describe('DnsService', () => {
  beforeEach(() => {
    initDnsService();
  });

  it('init/accessor pattern works', () => {
    expect(getDnsService()).toBeDefined();
  });

  it('checkDomains returns one result per domain', async () => {
    const service = getDnsService();
    const results = await service.checkDomains(['example.com'], ['A'], ['8.8.8.8'], 1000);
    expect(results).toHaveLength(1);
    expect(results[0]!.domain).toBe('example.com');
  });

  it('records A records from mock resolver', async () => {
    const service = getDnsService();
    const results = await service.checkDomains(['example.com'], ['A', 'MX'], ['8.8.8.8'], 1000);
    // A records should come through from the default mock
    expect(results[0]!.records.A).toBeDefined();
    expect(results[0]!.records.A).toContain('1.2.3.4');
    expect(results[0]!.records.MX).toBeDefined();
    expect(results[0]!.records.MX).toContain('10 mail.example.com');
  });

  it('reports no discrepancy when both resolvers agree', async () => {
    const service = getDnsService();
    // Both resolver instances use the same class mock (A=['1.2.3.4']) → they agree
    const results = await service.checkDomains(
      ['agree.example.com'],
      ['A'],
      ['8.8.8.8', '1.1.1.1'],
      1000,
    );
    expect(results[0]!.propagation_discrepancies).toHaveLength(0);
  });

  it('handles multiple domains in one call', async () => {
    const service = getDnsService();
    const results = await service.checkDomains(
      ['a.example.com', 'b.example.com'],
      ['A'],
      ['8.8.8.8'],
      1000,
    );
    expect(results).toHaveLength(2);
    expect(results[0]!.domain).toBe('a.example.com');
    expect(results[1]!.domain).toBe('b.example.com');
  });

  it('findDiscrepancies works: disagree when A records differ per resolver', async () => {
    // Create a custom service that we'll test with controlled resolver results directly
    // by invoking the internal logic via checkDomains with a new service instance
    // The mock class always returns ['1.2.3.4'] — but we can verify the discrepancy
    // analysis by feeding a service with a custom subclass that differentiates by call count

    const { Resolver: MockResolver } = await import('node:dns/promises');
    let callIndex = 0;
    // Temporarily patch the class so the first resolver instance returns '1.2.3.4'
    // and the second returns '9.9.9.9'
    const origResolve4 = MockResolver.prototype.resolve4;
    Object.defineProperty(MockResolver.prototype, 'resolve4', {
      configurable: true,
      value: vi.fn(() => {
        const n = callIndex++;
        return Promise.resolve(n % 2 === 0 ? ['1.2.3.4'] : ['9.9.9.9']);
      }),
    });

    const service = new DnsService();
    const results = await service.checkDomains(
      ['disagree.example.com'],
      ['A'],
      ['8.8.8.8', '1.1.1.1'],
      1000,
    );

    // Restore
    Object.defineProperty(MockResolver.prototype, 'resolve4', {
      configurable: true,
      value: origResolve4,
    });

    expect(results[0]!.propagation_discrepancies.length).toBeGreaterThan(0);
    expect(results[0]!.propagation_discrepancies[0]!.resolvers_agree).toBe(false);
    expect(results[0]!.flags.some((f) => f.includes('Propagation mismatch'))).toBe(true);
  });

  it('flags no-MX when MX query returns empty', async () => {
    const { Resolver: MockResolver } = await import('node:dns/promises');
    const origResolveMx = MockResolver.prototype.resolveMx;
    Object.defineProperty(MockResolver.prototype, 'resolveMx', {
      configurable: true,
      value: vi.fn(() => Promise.resolve([])),
    });

    const service = new DnsService();
    const results = await service.checkDomains(
      ['no-mx.example.com'],
      ['A', 'MX'],
      ['8.8.8.8'],
      1000,
    );

    Object.defineProperty(MockResolver.prototype, 'resolveMx', {
      configurable: true,
      value: origResolveMx,
    });

    expect(results[0]!.flags).toContain('No MX records found');
  });
});
