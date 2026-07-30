/**
 * @fileoverview Tool to inspect SSL/TLS certificate health for one or more domains.
 * Pure node:tls — no external APIs.
 * @module mcp-server/tools/definitions/devops-check-certs.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getCertService } from '@/services/cert/cert-service.js';

/** Regex for a bare hostname (no protocol). */
const PROTOCOL_RE = /^https?:\/\//i;

export const devopsCheckCerts = tool('devops_check_certs', {
  description:
    'Inspect SSL/TLS certificate health for one or more domains by performing a real TLS handshake. ' +
    'Works for any internet-accessible domain — no vendor registry required. ' +
    'Reports days to expiry (flagged at < 30 days warning and < 7 days critical), ' +
    'certificate subject and SANs, issuer, hostname coverage, chain-trust verification, ' +
    'TLS protocol version negotiated (flags TLS 1.0/1.1 as insecure), cipher suite, and HSTS presence. ' +
    'The handshake completes even for a certificate clients would reject, so a broken certificate is reported rather than hidden behind a connection error: ' +
    'a hostname mismatch surfaces in cert.hostname_verification_error and a chain-trust failure (self-signed, untrusted root) in cert.authorization_error, both status "critical". ' +
    'If a domain fails to connect at all, check devops_check_dns first — the name may not resolve.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    domains: z
      .array(
        z
          .string()
          .min(1)
          .describe('Domain name without protocol (e.g., "api.github.com", "example.com").'),
      )
      .min(1)
      .max(10)
      .describe(
        'Domains to inspect. Do not include "https://" — pass the bare hostname. Up to 10 per call.',
      ),
    port: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .default(443)
      .describe(
        'TLS port. Defaults to 443. Use 8443 or custom ports for non-standard HTTPS endpoints.',
      ),
    timeout_ms: z
      .number()
      .int()
      .min(1000)
      .max(15000)
      // Lazy default — resolved at parse time from server config, so the
      // DEVOPS_STATUS_CERT_TIMEOUT_MS env var takes effect without baking a
      // value in at module load. An explicit timeout_ms always wins.
      .default(() => getServerConfig().certTimeoutMs)
      .describe(
        'Connection timeout per domain in milliseconds. Defaults to the DEVOPS_STATUS_CERT_TIMEOUT_MS env var (5000 when unset). Increase for slow or geographically distant endpoints.',
      ),
  }),

  output: z.object({
    results: z
      .array(
        z
          .object({
            domain: z.string().describe('The domain that was inspected.'),
            port: z.number().describe('The port used for the TLS connection.'),
            status: z
              .enum(['ok', 'warning', 'critical', 'error'])
              .describe(
                'Overall status. "critical" — the certificate expires in < 7 days or has already expired, the hostname is not covered by the certificate, chain verification failed (self-signed or untrusted root), or an insecure TLS version was negotiated; every one of these is rejected by ordinary clients. "warning" — expires in < 30 days. "ok" — none of the above. "error" — the connection failed and no certificate was retrieved.',
              ),
            flags: z
              .array(z.string())
              .describe(
                'Human-readable warnings and issues found: "Expires in 12 days (warning)", "Certificate expired 40 days ago", "Hostname mismatch — the certificate does not cover api.example.com; clients will reject it", "Certificate chain not trusted (SELF_SIGNED_CERT_IN_CHAIN); clients will reject it", "Self-signed certificate", "Insecure TLS version in use: TLSv1.1", "HSTS present" / "HSTS not configured".',
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
              .describe('Certificate details, or null when connection failed (error status).'),
            tls: z
              .object({
                protocol: z.string().describe('Negotiated TLS version, e.g., "TLSv1.3".'),
                cipher: z.string().describe('Negotiated cipher suite name.'),
              })
              .nullable()
              .describe('TLS session details, or null when connection failed.'),
            checked_at: z.string().describe('ISO 8601 UTC timestamp of this check.'),
            error: z
              .string()
              .nullable()
              .describe('Connection error message when status is "error".'),
          })
          .describe('Certificate inspection result for one domain.'),
      )
      .describe('Per-domain certificate inspection results.'),
  }),

  errors: [
    {
      reason: 'invalid_domain',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A domain string contains a protocol prefix or invalid characters.',
      recovery:
        'Remove "https://" and pass the bare hostname only (e.g., "api.github.com" not "https://api.github.com").',
    },
  ],
  // Note: SSRF-blocked domains surface as per-domain error results (status: "error") rather than
  // as a thrown tool error, matching the service's soft-error pattern for cert/DNS tools.

  async handler(input, ctx) {
    // Validate no protocol prefixes slipped through (belt-and-suspenders over the regex)
    for (const domain of input.domains) {
      if (PROTOCOL_RE.test(domain)) {
        throw ctx.fail(
          'invalid_domain',
          `Domain "${domain}" must not include a protocol prefix. Pass the bare hostname (e.g., "github.com").`,
          { ...ctx.recoveryFor('invalid_domain') },
        );
      }
    }

    const certService = getCertService();
    const results = await certService.checkDomains(input.domains, input.port, input.timeout_ms);

    ctx.log.info('Cert check completed', {
      domains: input.domains.length,
      ok: results.filter((r) => r.status === 'ok').length,
      warning: results.filter((r) => r.status === 'warning').length,
      critical: results.filter((r) => r.status === 'critical').length,
      error: results.filter((r) => r.status === 'error').length,
    });

    return { results };
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
      lines.push(`### ${icon} ${r.domain}:${r.port} — ${r.status}`);
      if (r.error) lines.push(`**Error:** ${r.error}`);
      if (r.flags.length > 0) lines.push(`**Flags:** ${r.flags.join(' | ')}`);
      if (r.cert) {
        lines.push(`**Subject:** ${r.cert.subject}`);
        lines.push(`**SANs:** ${r.cert.san.join(', ') || 'none'}`);
        lines.push(`**Issuer:** ${r.cert.issuer}`);
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
          lines.push(`**Hostname mismatch:** ${r.cert.hostname_verification_error}`);
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
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
