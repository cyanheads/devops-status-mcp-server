/**
 * @fileoverview Tool to resolve DNS records and verify propagation across multiple public resolvers.
 * Queries each resolver directly over the DNS wire protocol (UDP, TCP on truncation) — no
 * external APIs.
 * @module mcp-server/tools/definitions/devops-check-dns.tool
 */

import { isIP } from 'node:net';
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type { DnsResult, RecordType } from '@/services/dns/dns-service.js';
import {
  DISCREPANCY_KINDS,
  DNS_QUERY_STATUSES,
  getDnsService,
} from '@/services/dns/dns-service.js';
import { normalizeDomainInput } from '@/utils/domain-input.js';
import { clampMax, deferralNotice, splitBatch, uniqueInOrder } from '@/utils/input-bounds.js';
import { literal } from '@/utils/markdown-literal.js';
import { parseResolverTarget, ssrfRejectionMessage } from '@/utils/ssrf-guard.js';

const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'CAA', 'SOA'] as const;

/** Domains queried per call; later entries come back in `deferred_domains`. */
const DOMAINS_PER_CALL = 10;
/** Most domain entries one call accepts, queried and deferred together. */
const DOMAINS_MAX = 100;
/**
 * Distinct resolvers queried per call; later ones come back in `deferred_resolvers`. Every
 * domain is queried at every resolver, so this and the domain cap bound one call's queries.
 */
const RESOLVERS_PER_CALL = 5;
/** Most resolver entries one call accepts, before duplicates are dropped. */
const RESOLVERS_MAX = 20;
/** Longest `timeout_ms` honored; a larger value is served at this. */
const TIMEOUT_MAX_MS = 10_000;
const DNS_PORT = 53;

/**
 * The address and port a resolver entry sends to — the identity two entries share when they
 * name one resolver. Entries are parsed the way the wire client parses them, so "8.8.8.8" and
 * "8.8.8.8:53" key alike (53 is the default port), as do an IPv6 address with or without
 * brackets and in compressed or expanded form; the same address on another port stays
 * distinct. An entry that is not an IP literal keys as written, so the resolver check still
 * rejects it by name.
 */
function resolverKey(resolver: string): string {
  const { address, port = DNS_PORT } = parseResolverTarget(resolver);
  const family = isIP(address);
  if (family === 0) return resolver;
  return `${family === 6 ? canonicalIPv6(address) : address} ${port}`;
}

/** An IPv6 literal in its canonical text form; one the URL parser refuses keeps its spelling. */
function canonicalIPv6(address: string): string {
  try {
    return new URL(`http://[${address}]/`).hostname.slice(1, -1);
  } catch {
    return address.toLowerCase();
  }
}

/**
 * Queried when the field is omitted or sent as an empty array. An empty list would query
 * nothing and still render a clean result, so it is read as "no preference" — the handler
 * applies these rather than a schema transform, which would change the advertised schema.
 */
const DEFAULT_RECORD_TYPES: RecordType[] = ['A', 'AAAA', 'MX', 'TXT'];
const DEFAULT_RESOLVERS = ['8.8.8.8', '1.1.1.1', '9.9.9.9'];

/** Record values for one content[] line: one span each, joined outside the spans. */
const renderValues = (values: string[]) => values.map(literal).join(', ');

export const devopsCheckDns = tool('devops_check_dns', {
  description:
    'Resolve DNS records for one or more domains across multiple public resolvers and compare what each resolver returned. Works for any domain — no vendor registry required. Reports records found (A/AAAA/CNAME/MX/TXT/NS/CAA/SOA), resolution latency per resolver, and a typed outcome per resolver and record type so "the domain does not exist" (nxdomain), "the resolver could not answer" (servfail), and "no record of this type" (nodata) stay distinguishable. Resolver disagreements are reported without asserting a cause: partial_resolution (some resolvers answered, others returned nothing) points at a real propagation or resolver problem, while value_variation (every resolver answered with different values) is the normal steady state for anycast and geo-steered domains. Pair with devops_check_certs when a domain resolves but TLS to it is failing.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    domains: z
      .array(
        z
          .string()
          .min(1)
          .describe(
            'A domain name to query (e.g., "github.com", "_dmarc.example.com"). A URL or a host:port is reduced to its host.',
          ),
      )
      .min(1)
      .max(DOMAINS_MAX)
      .describe(
        'Domain names to query. The first 10 entries are queried; up to 100 are accepted, and entries past the 10th come back unqueried and verbatim in deferred_domains, to resend in another call. Each entry is read as one name: surrounding whitespace and letter case are ignored, a scheme, port, path, query, or fragment is dropped, and an internationalized name is converted to its ASCII form ("münchen.de" → "xn--mnchen-3ya.de"); a trailing dot and underscore labels are kept. An entry that is not a domain name — an IP address, a user name before "@", a bad port, or a malformed label — gets its own result with "error" set and is never queried; the other entries still run.',
      ),
    record_types: z
      .array(z.enum(RECORD_TYPES))
      .default(DEFAULT_RECORD_TYPES)
      .describe(
        'DNS record types to resolve. Defaults to A, AAAA, MX, and TXT. An empty array uses the same defaults. A type listed more than once is queried once. Add NS to check nameserver delegation. Add CNAME when investigating redirect chains. Add CAA when a certificate will not issue or renew: it lists the certificate authorities allowed to issue for the name. CAA is reported for the exact name only; a CA that finds none there checks the parent domains, so no CAA at a subdomain does not mean any CA may issue. Add SOA to compare zone serials across resolvers. SOA answers only at a zone apex, so a name below it returns nodata (a name that is a CNAME returns the SOA of its target). A serial difference means a zone change has not reached every resolver only when those resolvers report the same primary nameserver; a different primary means more than one DNS provider serves the zone.',
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
      .max(RESOLVERS_MAX)
      .default(DEFAULT_RESOLVERS)
      .describe(
        'Resolver IP addresses to query. Defaults to Google (8.8.8.8), Cloudflare (1.1.1.1), and Quad9 (9.9.9.9). An empty array uses the same defaults. Add custom resolvers to test resolver-specific behavior. A resolver listed more than once — the same address and port, however written ("8.8.8.8" and "8.8.8.8:53") — is queried once, under its first spelling. The first 5 distinct resolvers are queried; up to 20 entries are accepted, and the rest come back unqueried in deferred_resolvers, to resend with the same domains in another call. Each must be an IP literal, not a hostname; resolvers in private, loopback, or cloud-metadata ranges are rejected unless DEVOPS_STATUS_ALLOW_PRIVATE_TARGETS=true.',
      ),
    timeout_ms: z
      .number()
      .int()
      .min(1000)
      // Lazy default — resolved at parse time from server config, so the
      // DEVOPS_STATUS_DNS_TIMEOUT_MS env var takes effect without baking a
      // value in at module load. An explicit timeout_ms always wins.
      .default(() => getServerConfig().dnsTimeoutMs)
      .describe(
        'Time limit in milliseconds for each domain+resolver pair, covering every requested record type and any retry over TCP. A resolver that has not answered within it reports "timeout" for the unanswered types. At least 1000; a value over 10000 is served as 10000, and the notice says so. Defaults to 3000 unless the server is configured otherwise.',
      ),
  }),

  output: z.object({
    results: z
      .array(
        z
          .object({
            domain: z
              .string()
              .describe(
                'The domain name that was queried, as read from the submitted entry (lowercase, ASCII, no scheme, port, or path). For an entry that is not a domain name, the submitted string as given.',
              ),
            records: z
              .record(z.string(), z.array(z.string()))
              .describe(
                'Resolved records from a single resolver, keyed by record type (A, AAAA, CNAME, MX, TXT, NS, CAA, SOA). Names carry no trailing dot; MX renders as "<preference> <exchange>", CAA as \'<flags> <tag> "<value>"\', and SOA as "<primary nameserver> <hostmaster> <serial> <refresh> <retry> <expire> <minimum>". Taken from the primary resolver (first in "resolvers"), or from the first resolver that returned records when the primary returned none. Read "records_source" for which resolver these came from, and "resolver_results" for the full per-resolver picture. This is also the reference set the per-resolver answers are reported against: a resolver that returned exactly these values for a type names it in "records_same_as_domain" rather than repeating them.',
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
                        'Outcome for each requested record type, keyed by type. "ok" = records returned; "nodata" = the domain exists but has no record of this type; "nxdomain" = the domain does not exist (check for a typo, an expired registration, or a missing delegation); "servfail" = the resolver could not complete the query, commonly a DNSSEC validation failure; "refused" = the resolver declined the query or refused the connection; "timeout" = no answer within timeout_ms; "error" = any other failure, described in "error".',
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
                'Human-readable observations that need attention: "NXDOMAIN from 8.8.8.8, 1.1.1.1 on A, MX — the domain does not exist …", "Partial resolution on A records — 9.9.9.9 (nodata) returned nothing while 8.8.8.8 answered", "No MX records found", "CNAME detected — further records resolve via the CNAME target". A value_variation disagreement is not flagged here — it is reported in "propagation_discrepancies" because it is normal for geo-steered domains. Empty for a domain rejected before any query, whose reason is in "error".',
              ),
            error: z
              .string()
              .nullable()
              .describe(
                'Set only when the domain could not be queried at all: either the entry is not a domain name — rejected before any query, so "resolver_results" is empty, and the message names the entry and the accepted shapes — or every resolver failed and none returned records, in which case each failing resolver is named with its own outcome ("8.8.8.8: SERVFAIL on A; 1.1.1.1: NXDOMAIN on A") so a split result stays visible. Null when at least one resolver answered; per-resolver failures are still in "resolver_results" and "flags".',
              ),
          })
          .describe('DNS resolution result for one domain.'),
      )
      .describe('Per-domain DNS resolution results.'),
    deferred_domains: z
      .array(z.string().describe('A submitted domain entry, exactly as sent.'))
      .describe(
        'Domain entries past the first 10, not queried on this call, verbatim and in input order. Resend them in another call. Empty when every entry was queried.',
      ),
    deferred_resolvers: z
      .array(z.string().describe('A submitted resolver entry, exactly as sent.'))
      .describe(
        'Distinct resolvers past the first 5, not queried on this call, verbatim and in input order. Resend them with the same domains in another call. Empty when every resolver was queried.',
      ),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Present when the call was served at a bound: domains or resolvers past the per-call cap, named in deferred_domains and deferred_resolvers, or a timeout_ms over 10000 that was served as 10000. Absent otherwise.',
      ),
  },

  errors: [
    {
      reason: 'target_blocked',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A resolver is a private, loopback, or otherwise non-public address, or is not an IP literal at all.',
      recovery:
        'Use a public resolver IP literal (e.g., 8.8.8.8, 1.1.1.1), optionally with a port; pass an address rather than a hostname. Set DEVOPS_STATUS_ALLOW_PRIVATE_TARGETS=true for trusted local/internal monitoring deployments.',
    },
  ],
  /**
   * An entry that is not a domain name surfaces as a per-domain result with the error field set.
   * SSRF-blocked resolver IPs are caught in the handler and rethrown as target_blocked.
   */

  async handler(input, ctx) {
    // The raw entries are split before normalization, so an entry that is not a domain name
    // takes its slot as an error row and a deferred entry comes back exactly as sent.
    const domains = splitBatch(input.domains, DOMAINS_PER_CALL);
    const entries = domains.served.map((domain) => normalizeDomainInput(domain, 'dns'));
    const resolvers = splitBatch(
      input.resolvers.length > 0 ? uniqueInOrder(input.resolvers, resolverKey) : DEFAULT_RESOLVERS,
      RESOLVERS_PER_CALL,
    );
    const recordTypes =
      input.record_types.length > 0 ? uniqueInOrder(input.record_types) : DEFAULT_RECORD_TYPES;
    const timeout = clampMax('timeout_ms', input.timeout_ms, TIMEOUT_MAX_MS);

    const dnsService = getDnsService();
    let results: DnsResult[];
    try {
      results = await dnsService.checkDomains(
        entries,
        recordTypes,
        resolvers.served,
        timeout.value,
        ctx.signal,
      );
    } catch (err) {
      // Resolver-IP SSRF blocks throw out of checkDomains (the pre-check runs before the
      // per-domain Promise.allSettled). Translate to the declared target_blocked contract,
      // mirroring devops_status_check's raw-URL guard handling.
      const blocked = ssrfRejectionMessage(err);
      if (blocked === null) throw err;
      throw ctx.fail('target_blocked', blocked);
    }

    const notices = [
      ...(domains.deferred.length > 0
        ? [
            deferralNotice({
              cap: DOMAINS_PER_CALL,
              deferredCount: domains.deferred.length,
              field: 'deferred_domains',
              noun: 'domains',
              verb: 'queried',
            }),
          ]
        : []),
      ...(resolvers.deferred.length > 0
        ? [
            deferralNotice({
              cap: RESOLVERS_PER_CALL,
              deferredCount: resolvers.deferred.length,
              field: 'deferred_resolvers',
              noun: 'resolvers',
              verb: 'queried',
            }),
          ]
        : []),
      ...(timeout.notice ? [timeout.notice] : []),
    ];
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    ctx.log.info('DNS check completed', {
      domains: entries.length,
      withDiscrepancies: results.filter((r) => r.propagation_discrepancies.length > 0).length,
      ...(domains.deferred.length > 0 ? { deferredDomains: domains.deferred.length } : {}),
      ...(resolvers.deferred.length > 0 ? { deferredResolvers: resolvers.deferred.length } : {}),
    });

    return {
      results,
      deferred_domains: domains.deferred,
      deferred_resolvers: resolvers.deferred,
    };
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
      lines.push(`### ${icon} ${literal(r.domain)}`);
      if (r.error) lines.push(`**Error:** ${escapeMarkdownInline(r.error)}`);
      if (r.flags.length > 0) lines.push(`**Flags:** ${r.flags.join(' | ')}`);

      // Records summary, naming the resolver they came from
      const recordEntries = Object.entries(r.records);
      if (recordEntries.length > 0) {
        lines.push(`**Records (from ${r.records_source ?? 'no resolver'}):**`);
        for (const [type, values] of recordEntries) {
          lines.push(`- ${type}: ${renderValues(values)}`);
        }
      } else if (r.records_source) {
        lines.push(`**Records:** none returned by ${r.records_source}`);
      }

      // Per-resolver breakdown (latency, outcome, records, errors)
      if (r.resolver_results.length > 0) lines.push('**Resolver results:**');
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
              ? ` → ${renderValues(values)}`
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
              `  - ${resolver} (${d.status_by_resolver[resolver]}): ${values.length > 0 ? renderValues(values) : 'no records'}`,
            );
          }
        }
      }
      lines.push('');
    }
    if (result.deferred_domains.length > 0) {
      lines.push(`**Deferred domains (not queried):** ${renderValues(result.deferred_domains)}`);
    }
    if (result.deferred_resolvers.length > 0) {
      lines.push(
        `**Deferred resolvers (not queried):** ${renderValues(result.deferred_resolvers)}`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
