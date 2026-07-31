/**
 * @fileoverview Tool to resolve DNS records and verify propagation across multiple public resolvers.
 * Pure node:dns — no external APIs.
 * @module mcp-server/tools/definitions/devops-check-dns.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import type { DnsResult, RecordType } from '@/services/dns/dns-service.js';
import {
  DISCREPANCY_KINDS,
  DNS_QUERY_STATUSES,
  getDnsService,
} from '@/services/dns/dns-service.js';

const PROTOCOL_RE = /^https?:\/\//i;
const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'] as const;

export const devopsCheckDns = tool('devops_check_dns', {
  description:
    'Resolve DNS records for one or more domains across multiple public resolvers and compare what each resolver returned. ' +
    'Works for any domain — no vendor registry required. ' +
    'Reports records found (A/AAAA/CNAME/MX/TXT/NS), resolution latency per resolver, and a typed outcome per resolver and record type ' +
    'so "the domain does not exist" (nxdomain), "the resolver could not answer" (servfail), and "no record of this type" (nodata) stay distinguishable. ' +
    'Resolver disagreements are reported without asserting a cause: partial_resolution (some resolvers answered, others returned nothing) points at a real propagation or resolver problem, ' +
    'while value_variation (every resolver answered with different values) is the normal steady state for anycast and geo-steered domains. ' +
    'Pair with devops_check_certs when a domain resolves but TLS to it is failing.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    domains: z
      .array(
        z
          .string()
          .min(1)
          .describe('A domain name to query (e.g., "github.com", "api.example.com").'),
      )
      .min(1)
      .max(10)
      .describe('Domain names to query. Up to 10 per call.'),
    record_types: z
      .array(z.enum(RECORD_TYPES))
      .default(['A', 'AAAA', 'MX', 'TXT'])
      .describe(
        'DNS record types to resolve. Defaults to A, AAAA, MX, and TXT. Add NS to check nameserver delegation. Add CNAME when investigating redirect chains.',
      ),
    resolvers: z
      .array(
        z
          .string()
          .min(1)
          .describe(
            'A resolver IP literal — IPv4 ("8.8.8.8"), IPv6 ("2001:4860:4860::8888"), or either with a port ("1.1.1.1:53", "[2001:4860:4860::8888]:53"). A hostname is rejected.',
          ),
      )
      .default(['8.8.8.8', '1.1.1.1', '9.9.9.9'])
      .describe(
        'Resolver IP addresses to query. Defaults to Google (8.8.8.8), Cloudflare (1.1.1.1), and Quad9 (9.9.9.9). Add custom resolvers to test resolver-specific behavior. Each must be an IP literal, not a hostname; resolvers in private, loopback, or cloud-metadata ranges are rejected unless DEVOPS_STATUS_ALLOW_PRIVATE_TARGETS=true.',
      ),
    timeout_ms: z
      .number()
      .int()
      .min(1000)
      .max(10000)
      // Lazy default — resolved at parse time from server config, so the
      // DEVOPS_STATUS_DNS_TIMEOUT_MS env var takes effect without baking a
      // value in at module load. An explicit timeout_ms always wins.
      .default(() => getServerConfig().dnsTimeoutMs)
      .describe(
        'Query timeout per domain+resolver combination in milliseconds. Defaults to the DEVOPS_STATUS_DNS_TIMEOUT_MS env var (3000 when unset).',
      ),
  }),

  output: z.object({
    results: z
      .array(
        z
          .object({
            domain: z.string().describe('The domain that was queried.'),
            records: z
              .record(z.string(), z.array(z.string()))
              .describe(
                'Resolved records from a single resolver, keyed by record type (A, AAAA, CNAME, MX, TXT, NS). Taken from the primary resolver (first in "resolvers"), or from the first resolver that returned records when the primary returned none. Read "records_source" for which resolver these came from, and "resolver_results" for the full per-resolver picture. This is also the reference set the per-resolver answers are reported against: a resolver that returned exactly these values for a type names it in "records_same_as_domain" rather than repeating them.',
              ),
            records_source: z
              .string()
              .nullable()
              .describe(
                'Resolver IP whose answers populated "records", or null when no resolver was queried.',
              ),
            resolver_results: z
              .array(
                z
                  .object({
                    resolver: z.string().describe('Resolver IP address used.'),
                    latency_ms: z
                      .number()
                      .int()
                      .describe('Round-trip resolution latency in milliseconds.'),
                    records: z
                      .record(z.string(), z.array(z.string()))
                      .describe(
                        'Records returned by this resolver, keyed by type — carrying only the types whose values differ from the domain-level "records" set. A type this resolver answered identically is named in "records_same_as_domain" instead of repeated here. A requested type in neither place returned nothing from this resolver; "status_by_type" says why.',
                      ),
                    records_same_as_domain: z
                      .array(
                        z
                          .string()
                          .describe('A record type answered exactly as the domain-level set.'),
                      )
                      .describe(
                        'Record types this resolver answered with exactly the domain-level "records" values, omitted from "records" above rather than duplicated. Read their values from the domain-level set. Resolvers agreeing is the common case, so this list is usually where most of the answer is.',
                      ),
                    status: z
                      .enum(DNS_QUERY_STATUSES)
                      .describe(
                        'Headline outcome for this resolver: "ok" when any requested record type resolved, otherwise the most actionable failure across the requested types (servfail, timeout, refused, error, nxdomain, nodata — in that order). Read "status_by_type" for the per-record-type detail.',
                      ),
                    status_by_type: z
                      .record(z.string(), z.enum(DNS_QUERY_STATUSES))
                      .describe(
                        'Outcome for each requested record type, keyed by type. "ok" = records returned; "nodata" = the domain exists but has no record of this type; "nxdomain" = the domain does not exist (check for a typo, an expired registration, or a missing delegation); "servfail" = the resolver could not complete the query, commonly a DNSSEC validation failure; "refused" = the resolver declined; "timeout" = no answer within timeout_ms; "error" = any other failure, described in "error".',
                      ),
                    error: z
                      .string()
                      .nullable()
                      .describe(
                        'Failure summary for this resolver in the form "SERVFAIL on A, MX", or null when every requested type either resolved or returned nodata. Nodata is never reported as an error — it is a valid DNS answer.',
                      ),
                  })
                  .describe('DNS resolution result from one resolver.'),
              )
              .describe('Per-resolver breakdown for propagation analysis.'),
            propagation_discrepancies: z
              .array(
                z
                  .object({
                    record_type: z.string().describe('The DNS record type resolvers disagreed on.'),
                    resolvers_agree: z
                      .boolean()
                      .describe('Always false — an entry only exists when resolvers disagreed.'),
                    kind: z
                      .enum(DISCREPANCY_KINDS)
                      .describe(
                        'What the disagreement is. "partial_resolution" = at least one resolver returned records and at least one returned nothing; this is the signal worth investigating (in-flight propagation, a broken resolver, or a partial delegation) — read "status_by_resolver" for why each empty resolver was empty. "value_variation" = every resolver answered but with different values; this is the expected steady state for anycast and geo-steered domains such as CDN-fronted hostnames, and is also consistent with an in-flight DNS change. Neither value asserts a cause on its own.',
                      ),
                    values_by_resolver: z
                      .record(z.string(), z.array(z.string()))
                      .describe(
                        'Values reported per resolver IP address. An empty array means that resolver returned no records of this type.',
                      ),
                    status_by_resolver: z
                      .record(z.string(), z.enum(DNS_QUERY_STATUSES))
                      .describe(
                        'Outcome for this record type per resolver IP address — explains an empty entry in "values_by_resolver" as nodata, nxdomain, servfail, timeout, refused, or error.',
                      ),
                  })
                  .describe('A record type where resolvers returned different answers.'),
              )
              .describe(
                'Record types where resolvers returned different answers, each labelled by "kind". Empty when all resolvers agree.',
              ),
            flags: z
              .array(z.string())
              .describe(
                'Human-readable observations that need attention: "NXDOMAIN from 8.8.8.8, 1.1.1.1 on A, MX — the domain does not exist …", "Partial resolution on A records — 9.9.9.9 (nodata) returned nothing while 8.8.8.8 answered", "No MX records found", "CNAME detected — further records resolve via the CNAME target". A value_variation disagreement is not flagged here — it is reported in "propagation_discrepancies" because it is normal for geo-steered domains.',
              ),
            error: z
              .string()
              .nullable()
              .describe(
                'Set only when the domain could not be queried at all — every resolver failed and none returned records. Each failing resolver is named with its own outcome ("8.8.8.8: SERVFAIL on A; 1.1.1.1: NXDOMAIN on A") so a split result stays visible. Null when at least one resolver answered; per-resolver failures are still in "resolver_results" and "flags".',
              ),
          })
          .describe('DNS resolution result for one domain.'),
      )
      .describe('Per-domain DNS resolution results.'),
  }),

  errors: [
    {
      reason: 'invalid_domain',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A domain string contains a protocol prefix or invalid format.',
      recovery:
        'Pass bare hostnames without "https://" (e.g., "example.com" not "https://example.com").',
    },
    {
      reason: 'target_blocked',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A resolver is a private, loopback, or otherwise non-public address, or is not an IP literal at all.',
      recovery:
        'Use a public resolver IP literal (e.g., 8.8.8.8, 1.1.1.1), optionally with a port; pass an address rather than a hostname. Set DEVOPS_STATUS_ALLOW_PRIVATE_TARGETS=true for trusted local/internal monitoring deployments.',
    },
  ],
  // Note: SSRF-blocked domains surface as per-domain error results (status with error field).
  // SSRF-blocked resolver IPs are caught in the handler and rethrown as target_blocked.

  async handler(input, ctx) {
    // Validate domains — no protocol prefixes
    for (const domain of input.domains) {
      if (PROTOCOL_RE.test(domain)) {
        throw ctx.fail(
          'invalid_domain',
          `Domain "${domain}" must not include a protocol prefix. Pass the bare hostname.`,
          { ...ctx.recoveryFor('invalid_domain') },
        );
      }
    }

    const dnsService = getDnsService();
    let results: DnsResult[];
    try {
      results = await dnsService.checkDomains(
        input.domains,
        input.record_types as RecordType[],
        input.resolvers,
        input.timeout_ms,
      );
    } catch (err) {
      // Resolver-IP SSRF blocks throw out of checkDomains (the pre-check runs before the
      // per-domain Promise.allSettled). Translate to the declared target_blocked contract,
      // mirroring devops_status_check's raw-URL guard handling.
      const msg = (err as Error).message;
      if (msg.startsWith('SSRF_BLOCKED')) {
        throw ctx.fail('target_blocked', msg.replace('SSRF_BLOCKED: ', ''), {
          ...ctx.recoveryFor('target_blocked'),
        });
      }
      throw err;
    }

    ctx.log.info('DNS check completed', {
      domains: input.domains.length,
      withDiscrepancies: results.filter((r) => r.propagation_discrepancies.length > 0).length,
    });

    return { results };
  },

  format: (result) => {
    const lines: string[] = [`## DNS Check — ${result.results.length} domain(s)`, ''];
    for (const r of result.results) {
      /**
       * A value_variation disagreement on its own is the expected steady state for a geo-steered
       * domain, so it does not raise the icon — everything in `flags` does.
       */
      const needsAttention =
        r.flags.length > 0 ||
        r.propagation_discrepancies.some((d) => d.kind === 'partial_resolution');
      const icon = r.error ? '❌' : needsAttention ? '⚠️' : '✅';
      lines.push(`### ${icon} ${r.domain}`);
      if (r.error) lines.push(`**Error:** ${r.error}`);
      if (r.flags.length > 0) lines.push(`**Flags:** ${r.flags.join(' | ')}`);

      // Records summary, naming the resolver they came from
      const recordEntries = Object.entries(r.records);
      if (recordEntries.length > 0) {
        lines.push(`**Records (from ${r.records_source ?? 'no resolver'}):**`);
        for (const [type, values] of recordEntries) {
          lines.push(`- ${type}: ${values.join(', ')}`);
        }
      } else if (r.records_source) {
        lines.push(`**Records:** none returned by ${r.records_source}`);
      }

      // Per-resolver breakdown (latency, outcome, records, errors)
      lines.push('**Resolver results:**');
      for (const rr of r.resolver_results) {
        /**
         * Agreement is stated, never rendered as nothing — a bare status line would
         * read as "this resolver returned no records", which is the one thing
         * agreement is not. The headline names the agreeing types so a reader
         * scanning resolvers sees the shape without reading every sub-line.
         */
        const agreed =
          rr.records_same_as_domain.length > 0
            ? `, agreed with the domain-level records on ${rr.records_same_as_domain.join(', ')}`
            : '';
        lines.push(
          `- ${rr.resolver}: ${rr.status} in ${rr.latency_ms} ms${rr.error ? ` (${rr.error})` : ''}${agreed}`,
        );
        for (const [type, status] of Object.entries(rr.status_by_type)) {
          const values = rr.records[type];
          const answer =
            values && values.length > 0
              ? ` → ${values.join(', ')}`
              : rr.records_same_as_domain.includes(type)
                ? ` → same values as the domain-level ${type} records above`
                : '';
          lines.push(`  - ${type}: ${status}${answer}`);
        }
      }

      // Resolver disagreements, labelled by kind
      if (r.propagation_discrepancies.length > 0) {
        lines.push('**Resolver disagreements:**');
        for (const d of r.propagation_discrepancies) {
          lines.push(
            `- ${d.record_type} — ${d.kind} (resolvers_agree: ${d.resolvers_agree})${
              d.kind === 'value_variation'
                ? ': every resolver answered with different values — normal for anycast or geo-steered domains, and also consistent with an in-flight DNS change'
                : ': some resolvers answered and some did not'
            }`,
          );
          for (const [resolver, values] of Object.entries(d.values_by_resolver)) {
            lines.push(
              `  - ${resolver} (${d.status_by_resolver[resolver]}): ${values.length > 0 ? values.join(', ') : 'no records'}`,
            );
          }
        }
      }
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
