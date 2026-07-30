/**
 * @fileoverview Tests for the devops_watch_stack tool.
 * @module tests/mcp-server/tools/definitions/devops-watch-stack.tool.test
 */

import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { devopsWatchStack } from '@/mcp-server/tools/definitions/devops-watch-stack.tool.js';
import type { StatuspageSummaryResponse } from '@/services/statuspage/types.js';
import { initVendorRegistryService } from '@/services/vendor-registry/vendor-registry-service.js';

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

describe('devopsWatchStack', () => {
  it('saves vendor list on first call and returns health', async () => {
    const { _mockFetchSummary } = (await import('@/services/statuspage/statuspage-service.js')) as {
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
    const { _mockFetchSummary } = (await import('@/services/statuspage/statuspage-service.js')) as {
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
    const ctx = createMockContext({ tenantId: 'test-tenant', errors: devopsWatchStack.errors });
    const input = devopsWatchStack.input.parse({ stack_name: 'empty-stack-xyz' });
    await expect(devopsWatchStack.handler(input, ctx)).rejects.toMatchObject({
      data: {
        reason: 'no_stack',
        recovery: { hint: expect.stringContaining('Provide a vendors list') },
      },
    });
  });

  it('computes major_outage when any vendor is critical', async () => {
    const { _mockFetchSummary } = (await import('@/services/statuspage/statuspage-service.js')) as {
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
    const ctx = createMockContext({ tenantId: 'test-tenant', errors: devopsWatchStack.errors });
    const input = devopsWatchStack.input.parse({
      vendors: ['unknown-xyz-999'],
      stack_name: 'err-stack',
    });
    await expect(devopsWatchStack.handler(input, ctx)).rejects.toMatchObject({
      data: {
        reason: 'vendor_not_found',
        recovery: { hint: expect.stringContaining('devops_list_vendors') },
      },
    });
  });

  it('persists only the resolvable subset and reports what it dropped (#33)', async () => {
    const { _mockFetchSummary } = (await import('@/services/statuspage/statuspage-service.js')) as {
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
    const { total, operational, degraded, down, unavailable } = result.summary;
    expect(operational + degraded + down + unavailable).toBe(total);
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

  it('caps detailed components per vendor and discloses the omission (#36)', async () => {
    const { _mockFetchSummary } = (await import('@/services/statuspage/statuspage-service.js')) as {
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
  });

  it('formats output with health field verbatim', async () => {
    const { _mockFetchSummary } = (await import('@/services/statuspage/statuspage-service.js')) as {
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
    const { _mockFetchSummary } = (await import('@/services/statuspage/statuspage-service.js')) as {
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
    const { _mockFetchSummary } = (await import('@/services/statuspage/statuspage-service.js')) as {
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
    const { _mockFetchSummary } = (await import('@/services/statuspage/statuspage-service.js')) as {
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
    const { _mockFetchSummary } = (await import('@/services/statuspage/statuspage-service.js')) as {
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

  it('errored vendors force health = unknown, count as unavailable, and never roll up as all_operational', async () => {
    const { _mockFetchSummary } = (await import('@/services/statuspage/statuspage-service.js')) as {
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
    const { total, operational, degraded, down, unavailable } = result.summary;
    expect(operational + degraded + down + unavailable).toBe(total);

    // The rendered header must not claim green either.
    const text = (devopsWatchStack.format!(result)[0] as { text: string }).text;
    expect(text).not.toContain('all_operational');
    expect(text).toContain('unknown');
    expect(text).toContain('1 unavailable');
  });

  it('never puts a raw runtime TypeError message in a per-vendor error (#32)', async () => {
    const { _mockFetchSummary } = (await import('@/services/statuspage/statuspage-service.js')) as {
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
});
