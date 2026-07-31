/**
 * @fileoverview DNS resolution service — multi-resolver propagation checks via node:dns/promises.
 * @module services/dns/dns-service
 */

import { Resolver } from 'node:dns/promises';
import { performance } from 'node:perf_hooks';
import { assertSafeDomain, assertSafeResolverIp } from '@/utils/ssrf-guard.js';

export type RecordType = 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'NS';

/**
 * Outcome of one resolver answering one record type. `nodata` is the only silent case —
 * every other non-`ok` value names a condition an operator has to act on.
 */
export const DNS_QUERY_STATUSES = [
  'ok',
  'nodata',
  'nxdomain',
  'servfail',
  'refused',
  'timeout',
  'error',
] as const;
export type DnsQueryStatus = (typeof DNS_QUERY_STATUSES)[number];

/**
 * Why resolvers returned different answers for a record type.
 * `value_variation` — every resolver answered, with different values (anycast/geo-steering, or an
 * in-flight change). `partial_resolution` — at least one resolver answered and at least one did not.
 */
export const DISCREPANCY_KINDS = ['value_variation', 'partial_resolution'] as const;
export type DiscrepancyKind = (typeof DISCREPANCY_KINDS)[number];

/**
 * node:dns error code → typed outcome. Anything unmapped falls through to `error`. `ENOTFOUND` is
 * deliberately absent — it is resolved separately in `queryResolver`, see the note there.
 */
const DNS_ERROR_STATUS: Record<string, DnsQueryStatus> = {
  ENODATA: 'nodata',
  ESERVFAIL: 'servfail',
  EREFUSED: 'refused',
  ECONNREFUSED: 'refused',
  ETIMEOUT: 'timeout',
  ETIMEDOUT: 'timeout',
};

/** Operator-facing meaning of each non-`ok` outcome. */
const STATUS_EXPLANATION: Record<DnsQueryStatus, string> = {
  ok: 'records were returned',
  nodata: 'the domain exists but has no record of this type',
  nxdomain:
    'the domain does not exist — check for a typo, an expired registration, or a missing delegation',
  servfail:
    'the resolver could not complete the query — commonly a DNSSEC validation failure or a broken delegation',
  refused: 'the resolver refused the query',
  timeout: 'the resolver did not answer within the timeout',
  error: 'the query failed',
};

/**
 * Order in which a resolver-level condition is reported when a resolver's record types
 * disagree: resolver-health failures first, then name-level, then the silent case.
 */
const FAILURE_PRECEDENCE = [
  'servfail',
  'timeout',
  'refused',
  'error',
  'nxdomain',
  'nodata',
] as const satisfies readonly DnsQueryStatus[];

export interface ResolverResult {
  error: string | null;
  latency_ms: number;
  /**
   * Only the record types where this resolver's answer differs from the domain-level set.
   * Types answered identically are named in `records_same_as_domain` instead of repeated.
   */
  records: Partial<Record<RecordType, string[]>>;
  /** Record types this resolver answered exactly as the domain-level `records` set. */
  records_same_as_domain: RecordType[];
  resolver: string;
  status: DnsQueryStatus;
  status_by_type: Partial<Record<RecordType, DnsQueryStatus>>;
}

/** One resolver's full answer, before its record sets are elided against the domain-level set. */
type ResolverAnswer = Omit<ResolverResult, 'records_same_as_domain'>;

export interface PropagationDiscrepancy {
  kind: DiscrepancyKind;
  record_type: string;
  resolvers_agree: boolean;
  status_by_resolver: Record<string, DnsQueryStatus>;
  values_by_resolver: Record<string, string[]>;
}

export interface DnsResult {
  domain: string;
  error: string | null;
  flags: string[];
  propagation_discrepancies: PropagationDiscrepancy[];
  records: Partial<Record<RecordType, string[]>>;
  records_source: string | null;
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

/**
 * Roll one resolver's per-type outcomes into a single headline status: `ok` when any requested
 * type resolved, otherwise the most actionable failure present (see FAILURE_PRECEDENCE).
 */
function rollUpStatus(
  statusByType: Partial<Record<RecordType, DnsQueryStatus>>,
  types: RecordType[],
): DnsQueryStatus {
  const seen = types
    .map((t) => statusByType[t])
    .filter((s): s is DnsQueryStatus => s !== undefined);
  if (seen.length === 0) return 'error';
  if (seen.includes('ok')) return 'ok';
  return FAILURE_PRECEDENCE.find((s) => seen.includes(s)) ?? 'error';
}

/** Query one resolver for all requested record types. */
async function queryResolver(
  resolverIp: string,
  domain: string,
  types: RecordType[],
  timeoutMs: number,
): Promise<ResolverAnswer> {
  const resolver = new Resolver({ timeout: timeoutMs });
  resolver.setServers([resolverIp]);

  const start = performance.now();
  const records: Partial<Record<RecordType, string[]>> = {};
  const statusByType: Partial<Record<RecordType, DnsQueryStatus>> = {};
  const outcomes: Partial<
    Record<RecordType, { code?: string; message?: string; values?: string[] }>
  > = {};

  await Promise.allSettled(
    types.map(async (type) => {
      try {
        outcomes[type] = { values: await resolveOne(resolver, domain, type) };
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        outcomes[type] = { code: e.code ?? '', message: e.message };
      }
    }),
  );

  /**
   * `ENOTFOUND` is ambiguous on a per-type query: c-ares raises it both for a true NXDOMAIN and
   * for a NOERROR response with an empty answer section on some types (github.com AAAA). Claim
   * nxdomain only when every requested type came back ENOTFOUND — any type that resolved, or that
   * failed differently, proves the name itself resolves, which makes the empty type a NODATA.
   */
  const allNotFound =
    types.length > 0 && types.every((type) => outcomes[type]?.code === 'ENOTFOUND');

  for (const type of types) {
    const outcome = outcomes[type];
    if (!outcome) {
      statusByType[type] = 'error';
    } else if (outcome.values) {
      if (outcome.values.length > 0) {
        records[type] = outcome.values.sort();
        statusByType[type] = 'ok';
      } else {
        // Empty success is NOERROR with an empty answer section — the NODATA case.
        statusByType[type] = 'nodata';
      }
    } else if (outcome.code === 'ENOTFOUND') {
      statusByType[type] = allNotFound ? 'nxdomain' : 'nodata';
    } else {
      statusByType[type] = DNS_ERROR_STATUS[outcome.code ?? ''] ?? 'error';
    }
  }

  /**
   * Build the message from the requested-type order rather than settle order, so the same
   * outcome always renders the same string. NODATA stays silent — it is a valid answer.
   */
  const byStatus = new Map<DnsQueryStatus, RecordType[]>();
  for (const type of types) {
    const status = statusByType[type];
    if (!status || status === 'ok' || status === 'nodata') continue;
    const bucket = byStatus.get(status);
    if (bucket) bucket.push(type);
    else byStatus.set(status, [type]);
  }
  const error =
    byStatus.size === 0
      ? null
      : [...byStatus]
          .map(([status, affected]) => {
            const raw =
              status === 'error' ? outcomes[affected[0] as RecordType]?.message : undefined;
            return `${status.toUpperCase()} on ${affected.join(', ')}${raw ? ` (${raw})` : ''}`;
          })
          .join('; ');

  return {
    resolver: resolverIp,
    latency_ms: Math.round(performance.now() - start),
    records,
    status: rollUpStatus(statusByType, types),
    status_by_type: statusByType,
    error,
  };
}

/**
 * Detect where resolvers disagreed, separating the two causes an operator has to tell apart:
 * resolvers that all answered with different values (steering) from resolvers where some
 * answered and others did not (a genuine propagation or resolver problem).
 */
function findDiscrepancies(
  resolverResults: ResolverAnswer[],
  types: RecordType[],
): PropagationDiscrepancy[] {
  const discrepancies: PropagationDiscrepancy[] = [];

  for (const type of types) {
    const valuesByResolver: Record<string, string[]> = {};
    const statusByResolver: Record<string, DnsQueryStatus> = {};
    for (const r of resolverResults) {
      valuesByResolver[r.resolver] = r.records[type] ?? [];
      statusByResolver[r.resolver] = r.status_by_type[type] ?? 'error';
    }

    const values = Object.values(valuesByResolver);
    const answered = values.filter((v) => v.length > 0);
    // Nobody has this record type — that is a "no records" observation, not a disagreement.
    if (answered.length === 0) continue;

    const partial = answered.length < values.length;
    if (!partial) {
      const first = JSON.stringify(values[0] ?? []);
      if (values.every((v) => JSON.stringify(v) === first)) continue;
    }

    discrepancies.push({
      record_type: type,
      resolvers_agree: false,
      kind: partial ? 'partial_resolution' : 'value_variation',
      values_by_resolver: valuesByResolver,
      status_by_resolver: statusByResolver,
    });
  }

  return discrepancies;
}

/**
 * Drop each per-resolver record set that matches the domain-level set exactly, naming the
 * dropped types in `records_same_as_domain`.
 *
 * Resolvers agreeing is the common case, and an agreeing copy carries nothing the
 * domain-level set does not already hold — a domain with a large TXT set was serialized
 * once per resolver plus once at the domain level. Only an exact match is elided, so a
 * divergent type keeps its full per-resolver values and no disagreement can be hidden.
 * Absence is never ambiguous: a type in neither `records` nor `records_same_as_domain`
 * returned nothing from that resolver, and `status_by_type` says why.
 */
function elideAgreeingRecords(
  answers: ResolverAnswer[],
  domainRecords: Partial<Record<RecordType, string[]>>,
  types: RecordType[],
): ResolverResult[] {
  return answers.map((answer) => {
    const records: Partial<Record<RecordType, string[]>> = {};
    const sameAsDomain: RecordType[] = [];
    for (const type of types) {
      const values = answer.records[type];
      if (!values) continue;
      const domainValues = domainRecords[type];
      const agrees =
        domainValues !== undefined &&
        domainValues.length === values.length &&
        values.every((v, i) => v === domainValues[i]);
      if (agrees) sameAsDomain.push(type);
      else records[type] = values;
    }
    return { ...answer, records, records_same_as_domain: sameAsDomain };
  });
}

export class DnsService {
  async checkDomains(
    domains: string[],
    types: RecordType[],
    resolverIps: string[],
    timeoutMs: number,
  ): Promise<DnsResult[]> {
    // SSRF guard: reject resolver IPs that are in private/loopback ranges (direct IP check —
    // no DNS resolution needed since the caller controls the value).
    for (const ip of resolverIps) {
      assertSafeResolverIp(ip);
    }

    const results = await Promise.allSettled(
      domains.map(async (domain) => {
        // SSRF guard: reject domains that resolve to private/loopback/cloud-metadata addresses.
        await assertSafeDomain(domain);
        return this.checkOneDomain(domain, types, resolverIps, timeoutMs);
      }),
    );
    return results.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : {
            domain: domains[i] ?? 'unknown',
            records: {},
            records_source: null,
            resolver_results: [],
            propagation_discrepancies: [],
            flags: [`${(r.reason as Error).message}`],
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

    /**
     * `records` mirrors the primary resolver, falling back to the first resolver that answered
     * when the primary returned nothing — a primary-resolver failure must not present the domain
     * as record-less while other resolvers hold answers. `records_source` names the resolver used.
     */
    const firstWithRecords = resolverResults.find((r) => Object.keys(r.records).length > 0);
    const source = firstWithRecords ?? resolverResults[0];
    const records: Partial<Record<RecordType, string[]>> = source?.records ?? {};

    const anyRecords = (type: RecordType) =>
      resolverResults.some((r) => (r.records[type]?.length ?? 0) > 0);
    const anyNodata = (type: RecordType) =>
      resolverResults.some((r) => r.status_by_type[type] === 'nodata');

    /**
     * "No records" is only claimed when a resolver actually reported NODATA for the type. When
     * every resolver returned NXDOMAIN or SERVFAIL the condition flag below is the true finding,
     * and "no records found" would misattribute a missing domain to a missing record.
     */
    if (types.includes('MX') && !anyRecords('MX') && anyNodata('MX')) {
      flags.push('No MX records found');
    }
    if (
      types.includes('A') &&
      !anyRecords('A') &&
      !anyRecords('AAAA') &&
      (anyNodata('A') || anyNodata('AAAA'))
    ) {
      flags.push('No A or AAAA records found');
    }
    if (anyRecords('CNAME')) {
      flags.push('CNAME detected — further records resolve via the CNAME target');
    }

    // Per-condition flags, grouped so a split outcome names every resolver and every record type.
    for (const status of FAILURE_PRECEDENCE) {
      if (status === 'nodata') continue;
      const affectedResolvers = resolverResults.filter((r) =>
        types.some((t) => r.status_by_type[t] === status),
      );
      if (affectedResolvers.length === 0) continue;
      const affectedTypes = types.filter((t) =>
        affectedResolvers.some((r) => r.status_by_type[t] === status),
      );
      flags.push(
        `${status.toUpperCase()} from ${affectedResolvers.map((r) => r.resolver).join(', ')} on ${affectedTypes.join(', ')} — ${STATUS_EXPLANATION[status]}`,
      );
    }

    for (const d of discrepancies) {
      if (d.kind === 'partial_resolution') {
        const missing = Object.entries(d.values_by_resolver)
          .filter(([, v]) => v.length === 0)
          .map(([ip]) => `${ip} (${d.status_by_resolver[ip]})`);
        const answering = Object.entries(d.values_by_resolver)
          .filter(([, v]) => v.length > 0)
          .map(([ip]) => ip);
        flags.push(
          `Partial resolution on ${d.record_type} records — ${missing.join(', ')} returned nothing while ${answering.join(', ')} answered`,
        );
      }
    }

    /**
     * Domain-level error means the domain could not be queried at all: every resolver reported a
     * failure and none returned records. Each resolver's own outcome is preserved so a split
     * result (one NXDOMAIN, one SERVFAIL) stays visible instead of collapsing to the first.
     */
    const failing = resolverResults.filter((r) => r.error !== null);
    const allFailed =
      resolverResults.length > 0 &&
      failing.length === resolverResults.length &&
      firstWithRecords === undefined;
    const error = allFailed ? failing.map((r) => `${r.resolver}: ${r.error}`).join('; ') : null;

    return {
      domain,
      records,
      records_source: source?.resolver ?? null,
      resolver_results: elideAgreeingRecords(resolverResults, records, types),
      propagation_discrepancies: discrepancies,
      flags,
      error,
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
