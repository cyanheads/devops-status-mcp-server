/**
 * @fileoverview Spawn tests for the `src/index.ts` entry point: an invalid server
 * env var fails through the framework's startup banner (no raw stack), and the
 * active-probe flag decides the registered tool surface and server instructions.
 * Each case runs the real entry point under Bun with stdin closed or fed a fixed
 * JSON-RPC script, bounded by a timeout.
 * @module tests/index.test
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SPAWN_TIMEOUT_MS = 20_000;
const BANNER = 'Configuration error — server failed to start';

interface SpawnResult {
  status: number | null;
  stderr: string;
  stdout: string;
}

/** Inherited env minus anything that would change the entry point's behavior. */
function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('DEVOPS_STATUS_') || key.startsWith('MCP_') || key === 'DEBUG') continue;
    env[key] = value;
  }
  return { ...env, MCP_TRANSPORT_TYPE: 'stdio', MCP_LOG_LEVEL: 'error' };
}

function runEntry(env: Record<string, string>, stdin = ''): SpawnResult {
  const result = spawnSync('bun', ['src/index.ts'], {
    cwd: REPO_ROOT,
    env: { ...baseEnv(), ...env },
    input: stdin,
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'entry-spawn-test', version: '0.0.0' },
  },
};
const INITIALIZED = { jsonrpc: '2.0', method: 'notifications/initialized' };
const TOOLS_LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

/** Runs initialize + tools/list and returns the two responses. */
function listSurface(env: Record<string, string>) {
  const script = `${[INITIALIZE, INITIALIZED, TOOLS_LIST].map((m) => JSON.stringify(m)).join('\n')}\n`;
  const result = runEntry(env, script);
  const messages = result.stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as { id?: number; result?: Record<string, unknown> });
  const init = messages.find((m) => m.id === 1)?.result as { instructions?: string } | undefined;
  const list = messages.find((m) => m.id === 2)?.result as
    | { tools: Array<{ name: string }> }
    | undefined;
  return { result, instructions: init?.instructions, toolNames: list?.tools.map((t) => t.name) };
}

describe('entry point: invalid server env vars', () => {
  it('reports a bad DEVOPS_STATUS_CACHE_TTL_MS through the startup banner and exits 1', () => {
    const { status, stderr } = runEntry({ DEVOPS_STATUS_CACHE_TTL_MS: 'abc' });
    expect(status).toBe(1);
    expect(stderr).toContain(BANNER);
    expect(stderr).toContain('DEVOPS_STATUS_CACHE_TTL_MS');
    expect(stderr).toContain('Set DEBUG=true for the full stack trace.');
    expect(stderr).not.toContain('McpError');
    expect(stderr).not.toMatch(/^\s+at /m);
  });

  it('reports a bad DEVOPS_STATUS_DISABLE_ACTIVE_PROBES through the same banner and exits 1', () => {
    const { status, stderr } = runEntry({ DEVOPS_STATUS_DISABLE_ACTIVE_PROBES: 'yes' });
    expect(status).toBe(1);
    expect(stderr).toContain(BANNER);
    expect(stderr).toContain('DEVOPS_STATUS_DISABLE_ACTIVE_PROBES');
    expect(stderr).not.toContain('McpError');
    expect(stderr).not.toMatch(/^\s+at /m);
  });

  it('adds the stack trace only under DEBUG=true', () => {
    const { status, stderr } = runEntry({ DEVOPS_STATUS_CACHE_TTL_MS: 'abc', DEBUG: 'true' });
    expect(status).toBe(1);
    expect(stderr).toContain(BANNER);
    expect(stderr).toMatch(/^\s+at .*setup/m);
  });
});

describe('entry point: active-probe flag', () => {
  const ANY_DOMAIN_SENTENCE = 'devops_check_certs and devops_check_dns work for any domain';

  it('omits the probe tools and the any-domain sentence when the flag is "true"', () => {
    const { result, instructions, toolNames } = listSurface({
      DEVOPS_STATUS_DISABLE_ACTIVE_PROBES: 'true',
    });
    expect(result.status).toBe(0);
    expect(toolNames).toBeDefined();
    expect(toolNames).not.toContain('devops_check_dns');
    expect(toolNames).not.toContain('devops_check_certs');
    expect(toolNames).toContain('devops_status_check');
    expect(instructions).toBeDefined();
    expect(instructions).not.toContain(ANY_DOMAIN_SENTENCE);
  });

  it.each([
    ['unset', {}],
    ['"false"', { DEVOPS_STATUS_DISABLE_ACTIVE_PROBES: 'false' }],
  ])('lists both probe tools when the flag is %s', (_label, env) => {
    const { result, instructions, toolNames } = listSurface(env);
    expect(result.status).toBe(0);
    expect(toolNames).toContain('devops_check_dns');
    expect(toolNames).toContain('devops_check_certs');
    expect(instructions).toContain(ANY_DOMAIN_SENTENCE);
  });

  it('separates every instructions sentence with a space', () => {
    const { instructions } = listSurface({});
    expect(instructions).toBeDefined();
    expect(instructions).not.toMatch(/[a-z)][.;][A-Z]/);
  });
});
