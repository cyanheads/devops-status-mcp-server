/**
 * @fileoverview Server-specific configuration for devops-status-mcp-server.
 * Parses environment variables with Zod. No API keys required.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  cacheTtlMs: z.coerce
    .number()
    .default(60_000)
    .describe('Vendor status read cache TTL (all backends) in milliseconds.'),
  fetchTimeoutMs: z.coerce
    .number()
    .default(8_000)
    .describe('Vendor status API request timeout (all backends) in milliseconds.'),
  certTimeoutMs: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(15_000)
    .default(5_000)
    .describe(
      'Default devops_check_certs timeout_ms, in milliseconds (1000-15000, the range the tool serves).',
    ),
  dnsTimeoutMs: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(10_000)
    .default(3_000)
    .describe(
      'Default devops_check_dns timeout_ms, in milliseconds (1000-10000, the range the tool serves).',
    ),
  allowPrivateTargets: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true')
    .describe(
      'When "true", disables the SSRF guards on user-supplied status-page URLs, devops_check_certs hosts, and devops_check_dns resolver IPs. For trusted local/intranet deployments only. Defaults to false (guards enabled).',
    ),
  disableActiveProbes: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true')
    .describe(
      'When "true", the arbitrary-target probe tools (devops_check_dns, devops_check_certs) are ' +
        'omitted from the registered tool surface. The five vendor-registry/incident tools remain. ' +
        'For shared/public multi-tenant instances. Defaults to false (both tools registered).',
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    cacheTtlMs: 'DEVOPS_STATUS_CACHE_TTL_MS',
    fetchTimeoutMs: 'DEVOPS_STATUS_FETCH_TIMEOUT_MS',
    certTimeoutMs: 'DEVOPS_STATUS_CERT_TIMEOUT_MS',
    dnsTimeoutMs: 'DEVOPS_STATUS_DNS_TIMEOUT_MS',
    allowPrivateTargets: 'DEVOPS_STATUS_ALLOW_PRIVATE_TARGETS',
    disableActiveProbes: 'DEVOPS_STATUS_DISABLE_ACTIVE_PROBES',
  });
  return _config;
}

/**
 * Reads only `DEVOPS_STATUS_DISABLE_ACTIVE_PROBES`, never throwing — an invalid value
 * reads as `false`. The entry point needs this flag at import to decide the tool list,
 * before `createApp()` can report a bad env var through its startup banner; the full
 * `getServerConfig()` parse runs in `setup()` and rejects the invalid value there.
 */
export function readDisableActiveProbes(): boolean {
  const parsed = ServerConfigSchema.shape.disableActiveProbes.safeParse(
    process.env.DEVOPS_STATUS_DISABLE_ACTIVE_PROBES,
  );
  return parsed.success && parsed.data;
}
