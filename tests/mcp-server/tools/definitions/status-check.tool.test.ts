/**
 * @fileoverview Tests for the status_check tool.
 * @module tests/mcp-server/tools/definitions/status-check.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { statusCheck } from '@/mcp-server/tools/definitions/status-check.tool.js';
import type { StatuspageSummaryResponse } from '@/services/statuspage/types.js';
import { initVendorRegistryService } from '@/services/vendor-registry/vendor-registry-service.js';

// Mock the statuspage service module so no HTTP calls go out
vi.mock('@/services/statuspage/statuspage-service.js', () => {
  const mockFetchSummary = vi.fn();
  return {
    getStatuspageService: () => ({ fetchSummary: mockFetchSummary }),
    initStatuspageService: vi.fn(),
    _mockFetchSummary: mockFetchSummary,
  };
});

// Mock the SSRF guard so tests that pass raw URLs don't make real DNS calls.
// Default: passes (public URL). Individual tests override for block scenarios.
vi.mock('@/utils/ssrf-guard.js', () => ({
  assertSafeUrl: vi.fn().mockResolvedValue(undefined),
  assertSafeDomain: vi.fn().mockResolvedValue(undefined),
  assertSafeResolverIp: vi.fn(),
}));

const ALL_OPERATIONAL: StatuspageSummaryResponse = {
  page: {
    id: 'p1',
    name: 'GitHub',
    time_zone: 'UTC',
    updated_at: '2025-01-01T00:00:00Z',
    url: 'https://www.githubstatus.com',
  },
  status: { indicator: 'none', description: 'All Systems Operational' },
  components: [
    {
      id: 'c1',
      name: 'Git Operations',
      status: 'operational',
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

const DEGRADED: StatuspageSummaryResponse = {
  page: {
    id: 'p2',
    name: 'Cloudflare',
    time_zone: 'UTC',
    updated_at: '2025-01-01T00:00:00Z',
    url: 'https://www.cloudflarestatus.com',
  },
  status: { indicator: 'minor', description: 'Minor Service Disruption' },
  components: [
    {
      id: 'c2',
      name: 'CDN',
      status: 'degraded_performance',
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
  incidents: [
    {
      id: 'inc1',
      name: 'CDN Slowness',
      impact: 'minor',
      status: 'investigating',
      created_at: '2025-01-01T10:00:00Z',
      started_at: '2025-01-01T10:00:00Z',
      resolved_at: null,
      monitoring_at: null,
      page_id: 'p2',
      shortlink: 'https://stspg.io/inc1',
      components: [],
      incident_updates: [
        {
          id: 'u1',
          body: 'Investigating CDN latency spike.',
          status: 'investigating',
          created_at: '2025-01-01T10:05:00Z',
          display_at: '',
          affected_components: null,
        },
      ],
    },
  ],
  scheduled_maintenances: [],
};

beforeAll(() => {
  initVendorRegistryService();
});

describe('statusCheck', () => {
  it('returns operational result for all-clear vendor', async () => {
    const { _mockFetchSummary } = (await import('@/services/statuspage/statuspage-service.js')) as {
      _mockFetchSummary: ReturnType<typeof vi.fn>;
    };
    _mockFetchSummary.mockResolvedValue({ data: ALL_OPERATIONAL, cached: false });

    const ctx = createMockContext({ errors: statusCheck.errors });
    const input = statusCheck.input.parse({ vendors: ['github'] });
    const result = await statusCheck.handler(input, ctx);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.vendor).toBe('github');
    expect(result.results[0]!.indicator).toBe('none');
    expect(result.results[0]!.active_incidents).toHaveLength(0);
    expect(result.summary.total).toBe(1);
    expect(result.summary.operational).toBe(1);
    expect(result.summary.degraded).toBe(0);
    expect(result.summary.down).toBe(0);
  });

  it('returns degraded result with incident detail', async () => {
    const { _mockFetchSummary } = (await import('@/services/statuspage/statuspage-service.js')) as {
      _mockFetchSummary: ReturnType<typeof vi.fn>;
    };
    _mockFetchSummary.mockResolvedValue({ data: DEGRADED, cached: false });

    const ctx = createMockContext({ errors: statusCheck.errors });
    const input = statusCheck.input.parse({ vendors: ['cloudflare'] });
    const result = await statusCheck.handler(input, ctx);

    expect(result.results[0]!.indicator).toBe('minor');
    expect(result.results[0]!.degraded_components.length).toBeGreaterThan(0);
    expect(result.results[0]!.active_incidents.length).toBeGreaterThan(0);
    expect(result.results[0]!.active_incidents[0]!.id).toBe('inc1');
    expect(result.summary.degraded).toBe(1);
  });

  it('throws vendor_not_found for unknown slug', async () => {
    const ctx = createMockContext({ errors: statusCheck.errors });
    const input = statusCheck.input.parse({ vendors: ['totally-unknown-slug-xyz'] });
    await expect(statusCheck.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'vendor_not_found' },
    });
  });

  it('detailed mode adds all_components and scheduled_maintenances fields', async () => {
    const { _mockFetchSummary } = (await import('@/services/statuspage/statuspage-service.js')) as {
      _mockFetchSummary: ReturnType<typeof vi.fn>;
    };
    _mockFetchSummary.mockResolvedValue({ data: ALL_OPERATIONAL, cached: false });

    const ctx = createMockContext({ errors: statusCheck.errors });
    const input = statusCheck.input.parse({ vendors: ['github'], mode: 'detailed' });
    const result = await statusCheck.handler(input, ctx);

    expect(result.results[0]!.all_components).toBeDefined();
    expect(result.results[0]!.scheduled_maintenances).toBeDefined();
  });

  it('formats output with vendor name and indicator', async () => {
    const { _mockFetchSummary } = (await import('@/services/statuspage/statuspage-service.js')) as {
      _mockFetchSummary: ReturnType<typeof vi.fn>;
    };
    _mockFetchSummary.mockResolvedValue({ data: ALL_OPERATIONAL, cached: false });

    const ctx = createMockContext({ errors: statusCheck.errors });
    const input = statusCheck.input.parse({ vendors: ['github'] });
    const result = await statusCheck.handler(input, ctx);
    const blocks = statusCheck.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('GitHub');
    expect(text).toContain('none');
  });

  it('surfaces statuspage_unavailable when fetch rejects — other vendors still succeed', async () => {
    const { _mockFetchSummary } = (await import('@/services/statuspage/statuspage-service.js')) as {
      _mockFetchSummary: ReturnType<typeof vi.fn>;
    };
    // First call (github) succeeds, second (cloudflare) fails
    _mockFetchSummary
      .mockResolvedValueOnce({ data: ALL_OPERATIONAL, cached: false })
      .mockRejectedValueOnce(
        new Error('HTTP 503 from https://www.cloudflarestatus.com/api/v2/summary.json'),
      );

    const ctx = createMockContext({ errors: statusCheck.errors });
    const input = statusCheck.input.parse({ vendors: ['github', 'cloudflare'] });
    const result = await statusCheck.handler(input, ctx);

    // Both vendors appear — allSettled semantics
    expect(result.results).toHaveLength(2);
    expect(result.results[0]!.indicator).toBe('none'); // github ok
    // cloudflare surfaced inline with an error field
    expect(result.results[1]!.error).toBeTruthy();
    expect(result.summary.total).toBe(2);
  });

  it('accepts a raw Statuspage URL in place of a slug', async () => {
    const { _mockFetchSummary } = (await import('@/services/statuspage/statuspage-service.js')) as {
      _mockFetchSummary: ReturnType<typeof vi.fn>;
    };
    _mockFetchSummary.mockResolvedValue({ data: ALL_OPERATIONAL, cached: false });

    const ctx = createMockContext({ errors: statusCheck.errors });
    const rawUrl = 'https://www.githubstatus.com';
    const input = statusCheck.input.parse({ vendors: [rawUrl] });
    const result = await statusCheck.handler(input, ctx);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.vendor).toBe(rawUrl);
    expect(result.results[0]!.statuspage_url).toBe(rawUrl);
  });

  it('indicator: critical maps to down count in summary', async () => {
    const { _mockFetchSummary } = (await import('@/services/statuspage/statuspage-service.js')) as {
      _mockFetchSummary: ReturnType<typeof vi.fn>;
    };
    const CRITICAL_RESPONSE = {
      ...ALL_OPERATIONAL,
      status: { indicator: 'critical' as const, description: 'Major Outage' },
    };
    _mockFetchSummary.mockResolvedValue({ data: CRITICAL_RESPONSE, cached: false });

    const ctx = createMockContext({ errors: statusCheck.errors });
    const input = statusCheck.input.parse({ vendors: ['github'] });
    const result = await statusCheck.handler(input, ctx);

    expect(result.results[0]!.indicator).toBe('critical');
    expect(result.summary.down).toBe(1);
    expect(result.summary.operational).toBe(0);
  });

  it('indicator: major maps to degraded count in summary', async () => {
    const { _mockFetchSummary } = (await import('@/services/statuspage/statuspage-service.js')) as {
      _mockFetchSummary: ReturnType<typeof vi.fn>;
    };
    const MAJOR_RESPONSE = {
      ...ALL_OPERATIONAL,
      status: { indicator: 'major' as const, description: 'Major Degradation' },
    };
    _mockFetchSummary.mockResolvedValue({ data: MAJOR_RESPONSE, cached: false });

    const ctx = createMockContext({ errors: statusCheck.errors });
    const input = statusCheck.input.parse({ vendors: ['github'] });
    const result = await statusCheck.handler(input, ctx);

    expect(result.results[0]!.indicator).toBe('major');
    expect(result.summary.degraded).toBe(1);
    expect(result.summary.down).toBe(0);
  });

  it('group components are excluded from degraded_components', async () => {
    const { _mockFetchSummary } = (await import('@/services/statuspage/statuspage-service.js')) as {
      _mockFetchSummary: ReturnType<typeof vi.fn>;
    };
    const WITH_GROUP_COMPONENT = {
      ...ALL_OPERATIONAL,
      status: { indicator: 'minor' as const, description: 'Minor Degradation' },
      components: [
        {
          id: 'grp1',
          name: 'Group Header',
          status: 'partial_outage' as const,
          group: true, // group component — must be excluded
          group_id: null,
          description: null,
          position: 0,
          showcase: false,
          only_show_if_degraded: false,
          created_at: '',
          updated_at: '',
        },
        {
          id: 'c2',
          name: 'Real Component',
          status: 'degraded_performance' as const,
          group: false,
          group_id: 'grp1',
          description: null,
          position: 1,
          showcase: true,
          only_show_if_degraded: false,
          created_at: '',
          updated_at: '',
        },
      ],
    };
    _mockFetchSummary.mockResolvedValue({ data: WITH_GROUP_COMPONENT, cached: false });

    const ctx = createMockContext({ errors: statusCheck.errors });
    const input = statusCheck.input.parse({ vendors: ['github'] });
    const result = await statusCheck.handler(input, ctx);

    // Only the non-group degraded component should appear
    expect(result.results[0]!.degraded_components).toHaveLength(1);
    expect(result.results[0]!.degraded_components[0]!.name).toBe('Real Component');
  });

  describe('SSRF guard integration', () => {
    afterEach(() => vi.clearAllMocks());

    it('throws target_blocked for a raw URL that the guard rejects', async () => {
      const { assertSafeUrl } = await import('@/utils/ssrf-guard.js');
      vi.mocked(assertSafeUrl).mockRejectedValueOnce(
        new Error(
          'SSRF_BLOCKED: URL "http://169.254.169.254" resolves to 169.254.169.254 (link-local / cloud-metadata).',
        ),
      );

      const ctx = createMockContext({ errors: statusCheck.errors });
      const input = statusCheck.input.parse({ vendors: ['http://169.254.169.254'] });
      await expect(statusCheck.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'target_blocked' },
      });
    });

    it('does NOT call assertSafeUrl for registry slugs (public, pre-verified)', async () => {
      const { _mockFetchSummary } = (await import(
        '@/services/statuspage/statuspage-service.js'
      )) as {
        _mockFetchSummary: ReturnType<typeof vi.fn>;
      };
      _mockFetchSummary.mockResolvedValue({ data: ALL_OPERATIONAL, cached: false });

      const { assertSafeUrl } = await import('@/utils/ssrf-guard.js');
      const ctx = createMockContext({ errors: statusCheck.errors });
      const input = statusCheck.input.parse({ vendors: ['github'] });
      await statusCheck.handler(input, ctx);

      // Guard must not fire for registry slugs — they're pre-verified
      expect(vi.mocked(assertSafeUrl)).not.toHaveBeenCalled();
    });
  });
});
