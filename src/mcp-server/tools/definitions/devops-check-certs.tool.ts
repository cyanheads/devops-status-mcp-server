/**
 * @fileoverview Tool to inspect SSL/TLS certificate health for one or more domains.
 * Pure node:tls — no external APIs.
 * @module mcp-server/tools/definitions/devops-check-certs.tool
 */

import { isIP } from 'node:net';
import { tool, z } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from '@/config/server-config.js';
import { getCertService } from '@/services/cert/cert-service.js';
import { normalizeDomainInput } from '@/utils/domain-input.js';
import { clampMax, deferralNotice, splitBatch } from '@/utils/input-bounds.js';
import { vendorInline } from '@/utils/vendor-markdown.js';

/** Hosts inspected per call; later entries come back in `deferred_domains`. */
const DOMAINS_PER_CALL = 10;
/** Most host entries one call accepts, inspected and deferred together. */
const DOMAINS_MAX = 100;
/** Longest `timeout_ms` honored; a larger value is served at this. */
const TIMEOUT_MAX_MS = 15_000;

export const devopsCheckCerts = tool('devops_check_certs', {
  description:
    'Inspect SSL/TLS certificate health for one or more domains by performing a real TLS handshake. Works for any internet-accessible domain — no vendor registry required. Reports days to expiry (flagged at < 30 days warning and < 7 days critical), certificate subject and SANs, issuer, hostname coverage, chain-trust verification, TLS protocol version negotiated (flags TLS 1.0/1.1 as insecure — a server offering only those is still inspected), cipher suite, and HSTS presence when the port answers HTTP. The handshake completes even for a certificate clients would reject, so a broken certificate is reported rather than hidden behind a connection error: a hostname mismatch surfaces in cert.hostname_verification_error and a chain-trust failure (self-signed, untrusted root) in cert.authorization_error, both status "critical". Non-HTTP TLS ports (IMAPS 993, SMTPS 465, DNS over TLS 853) are graded the same way, with HSTS reported as not checked. If a domain fails to connect at all, check devops_check_dns first — the name may not resolve. When a certificate fails to issue or renew, run devops_check_dns with record_types ["CAA"] to see which certificate authorities the domain allows.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    domains: z
      .array(
        z
          .string()
          .min(1)
          .describe(
            'A host to inspect: a hostname ("api.github.com"), an IP address, a host with a port ("example.com:8443", "[2606:4700:4700::1111]:853"), or a URL ("https://example.com/login"), which is reduced to its host.',
          ),
      )
      .min(1)
      .max(DOMAINS_MAX)
      .describe(
        'Hosts to inspect. The first 10 entries are inspected; up to 100 are accepted, and entries past the 10th come back uninspected and verbatim in deferred_domains, to resend in another call. Each entry is read as one host: surrounding whitespace and letter case are ignored, a scheme, path, query, or fragment is dropped, an internationalized name is converted to its ASCII form ("münchen.de" → "xn--mnchen-3ya.de"), and a port written on the entry is used for that entry in place of "port". An entry with no single host — a user name before "@", a bad port, or a malformed label — gets its own result with status "error" and is never connected to; the other entries still run.',
      ),
    port: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .default(443)
      .describe(
        'TLS port for entries that do not carry their own. Defaults to 443. Use 8443 or custom ports for non-standard HTTPS endpoints, or 993, 465, 853, and the like for other TLS services. A port written on an entry ("example.com:8443") wins for that entry.',
      ),
    timeout_ms: z
      .number()
      .int()
      .min(1000)
      // Lazy default — resolved at parse time from server config, so the
      // DEVOPS_STATUS_CERT_TIMEOUT_MS env var takes effect without baking a
      // value in at module load. An explicit timeout_ms always wins.
      .default(() => getServerConfig().certTimeoutMs)
      .describe(
        'Time limit in milliseconds for each domain, covering the connection, the handshake, a second handshake with TLS 1.0/1.1 enabled when the server offers nothing newer, and the HSTS request. A port that completes the handshake and then sends nothing is reported at this limit, certificate included. At least 1000; a value over 15000 is served as 15000, and the notice says so. Defaults to 5000 unless the server is configured otherwise. Increase for slow or geographically distant endpoints.',
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
                'The host that was inspected, as read from the submitted entry (lowercase, ASCII, no scheme, port, or path; an IPv6 address without brackets). For an entry with no single host, the submitted string as given.',
              ),
            port: z
              .number()
              .describe(
                'The port used for the TLS connection: the port written on the entry, otherwise the "port" input.',
              ),
            status: z
              .enum(['ok', 'warning', 'critical', 'error'])
              .describe(
                'Overall status. "critical" — the certificate expires in < 7 days or has already expired, the hostname is not covered by the certificate, chain verification failed (self-signed or untrusted root), or an insecure TLS version was negotiated (TLS 1.0/1.1, including a server that offers nothing newer); every one of these is rejected by ordinary clients. "warning" — expires in < 30 days. "ok" — none of the above. Graded from the certificate and session alone: HSTS never changes it, and neither does what the port sends after the handshake. "error" — no certificate was retrieved: the entry was rejected, the connection failed or timed out before the handshake completed, or the server presented no certificate; the reason is in "error".',
              ),
            flags: z
              .array(z.string())
              .describe(
                'Human-readable findings about the certificate and TLS session that were read: "Expires in 12 days (warning)", "Certificate expired 40 days ago", "Hostname mismatch — the certificate does not cover api.example.com; clients will reject it", "Certificate chain not trusted (SELF_SIGNED_CERT_IN_CHAIN); clients will reject it", "Self-signed certificate", "Insecure TLS version in use: TLSv1.1", and one HSTS finding: "HSTS present" or "HSTS not configured" when the port answered the HTTP request, or "HSTS not checked — no HTTP response on port 993" when it did not (a non-HTTP service such as IMAPS, SMTPS, or DNS over TLS). Empty when the connection never completed a handshake (rejected target, connection failure, or timeout) — the reason is in "error" only. A handshake that completed without a certificate keeps its TLS-session findings here alongside "error".',
              ),
            cert: z
              .object({
                subject: z.string().describe('Certificate subject CN.'),
                san: z
                  .array(z.string())
                  .describe('Subject Alternative Names covered by this certificate.'),
                issuer: z.string().describe('Issuer common name.'),
                valid_from: z
                  .string()
                  .describe('ISO 8601 UTC timestamp of certificate validity start.'),
                valid_until: z.string().describe('ISO 8601 UTC timestamp of certificate expiry.'),
                days_until_expiry: z
                  .number()
                  .int()
                  .describe('Days remaining until certificate expiry. Negative = already expired.'),
                chain_depth: z
                  .number()
                  .int()
                  .nullable()
                  .describe(
                    'Number of certificates the server sent, counting the leaf. Null when the runtime does not expose the issuer chain — read "chain_depth_unavailable_reason" in that case. Not a self-signed indicator: use "authorization_error" for that.',
                  ),
                chain_depth_unavailable_reason: z
                  .string()
                  .nullable()
                  .describe(
                    'Why "chain_depth" is null, or null when a depth was measured. Absence of a depth is a runtime limitation, not a finding about the certificate.',
                  ),
                hostname_verification_error: z
                  .string()
                  .nullable()
                  .describe(
                    'Node\'s hostname-verification message when the requested domain is not covered by the certificate\'s CN or SANs (e.g. "Hostname/IP does not match certificate\'s altnames: …"), or null when the hostname is covered. A non-null value means ordinary clients reject this certificate for this hostname; compare against the "san" list to see what it does cover.',
                  ),
                authorization_error: z
                  .string()
                  .nullable()
                  .describe(
                    'OpenSSL chain-verification code when the certificate chain does not validate against the system trust store, or null when it validates. Common values: "DEPTH_ZERO_SELF_SIGNED_CERT" (self-signed leaf), "SELF_SIGNED_CERT_IN_CHAIN" / "UNABLE_TO_VERIFY_LEAF_SIGNATURE" (issuing root not trusted), "CERT_HAS_EXPIRED" (also reported in "days_until_expiry"). This is the authoritative chain-trust signal — the issuer and subject fields alone cannot detect an untrusted root.',
                  ),
                serial: z.string().describe('Certificate serial number.'),
              })
              .nullable()
              .describe(
                'Certificate details, or null when no certificate was retrieved (status "error").',
              ),
            tls: z
              .object({
                protocol: z.string().describe('Negotiated TLS version, e.g., "TLSv1.3".'),
                cipher: z.string().describe('Negotiated cipher suite name.'),
              })
              .nullable()
              .describe('TLS session details, or null when no TLS handshake completed.'),
            checked_at: z.string().describe('ISO 8601 UTC timestamp of this check.'),
            error: z
              .string()
              .nullable()
              .describe(
                'Why status is "error". Either no handshake completed — the entry has no single host (the message names the entry and the accepted shapes), the host was rejected as a private, loopback, or cloud-metadata target, a connection failure such as "getaddrinfo ENOTFOUND …" (for a server offering only TLS 1.0/1.1 that still refuses, the failure of the legacy-version attempt), or "Timed out after 5000ms" when timeout_ms ran out before a handshake completed — with cert and tls null and flags empty; or the handshake completed but the server presented no certificate, with cert null and the TLS session still reported in tls and flags. Null for every other status, including a completed handshake whose port never answered HTTP.',
              ),
          })
          .describe('Certificate inspection result for one domain.'),
      )
      .describe('Per-domain certificate inspection results.'),
    deferred_domains: z
      .array(z.string().describe('A submitted host entry, exactly as sent.'))
      .describe(
        'Host entries past the first 10, not inspected on this call, verbatim and in input order. Resend them in another call. Empty when every entry was inspected.',
      ),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Present when the call was served at a bound: hosts past the per-call cap, named in deferred_domains, or a timeout_ms over 15000 that was served as 15000. Absent otherwise.',
      ),
  },

  /**
   * Entries with no single host and SSRF-blocked hosts surface as per-domain error results
   * (status: "error") rather than as a thrown tool error.
   */

  async handler(input, ctx) {
    // The raw entries are split before normalization, so an entry with no single host takes
    // its slot as an error row and a deferred entry comes back exactly as sent.
    const domains = splitBatch(input.domains, DOMAINS_PER_CALL);
    const entries = domains.served.map((domain) => normalizeDomainInput(domain, 'tls'));
    const timeout = clampMax('timeout_ms', input.timeout_ms, TIMEOUT_MAX_MS);
    const certService = getCertService();
    const results = await certService.checkDomains(entries, input.port, timeout.value, ctx.signal);

    const notices = [
      ...(domains.deferred.length > 0
        ? [
            deferralNotice({
              cap: DOMAINS_PER_CALL,
              deferredCount: domains.deferred.length,
              field: 'deferred_domains',
              noun: 'domains',
              verb: 'inspected',
            }),
          ]
        : []),
      ...(timeout.notice ? [timeout.notice] : []),
    ];
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    ctx.log.info('Cert check completed', {
      domains: entries.length,
      ok: results.filter((r) => r.status === 'ok').length,
      warning: results.filter((r) => r.status === 'warning').length,
      critical: results.filter((r) => r.status === 'critical').length,
      error: results.filter((r) => r.status === 'error').length,
      ...(domains.deferred.length > 0 ? { deferredDomains: domains.deferred.length } : {}),
    });

    return { results, deferred_domains: domains.deferred };
  },

  format: (result) => {
    const lines: string[] = [`## Certificate Check — ${result.results.length} domain(s)`, ''];
    for (const r of result.results) {
      const icon =
        r.status === 'ok'
          ? '✅'
          : r.status === 'warning'
            ? '⚠️'
            : r.status === 'critical'
              ? '🔴'
              : '❌';
      const host = isIP(r.domain) === 6 ? `[${r.domain}]` : r.domain;
      lines.push(`### ${icon} ${host}:${r.port} — ${r.status}`);
      if (r.error) lines.push(`**Error:** ${r.error}`);
      if (r.flags.length > 0) lines.push(`**Flags:** ${r.flags.join(' | ')}`);
      if (r.cert) {
        // The names are whatever the inspected host's certificate carries.
        lines.push(`**Subject:** ${vendorInline(r.cert.subject)}`);
        lines.push(`**SANs:** ${r.cert.san.map(vendorInline).join(', ') || 'none'}`);
        lines.push(`**Issuer:** ${vendorInline(r.cert.issuer)}`);
        lines.push(
          `**Valid:** ${r.cert.valid_from} → ${r.cert.valid_until} (${r.cert.days_until_expiry} days remaining)`,
        );
        lines.push(
          `**Chain depth:** ${r.cert.chain_depth ?? 'unavailable'} | **Serial:** ${r.cert.serial}`,
        );
        if (r.cert.chain_depth_unavailable_reason) {
          lines.push(`**Chain depth unavailable:** ${r.cert.chain_depth_unavailable_reason}`);
        }
        if (r.cert.hostname_verification_error) {
          // The verifier's message quotes the certificate's names.
          lines.push(`**Hostname mismatch:** ${vendorInline(r.cert.hostname_verification_error)}`);
        }
        if (r.cert.authorization_error) {
          lines.push(`**Chain not trusted:** ${r.cert.authorization_error}`);
        }
      }
      if (r.tls) {
        lines.push(`**TLS:** ${r.tls.protocol} / ${r.tls.cipher}`);
      }
      lines.push(`*Checked: ${r.checked_at}*`);
      lines.push('');
    }
    if (result.deferred_domains.length > 0) {
      lines.push(`**Deferred domains (not inspected):** ${result.deferred_domains.join(', ')}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
