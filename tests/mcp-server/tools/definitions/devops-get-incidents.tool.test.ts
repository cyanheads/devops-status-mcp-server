/**
 * @fileoverview Tests for the devops_get_incidents tool.
 * @module tests/mcp-server/tools/definitions/devops-get-incidents.tool.test
 */

import { readFileSync } from 'node:fs';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  getEnrichment,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { devopsGetIncidents } from '@/mcp-server/tools/definitions/devops-get-incidents.tool.js';
import type {
  StatuspageIncidentsResponse,
  StatuspageScheduledMaintenancesResponse,
} from '@/services/statuspage/types.js';
import { initVendorRegistryService } from '@/services/vendor-registry/vendor-registry-service.js';
import { clearFetchCache } from '@/utils/cached-fetch.js';

/**
 * Cache entries expire immediately so every case reaches the fetch fake, and the
 * SSRF guard is off so a redirect hop to another public host resolves no DNS.
 */
vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    cacheTtlMs: -1,
    fetchTimeoutMs: 1000,
    certTimeoutMs: 5000,
    dnsTimeoutMs: 3000,
    allowPrivateTargets: true,
    disableActiveProbes: false,
  }),
}));

/** A recorded Statuspage response, trimmed to the records a case needs. */
function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`../../../services/statuspage/fixtures/${name}`, import.meta.url),
      'utf-8',
    ),
  );
}

/**
 * Only the AWS incident fetcher is replaced — it is the one AWS call that hits the
 * network. `fetchAwsScheduledMaintenances` stays real so the "AWS publishes no
 * maintenance feed" case is proved by the adapter itself, not by a stub.
 */
vi.mock('@/services/status-adapters/aws-adapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/status-adapters/aws-adapter.js')>();
  return { ...actual, fetchAwsIncidents: vi.fn() };
});

/**
 * The guard stays real — the config above allows private targets, so it passes every
 * URL — and a case that needs a blocked raw URL queues the rejection itself.
 */
vi.mock('@/utils/ssrf-guard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/ssrf-guard.js')>();
  return { ...actual, assertSafeUrl: vi.fn(actual.assertSafeUrl) };
});

vi.mock('@/services/statuspage/statuspage-service.js', () => {
  const mockFetchIncidents = vi.fn();
  const mockFetchScheduledMaintenances = vi.fn();
  const mockFetchHistory = vi.fn();
  return {
    getStatuspageService: () => ({
      fetchIncidents: mockFetchIncidents,
      fetchScheduledMaintenances: mockFetchScheduledMaintenances,
      fetchHistory: mockFetchHistory,
    }),
    initStatuspageService: vi.fn(),
    _mockFetchIncidents: mockFetchIncidents,
    _mockFetchScheduledMaintenances: mockFetchScheduledMaintenances,
    _mockFetchHistory: mockFetchHistory,
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

/**
 * The shared response cache expires by wall clock, and the deep-history cases pin the
 * clock, so an entry cached at one time can read back as fresh at another. Clearing it
 * keeps every case independent of the order the cases run in.
 */
beforeEach(() => {
  clearFetchCache();
});

/**
 * Route the mocked service accessor to a real StatuspageService, so a case runs the
 * real fetch, redirect, and shape-gate path down to the fetch fake.
 */
async function useRealStatuspageService() {
  const actual = await vi.importActual<
    typeof import('@/services/statuspage/statuspage-service.js')
  >('@/services/statuspage/statuspage-service.js');
  const real = new actual.StatuspageService();
  const { _mockFetchIncidents, _mockFetchScheduledMaintenances, _mockFetchHistory } = (await import(
    '@/services/statuspage/statuspage-service.js'
  )) as unknown as {
    _mockFetchIncidents: ReturnType<typeof vi.fn>;
    _mockFetchScheduledMaintenances: ReturnType<typeof vi.fn>;
    _mockFetchHistory: ReturnType<typeof vi.fn>;
  };
  _mockFetchIncidents.mockImplementation((url: string) => real.fetchIncidents(url));
  _mockFetchScheduledMaintenances.mockImplementation((url: string) =>
    real.fetchScheduledMaintenances(url),
  );
  _mockFetchHistory.mockImplementation((url: string, page: number) => real.fetchHistory(url, page));
}

describe('devopsGetIncidents', () => {
  it('returns resolved incidents with full detail', async () => {
    const { _mockFetchIncidents, _mockFetchScheduledMaintenances } = (await import(
      '@/services/statuspage/statuspage-service.js'
    )) as unknown as {
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
    )) as unknown as {
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

  it('throws target_blocked with the guard sentence, sentinel stripped, for a blocked raw URL', async () => {
    const { assertSafeUrl } = await import('@/utils/ssrf-guard.js');
    vi.mocked(assertSafeUrl).mockRejectedValueOnce(
      new Error(
        'SSRF_BLOCKED: URL "http://169.254.169.254" resolves to 169.254.169.254 (link-local / cloud-metadata).',
      ),
    );

    const ctx = createMockContext({ errors: devopsGetIncidents.errors });
    const input = devopsGetIncidents.input.parse({
      vendor: 'http://169.254.169.254',
      filter: 'all',
    });
    await expect(devopsGetIncidents.handler(input, ctx)).rejects.toMatchObject({
      message:
        'URL "http://169.254.169.254" resolves to 169.254.169.254 (link-local / cloud-metadata).',
      data: {
        reason: 'target_blocked',
        recovery: { hint: expect.stringContaining('DEVOPS_STATUS_ALLOW_PRIVATE_TARGETS') },
      },
    });
  });

  it('filters to resolved incidents only', async () => {
    const { _mockFetchIncidents, _mockFetchScheduledMaintenances } = (await import(
      '@/services/statuspage/statuspage-service.js'
    )) as unknown as {
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
    )) as unknown as {
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
    )) as unknown as {
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
    )) as unknown as {
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
    )) as unknown as {
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
    )) as unknown as {
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
    )) as unknown as {
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
    )) as unknown as {
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
          source: 'api' as const,
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
      )) as unknown as {
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
      )) as unknown as {
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
      )) as unknown as {
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
      )) as unknown as {
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

    it('says AWS lists resolved events only while its feed still carries them (#34, #50)', async () => {
      const { fetchAwsIncidents } = await import('@/services/status-adapters/aws-adapter.js');
      // One open event and no resolved one still listed, so filter: "resolved" is empty.
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
      expect(structured.notice).toMatch(/only the incidents its status page currently lists/i);
      expect(structured.notice).not.toMatch(/no resolution lifecycle/i);
      const suggestions = String(structured.notice).split('Try filter:')[1] ?? '';
      // The filter just used and the maintenance feed AWS lacks are never recommended.
      expect(suggestions).not.toContain('"resolved"');
      expect(suggestions).not.toContain('"scheduled"');
      expect(suggestions).toContain('"active"');
    });

    it('returns a resolved AWS event the feed still lists under filter: resolved (#50)', async () => {
      const aws = await import('@/services/status-adapters/aws-adapter.js');
      const actual = await vi.importActual<typeof aws>('@/services/status-adapters/aws-adapter.js');
      // Run the real adapter down to the fetch, so the status mapping is what is tested.
      vi.mocked(aws.fetchAwsIncidents).mockImplementation(actual.fetchAwsIncidents);
      const events = [
        {
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
        },
        {
          arn: 'open-arn',
          status: '3',
          service_name: 'Amazon S3',
          region_name: 'N. Virginia',
          date: '1772050000',
          summary: 'Increased Error Rates',
          event_log: [{ status: 3, message: 'Investigating.', timestamp: 1772050000 }],
        },
      ];
      const http = createFetchMock();
      http.install();
      http.route({
        match: 'https://health.aws.amazon.com/public/currentevents',
        respond: () => new Response(Buffer.from(JSON.stringify(events), 'utf16le')),
      });
      try {
        const ctx = createMockContext({ errors: devopsGetIncidents.errors });
        const result = await devopsGetIncidents.handler(
          devopsGetIncidents.input.parse({ vendor: 'aws', filter: 'resolved' }),
          ctx,
        );

        expect(result.incidents).toEqual([
          expect.objectContaining({
            id: 'resolved-arn',
            status: 'resolved',
            impact: 'minor',
            started_at: '2026-02-25T18:14:29.000Z',
            resolved_at: '2026-02-25T20:51:52.000Z',
            duration_minutes: 157,
          }),
        ]);
        expect(result.incidents[0]!.updates.map((u) => u.status)).toEqual([
          'informational',
          'resolved',
        ]);
        expect(getEnrichment(ctx).notice).toBeUndefined();
        const text = (devopsGetIncidents.format!(result)[0] as { text: string }).text;
        expect(text).toContain('✅ [RESOLVED] Increased Error Rates');
        expect(text).toContain('**Resolved:** 2026-02-25T20:51:52.000Z (157 min)');
      } finally {
        http.restore();
        vi.mocked(aws.fetchAwsIncidents).mockReset();
      }
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
      // A resolved event stays in the AWS feed for hours, so that filter stays on offer (#50).
      expect(suggestions).toContain('"resolved"');
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
      )) as unknown as {
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
      )) as unknown as {
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
    /**
     * Strict upstream fake: a request to a URL no case routed throws rather than
     * reaching the network, so an accidental live call is loud instead of flaky.
     */
    const http = createFetchMock();

    beforeEach(() => {
      http.reset();
      http.install();
    });

    afterEach(() => {
      http.restore();
    });

    it('a non-2xx from the vendor API throws ServiceUnavailable with the reason on the wire', async () => {
      await useRealStatuspageService();
      http.route({ match: /\/api\/v2\//, respond: () => new Response(null, { status: 503 }) });

      const ctx = createMockContext({ errors: devopsGetIncidents.errors });
      const input = devopsGetIncidents.input.parse({ vendor: 'github', filter: 'active' });
      const err = await Promise.resolve(devopsGetIncidents.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect((err as McpError).data).toMatchObject({ reason: 'statuspage_unavailable' });
      expect((err as McpError).message).toContain('HTTP 503');
    });

    it('an unreachable vendor host throws ServiceUnavailable, not an unclassified InternalError', async () => {
      await useRealStatuspageService();
      http.route({
        match: /\/api\/v2\//,
        respond: () => {
          throw new TypeError('Unable to connect. Is the computer able to access the url?');
        },
      });

      const ctx = createMockContext({ errors: devopsGetIncidents.errors });
      const input = devopsGetIncidents.input.parse({ vendor: 'github', filter: 'resolved' });
      const err = await Promise.resolve(devopsGetIncidents.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

      expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect((err as McpError).data).toMatchObject({ reason: 'statuspage_unavailable' });
    });

    /**
     * Characterization of the documented path on recorded Twilio responses: the
     * endpoints requested and every normalized value, pinned so an opt-in addition
     * cannot move them.
     */
    it('filter all requests the two v2 endpoints and normalizes recorded records', async () => {
      await useRealStatuspageService();
      http.route(
        {
          match: 'https://status.twilio.com/api/v2/incidents.json',
          respond: () => Response.json(fixture('twilio-incidents.json')),
        },
        {
          match: 'https://status.twilio.com/api/v2/scheduled-maintenances.json',
          respond: () => Response.json(fixture('twilio-scheduled-maintenances.json')),
        },
      );

      const ctx = createMockContext({ errors: devopsGetIncidents.errors });
      const result = await devopsGetIncidents.handler(
        devopsGetIncidents.input.parse({ vendor: 'twilio', filter: 'all', limit: 50 }),
        ctx,
      );

      expect(http.calls.map((c) => c.request.url).sort()).toEqual([
        'https://status.twilio.com/api/v2/incidents.json',
        'https://status.twilio.com/api/v2/scheduled-maintenances.json',
      ]);
      expect(result.total_returned).toBe(50);
      expect(Object.keys(result.incidents[0]!).sort()).toEqual(
        [
          'affected_components',
          'created_at',
          'duration_minutes',
          'id',
          'impact',
          'name',
          'resolved_at',
          'scheduled_for',
          'scheduled_until',
          'shortlink',
          'source',
          'started_at',
          'status',
          'updates',
        ].sort(),
      );
      expect(result.incidents.find((i) => i.id === 'hpwx3sl7kbz0')).toEqual({
        id: 'hpwx3sl7kbz0',
        name: 'Event Streams Service Disruption',
        impact: 'minor',
        status: 'resolved',
        created_at: '2026-09-24T13:40:23.826-07:00',
        started_at: '2026-09-24T13:40:23.817-07:00',
        resolved_at: '2026-09-24T19:24:38.620-07:00',
        scheduled_for: null,
        scheduled_until: null,
        duration_minutes: 344,
        shortlink: 'https://stspg.io/jvck7rxc4qr9',
        affected_components: [
          'SendGrid Marketing Campaigns',
          'SendGrid Webhooks - Event Webhooks',
          'SendGrid Statistics',
          'SendGrid Email Activity',
        ],
        updates: [
          {
            status: 'investigating',
            body: 'We are investigating a service interruption with Event Streams. Customers may experience event data loss or delays in event delivery. Our team is actively investigating the scope of impact and data recovery options. We expect to provide another update in 2 hours or as soon as more information becomes available.',
            created_at: '2026-09-24T13:40:23.924-07:00',
          },
          {
            status: 'resolved',
            body: 'Our engineers have monitored the fix and confirmed the issue with event streams has been resolved. All services are now operating normally at this time.',
            created_at: '2026-09-24T19:24:38.620-07:00',
          },
        ],
        source: 'api',
      });
      expect(result.incidents.every((i) => i.source === 'api')).toBe(true);
      const maintenance = result.incidents.find((i) => i.id === 'bn6yyz65wk75');
      expect(maintenance).toMatchObject({
        impact: 'maintenance',
        status: 'completed',
        scheduled_for: '2026-09-17T18:00:00.000-07:00',
        scheduled_until: '2026-09-24T18:00:00.000-07:00',
      });

      const structured = devopsGetIncidents.output
        .extend(devopsGetIncidents.enrichment!)
        .parse({ ...result, ...getEnrichment(ctx) });
      expect(structured).toMatchObject({
        truncated: true,
        totalCount: 52,
        nextOffset: 50,
        upstreamCeiling: 50,
      });
    });

    it('filter resolved requests only the v2 incidents endpoint', async () => {
      await useRealStatuspageService();
      http.route({
        match: 'https://status.twilio.com/api/v2/incidents.json',
        respond: () => Response.json(fixture('twilio-incidents.json')),
      });

      const ctx = createMockContext({ errors: devopsGetIncidents.errors });
      const result = await devopsGetIncidents.handler(
        devopsGetIncidents.input.parse({ vendor: 'twilio', filter: 'resolved', limit: 50 }),
        ctx,
      );

      expect(http.calls.map((c) => c.request.url)).toEqual([
        'https://status.twilio.com/api/v2/incidents.json',
      ]);
      expect(result.incidents.every((i) => ['resolved', 'postmortem'].includes(i.status))).toBe(
        true,
      );
      expect(result.total_returned).toBe(41);
    });

    it('a 200 that is not a Statuspage payload throws the contract, never a raw TypeError', async () => {
      await useRealStatuspageService();
      http.route({
        match: /\/api\/v2\//,
        respond: () => Response.json({ args: {}, headers: {}, method: 'GET' }),
      });

      const ctx = createMockContext({ errors: devopsGetIncidents.errors });
      // filter 'all' is the path that used to die on `incData.data.incidents.map`.
      const input = devopsGetIncidents.input.parse({ vendor: 'github', filter: 'all' });
      const err = await Promise.resolve(devopsGetIncidents.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

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
          source: 'api' as const,
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
    // Characterization: the whole rendered block, line by line.
    expect(text).toBe(
      [
        '## GitHub (github) — 1 incidents',
        '**URL:** https://www.githubstatus.com',
        '',
        '### ✅ API Issue `inc-001`',
        '**Impact:** minor | **Status:** resolved | **Source:** api | **Created:** 2025-01-01T08:00:00Z | **Started:** 2025-01-01T08:00:00Z',
        '**Resolved:** 2025-01-01T10:00:00Z (120 min)',
        '**Components:** API',
        '**Updates (1):**',
        '- [2025-01-01T10:00:00Z] resolved: All clear.',
        '[Incident page](https://stspg.io/001)',
        '',
      ].join('\n'),
    );
  });

  /**
   * The real Azure adapter runs down to the fetch fake, serving the archived feed
   * capture of 2026-07-23 (one item, nine services plus one region).
   */
  describe('azure (#42)', () => {
    const http = createFetchMock();
    const FEED = 'https://rssfeed.azure.status.microsoft/en-us/status/feed/';
    const capture = readFileSync(
      new URL(
        '../../../services/status-adapters/fixtures/azure-feed-20260723.xml',
        import.meta.url,
      ),
      'utf-8',
    );

    beforeEach(() => {
      http.reset();
      http.install();
      http.route({ match: FEED, respond: () => new Response(capture) });
    });

    afterEach(() => {
      http.restore();
    });

    async function call(filter: string) {
      const ctx = createMockContext({ errors: devopsGetIncidents.errors });
      const result = await devopsGetIncidents.handler(
        devopsGetIncidents.input.parse({ vendor: 'azure', filter }),
        ctx,
      );
      const structured = devopsGetIncidents.output
        .extend(devopsGetIncidents.enrichment!)
        .parse({ ...result, ...getEnrichment(ctx) });
      const text = (devopsGetIncidents.format!(result)[0] as { text: string }).text;
      return { result, structured, text };
    }

    it('returns the listed item as an open minor incident, categories as its components', async () => {
      const { result, structured, text } = await call('all');

      expect(result.incidents).toEqual([
        {
          id: 'issues-connecting-to-resources-in-west-us@2026-07-23T16:29:09.000Z',
          name: 'Issues connecting to resources in West US',
          impact: 'minor',
          status: 'investigating',
          created_at: '2026-07-23T16:29:09.000Z',
          started_at: '2026-07-23T16:29:09.000Z',
          resolved_at: null,
          scheduled_for: null,
          scheduled_until: null,
          duration_minutes: null,
          shortlink: null,
          affected_components: [
            'API Management',
            'Application Gateway',
            'Azure Database for PostgreSQL',
            'Azure Kubernetes Service (AKS)',
            'ExpressRoute Circuits',
            'ExpressRoute Gateways',
            'Network Infrastructure',
            'VPN Gateway',
            'Virtual WAN',
            'West US',
          ],
          updates: [
            {
              status: 'investigating',
              body: expect.stringMatching(/^We are investigating a networking issue/),
              created_at: '2026-07-23T16:29:09.000Z',
            },
          ],
          source: 'api',
        },
      ]);
      expect(result.incidents[0]!.updates[0]!.body).not.toMatch(/<p>|&lt;|&nbsp;/);
      expect(structured.notice).toBeUndefined();
      expect(http.calls.map((c) => c.request.url)).toEqual([FEED]);

      expect(text).toContain('## Microsoft Azure (azure) — 1 incidents');
      expect(text).toContain(
        '**Impact:** minor | **Status:** investigating | **Source:** api | **Created:** 2026-07-23T16:29:09.000Z',
      );
      expect(text).toContain('**Components:** API Management, Application Gateway,');
      expect(text).toContain('- [2026-07-23T16:29:09.000Z] investigating: We are investigating');
      expect(text).not.toContain('[Incident page]');
    });

    it('returns the item under filter: active', async () => {
      const { result } = await call('active');
      expect(result.incidents.map((i) => i.status)).toEqual(['investigating']);
    });

    it('filter: resolved is empty and says the feed has no resolution lifecycle', async () => {
      const { result, structured, text } = await call('resolved');

      expect(result.total_returned).toBe(0);
      expect(structured.notice).toContain('Microsoft Azure');
      expect(structured.notice).toMatch(/no resolution lifecycle/i);
      const suggestions = String(structured.notice).split('Try filter:')[1] ?? '';
      expect(suggestions).not.toContain('"resolved"');
      expect(suggestions).not.toContain('"scheduled"');
      expect(suggestions).toContain('"active"');
      expect(text).toContain('No incidents matched this filter.');
    });

    it('filter: scheduled is empty with no feed request and says there is no maintenance feed', async () => {
      const { result, structured } = await call('scheduled');

      expect(result.total_returned).toBe(0);
      expect(http.calls).toHaveLength(0);
      expect(structured.notice).toContain('Microsoft Azure');
      expect(structured.notice).toMatch(/no scheduled-maintenance feed/i);
      const suggestions = String(structured.notice).split('Try filter:')[1] ?? '';
      expect(suggestions).not.toContain('"scheduled"');
      expect(suggestions).not.toContain('"resolved"');
    });

    it('a body that is not the feed surfaces statuspage_unavailable', async () => {
      http.reset();
      http.route({ match: FEED, respond: () => new Response('<html>maintenance</html>') });

      const ctx = createMockContext({ errors: devopsGetIncidents.errors });
      const err = await Promise.resolve(
        devopsGetIncidents.handler(
          devopsGetIncidents.input.parse({ vendor: 'azure', filter: 'all' }),
          ctx,
        ),
      ).catch((e: unknown) => e);

      expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect((err as McpError).data).toMatchObject({ reason: 'statuspage_unavailable' });
    });
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
      )) as unknown as {
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
      )) as unknown as {
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

  /**
   * `since` reads the status page's quarterly history archive past the v2 feed's
   * 50-record ceiling. Every case runs the real service, fetch, redirect, and
   * shape-gate path against recorded pages; the clock is pinned to the day they
   * were recorded so page 1 is still the current quarter.
   */
  describe('deep history (since)', () => {
    const http = createFetchMock();

    beforeEach(async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-25T05:00:00Z'));
      http.reset();
      http.install();
      await useRealStatuspageService();
    });

    afterEach(() => {
      http.restore();
      vi.useRealTimers();
    });

    const json = (name: string) => () => Response.json(fixture(name));
    const historyPage = (base: string, page: number) => `${base}/history.json?page=${page}`;
    const requested = () => http.calls.map((c) => c.request.url);
    const historyRequests = () => requested().filter((u) => u.includes('/history.json'));

    type HistoryFixture = {
      months: {
        name: string;
        incidents: { code: string; name: string; message: string; timestamp: string }[];
      }[];
    };
    const historyRecord = (name: string, code: string) =>
      (fixture(name) as HistoryFixture).months
        .flatMap((m) => m.incidents)
        .find((r) => r.code === code)!;

    async function call(args: Record<string, unknown>) {
      const ctx = createMockContext({ errors: devopsGetIncidents.errors });
      const result = await devopsGetIncidents.handler(devopsGetIncidents.input.parse(args), ctx);
      const structured = devopsGetIncidents.output
        .extend(devopsGetIncidents.enrichment!)
        .parse({ ...result, ...getEnrichment(ctx) });
      return { result, structured };
    }

    const GITHUB = 'https://www.githubstatus.com';
    /** GitHub history page 1's records that neither v2 list carries, newest first. */
    const PAGE_ONE_HISTORY_ONLY = ['zq3c1jst2vkq', '20frdtvv3yg6', 'g40zcbvchny4'];
    function routeGithub(
      pages: Record<number, (req: Request) => Response | Promise<Response>> = {},
    ) {
      http.route(
        { match: `${GITHUB}/api/v2/incidents.json`, respond: json('github-incidents.json') },
        {
          match: `${GITHUB}/api/v2/scheduled-maintenances.json`,
          respond: json('github-scheduled-maintenances.json'),
        },
      );
      for (let page = 1; page <= 5; page++) {
        http.route({
          match: historyPage(GITHUB, page),
          respond: pages[page] ?? json(`github-history-p${page}.json`),
        });
      }
    }

    const TWILIO = 'https://status.twilio.com';
    function routeTwilio() {
      http.route(
        { match: `${TWILIO}/api/v2/incidents.json`, respond: json('twilio-incidents.json') },
        {
          match: `${TWILIO}/api/v2/scheduled-maintenances.json`,
          respond: json('twilio-scheduled-maintenances.json'),
        },
      );
      for (let page = 1; page <= 4; page++) {
        http.route({
          match: historyPage(TWILIO, page),
          respond: json(`twilio-history-p${page}.json`),
        });
      }
    }

    it('github, resolved, one year back: reaches records older than the oldest v2 record', async () => {
      routeGithub();
      const { result, structured } = await call({
        vendor: 'github',
        filter: 'resolved',
        since: '2025-09-25',
        limit: 50,
      });

      // One quarter per page, stopping at the first quarter that holds the floor.
      expect(historyRequests()).toEqual([1, 2, 3, 4, 5].map((p) => historyPage(GITHUB, p)));
      // Under resolved the maintenance list is read too, so a record it carries is not re-added.
      expect(requested()).toContain(`${GITHUB}/api/v2/scheduled-maintenances.json`);

      const oldestV2 = Date.parse('2026-07-24T11:00:00.000Z');
      const all = [...result.incidents];
      let next = structured.nextOffset as number | undefined;
      while (next !== undefined) {
        const page = await call({
          vendor: 'github',
          filter: 'resolved',
          since: '2025-09-25',
          limit: 50,
          offset: next,
        });
        all.push(...page.result.incidents);
        next = page.structured.nextOffset as number | undefined;
      }
      const history = all.filter((i) => i.source === 'history');
      expect(history.length).toBeGreaterThan(0);
      expect(history.some((i) => Date.parse(i.created_at) < oldestV2)).toBe(true);
      for (const i of history) {
        expect(i.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/);
        expect(i.resolved_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/);
        expect(i.status).toBe('resolved');
      }
      // No id twice, and the three page-1 records v2 already carries stay v2 records.
      const ids = all.map((i) => i.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ['1dk955gg3bvz', '8zc63m64hy36', 'f6yrxnz5f7bs']) {
        expect(all.filter((i) => i.id === id).map((i) => i.source)).toEqual(['api']);
      }
      // Floored on start: page 5's September records are in, its July and August ones out.
      expect(ids).toContain('0s5rb1l03m76');
      expect(ids).not.toContain('x7gtw6r3x2s1');
      expect(ids).not.toContain('spbr5ff8hyt2');
      expect(all.every((i) => Date.parse(i.created_at) >= Date.parse('2025-09-25T00:00:00Z'))).toBe(
        true,
      );
      // Newest first across both sources.
      const times = all.map((i) => Date.parse(i.created_at));
      expect([...times].sort((a, b) => b - a)).toEqual(times);
      // The floor was reached, so the v2 ceiling no longer bounds this result.
      expect(structured.upstreamCeiling).toBeUndefined();

      const raw = historyRecord('github-history-p1.json', 'zq3c1jst2vkq');
      expect(all.find((i) => i.id === 'zq3c1jst2vkq')).toEqual({
        id: 'zq3c1jst2vkq',
        name: raw.name,
        impact: 'major',
        status: 'resolved',
        created_at: '2026-07-23T07:53:00.000Z',
        started_at: null,
        resolved_at: '2026-07-23T09:39:00.000Z',
        scheduled_for: null,
        scheduled_until: null,
        duration_minutes: null,
        shortlink: 'https://www.githubstatus.com/incidents/zq3c1jst2vkq',
        affected_components: [],
        updates: [
          { status: 'resolved', body: raw.message, created_at: '2026-07-23T09:39:00.000Z' },
        ],
        source: 'history',
      });
    });

    it('twilio, all: walks four quarters and merges history under both v2 lists', async () => {
      routeTwilio();
      const { result, structured } = await call({
        vendor: 'twilio',
        filter: 'all',
        since: '2025-12-29',
        limit: 50,
      });
      const rest = await call({
        vendor: 'twilio',
        filter: 'all',
        since: '2025-12-29',
        limit: 50,
        offset: 50,
      });
      const all = [...result.incidents, ...rest.result.incidents];
      const byId = (id: string) => all.filter((i) => i.id === id);

      expect(historyRequests()).toEqual(
        [1, 2, 3, 4, 1, 2, 3, 4].map((p) => historyPage(TWILIO, p)),
      );
      // 50 v2 incidents + 2 v2 maintenances + 15 history-only records at or after the floor.
      expect(structured).toMatchObject({ truncated: true, totalCount: 67, nextOffset: 50 });
      expect(rest.result.total_returned).toBe(17);
      expect(rest.structured.nextOffset).toBeUndefined();
      expect(structured.upstreamCeiling).toBeUndefined();

      // A record in both sources appears once, as the v2 record — from either v2 list.
      expect(byId('hpwx3sl7kbz0').map((i) => i.source)).toEqual(['api']);
      expect(byId('st6rn5kjs488').map((i) => i.source)).toEqual(['api']);
      expect(byId('yll2y7hhb3hd')).toEqual([
        expect.objectContaining({ source: 'api', impact: 'maintenance' }),
      ]);
      expect(byId('bn6yyz65wk75')).toEqual([
        expect.objectContaining({
          source: 'api',
          status: 'completed',
          scheduled_for: '2026-09-17T18:00:00.000-07:00',
        }),
      ]);

      // A history record with no end has no published lifecycle stage.
      expect(byId('408d7njdzzlw')).toEqual([
        expect.objectContaining({
          source: 'history',
          status: 'unknown',
          created_at: '2026-09-25T03:00:00.000Z',
          resolved_at: null,
          updates: [
            expect.objectContaining({ status: 'unknown', created_at: '2026-09-25T03:00:00.000Z' }),
          ],
        }),
      ]);

      // Year boundary: December starts filed under the January 2026 bucket.
      expect(byId('bchpvm9st7h2')[0]).toMatchObject({
        created_at: '2026-01-01T06:28:00.000Z',
        resolved_at: '2026-01-01T16:17:00.000Z',
      });
      expect(byId('lc1txpxrvm2r')[0]).toMatchObject({
        created_at: '2025-12-29T08:32:00.000Z',
        resolved_at: '2026-01-06T21:43:00.000Z',
      });

      // Both sides of the 2026-03-08 PST → PDT change, and a span straddling it.
      expect(byId('q5vcf66029py')[0]).toMatchObject({
        created_at: '2026-03-07T18:45:00.000Z',
        resolved_at: '2026-03-07T23:36:00.000Z',
      });
      expect(byId('4lmk03nn0ptx')[0]).toMatchObject({
        created_at: '2026-03-09T16:22:00.000Z',
        resolved_at: '2026-03-09T21:30:00.000Z',
      });
      expect(byId('rkvy1mv3c47t')[0]).toMatchObject({
        created_at: '2026-03-07T15:50:00.000Z',
        resolved_at: '2026-03-10T11:12:00.000Z',
      });

      // Page 4 holds the floor, which is UTC midnight: Dec 30 is in, and so is Dec 28
      // 18:01 PST (2025-12-29T02:01Z); November and October are out.
      expect(byId('xcdk5zq41ztc')[0]).toMatchObject({ created_at: '2025-12-31T01:55:00.000Z' });
      expect(byId('l389xq3k5gqw')[0]).toMatchObject({ created_at: '2025-12-29T02:01:00.000Z' });
      for (const id of ['jd1ldm4c680v', 'h7ngyb37q2pb']) expect(byId(id)).toEqual([]);

      const ids = all.map((i) => i.id);
      expect(new Set(ids).size).toBe(ids.length);

      // Both consumption paths carry the source.
      const text = (devopsGetIncidents.format!(rest.result)[0] as { text: string }).text;
      expect(text).toContain('**Source:** history');
      expect(text).toContain('`bchpvm9st7h2`');
      const firstText = (devopsGetIncidents.format!(result)[0] as { text: string }).text;
      expect(firstText).toContain('**Source:** api');
      expect(firstText).toContain('**Status:** unknown');
    });

    it('an offset past the merged list names the valid range', async () => {
      routeTwilio();
      const { result, structured } = await call({
        vendor: 'twilio',
        filter: 'all',
        since: '2025-12-29',
        offset: 9999,
      });
      expect(result.total_returned).toBe(0);
      expect(structured.notice).toContain('matched 67 incidents');
      expect(structured.notice).toContain('0–66');
    });

    it('cloudflare (no archive, HTTP 404): returns the v2 result with the gap named, never an error', async () => {
      const base = 'https://www.cloudflarestatus.com';
      http.route(
        { match: `${base}/api/v2/incidents.json`, respond: json('cloudflare-incidents.json') },
        {
          match: `${base}/api/v2/scheduled-maintenances.json`,
          respond: () =>
            Response.json({ page: { name: 'Cloudflare Status' }, scheduled_maintenances: [] }),
        },
        {
          match: historyPage(base, 1),
          respond: () =>
            Response.json(
              {
                errors: [{ code: 1001, message: 'no matching operation was found' }],
                messages: [],
                success: false,
              },
              { status: 404 },
            ),
        },
      );

      const { result, structured } = await call({
        vendor: 'cloudflare',
        filter: 'resolved',
        since: '2026-09-15',
        limit: 50,
      });

      expect(historyRequests()).toEqual([historyPage(base, 1)]);
      expect(result.total_returned).toBeGreaterThan(0);
      expect(result.incidents.every((i) => i.source === 'api')).toBe(true);
      expect(
        result.incidents.every(
          (i) => Date.parse(i.created_at) >= Date.parse('2026-09-15T00:00:00Z'),
        ),
      ).toBe(true);
      expect(structured.upstreamCeiling).toBe(50);
      expect(structured.notice).toContain('404');
      expect(structured.notice).toContain('2026-09-15');
      expect(structured.notice).toContain(base);
    });

    /**
     * Under resolved the maintenance list is read only to match archive records against,
     * so its failure costs the archive, never the v2 result the same call without since
     * returns.
     */
    it('resolved: a failed maintenance read skips the archive and keeps the v2 result', async () => {
      http.route(
        { match: `${GITHUB}/api/v2/incidents.json`, respond: json('github-incidents.json') },
        {
          match: `${GITHUB}/api/v2/scheduled-maintenances.json`,
          respond: () => new Response('upstream error', { status: 500 }),
        },
      );

      const { result, structured } = await call({
        vendor: 'github',
        filter: 'resolved',
        since: '2026-01-01',
        limit: 50,
      });

      expect(historyRequests()).toEqual([]);
      expect(result.total_returned).toBe(50);
      expect(result.incidents.every((i) => i.source === 'api')).toBe(true);
      expect(structured.upstreamCeiling).toBe(50);
      expect(structured.notice).toContain('HTTP 500');
      expect(structured.notice).toContain('2026-01-01');
    });

    it('all: a failed maintenance read still fails the call, as it does without since', async () => {
      http.route(
        { match: `${GITHUB}/api/v2/incidents.json`, respond: json('github-incidents.json') },
        {
          match: `${GITHUB}/api/v2/scheduled-maintenances.json`,
          respond: () => new Response('upstream error', { status: 500 }),
        },
      );

      const err = await call({ vendor: 'github', filter: 'all', since: '2026-01-01' }).catch(
        (e: unknown) => e,
      );
      expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(historyRequests()).toEqual([]);
    });

    it('a timeout on page 2 keeps page 1 and says how far history reached', async () => {
      routeGithub({
        2: (req) =>
          new Promise<Response>((_, reject) => {
            req.signal.addEventListener('abort', () => reject(req.signal.reason));
          }),
      });

      // All 50 v2 records are resolved and newer than any history record, so offset 50
      // is exactly where the history-only records begin.
      const { result, structured } = await call({
        vendor: 'github',
        filter: 'resolved',
        since: '2025-09-25',
        limit: 50,
        offset: 50,
      });

      expect(historyRequests()).toEqual([historyPage(GITHUB, 1), historyPage(GITHUB, 2)]);
      expect(result.incidents.map((i) => i.id)).toEqual(PAGE_ONE_HISTORY_ONLY);
      expect(structured.upstreamCeiling).toBe(50);
      expect(structured.notice).toContain('2026-07-01');
      expect(structured.notice).toMatch(/timed out/i);
    });

    it('a page that is not a history payload stops the walk with the gap named', async () => {
      routeGithub({ 3: () => Response.json({ months: 'unavailable' }) });

      const { result, structured } = await call({
        vendor: 'github',
        filter: 'resolved',
        since: '2025-09-25',
        limit: 50,
        offset: 50,
      });

      expect(historyRequests()).toEqual([1, 2, 3].map((p) => historyPage(GITHUB, p)));
      const pageTwoCodes = (fixture('github-history-p2.json') as HistoryFixture).months.flatMap(
        (m) => m.incidents.map((r) => r.code),
      );
      expect(result.incidents.map((i) => i.id).sort()).toEqual(
        [...PAGE_ONE_HISTORY_ONLY, ...pageTwoCodes].sort(),
      );
      expect(result.incidents.every((i) => i.source === 'history')).toBe(true);
      expect(structured.upstreamCeiling).toBe(50);
      expect(structured.notice).toContain('2026-04-01');
      expect(structured.notice).toContain('history payload');
    });

    it('a timestamp outside the known grammar drops that page and names the gap', async () => {
      const page2 = fixture('github-history-p2.json') as HistoryFixture;
      const broken = page2.months[0]!.incidents[0]!;
      broken.timestamp = 'Jun 30, 2026 10:00 UTC';
      routeGithub({ 2: () => Response.json(page2) });

      const { result, structured } = await call({
        vendor: 'github',
        filter: 'resolved',
        since: '2025-09-25',
        limit: 50,
        offset: 50,
      });

      expect(historyRequests()).toEqual([historyPage(GITHUB, 1), historyPage(GITHUB, 2)]);
      // The page with the unreadable record contributes nothing; page 1 stands.
      expect(result.incidents.map((i) => i.id)).toEqual(PAGE_ONE_HISTORY_ONLY);
      expect(structured.upstreamCeiling).toBe(50);
      expect(structured.notice).toContain(broken.code);
      expect(structured.notice).toContain('2026-07-01');
    });

    /**
     * status.sendgrid.com 302s every history URL to status.twilio.com/history.json,
     * dropping ?page=, so page 2 arrives as page 1 again.
     */
    it('a redirect that drops the page parameter never presents page 1 as an older quarter', async () => {
      const base = 'https://status.sendgrid.com';
      const redirect = (location: string) => () =>
        new Response(null, { status: 302, headers: { location } });
      http.route(
        {
          match: `${base}/api/v2/incidents.json`,
          respond: redirect(`${TWILIO}/api/v2/incidents.json`),
        },
        {
          match: `${base}/api/v2/scheduled-maintenances.json`,
          respond: redirect(`${TWILIO}/api/v2/scheduled-maintenances.json`),
        },
        {
          match: (req) => req.url.startsWith(`${base}/history.json?page=`),
          respond: redirect(`${TWILIO}/history.json`),
        },
        { match: `${TWILIO}/api/v2/incidents.json`, respond: json('twilio-incidents.json') },
        {
          match: `${TWILIO}/api/v2/scheduled-maintenances.json`,
          respond: json('twilio-scheduled-maintenances.json'),
        },
        { match: `${TWILIO}/history.json`, respond: json('twilio-history-p1.json') },
      );

      const { result, structured } = await call({
        vendor: 'sendgrid',
        filter: 'all',
        since: '2026-01-01',
        limit: 50,
      });

      expect(historyRequests()).toEqual([
        historyPage(base, 1),
        `${TWILIO}/history.json`,
        historyPage(base, 2),
        `${TWILIO}/history.json`,
      ]);
      const pageOneStart = Date.parse('2026-07-01T00:00:00-07:00');
      const history = result.incidents.filter((i) => i.source === 'history');
      expect(history.length).toBeGreaterThan(0);
      expect(history.every((i) => Date.parse(i.created_at) >= pageOneStart)).toBe(true);
      expect(structured.upstreamCeiling).toBe(50);
      expect(structured.notice).toContain('page 2');
      expect(structured.notice).toContain('2026-07-01');
    });

    /**
     * A raw URL points the walk at any host. One whose page 1 claims a quarter years
     * ahead, then steps back one quarter per page, passes every per-page check, so the
     * walk must stop on a page count the floor fixes rather than on the page contents.
     */
    it('stops after the pages the floor needs when the archive starts in the future', async () => {
      const base = 'https://status.future.example';
      const quarterStart = (page: number) => {
        const quarter = 2036 * 4 + 3 - (page - 1);
        const month = String((quarter % 4) * 3 + 1).padStart(2, '0');
        return `${Math.floor(quarter / 4)}-${month}-01T00:00:00Z`;
      };
      http.route(
        { match: `${base}/api/v2/incidents.json`, respond: json('github-incidents.json') },
        {
          match: `${base}/api/v2/scheduled-maintenances.json`,
          respond: json('github-scheduled-maintenances.json'),
        },
        {
          match: (req) => req.url.startsWith(`${base}/history.json?page=`),
          respond: (req) => {
            const page = Number(new URL(req.url).searchParams.get('page'));
            return Response.json({ start_time: quarterStart(page), months: [] });
          },
        },
      );

      const { result, structured } = await call({
        vendor: base,
        filter: 'resolved',
        since: '2025-09-25',
        limit: 50,
      });

      // 2025-09-25 is four quarters back: five pages reach it, plus a page of slack at
      // each end for a page zone on either side of UTC.
      expect(historyRequests()).toEqual([1, 2, 3, 4, 5, 6, 7].map((p) => historyPage(base, p)));
      expect(result.total_returned).toBe(50);
      expect(result.incidents.every((i) => i.source === 'api')).toBe(true);
      expect(structured.upstreamCeiling).toBe(50);
      expect(structured.notice).toContain('2035-04-01');
      expect(structured.notice).toContain('2025-09-25');
    });

    it('a history month with an out-of-range year stops the walk rather than failing the call', async () => {
      const page2 = fixture('github-history-p2.json') as HistoryFixture & {
        months: { year: number }[];
      };
      page2.months[0]!.year = 300_000;
      routeGithub({ 2: () => Response.json(page2) });

      const { result, structured } = await call({
        vendor: 'github',
        filter: 'resolved',
        since: '2025-09-25',
        limit: 50,
        offset: 50,
      });

      expect(historyRequests()).toEqual([historyPage(GITHUB, 1), historyPage(GITHUB, 2)]);
      expect(result.incidents.map((i) => i.id)).toEqual(PAGE_ONE_HISTORY_ONLY);
      expect(structured.upstreamCeiling).toBe(50);
      expect(structured.notice).toContain('2026-07-01');
      expect(structured.notice).toContain('history payload');
    });

    it('a non-Statuspage backend applies the floor and requests no history', async () => {
      http.route({
        match: 'https://status.cloud.google.com/incidents.json',
        respond: () =>
          Response.json(
            JSON.parse(
              readFileSync(
                new URL(
                  '../../../services/status-adapters/fixtures/gcp-incidents.json',
                  import.meta.url,
                ),
                'utf-8',
              ),
            ),
          ),
      });

      const { result, structured } = await call({
        vendor: 'gcp',
        filter: 'all',
        since: '2026-06-01',
      });

      expect(requested()).toEqual(['https://status.cloud.google.com/incidents.json']);
      expect(result.incidents.map((i) => i.id)).toEqual([
        '3BvH3LVGcupoYqV6F4Nw',
        'T8gmtofFSTGT5tbhyciF',
        '5fGQt4VbkDnr3Yp8PXPr',
      ]);
      expect(result.incidents.every((i) => i.source === 'api')).toBe(true);
      expect(structured.notice).toBeUndefined();
    });

    it('a floor that leaves nothing says so and points at an earlier since', async () => {
      routeGithub();
      const { result, structured } = await call({
        vendor: 'github',
        filter: 'resolved',
        since: '2026-09-25',
      });

      expect(historyRequests()).toEqual([historyPage(GITHUB, 1)]);
      expect(result.total_returned).toBe(0);
      expect(structured.notice).toContain('2026-09-25');
      expect(structured.notice).toMatch(/earlier since/);
      expect(structured.notice).not.toMatch(/no incidents and no maintenance windows/i);
    });

    it('an empty since is read as omitted, as form clients send it', async () => {
      http.route(
        { match: `${GITHUB}/api/v2/incidents.json`, respond: json('github-incidents.json') },
        {
          match: `${GITHUB}/api/v2/scheduled-maintenances.json`,
          respond: json('github-scheduled-maintenances.json'),
        },
      );
      const { result } = await call({ vendor: 'github', filter: 'all', since: '' });
      expect(historyRequests()).toEqual([]);
      expect(result.incidents.every((i) => i.source === 'api')).toBe(true);
    });

    /**
     * Some v2-compatible pages publish no `page.time_zone`. The archive's timestamps
     * cannot be placed without it, so no page is requested and the gap is named.
     */
    it('a page with no time zone reads no history and names why', async () => {
      const incidents = fixture('github-incidents.json') as { page: Record<string, unknown> };
      delete incidents.page.time_zone;
      // No history route: the strict fetch fake throws on any archive request.
      http.route(
        { match: `${GITHUB}/api/v2/incidents.json`, respond: () => Response.json(incidents) },
        {
          match: `${GITHUB}/api/v2/scheduled-maintenances.json`,
          respond: json('github-scheduled-maintenances.json'),
        },
      );

      const { result, structured } = await call({
        vendor: 'github',
        filter: 'resolved',
        since: '2026-01-01',
        limit: 50,
      });

      expect(historyRequests()).toEqual([]);
      expect(result.total_returned).toBe(50);
      expect(structured.upstreamCeiling).toBe(50);
      expect(structured.notice).toContain('time zone');
      expect(structured.notice).toContain('2026-01-01');
    });

    /** The archive's own Rails zone name is not IANA; a v2 page that sent one is named, not guessed. */
    it('a page whose time zone is not an IANA zone reads no history and names it', async () => {
      const incidents = fixture('github-incidents.json') as { page: Record<string, unknown> };
      incidents.page.time_zone = 'Pacific Time (US & Canada)';
      http.route(
        { match: `${GITHUB}/api/v2/incidents.json`, respond: () => Response.json(incidents) },
        {
          match: `${GITHUB}/api/v2/scheduled-maintenances.json`,
          respond: json('github-scheduled-maintenances.json'),
        },
      );

      const { result, structured } = await call({
        vendor: 'github',
        filter: 'all',
        since: '2026-01-01',
        limit: 10,
      });

      expect(historyRequests()).toEqual([]);
      expect(result.incidents.every((i) => i.source === 'api')).toBe(true);
      expect(structured.upstreamCeiling).toBe(50);
      expect(structured.notice).toContain('"Pacific Time (US & Canada)"');
      expect(structured.notice).toContain('not a recognized zone');
    });

    describe('since validation', () => {
      it.each(['active', 'scheduled'])(
        'rejects since with filter %s before any request',
        async (filter) => {
          const ctx = createMockContext({ errors: devopsGetIncidents.errors });
          const err = await Promise.resolve(
            devopsGetIncidents.handler(
              devopsGetIncidents.input.parse({ vendor: 'github', filter, since: '2026-01-01' }),
              ctx,
            ),
          ).catch((e: unknown) => e);

          expect(err).toBeInstanceOf(McpError);
          expect((err as McpError).code).toBe(JsonRpcErrorCode.ValidationError);
          expect((err as McpError).data).toMatchObject({
            reason: 'invalid_since',
            recovery: { hint: expect.stringContaining('24 months') },
          });
          expect((err as McpError).message).toContain(`"${filter}"`);
          expect(http.calls).toHaveLength(0);
        },
      );

      it('rejects a since more than 24 months back, naming the earliest accepted date', async () => {
        const ctx = createMockContext({ errors: devopsGetIncidents.errors });
        const err = await Promise.resolve(
          devopsGetIncidents.handler(
            devopsGetIncidents.input.parse({
              vendor: 'github',
              filter: 'all',
              since: '2024-09-24',
            }),
            ctx,
          ),
        ).catch((e: unknown) => e);

        expect((err as McpError).code).toBe(JsonRpcErrorCode.ValidationError);
        expect((err as McpError).data).toMatchObject({ reason: 'invalid_since' });
        expect((err as McpError).message).toContain('24 months');
        expect((err as McpError).message).toContain('2024-09-25');
        expect(http.calls).toHaveLength(0);
      });

      it('accepts a since exactly 24 months back', async () => {
        http.route({
          match: 'https://status.cloud.google.com/incidents.json',
          respond: () => Response.json([]),
        });
        const { result } = await call({ vendor: 'gcp', filter: 'resolved', since: '2024-09-25' });
        expect(result.total_returned).toBe(0);
      });

      it.each(['2025-13-01', '09/25/2025', '2025-9-1', 'last year'])(
        'rejects the malformed date %s at the schema',
        (since) => {
          const parsed = devopsGetIncidents.input.safeParse({ vendor: 'github', since });
          expect(parsed.success).toBe(false);
          // Rejected as a malformed value of the field, not as an unknown key.
          expect(parsed.error?.issues.map((i) => i.code)).not.toContain('unrecognized_keys');
          expect(parsed.error?.issues.every((i) => i.path[0] === 'since')).toBe(true);
        },
      );
    });
  });

  /**
   * After an empty `active`, a wider filter can only return more when the backend's
   * feed can carry something `active` excludes — a resolved incident or a maintenance
   * window. Each row runs that backend's real adapter down to the fetch fake, serving
   * a feed with nothing open (#57).
   */
  describe('empty filter: "active" on every backend (#57)', () => {
    const http = createFetchMock();
    const AZURE_FEED = 'https://rssfeed.azure.status.microsoft/en-us/status/feed/';
    const emptyAzureFeed = readFileSync(
      new URL('../../../services/status-adapters/fixtures/azure-feed-empty.xml', import.meta.url),
      'utf-8',
    );

    beforeEach(async () => {
      http.reset();
      http.install();
      await useRealStatuspageService();
      const aws = await import('@/services/status-adapters/aws-adapter.js');
      const actual = await vi.importActual<typeof aws>('@/services/status-adapters/aws-adapter.js');
      vi.mocked(aws.fetchAwsIncidents).mockImplementation(actual.fetchAwsIncidents);
    });

    afterEach(async () => {
      http.restore();
      const aws = await import('@/services/status-adapters/aws-adapter.js');
      vi.mocked(aws.fetchAwsIncidents).mockReset();
    });

    const retry = (name: string, filters: string) =>
      `No incidents matched filter "active" for ${name}. Try filter: ${filters}.`;

    it.each([
      {
        backend: 'statuspage',
        vendor: 'github',
        feed: 'https://www.githubstatus.com/api/v2/incidents.json',
        body: () => Response.json({ ...RESOLVED_INCIDENT, incidents: [] }),
        notice: retry('GitHub', '"all" or "resolved" or "scheduled"'),
      },
      {
        backend: 'statusio',
        vendor: 'gitlab',
        feed: 'https://status-api.hostedstatus.com/1.0/status/5b36dc6502d06804c08349f7',
        body: () => Response.json({ result: { status_overall: {} } }),
        notice: retry('GitLab', '"all" or "resolved" or "scheduled"'),
      },
      {
        backend: 'gcp',
        vendor: 'gcp',
        feed: 'https://status.cloud.google.com/incidents.json',
        body: () => Response.json([]),
        notice: retry('Google Cloud', '"all" or "resolved"'),
      },
      {
        backend: 'aws',
        vendor: 'aws',
        feed: 'https://health.aws.amazon.com/public/currentevents',
        body: () => new Response(Buffer.from('[]', 'utf16le')),
        notice: retry('Amazon Web Services', '"all" or "resolved"'),
      },
      {
        backend: 'slack',
        vendor: 'slack',
        feed: 'https://status.slack.com/api/v2.0.0/history',
        body: () => Response.json([]),
        notice: retry('Slack', '"all" or "resolved"'),
      },
      {
        backend: 'firehydrant',
        vendor: 'redis-cloud',
        feed: 'https://status.redis.io/data/payload.json',
        body: () => Response.json({}),
        notice: retry('Redis Cloud', '"all" or "resolved" or "scheduled"'),
      },
      {
        backend: 'azure',
        vendor: 'azure',
        feed: AZURE_FEED,
        body: () => new Response(emptyAzureFeed),
        notice:
          "Microsoft Azure currently lists no open incidents. Its status feed publishes only currently-open events and keeps no resolved history or maintenance windows, so no other filter can return more. See https://azure.status.microsoft/en-us/status/ to confirm on the vendor's own status page.",
      },
    ])('$backend ($vendor)', async ({ vendor, feed, body, notice }) => {
      http.route({ match: feed, respond: body });

      const result = await runToolContract(devopsGetIncidents, { vendor, filter: 'active' });

      expect(result.isError).toBeFalsy();
      // The incident feed is the only request: filter "active" never reads maintenance.
      expect(http.calls.map((c) => c.request.url)).toEqual([feed]);
      expect(result.structuredContent).toMatchObject({
        vendor,
        incidents: [],
        total_returned: 0,
        notice,
      });
      const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      expect(text).toContain('No incidents matched this filter.');
      expect(text.split(notice)).toHaveLength(2);
    });

    it('offers no retry on a backend where no other filter can hold more than "active"', async () => {
      http.route({ match: AZURE_FEED, respond: () => new Response(emptyAzureFeed) });

      const result = await runToolContract(devopsGetIncidents, {
        vendor: 'azure',
        filter: 'active',
      });

      const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      const { notice } = result.structuredContent as { notice: string };
      for (const surface of [notice, text]) {
        expect(surface).not.toContain('Try filter');
        expect(surface).not.toMatch(/"all"|"resolved"|"scheduled"|"active"/);
      }
    });
  });
});
