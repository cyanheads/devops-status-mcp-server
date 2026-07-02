/**
 * @fileoverview Regression tests for config-backed `timeout_ms` defaults on the
 * active probe tools. `DEVOPS_STATUS_CERT_TIMEOUT_MS` / `DEVOPS_STATUS_DNS_TIMEOUT_MS`
 * set the effective default at parse time; an explicit `timeout_ms` input always wins.
 * Each case resets the module registry so the lazy config singleton (and the tool
 * modules that close over it) re-parse against freshly stubbed env vars.
 * @module tests/mcp-server/tools/definitions/probe-timeout-defaults.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Re-import both tool modules fresh so the config singleton re-reads the env. */
async function loadTools() {
  vi.resetModules();
  const [certs, dns] = await Promise.all([
    import('@/mcp-server/tools/definitions/devops-check-certs.tool.js'),
    import('@/mcp-server/tools/definitions/devops-check-dns.tool.js'),
  ]);
  return { devopsCheckCerts: certs.devopsCheckCerts, devopsCheckDns: dns.devopsCheckDns };
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('devops_check_certs timeout_ms default', () => {
  it('defaults to 5000 when DEVOPS_STATUS_CERT_TIMEOUT_MS is unset', async () => {
    const { devopsCheckCerts } = await loadTools();
    const input = devopsCheckCerts.input.parse({ domains: ['example.com'] });
    expect(input.timeout_ms).toBe(5000);
  });

  it('honors DEVOPS_STATUS_CERT_TIMEOUT_MS when set', async () => {
    vi.stubEnv('DEVOPS_STATUS_CERT_TIMEOUT_MS', '9000');
    const { devopsCheckCerts } = await loadTools();
    const input = devopsCheckCerts.input.parse({ domains: ['example.com'] });
    expect(input.timeout_ms).toBe(9000);
  });

  it('explicit timeout_ms input wins over the env var', async () => {
    vi.stubEnv('DEVOPS_STATUS_CERT_TIMEOUT_MS', '9000');
    const { devopsCheckCerts } = await loadTools();
    const input = devopsCheckCerts.input.parse({ domains: ['example.com'], timeout_ms: 2000 });
    expect(input.timeout_ms).toBe(2000);
  });
});

describe('devops_check_dns timeout_ms default', () => {
  it('defaults to 3000 when DEVOPS_STATUS_DNS_TIMEOUT_MS is unset', async () => {
    const { devopsCheckDns } = await loadTools();
    const input = devopsCheckDns.input.parse({ domains: ['example.com'] });
    expect(input.timeout_ms).toBe(3000);
  });

  it('honors DEVOPS_STATUS_DNS_TIMEOUT_MS when set', async () => {
    vi.stubEnv('DEVOPS_STATUS_DNS_TIMEOUT_MS', '7000');
    const { devopsCheckDns } = await loadTools();
    const input = devopsCheckDns.input.parse({ domains: ['example.com'] });
    expect(input.timeout_ms).toBe(7000);
  });

  it('explicit timeout_ms input wins over the env var', async () => {
    vi.stubEnv('DEVOPS_STATUS_DNS_TIMEOUT_MS', '7000');
    const { devopsCheckDns } = await loadTools();
    const input = devopsCheckDns.input.parse({ domains: ['example.com'], timeout_ms: 1500 });
    expect(input.timeout_ms).toBe(1500);
  });
});
