/**
 * @fileoverview Tests for the devops_get_incidents tool.
 * @module tests/mcp-server/tools/definitions/devops-get-incidents.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { devopsGetIncidents } from '@/mcp-server/tools/definitions/devops-get-incidents.tool.js';
import type {
  StatuspageIncidentsResponse,
  StatuspageScheduledMaintenancesResponse,
} from '@/services/statuspage/types.js';
import { initVendorRegistryService } from '@/services/vendor-registry/vendor-registry-service.js';

vi.mock('@/services/statuspage/statuspage-service.js', () => {
  const mockFetchIncidents = vi.fn();
  const mockFetchScheduledMaintenances = vi.fn();
  return {
    getStatuspageService: () => ({
      fetchIncidents: mockFetchIncidents,
      fetchScheduledMaintenances: mockFetchScheduledMaintenances,
    }),
    initStatuspageService: vi.fn(),
    _mockFetchIncidents: mockFetchIncidents,
    _mockFetchScheduledMaintenances: mockFetchScheduledMaintenances,
  };
});

const RESOLVED_INCIDENT: StatuspageIncidentsResponse = {
  page: {
    id: 'p1',
    name: 'GitHub',
    time_zone: 'UTC',
    updated_at: '',
    url: 'https://www.githubstatus.com',
  },
  incidents: [
    {
      id: 'inc-001',
      name: 'API Rate Limiting Issue',
      impact: 'minor',
      status: 'resolved',
      created_at: '2025-01-01T08:00:00Z',
      started_at: '2025-01-01T08:00:00Z',
      resolved_at: '2025-01-01T10:00:00Z',
      monitoring_at: null,
      page_id: 'p1',
      shortlink: 'https://stspg.io/001',
      components: [],
      incident_updates: [
        {
          id: 'u1',
          body: 'We are investigating an issue.',
          status: 'investigating',
          created_at: '2025-01-01T08:05:00Z',
          display_at: '',
          affected_components: [
            {
              code: 'c1',
              name: 'API',
              new_status: 'degraded_performance',
              old_status: 'operational',
            },
          ],
        },
        {
          id: 'u2',
          body: 'Issue resolved.',
          status: 'resolved',
          created_at: '2025-01-01T10:00:00Z',
          display_at: '',
          affected_components: null,
        },
      ],
    },
  ],
};

const EMPTY_SCHEDULED: StatuspageScheduledMaintenancesResponse = {
  page: {
    id: 'p1',
    name: 'GitHub',
    time_zone: 'UTC',
    updated_at: '',
    url: 'https://www.githubstatus.com',
  },
  scheduled_maintenances: [],
};

beforeAll(() => {
  initVendorRegistryService();
});

describe('devopsGetIncidents', () => {
  it('returns resolved incidents with full detail', async () => {
    const { _mockFetchIncidents, _mockFetchScheduledMaintenances } = (await import(
      '@/services/statuspage/statuspage-service.js'
    )) as {
      _mockFetchIncidents: ReturnType<typeof vi.fn>;
      _mockFetchScheduledMaintenances: ReturnType<typeof vi.fn>;
    };
    _mockFetchIncidents.mockResolvedValue({ data: RESOLVED_INCIDENT, cached: false });
    _mockFetchScheduledMaintenances.mockResolvedValue({ data: EMPTY_SCHEDULED, cached: false });

    const ctx = createMockContext({ errors: devopsGetIncidents.errors });
    const input = devopsGetIncidents.input.parse({ vendor: 'github', filter: 'all' });
    const result = await devopsGetIncidents.handler(input, ctx);

    expect(result.vendor).toBe('github');
    expect(result.incidents).toHaveLength(1);
    expect(result.incidents[0]!.id).toBe('inc-001');
    expect(result.incidents[0]!.name).toBe('API Rate Limiting Issue');
    expect(result.incidents[0]!.impact).toBe('minor');
    expect(result.incidents[0]!.status).toBe('resolved');
    expect(result.incidents[0]!.created_at).toBe('2025-01-01T08:00:00Z');
    expect(result.incidents[0]!.duration_minutes).toBe(120);
    expect(result.incidents[0]!.updates).toHaveLength(2);
    expect(result.incidents[0]!.affected_components).toContain('API');
    expect(result.total_returned).toBe(1);
  });

  it('filters to active incidents only', async () => {
    const { _mockFetchIncidents } = (await import(
      '@/services/statuspage/statuspage-service.js'
    )) as {
      _mockFetchIncidents: ReturnType<typeof vi.fn>;
    };
    // Only resolved incident — active filter should return empty
    _mockFetchIncidents.mockResolvedValue({ data: RESOLVED_INCIDENT, cached: false });

    const ctx = createMockContext({ errors: devopsGetIncidents.errors });
    const input = devopsGetIncidents.input.parse({ vendor: 'github', filter: 'active' });
    const result = await devopsGetIncidents.handler(input, ctx);
    expect(result.incidents).toHaveLength(0);
  });

  it('throws vendor_not_found for unknown slug', async () => {
    const ctx = createMockContext({ errors: devopsGetIncidents.errors });
    const input = devopsGetIncidents.input.parse({ vendor: 'unknown-xyz', filter: 'all' });
    await expect(devopsGetIncidents.handler(input, ctx)).rejects.toMatchObject({
      data: {
        reason: 'vendor_not_found',
        recovery: { hint: expect.stringContaining('devops_list_vendors') },
      },
    });
  });

  it('filters to resolved incidents only', async () => {
    const { _mockFetchIncidents, _mockFetchScheduledMaintenances } = (await import(
      '@/services/statuspage/statuspage-service.js'
    )) as {
      _mockFetchIncidents: ReturnType<typeof vi.fn>;
      _mockFetchScheduledMaintenances: ReturnType<typeof vi.fn>;
    };
    _mockFetchIncidents.mockResolvedValue({ data: RESOLVED_INCIDENT, cached: false });
    _mockFetchScheduledMaintenances.mockResolvedValue({ data: EMPTY_SCHEDULED, cached: false });

    const ctx = createMockContext({ errors: devopsGetIncidents.errors });
    const input = devopsGetIncidents.input.parse({ vendor: 'github', filter: 'resolved' });
    const result = await devopsGetIncidents.handler(input, ctx);

    // The fixture incident has status 'resolved'
    expect(result.incidents).toHaveLength(1);
    expect(result.incidents[0]!.status).toBe('resolved');
  });

  it('filter: scheduled uses scheduled_maintenances key from API response', async () => {
    // Regression: scheduled-maintenances endpoint returns { scheduled_maintenances: [] },
    // NOT { incidents: [] }. The handler must use data.scheduled_maintenances.
    const SCHEDULED_RESPONSE: StatuspageScheduledMaintenancesResponse = {
      page: {
        id: 'p1',
        name: 'GitHub',
        time_zone: 'UTC',
        updated_at: '',
        url: 'https://www.githubstatus.com',
      },
      scheduled_maintenances: [
        {
          id: 'maint-001',
          name: 'Planned DB Migration',
          impact: 'none',
          status: 'scheduled',
          created_at: '2025-02-01T00:00:00Z',
          started_at: '2025-02-01T00:00:00Z',
          resolved_at: null,
          monitoring_at: null,
          page_id: 'p1',
          shortlink: 'https://stspg.io/maint-001',
          components: [],
          incident_updates: [],
          scheduled_for: '2025-02-05T02:00:00Z',
          scheduled_until: '2025-02-05T04:00:00Z',
        },
      ],
    };

    const { _mockFetchScheduledMaintenances } = (await import(
      '@/services/statuspage/statuspage-service.js'
    )) as {
      _mockFetchScheduledMaintenances: ReturnType<typeof vi.fn>;
    };
    _mockFetchScheduledMaintenances.mockResolvedValue({ data: SCHEDULED_RESPONSE, cached: false });

    const ctx = createMockContext({ errors: devopsGetIncidents.errors });
    const input = devopsGetIncidents.input.parse({ vendor: 'github', filter: 'scheduled' });
    const result = await devopsGetIncidents.handler(input, ctx);

    expect(result.incidents).toHaveLength(1);
    // Scheduled maintenances get impact='maintenance' from normalizeIncident
    expect(result.incidents[0]!.impact).toBe('maintenance');
    expect(result.incidents[0]!.scheduled_for).toBe('2025-02-05T02:00:00Z');
  });

  it('handles null started_at and shortlink (vendors using newer Statuspage format)', async () => {
    // Regression: some vendors (e.g., OpenAI) omit started_at and shortlink entirely.
    // The API returns these fields as absent (undefined at runtime, null after ?? null coercion).
    // The output schema must accept null/undefined; durationMinutes must not throw.
    const SPARSE_INCIDENTS: StatuspageIncidentsResponse = {
      page: {
        id: 'p-openai',
        name: 'OpenAI',
        time_zone: 'UTC',
        updated_at: '',
        url: 'https://status.openai.com',
      },
      incidents: [
        {
          id: 'inc-sparse-001',
          name: 'Service Disruption',
          impact: 'critical',
          status: 'resolved',
          created_at: '2026-05-28T19:00:00Z',
          // started_at and shortlink intentionally absent (as in real OpenAI API responses)
          resolved_at: '2026-05-28T21:00:00Z',
          monitoring_at: null,
          page_id: 'p-openai',
          components: [],
          incident_updates: [
            {
              id: 'u1',
              body: 'Resolved.',
              status: 'resolved',
              created_at: '2026-05-28T21:00:00Z',
              display_at: '2026-05-28T21:00:00Z',
              affected_components: null,
            },
          ],
        } as unknown as StatuspageIncidentsResponse['incidents'][number],
      ],
    };

    const { _mockFetchIncidents } = (await import(
      '@/services/statuspage/statuspage-service.js'
    )) as {
      _mockFetchIncidents: ReturnType<typeof vi.fn>;
    };
    _mockFetchIncidents.mockResolvedValue({ data: SPARSE_INCIDENTS, cached: false });

    const ctx = createMockContext({ errors: devopsGetIncidents.errors });
    const input = devopsGetIncidents.input.parse({ vendor: 'openai', filter: 'resolved' });
    const result = await devopsGetIncidents.handler(input, ctx);

    expect(result.incidents).toHaveLength(1);
    expect(result.incidents[0]!.started_at).toBeNull();
    expect(result.incidents[0]!.shortlink).toBeNull();
    // duration_minutes should be null when started_at is absent (can't compute elapsed time)
    expect(result.incidents[0]!.duration_minutes).toBeNull();
  });

  it('non-truncated results pass the effective-output parse without enrichment (#5)', async () => {
    // Regression for #5: enrichment fields are populated only when the cap is hit,
    // so they must be optional — a non-truncated (here: empty) result must validate
    // against output.extend(enrichment) with no enrichment written.
    const { _mockFetchIncidents } = (await import(
      '@/services/statuspage/statuspage-service.js'
    )) as {
      _mockFetchIncidents: ReturnType<typeof vi.fn>;
    };
    // Only a resolved incident — the active filter yields an empty, non-truncated set.
    _mockFetchIncidents.mockResolvedValue({ data: RESOLVED_INCIDENT, cached: false });

    const ctx = createMockContext({ errors: devopsGetIncidents.errors });
    const input = devopsGetIncidents.input.parse({ vendor: 'github', filter: 'active', limit: 3 });
    const result = await devopsGetIncidents.handler(input, ctx);

    expect(result.incidents).toHaveLength(0);
    expect(result.total_returned).toBe(0);
    expect(getEnrichment(ctx)).toEqual({});

    const effectiveOutput = devopsGetIncidents.output.extend(devopsGetIncidents.enrichment!);
    expect(() => effectiveOutput.parse({ ...result, ...getEnrichment(ctx) })).not.toThrow();
  });

  it('writes truncation enrichment when more incidents matched than the limit', async () => {
    const TWO_INCIDENTS: StatuspageIncidentsResponse = {
      ...RESOLVED_INCIDENT,
      incidents: [
        RESOLVED_INCIDENT.incidents[0]!,
        { ...RESOLVED_INCIDENT.incidents[0]!, id: 'inc-002', name: 'Second Incident' },
      ],
    };
    const { _mockFetchIncidents } = (await import(
      '@/services/statuspage/statuspage-service.js'
    )) as {
      _mockFetchIncidents: ReturnType<typeof vi.fn>;
    };
    _mockFetchIncidents.mockResolvedValue({ data: TWO_INCIDENTS, cached: false });

    const ctx = createMockContext({ errors: devopsGetIncidents.errors });
    const input = devopsGetIncidents.input.parse({
      vendor: 'github',
      filter: 'resolved',
      limit: 1,
    });
    const result = await devopsGetIncidents.handler(input, ctx);

    expect(result.incidents).toHaveLength(1);
    expect(getEnrichment(ctx)).toMatchObject({ truncated: true, shown: 1, cap: 1 });
  });

  it('pages through incidents with offset, disclosing totalCount and truncation (#22)', async () => {
    const base = RESOLVED_INCIDENT.incidents[0]!;
    const THREE: StatuspageIncidentsResponse = {
      ...RESOLVED_INCIDENT,
      incidents: [
        { ...base, id: 'inc-a', name: 'First' },
        { ...base, id: 'inc-b', name: 'Second' },
        { ...base, id: 'inc-c', name: 'Third' },
      ],
    };
    const { _mockFetchIncidents, _mockFetchScheduledMaintenances } = (await import(
      '@/services/statuspage/statuspage-service.js'
    )) as {
      _mockFetchIncidents: ReturnType<typeof vi.fn>;
      _mockFetchScheduledMaintenances: ReturnType<typeof vi.fn>;
    };
    _mockFetchIncidents.mockResolvedValue({ data: THREE, cached: false });
    _mockFetchScheduledMaintenances.mockResolvedValue({ data: EMPTY_SCHEDULED, cached: false });

    // First page — offset 0, limit 2: two incidents, truncated, true total disclosed.
    const ctx1 = createMockContext({ errors: devopsGetIncidents.errors });
    const page1 = await devopsGetIncidents.handler(
      devopsGetIncidents.input.parse({ vendor: 'github', filter: 'resolved', limit: 2, offset: 0 }),
      ctx1,
    );
    expect(page1.incidents.map((i) => i.id)).toEqual(['inc-a', 'inc-b']);
    expect(page1.total_returned).toBe(2);
    expect(getEnrichment(ctx1)).toMatchObject({ truncated: true, shown: 2, cap: 2, totalCount: 3 });

    // Second page — offset 2: the remaining incident, no truncation, no enrichment.
    const ctx2 = createMockContext({ errors: devopsGetIncidents.errors });
    const page2 = await devopsGetIncidents.handler(
      devopsGetIncidents.input.parse({ vendor: 'github', filter: 'resolved', limit: 2, offset: 2 }),
      ctx2,
    );
    expect(page2.incidents.map((i) => i.id)).toEqual(['inc-c']);
    expect(page2.total_returned).toBe(1);
    expect(getEnrichment(ctx2)).toEqual({});

    // The two windows cover the full set with no overlap — every incident is reachable.
    const seen = [...page1.incidents, ...page2.incidents].map((i) => i.id);
    expect(new Set(seen)).toEqual(new Set(['inc-a', 'inc-b', 'inc-c']));
    expect(seen).toHaveLength(3);
  });

  it('returns null duration_minutes when resolved_at precedes started_at (#6)', async () => {
    // Regression for #6: vendor-authored Statuspage data can carry inverted
    // timestamps; the derived duration must be null, never negative.
    const INVERTED: StatuspageIncidentsResponse = {
      ...RESOLVED_INCIDENT,
      incidents: [
        {
          ...RESOLVED_INCIDENT.incidents[0]!,
          id: 'inc-inverted',
          started_at: '2026-06-19T14:38:09.691Z',
          resolved_at: '2026-06-17T19:00:00.000Z',
        },
      ],
    };
    const { _mockFetchIncidents } = (await import(
      '@/services/statuspage/statuspage-service.js'
    )) as {
      _mockFetchIncidents: ReturnType<typeof vi.fn>;
    };
    _mockFetchIncidents.mockResolvedValue({ data: INVERTED, cached: false });

    const ctx = createMockContext({ errors: devopsGetIncidents.errors });
    const input = devopsGetIncidents.input.parse({ vendor: 'github', filter: 'resolved' });
    const result = await devopsGetIncidents.handler(input, ctx);

    expect(result.incidents).toHaveLength(1);
    expect(result.incidents[0]!.duration_minutes).toBeNull();
  });

  it('format omits the duration when duration_minutes is null', () => {
    const result = {
      vendor: 'github',
      name: 'GitHub',
      incidents: [
        {
          id: 'inc-nodur',
          name: 'Webhook Incident',
          impact: 'minor' as const,
          status: 'resolved',
          created_at: '2026-06-17T19:00:00.000Z',
          started_at: '2026-06-19T14:38:09.691Z',
          resolved_at: '2026-06-17T19:00:00.000Z',
          scheduled_for: null,
          scheduled_until: null,
          duration_minutes: null,
          shortlink: null,
          affected_components: [],
          updates: [],
        },
      ],
      total_returned: 1,
      statuspage_url: 'https://www.githubstatus.com',
    };
    const blocks = devopsGetIncidents.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**Resolved:** 2026-06-17T19:00:00.000Z');
    expect(text).not.toMatch(/\(-?\d+ min\)/);
    expect(text).not.toContain('? min');
  });

  it('format explains an empty incident result and suggests a broader filter (#17)', () => {
    const result = {
      vendor: 'github',
      name: 'GitHub',
      incidents: [],
      total_returned: 0,
      statuspage_url: 'https://www.githubstatus.com',
    };
    const blocks = devopsGetIncidents.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('GitHub');
    expect(text).toContain('github');
    expect(text).toMatch(/no incidents/i);
    // Names concrete follow-up filters instead of leaving a bare header.
    expect(text).toContain('filter');
    expect(text).toMatch(/"all"|"resolved"/);
  });

  it('throws statuspage_unavailable when fetch rejects', async () => {
    const { _mockFetchIncidents, _mockFetchScheduledMaintenances } = (await import(
      '@/services/statuspage/statuspage-service.js'
    )) as {
      _mockFetchIncidents: ReturnType<typeof vi.fn>;
      _mockFetchScheduledMaintenances: ReturnType<typeof vi.fn>;
    };
    _mockFetchIncidents.mockRejectedValue(new Error('HTTP 503 from statuspage'));
    _mockFetchScheduledMaintenances.mockRejectedValue(new Error('HTTP 503 from statuspage'));

    const ctx = createMockContext({ errors: devopsGetIncidents.errors });
    const input = devopsGetIncidents.input.parse({ vendor: 'github', filter: 'active' });
    // The handler does not catch fetch errors — they propagate as ServiceUnavailable
    await expect(devopsGetIncidents.handler(input, ctx)).rejects.toThrow();
  });

  it('formats output with vendor, id, and created_at', async () => {
    const result = {
      vendor: 'github',
      name: 'GitHub',
      incidents: [
        {
          id: 'inc-001',
          name: 'API Issue',
          impact: 'minor' as const,
          status: 'resolved',
          created_at: '2025-01-01T08:00:00Z',
          started_at: '2025-01-01T08:00:00Z',
          resolved_at: '2025-01-01T10:00:00Z',
          scheduled_for: null,
          scheduled_until: null,
          duration_minutes: 120,
          shortlink: 'https://stspg.io/001',
          affected_components: ['API'],
          updates: [{ status: 'resolved', body: 'All clear.', created_at: '2025-01-01T10:00:00Z' }],
        },
      ],
      total_returned: 1,
      statuspage_url: 'https://www.githubstatus.com',
    };
    const blocks = devopsGetIncidents.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('github');
    expect(text).toContain('inc-001');
    expect(text).toContain('2025-01-01T08:00:00Z');
    expect(text).toContain('GitHub');
  });
});
