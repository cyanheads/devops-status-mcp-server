/**
 * @fileoverview Tests for the devops_get_incidents tool.
 * @module tests/mcp-server/tools/definitions/devops-get-incidents.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { devopsGetIncidents } from '@/mcp-server/tools/definitions/devops-get-incidents.tool.js';
import type {
  StatuspageIncidentsResponse,
  StatuspageScheduledMaintenancesResponse,
} from '@/services/statuspage/types.js';
import { initVendorRegistryService } from '@/services/vendor-registry/vendor-registry-service.js';

/**
 * Only the AWS incident fetcher is replaced — it is the one AWS call that hits the
 * network. `fetchAwsScheduledMaintenances` stays real so the "AWS publishes no
 * maintenance feed" case is proved by the adapter itself, not by a stub.
 */
vi.mock('@/services/status-adapters/aws-adapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/status-adapters/aws-adapter.js')>();
  return { ...actual, fetchAwsIncidents: vi.fn() };
});

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
    // Regression for #5: every enrichment field is written only on the path that
    // produces it, so they must be optional — a plain result (nothing capped, nothing
    // empty, the vendor feed nowhere near its ceiling) must validate against
    // output.extend(enrichment) with no enrichment written at all.
    const { _mockFetchIncidents } = (await import(
      '@/services/statuspage/statuspage-service.js'
    )) as {
      _mockFetchIncidents: ReturnType<typeof vi.fn>;
    };
    _mockFetchIncidents.mockResolvedValue({ data: RESOLVED_INCIDENT, cached: false });

    const ctx = createMockContext({ errors: devopsGetIncidents.errors });
    const input = devopsGetIncidents.input.parse({
      vendor: 'github',
      filter: 'resolved',
      limit: 3,
    });
    const result = await devopsGetIncidents.handler(input, ctx);

    expect(result.incidents).toHaveLength(1);
    expect(result.total_returned).toBe(1);
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

  it('a truncated page carries nextOffset and the guidance through the declared enrichment (#24)', async () => {
    // The handler always composed continuation guidance, but the enrichment block
    // declared neither `notice` nor `nextOffset`, so output.extend(enrichment) — the
    // schema that builds structuredContent and the content[] trailer — stripped both.
    const base = RESOLVED_INCIDENT.incidents[0]!;
    const THREE: StatuspageIncidentsResponse = {
      ...RESOLVED_INCIDENT,
      incidents: [
        { ...base, id: 'inc-a' },
        { ...base, id: 'inc-b' },
        { ...base, id: 'inc-c' },
      ],
    };
    const { _mockFetchIncidents } = (await import(
      '@/services/statuspage/statuspage-service.js'
    )) as {
      _mockFetchIncidents: ReturnType<typeof vi.fn>;
    };
    _mockFetchIncidents.mockResolvedValue({ data: THREE, cached: false });

    const ctx = createMockContext({ errors: devopsGetIncidents.errors });
    const result = await devopsGetIncidents.handler(
      devopsGetIncidents.input.parse({ vendor: 'github', filter: 'resolved', limit: 1, offset: 0 }),
      ctx,
    );

    const effectiveOutput = devopsGetIncidents.output.extend(devopsGetIncidents.enrichment!);
    const structured = effectiveOutput.parse({ ...result, ...getEnrichment(ctx) });

    // The typed continuation value — an agent should not parse an offset out of prose.
    expect(structured.nextOffset).toBe(1);
    expect(structured.totalCount).toBe(3);
    // …and the same value stated in the human-readable trailer.
    expect(structured.notice).toContain('offset: 1');
    expect(structured.notice).toContain('of 3');

    // A second call at the disclosed offset returns the next window, not a repeat.
    const ctx2 = createMockContext({ errors: devopsGetIncidents.errors });
    const page2 = await devopsGetIncidents.handler(
      devopsGetIncidents.input.parse({
        vendor: 'github',
        filter: 'resolved',
        limit: 1,
        offset: structured.nextOffset as number,
      }),
      ctx2,
    );
    expect(page2.incidents.map((i) => i.id)).toEqual(['inc-b']);

    // The last page must not advertise a next one — an agent looping on nextOffset
    // needs its absence to be the stop condition.
    const ctx3 = createMockContext({ errors: devopsGetIncidents.errors });
    const page3 = await devopsGetIncidents.handler(
      devopsGetIncidents.input.parse({ vendor: 'github', filter: 'resolved', limit: 1, offset: 2 }),
      ctx3,
    );
    expect(page3.incidents.map((i) => i.id)).toEqual(['inc-c']);
    expect(effectiveOutput.parse({ ...page3, ...getEnrichment(ctx3) }).nextOffset).toBeUndefined();
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
    expect(getEnrichment(ctx1)).toMatchObject({
      truncated: true,
      shown: 2,
      cap: 2,
      totalCount: 3,
      nextOffset: 2,
    });

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

  it('format states an empty result without guessing a follow-up filter (#17, #34)', () => {
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
    // format() receives only the domain object — no filter, offset, or backend — so
    // it cannot name a useful follow-up. The handler writes that to `notice`, which
    // the framework renders into this same content[] block as a trailer; a filter
    // named here would contradict it (see the empty-result guidance tests below).
    expect(text).not.toMatch(/"all"|"resolved"|"active"|"scheduled"/);
  });

  /**
   * Every omitted incident must stay discoverable: when the vendor's own feed, not
   * this tool's window, is what bounded the history, the response says so and names
   * the ceiling rather than presenting a full window as complete history (#25).
   */
  describe('upstream history ceiling', () => {
    function incidentsPage(count: number): StatuspageIncidentsResponse {
      const base = RESOLVED_INCIDENT.incidents[0]!;
      return {
        ...RESOLVED_INCIDENT,
        incidents: Array.from({ length: count }, (_, i) => ({ ...base, id: `inc-${i}` })),
      };
    }

    it('discloses the 50-record Statuspage cap when the feed returns 50 (#25)', async () => {
      const { _mockFetchIncidents } = (await import(
        '@/services/statuspage/statuspage-service.js'
      )) as {
        _mockFetchIncidents: ReturnType<typeof vi.fn>;
      };
      _mockFetchIncidents.mockResolvedValue({ data: incidentsPage(50), cached: false });

      const ctx = createMockContext({ errors: devopsGetIncidents.errors });
      const result = await devopsGetIncidents.handler(
        devopsGetIncidents.input.parse({ vendor: 'github', filter: 'resolved', limit: 50 }),
        ctx,
      );

      // The window covers everything the feed returned, so tool-side truncation is
      // silent — the cap is the vendor's, and only the ceiling signal reveals it.
      expect(result.total_returned).toBe(50);
      const effectiveOutput = devopsGetIncidents.output.extend(devopsGetIncidents.enrichment!);
      const structured = effectiveOutput.parse({ ...result, ...getEnrichment(ctx) });

      expect(structured.truncated).toBeUndefined();
      expect(structured.upstreamCeiling).toBe(50);
      expect(structured.notice).toContain('50');
      expect(structured.notice).toContain('https://www.githubstatus.com');
      // Says the omitted incidents are unreachable by paging, not just "capped".
      expect(structured.notice).toMatch(/offset/i);

      // Control: one record short of the ceiling is the whole history, so claiming a
      // cap there would be as wrong as hiding it above.
      const ctxUnder = createMockContext({ errors: devopsGetIncidents.errors });
      _mockFetchIncidents.mockResolvedValue({ data: incidentsPage(49), cached: false });
      const under = await devopsGetIncidents.handler(
        devopsGetIncidents.input.parse({ vendor: 'github', filter: 'resolved', limit: 50 }),
        ctxUnder,
      );
      expect(under.total_returned).toBe(49);
      expect(getEnrichment(ctxUnder)).toEqual({});
    });

    it('composes the ceiling with paging guidance when both bound the result (#24, #25)', async () => {
      const { _mockFetchIncidents } = (await import(
        '@/services/statuspage/statuspage-service.js'
      )) as {
        _mockFetchIncidents: ReturnType<typeof vi.fn>;
      };
      _mockFetchIncidents.mockResolvedValue({ data: incidentsPage(50), cached: false });

      const ctx = createMockContext({ errors: devopsGetIncidents.errors });
      const result = await devopsGetIncidents.handler(
        devopsGetIncidents.input.parse({ vendor: 'github', filter: 'resolved', limit: 20 }),
        ctx,
      );

      const effectiveOutput = devopsGetIncidents.output.extend(devopsGetIncidents.enrichment!);
      const structured = effectiveOutput.parse({ ...result, ...getEnrichment(ctx) });

      // `notice` is last-wins across enrich calls, so both reasons must survive in one string.
      expect(structured.nextOffset).toBe(20);
      expect(structured.upstreamCeiling).toBe(50);
      expect(structured.notice).toContain('offset: 20');
      expect(structured.notice).toContain('at most 50 incidents');
    });
  });

  /**
   * The empty branch used to emit one fixed string: it recommended the filter the
   * caller had just used, recommended history from backends that publish none, and
   * said nothing when an out-of-range offset caused the emptiness (#34).
   */
  describe('empty-result guidance', () => {
    it('names the valid offset range when the offset overshot the matches (#34)', async () => {
      const { _mockFetchIncidents } = (await import(
        '@/services/statuspage/statuspage-service.js'
      )) as {
        _mockFetchIncidents: ReturnType<typeof vi.fn>;
      };
      _mockFetchIncidents.mockResolvedValue({ data: RESOLVED_INCIDENT, cached: false });

      const ctx = createMockContext({ errors: devopsGetIncidents.errors });
      const result = await devopsGetIncidents.handler(
        devopsGetIncidents.input.parse({
          vendor: 'github',
          filter: 'resolved',
          limit: 5,
          offset: 9999,
        }),
        ctx,
      );

      expect(result.total_returned).toBe(0);
      const effectiveOutput = devopsGetIncidents.output.extend(devopsGetIncidents.enrichment!);
      const structured = effectiveOutput.parse({ ...result, ...getEnrichment(ctx) });

      expect(structured.notice).toContain('9999');
      expect(structured.notice).toContain('matched 1 incident');
      expect(structured.notice).toContain('0–0');
    });

    it('never recommends the filter that was just used (#34)', async () => {
      const { _mockFetchIncidents } = (await import(
        '@/services/statuspage/statuspage-service.js'
      )) as {
        _mockFetchIncidents: ReturnType<typeof vi.fn>;
      };
      // Only a resolved incident, so the active filter matches nothing.
      _mockFetchIncidents.mockResolvedValue({ data: RESOLVED_INCIDENT, cached: false });

      const ctx = createMockContext({ errors: devopsGetIncidents.errors });
      const result = await devopsGetIncidents.handler(
        devopsGetIncidents.input.parse({ vendor: 'github', filter: 'active' }),
        ctx,
      );

      const effectiveOutput = devopsGetIncidents.output.extend(devopsGetIncidents.enrichment!);
      const structured = effectiveOutput.parse({ ...result, ...getEnrichment(ctx) });

      expect(structured.notice).toContain('"active"');
      expect(structured.notice).toContain('Try filter:');
      // The suggestion list is what must not echo the caller's own filter back.
      const suggestions = String(structured.notice).split('Try filter:')[1] ?? '';
      expect(suggestions).not.toContain('"active"');
      // `all`, `resolved`, and `scheduled` are all genuinely wider than or disjoint
      // from `active`, so subset awareness (#43) must leave this direction intact.
      expect(suggestions).toContain('"all"');
      expect(suggestions).toContain('"resolved"');
      expect(suggestions).toContain('"scheduled"');
    });

    it('says AWS has no resolution lifecycle rather than suggesting a dead filter (#34)', async () => {
      const { fetchAwsIncidents } = await import('@/services/status-adapters/aws-adapter.js');
      // One open event — the AWS feed's only shape. mapAwsEvent pins it to
      // 'investigating', so the resolved filter can never match it.
      vi.mocked(fetchAwsIncidents).mockResolvedValue({
        data: {
          page: {
            id: 'aws',
            name: 'Amazon Web Services',
            time_zone: 'Etc/UTC',
            updated_at: '',
            url: 'https://health.aws.amazon.com',
          },
          incidents: [
            {
              ...RESOLVED_INCIDENT.incidents[0]!,
              id: 'aws-evt-1',
              status: 'investigating',
              resolved_at: null,
            },
          ],
        },
        cached: false,
      });

      const ctx = createMockContext({ errors: devopsGetIncidents.errors });
      const result = await devopsGetIncidents.handler(
        devopsGetIncidents.input.parse({ vendor: 'aws', filter: 'resolved' }),
        ctx,
      );

      expect(result.total_returned).toBe(0);
      const effectiveOutput = devopsGetIncidents.output.extend(devopsGetIncidents.enrichment!);
      const structured = effectiveOutput.parse({ ...result, ...getEnrichment(ctx) });

      expect(structured.notice).toContain('Amazon Web Services');
      expect(structured.notice).toMatch(/no resolution lifecycle/i);
      const suggestions = String(structured.notice).split('Try filter:')[1] ?? '';
      // AWS can serve neither of these, so neither may be recommended.
      expect(suggestions).not.toContain('"resolved"');
      expect(suggestions).not.toContain('"scheduled"');
      expect(suggestions).toContain('"active"');
    });

    it('says AWS publishes no maintenance feed for filter: scheduled (#34)', async () => {
      // fetchAwsScheduledMaintenances is unconditionally empty with no network call.
      const ctx = createMockContext({ errors: devopsGetIncidents.errors });
      const result = await devopsGetIncidents.handler(
        devopsGetIncidents.input.parse({ vendor: 'aws', filter: 'scheduled' }),
        ctx,
      );

      expect(result.total_returned).toBe(0);
      const effectiveOutput = devopsGetIncidents.output.extend(devopsGetIncidents.enrichment!);
      const structured = effectiveOutput.parse({ ...result, ...getEnrichment(ctx) });

      expect(structured.notice).toContain('Amazon Web Services');
      expect(structured.notice).toMatch(/no scheduled-maintenance feed/i);
      const suggestions = String(structured.notice).split('Try filter:')[1] ?? '';
      expect(suggestions).not.toContain('"scheduled"');
      expect(suggestions).not.toContain('"resolved"');
    });

    it('says Slack publishes no maintenance feed for filter: scheduled (#34)', async () => {
      // fetchSlackScheduledMaintenances is unconditionally empty with no network call.
      const ctx = createMockContext({ errors: devopsGetIncidents.errors });
      const result = await devopsGetIncidents.handler(
        devopsGetIncidents.input.parse({ vendor: 'slack', filter: 'scheduled' }),
        ctx,
      );

      expect(result.total_returned).toBe(0);
      const effectiveOutput = devopsGetIncidents.output.extend(devopsGetIncidents.enrichment!);
      const structured = effectiveOutput.parse({ ...result, ...getEnrichment(ctx) });

      expect(structured.notice).toContain('Slack');
      expect(structured.notice).toMatch(/no scheduled-maintenance feed/i);
      const suggestions = String(structured.notice).split('Try filter:')[1] ?? '';
      expect(suggestions).not.toContain('"scheduled"');
      // Slack's /history does carry resolved incidents, so that one stays on offer.
      expect(suggestions).toContain('"resolved"');
    });

    /**
     * `all` is built from the incident list plus the maintenance list, so an empty
     * `all` guarantees every narrower filter is empty too. Recommending one sends the
     * caller on a round trip that cannot succeed (#43).
     */
    it('says the vendor lists nothing rather than naming subsets of an empty all (#43)', async () => {
      const { _mockFetchIncidents, _mockFetchScheduledMaintenances } = (await import(
        '@/services/statuspage/statuspage-service.js'
      )) as {
        _mockFetchIncidents: ReturnType<typeof vi.fn>;
        _mockFetchScheduledMaintenances: ReturnType<typeof vi.fn>;
      };
      _mockFetchIncidents.mockResolvedValue({
        data: { ...RESOLVED_INCIDENT, incidents: [] },
        cached: false,
      });
      _mockFetchScheduledMaintenances.mockResolvedValue({ data: EMPTY_SCHEDULED, cached: false });

      const ctx = createMockContext({ errors: devopsGetIncidents.errors });
      const result = await devopsGetIncidents.handler(
        devopsGetIncidents.input.parse({ vendor: 'github', filter: 'all' }),
        ctx,
      );

      expect(result.total_returned).toBe(0);
      const effectiveOutput = devopsGetIncidents.output.extend(devopsGetIncidents.enrichment!);
      const structured = effectiveOutput.parse({ ...result, ...getEnrichment(ctx) });

      expect(structured.notice).toContain('GitHub');
      expect(structured.notice).toContain('https://www.githubstatus.com');
      expect(structured.notice).toMatch(/no incidents and no maintenance windows/i);
      // No sub-filter may be named — each is empty by construction.
      expect(structured.notice).not.toContain('Try filter:');
      expect(structured.notice).not.toContain('"active"');
      expect(structured.notice).not.toContain('"resolved"');
      expect(structured.notice).not.toContain('"scheduled"');
    });

    /**
     * The nothing-published branch sits behind the offset branch, so an `all` that
     * matched incidents but overshot them keeps the offset guidance (#43).
     */
    it('keeps the offset guidance when an overshooting all matched incidents (#43)', async () => {
      const { _mockFetchIncidents, _mockFetchScheduledMaintenances } = (await import(
        '@/services/statuspage/statuspage-service.js'
      )) as {
        _mockFetchIncidents: ReturnType<typeof vi.fn>;
        _mockFetchScheduledMaintenances: ReturnType<typeof vi.fn>;
      };
      _mockFetchIncidents.mockResolvedValue({ data: RESOLVED_INCIDENT, cached: false });
      _mockFetchScheduledMaintenances.mockResolvedValue({ data: EMPTY_SCHEDULED, cached: false });

      const ctx = createMockContext({ errors: devopsGetIncidents.errors });
      const result = await devopsGetIncidents.handler(
        devopsGetIncidents.input.parse({ vendor: 'github', filter: 'all', offset: 9999 }),
        ctx,
      );

      const effectiveOutput = devopsGetIncidents.output.extend(devopsGetIncidents.enrichment!);
      const structured = effectiveOutput.parse({ ...result, ...getEnrichment(ctx) });

      expect(result.total_returned).toBe(0);
      expect(structured.notice).toContain('9999');
      expect(structured.notice).toContain('matched 1 incident');
      expect(structured.notice).not.toMatch(/no incidents and no maintenance windows/i);
    });
  });

  /**
   * These drive the *real* StatuspageService through the mocked accessor, so the
   * declared statuspage_unavailable contract is proved reachable by the service
   * layer rather than by whatever the module mock was told to reject with.
   */
  describe('statuspage_unavailable contract (#32)', () => {
    async function useRealStatuspageService() {
      const actual = await vi.importActual<
        typeof import('@/services/statuspage/statuspage-service.js')
      >('@/services/statuspage/statuspage-service.js');
      const real = new actual.StatuspageService();
      const { _mockFetchIncidents, _mockFetchScheduledMaintenances } = (await import(
        '@/services/statuspage/statuspage-service.js'
      )) as {
        _mockFetchIncidents: ReturnType<typeof vi.fn>;
        _mockFetchScheduledMaintenances: ReturnType<typeof vi.fn>;
      };
      _mockFetchIncidents.mockImplementation((url: string) => real.fetchIncidents(url));
      _mockFetchScheduledMaintenances.mockImplementation((url: string) =>
        real.fetchScheduledMaintenances(url),
      );
    }

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('a non-2xx from the vendor API throws ServiceUnavailable with the reason on the wire', async () => {
      await useRealStatuspageService();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: false, status: 503, headers: new Headers() }),
      );

      const ctx = createMockContext({ errors: devopsGetIncidents.errors });
      const input = devopsGetIncidents.input.parse({ vendor: 'github', filter: 'active' });
      const err = await devopsGetIncidents.handler(input, ctx).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect((err as McpError).data).toMatchObject({ reason: 'statuspage_unavailable' });
      expect((err as McpError).message).toContain('HTTP 503');
    });

    it('an unreachable vendor host throws ServiceUnavailable, not an unclassified InternalError', async () => {
      await useRealStatuspageService();
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockRejectedValue(
            new TypeError('Unable to connect. Is the computer able to access the url?'),
          ),
      );

      const ctx = createMockContext({ errors: devopsGetIncidents.errors });
      const input = devopsGetIncidents.input.parse({ vendor: 'github', filter: 'resolved' });
      const err = await devopsGetIncidents.handler(input, ctx).catch((e: unknown) => e);

      expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect((err as McpError).data).toMatchObject({ reason: 'statuspage_unavailable' });
    });

    it('a 200 that is not a Statuspage payload throws the contract, never a raw TypeError', async () => {
      await useRealStatuspageService();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({ args: {}, headers: {}, method: 'GET' }),
        }),
      );

      const ctx = createMockContext({ errors: devopsGetIncidents.errors });
      // filter 'all' is the path that used to die on `incData.data.incidents.map`.
      const input = devopsGetIncidents.input.parse({ vendor: 'github', filter: 'all' });
      const err = await devopsGetIncidents.handler(input, ctx).catch((e: unknown) => e);

      expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect((err as McpError).data).toMatchObject({ reason: 'statuspage_unavailable' });
      expect((err as McpError).message).not.toMatch(/undefined is not an object|is not a function/);
      expect((err as McpError).message).toContain('/api/v2/');
    });
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

  describe('pages that publish no scheduled-maintenances endpoint', () => {
    /**
     * Six registry vendors 404 on scheduled-maintenances.json. Under filter:'all'
     * the incidents fetch already proved the base URL is a real Statuspage, so the
     * 404 means "publishes no maintenance data" and must not fail the whole call.
     */
    it('filter:all degrades to incidents only when scheduled-maintenances 404s', async () => {
      const { _mockFetchIncidents, _mockFetchScheduledMaintenances } = (await import(
        '@/services/statuspage/statuspage-service.js'
      )) as {
        _mockFetchIncidents: ReturnType<typeof vi.fn>;
        _mockFetchScheduledMaintenances: ReturnType<typeof vi.fn>;
      };
      _mockFetchIncidents.mockResolvedValue({ data: RESOLVED_INCIDENT, cached: false });
      _mockFetchScheduledMaintenances.mockRejectedValue(
        new McpError(JsonRpcErrorCode.ServiceUnavailable, 'HTTP 404 from .../scheduled', {
          reason: 'statuspage_unavailable',
          status: 404,
        }),
      );

      const ctx = createMockContext({ errors: devopsGetIncidents.errors });
      const input = devopsGetIncidents.input.parse({ vendor: 'github', filter: 'all' });
      const result = await devopsGetIncidents.handler(input, ctx);

      expect(result.incidents).toHaveLength(1);
      expect(result.incidents[0]?.id).toBe('inc-001');
    });

    /**
     * filter:'scheduled' fetches nothing else, so a 404 is indistinguishable from a
     * wrong base URL — it must stay an error rather than silently return empty.
     */
    it('filter:scheduled still surfaces the 404 as statuspage_unavailable', async () => {
      const { _mockFetchScheduledMaintenances } = (await import(
        '@/services/statuspage/statuspage-service.js'
      )) as {
        _mockFetchScheduledMaintenances: ReturnType<typeof vi.fn>;
      };
      _mockFetchScheduledMaintenances.mockRejectedValue(
        new McpError(JsonRpcErrorCode.ServiceUnavailable, 'HTTP 404 from .../scheduled', {
          reason: 'statuspage_unavailable',
          status: 404,
        }),
      );

      const ctx = createMockContext({ errors: devopsGetIncidents.errors });
      const input = devopsGetIncidents.input.parse({ vendor: 'github', filter: 'scheduled' });
      await expect(devopsGetIncidents.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'statuspage_unavailable' },
      });
    });
  });
});
