/**
 * @fileoverview Tool to inspect SSL/TLS certificate health for one or more domains.
 * Pure node:tls — no external APIs.
 * @module mcp-server/tools/definitions/status-check-certs.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getCertService } from '@/services/cert/cert-service.js';

/** Regex for a bare hostname (no protocol). */
const PROTOCOL_RE = /^https?:\/\//i;

export const statusCheckCerts = tool('status_check_certs', {
  description:
    'Inspect SSL/TLS certificate health for one or more domains by performing a real TLS handshake. ' +
    'Works for any internet-accessible domain — no vendor registry required. ' +
    'Reports days to expiry (flagged at < 30 days warning and < 7 days critical), ' +
    'certificate subject and SANs, issuer, chain depth, TLS protocol version negotiated (flags TLS 1.0/1.1 as insecure), ' +
    'cipher suite, and HSTS presence.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    domains: z
      .array(
        z
          .string()
          .regex(
            /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/,
          )
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
      .default(5000)
      .describe(
        'Connection timeout per domain in milliseconds. Increase for slow or geographically distant endpoints.',
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
                'Overall status: ok, warning (< 30 days), critical (< 7 days or insecure TLS), or error (connection failed).',
              ),
            flags: z
              .array(z.string())
              .describe(
                'Human-readable warnings and issues found: "expires in 12 days", "TLS 1.1 in use", "self-signed certificate", "HSTS present", etc.',
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
                  .describe('Number of certificates in the chain (1 = self-signed).'),
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
      code: JsonRpcErrorCode.InvalidParams,
      when: 'A domain string contains a protocol prefix or invalid characters.',
      recovery:
        'Remove "https://" and pass the bare hostname only (e.g., "api.github.com" not "https://api.github.com").',
    },
  ],

  async handler(input, ctx) {
    // Validate no protocol prefixes slipped through (belt-and-suspenders over the regex)
    for (const domain of input.domains) {
      if (PROTOCOL_RE.test(domain)) {
        throw ctx.fail(
          'invalid_domain',
          `Domain "${domain}" must not include a protocol prefix. Pass the bare hostname (e.g., "github.com").`,
        );
      }
    }

    const timeoutMs = input.timeout_ms ?? getServerConfig().certTimeoutMs;
    const certService = getCertService();
    const results = await certService.checkDomains(input.domains, input.port, timeoutMs);

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
        lines.push(`**Chain depth:** ${r.cert.chain_depth} | **Serial:** ${r.cert.serial}`);
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
