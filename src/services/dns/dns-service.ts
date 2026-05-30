/**
 * @fileoverview DNS resolution service — multi-resolver propagation checks via node:dns/promises.
 * @module services/dns/dns-service
 */

import { Resolver } from 'node:dns/promises';
import { performance } from 'node:perf_hooks';

export type RecordType = 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'NS';

export interface ResolverResult {
  error: string | null;
  latency_ms: number;
  records: Partial<Record<RecordType, string[]>>;
  resolver: string;
}

export interface PropagationDiscrepancy {
  record_type: string;
  resolvers_agree: boolean;
  values_by_resolver: Record<string, string[]>;
}

export interface DnsResult {
  domain: string;
  error: string | null;
  flags: string[];
  propagation_discrepancies: PropagationDiscrepancy[];
  records: Partial<Record<RecordType, string[]>>;
  resolver_results: ResolverResult[];
}

/** Resolve one record type using one resolver; returns sorted string values. */
async function resolveOne(resolver: Resolver, domain: string, type: RecordType): Promise<string[]> {
  switch (type) {
    case 'A':
      return resolver.resolve4(domain);
    case 'AAAA':
      return resolver.resolve6(domain);
    case 'CNAME':
      return resolver.resolveCname(domain);
    case 'MX': {
      const records = await resolver.resolveMx(domain);
      return records.map((r) => `${r.priority} ${r.exchange}`).sort();
    }
    case 'TXT': {
      const records = await resolver.resolveTxt(domain);
      return records.map((r) => r.join('')).sort();
    }
    case 'NS':
      return resolver.resolveNs(domain);
  }
}

/** Query one resolver for all requested record types. */
async function queryResolver(
  resolverIp: string,
  domain: string,
  types: RecordType[],
  timeoutMs: number,
): Promise<ResolverResult> {
  const resolver = new Resolver({ timeout: timeoutMs });
  resolver.setServers([resolverIp]);

  const start = performance.now();
  const records: Partial<Record<RecordType, string[]>> = {};
  let firstError: string | null = null;

  await Promise.allSettled(
    types.map(async (type) => {
      try {
        const vals = await resolveOne(resolver, domain, type);
        if (vals.length > 0) records[type] = vals.sort();
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        // NODATA/NOTFOUND are normal "no records of this type" — not a resolver error
        if (code !== 'ENODATA' && code !== 'ENOTFOUND' && code !== 'ESERVFAIL') {
          if (!firstError) firstError = (err as Error).message;
        }
      }
    }),
  );

  return {
    resolver: resolverIp,
    latency_ms: Math.round(performance.now() - start),
    records,
    error: firstError,
  };
}

/** Detect discrepancies between resolvers for each record type. */
function findDiscrepancies(
  resolverResults: ResolverResult[],
  types: RecordType[],
): PropagationDiscrepancy[] {
  const discrepancies: PropagationDiscrepancy[] = [];

  for (const type of types) {
    const byResolver: Record<string, string[]> = {};
    for (const r of resolverResults) {
      byResolver[r.resolver] = r.records[type] ?? [];
    }

    const values = Object.values(byResolver);
    const first = JSON.stringify(values[0] ?? []);
    const agree = values.every((v) => JSON.stringify(v) === first);

    if (!agree) {
      discrepancies.push({
        record_type: type,
        resolvers_agree: false,
        values_by_resolver: byResolver,
      });
    }
  }

  return discrepancies;
}

export class DnsService {
  async checkDomains(
    domains: string[],
    types: RecordType[],
    resolverIps: string[],
    timeoutMs: number,
  ): Promise<DnsResult[]> {
    const results = await Promise.allSettled(
      domains.map((domain) => this.checkOneDomain(domain, types, resolverIps, timeoutMs)),
    );
    return results.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : {
            domain: domains[i] ?? 'unknown',
            records: {},
            resolver_results: [],
            propagation_discrepancies: [],
            flags: [`Unexpected error: ${(r.reason as Error).message}`],
            error: (r.reason as Error).message,
          },
    );
  }

  private async checkOneDomain(
    domain: string,
    types: RecordType[],
    resolverIps: string[],
    timeoutMs: number,
  ): Promise<DnsResult> {
    const resolverResults = await Promise.all(
      resolverIps.map((ip) => queryResolver(ip, domain, types, timeoutMs)),
    );

    const discrepancies = findDiscrepancies(resolverResults, types);
    const flags: string[] = [];

    const primary = resolverResults[0];
    const records: Partial<Record<RecordType, string[]>> = primary?.records ?? {};

    if (types.includes('MX') && (!records.MX || records.MX.length === 0)) {
      flags.push('No MX records found');
    }
    if (
      types.includes('A') &&
      (!records.A || records.A.length === 0) &&
      (!records.AAAA || records.AAAA.length === 0)
    ) {
      flags.push('No A or AAAA records found');
    }
    if (records.CNAME && records.CNAME.length > 0) {
      flags.push('CNAME detected — further records resolve via the CNAME target');
    }
    if (discrepancies.length > 0) {
      for (const d of discrepancies) {
        flags.push(`Propagation mismatch on ${d.record_type} records`);
      }
    }

    const anyError = resolverResults.find((r) => r.error)?.error ?? null;

    return {
      domain,
      records,
      resolver_results: resolverResults,
      propagation_discrepancies: discrepancies,
      flags,
      error: anyError,
    };
  }
}

// --- Init/accessor pattern ---

let _service: DnsService | undefined;

export function initDnsService(): void {
  _service = new DnsService();
}

export function getDnsService(): DnsService {
  if (!_service) throw new Error('DnsService not initialized — call initDnsService() in setup()');
  return _service;
}
