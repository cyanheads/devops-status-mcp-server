/**
 * @fileoverview Tests for the devops_status_check tool.
 * @module tests/mcp-server/tools/definitions/devops-status-check.tool.test
 */

import { readFileSync } from 'node:fs';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  getEnrichment,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { devopsStatusCheck } from '@/mcp-server/tools/definitions/devops-status-check.tool.js';
import { devopsSuggestAction } from '@/mcp-server/tools/definitions/devops-suggest-action.tool.js';
import type { StatuspageSummaryResponse } from '@/services/statuspage/types.js';
import {
  getVendorRegistryService,
  initVendorRegistryService,
} from '@/services/vendor-registry/vendor-registry-service.js';

// Mock the statuspage service module so no HTTP calls go out
vi.mock('@/services/statuspage/statuspage-service.js', () => {
  const mockFetchSummary = vi.fn();
  return {
    getStatuspageService: () => ({ fetchSummary: mockFetchSummary }),
    initStatuspageService: vi.fn(),
    _mockFetchSummary: mockFetchSummary,
  };
});

/**
 * Adapter-backed vendors fetch through the shared response cache, keyed by a fixed
 * feed URL; expiring entries at once lets each case serve its own feed body.
 */
vi.mock('@/config/server-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/server-config.js')>();
  return { getServerConfig: () => ({ ...actual.getServerConfig(), cacheTtlMs: -1 }) };
});

// Mock the SSRF guard so tests that pass raw URLs don't make real DNS calls.
// Default: passes (public URL). Individual tests override for block scenarios.
// Sentinel stripping stays real, since the blocked-vendor error text depends on it.
vi.mock('@/utils/ssrf-guard.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/ssrf-guard.js')>()),
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

/**
 * A page shaped the way live Statuspage pages actually serve components: a group
 * container carrying `group: true` and no `group_id`, children pointing back at it,
 * `description` omitted entirely on most entries rather than sent as null, and one
 * entry carrying a real description string.
 */
function pageWithComponents(count: number, extraNames: string[] = []): StatuspageSummaryResponse {
  const names = [
    ...Array.from({ length: count }, (_, i) => `Component ${String(i + 1).padStart(3, '0')}`),
    ...extraNames,
  ];
  return {
    ...ALL_OPERATIONAL,
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
      ...names.map((name, i) => ({
        id: `cmp-${i}`,
        name,
        status: 'operational' as const,
        group: false,
        group_id: 'grp-core',
        position: i + 1,
        showcase: true,
        only_show_if_degraded: false,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        ...(i === 0 ? { description: 'Primary request path.' } : {}),
      })),
    ],
  };
}

/**
 * A page publishing the non-operational fleet an edge network routinely has open:
 * dozens of components across several statuses, with in-progress maintenance windows
 * sitting in the same list as genuine outages.
 */
function pageWithDegradedFleet(): StatuspageSummaryResponse {
  const entries: Array<readonly [string, 'major_outage' | 'partial_outage' | 'under_maintenance']> =
    [
      ...Array.from({ length: 2 }, (_, i) => [`Edge Major ${i + 1}`, 'major_outage'] as const),
      ...Array.from(
        { length: 26 },
        (_, i) => [`Edge Partial ${String(i + 1).padStart(2, '0')}`, 'partial_outage'] as const,
      ),
      ...Array.from(
        { length: 20 },
        (_, i) => [`Edge Maint ${String(i + 1).padStart(2, '0')}`, 'under_maintenance'] as const,
      ),
    ];
  return {
    ...ALL_OPERATIONAL,
    status: { indicator: 'major', description: 'Partial System Outage' },
    components: [
      {
        id: 'grp-edge',
        name: 'Edge Network',
        status: 'major_outage',
        group: true,
        position: 0,
        created_at: '',
        updated_at: '',
      },
      ...entries.map(([name, status], i) => ({
        id: `cmp-${i}`,
        name,
        status,
        group: false,
        group_id: 'grp-edge',
        description: null,
        position: i + 1,
        showcase: true,
        only_show_if_degraded: false,
        created_at: '',
        updated_at: '',
      })),
    ],
  };
}

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

type Component = StatuspageSummaryResponse['components'][number];
type Incident = NonNullable<StatuspageSummaryResponse['incidents']>[number];

function component(name: string, status: Component['status'], group = false): Component {
  return { id: `c-${name}`, name, status, group, position: 1, created_at: '', updated_at: '' };
}

function incident(
  name: string,
  impact: Incident['impact'],
  startedAt?: string,
  status = 'investigating',
): Incident {
  return {
    id: `i-${name}`,
    name,
    impact,
    status,
    created_at: '2025-03-01T00:00:00Z',
    ...(startedAt ? { started_at: startedAt } : {}),
    resolved_at: null,
    monitoring_at: null,
    page_id: 'p',
    components: [],
    incident_updates: [
      {
        id: `u-${name}`,
        body: `${name} — update`,
        status,
        created_at: '2025-03-01T00:00:00Z',
        display_at: '',
        affected_components: null,
      },
    ],
  };
}

function page(
  name: string,
  indicator: StatuspageSummaryResponse['status']['indicator'],
  components: Component[] = [],
  incidents: Incident[] = [],
): StatuspageSummaryResponse {
  return {
    page: { id: name, name, time_zone: 'UTC', updated_at: '', url: '' },
    status: { indicator, description: `${name} is ${indicator}` },
    components,
    incidents,
    scheduled_maintenances: [],
  };
}

/**
 * A mixed batch keyed by the registry slug whose status page serves it. Qualifying:
 * github (major, mixed incident offsets and undated), npm (indicator none, open minor
 * incidents only, all undated), openai (critical, two incidents at the same instant in
 * different offsets, degraded only by a maintenance window), elastic (minor, no
 * incidents). Not qualifying: cloudflare (none; a maintenance window and an
 * impact-none incident), brevo (maintenance), twilio (fetch fails).
 */
const MIXED_PAGES: Record<string, StatuspageSummaryResponse> = {
  github: page(
    'GitHub',
    'major',
    [
      component('Git Operations', 'partial_outage'),
      component('Packages', 'under_maintenance'),
      component('Actions', 'major_outage'),
      component('Core', 'major_outage', true),
    ],
    [
      incident('Actions delays', 'minor', '2025-03-01T10:00:00Z'),
      // 11:30Z — the latest instant, though it sorts first as a string.
      incident('Git push failures', 'major', '2025-03-01T03:30:00-08:00'),
      incident('Webhook backlog', 'major'),
      incident('Informational notice', 'none', '2025-03-02T00:00:00Z'),
      incident('Database maintenance', 'maintenance', '2025-03-03T00:00:00Z'),
      incident('Old outage', 'critical', '2025-03-04T00:00:00Z', 'resolved'),
    ],
  ),
  cloudflare: page(
    'Cloudflare',
    'none',
    [component('Lisbon, Portugal - (LIS)', 'under_maintenance')],
    [incident('Scheduled network upgrade notice', 'none', '2025-03-01T00:00:00Z')],
  ),
  npm: page(
    'npm',
    'none',
    [],
    [incident('Slow package installs', 'minor'), incident('Search indexing lag', 'minor')],
  ),
  brevo: page(
    'Brevo',
    'maintenance',
    [component('Transactional Email', 'under_maintenance')],
    [incident('Planned database upgrade', 'maintenance', '2025-03-01T00:00:00Z')],
  ),
  openai: page(
    'OpenAI',
    'critical',
    [component('Fine-tuning', 'under_maintenance')],
    [
      incident('API errors', 'critical', '2025-03-01T12:00:00Z'),
      incident('ChatGPT errors', 'major', '2025-03-01T13:00:00+01:00'),
    ],
  ),
  elastic: page('Elastic', 'minor', [component('Cloud Console', 'degraded_performance')]),
};

/** Route the mocked Statuspage service by URL: MIXED_PAGES, a 503 for twilio, else all-clear. */
async function serveMixedPages() {
  const { _mockFetchSummary } = (await import(
    '@/services/statuspage/statuspage-service.js'
  )) as unknown as { _mockFetchSummary: ReturnType<typeof vi.fn> };
  const registry = getVendorRegistryService();
  const bySlugUrl = new Map(
    Object.entries(MIXED_PAGES).map(([slug, data]) => [
      registry.getBySlug(slug)!.statuspage_url,
      data,
    ]),
  );
  const twilioUrl = registry.getBySlug('twilio')!.statuspage_url;
  _mockFetchSummary.mockImplementation((url: string) => {
    if (url === twilioUrl) {
      return Promise.reject(
        serviceUnavailable(`HTTP 503 from ${url}/api/v2/summary.json`, {
          reason: 'statuspage_unavailable',
          url,
          status: 503,
        }),
      );
    }
    return Promise.resolve({ data: bySlugUrl.get(url) ?? ALL_OPERATIONAL, cached: false });
  });
}

const MIXED_VENDORS = [
  'GitHub',
  'cloudflare',
  'npm',
  'brevo',
  'twilio',
  'nope-vendor',
  'openai',
  'elastic',
  'github',
];

describe('devopsStatusCheck', () => {
  it('returns operational result for all-clear vendor', async () => {
    const { _mockFetchSummary } = (await import(
      '@/services/statuspage/statuspage-service.js'
    )) as unknown as {
      _mockFetchSummary: ReturnType<typeof vi.fn>;
    };
    _mockFetchSummary.mockResolvedValue({ data: ALL_OPERATIONAL, cached: false });

    const ctx = createMockContext({ errors: devopsStatusCheck.errors });
    const input = devopsStatusCheck.input.parse({ vendors: ['github'] });
    const result = await devopsStatusCheck.handler(input, ctx);

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
    const { _mockFetchSummary } = (await import(
      '@/services/statuspage/statuspage-service.js'
    )) as unknown as {
      _mockFetchSummary: ReturnType<typeof vi.fn>;
    };
    _mockFetchSummary.mockResolvedValue({ data: DEGRADED, cached: false });

    const ctx = createMockContext({ errors: devopsStatusCheck.errors });
    const input = devopsStatusCheck.input.parse({ vendors: ['cloudflare'] });
    const result = await devopsStatusCheck.handler(input, ctx);

    expect(result.results[0]!.indicator).toBe('minor');
    expect(result.results[0]!.degraded_components.length).toBeGreaterThan(0);
    expect(result.results[0]!.active_incidents.length).toBeGreaterThan(0);
    expect(result.results[0]!.active_incidents[0]!.id).toBe('inc1');
    expect(result.summary.degraded).toBe(1);
  });

  it('throws vendor_not_found when the only vendor is unknown — nothing to return', async () => {
    const ctx = createMockContext({ errors: devopsStatusCheck.errors });
    const input = devopsStatusCheck.input.parse({ vendors: ['totally-unknown-slug-xyz'] });
    await expect(devopsStatusCheck.handler(input, ctx)).rejects.toMatchObject({
      data: {
        reason: 'vendor_not_found',
        recovery: { hint: expect.stringContaining('devops_list_vendors') },
      },
    });
  });

  it('names every unresolvable entry when no vendor in the batch resolves (#33)', async () => {
    const ctx = createMockContext({ errors: devopsStatusCheck.errors });
    const input = devopsStatusCheck.input.parse({ vendors: ['nope-one', 'nope-two'] });
    const err = await Promise.resolve(devopsStatusCheck.handler(input, ctx)).catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    // One round trip must be enough to correct every bad entry, not just the first.
    expect((err as Error).message).toContain('nope-one');
    expect((err as Error).message).toContain('nope-two');
  });

  it('keeps the resolvable vendors when one slug is unresolvable and one URL is blocked (#33)', async () => {
    const { _mockFetchSummary } = (await import(
      '@/services/statuspage/statuspage-service.js'
    )) as unknown as {
      _mockFetchSummary: ReturnType<typeof vi.fn>;
    };
    _mockFetchSummary.mockResolvedValue({ data: ALL_OPERATIONAL, cached: false });
    const { assertSafeUrl } = await import('@/utils/ssrf-guard.js');
    vi.mocked(assertSafeUrl).mockRejectedValueOnce(
      new Error(
        'SSRF_BLOCKED: URL "http://169.254.169.254" resolves to 169.254.169.254 (link-local / cloud-metadata).',
      ),
    );

    const ctx = createMockContext({ errors: devopsStatusCheck.errors });
    const input = devopsStatusCheck.input.parse({
      vendors: ['github', 'totally-unknown-slug-xyz', 'http://169.254.169.254', 'cloudflare'],
    });
    const result = await devopsStatusCheck.handler(input, ctx);

    // Every input keeps its slot, in order.
    expect(result.results.map((r) => r.vendor)).toEqual([
      'github',
      'totally-unknown-slug-xyz',
      'http://169.254.169.254',
      'cloudflare',
    ]);
    expect(result.results[0]!.error).toBeUndefined();
    expect(result.results[1]!.error).toContain('is not a known vendor slug');
    // The blocked row carries the guard's sentence whole, internal sentinel stripped.
    expect(result.results[2]!.error).toBe(
      'URL "http://169.254.169.254" resolves to 169.254.169.254 (link-local / cloud-metadata).',
    );
    expect(result.results[3]!.error).toBeUndefined();

    expect(result.summary.total).toBe(4);
    expect(result.summary.operational).toBe(2);
    expect(result.summary.unavailable).toBe(2);
    const { total, operational, degraded, down, maintenance, unavailable } = result.summary;
    expect(operational + degraded + down + maintenance + unavailable).toBe(total);

    // The headline discloses the unavailable count instead of dropping it (#23).
    const text = (devopsStatusCheck.format!(result)[0] as { text: string }).text;
    expect(text).toContain('2 unavailable');
  });

  it('counts a failed status fetch in the unavailable bucket (#23)', async () => {
    const { _mockFetchSummary } = (await import(
      '@/services/statuspage/statuspage-service.js'
    )) as unknown as {
      _mockFetchSummary: ReturnType<typeof vi.fn>;
    };
    _mockFetchSummary.mockRejectedValue(
      serviceUnavailable('HTTP 404 from https://www.githubstatus.com/api/v2/summary.json', {
        reason: 'statuspage_unavailable',
        url: 'https://www.githubstatus.com/api/v2/summary.json',
        status: 404,
      }),
    );

    const ctx = createMockContext({ errors: devopsStatusCheck.errors });
    const input = devopsStatusCheck.input.parse({ vendors: ['github'] });
    const result = await devopsStatusCheck.handler(input, ctx);

    expect(result.summary.unavailable).toBe(1);
    const { total, operational, degraded, down, maintenance, unavailable } = result.summary;
    expect(operational + degraded + down + maintenance + unavailable).toBe(total);
    expect((devopsStatusCheck.format!(result)[0] as { text: string }).text).toContain(
      '1 unavailable',
    );
  });

  describe('degraded component rendering (#39)', () => {
    async function renderDegradedFleet() {
      const { _mockFetchSummary } = (await import(
        '@/services/statuspage/statuspage-service.js'
      )) as unknown as {
        _mockFetchSummary: ReturnType<typeof vi.fn>;
      };
      _mockFetchSummary.mockResolvedValue({ data: pageWithDegradedFleet(), cached: false });

      const ctx = createMockContext({ errors: devopsStatusCheck.errors });
      const input = devopsStatusCheck.input.parse({ vendors: ['cloudflare'] });
      const result = await devopsStatusCheck.handler(input, ctx);
      return { result, text: (devopsStatusCheck.format!(result)[0] as { text: string }).text };
    }

    it('leads with the count and the per-status breakdown', async () => {
      const { result, text } = await renderDegradedFleet();
      expect(result.results[0]!.degraded_components).toHaveLength(48);
      expect(text).toContain(
        '**Degraded (48):** 2 major_outage, 26 partial_outage, 20 under_maintenance',
      );
    });

    it('renders every component on its own line, uncapped, not one comma-joined paragraph', async () => {
      const { text } = await renderDegradedFleet();
      // The old renderer put every entry on the `**Degraded:**` line as `name (status)`.
      expect(text).not.toContain('Edge Partial 01 (partial_outage),');
      const componentLines = text
        .split('\n')
        .filter((l) => l.startsWith('- ') && l.includes('Edge'));
      // One line each, none dropped — degraded components are never capped.
      expect(componentLines).toHaveLength(48);
      expect(text).toContain('Edge Partial 01');
      expect(text).toContain('Edge Partial 26');
      expect(text).toContain('Edge Maint 20');
      expect(text).toContain('Edge Major 2');
    });

    it('marks a scheduled maintenance window apart from a genuine outage', async () => {
      const { text } = await renderDegradedFleet();
      expect(text).toContain('**under_maintenance (20) — scheduled window, not an outage:**');
      expect(text).toContain('- 🛠️ Edge Maint 01');
      expect(text).toContain('- 🔴 Edge Major 1');
      expect(text).toContain('- ⚠️ Edge Partial 01');
      // Worst first, scheduled last.
      expect(text.indexOf('**major_outage (2)')).toBeLessThan(
        text.indexOf('**partial_outage (26)'),
      );
      expect(text.indexOf('**partial_outage (26)')).toBeLessThan(
        text.indexOf('**under_maintenance (20)'),
      );
    });
  });

  it('caps detailed components per vendor and discloses the omission (#36)', async () => {
    const { _mockFetchSummary } = (await import(
      '@/services/statuspage/statuspage-service.js'
    )) as unknown as {
      _mockFetchSummary: ReturnType<typeof vi.fn>;
    };
    _mockFetchSummary.mockResolvedValue({ data: pageWithComponents(120), cached: false });

    const ctx = createMockContext({ errors: devopsStatusCheck.errors });
    const input = devopsStatusCheck.input.parse({ vendors: ['github'], mode: 'detailed' });
    const result = await devopsStatusCheck.handler(input, ctx);

    // The group container is not a component and never counts toward the total.
    expect(result.results[0]!.all_components).toHaveLength(50);
    expect(result.results[0]!.all_components_total).toBe(120);
    expect(getEnrichment(ctx)).toMatchObject({
      truncated: true,
      shown: 50,
      cap: 50,
      totalCount: 120,
    });

    const text = (devopsStatusCheck.format!(result)[0] as { text: string }).text;
    expect(text).toContain('Components (50 of 120)');
  });

  it('the capped-component guidance survives the effective-output parse (#24)', async () => {
    // fetchVendorResults always composed guidance for the cap, but the enrichment
    // block declared no `notice`, so output.extend(enrichment) — the schema behind
    // structuredContent and the content[] trailer — stripped it before either surface.
    const { _mockFetchSummary } = (await import(
      '@/services/statuspage/statuspage-service.js'
    )) as unknown as {
      _mockFetchSummary: ReturnType<typeof vi.fn>;
    };
    _mockFetchSummary.mockResolvedValue({ data: pageWithComponents(120), cached: false });

    const ctx = createMockContext({ errors: devopsStatusCheck.errors });
    const input = devopsStatusCheck.input.parse({ vendors: ['github'], mode: 'detailed' });
    const result = await devopsStatusCheck.handler(input, ctx);

    const effectiveOutput = devopsStatusCheck.output.extend(devopsStatusCheck.enrichment!);
    const structured = effectiveOutput.parse({ ...result, ...getEnrichment(ctx) });

    expect(structured.notice).toContain('70 of 120 components are not shown');
    // Names both ways past the cap, so the guidance is actionable on its own.
    expect(structured.notice).toContain('component_filter');
    expect(structured.notice).toContain('component_limit');
  });

  it('component_filter reaches a component the cap would have dropped (#36)', async () => {
    const { _mockFetchSummary } = (await import(
      '@/services/statuspage/statuspage-service.js'
    )) as unknown as {
      _mockFetchSummary: ReturnType<typeof vi.fn>;
    };
    // The named component sits past the default cap, so only the filter can reach it.
    _mockFetchSummary.mockResolvedValue({
      data: pageWithComponents(120, ['Webhook Delivery']),
      cached: false,
    });

    const ctx = createMockContext({ errors: devopsStatusCheck.errors });
    const input = devopsStatusCheck.input.parse({
      vendors: ['github'],
      mode: 'detailed',
      component_filter: 'webhook',
    });
    const result = await devopsStatusCheck.handler(input, ctx);

    expect(result.results[0]!.all_components?.map((c) => c.name)).toEqual(['Webhook Delivery']);
    expect(result.results[0]!.all_components_total).toBe(1);
    // Nothing was dropped, so nothing is disclosed.
    expect(getEnrichment(ctx)).toEqual({});
  });

  it('component_limit raises the cap and clears the truncation signal (#36)', async () => {
    const { _mockFetchSummary } = (await import(
      '@/services/statuspage/statuspage-service.js'
    )) as unknown as {
      _mockFetchSummary: ReturnType<typeof vi.fn>;
    };
    _mockFetchSummary.mockResolvedValue({ data: pageWithComponents(120), cached: false });

    const ctx = createMockContext({ errors: devopsStatusCheck.errors });
    const input = devopsStatusCheck.input.parse({
      vendors: ['github'],
      mode: 'detailed',
      component_limit: 200,
    });
    const result = await devopsStatusCheck.handler(input, ctx);

    expect(result.results[0]!.all_components).toHaveLength(120);
    expect(result.results[0]!.all_components_total).toBe(120);
    expect(getEnrichment(ctx)).toEqual({});

    // Uncapped results carry no enrichment, so the effective output must still parse.
    const effectiveOutput = devopsStatusCheck.output.extend(devopsStatusCheck.enrichment!);
    expect(() => effectiveOutput.parse({ ...result, ...getEnrichment(ctx) })).not.toThrow();
  });

  it('detailed mode adds all_components and scheduled_maintenances fields', async () => {
    const { _mockFetchSummary } = (await import(
      '@/services/statuspage/statuspage-service.js'
    )) as unknown as {
      _mockFetchSummary: ReturnType<typeof vi.fn>;
    };
    _mockFetchSummary.mockResolvedValue({ data: ALL_OPERATIONAL, cached: false });

    const ctx = createMockContext({ errors: devopsStatusCheck.errors });
    const input = devopsStatusCheck.input.parse({ vendors: ['github'], mode: 'detailed' });
    const result = await devopsStatusCheck.handler(input, ctx);

    expect(result.results[0]!.all_components).toBeDefined();
    expect(result.results[0]!.scheduled_maintenances).toBeDefined();
  });

  it('formats output with vendor name and indicator', async () => {
    const { _mockFetchSummary } = (await import(
      '@/services/statuspage/statuspage-service.js'
    )) as unknown as {
      _mockFetchSummary: ReturnType<typeof vi.fn>;
    };
    _mockFetchSummary.mockResolvedValue({ data: ALL_OPERATIONAL, cached: false });

    const ctx = createMockContext({ errors: devopsStatusCheck.errors });
    const input = devopsStatusCheck.input.parse({ vendors: ['github'] });
    const result = await devopsStatusCheck.handler(input, ctx);
    const blocks = devopsStatusCheck.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('GitHub');
    expect(text).toContain('none');
  });

  it('reports an unreachable vendor inline while other vendors still succeed', async () => {
    const { _mockFetchSummary } = (await import(
      '@/services/statuspage/statuspage-service.js'
    )) as unknown as {
      _mockFetchSummary: ReturnType<typeof vi.fn>;
    };
    // First call (github) succeeds, second (cloudflare) fails the way the service
    // layer now fails: a contract-carrying McpError, not a bare Error.
    _mockFetchSummary
      .mockResolvedValueOnce({ data: ALL_OPERATIONAL, cached: false })
      .mockRejectedValueOnce(
        serviceUnavailable('HTTP 503 from https://www.cloudflarestatus.com/api/v2/summary.json', {
          reason: 'statuspage_unavailable',
          url: 'https://www.cloudflarestatus.com/api/v2/summary.json',
          status: 503,
        }),
      );

    const ctx = createMockContext({ errors: devopsStatusCheck.errors });
    const input = devopsStatusCheck.input.parse({ vendors: ['github', 'cloudflare'] });
    const result = await devopsStatusCheck.handler(input, ctx);

    // Both vendors appear — allSettled semantics
    expect(result.results).toHaveLength(2);
    expect(result.results[0]!.indicator).toBe('none'); // github ok
    // The authored message reaches the caller intact, naming status and URL.
    expect(result.results[1]!.error).toBe(
      'HTTP 503 from https://www.cloudflarestatus.com/api/v2/summary.json',
    );
    expect(result.summary.total).toBe(2);
    expect(result.summary.operational).toBe(1);
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

    const ctx = createMockContext({ errors: devopsStatusCheck.errors });
    const input = devopsStatusCheck.input.parse({ vendors: ['github'] });
    const result = await devopsStatusCheck.handler(input, ctx);

    const error = result.results[0]?.error ?? '';
    expect(error).not.toContain('undefined is not an object');
    expect(error).not.toContain('data.components.filter');
    expect(error).toMatch(/unexpected response/i);
    // Still counted as unchecked, not as operational.
    expect(result.summary.operational).toBe(0);
  });

  it('does not declare a statuspage_unavailable contract it can never throw (#32)', () => {
    // Every vendor is fetched under Promise.allSettled, so an unreachable vendor is
    // reported in that vendor's `error` field and never surfaces as a JSON-RPC error.
    const reasons = devopsStatusCheck.errors?.map((e) => e.reason) ?? [];
    expect(reasons).not.toContain('statuspage_unavailable');
    expect(reasons).toEqual(expect.arrayContaining(['vendor_not_found', 'target_blocked']));
  });

  it('accepts a raw Statuspage URL in place of a slug', async () => {
    const { _mockFetchSummary } = (await import(
      '@/services/statuspage/statuspage-service.js'
    )) as unknown as {
      _mockFetchSummary: ReturnType<typeof vi.fn>;
    };
    _mockFetchSummary.mockResolvedValue({ data: ALL_OPERATIONAL, cached: false });

    const ctx = createMockContext({ errors: devopsStatusCheck.errors });
    const rawUrl = 'https://www.githubstatus.com';
    const input = devopsStatusCheck.input.parse({ vendors: [rawUrl] });
    const result = await devopsStatusCheck.handler(input, ctx);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.vendor).toBe(rawUrl);
    expect(result.results[0]!.statuspage_url).toBe(rawUrl);
  });

  it('indicator: critical maps to down count in summary', async () => {
    const { _mockFetchSummary } = (await import(
      '@/services/statuspage/statuspage-service.js'
    )) as unknown as {
      _mockFetchSummary: ReturnType<typeof vi.fn>;
    };
    const CRITICAL_RESPONSE = {
      ...ALL_OPERATIONAL,
      status: { indicator: 'critical' as const, description: 'Major Outage' },
    };
    _mockFetchSummary.mockResolvedValue({ data: CRITICAL_RESPONSE, cached: false });

    const ctx = createMockContext({ errors: devopsStatusCheck.errors });
    const input = devopsStatusCheck.input.parse({ vendors: ['github'] });
    const result = await devopsStatusCheck.handler(input, ctx);

    expect(result.results[0]!.indicator).toBe('critical');
    expect(result.summary.down).toBe(1);
    expect(result.summary.operational).toBe(0);
  });

  /**
   * A page publishes `indicator: "maintenance"` while a window is open. It is
   * neither a fault nor all-clear, so it carries through to its own bucket and
   * its own icon rather than being folded into an existing one.
   */
  describe('indicator: maintenance (#44)', () => {
    const MAINTENANCE_RESPONSE: StatuspageSummaryResponse = {
      ...ALL_OPERATIONAL,
      status: { indicator: 'maintenance', description: 'Under Maintenance' },
      components: [
        {
          id: 'c1',
          name: 'Transactional Email',
          status: 'under_maintenance',
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
    };

    async function checkMaintenanceVendor() {
      const { _mockFetchSummary } = (await import(
        '@/services/statuspage/statuspage-service.js'
      )) as unknown as {
        _mockFetchSummary: ReturnType<typeof vi.fn>;
      };
      _mockFetchSummary.mockResolvedValue({ data: MAINTENANCE_RESPONSE, cached: false });

      const ctx = createMockContext({ errors: devopsStatusCheck.errors });
      const input = devopsStatusCheck.input.parse({ vendors: ['brevo'] });
      return await devopsStatusCheck.handler(input, ctx);
    }

    it('carries the published indicator through to the caller, unmapped', async () => {
      const result = await checkMaintenanceVendor();

      expect(result.results[0]!.indicator).toBe('maintenance');
      expect(result.results[0]!.description).toBe('Under Maintenance');
      expect(result.results[0]!.error).toBeUndefined();
      // The value has to survive the declared output contract, not just the handler.
      expect(() => devopsStatusCheck.output.parse(result)).not.toThrow();
    });

    it('lands in the maintenance bucket only, and the buckets still partition', async () => {
      const result = await checkMaintenanceVendor();

      expect(result.summary.maintenance).toBe(1);
      expect(result.summary.operational).toBe(0);
      expect(result.summary.degraded).toBe(0);
      expect(result.summary.down).toBe(0);
      expect(result.summary.unavailable).toBe(0);
      const { total, operational, degraded, down, maintenance, unavailable } = result.summary;
      expect(operational + degraded + down + maintenance + unavailable).toBe(total);
    });

    it('renders with the scheduled-window icon and discloses the count', async () => {
      const result = await checkMaintenanceVendor();
      const text = (devopsStatusCheck.format!(result)[0] as { text: string }).text;

      // Same glyph the degraded-component list marks a scheduled window with.
      expect(text).toContain('### 🛠️');
      expect(text).toContain('**Indicator:** maintenance');
      expect(text).toContain('1 maintenance');
      // Not an outage and not all clear.
      expect(text).not.toContain('### 🔴');
      expect(text).not.toContain('### ✅');
    });
  });

  it('indicator: major maps to degraded count in summary', async () => {
    const { _mockFetchSummary } = (await import(
      '@/services/statuspage/statuspage-service.js'
    )) as unknown as {
      _mockFetchSummary: ReturnType<typeof vi.fn>;
    };
    const MAJOR_RESPONSE = {
      ...ALL_OPERATIONAL,
      status: { indicator: 'major' as const, description: 'Major Degradation' },
    };
    _mockFetchSummary.mockResolvedValue({ data: MAJOR_RESPONSE, cached: false });

    const ctx = createMockContext({ errors: devopsStatusCheck.errors });
    const input = devopsStatusCheck.input.parse({ vendors: ['github'] });
    const result = await devopsStatusCheck.handler(input, ctx);

    expect(result.results[0]!.indicator).toBe('major');
    expect(result.summary.degraded).toBe(1);
    expect(result.summary.down).toBe(0);
  });

  it('group components are excluded from degraded_components', async () => {
    const { _mockFetchSummary } = (await import(
      '@/services/statuspage/statuspage-service.js'
    )) as unknown as {
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

    const ctx = createMockContext({ errors: devopsStatusCheck.errors });
    const input = devopsStatusCheck.input.parse({ vendors: ['github'] });
    const result = await devopsStatusCheck.handler(input, ctx);

    // Only the non-group degraded component should appear
    expect(result.results[0]!.degraded_components).toHaveLength(1);
    expect(result.results[0]!.degraded_components[0]!.name).toBe('Real Component');
  });

  it('adapter-backed vendor (aws) resolves without touching the Statuspage service (#12)', async () => {
    // The aws slug dispatches to the AWS Health adapter — global fetch serves the
    // (UTF-16) feed and the mocked Statuspage service must stay untouched.
    const { _mockFetchSummary } = (await import(
      '@/services/statuspage/statuspage-service.js'
    )) as unknown as {
      _mockFetchSummary: ReturnType<typeof vi.fn>;
    };
    _mockFetchSummary.mockClear();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(new Uint8Array(Buffer.from('[]', 'utf16le')).buffer),
      }),
    );
    try {
      const ctx = createMockContext({ errors: devopsStatusCheck.errors });
      const input = devopsStatusCheck.input.parse({ vendors: ['aws'] });
      const result = await devopsStatusCheck.handler(input, ctx);

      expect(result.results[0]!.indicator).toBe('none');
      expect(result.results[0]!.name).toBe('Amazon Web Services');
      expect(result.results[0]!.error).toBeUndefined();
      expect(_mockFetchSummary).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
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

      const ctx = createMockContext({ errors: devopsStatusCheck.errors });
      const input = devopsStatusCheck.input.parse({ vendors: ['http://169.254.169.254'] });
      await expect(devopsStatusCheck.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'target_blocked' },
        message:
          'None of the 1 requested vendors could be checked. URL "http://169.254.169.254" resolves to 169.254.169.254 (link-local / cloud-metadata).',
      });
    });

    it('does NOT call assertSafeUrl for registry slugs (public, pre-verified)', async () => {
      const { _mockFetchSummary } = (await import(
        '@/services/statuspage/statuspage-service.js'
      )) as unknown as {
        _mockFetchSummary: ReturnType<typeof vi.fn>;
      };
      _mockFetchSummary.mockResolvedValue({ data: ALL_OPERATIONAL, cached: false });

      const { assertSafeUrl } = await import('@/utils/ssrf-guard.js');
      const ctx = createMockContext({ errors: devopsStatusCheck.errors });
      const input = devopsStatusCheck.input.parse({ vendors: ['github'] });
      await devopsStatusCheck.handler(input, ctx);

      // Guard must not fire for registry slugs — they're pre-verified
      expect(vi.mocked(assertSafeUrl)).not.toHaveBeenCalled();
    });

    /**
     * Several live pages omit `incidents` / `scheduled_maintenances` rather than
     * sending `[]`. Dereferencing them unguarded throws a TypeError that
     * `Promise.allSettled` turns into a per-vendor failure on a healthy page.
     */
    it('reports a healthy vendor whose summary omits the incident arrays', async () => {
      const { _mockFetchSummary } = (await import(
        '@/services/statuspage/statuspage-service.js'
      )) as unknown as {
        _mockFetchSummary: ReturnType<typeof vi.fn>;
      };
      const { incidents: _i, scheduled_maintenances: _m, ...sparse } = ALL_OPERATIONAL;
      _mockFetchSummary.mockResolvedValue({ data: sparse, cached: false });

      const ctx = createMockContext({ errors: devopsStatusCheck.errors });
      const input = devopsStatusCheck.input.parse({ vendors: ['github'], mode: 'detailed' });
      const result = await devopsStatusCheck.handler(input, ctx);

      expect(result.results[0]?.error).toBeUndefined();
      expect(result.results[0]?.indicator).toBe('none');
      expect(result.results[0]?.active_incidents).toEqual([]);
      expect(result.results[0]?.scheduled_maintenances).toEqual([]);
    });
  });

  describe('nextToolSuggestions → devops_suggest_action (#47)', () => {
    type Suggestion = { toolName: string; reason: string; args: Record<string, unknown> };

    beforeEach(async () => {
      const { _mockFetchSummary } = (await import(
        '@/services/statuspage/statuspage-service.js'
      )) as unknown as { _mockFetchSummary: ReturnType<typeof vi.fn> };
      _mockFetchSummary.mockReset();
    });

    async function checkMixed() {
      await serveMixedPages();
      const ctx = createMockContext({ errors: devopsStatusCheck.errors });
      const result = await devopsStatusCheck.handler(
        devopsStatusCheck.input.parse({ vendors: MIXED_VENDORS }),
        ctx,
      );
      return { result, ctx };
    }

    it('leaves every existing field of a mixed batch as it was', async () => {
      const { result, ctx } = await checkMixed();

      expect(
        result.results.map((r) => ({
          vendor: r.vendor,
          name: r.name,
          indicator: r.indicator,
          degraded: r.degraded_components.map((c) => `${c.name}:${c.status}`),
          incidents: r.active_incidents.map((i) => `${i.name}:${i.impact}:${i.started_at ?? '-'}`),
          error: r.error !== undefined,
        })),
      ).toEqual([
        {
          vendor: 'GitHub',
          name: 'GitHub',
          indicator: 'major',
          degraded: [
            'Git Operations:partial_outage',
            'Packages:under_maintenance',
            'Actions:major_outage',
          ],
          incidents: [
            'Actions delays:minor:2025-03-01T10:00:00Z',
            'Git push failures:major:2025-03-01T03:30:00-08:00',
            'Webhook backlog:major:-',
            'Informational notice:none:2025-03-02T00:00:00Z',
            'Database maintenance:maintenance:2025-03-03T00:00:00Z',
          ],
          error: false,
        },
        {
          vendor: 'cloudflare',
          name: 'Cloudflare',
          indicator: 'none',
          degraded: ['Lisbon, Portugal - (LIS):under_maintenance'],
          incidents: ['Scheduled network upgrade notice:none:2025-03-01T00:00:00Z'],
          error: false,
        },
        {
          vendor: 'npm',
          name: 'npm',
          indicator: 'none',
          degraded: [],
          incidents: ['Slow package installs:minor:-', 'Search indexing lag:minor:-'],
          error: false,
        },
        {
          vendor: 'brevo',
          name: 'Brevo',
          indicator: 'maintenance',
          degraded: ['Transactional Email:under_maintenance'],
          incidents: ['Planned database upgrade:maintenance:2025-03-01T00:00:00Z'],
          error: false,
        },
        {
          vendor: 'twilio',
          name: 'Twilio',
          indicator: 'none',
          degraded: [],
          incidents: [],
          error: true,
        },
        {
          vendor: 'nope-vendor',
          name: 'nope-vendor',
          indicator: 'none',
          degraded: [],
          incidents: [],
          error: true,
        },
        {
          vendor: 'openai',
          name: 'OpenAI',
          indicator: 'critical',
          degraded: ['Fine-tuning:under_maintenance'],
          incidents: [
            'API errors:critical:2025-03-01T12:00:00Z',
            'ChatGPT errors:major:2025-03-01T13:00:00+01:00',
          ],
          error: false,
        },
        {
          vendor: 'elastic',
          name: 'Elastic',
          indicator: 'minor',
          degraded: ['Cloud Console:degraded_performance'],
          incidents: [],
          error: false,
        },
        {
          vendor: 'github',
          name: 'GitHub',
          indicator: 'major',
          degraded: [
            'Git Operations:partial_outage',
            'Packages:under_maintenance',
            'Actions:major_outage',
          ],
          incidents: [
            'Actions delays:minor:2025-03-01T10:00:00Z',
            'Git push failures:major:2025-03-01T03:30:00-08:00',
            'Webhook backlog:major:-',
            'Informational notice:none:2025-03-02T00:00:00Z',
            'Database maintenance:maintenance:2025-03-03T00:00:00Z',
          ],
          error: false,
        },
      ]);
      // The buckets report each vendor's own indicator — npm stays operational.
      expect(result.summary).toEqual({
        total: 9,
        operational: 2,
        degraded: 3,
        down: 1,
        maintenance: 1,
        unavailable: 2,
      });
      // Nothing was capped, so nothing is disclosed.
      expect(getEnrichment(ctx)).toEqual({});
    });

    it('suggests devops_suggest_action once per vendor with an active problem, in results order', async () => {
      const { result } = await checkMixed();
      const suggestions = (result as { nextToolSuggestions: Suggestion[] }).nextToolSuggestions;

      expect(suggestions.map((s) => s.toolName)).toEqual(Array(4).fill('devops_suggest_action'));
      expect(suggestions.map((s) => s.args)).toEqual([
        {
          // The canonical slug, not the "GitHub" the caller typed (#20); the trailing
          // duplicate "github" collapses into this entry.
          vendor: 'github',
          vendor_indicator: 'major',
          affected_components: ['Git Operations', 'Actions'],
          incident_summary: 'Git push failures',
        },
        // Qualifies by incident alone: no vendor_indicator, and undated incidents keep order.
        { vendor: 'npm', incident_summary: 'Slow package installs' },
        // Same instant in two offsets is a tie — the first listed wins. Only a
        // maintenance window is degraded, so affected_components is omitted.
        { vendor: 'openai', vendor_indicator: 'critical', incident_summary: 'API errors' },
        // No qualifying incident, so incident_summary is omitted.
        { vendor: 'elastic', vendor_indicator: 'minor', affected_components: ['Cloud Console'] },
      ]);
    });

    it('emits args devops_suggest_action accepts as-is', async () => {
      const { result } = await checkMixed();
      const suggestions = (result as { nextToolSuggestions: Suggestion[] }).nextToolSuggestions;

      expect(suggestions.length).toBeGreaterThan(0);
      for (const s of suggestions) {
        expect(devopsSuggestAction.input.parse(s.args)).toMatchObject(s.args);
      }
    });

    it('says in each reason why the vendor qualified', async () => {
      const { result } = await checkMixed();
      const [github, npm, openai] = (result as { nextToolSuggestions: Suggestion[] })
        .nextToolSuggestions;

      /**
       * Names carry commas, so the reason separates them with semicolons. The indicator is
       * the vendor's, not each component's: Actions is in major_outage under a major page,
       * so the reason must not read as "partial outage on Actions".
       */
      expect(github!.reason).toBe(
        'github reports major (partial outage) overall; affected components: Git Operations; Actions.',
      );
      expect(npm!.reason).toBe(
        'npm reports none overall but has an open minor incident: "Slow package installs".',
      );
      expect(openai!.reason).toBe('openai reports critical (full outage) overall.');
    });

    it('renders the suggestions in content[] and validates against the output schema', async () => {
      await serveMixedPages();
      const call = await runToolContract(devopsStatusCheck, { vendors: MIXED_VENDORS });

      expect(call.isError).toBeFalsy();
      const structured = call.structuredContent as { nextToolSuggestions: Suggestion[] };
      expect(structured.nextToolSuggestions).toHaveLength(4);

      const text = call.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      expect(text).toContain('## Recommended Next Steps');
      expect(text.split('### `devops_suggest_action`')).toHaveLength(5);
      for (const s of structured.nextToolSuggestions) {
        expect(text).toContain(`**Why:** ${s.reason}`);
        expect(text).toContain(`**Args:** \`${JSON.stringify(s.args)}\``);
      }
    });

    it('returns an empty list and no heading for an all-clear batch', async () => {
      const { _mockFetchSummary } = (await import(
        '@/services/statuspage/statuspage-service.js'
      )) as unknown as { _mockFetchSummary: ReturnType<typeof vi.fn> };
      _mockFetchSummary.mockResolvedValue({ data: ALL_OPERATIONAL, cached: false });

      const call = await runToolContract(devopsStatusCheck, { vendors: ['github', 'cloudflare'] });

      expect(call.isError).toBeFalsy();
      expect(
        (call.structuredContent as { nextToolSuggestions: Suggestion[] }).nextToolSuggestions,
      ).toEqual([]);
      const text = call.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      expect(text).not.toContain('Recommended Next Steps');
      expect(text).not.toContain('devops_suggest_action');
    });

    it('names three components in the reason and counts the rest, while args keeps them all', async () => {
      const { _mockFetchSummary } = (await import(
        '@/services/statuspage/statuspage-service.js'
      )) as unknown as { _mockFetchSummary: ReturnType<typeof vi.fn> };
      const names = ['SMS, Latin America', 'Voice, APAC', 'MMS, APAC', 'Bulk Export', 'Lookup'];
      _mockFetchSummary.mockResolvedValue({
        data: page('Twilio', 'minor', [
          ...names.map((n) => component(n, 'degraded_performance')),
          component('Edge, Lisbon', 'under_maintenance'),
        ]),
        cached: false,
      });

      const ctx = createMockContext({ errors: devopsStatusCheck.errors });
      const result = await devopsStatusCheck.handler(
        devopsStatusCheck.input.parse({ vendors: ['twilio'] }),
        ctx,
      );
      const [s] = (result as { nextToolSuggestions: Suggestion[] }).nextToolSuggestions;

      expect(s!.reason).toBe(
        'twilio reports minor (degraded performance) overall; affected components: SMS, Latin America; Voice, APAC; MMS, APAC and 2 more.',
      );
      expect(s!.args.affected_components).toEqual(names);
    });

    it('passes a raw Statuspage URL as its normalized URL', async () => {
      const { _mockFetchSummary } = (await import(
        '@/services/statuspage/statuspage-service.js'
      )) as unknown as { _mockFetchSummary: ReturnType<typeof vi.fn> };
      _mockFetchSummary.mockResolvedValue({
        data: page('Example', 'minor', [component('API', 'degraded_performance')]),
        cached: false,
      });

      const ctx = createMockContext({ errors: devopsStatusCheck.errors });
      const result = await devopsStatusCheck.handler(
        devopsStatusCheck.input.parse({ vendors: [' https://status.example.test/ '] }),
        ctx,
      );
      const suggestions = (result as { nextToolSuggestions: Suggestion[] }).nextToolSuggestions;

      expect(result.results[0]!.statuspage_url).toBe('https://status.example.test');
      expect(suggestions.map((s) => s.args)).toEqual([
        {
          vendor: 'https://status.example.test',
          vendor_indicator: 'minor',
          affected_components: ['API'],
        },
      ]);
    });

    /**
     * Native-adapter vendors, run through the real adapters down to a fetch fake and
     * checked on both surfaces the contract runner produces.
     */
    describe('adapter-backed vendors', () => {
      const http = createFetchMock();
      const AZURE_FEED = 'https://rssfeed.azure.status.microsoft/en-us/status/feed/';
      const AWS_FEED = 'https://health.aws.amazon.com/public/currentevents';
      const azureCapture = (name: string) =>
        readFileSync(
          new URL(`../../../services/status-adapters/fixtures/${name}`, import.meta.url),
          'utf-8',
        );
      const utf16 = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf16le');

      beforeEach(() => {
        http.reset();
        http.install();
      });

      afterEach(() => {
        http.restore();
      });

      function rendered(call: Awaited<ReturnType<typeof runToolContract>>): string {
        return call.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      }

      it('azure: a listed item reads minor with one suggestion naming its title (#42)', async () => {
        http.route({
          match: AZURE_FEED,
          respond: () => new Response(azureCapture('azure-feed-20260723.xml')),
        });

        const call = await runToolContract(devopsStatusCheck, { vendors: ['azure'] });

        expect(call.isError).toBeFalsy();
        const structured = call.structuredContent as {
          results: Array<Record<string, unknown>>;
          nextToolSuggestions: Suggestion[];
        };
        expect(structured.results[0]).toMatchObject({
          vendor: 'azure',
          name: 'Microsoft Azure',
          indicator: 'minor',
          description: '1 active incident on the Azure status page',
          degraded_components: [],
          active_incidents: [
            {
              name: 'Issues connecting to resources in West US',
              impact: 'minor',
              status: 'investigating',
              started_at: '2026-07-23T16:29:09.000Z',
            },
          ],
        });
        expect(structured.nextToolSuggestions).toEqual([
          {
            toolName: 'devops_suggest_action',
            reason: 'azure reports minor (degraded performance) overall.',
            args: {
              vendor: 'azure',
              vendor_indicator: 'minor',
              incident_summary: 'Issues connecting to resources in West US',
            },
          },
        ]);
        const args = structured.nextToolSuggestions[0]!.args;
        expect(devopsSuggestAction.input.parse(args)).toMatchObject(args);

        const text = rendered(call);
        expect(text).toContain('### ⚠️ Microsoft Azure (azure)');
        expect(text).toContain('**Indicator:** minor');
        expect(text).toContain('Issues connecting to resources in West US [minor/investigating]');
        expect(text).toContain(`**Args:** \`${JSON.stringify(args)}\``);
      });

      it('azure: an empty feed reads all clear with no suggestion (#42)', async () => {
        http.route({
          match: AZURE_FEED,
          respond: () => new Response(azureCapture('azure-feed-empty.xml')),
        });

        const call = await runToolContract(devopsStatusCheck, { vendors: ['azure'] });

        const structured = call.structuredContent as {
          results: Array<{ indicator: string }>;
          nextToolSuggestions: Suggestion[];
          summary: { operational: number };
        };
        expect(structured.results[0]!.indicator).toBe('none');
        expect(structured.summary.operational).toBe(1);
        expect(structured.nextToolSuggestions).toEqual([]);
        expect(rendered(call)).not.toContain('## Recommended Next Steps');
      });

      const RESOLVED_EVENT = {
        arn: 'resolved-arn',
        status: '0',
        service_name: 'Amazon EC2',
        region_name: 'N. Virginia',
        date: '1772043269',
        summary: '[RESOLVED] Increased Error Rates',
        event_log: [
          { status: 1, message: 'Investigating.', timestamp: 1772043269 },
          { status: 0, message: 'Resolved.', timestamp: 1772052712 },
        ],
      };

      it('aws: a listed resolved event stays out of health and out of the suggestion (#50)', async () => {
        const open = {
          arn: 'open-arn',
          status: '3',
          service_name: 'Amazon S3',
          region_name: 'N. Virginia',
          date: '1772050000',
          summary: 'Increased Error Rates',
          event_log: [{ status: 3, message: 'We are investigating.', timestamp: 1772050000 }],
        };
        http.route({ match: AWS_FEED, respond: () => new Response(utf16([RESOLVED_EVENT, open])) });

        const call = await runToolContract(devopsStatusCheck, { vendors: ['aws'] });

        const structured = call.structuredContent as {
          results: Array<{
            indicator: string;
            description: string;
            degraded_components: Array<{ name: string; status: string }>;
            active_incidents: Array<{ id: string }>;
          }>;
          nextToolSuggestions: Suggestion[];
        };
        const [aws] = structured.results;
        expect(aws!.indicator).toBe('major');
        expect(aws!.description).toBe('1 open event on the AWS Health Dashboard');
        expect(aws!.degraded_components).toEqual([
          { name: 'Amazon S3 (N. Virginia)', status: 'partial_outage' },
        ]);
        expect(aws!.active_incidents.map((i) => i.id)).toEqual(['open-arn']);
        expect(structured.nextToolSuggestions.map((s) => s.args)).toEqual([
          {
            vendor: 'aws',
            vendor_indicator: 'major',
            affected_components: ['Amazon S3 (N. Virginia)'],
            incident_summary: 'Increased Error Rates — Amazon S3 (N. Virginia)',
          },
        ]);

        const text = rendered(call);
        expect(text).not.toContain('[RESOLVED]');
        expect(text).not.toContain('Amazon EC2');
        expect(text).toContain('- ⚠️ Amazon S3 (N. Virginia)');
      });

      it('aws: a feed listing only resolved events reads all clear (#50)', async () => {
        http.route({ match: AWS_FEED, respond: () => new Response(utf16([RESOLVED_EVENT])) });

        const call = await runToolContract(devopsStatusCheck, { vendors: ['aws'] });

        const structured = call.structuredContent as {
          results: Array<Record<string, unknown>>;
          nextToolSuggestions: Suggestion[];
        };
        expect(structured.results[0]).toMatchObject({
          indicator: 'none',
          description: 'All Systems Operational',
          degraded_components: [],
          active_incidents: [],
        });
        expect(structured.nextToolSuggestions).toEqual([]);
        expect(rendered(call)).toContain('### ✅ Amazon Web Services (aws)');
      });
    });
  });
});
