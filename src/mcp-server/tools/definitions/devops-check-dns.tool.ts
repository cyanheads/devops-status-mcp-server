/**
 * @fileoverview Tool to resolve DNS records and verify propagation across multiple public resolvers.
 * Pure node:dns — no external APIs.
 * @module mcp-server/tools/definitions/devops-check-dns.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import type { DnsResult, RecordType } from '@/services/dns/dns-service.js';
import { getDnsService } from '@/services/dns/dns-service.js';

const PROTOCOL_RE = /^https?:\/\//i;
const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'] as const;

export const devopsCheckDns = tool('devops_check_dns', {
  description:
    'Resolve DNS records and verify propagation for one or more domains across multiple public resolvers. ' +
    'Works for any domain — no vendor registry required. ' +
    'Reports records found (A/AAAA/CNAME/MX/TXT/NS), resolution latency per resolver, and discrepancies between resolvers (propagation gaps).',
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
                'Resolved records from the primary resolver (first in list). Keyed by record type (A, AAAA, CNAME, MX, TXT, NS).',
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
                      .describe('Records returned by this resolver, keyed by type.'),
                    error: z
                      .string()
                      .nullable()
                      .describe('Error message if this resolver failed, or null on success.'),
                  })
                  .describe('DNS resolution result from one resolver.'),
              )
              .describe('Per-resolver breakdown for propagation analysis.'),
            propagation_discrepancies: z
              .array(
                z
                  .object({
                    record_type: z.string().describe('The DNS record type with differing values.'),
                    resolvers_agree: z
                      .boolean()
                      .describe('False when resolvers returned different values.'),
                    values_by_resolver: z
                      .record(z.string(), z.array(z.string()))
                      .describe('Values reported per resolver IP address.'),
                  })
                  .describe('A record type where resolvers returned different values.'),
              )
              .describe(
                'Record types where resolvers returned different values. Empty when all resolvers agree.',
              ),
            flags: z
              .array(z.string())
              .describe(
                'Human-readable observations: "propagation mismatch on A records", "no MX records found", "CNAME detected — further records resolve via the CNAME target", etc.',
              ),
            error: z
              .string()
              .nullable()
              .describe('Overall error message if the domain could not be queried at all.'),
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
      const hasIssues = r.propagation_discrepancies.length > 0 || r.flags.length > 0 || r.error;
      const icon = r.error ? '❌' : hasIssues ? '⚠️' : '✅';
      lines.push(`### ${icon} ${r.domain}`);
      if (r.error) lines.push(`**Error:** ${r.error}`);
      if (r.flags.length > 0) lines.push(`**Flags:** ${r.flags.join(' | ')}`);

      // Records summary from primary resolver
      const recordEntries = Object.entries(r.records);
      if (recordEntries.length > 0) {
        lines.push('**Records (primary resolver):**');
        for (const [type, values] of recordEntries) {
          lines.push(`- ${type}: ${values.join(', ')}`);
        }
      }

      // Per-resolver breakdown (latency, records, errors)
      lines.push('**Resolver results:**');
      for (const rr of r.resolver_results) {
        lines.push(
          `- ${rr.resolver}: ${rr.latency_ms} ms${rr.error ? ` (error: ${rr.error})` : ''}`,
        );
        for (const [type, values] of Object.entries(rr.records)) {
          lines.push(`  - ${type}: ${values.join(', ')}`);
        }
      }

      // Propagation discrepancies
      if (r.propagation_discrepancies.length > 0) {
        lines.push('**Propagation discrepancies:**');
        for (const d of r.propagation_discrepancies) {
          lines.push(`- ${d.record_type} (resolvers_agree: ${d.resolvers_agree}):`);
          for (const [resolver, values] of Object.entries(d.values_by_resolver)) {
            lines.push(
              `  - ${resolver}: ${values.length > 0 ? values.join(', ') : '(no records)'}`,
            );
          }
        }
      }
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
