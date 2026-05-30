/**
 * @fileoverview Tests for the status_watch_stack tool.
 * @module tests/mcp-server/tools/definitions/status-watch-stack.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { statusWatchStack } from '@/mcp-server/tools/definitions/status-watch-stack.tool.js';
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

describe('statusWatchStack', () => {
  it('saves vendor list on first call and returns health', async () => {
    const { _mockFetchSummary } = (await import('@/services/statuspage/statuspage-service.js')) as {
      _mockFetchSummary: ReturnType<typeof vi.fn>;
    };
    _mockFetchSummary.mockResolvedValue({ data: OPERATIONAL_SUMMARY, cached: false });

    const ctx = createMockContext({ tenantId: 'test-tenant', errors: statusWatchStack.errors });
    const input = statusWatchStack.input.parse({ vendors: ['github'], stack_name: 'my-stack' });
    const result = await statusWatchStack.handler(input, ctx);

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

    const ctx = createMockContext({ tenantId: 'test-tenant', errors: statusWatchStack.errors });

    // First call — saves the list
    await statusWatchStack.handler(
      statusWatchStack.input.parse({ vendors: ['github'], stack_name: 'reuse-stack' }),
      ctx,
    );

    // Second call — omit vendors, should use persisted list
    const result = await statusWatchStack.handler(
      statusWatchStack.input.parse({ stack_name: 'reuse-stack' }),
      ctx,
    );
    expect(result.stack_persisted).toBe(false);
    expect(result.vendors).toHaveLength(1);
    expect(result.vendors[0]!.vendor).toBe('github');
  });

  it('throws no_stack when no vendors provided and no saved stack', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant', errors: statusWatchStack.errors });
    const input = statusWatchStack.input.parse({ stack_name: 'empty-stack-xyz' });
    await expect(statusWatchStack.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_stack' },
    });
  });

  it('computes major_outage when any vendor is critical', async () => {
    const { _mockFetchSummary } = (await import('@/services/statuspage/statuspage-service.js')) as {
      _mockFetchSummary: ReturnType<typeof vi.fn>;
    };
    _mockFetchSummary.mockResolvedValue({ data: CRITICAL_SUMMARY, cached: false });

    const ctx = createMockContext({ tenantId: 'test-tenant', errors: statusWatchStack.errors });
    // 'cloudflare' is a known slug in the registry
    const input = statusWatchStack.input.parse({
      vendors: ['cloudflare'],
      stack_name: 'critical-stack',
    });
    const result = await statusWatchStack.handler(input, ctx);
    expect(result.health).toBe('major_outage');
    expect(result.summary.down).toBe(1);
  });

  it('throws vendor_not_found for unknown vendor', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant', errors: statusWatchStack.errors });
    const input = statusWatchStack.input.parse({
      vendors: ['unknown-xyz-999'],
      stack_name: 'err-stack',
    });
    await expect(statusWatchStack.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'vendor_not_found' },
    });
  });

  it('formats output with health field verbatim', async () => {
    const { _mockFetchSummary } = (await import('@/services/statuspage/statuspage-service.js')) as {
      _mockFetchSummary: ReturnType<typeof vi.fn>;
    };
    _mockFetchSummary.mockResolvedValue({ data: OPERATIONAL_SUMMARY, cached: false });

    const ctx = createMockContext({ tenantId: 'test-tenant', errors: statusWatchStack.errors });
    const input = statusWatchStack.input.parse({ vendors: ['github'], stack_name: 'fmt-stack' });
    const result = await statusWatchStack.handler(input, ctx);
    const blocks = statusWatchStack.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('all_operational');
    expect(text).toContain('fmt-stack');
  });

  it('accepts raw Statuspage URL as vendor and persists it in stack state', async () => {
    const { _mockFetchSummary } = (await import('@/services/statuspage/statuspage-service.js')) as {
      _mockFetchSummary: ReturnType<typeof vi.fn>;
    };
    _mockFetchSummary.mockResolvedValue({ data: OPERATIONAL_SUMMARY, cached: false });

    const ctx = createMockContext({ tenantId: 'test-url-stack', errors: statusWatchStack.errors });
    const rawUrl = 'https://status.example-internal.com';
    const input = statusWatchStack.input.parse({
      vendors: [rawUrl],
      stack_name: 'url-stack',
    });
    const result = await statusWatchStack.handler(input, ctx);

    expect(result.stack_persisted).toBe(true);
    expect(result.vendors[0]!.vendor).toBe(rawUrl);
    expect(result.vendors[0]!.statuspage_url).toBe(rawUrl);

    // Second call omitting vendors should load the raw URL from state
    const result2 = await statusWatchStack.handler(
      statusWatchStack.input.parse({ stack_name: 'url-stack' }),
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

    const ctx = createMockContext({ tenantId: 'multi-stack', errors: statusWatchStack.errors });

    await statusWatchStack.handler(
      statusWatchStack.input.parse({ vendors: ['github'], stack_name: 'prod' }),
      ctx,
    );
    await statusWatchStack.handler(
      statusWatchStack.input.parse({ vendors: ['cloudflare', 'npm'], stack_name: 'infra' }),
      ctx,
    );

    // Reading 'prod' should give only github
    const prod = await statusWatchStack.handler(
      statusWatchStack.input.parse({ stack_name: 'prod' }),
      ctx,
    );
    expect(prod.vendors).toHaveLength(1);
    expect(prod.vendors[0]!.vendor).toBe('github');

    // Reading 'infra' should give cloudflare and npm
    const infra = await statusWatchStack.handler(
      statusWatchStack.input.parse({ stack_name: 'infra' }),
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

    const ctx = createMockContext({ tenantId: 'key-fmt-test', errors: statusWatchStack.errors });
    const stackName = 'my-stack';

    // This must not throw (would throw with 'stack:my-stack' key)
    const r1 = await statusWatchStack.handler(
      statusWatchStack.input.parse({ vendors: ['github'], stack_name: stackName }),
      ctx,
    );
    expect(r1.stack_persisted).toBe(true);

    // Confirm recall works
    const r2 = await statusWatchStack.handler(
      statusWatchStack.input.parse({ stack_name: stackName }),
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
    const ctx1 = createMockContext({ tenantId: 'health-test-1', errors: statusWatchStack.errors });
    const r1 = await statusWatchStack.handler(
      statusWatchStack.input.parse({ vendors: ['github'], stack_name: 'h1' }),
      ctx1,
    );
    expect(r1.health).toBe('degraded');

    // major case
    _mockFetchSummary.mockResolvedValue({ data: MAJOR_SUMMARY, cached: false });
    const ctx2 = createMockContext({ tenantId: 'health-test-2', errors: statusWatchStack.errors });
    const r2 = await statusWatchStack.handler(
      statusWatchStack.input.parse({ vendors: ['github'], stack_name: 'h2' }),
      ctx2,
    );
    expect(r2.health).toBe('partial_outage');
  });
});
