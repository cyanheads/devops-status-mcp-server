/**
 * @fileoverview Tests for the registered tool surface gated by
 * `DEVOPS_STATUS_DISABLE_ACTIVE_PROBES`. The two arbitrary-target probe tools
 * (`devops_check_dns`, `devops_check_certs`) are omitted when the flag is set;
 * the vendor-registry/incident tools always remain. Also guards the invariant
 * behind `createApp({ sessionMode: 'stateless' })`.
 * @module tests/mcp-server/tools/definitions/tool-surface.test
 */

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ACTIVE_PROBE_TOOL_NAMES,
  allToolDefinitions,
} from '@/mcp-server/tools/definitions/index.js';

/**
 * Mirrors the gate applied in `src/index.ts`: when `disableActiveProbes` is true,
 * filter the probe tools out of the registered surface.
 */
function registeredTools(disableActiveProbes: boolean) {
  return disableActiveProbes
    ? allToolDefinitions.filter((t) => !ACTIVE_PROBE_TOOL_NAMES.has(t.name))
    : [...allToolDefinitions];
}

const ALWAYS_REGISTERED = [
  'devops_list_vendors',
  'devops_status_check',
  'devops_get_incidents',
  'devops_watch_stack',
  'devops_suggest_action',
];

describe('active-probe tool names', () => {
  it('covers exactly the two arbitrary-target probe tools', () => {
    expect([...ACTIVE_PROBE_TOOL_NAMES].sort()).toEqual(['devops_check_certs', 'devops_check_dns']);
  });
});

describe('registered tool surface', () => {
  it('includes the probe tools when the flag is unset (default behavior)', () => {
    const names = registeredTools(false).map((t) => t.name);
    expect(names).toContain('devops_check_dns');
    expect(names).toContain('devops_check_certs');
    // All seven tools registered.
    expect(names).toHaveLength(allToolDefinitions.length);
  });

  it('omits the probe tools when DISABLE_ACTIVE_PROBES is set', () => {
    const names = registeredTools(true).map((t) => t.name);
    expect(names).not.toContain('devops_check_dns');
    expect(names).not.toContain('devops_check_certs');
  });

  it('retains the five vendor-registry/incident tools when probes are disabled', () => {
    const names = registeredTools(true).map((t) => t.name);
    for (const name of ALWAYS_REGISTERED) {
      expect(names).toContain(name);
    }
    expect(names).toHaveLength(ALWAYS_REGISTERED.length);
  });
});

describe('stateless session posture', () => {
  /**
   * `src/index.ts` declares `sessionMode: 'stateless'`, which is only safe while no
   * handler suspends on `ctx.requestInput` — a 2025-era HTTP client cannot answer an
   * elicitation without a session, and nothing at startup catches the mismatch. A tool
   * that needs mid-handler input must switch the declaration to
   * `{ default: 'stateful', require: 'stateful' }` and update this test.
   * `ctx.state` is tenant-scoped storage rather than the session store, so
   * `devops_watch_stack` persisting a named stack is unaffected by the mode.
   */
  it('no tool or resource handler suspends on ctx.requestInput', () => {
    const roots = [
      new URL('../../../../src/mcp-server/tools/definitions/', import.meta.url),
      new URL('../../../../src/mcp-server/resources/definitions/', import.meta.url),
    ];
    const offenders = roots.flatMap((root) =>
      readdirSync(root)
        .filter((f) => f.endsWith('.ts'))
        .filter((f) => readFileSync(new URL(f, root), 'utf8').includes('requestInput')),
    );
    expect(offenders).toEqual([]);
  });
});

describe('tool annotations match handler behavior', () => {
  it('devops_watch_stack is not read-only — providing vendors persists stack state', () => {
    const watchStack = allToolDefinitions.find((t) => t.name === 'devops_watch_stack');
    expect(watchStack?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it('every other tool advertises readOnlyHint: true — none of them write state', () => {
    for (const t of allToolDefinitions.filter((t) => t.name !== 'devops_watch_stack')) {
      expect(t.annotations?.readOnlyHint, `${t.name} readOnlyHint`).toBe(true);
    }
  });
});
