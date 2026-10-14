/**
 * @fileoverview Tests for the devops_watch_stack tool.
 * @module tests/mcp-server/tools/definitions/devops-watch-stack.tool.test
 */

import { resetConfig } from '@cyanheads/mcp-ts-core/config';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { devopsSuggestAction } from '@/mcp-server/tools/definitions/devops-suggest-action.tool.js';
import {
  devopsWatchStack,
  stacksPersist,
} from '@/mcp-server/tools/definitions/devops-watch-stack.tool.js';
import type { StatuspageSummaryResponse } from '@/services/statuspage/types.js';
import {
  getVendorRegistryService,
  initVendorRegistryService,
} from '@/services/vendor-registry/vendor-registry-service.js';

vi.mock('@/services/statuspage/statuspage-service.js', () => {
  const mockFetchSummary = vi.fn();
  return {
    getStatuspageService: () => ({ fetchSummary: mockFetchSummary }),
    initStatuspageService: vi.fn(),
    _mockFetchSummary: mockFetchSummary,
  };
});

const OPERATIONAL_SUMMARY: StatuspageSummaryResponse = {
  page: {
    id: 'p1',
    name: 'GitHub',
    time_zone: 'UTC',
    updated_at: '',
    url: 'https://www.githubstatus.com',
  },
  status: { indicator: 'none', description: 'All Systems Operational' },
  components: [],
  incidents: [],
  scheduled_maintenances: [],
};

const CRITICAL_SUMMARY: StatuspageSummaryResponse = {
  page: {
    id: 'p2',
    name: 'AWS',
    time_zone: 'UTC',
    updated_at: '',
    url: 'https://health.aws.amazon.com',
  },
  status: { indicator: 'critical', description: 'Major Service Disruption' },
  components: [
    {
      id: 'c1',
      name: 'EC2',
      status: 'major_outage',
      group: false,
      group_id: null,
      description: null,
      position: 1,
      showcase: true,
      only_show_if_degraded: false,
      created_at: '',
      updated_at: '',
    },
  ],
  incidents: [],
  scheduled_maintenances: [],
};

beforeAll(() => {
  initVendorRegistryService();
});

/** Every vendor here is served by the mocked Statuspage service; a stray real fetch fails loudly. */
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => Promise.reject(new Error(`Unmocked fetch: ${String(input)}`))),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Open incident on an otherwise all-clear page — the case the indicator alone misses. */
function withIncident(
  name: string,
  impact: 'none' | 'minor' | 'major' | 'critical' | 'maintenance',
  startedAt: string | null,
): NonNullable<StatuspageSummaryResponse['incidents']>[number] {
  return {
    id: `i-${name}`,
    name,
    impact,
    status: 'identified',
    created_at: '2025-03-01T00:00:00Z',
    started_at: startedAt,
    resolved_at: null,
    monitoring_at: null,
    page_id: 'p',
    components: [],
    incident_updates: [],
  };
}

describe('devopsWatchStack', () => {
  it('saves vendor list on first call and returns health', async () => {
    const { _mockFetchSummary } = (await import(
      '@/services/statuspage/statuspage-service.js'
    )) as unknown as {
      _mockFetchSummary: ReturnType<typeof vi.fn>;
    };
    _mockFetchSummary.mockResolvedValue({ data: OPERATIONAL_SUMMARY, cached: false });

    const ctx = createMockContext({ tenantId: 'test-tenant', errors: devopsWatchStack.errors });
    const input = devopsWatchStack.input.parse({ vendors: ['github'], stack_name: 'my-stack' });
    const result = await devopsWatchStack.handler(input, ctx);

    expect(result.stack_name).toBe('my-stack');
    expect(result.stack_persisted).toBe(true);
    expect(result.health).toBe('all_operational');
    expect(result.vendors).toHaveLength(1);
    expect(result.vendors[0]!.vendor).toBe('github');
    expect(result.summary.total).toBe(1);
    expect(result.summary.operational).toBe(1);
  });

  it('reuses persisted vendor list on second call', async () => {
    const { _mockFetchSummary } = (await import(
      '@/services/statuspage/statuspage-service.js'
    )) as unknown as {
      _mockFetchSummary: ReturnType<typeof vi.fn>;
    };
    _mockFetchSummary.mockResolvedValue({ data: OPERATIONAL_SUMMARY, cached: false });

    const ctx = createMockContext({ tenantId: 'test-tenant', errors: devopsWatchStack.errors });

    // First call — saves the list
    await devopsWatchStack.handler(
      devopsWatchStack.input.parse({ vendors: ['github'], stack_name: 'reuse-stack' }),
      ctx,
    );

    // Second call — omit vendors, should use persisted list
    const result = await devopsWatchStack.handler(
      devopsWatchStack.input.parse({ stack_name: 'reuse-stack' }),
      ctx,
    );
    expect(result.stack_persisted).toBe(false);
    expect(result.vendors).toHaveLength(1);
    expect(result.vendors[0]!.vendor).toBe('github');
  });

  it('throws no_stack when no vendors provided and no saved stack', async () => {
    const result = await runToolContract(
      devopsWatchStack,
      { stack_name: 'empty-stack-xyz' },
      { context: { tenantId: 'test-tenant' } },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'no_stack',
          recovery: { hint: expect.stringContaining('Provide a vendors list') },
        },
      },
    });
  });

  it('computes major_outage when any vendor is critical', async () => {
    const { _mockFetchSummary } = (await import(
      '@/services/statuspage/statuspage-service.js'
    )) as unknown as {
      _mockFetchSummary: ReturnType<typeof vi.fn>;
    };
    _mockFetchSummary.mockResolvedValue({ data: CRITICAL_SUMMARY, cached: false });

    const ctx = createMockContext({ tenantId: 'test-tenant', errors: devopsWatchStack.errors });
    // 'cloudflare' is a known slug in the registry
    const input = devopsWatchStack.input.parse({
      vendors: ['cloudflare'],
      stack_name: 'critical-stack',
    });
    const result = await devopsWatchStack.handler(input, ctx);
    expect(result.health).toBe('major_outage');
    expect(result.summary.down).toBe(1);
  });

  it('throws vendor_not_found when no vendor in the stack is checkable', async () => {
    const result = await runToolContract(
      devopsWatchStack,
      { vendors: ['unknown-xyz-999'], stack_name: 'err-stack' },
      { context: { tenantId: 'test-tenant' } },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'vendor_not_found',
          recovery: { hint: expect.stringContaining('devops_list_vendors') },
        },
      },
    });
  });

  it('persists only the resolvable subset and reports what it dropped (#33)', async () => {
    const { _mockFetchSummary } = (await import(
      '@/services/statuspage/statuspage-service.js'
    )) as unknown as {
      _mockFetchSummary: ReturnType<typeof vi.fn>;
    };
    _mockFetchSummary.mockResolvedValue({ data: OPERATIONAL_SUMMARY, cached: false });

    const ctx = createMockContext({ tenantId: 'subset-stack', errors: devopsWatchStack.errors });
    const result = await devopsWatchStack.handler(
      devopsWatchStack.input.parse({
        vendors: ['github', 'unknown-xyz-999', 'cloudflare'],
        stack_name: 'subset',
      }),
      ctx,
    );

    expect(result.stack_persisted).toBe(true);
    expect(result.omitted_vendors).toEqual(['unknown-xyz-999']);
    expect(result.vendors).toHaveLength(3);
    expect(result.vendors[1]!.error).toContain('is not a known vendor slug');
    expect(result.summary.unavailable).toBe(1);
    expect(result.summary.operational).toBe(2);
    const { total, operational, degraded, down, maintenance, unavailable } = result.summary;
    expect(operational + degraded + down + maintenance + unavailable).toBe(total);
    // An unchecked vendor can never roll up green.
    expect(result.health).toBe('unknown');

    const text = (devopsWatchStack.format!(result)[0] as { text: string }).text;
    expect(text).toContain('Unusable entries:');
    expect(text).toContain('unknown-xyz-999');

    // The saved stack is the resolvable subset — the bad slug is gone for good,
    // not replayed as a permanent error row on every future sweep.
    const replay = await devopsWatchStack.handler(
      devopsWatchStack.input.parse({ stack_name: 'subset' }),
      ctx,
    );
    expect(replay.vendors.map((v) => v.vendor)).toEqual(['github', 'cloudflare']);
    expect(replay.omitted_vendors).toEqual([]);
    expect(replay.summary.unavailable).toBe(0);
    expect(replay.health).toBe('all_operational');
  });

  it('renders degraded components grouped by status through the shared renderer (#39)', async () => {
    const { _mockFetchSummary } = (await import(
      '@/services/statuspage/statuspage-service.js'
    )) as unknown as {
      _mockFetchSummary: ReturnType<typeof vi.fn>;
    };
    const component = (id: string, name: string, status: string) => ({
      id,
      name,
      status,
      group: false,
      group_id: null,
      description: null,
      position: 1,
      showcase: true,
      only_show_if_degraded: false,
      created_at: '',
      updated_at: '',
    });
    const MIXED_DEGRADED = {
      ...OPERATIONAL_SUMMARY,
      status: { indicator: 'major', description: 'Partial System Outage' },
      components: [
        component('c1', 'Git Operations', 'major_outage'),
        component('c2', 'Actions', 'partial_outage'),
        component('c3', 'Packages Registry', 'under_maintenance'),
      ],
    } as StatuspageSummaryResponse;
    _mockFetchSummary.mockResolvedValue({ data: MIXED_DEGRADED, cached: false });

    const ctx = createMockContext({ tenantId: 'degraded-stack', errors: devopsWatchStack.errors });
    const result = await devopsWatchStack.handler(
      devopsWatchStack.input.parse({ vendors: ['github'], stack_name: 'degraded' }),
      ctx,
    );
    const text = (devopsWatchStack.format!(result)[0] as { text: string }).text;

    expect(text).toContain(
      '**Degraded (3):** 1 major_outage, 1 partial_outage, 1 under_maintenance',
    );
    expect(text).toContain('- 🔴 Git Operations');
    expect(text).toContain('- ⚠️ Actions');
    expect(text).toContain('**under_maintenance (1) — scheduled window, not an outage:**');
    expect(text).toContain('- 🛠️ Packages Registry');
  });

  it('caps detailed components per vendor and discloses the omission (#36)', async () => {
    const { _mockFetchSummary } = (await import(
      '@/services/statuspage/statuspage-service.js'
    )) as unknown as {
      _mockFetchSummary: ReturnType<typeof vi.fn>;
    };
    const MANY_COMPONENTS: StatuspageSummaryResponse = {
      ...OPERATIONAL_SUMMARY,
      components: [
        {
          id: 'grp-core',
          name: 'Core Services',
          status: 'operational',
          group: true,
          position: 0,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
        ...Array.from({ length: 80 }, (_, i) => ({
          id: `cmp-${i}`,
          name: `Component ${String(i + 1).padStart(3, '0')}`,
          status: 'operational' as const,
          group: false,
          group_id: 'grp-core',
          position: i + 1,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        })),
      ],
    };
    _mockFetchSummary.mockResolvedValue({ data: MANY_COMPONENTS, cached: false });

    const ctx = createMockContext({ tenantId: 'cap-stack', errors: devopsWatchStack.errors });
    const result = await devopsWatchStack.handler(
      devopsWatchStack.input.parse({
        vendors: ['github'],
        stack_name: 'capped',
        mode: 'detailed',
      }),
      ctx,
    );

    expect(result.vendors[0]!.all_components).toHaveLength(50);
    expect(result.vendors[0]!.all_components_total).toBe(80);
    expect(getEnrichment(ctx)).toMatchObject({
      truncated: true,
      shown: 50,
      cap: 50,
      totalCount: 80,
    });
    expect((devopsWatchStack.format!(result)[0] as { text: string }).text).toContain(
      'Components (50 of 80)',
    );

    // The guidance composed alongside those counts was declared nowhere, so
    // output.extend(enrichment) — the schema behind structuredContent and the
    // content[] trailer — stripped it before it reached either surface (#24).
    const effectiveOutput = devopsWatchStack.output.extend(devopsWatchStack.enrichment!);
    const structured = effectiveOutput.parse({ ...result, ...getEnrichment(ctx) });
    expect(structured.notice).toContain('30 of 80 components are not shown');
    expect(structured.notice).toContain('component_filter');
    expect(structured.notice).toContain('component_limit');
  });

  it('formats output with health field verbatim', async () => {
    const { _mockFetchSummary } = (await import(
      '@/services/statuspage/statuspage-service.js'
    )) as unknown as {
      _mockFetchSummary: ReturnType<typeof vi.fn>;
    };
    _mockFetchSummary.mockResolvedValue({ data: OPERATIONAL_SUMMARY, cached: false });

    const ctx = createMockContext({ tenantId: 'test-tenant', errors: devopsWatchStack.errors });
    const input = devopsWatchStack.input.parse({ vendors: ['github'], stack_name: 'fmt-stack' });
    const result = await devopsWatchStack.handler(input, ctx);
    const blocks = devopsWatchStack.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('all_operational');
    expect(text).toContain('fmt-stack');
  });

  it('accepts raw Statuspage URL as vendor and persists it in stack state', async () => {
    const { _mockFetchSummary } = (await import(
      '@/services/statuspage/statuspage-service.js'
    )) as unknown as {
      _mockFetchSummary: ReturnType<typeof vi.fn>;
    };
    _mockFetchSummary.mockResolvedValue({ data: OPERATIONAL_SUMMARY, cached: false });

    const ctx = createMockContext({ tenantId: 'test-url-stack', errors: devopsWatchStack.errors });
    const rawUrl = 'https://status.example-internal.com';
    const input = devopsWatchStack.input.parse({
      vendors: [rawUrl],
      stack_name: 'url-stack',
    });
    const result = await devopsWatchStack.handler(input, ctx);

    expect(result.stack_persisted).toBe(true);
    expect(result.vendors[0]!.vendor).toBe(rawUrl);
    expect(result.vendors[0]!.statuspage_url).toBe(rawUrl);

    // Second call omitting vendors should load the raw URL from state
    const result2 = await devopsWatchStack.handler(
      devopsWatchStack.input.parse({ stack_name: 'url-stack' }),
      ctx,
    );
    expect(result2.stack_persisted).toBe(false);
    expect(result2.vendors[0]!.vendor).toBe(rawUrl);
  });

  it('two stacks are isolated in tenant state (different stack_name)', async () => {
    const { _mockFetchSummary } = (await import(
      '@/services/statuspage/statuspage-service.js'
    )) as unknown as {
      _mockFetchSummary: ReturnType<typeof vi.fn>;
    };
    _mockFetchSummary.mockResolvedValue({ data: OPERATIONAL_SUMMARY, cached: false });

    const ctx = createMockContext({ tenantId: 'multi-stack', errors: devopsWatchStack.errors });

    await devopsWatchStack.handler(
      devopsWatchStack.input.parse({ vendors: ['github'], stack_name: 'prod' }),
      ctx,
    );
    await devopsWatchStack.handler(
      devopsWatchStack.input.parse({ vendors: ['cloudflare', 'npm'], stack_name: 'infra' }),
      ctx,
    );

    // Reading 'prod' should give only github
    const prod = await devopsWatchStack.handler(
      devopsWatchStack.input.parse({ stack_name: 'prod' }),
      ctx,
    );
    expect(prod.vendors).toHaveLength(1);
    expect(prod.vendors[0]!.vendor).toBe('github');

    // Reading 'infra' should give cloudflare and npm
    const infra = await devopsWatchStack.handler(
      devopsWatchStack.input.parse({ stack_name: 'infra' }),
      ctx,
    );
    expect(infra.vendors).toHaveLength(2);
    const slugs = infra.vendors.map((v) => v.vendor);
    expect(slugs).toContain('cloudflare');
    expect(slugs).toContain('npm');
  });

  it('state key uses slash separator (not colon) — colons are invalid in ctx.state keys', async () => {
    // Regression: STACK_STATE_PREFIX was 'stack:' which violates the state store key format.
    // The key must use only alphanumeric, hyphens, underscores, dots, and slashes.
    // Verify that saving a stack (which writes to ctx.state) succeeds with the current prefix.
    const { _mockFetchSummary } = (await import(
      '@/services/statuspage/statuspage-service.js'
    )) as unknown as {
      _mockFetchSummary: ReturnType<typeof vi.fn>;
    };
    _mockFetchSummary.mockResolvedValue({ data: OPERATIONAL_SUMMARY, cached: false });

    const ctx = createMockContext({ tenantId: 'key-fmt-test', errors: devopsWatchStack.errors });
    const stackName = 'my-stack';

    // This must not throw (would throw with 'stack:my-stack' key)
    const r1 = await devopsWatchStack.handler(
      devopsWatchStack.input.parse({ vendors: ['github'], stack_name: stackName }),
      ctx,
    );
    expect(r1.stack_persisted).toBe(true);

    // Confirm recall works
    const r2 = await devopsWatchStack.handler(
      devopsWatchStack.input.parse({ stack_name: stackName }),
      ctx,
    );
    expect(r2.stack_persisted).toBe(false);
    expect(r2.vendors[0]!.vendor).toBe('github');
  });

  it('health = degraded when any vendor is minor, partial_outage when any is major', async () => {
    const { _mockFetchSummary } = (await import(
      '@/services/statuspage/statuspage-service.js'
    )) as unknown as {
      _mockFetchSummary: ReturnType<typeof vi.fn>;
    };
    const MINOR_SUMMARY = {
      ...OPERATIONAL_SUMMARY,
      status: { indicator: 'minor' as const, description: 'Minor Issues' },
    };
    const MAJOR_SUMMARY = {
      ...OPERATIONAL_SUMMARY,
      status: { indicator: 'major' as const, description: 'Major Outage' },
    };

    // minor case
    _mockFetchSummary.mockResolvedValue({ data: MINOR_SUMMARY, cached: false });
    const ctx1 = createMockContext({ tenantId: 'health-test-1', errors: devopsWatchStack.errors });
    const r1 = await devopsWatchStack.handler(
      devopsWatchStack.input.parse({ vendors: ['github'], stack_name: 'h1' }),
      ctx1,
    );
    expect(r1.health).toBe('degraded');

    // major case
    _mockFetchSummary.mockResolvedValue({ data: MAJOR_SUMMARY, cached: false });
    const ctx2 = createMockContext({ tenantId: 'health-test-2', errors: devopsWatchStack.errors });
    const r2 = await devopsWatchStack.handler(
      devopsWatchStack.input.parse({ vendors: ['github'], stack_name: 'h2' }),
      ctx2,
    );
    expect(r2.health).toBe('partial_outage');
  });

  /**
   * A vendor publishing `indicator: "maintenance"` gets its own rung: below every
   * outage rung and below unknown, above all_operational, which stays reserved for
   * a stack with nothing open at all.
   */
  describe('health rung for a vendor in a maintenance window (#44)', () => {
    const MAINTENANCE_SUMMARY: StatuspageSummaryResponse = {
      ...OPERATIONAL_SUMMARY,
      status: { indicator: 'maintenance', description: 'Under Maintenance' },
    };

    async function mockSummary() {
      return (await import('@/services/statuspage/statuspage-service.js')) as unknown as {
        _mockFetchSummary: ReturnType<typeof vi.fn>;
      };
    }

    it('rolls up as maintenance, not all_operational and not an outage', async () => {
      const { _mockFetchSummary } = await mockSummary();
      _mockFetchSummary.mockResolvedValue({ data: MAINTENANCE_SUMMARY, cached: false });

      const ctx = createMockContext({ tenantId: 'maint-stack', errors: devopsWatchStack.errors });
      const result = await devopsWatchStack.handler(
        devopsWatchStack.input.parse({ vendors: ['brevo'], stack_name: 'maint' }),
        ctx,
      );

      expect(result.health).toBe('maintenance');
      expect(result.summary.maintenance).toBe(1);
      expect(result.summary.operational).toBe(0);
      expect(result.summary.degraded).toBe(0);
      const { total, operational, degraded, down, maintenance, unavailable } = result.summary;
      expect(operational + degraded + down + maintenance + unavailable).toBe(total);
      // The rollup has to survive the declared output contract, not just the handler.
      expect(() => devopsWatchStack.output.parse(result)).not.toThrow();

      const text = (devopsWatchStack.format!(result)[0] as { text: string }).text;
      expect(text).toContain('🛠️ Stack "maint" — maintenance');
      expect(text).toContain('1 maintenance');
      expect(text).toContain('### 🛠️');
    });

    it('does not mask a real outage elsewhere in the stack', async () => {
      const { _mockFetchSummary } = await mockSummary();
      _mockFetchSummary
        .mockResolvedValueOnce({ data: MAINTENANCE_SUMMARY, cached: false })
        .mockResolvedValueOnce({ data: CRITICAL_SUMMARY, cached: false });

      const ctx = createMockContext({ tenantId: 'maint-crit', errors: devopsWatchStack.errors });
      const result = await devopsWatchStack.handler(
        devopsWatchStack.input.parse({
          vendors: ['brevo', 'cloudflare'],
          stack_name: 'maint-and-outage',
        }),
        ctx,
      );

      expect(result.health).toBe('major_outage');
      expect(result.summary.maintenance).toBe(1);
      expect(result.summary.down).toBe(1);
    });

    it('ranks below unknown — an unchecked vendor still dominates the rollup', async () => {
      const { _mockFetchSummary } = await mockSummary();
      _mockFetchSummary.mockResolvedValue({ data: MAINTENANCE_SUMMARY, cached: false });

      const ctx = createMockContext({ tenantId: 'maint-unknown', errors: devopsWatchStack.errors });
      const result = await devopsWatchStack.handler(
        devopsWatchStack.input.parse({
          vendors: ['brevo', 'unknown-xyz-999'],
          stack_name: 'maint-and-unknown',
        }),
        ctx,
      );

      expect(result.health).toBe('unknown');
      expect(result.summary.maintenance).toBe(1);
      expect(result.summary.unavailable).toBe(1);
    });
  });

  it('errored vendors force health = unknown, count as unavailable, and never roll up as all_operational', async () => {
    const { _mockFetchSummary } = (await import(
      '@/services/statuspage/statuspage-service.js'
    )) as unknown as {
      _mockFetchSummary: ReturnType<typeof vi.fn>;
    };
    // Every vendor fetch fails — the stack is uncheckable, not healthy.
    _mockFetchSummary.mockRejectedValue(
      serviceUnavailable('HTTP 404 from https://example.com/api/v2/summary.json', {
        reason: 'statuspage_unavailable',
        url: 'https://example.com/api/v2/summary.json',
        status: 404,
      }),
    );

    const ctx = createMockContext({ tenantId: 'errored-stack', errors: devopsWatchStack.errors });
    const input = devopsWatchStack.input.parse({ vendors: ['github'], stack_name: 'all-errored' });
    const result = await devopsWatchStack.handler(input, ctx);

    expect(result.health).not.toBe('all_operational');
    expect(result.health).toBe('unknown');
    // The authored contract message reaches the per-vendor field intact.
    expect(result.vendors[0]!.error).toBe('HTTP 404 from https://example.com/api/v2/summary.json');
    expect(result.summary.operational).toBe(0);
    expect(result.summary.unavailable).toBe(1);
    // Every vendor lands in exactly one bucket, so the buckets sum to total.
    const { total, operational, degraded, down, maintenance, unavailable } = result.summary;
    expect(operational + degraded + down + maintenance + unavailable).toBe(total);

    // The rendered header must not claim green either.
    const text = (devopsWatchStack.format!(result)[0] as { text: string }).text;
    expect(text).not.toContain('all_operational');
    expect(text).toContain('unknown');
    expect(text).toContain('1 unavailable');
  });

  it('never puts a raw runtime TypeError message in a per-vendor error (#32)', async () => {
    const { _mockFetchSummary } = (await import(
      '@/services/statuspage/statuspage-service.js'
    )) as unknown as {
      _mockFetchSummary: ReturnType<typeof vi.fn>;
    };
    _mockFetchSummary.mockRejectedValue(
      new TypeError("undefined is not an object (evaluating 'data.components.filter')"),
    );

    const ctx = createMockContext({ tenantId: 'typeerror-stack', errors: devopsWatchStack.errors });
    const input = devopsWatchStack.input.parse({ vendors: ['github'], stack_name: 'type-error' });
    const result = await devopsWatchStack.handler(input, ctx);

    const error = result.vendors[0]?.error ?? '';
    expect(error).not.toContain('undefined is not an object');
    expect(error).not.toContain('data.components.filter');
    expect(error).toMatch(/unexpected response/i);
    expect(result.summary.unavailable).toBe(1);
  });

  it('a failed (invalid-vendor) call does not persist the stack — no poisoned state', async () => {
    const ctx = createMockContext({ tenantId: 'poison-check', errors: devopsWatchStack.errors });

    // First call with an invalid slug throws before any state write.
    await expect(
      devopsWatchStack.handler(
        devopsWatchStack.input.parse({ vendors: ['nope-vendor'], stack_name: 'poison' }),
        ctx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'vendor_not_found' } });

    // Omitting vendors on the retry proves nothing was saved: no_stack, not a
    // replay of vendor_not_found from a persisted invalid list.
    await expect(
      devopsWatchStack.handler(devopsWatchStack.input.parse({ stack_name: 'poison' }), ctx),
    ).rejects.toMatchObject({ data: { reason: 'no_stack' } });
  });
  /**
   * `stack_name` is concatenated into a `ctx.state` key. Left unconstrained, a name
   * carrying a character the storage layer rejects surfaced as a bare "Key contains
   * invalid characters" from a layer that names neither the tool nor the parameter.
   * The schema rejects it against `stack_name` instead, before the handler runs.
   */
  describe('stack_name charset (state-key safety)', () => {
    it.each(['prod:eu', 'prod eu', 'prod..eu', 'prod//eu', '.prod', 'prod.', '/prod', ''])(
      'rejects %j at the schema rather than in storage',
      (stack_name) => {
        const parsed = devopsWatchStack.input.safeParse({ stack_name });
        expect(parsed.success).toBe(false);
      },
    );

    it.each(['default', 'production', 'data-layer', 'prod_eu', 'prod.eu', 'team/prod', 'a'])(
      'accepts %j',
      (stack_name) => {
        expect(devopsWatchStack.input.parse({ stack_name }).stack_name).toBe(stack_name);
      },
    );

    it('rejects a name past the 64-character cap', () => {
      expect(devopsWatchStack.input.safeParse({ stack_name: 'a'.repeat(65) }).success).toBe(false);
      expect(devopsWatchStack.input.safeParse({ stack_name: 'a'.repeat(64) }).success).toBe(true);
    });

    it('round-trips a dotted name through state, proving the key stays legal', async () => {
      const { _mockFetchSummary } = (await import(
        '@/services/statuspage/statuspage-service.js'
      )) as unknown as {
        _mockFetchSummary: ReturnType<typeof vi.fn>;
      };
      _mockFetchSummary.mockResolvedValue({ data: OPERATIONAL_SUMMARY, cached: false });

      const ctx = createMockContext({ tenantId: 'dotted', errors: devopsWatchStack.errors });
      const saved = await devopsWatchStack.handler(
        devopsWatchStack.input.parse({ vendors: ['github'], stack_name: 'prod.eu' }),
        ctx,
      );
      expect(saved.stack_persisted).toBe(true);

      const reused = await devopsWatchStack.handler(
        devopsWatchStack.input.parse({ stack_name: 'prod.eu' }),
        ctx,
      );
      expect(reused.stack_persisted).toBe(false);
      expect(reused.vendors).toHaveLength(1);
    });
  });

  describe('nextToolSuggestions → devops_suggest_action (#47)', () => {
    type Suggestion = { toolName: string; reason: string; args: Record<string, unknown> };

    /**
     * github: major, one component in a maintenance window. npm: indicator none with
     * an open major incident (UTC) and a later minor one (-05:00), plus an impact-none
     * incident later still. cloudflare: all clear. twilio: fetch fails.
     */
    async function serveStack() {
      const { _mockFetchSummary } = (await import(
        '@/services/statuspage/statuspage-service.js'
      )) as unknown as { _mockFetchSummary: ReturnType<typeof vi.fn> };
      const registry = getVendorRegistryService();
      const url = (slug: string) => registry.getBySlug(slug)!.statuspage_url;
      const pages = new Map<string, StatuspageSummaryResponse>([
        [
          url('github'),
          {
            ...OPERATIONAL_SUMMARY,
            status: { indicator: 'major', description: 'Partial System Outage' },
            components: [
              { ...CRITICAL_SUMMARY.components[0]!, name: 'Actions', status: 'partial_outage' },
              { ...CRITICAL_SUMMARY.components[0]!, name: 'Pages', status: 'under_maintenance' },
            ],
          },
        ],
        [
          url('npm'),
          {
            ...OPERATIONAL_SUMMARY,
            incidents: [
              withIncident('Registry 5xx', 'major', '2025-03-01T15:00:00Z'),
              // 15:30Z — later than the major one despite the earlier wall-clock hour.
              withIncident('Slow installs', 'minor', '2025-03-01T10:30:00-05:00'),
              withIncident('FYI: new docs site', 'none', '2025-03-02T00:00:00Z'),
            ],
          },
        ],
      ]);
      _mockFetchSummary.mockReset();
      _mockFetchSummary.mockImplementation((u: string) =>
        u === url('twilio')
          ? Promise.reject(
              serviceUnavailable(`HTTP 503 from ${u}`, {
                reason: 'statuspage_unavailable',
                url: u,
                status: 503,
              }),
            )
          : Promise.resolve({ data: pages.get(u) ?? OPERATIONAL_SUMMARY, cached: false }),
      );
    }

    const EXPECTED_ARGS = [
      {
        vendor: 'github',
        vendor_indicator: 'major',
        affected_components: ['Actions'],
      },
      { vendor: 'npm', incident_summary: 'Slow installs' },
    ];

    it('suggests a playbook for each problem vendor when the stack is saved', async () => {
      await serveStack();
      const ctx = createMockContext({ tenantId: 'suggest-stack', errors: devopsWatchStack.errors });
      const result = await devopsWatchStack.handler(
        devopsWatchStack.input.parse({
          vendors: ['GitHub', 'npm', 'cloudflare', 'twilio', 'unknown-xyz-999'],
          stack_name: 'suggest',
        }),
        ctx,
      );
      const suggestions = (result as { nextToolSuggestions: Suggestion[] }).nextToolSuggestions;

      expect(suggestions.map((s) => s.toolName)).toEqual([
        'devops_suggest_action',
        'devops_suggest_action',
      ]);
      expect(suggestions.map((s) => s.args)).toEqual(EXPECTED_ARGS);
      for (const s of suggestions) {
        expect(devopsSuggestAction.input.parse(s.args)).toMatchObject(s.args);
      }
      // The rollup and buckets are unchanged by the new field.
      expect(result.health).toBe('partial_outage');
      expect(result.summary).toEqual({
        total: 5,
        operational: 2,
        degraded: 1,
        down: 0,
        maintenance: 0,
        unavailable: 2,
      });
      expect(getEnrichment(ctx)).toEqual({});

      const parsed = devopsWatchStack.output.parse(result);
      const text = (devopsWatchStack.format!(parsed)[0] as { text: string }).text;
      expect(text).toContain('## Recommended Next Steps');
      for (const s of suggestions) {
        expect(text).toContain(`**Why:** ${s.reason}`);
        expect(text).toContain(`**Args:** \`${JSON.stringify(s.args)}\``);
      }
    });

    it('suggests the same playbooks when the saved stack is reused', async () => {
      await serveStack();
      const ctx = createMockContext({ tenantId: 'suggest-reuse', errors: devopsWatchStack.errors });
      await devopsWatchStack.handler(
        devopsWatchStack.input.parse({ vendors: ['GitHub', 'npm', 'cloudflare'], stack_name: 'r' }),
        ctx,
      );

      const reused = await devopsWatchStack.handler(
        devopsWatchStack.input.parse({ stack_name: 'r' }),
        ctx,
      );

      expect(reused.stack_persisted).toBe(false);
      // The saved entry is the caller's "GitHub"; the suggestion still carries the slug.
      expect(reused.vendors[0]!.vendor).toBe('GitHub');
      expect(
        (reused as { nextToolSuggestions: Suggestion[] }).nextToolSuggestions.map((s) => s.args),
      ).toEqual(EXPECTED_ARGS);
    });

    it('returns an empty list and renders no heading for an all-clear stack', async () => {
      const { _mockFetchSummary } = (await import(
        '@/services/statuspage/statuspage-service.js'
      )) as unknown as { _mockFetchSummary: ReturnType<typeof vi.fn> };
      _mockFetchSummary.mockReset();
      _mockFetchSummary.mockResolvedValue({ data: OPERATIONAL_SUMMARY, cached: false });

      const ctx = createMockContext({ tenantId: 'suggest-clear', errors: devopsWatchStack.errors });
      const result = await devopsWatchStack.handler(
        devopsWatchStack.input.parse({ vendors: ['github', 'npm'], stack_name: 'clear' }),
        ctx,
      );

      expect((result as { nextToolSuggestions: Suggestion[] }).nextToolSuggestions).toEqual([]);
      const text = (
        devopsWatchStack.format!(devopsWatchStack.output.parse(result))[0] as {
          text: string;
        }
      ).text;
      expect(text).not.toContain('Recommended Next Steps');
    });
  });
});

/**
 * Stacks are saved only where the tenant identifies the caller. Each case sets the
 * framework's transport and auth env, then re-parses its config so the tool reads the
 * deployment posture a real process would.
 */
describe('devopsWatchStack: deployment posture', () => {
  async function serveOperational() {
    const { _mockFetchSummary } = (await import(
      '@/services/statuspage/statuspage-service.js'
    )) as unknown as { _mockFetchSummary: ReturnType<typeof vi.fn> };
    _mockFetchSummary.mockReset();
    _mockFetchSummary.mockResolvedValue({ data: OPERATIONAL_SUMMARY, cached: false });
  }

  function useDeployment(env: Record<string, string>) {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    resetConfig();
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    resetConfig();
  });

  describe('HTTP without authentication', () => {
    beforeEach(() => {
      useDeployment({ MCP_TRANSPORT_TYPE: 'http', MCP_AUTH_MODE: 'none' });
    });

    it('does not save stacks', () => {
      expect(stacksPersist()).toBe(false);
    });

    it('rejects a vendors-less call with vendors_required after another call passed vendors', async () => {
      await serveOperational();
      const ctx = createMockContext({ tenantId: 'default', errors: devopsWatchStack.errors });
      const setSpy = vi.spyOn(ctx.state, 'set');
      const getSpy = vi.spyOn(ctx.state, 'get');

      const swept = await devopsWatchStack.handler(
        devopsWatchStack.input.parse({ vendors: ['github', 'cloudflare'], stack_name: 'prod.eu' }),
        ctx,
      );
      expect(swept.stack_persisted).toBe(false);

      await expect(
        devopsWatchStack.handler(devopsWatchStack.input.parse({ stack_name: 'prod.eu' }), ctx),
      ).rejects.toMatchObject({ data: { reason: 'vendors_required' } });
      expect(setSpy).not.toHaveBeenCalled();
      expect(getSpy).not.toHaveBeenCalled();
    });

    it('returns vendors_required with its recovery on both surfaces', async () => {
      const result = await runToolContract(
        devopsWatchStack,
        { stack_name: 'prod.eu' },
        { context: { tenantId: 'default' } },
      );
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          data: {
            reason: 'vendors_required',
            recovery: { hint: expect.stringContaining('Pass the vendors list on every call') },
          },
        },
      });
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('vendors_required');
      expect(text).toContain('Pass the vendors list on every call');
    });

    it('sweeps the passed vendors unchanged, with stack_persisted false and a notice on both surfaces', async () => {
      await serveOperational();
      const result = await runToolContract(
        devopsWatchStack,
        { vendors: ['github'], stack_name: 'prod.eu' },
        { context: { tenantId: 'default' } },
      );
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as {
        stack_persisted: boolean;
        persistence_notice?: string;
        vendors: Array<{ vendor: string; indicator: string }>;
        health: string;
      };
      expect(structured.stack_persisted).toBe(false);
      expect(structured.health).toBe('all_operational');
      expect(structured.vendors.map((v) => [v.vendor, v.indicator])).toEqual([['github', 'none']]);
      expect(structured.persistence_notice).toContain('does not save stacks');
      expect(structured.persistence_notice).toContain('pass vendors on every call');

      const text = result.content.map((c) => (c as { text: string }).text).join('\n');
      expect(text).toContain('does not save stacks');
      expect(text).not.toContain('Stack list saved for future calls');
    });

    it('keeps the truncation notice alongside the persistence notice', async () => {
      const { _mockFetchSummary } = (await import(
        '@/services/statuspage/statuspage-service.js'
      )) as unknown as { _mockFetchSummary: ReturnType<typeof vi.fn> };
      const many = Array.from({ length: 5 }, (_, i) => ({
        ...CRITICAL_SUMMARY.components[0]!,
        id: `c${i}`,
        name: `Component ${i}`,
        status: 'operational' as const,
      }));
      _mockFetchSummary.mockReset();
      _mockFetchSummary.mockResolvedValue({
        data: { ...OPERATIONAL_SUMMARY, components: many },
        cached: false,
      });

      const result = await runToolContract(
        devopsWatchStack,
        { vendors: ['github'], mode: 'detailed', component_limit: 2 },
        { context: { tenantId: 'default' } },
      );
      const structured = result.structuredContent as {
        notice?: string;
        persistence_notice?: string;
      };
      expect(structured.notice).toContain('3 of 5 components are not shown');
      expect(structured.persistence_notice).toContain('does not save stacks');
    });

    it('keeps a component_filter miss beside the truncation and persistence notices (#62)', async () => {
      const { _mockFetchSummary } = (await import(
        '@/services/statuspage/statuspage-service.js'
      )) as unknown as { _mockFetchSummary: ReturnType<typeof vi.fn> };
      const base = CRITICAL_SUMMARY.components[0]!;
      const grouped: StatuspageSummaryResponse = {
        ...OPERATIONAL_SUMMARY,
        components: [
          { ...base, id: 'grp-eu', name: 'Europe', status: 'operational', group: true },
          ...Array.from({ length: 4 }, (_, i) => ({
            ...base,
            id: `c${i}`,
            name: `Region ${i}`,
            status: 'operational' as const,
            group_id: 'grp-eu',
          })),
        ],
      };
      const githubUrl = getVendorRegistryService().getBySlug('github')!.statuspage_url;
      _mockFetchSummary.mockReset();
      _mockFetchSummary.mockImplementation((url: string) =>
        Promise.resolve({ data: url === githubUrl ? grouped : OPERATIONAL_SUMMARY, cached: false }),
      );

      const result = await runToolContract(
        devopsWatchStack,
        {
          vendors: ['github', 'cloudflare'],
          mode: 'detailed',
          component_filter: 'europe',
          component_limit: 2,
        },
        { context: { tenantId: 'default' } },
      );
      const structured = result.structuredContent as {
        notice?: string;
        persistence_notice?: string;
        vendors: Array<{ all_components?: Array<{ name: string; group: string | null }> }>;
      };
      expect(structured.vendors[0]!.all_components).toEqual([
        expect.objectContaining({ name: 'Region 0', group: 'Europe' }),
        expect.objectContaining({ name: 'Region 1', group: 'Europe' }),
      ]);
      expect(structured.notice).toBe(
        '2 of 4 components are not shown — component lists are capped at 2 per vendor. Set component_filter to reach a specific component, or raise component_limit. component_filter "europe" matched no component of cloudflare (0 published). It matches component and group names as a case-insensitive substring; call again without component_filter to list them.',
      );
      expect(structured.persistence_notice).toContain('does not save stacks');
      const text = result.content.map((c) => (c as { text: string }).text).join('\n');
      expect(text).toContain('- Europe / Region 0: operational');
      expect(text).toContain('matched no component of cloudflare (0 published)');
      expect(text).toContain('does not save stacks');
    });
  });

  describe('stdio', () => {
    beforeEach(() => {
      useDeployment({ MCP_TRANSPORT_TYPE: 'stdio', MCP_AUTH_MODE: 'none' });
    });

    it('saves and reuses a stack with no persistence notice', async () => {
      expect(stacksPersist()).toBe(true);
      await serveOperational();
      const ctx = createMockContext({ tenantId: 'default', errors: devopsWatchStack.errors });

      const saved = await devopsWatchStack.handler(
        devopsWatchStack.input.parse({ vendors: ['github'], stack_name: 'prod.eu' }),
        ctx,
      );
      expect(saved.stack_persisted).toBe(true);

      const reused = await devopsWatchStack.handler(
        devopsWatchStack.input.parse({ stack_name: 'prod.eu' }),
        ctx,
      );
      expect(reused.vendors.map((v) => v.vendor)).toEqual(['github']);
      expect(getEnrichment(ctx)).toEqual({});
    });
  });

  /**
   * Vendor-count bounds (#69). Where the call saves the stack, more than 20 rejects before
   * anything is saved; where it doesn't, the call is a read that checks the first 20 and
   * defers the rest. Over 100 rejects everywhere.
   */
  describe('vendor-count bounds (#69)', () => {
    const SLUGS = [
      'digitalocean',
      'linode',
      'cloudflare',
      'akamai',
      'github',
      'npm',
      'vercel',
      'netlify',
      'render',
      'fly-io',
      'circleci',
      'travis-ci',
      'snyk',
      'atlassian',
      'figma',
      'launchdarkly',
      'mongodb-atlas',
      'planetscale',
      'supabase',
      'elastic',
      'influxdb',
      'cloudinary',
      'segment',
      'discord',
      'mailgun',
    ];
    const DEFERRAL_21 =
      'Only the first 20 of 21 vendors were checked (20 per call); resend the 1 in deferred_vendors in another call.';

    type BoundsResult = {
      vendors: Array<{ vendor: string; all_components?: unknown[] }>;
      summary: { total: number; operational: number };
      stack_persisted: boolean;
      deferred_vendors: string[];
      notice?: string;
      persistence_notice?: string;
    };

    async function call(args: Record<string, unknown>) {
      // Over-cap arguments are the point, so they skip the input type.
      const result = await runToolContract(devopsWatchStack, args as never, {
        context: { tenantId: 'default' },
      });
      const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      return { result, structured: result.structuredContent as BoundsResult, text };
    }

    async function mockSummary() {
      const { _mockFetchSummary } = (await import(
        '@/services/statuspage/statuspage-service.js'
      )) as unknown as { _mockFetchSummary: ReturnType<typeof vi.fn> };
      _mockFetchSummary.mockReset();
      _mockFetchSummary.mockResolvedValue({ data: OPERATIONAL_SUMMARY, cached: false });
      return _mockFetchSummary;
    }

    describe('where stacks are saved (stdio)', () => {
      beforeEach(() => {
        useDeployment({ MCP_TRANSPORT_TYPE: 'stdio', MCP_AUTH_MODE: 'none' });
      });

      it('rejects 21 vendors with stack_too_large naming 20, before resolving or saving anything', async () => {
        const fetchSummary = await mockSummary();
        const ctx = createMockContext({ tenantId: 'default', errors: devopsWatchStack.errors });
        await devopsWatchStack.handler(
          devopsWatchStack.input.parse({ vendors: ['github'], stack_name: 'prod' }),
          ctx,
        );
        fetchSummary.mockClear();
        const setSpy = vi.spyOn(ctx.state, 'set');

        const err = await Promise.resolve(
          devopsWatchStack.handler(
            devopsWatchStack.input.parse({ vendors: SLUGS.slice(0, 21), stack_name: 'prod' }),
            ctx,
          ),
        ).catch((e: unknown) => e);

        expect(err).toMatchObject({ data: { reason: 'stack_too_large' } });
        expect((err as Error).message).toContain('21 vendors');
        expect((err as Error).message).toContain('at most 20');
        expect(setSpy).not.toHaveBeenCalled();
        expect(fetchSummary).not.toHaveBeenCalled();
        // The stack saved before is untouched.
        const reused = await devopsWatchStack.handler(
          devopsWatchStack.input.parse({ stack_name: 'prod' }),
          ctx,
        );
        expect(reused.vendors.map((v) => v.vendor)).toEqual(['github']);
      });

      it('returns stack_too_large with its recovery on both surfaces', async () => {
        await mockSummary();
        const { result, structured, text } = await call({ vendors: SLUGS.slice(0, 21) });

        expect(result.isError).toBe(true);
        expect(structured).toMatchObject({
          error: {
            data: {
              reason: 'stack_too_large',
              recovery: { hint: expect.stringContaining('at most 20') },
            },
          },
        });
        expect(text).toContain('stack_too_large');
        expect(text).toContain('at most 20');
      });

      it('saves 20 vendors with an empty deferred_vendors and no notice', async () => {
        await mockSummary();
        const { result, structured, text } = await call({ vendors: SLUGS.slice(0, 20) });

        expect(result.isError).toBeFalsy();
        expect(structured.stack_persisted).toBe(true);
        expect(structured.vendors).toHaveLength(20);
        expect(structured.deferred_vendors).toEqual([]);
        expect(structured.notice).toBeUndefined();
        expect(text).not.toContain('Deferred');
      });

      it('sweeps the first 20 of a saved stack longer than 20 and defers the rest', async () => {
        const fetchSummary = await mockSummary();
        const ctx = createMockContext({ tenantId: 'default', errors: devopsWatchStack.errors });
        // A saved stack can exceed 20 on a persistent storage backend.
        await ctx.state.set('stack/legacy', SLUGS);
        const setSpy = vi.spyOn(ctx.state, 'set');

        const result = await devopsWatchStack.handler(
          devopsWatchStack.input.parse({ stack_name: 'legacy' }),
          ctx,
        );

        expect(result.vendors.map((v) => v.vendor)).toEqual(SLUGS.slice(0, 20));
        expect(result.deferred_vendors).toEqual(SLUGS.slice(20));
        expect(result.summary.total).toBe(20);
        expect(result.stack_persisted).toBe(false);
        expect(fetchSummary).toHaveBeenCalledTimes(20);
        expect(setSpy).not.toHaveBeenCalled();

        const effective = devopsWatchStack.output.extend(devopsWatchStack.enrichment!);
        const structured = effective.parse({ ...result, ...getEnrichment(ctx) });
        expect(structured.notice).toBe(
          'Only the first 20 of 25 vendors were checked (20 per call); resend the 5 in deferred_vendors in another call. The saved stack "legacy" holds 25 vendors; save them under several stack names of at most 20 each to sweep every one.',
        );
        const text = (devopsWatchStack.format!(structured)[0] as { text: string }).text;
        expect(text).toContain(
          '**Deferred (5, not checked):** influxdb, cloudinary, segment, discord, mailgun',
        );
      });

      it('rejects more than 100 vendors at the schema, naming 100', async () => {
        const fetchSummary = await mockSummary();
        const vendors = Array.from({ length: 101 }, (_, i) => SLUGS[i % SLUGS.length]!);
        const { result, text } = await call({ vendors });

        expect(result.isError).toBe(true);
        expect(text).toMatch(/vendors\b.*<=100 items/);
        expect(fetchSummary).not.toHaveBeenCalled();
      });
    });

    describe('where stacks are not saved (HTTP without authentication)', () => {
      beforeEach(() => {
        useDeployment({ MCP_TRANSPORT_TYPE: 'http', MCP_AUTH_MODE: 'none' });
      });

      it('checks the first 20 of 21 vendors and defers the 21st, with both notices', async () => {
        const fetchSummary = await mockSummary();
        const { result, structured, text } = await call({ vendors: SLUGS.slice(0, 21) });

        expect(result.isError).toBeFalsy();
        expect(structured.vendors.map((v) => v.vendor)).toEqual(SLUGS.slice(0, 20));
        expect(structured.deferred_vendors).toEqual(['influxdb']);
        expect(structured.summary).toMatchObject({ total: 20, operational: 20 });
        expect(structured.stack_persisted).toBe(false);
        expect(fetchSummary).toHaveBeenCalledTimes(20);
        expect(structured.notice).toBe(DEFERRAL_21);
        expect(structured.persistence_notice).toContain('does not save stacks');

        expect(text).toContain('20 vendors |');
        expect(text).toContain('**Deferred (1, not checked):** influxdb');
        expect(text).toContain(DEFERRAL_21);
        expect(text).toContain('does not save stacks');
      });

      it('rejects more than 100 vendors at the schema, naming 100', async () => {
        await mockSummary();
        const vendors = Array.from({ length: 101 }, (_, i) => SLUGS[i % SLUGS.length]!);
        const { result, text } = await call({ vendors });

        expect(result.isError).toBe(true);
        expect(text).toMatch(/vendors\b.*<=100 items/);
      });

      it('composes the deferral and clamp notices with the truncation notice', async () => {
        const { _mockFetchSummary } = (await import(
          '@/services/statuspage/statuspage-service.js'
        )) as unknown as { _mockFetchSummary: ReturnType<typeof vi.fn> };
        const many = Array.from({ length: 503 }, (_, i) => ({
          ...CRITICAL_SUMMARY.components[0]!,
          id: `c${i}`,
          name: `Component ${i}`,
          status: 'operational' as const,
        }));
        _mockFetchSummary.mockReset();
        _mockFetchSummary.mockResolvedValue({
          data: { ...OPERATIONAL_SUMMARY, components: many },
          cached: false,
        });

        const { structured, text } = await call({
          vendors: SLUGS.slice(0, 21),
          mode: 'detailed',
          component_limit: 1000,
        });

        const expected = `${DEFERRAL_21} component_limit 1000 is past the maximum of 500; 500 was used. 60 of 10060 components are not shown — component lists are capped at 500 per vendor. Set component_filter to reach a specific component.`;
        expect(structured.vendors[0]!.all_components).toHaveLength(500);
        expect(structured.notice).toBe(expected);
        expect(structured.persistence_notice).toContain('does not save stacks');
        expect(text).toContain(expected);
      });
    });
  });

  describe('HTTP with JWT authentication', () => {
    beforeEach(() => {
      useDeployment({
        MCP_TRANSPORT_TYPE: 'http',
        MCP_AUTH_MODE: 'jwt',
        MCP_AUTH_SECRET_KEY: 'test-secret-key-that-is-at-least-32-characters-long',
      });
    });

    /** Isolation between tenants is the framework's, keyed by the token's `tid`. */
    it('saves and reuses a stack for the token’s tenant', async () => {
      expect(stacksPersist()).toBe(true);
      await serveOperational();
      const ctx = createMockContext({ tenantId: 'tenant-a', errors: devopsWatchStack.errors });

      const saved = await devopsWatchStack.handler(
        devopsWatchStack.input.parse({ vendors: ['github'], stack_name: 'prod.eu' }),
        ctx,
      );
      expect(saved.stack_persisted).toBe(true);

      const reused = await devopsWatchStack.handler(
        devopsWatchStack.input.parse({ stack_name: 'prod.eu' }),
        ctx,
      );
      expect(reused.vendors.map((v) => v.vendor)).toEqual(['github']);
      expect(getEnrichment(ctx)).toEqual({});
    });
  });
});
