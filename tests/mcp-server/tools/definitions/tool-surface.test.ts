/**
 * @fileoverview Tests for the registered tool surface gated by
 * `DEVOPS_STATUS_DISABLE_ACTIVE_PROBES`. The two arbitrary-target probe tools
 * (`devops_check_dns`, `devops_check_certs`) are omitted when the flag is set;
 * the vendor-registry/incident tools always remain.
 * @module tests/mcp-server/tools/definitions/tool-surface.test
 */

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
