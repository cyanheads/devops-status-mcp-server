/**
 * @fileoverview Server-specific configuration for devops-status-mcp-server.
 * Parses environment variables with Zod. No API keys required.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  cacheTtlMs: z.coerce.number().default(60_000).describe('Statuspage cache TTL in milliseconds.'),
  fetchTimeoutMs: z.coerce
    .number()
    .default(8_000)
    .describe('Statuspage request timeout in milliseconds.'),
  certTimeoutMs: z.coerce
    .number()
    .default(5_000)
    .describe('TLS handshake timeout per domain in milliseconds.'),
  dnsTimeoutMs: z.coerce.number().default(3_000).describe('DNS query timeout in milliseconds.'),
  allowPrivateTargets: z
    .string()
    .optional()
    .describe(
      'When "true", disables SSRF guards for user-supplied URLs and domains. ' +
        'For trusted local/intranet deployments only. Defaults to false (guards enabled).',
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    cacheTtlMs: 'STATUS_CACHE_TTL_MS',
    fetchTimeoutMs: 'STATUS_FETCH_TIMEOUT_MS',
    certTimeoutMs: 'STATUS_CERT_TIMEOUT_MS',
    dnsTimeoutMs: 'STATUS_DNS_TIMEOUT_MS',
    allowPrivateTargets: 'STATUS_ALLOW_PRIVATE_TARGETS',
  });
  return _config;
}
