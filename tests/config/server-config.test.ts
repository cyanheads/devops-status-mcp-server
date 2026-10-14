/**
 * @fileoverview Tests for server-config env parsing — boolean flag coercion and
 * fail-fast validation. Each case resets the module registry so the lazy
 * `_config` singleton re-parses against freshly stubbed env vars.
 * @module tests/config/server-config.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Re-import the config module fresh so `getServerConfig()`'s cached singleton is rebuilt. */
async function loadConfig() {
  vi.resetModules();
  const mod = await import('@/config/server-config.js');
  return mod.getServerConfig();
}

beforeEach(() => {
  // Start from a clean slate — no server-specific vars set.
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('allowPrivateTargets', () => {
  it('defaults to false when unset', async () => {
    const config = await loadConfig();
    expect(config.allowPrivateTargets).toBe(false);
  });

  it('parses "false" as the boolean false (not truthy-string true)', async () => {
    vi.stubEnv('DEVOPS_STATUS_ALLOW_PRIVATE_TARGETS', 'false');
    const config = await loadConfig();
    expect(config.allowPrivateTargets).toBe(false);
  });

  it('parses "true" as the boolean true', async () => {
    vi.stubEnv('DEVOPS_STATUS_ALLOW_PRIVATE_TARGETS', 'true');
    const config = await loadConfig();
    expect(config.allowPrivateTargets).toBe(true);
  });

  it('throws a ConfigurationError on an invalid value (fail fast at startup)', async () => {
    vi.stubEnv('DEVOPS_STATUS_ALLOW_PRIVATE_TARGETS', 'yes');
    await expect(loadConfig()).rejects.toMatchObject({
      code: JsonRpcErrorCode.ConfigurationError,
    });
    vi.stubEnv('DEVOPS_STATUS_ALLOW_PRIVATE_TARGETS', 'yes');
    await expect(loadConfig()).rejects.toBeInstanceOf(McpError);
  });
});

describe('probe timeouts', () => {
  it('defaults to 5000 ms for certs and 3000 ms for DNS', async () => {
    const config = await loadConfig();
    expect(config.certTimeoutMs).toBe(5000);
    expect(config.dnsTimeoutMs).toBe(3000);
  });

  it('accepts values inside the range the probe tools serve', async () => {
    vi.stubEnv('DEVOPS_STATUS_CERT_TIMEOUT_MS', '15000');
    vi.stubEnv('DEVOPS_STATUS_DNS_TIMEOUT_MS', '1000');
    const config = await loadConfig();
    expect(config.certTimeoutMs).toBe(15000);
    expect(config.dnsTimeoutMs).toBe(1000);
  });

  it.each([
    ['DEVOPS_STATUS_CERT_TIMEOUT_MS', '15001'],
    ['DEVOPS_STATUS_CERT_TIMEOUT_MS', '999'],
    ['DEVOPS_STATUS_DNS_TIMEOUT_MS', '10001'],
    ['DEVOPS_STATUS_DNS_TIMEOUT_MS', '999'],
  ])('fails at startup on %s=%s, outside the range a caller may request', async (name, value) => {
    vi.stubEnv(name, value);
    await expect(loadConfig()).rejects.toMatchObject({
      code: JsonRpcErrorCode.ConfigurationError,
    });
  });
});

describe('disableActiveProbes', () => {
  it('defaults to false when unset', async () => {
    const config = await loadConfig();
    expect(config.disableActiveProbes).toBe(false);
  });

  it('parses "false" as the boolean false', async () => {
    vi.stubEnv('DEVOPS_STATUS_DISABLE_ACTIVE_PROBES', 'false');
    const config = await loadConfig();
    expect(config.disableActiveProbes).toBe(false);
  });

  it('parses "true" as the boolean true', async () => {
    vi.stubEnv('DEVOPS_STATUS_DISABLE_ACTIVE_PROBES', 'true');
    const config = await loadConfig();
    expect(config.disableActiveProbes).toBe(true);
  });

  it('throws a ConfigurationError on an invalid value', async () => {
    vi.stubEnv('DEVOPS_STATUS_DISABLE_ACTIVE_PROBES', '1');
    await expect(loadConfig()).rejects.toMatchObject({
      code: JsonRpcErrorCode.ConfigurationError,
    });
  });
});

describe('readDisableActiveProbes', () => {
  /** Fresh import so nothing cached from another case leaks in. */
  async function readFlag() {
    vi.resetModules();
    const mod = await import('@/config/server-config.js');
    return mod.readDisableActiveProbes();
  }

  it('reads false when unset', async () => {
    expect(await readFlag()).toBe(false);
  });

  it('reads "true" as true and "false" as false', async () => {
    vi.stubEnv('DEVOPS_STATUS_DISABLE_ACTIVE_PROBES', 'true');
    expect(await readFlag()).toBe(true);
    vi.stubEnv('DEVOPS_STATUS_DISABLE_ACTIVE_PROBES', 'false');
    expect(await readFlag()).toBe(false);
  });

  it('reads an invalid value as false without throwing', async () => {
    vi.stubEnv('DEVOPS_STATUS_DISABLE_ACTIVE_PROBES', 'yes');
    expect(await readFlag()).toBe(false);
  });

  it('ignores invalid values of the other server env vars', async () => {
    vi.stubEnv('DEVOPS_STATUS_CACHE_TTL_MS', 'abc');
    vi.stubEnv('DEVOPS_STATUS_DISABLE_ACTIVE_PROBES', 'true');
    expect(await readFlag()).toBe(true);
  });
});
