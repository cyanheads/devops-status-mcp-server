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
