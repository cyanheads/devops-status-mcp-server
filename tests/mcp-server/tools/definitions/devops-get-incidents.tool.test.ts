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
import MarkdownIt from 'markdown-it';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { VENDOR_REGISTRY } from '@/data/vendor-registry.js';
import { devopsGetIncidents } from '@/mcp-server/tools/definitions/devops-get-incidents.tool.js';
import { productSlugsNotice } from '@/mcp-server/tools/definitions/devops-vendor-result.js';
import { backendHistory, vendorHistory } from '@/services/status-adapters/status-dispatch.js';
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

/**
 * vendorHistory answers from the real backend table; a case proving that a notice keys
 * on a feed capability, not on the vendor, overrides one call's answer.
 */
vi.mock('@/services/status-adapters/status-dispatch.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/services/status-adapters/status-dispatch.js')>();
  return { ...actual, vendorHistory: vi.fn(actual.vendorHistory) };
});

vi.mock('@/services/statuspage/statuspage-service.js', () => {
  const mockFetchIncidents = vi.fn();
  const mockFetchScheduledMaintenances = vi.fn();
  const mockFetchHistory = vi.fn();
  // Read only for an entry scoped to part of a shared page, for its component table.
  const mockFetchSummary = vi.fn();
  return {
    getStatuspageService: () => ({
      fetchIncidents: mockFetchIncidents,
      fetchScheduledMaintenances: mockFetchScheduledMaintenances,
      fetchHistory: mockFetchHistory,
      fetchSummary: mockFetchSummary,
    }),
    initStatuspageService: vi.fn(),
    _mockFetchIncidents: mockFetchIncidents,
    _mockFetchScheduledMaintenances: mockFetchScheduledMaintenances,
    _mockFetchHistory: mockFetchHistory,
    _mockFetchSummary: mockFetchSummary,
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
  const {
    _mockFetchIncidents,
    _mockFetchScheduledMaintenances,
    _mockFetchHistory,
    _mockFetchSummary,
  } = (await import('@/services/statuspage/statuspage-service.js')) as unknown as {
    _mockFetchIncidents: ReturnType<typeof vi.fn>;
    _mockFetchScheduledMaintenances: ReturnType<typeof vi.fn>;
    _mockFetchHistory: ReturnType<typeof vi.fn>;
    _mockFetchSummary: ReturnType<typeof vi.fn>;
  };
  _mockFetchSummary.mockImplementation((url: string) => real.fetchSummary(url));
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
    const result = await runToolContract(devopsGetIncidents, {
      vendor: 'unknown-xyz',
      filter: 'all',
    });
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

  it('throws target_blocked with the guard sentence, sentinel stripped, for a blocked raw URL', async () => {
    const { assertSafeUrl } = await import('@/utils/ssrf-guard.js');
    vi.mocked(assertSafeUrl).mockRejectedValueOnce(
      new Error(
        'SSRF_BLOCKED: URL "http://169.254.169.254" resolves to 169.254.169.254 (link-local / cloud-metadata).',
      ),
    );

    const result = await runToolContract(devopsGetIncidents, {
      vendor: 'http://169.254.169.254',
      filter: 'all',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        message:
          'URL "http://169.254.169.254" resolves to 169.254.169.254 (link-local / cloud-metadata).',
        data: {
          reason: 'target_blocked',
          recovery: { hint: expect.stringContaining('DEVOPS_STATUS_ALLOW_PRIVATE_TARGETS') },
        },
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
      // Says the omitted incidents are unreachable by paging, not just "capped", and, on a
      // Statuspage page read without since, that since reaches them through its archive (#97),
      // keeping the status page for a page that publishes none.
      expect(structured.notice).toBe(
        "The vendor's status API returns at most 50 incidents per fetch and offers no pagination, so incidents older than the oldest one it returned are not reachable at any offset. Set since to reach them through the status page's history archive, 24 months back at most, where the page publishes one; where it publishes none, see https://www.githubstatus.com for the older history.",
      );

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
        // The body is vendor text, quoted inside its list item (#63).
        '- [2025-01-01T10:00:00Z] resolved:',
        '  > All clear.',
        '',
        '[Incident page](https://stspg.io/001)',
        '',
      ].join('\n'),
    );
  });

  /**
   * Vendor text reaches content[] as data: `<` and an entity-starting `&` are escaped,
   * inline values cannot break their line, and a multi-line body stays inside a quote
   * nested in its list item. structuredContent keeps every string as the vendor wrote it.
   */
  describe('vendor text in content[] (#63)', () => {
    const multiLine = [
      'Summary line with a bound (<1%) and <FUNCTIONALITY IMPACTED> & &amp; text.',
      '',
      '## 2. Impact',
      '',
      '- Active customer accounts experienced errors',
      '<script>alert(1)</script>',
    ].join('\n');

    function result() {
      return {
        vendor: 'example',
        name: 'Example',
        incidents: [
          {
            id: 'inc-lt',
            name: 'Errors on <API>\n## Forged heading',
            impact: 'major' as const,
            status: 'monitoring',
            created_at: '2026-10-01T00:00:00Z',
            started_at: null,
            resolved_at: null,
            scheduled_for: '2026-10-02T00:00:00Z',
            scheduled_until: '2026-10-02T01:00:00Z',
            duration_minutes: null,
            shortlink: 'https://stspg.io/lt',
            affected_components: ['SMS <US>', 'Debugger & Alarms\r\nForged'],
            updates: [
              { status: 'identified', body: multiLine, created_at: '2026-10-01T00:05:00Z' },
              { status: 'monitoring', body: '', created_at: '2026-10-01T00:10:00Z' },
            ],
            source: 'api' as const,
          },
        ],
        total_returned: 1,
        statuspage_url: 'https://status.example.com',
      };
    }

    it('escapes `<` and entity-starting `&`, flattens inline names, quotes every body line', () => {
      const text = (devopsGetIncidents.format!(result())[0] as { text: string }).text;
      const lines = text.split('\n');

      expect(lines).toContain('### ⚠️ Errors on &lt;API> ## Forged heading `inc-lt`');
      expect(lines).toContain('**Components:** SMS &lt;US>, Debugger & Alarms Forged');
      expect(lines).toContain('**Scheduled:** 2026-10-02T00:00:00Z → 2026-10-02T01:00:00Z');
      const start = lines.indexOf('- [2026-10-01T00:05:00Z] identified:');
      expect(lines.slice(start, start + 8)).toEqual([
        '- [2026-10-01T00:05:00Z] identified:',
        '  > Summary line with a bound (&lt;1%) and &lt;FUNCTIONALITY IMPACTED> & &amp;amp; text.',
        '  >',
        '  > ## 2. Impact',
        '  >',
        '  > - Active customer accounts experienced errors',
        '  > &lt;script>alert(1)&lt;/script>',
        // An empty body renders no quote at all.
        '- [2026-10-01T00:10:00Z] monitoring:',
      ]);
      // No vendor line starts a heading, list, or HTML block of its own.
      expect(lines.filter((l) => /^## /.test(l))).toEqual(['## Example (example) — 1 incidents']);
      expect(text).not.toMatch(/<(?:script|API|US|FUNCTIONALITY)/);
      // The quote ends before the incident link, so the link is not read into it.
      expect(lines.slice(-3)).toEqual(['', '[Incident page](https://stspg.io/lt)', '']);
    });

    it('leaves structuredContent unescaped — the output schema parses the strings as written', () => {
      const parsed = devopsGetIncidents.output.parse(result());
      expect(parsed.incidents[0]!.updates[0]!.body).toBe(multiLine);
      expect(parsed.incidents[0]!.name).toBe('Errors on <API>\n## Forged heading');
      expect(parsed.incidents[0]!.affected_components).toEqual([
        'SMS <US>',
        'Debugger & Alarms\r\nForged',
      ]);
    });
  });

  /**
   * A maintenance window whose feed publishes no planned end reports scheduled_until null,
   * and content[] says the end is not published; a window with an end renders as it did
   * (#91). The real Firehydrant and Status.io adapters run down to the fetch fake.
   */
  describe('maintenance window with no published end (#91)', () => {
    const http = createFetchMock();
    const md = new MarkdownIt();
    const adapterFixture = (name: string) =>
      JSON.parse(
        readFileSync(
          new URL(`../../../services/status-adapters/fixtures/${name}`, import.meta.url),
          'utf-8',
        ),
      );

    beforeEach(() => {
      http.reset();
      http.install();
    });

    afterEach(() => {
      http.restore();
    });

    /** Both surfaces of a filter: "scheduled" call — content[] as written, and each line as a CommonMark reader sees it. */
    async function scheduled(vendor: string) {
      const call = await runToolContract(devopsGetIncidents, { vendor, filter: 'scheduled' });
      expect(call.isError).toBeFalsy();
      const text = call.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      const read = md
        .parse(text, {})
        .filter((t) => t.type === 'inline')
        .flatMap((t) =>
          (t.children ?? [])
            .map((c) => (c.type === 'softbreak' || c.type === 'hardbreak' ? '\n' : c.content))
            .join('')
            .split('\n'),
        );
      const { incidents } = call.structuredContent as {
        incidents: Array<{ name: string; scheduled_for: string | null; scheduled_until: unknown }>;
      };
      return { incidents, text, read };
    }

    it('redis-cloud: the recorded window reads null and "end not published"', async () => {
      // The capture's one MAINTENANCE item, completed; the payload publishes no planned end.
      http.route({
        match: 'https://status.redis.io/data/payload.json',
        respond: () => Response.json(adapterFixture('firehydrant-redis.json')),
      });

      const { incidents, read } = await scheduled('redis-cloud');

      expect(incidents.map((i) => [i.scheduled_for, i.scheduled_until])).toEqual([
        ['2026-02-24T04:52:19Z', null],
      ]);
      expect(read).toContain('Scheduled: 2026-02-24T04:52:19Z → end not published');
    });

    it('gitlab: a window without datetime_planned_end reads null; one with it is unchanged', async () => {
      const raw = adapterFixture('statusio-incident-doc-derived.json');
      delete raw.result.maintenance.upcoming[0].datetime_planned_end;
      http.route({
        match: 'https://status-api.hostedstatus.com/1.0/status/5b36dc6502d06804c08349f7',
        respond: () => Response.json(raw),
      });

      const { incidents, text, read } = await scheduled('gitlab');

      expect(incidents.map((i) => [i.name, i.scheduled_for, i.scheduled_until])).toEqual([
        ['Network Upgrade', '2021-12-06T16:50:00.000Z', '2021-12-06T17:50:00.000Z'],
        ['Mobile App Upgrade', '2021-12-22T15:00:00.000Z', null],
      ]);
      expect(text.split('\n')).toContain(
        '**Scheduled:** 2021-12-06T16:50:00.000Z → 2021-12-06T17:50:00.000Z',
      );
      expect(read).toContain('Scheduled: 2021-12-22T15:00:00.000Z → end not published');
    });
  });

  /**
   * Google Cloud incidents list their regions apart from their products (#84). The real
   * Google Cloud adapter runs down to the fetch fake.
   */
  describe('Google Cloud affected locations (#84)', () => {
    const http = createFetchMock();
    const FEED = 'https://status.cloud.google.com/incidents.json';
    const BUDGET = 64_000;

    beforeEach(() => {
      http.reset();
      http.install();
    });

    afterEach(() => {
      http.restore();
    });

    type GcpRecord = { id: string } & Record<string, unknown>;
    const serve = (records: GcpRecord[]) =>
      http.route({ match: FEED, respond: () => Response.json(records) });

    /** A resolved incident on `day` whose title and product name carry no region. */
    function gcpRecord(id: string, day: string, fields: Record<string, unknown> = {}): GcpRecord {
      return {
        id,
        external_desc:
          'Google Cloud Storage (GCS) customers experienced elevated latencies and error rates',
        begin: `${day}T14:00:00+00:00`,
        created: `${day}T14:30:00+00:00`,
        end: `${day}T16:00:00+00:00`,
        severity: 'medium',
        status_impact: 'SERVICE_DISRUPTION',
        uri: `incidents/${id}`,
        affected_products: [{ id: 'gcs', title: 'Google Cloud Storage' }],
        updates: [
          { when: `${day}T16:00:00+00:00`, text: 'The issue is resolved.', status: 'AVAILABLE' },
        ],
        ...fields,
      };
    }

    /** `count` distinct locations, the size of the largest Google Cloud record observed. */
    const manyLocations = (count: number) =>
      Array.from({ length: count }, (_, n) => ({
        id: `region-${n}`,
        title: `Region ${n} (region-${n})`,
      }));

    type Located = {
      id: string;
      affected_locations?: unknown;
      updates: unknown[];
      updates_omitted?: number;
    };

    /** One call through the production contract, with each surface as the caller receives it. */
    async function call(args: Record<string, unknown>) {
      const result = await runToolContract(devopsGetIncidents, args as never);
      expect(result.isError).toBeFalsy();
      const blocks = result.content.map((b) => (b.type === 'text' ? b.text : ''));
      const text = blocks.join('\n');
      return {
        structured: result.structuredContent as {
          incidents: Located[];
          nextOffset?: number;
          notice?: string;
        },
        text,
        lines: text.split('\n'),
        structuredBytes: Buffer.byteLength(JSON.stringify(result.structuredContent)),
        contentBytes: Buffer.byteLength(blocks.join('')),
      };
    }

    it('finds a regional incident by its location id or name, and renders the location', async () => {
      // The 2026-10-08 Cloud Storage incident names its region only in the location list.
      serve([
        gcpRecord('mSFVt6PiP557bjRyYsut', '2026-10-08', {
          currently_affected_locations: [],
          previously_affected_locations: [{ title: 'Iowa (us-central1)', id: 'us-central1' }],
        }),
        gcpRecord('netherlands', '2026-10-08', {
          previously_affected_locations: [
            { title: 'Netherlands (europe-west4)', id: 'europe-west4' },
          ],
        }),
        gcpRecord('older', '2026-09-01', {
          previously_affected_locations: [{ title: 'Iowa (us-central1)', id: 'us-central1' }],
        }),
      ]);

      for (const match of ['us-central1', 'iowa']) {
        const { structured, lines } = await call({
          vendor: 'gcp',
          since: '2026-10-08',
          until: '2026-10-09',
          match,
        });

        expect(structured.incidents.map((i) => i.id)).toEqual(['mSFVt6PiP557bjRyYsut']);
        expect(structured.incidents[0]!.affected_locations).toEqual([
          { id: 'us-central1', name: 'Iowa (us-central1)', current: false },
        ]);
        expect(lines).toContain('**Locations (previous):** Iowa (us-central1) `us-central1`');
        expect(lines.filter((l) => l.startsWith('**Locations ('))).toHaveLength(1);
      }
    });

    it('renders current and previous locations on their own lines, current first, names escaped', async () => {
      serve([
        gcpRecord('open', '2026-10-08', {
          end: '',
          currently_affected_locations: [
            { id: 'us-east1', title: 'South Carolina (us-east1)' },
            { id: 'lab', title: 'Lab <beta>\nregion' },
          ],
          previously_affected_locations: [
            { id: 'us-east1', title: 'South Carolina (us-east1)' },
            { id: 'europe-west4', title: 'Netherlands (europe-west4)' },
            { id: 'global', title: 'Global' },
          ],
        }),
      ]);
      const { structured, lines } = await call({ vendor: 'gcp' });

      // structuredContent carries the names as written.
      expect(structured.incidents[0]!.affected_locations).toEqual([
        { id: 'us-east1', name: 'South Carolina (us-east1)', current: true },
        { id: 'lab', name: 'Lab <beta>\nregion', current: true },
        { id: 'europe-west4', name: 'Netherlands (europe-west4)', current: false },
        { id: 'global', name: 'Global', current: false },
      ]);
      const current = lines.indexOf(
        '**Locations (current):** South Carolina (us-east1) `us-east1`, Lab &lt;beta> region `lab`',
      );
      expect(current).toBeGreaterThan(-1);
      expect(lines.slice(current - 1, current + 3)).toEqual([
        '**Components:** Google Cloud Storage',
        '**Locations (current):** South Carolina (us-east1) `us-east1`, Lab &lt;beta> region `lab`',
        '**Locations (previous):** Netherlands (europe-west4) `europe-west4`, Global `global`',
        '**Updates (1):**',
      ]);
    });

    it('names locations in the notice when match empties a Google Cloud result', async () => {
      serve([
        gcpRecord('a', '2026-10-08', {
          previously_affected_locations: [{ title: 'Iowa (us-central1)', id: 'us-central1' }],
        }),
        gcpRecord('b', '2026-10-01'),
      ]);
      const { structured, text } = await call({ vendor: 'gcp', match: 'tokyo' });

      const notice =
        '2 incidents for Google Cloud matched filter "all", but none has every term of "tokyo" in its title, affected components, or affected locations. ' +
        'Use fewer or broader terms, or omit match. History-archive records, and vendors that publish no components, match on title only.';
      expect(structured).toMatchObject({ incidents: [], notice });
      expect(text.split(notice)).toHaveLength(2);
    });

    it('keeps every location of an incident over the budget on its own, trimming only its updates', async () => {
      const locations = manyLocations(61);
      const updates = Array.from({ length: 120 }, (_, n) => ({
        when: new Date(Date.UTC(2026, 9, 8, 14) + n * 60_000).toISOString(),
        text: `Update ${n}: ${'x'.repeat(1_000)}`,
        status: 'SERVICE_DISRUPTION',
      }));
      serve([
        gcpRecord('outage', '2026-10-08', { previously_affected_locations: locations, updates }),
        gcpRecord('after', '2026-10-01'),
      ]);
      const page = await call({ vendor: 'gcp' });

      expect(page.structuredBytes).toBeLessThanOrEqual(BUDGET);
      expect(page.contentBytes).toBeLessThanOrEqual(BUDGET);
      expect(page.structured.incidents.map((i) => i.id)).toEqual(['outage']);
      const [inc] = page.structured.incidents;
      expect(inc!.updates_omitted).toBeGreaterThan(0);
      expect(inc!.updates.length + inc!.updates_omitted!).toBe(120);
      expect(inc!.affected_locations).toEqual(
        locations.map(({ id, title }) => ({ id, name: title, current: false })),
      );
      expect(page.lines).toContain(
        `**Locations (previous):** ${locations.map((l) => `${l.title} \`${l.id}\``).join(', ')}`,
      );
      expect(page.structured.nextOffset).toBe(1);
    });

    it('counts locations toward the budget, so every page fits with every location whole', async () => {
      const locations = manyLocations(61);
      const records = Array.from({ length: 30 }, (_, n) => {
        const day = new Date(Date.UTC(2026, 9, 1) - n * 86_400_000).toISOString().slice(0, 10);
        return gcpRecord(`inc-${n}`, day, {
          previously_affected_locations: locations,
          updates: [
            { when: `${day}T16:00:00+00:00`, text: 'y'.repeat(1_500), status: 'AVAILABLE' },
          ],
        });
      });
      serve(records);

      const args = { vendor: 'gcp', limit: 50 };
      const pages = [await call(args)];
      for (let next = pages[0]!.structured.nextOffset; next !== undefined; ) {
        const page = await call({ ...args, offset: next });
        pages.push(page);
        next = page.structured.nextOffset;
      }

      // Measured without its locations, a record weighs a third of what it does, and a
      // page would be cut three times too late.
      expect(pages.length).toBeGreaterThan(2);
      for (const page of pages) {
        expect(page.structuredBytes).toBeLessThanOrEqual(BUDGET);
        expect(page.contentBytes).toBeLessThanOrEqual(BUDGET);
        for (const inc of page.structured.incidents) {
          expect(inc.affected_locations).toHaveLength(61);
          expect(inc.updates_omitted).toBeUndefined();
        }
      }
      expect(pages.flatMap((p) => p.structured.incidents.map((i) => i.id))).toEqual(
        records.map((r) => r.id),
      );
    });

    it('leaves a Statuspage incident without the field and without a Locations line', async () => {
      const { _mockFetchIncidents, _mockFetchScheduledMaintenances } = (await import(
        '@/services/statuspage/statuspage-service.js'
      )) as unknown as {
        _mockFetchIncidents: ReturnType<typeof vi.fn>;
        _mockFetchScheduledMaintenances: ReturnType<typeof vi.fn>;
      };
      _mockFetchIncidents.mockResolvedValue({ data: RESOLVED_INCIDENT, cached: false });
      _mockFetchScheduledMaintenances.mockResolvedValue({ data: EMPTY_SCHEDULED, cached: false });

      const { structured, text } = await call({ vendor: 'github', match: 'api' });

      expect(Object.keys(structured.incidents[0]!)).toEqual([
        'id',
        'name',
        'impact',
        'status',
        'created_at',
        'started_at',
        'resolved_at',
        'scheduled_for',
        'scheduled_until',
        'duration_minutes',
        'shortlink',
        'affected_components',
        'updates',
        'source',
      ]);
      expect(text).not.toContain('**Locations');
    });

    it('names locations in the match and tool descriptions', () => {
      expect(devopsGetIncidents.input.shape.match.description).toContain(
        'on Google Cloud and AWS, its affected location names and IDs',
      );
      expect(devopsGetIncidents.description).toContain(
        'match (terms in the title or affected component names, plus location names and IDs on Google Cloud and AWS)',
      );
    });
  });

  /**
   * The real AWS adapter runs down to the fetch fake, serving the recorded capture: two
   * open events, in me-central-1 ("UAE") and me-south-1 ("Bahrain"), each listing the one
   * region its ARN names. The phrase rule itself is tabled in tests/utils/word-match.test.ts;
   * these prove that match reads AWS locations and that its notice names them (#95).
   */
  describe('AWS affected locations (#95)', () => {
    const http = createFetchMock();
    const capture = readFileSync(
      new URL(
        '../../../services/status-adapters/fixtures/aws-currentevents.utf16be.bin',
        import.meta.url,
      ),
    );
    const ME_SOUTH =
      'arn:aws:health:me-south-1::event/MULTIPLE_SERVICES/AWS_MULTIPLE_SERVICES_OPERATIONAL_ISSUE/AWS_MULTIPLE_SERVICES_OPERATIONAL_ISSUE_E6426_01AD72B4E1E';

    beforeEach(async () => {
      http.reset();
      http.install();
      http.route({
        match: (req) => new URL(req.url).origin === 'https://health.aws.amazon.com',
        respond: () => new Response(capture),
      });
      const aws = await import('@/services/status-adapters/aws-adapter.js');
      const actual = await vi.importActual<typeof aws>('@/services/status-adapters/aws-adapter.js');
      vi.mocked(aws.fetchAwsIncidents).mockImplementation(actual.fetchAwsIncidents);
    });

    afterEach(async () => {
      http.restore();
      const aws = await import('@/services/status-adapters/aws-adapter.js');
      vi.mocked(aws.fetchAwsIncidents).mockReset();
    });

    /** One call through the production contract, with each surface as the caller receives it. */
    async function call(match: string) {
      const result = await runToolContract(devopsGetIncidents, { vendor: 'aws', match });
      expect(result.isError).toBeFalsy();
      return {
        structured: result.structuredContent as {
          incidents: { id: string; affected_locations?: unknown }[];
          notice?: string;
        },
        text: result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n'),
      };
    }

    it('selects the me-south-1 event by its region code or its region name, location on both surfaces', async () => {
      for (const match of ['me-south-1', 'bahrain']) {
        const { structured, text } = await call(match);

        expect(
          structured.incidents.map((i) => i.id),
          match,
        ).toEqual([ME_SOUTH]);
        expect(structured.incidents[0]!.affected_locations).toEqual([
          { id: 'me-south-1', name: 'Bahrain', current: true },
        ]);
        expect(text.split('\n')).toContain('**Locations (current):** Bahrain `me-south-1`');
        expect(structured.notice).toBeUndefined();
      }
    });

    it("selects nothing for another region's code, and says a hyphenated term needs its words together", async () => {
      // Read word by word, "eu" inside "Amazon Managed Service for Prometheus" and the
      // me-central-1 location would select that event.
      const { structured, text } = await call('eu-central-1');

      const notice =
        '2 incidents for Amazon Web Services matched filter "all", but none has every term of "eu-central-1" in its title, affected components, or affected locations. ' +
        'A hyphenated term matches only where its words appear together, in that order, within the title, one component name, or one location name or ID; spaces between its words let each match on its own. ' +
        'Use fewer or broader terms, or omit match. History-archive records, and vendors that publish no components, match on title only.';
      expect(structured).toMatchObject({ incidents: [], notice });
      expect(text.split(notice)).toHaveLength(2);
    });

    it('names affected locations when a one-word match empties an AWS result', async () => {
      const { structured } = await call('tokyo');

      expect(structured).toMatchObject({
        incidents: [],
        notice:
          '2 incidents for Amazon Web Services matched filter "all", but none has every term of "tokyo" in its title, affected components, or affected locations. ' +
          'Use fewer or broader terms, or omit match. History-archive records, and vendors that publish no components, match on title only.',
      });
    });
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
      // The body is quoted under its update line (#63).
      expect(text).toContain(
        '- [2026-07-23T16:29:09.000Z] investigating:\n  > We are investigating',
      );
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

    /** The ceiling notice where since cannot reach past it, so the status page is the way (#25). */
    const pageCeiling = (url: string) =>
      `The vendor's status API returns at most 50 incidents per fetch and offers no pagination, so incidents older than the oldest one it returned are not reachable through this tool at any offset. See ${url} for the older history.`;
    /**
     * The ceiling notice on GitHub's Statuspage page read without since, which reaches past it
     * where the page publishes an archive; the status page stays for one that publishes none (#97).
     */
    const SINCE_CEILING =
      "The vendor's status API returns at most 50 incidents per fetch and offers no pagination, so incidents older than the oldest one it returned are not reachable at any offset. Set since to reach them through the status page's history archive, 24 months back at most, where the page publishes one; where it publishes none, see https://www.githubstatus.com for the older history.";

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
          {
            status: 'resolved',
            // The archive message is HTML (`<br />` pairs); it arrives as plain text (#63).
            body: [
              'On July 23, 2026, between 07:08 and 09:39 UTC, several services experienced delays: 8% of actions workflow runs experienced an average run start delay of 10 minutes, 5% of webhook deliveries exceeded SLO, and code scanning, repos, notifications, issues and pull requests experienced increased latency over the life of the incident.',
              'The root cause of the incident was a node of our background job processing system which did not recover after entering scheduled host maintenance. The incident was mitigated by identifying the problematic shard and restoring its correct state, after which queue backlogs drained and services recovered.',
              'To speed mitigation, we have added monitors for nodes in this unhealthy state after maintenance operations. To prevent future recurrence, we are adapting our lifecycle automation to verify host rejoin after a scheduled reboot.',
            ].join('\n'),
            created_at: '2026-07-23T09:39:00.000Z',
          },
        ],
        source: 'history',
      });
      expect(raw.message).toContain('<br /><br />');
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

    /**
     * sendgrid reads Twilio's page scoped to SendGrid's components (#54). The recorded
     * Twilio summary carries the component table; the recorded 50-record feed has its
     * components stripped, so one record is given SendGrid's SMTP leaf.
     */
    describe('sendgrid (scoped to its components on the Twilio page)', () => {
      const twilioSummary = () =>
        JSON.parse(
          readFileSync(
            new URL(
              '../../../services/status-adapters/fixtures/statuspage-twilio-summary.json',
              import.meta.url,
            ),
            'utf-8',
          ),
        ) as { components: Array<{ id: string; name: string }> };
      type Feed = { incidents: Array<{ id: string; components: unknown[] }> };

      function routeSendgrid(feed: Feed) {
        http.route(
          { match: `${TWILIO}/api/v2/summary.json`, respond: () => Response.json(twilioSummary()) },
          { match: `${TWILIO}/api/v2/incidents.json`, respond: () => Response.json(feed) },
          {
            match: `${TWILIO}/api/v2/scheduled-maintenances.json`,
            respond: json('twilio-scheduled-maintenances.json'),
          },
        );
      }

      it('keeps only records touching a SendGrid component, reads no archive, and still discloses the ceiling', async () => {
        const feed = fixture('twilio-incidents.json') as Feed;
        const smtp = twilioSummary().components.find((c) => c.name === 'SMTP')!;
        feed.incidents[3] = { ...feed.incidents[3]!, components: [smtp] };
        routeSendgrid(feed);

        const { result, structured } = await call({
          vendor: 'sendgrid',
          filter: 'all',
          since: '2026-01-01',
          limit: 50,
        });

        expect(historyRequests()).toEqual([]);
        expect(result.name).toBe('SendGrid');
        expect(result.incidents.map((i) => [i.id, i.source])).toEqual([
          [feed.incidents[3]!.id, 'api'],
        ]);
        // Twilio's unfiltered feed returned 50 records, which is its ceiling.
        expect(structured.upstreamCeiling).toBe(50);
        expect(structured.notice).toContain('returns at most 50 incidents per fetch');
      });

      it('returns nothing when no record touches a SendGrid component, and says why', async () => {
        routeSendgrid(fixture('twilio-incidents.json') as Feed);

        const { result, structured } = await call({
          vendor: 'sendgrid',
          filter: 'resolved',
          since: '2026-01-01',
          limit: 50,
        });

        expect(historyRequests()).toEqual([]);
        expect(result.incidents).toEqual([]);
        expect(structured.upstreamCeiling).toBe(50);
        expect(structured.notice).toContain('returns at most 50 incidents per fetch');
      });

      /**
       * At Twilio's 50-record ceiling, an empty "all" says the records the feed returned
       * hold nothing in SendGrid's scope, and leaves the way to older SendGrid incidents to
       * the ceiling notice, which names the status page (#99). Below the ceiling the feed's
       * whole record was read, so the nothing-published sentence stands.
       */
      it('says an empty "all" at the ceiling found nothing in scope, naming the status page once (#99)', async () => {
        routeSendgrid(fixture('twilio-incidents.json') as Feed);

        const result = await runToolContract(devopsGetIncidents, { vendor: 'sendgrid' });

        const notice = `None of the incidents or maintenance windows SendGrid's status feed returned touch SendGrid's components, so the narrower filters have nothing to return either. ${pageCeiling(TWILIO)}`;
        expect(result.structuredContent).toMatchObject({
          incidents: [],
          upstreamCeiling: 50,
          notice,
        });
        expect(notice.split(TWILIO)).toHaveLength(2);
        const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        expect(text.split(notice)).toHaveLength(2);
      });

      it('keeps the nothing-published sentence for an empty "all" below the ceiling (#99)', async () => {
        const feed = fixture('twilio-incidents.json') as Feed;
        feed.incidents.pop();
        routeSendgrid(feed);

        const { result, structured } = await call({ vendor: 'sendgrid' });

        expect(result.incidents).toEqual([]);
        expect(structured.upstreamCeiling).toBeUndefined();
        expect(structured.notice).toBe(
          `SendGrid currently lists no incidents and no maintenance windows at all. Filter "all" already spans everything its status feed publishes, so the narrower filters have nothing to return either. See ${TWILIO} to confirm on the vendor's own status page.`,
        );
      });

      it('keeps the status-page pointer at the ceiling without since: no archive is read for it (#97)', async () => {
        const feed = fixture('twilio-incidents.json') as Feed;
        const smtp = twilioSummary().components.find((c) => c.name === 'SMTP')!;
        feed.incidents[3] = { ...feed.incidents[3]!, components: [smtp] };
        routeSendgrid(feed);

        const { result, structured } = await call({ vendor: 'sendgrid' });

        expect(result.incidents.map((i) => i.id)).toEqual([feed.incidents[3]!.id]);
        expect(structured.upstreamCeiling).toBe(50);
        expect(structured.notice).toBe(pageCeiling(TWILIO));
      });
    });

    /**
     * On a Statuspage page the history archive reaches past the status API's 50-record
     * ceiling, so a call that read none says since reaches the older incidents. Where since
     * cannot — an entry scoped to part of a shared page, an until older than the archive
     * floor, or a call whose archive walk stopped short — the status page stays the way (#97).
     */
    describe('the ceiling notice names since where since reaches past it (#97)', () => {
      it('names since and its 24-month reach on a Statuspage page read without since, on both surfaces', async () => {
        routeGithub();
        const result = await runToolContract(devopsGetIncidents, {
          vendor: 'github',
          limit: 1,
          offset: 49,
        });

        expect(historyRequests()).toEqual([]);
        // 50 v2 incidents and 3 maintenance windows match "all".
        const notice = `Showing incidents 50–50 of 53. Call again with offset: 50 for the next page, or narrow with filter, since, until, or match. ${SINCE_CEILING}`;
        expect(result.structuredContent).toMatchObject({
          totalCount: 53,
          nextOffset: 50,
          upstreamCeiling: 50,
          notice,
        });
        const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        expect(text.split(notice)).toHaveLength(2);
        expect(notice).not.toContain('through this tool');
        // The status page is named once, for a page with no archive behind since.
        expect(notice.split(GITHUB)).toHaveLength(2);

        // An until the archive floor (2024-09-25 on this clock) does not pass still lets since reach.
        http.reset();
        routeGithub();
        const until = await call({ vendor: 'github', until: '2026-09-01' });
        expect(until.result.total_returned).toBeGreaterThan(0);
        expect(until.structured.upstreamCeiling).toBe(50);
        expect(until.structured.notice?.endsWith(SINCE_CEILING)).toBe(true);
      });

      it('keeps the status-page pointer under a filter that rejects since', async () => {
        routeGithub();
        const { structured } = await call({ vendor: 'github', filter: 'active' });

        // Every recorded GitHub incident is resolved, so "active" is empty; the ceiling still binds.
        expect(structured.upstreamCeiling).toBe(50);
        expect(structured.notice?.endsWith(pageCeiling(GITHUB))).toBe(true);
        expect(structured.notice).not.toContain('since');
      });

      it('leaves a Statuspage until-only notice as it was when no ceiling follows', async () => {
        const page = (fixture('github-incidents.json') as StatuspageIncidentsResponse).page;
        const record = {
          ...RESOLVED_INCIDENT.incidents[0]!,
          id: 'only',
          created_at: '2026-08-10T10:00:00Z',
          started_at: '2026-08-10T10:00:00Z',
        };
        const route = () =>
          http.route(
            {
              match: `${GITHUB}/api/v2/incidents.json`,
              respond: () => Response.json({ page, incidents: [record] }),
            },
            {
              match: `${GITHUB}/api/v2/scheduled-maintenances.json`,
              respond: () => Response.json({ page, scheduled_maintenances: [] }),
            },
          );

        route();
        const inside = await call({ vendor: 'github', until: '2026-08-01' });
        expect(inside.structured.upstreamCeiling).toBeUndefined();
        expect(inside.structured.notice).toBe(
          'No incidents matching filter "all" for GitHub started on or before 2026-08-01: all 1 match started after it. ' +
            "Add since (up to 24 months back) to also read the status page's history archive, which reaches incidents older than the ones its status API returns.",
        );

        http.reset();
        route();
        const older = await call({ vendor: 'github', until: '2024-01-01' });
        expect(older.structured.notice).toBe(
          'No incidents matching filter "all" for GitHub started on or before 2024-01-01: all 1 match started after it. ' +
            "The status page's history archive is read back 24 months at most, to 2024-09-25, so since cannot reach incidents that started on or before 2024-01-01. " +
            `See ${GITHUB} for earlier history.`,
        );
        expect(historyRequests()).toEqual([]);
      });
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
      // All 50 v2 incidents are kept; the response size budget ends the page sooner (#58).
      expect(structured.totalCount).toBe(50);
      expect(result.total_returned).toBeGreaterThan(0);
      expect(result.total_returned).toBeLessThan(50);
      expect(structured.nextOffset).toBe(result.total_returned);
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
      // since was set and its walk stopped short, so the status page stays the way (#97).
      expect(structured.notice).toContain(pageCeiling(GITHUB));
      expect(structured.notice).not.toContain('Set since');
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
     * dropping ?page=, so page 2 arrives as page 1 again. The registry's sendgrid entry
     * now reads Twilio's page directly (#54), so the redirecting host is reached as a
     * raw URL.
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
        vendor: base,
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
      // All 50 v2 incidents are kept; the response size budget ends the page sooner (#58).
      expect(structured.totalCount).toBe(50);
      expect(result.total_returned).toBeGreaterThan(0);
      expect(result.total_returned).toBeLessThan(50);
      expect(structured.nextOffset).toBe(result.total_returned);
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

      // These GCP incidents run to tens of kilobytes each, so the response size budget
      // splits them across pages (#58); every page is walked by nextOffset.
      const args = { vendor: 'gcp', filter: 'all', since: '2026-06-01' };
      const pages = [await call(args)];
      for (let next = pages[0]!.structured.nextOffset; next !== undefined; ) {
        const page = await call({ ...args, offset: next });
        pages.push(page);
        next = page.structured.nextOffset;
      }
      const incidents = pages.flatMap((p) => p.result.incidents);

      expect(new Set(requested())).toEqual(
        new Set(['https://status.cloud.google.com/incidents.json']),
      );
      expect(incidents.map((i) => i.id)).toEqual([
        '3BvH3LVGcupoYqV6F4Nw',
        'T8gmtofFSTGT5tbhyciF',
        '5fGQt4VbkDnr3Yp8PXPr',
      ]);
      expect(incidents.every((i) => i.source === 'api')).toBe(true);
      // Paging is the only thing any page explains: no history read, so no gap.
      for (const { structured } of pages) {
        expect(structured.notice ?? '').not.toMatch(/history archive/);
      }
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
      // All 50 v2 incidents are kept; the response size budget ends the page sooner (#58).
      expect(structured.totalCount).toBe(50);
      expect(result.total_returned).toBeGreaterThan(0);
      expect(result.total_returned).toBeLessThan(50);
      expect(structured.nextOffset).toBe(result.total_returned);
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

    /**
     * The 24-month floor bounds how far back the history archive is read, never which
     * records the live feeds return are kept (#69, #71). GitHub's maintenance list keeps
     * completed windows back years — this capture reaches 2018 — and the floor on this
     * clock is 2024-09-25.
     */
    describe('the 24-month history-archive floor', () => {
      /** Live capture of GitHub's scheduled-maintenances list, taken 2026-10-14. */
      const MAINTENANCES = 'github-scheduled-maintenances-20261014.json';
      /** Quarter start of history page `page`, counting back from page 1's 2026-07-01. */
      const quarterStart = (page: number) => {
        const quarter = 2026 * 4 + 2 - (page - 1);
        const month = String((quarter % 4) * 3 + 1).padStart(2, '0');
        return `${Math.floor(quarter / 4)}-${month}-01T00:00:00Z`;
      };

      /**
       * GitHub with the full maintenance capture. History pages 1–5 are recorded; pages
       * 6–9 (2025-04-01 back to 2024-07-01) are quarters with no records, so the walk
       * reaches the floor at page 9.
       */
      function routeGithubBeyondFloor(
        pages: Record<number, (req: Request) => Response | Promise<Response>> = {},
      ) {
        http.route(
          { match: `${GITHUB}/api/v2/incidents.json`, respond: json('github-incidents.json') },
          { match: `${GITHUB}/api/v2/scheduled-maintenances.json`, respond: json(MAINTENANCES) },
        );
        for (let page = 1; page <= 9; page++) {
          http.route({
            match: historyPage(GITHUB, page),
            respond:
              pages[page] ??
              (page <= 5
                ? json(`github-history-p${page}.json`)
                : () => Response.json({ start_time: quarterStart(page), months: [] })),
          });
        }
      }

      /** Every page of a call, walked by nextOffset. */
      async function walkPages(args: Record<string, unknown>) {
        const pages = [await call(args)];
        for (let next = pages[0]!.structured.nextOffset; next !== undefined; ) {
          const page = await call({ ...args, offset: next });
          pages.push(page);
          next = page.structured.nextOffset;
        }
        return pages;
      }

      it('an until older than the floor keeps the maintenances that started on or before it', async () => {
        routeGithubBeyondFloor();
        const result = await runToolContract(devopsGetIncidents, {
          vendor: 'github',
          until: '2023-01-01',
          limit: 50,
        });

        expect(result.isError).toBeFalsy();
        // until alone reads no archive.
        expect(historyRequests()).toEqual([]);
        const structured = result.structuredContent as {
          incidents: { id: string; name: string; impact: string; scheduled_for: string | null }[];
          notice?: string;
        };
        const ids = structured.incidents.map((i) => i.id);
        expect(ids).toContain('lpslbfcw2czs');
        expect(structured.incidents.find((i) => i.id === 'lpslbfcw2czs')).toMatchObject({
          name: 'GitHub Importer Maintenance',
          impact: 'maintenance',
          scheduled_for: '2022-10-27T15:00:00.000Z',
        });
        // Nothing after the until: the 2023-02-08 window and every v2 incident are out.
        expect(ids).not.toContain('53t2nlxs8016');
        expect(
          structured.incidents.every(
            (i) => Date.parse(i.scheduled_for ?? '') < Date.parse('2023-01-02T00:00:00Z'),
          ),
        ).toBe(true);
        expect(structured.notice ?? '').not.toMatch(/months back|read back to/);
        // since cannot reach a range that ends before the floor, so the ceiling keeps the
        // status page as the way to older incidents (#97).
        expect(structured.notice?.endsWith(pageCeiling(GITHUB))).toBe(true);
        const content = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        expect(content).toContain('GitHub Importer Maintenance');
      });

      it('an until before since is rejected as sent, even when both are older than the floor', async () => {
        for (const [since, until] of [
          ['2026-09-01', '2023-01-01'],
          ['2023-06-01', '2022-01-01'],
        ]) {
          http.reset();
          const result = await runToolContract(devopsGetIncidents, {
            vendor: 'github',
            since,
            until,
          });

          expect(result.isError).toBe(true);
          expect(result.structuredContent).toMatchObject({
            error: {
              code: JsonRpcErrorCode.ValidationError,
              data: { reason: 'invalid_until' },
              message: expect.stringContaining(`until ${until} is before since ${since}`),
            },
          });
          expect(http.calls).toHaveLength(0);
        }
      });

      it('a since older than the floor filters by that since and reads the archive to the floor', async () => {
        routeGithubBeyondFloor();
        const args = { vendor: 'github', filter: 'all' as const, since: '2022-01-01', limit: 50 };
        const pages = await walkPages(args);
        const all = pages.flatMap((p) => p.result.incidents);
        const ids = all.map((i) => i.id);

        // One walk per call, each stopping at the quarter that holds the 2024-09-25 floor.
        expect(historyRequests().slice(0, 9)).toEqual(
          [1, 2, 3, 4, 5, 6, 7, 8, 9].map((p) => historyPage(GITHUB, p)),
        );
        expect(historyRequests()).toHaveLength(9 * pages.length);
        // Maintenance windows from 2022 are kept; the ones before since are not.
        expect(ids).toContain('lpslbfcw2czs');
        expect(ids).toContain('flf8c4lvch31');
        expect(ids).not.toContain('6gpzw3mdnkwj');
        // Archive records past the v2 ceiling are merged in as before (page 5, July 2025).
        expect(ids).toContain('x7gtw6r3x2s1');
        expect(new Set(ids).size).toBe(ids.length);
        // The archive reached its floor, so the v2 ceiling no longer bounds the result.
        expect(pages[0]!.structured.upstreamCeiling).toBeUndefined();

        const notice =
          'since 2022-01-01 is past the 24-month history-archive floor; the archive was read back to 2024-07-01, so incidents that started before that appear only where the status API still returns them.';
        for (const { structured } of pages) expect(structured.notice).toContain(notice);
        const contract = await runToolContract(devopsGetIncidents, args);
        const content = contract.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        expect(content.split(notice)).toHaveLength(2);
      });

      it('names the floor and how far the walk got when it stops short of the floor', async () => {
        routeGithubBeyondFloor({ 3: () => Response.json({ months: 'unavailable' }) });
        const { structured } = await call({
          vendor: 'github',
          filter: 'resolved',
          since: '2022-01-01',
          limit: 1,
        });

        expect(historyRequests()).toEqual([1, 2, 3].map((p) => historyPage(GITHUB, p)));
        expect(structured.notice).toContain(
          'since 2022-01-01 is past the 24-month history-archive floor; the archive is read back to 2024-09-25 at most',
        );
        expect(structured.notice).toContain(
          'The GitHub history archive was read back to 2026-04-01, not to 2024-09-25',
        );
        // The archive stopped short, so the v2 ceiling still bounds the result.
        expect(structured.upstreamCeiling).toBe(50);
      });

      it('an empty range older than the floor says the archive does not reach it', async () => {
        routeGithubBeyondFloor();
        const until = await call({ vendor: 'github', filter: 'resolved', until: '2023-01-01' });
        expect(until.result.total_returned).toBe(0);
        expect(until.structured.notice).toContain(
          'No incidents matching filter "resolved" for GitHub started on or before 2023-01-01: all 50 matches started after it.',
        );
        expect(until.structured.notice).toContain(
          "The status page's history archive is read back 24 months at most, to 2024-09-25, so since cannot reach incidents that started on or before 2023-01-01.",
        );
        expect(until.structured.notice).not.toContain('Add since');

        http.reset();
        routeGithubBeyondFloor();
        const range = await call({
          vendor: 'github',
          filter: 'resolved',
          since: '2022-01-01',
          until: '2023-01-01',
        });
        expect(range.result.total_returned).toBe(0);
        expect(range.structured.notice).toContain('started between 2022-01-01 and 2023-01-01; ');
        expect(range.structured.notice).toContain(
          'The history archive is read back to 2024-09-25 at most, so before that date only records the status API still returns are reachable.',
        );
      });
    });

    describe('since validation', () => {
      it.each(['active', 'scheduled'] as const)(
        'rejects since with filter %s before any request',
        async (filter) => {
          const result = await runToolContract(devopsGetIncidents, {
            vendor: 'github',
            filter,
            since: '2026-01-01',
          });

          expect(result.isError).toBe(true);
          expect(result.structuredContent).toMatchObject({
            error: {
              code: JsonRpcErrorCode.ValidationError,
              message: expect.stringContaining(`"${filter}"`),
              data: {
                reason: 'invalid_since',
                recovery: { hint: expect.stringContaining('24 months') },
              },
            },
          });
          expect(http.calls).toHaveLength(0);
        },
      );

      /** GCP incidents either side of the 24-month floor, which is 2024-09-25 on this clock. */
      function routeGcpAroundFloor() {
        const incident = (id: string, begin: string) => ({
          id,
          external_desc: `Cloud Run errors ${id}`,
          begin,
          end: begin.replace('T10', 'T11'),
          severity: 'medium',
          updates: [],
          affected_products: [],
        });
        http.route({
          match: 'https://status.cloud.google.com/incidents.json',
          respond: () =>
            Response.json([
              incident('recent', '2026-09-20T10:00:00+00:00'),
              incident('after-floor', '2024-10-01T10:00:00+00:00'),
              incident('before-floor', '2024-09-20T10:00:00+00:00'),
            ]),
        });
      }
      /** The notice for a since earlier than before-floor, the oldest record above (#88). */
      const GCP_REACH = (since: string) =>
        `since ${since} is earlier than the oldest record Google Cloud's status feed returned, which starts on 2024-09-20. ` +
        'This tool reads no history archive for Google Cloud, so it cannot return incidents that started before then. ' +
        'See https://status.cloud.google.com for earlier history.';

      it('keeps a record older than the floor when since reaches it, on a backend with no archive (#69)', async () => {
        routeGcpAroundFloor();
        const result = await runToolContract(devopsGetIncidents, {
          vendor: 'gcp',
          filter: 'all',
          since: '2024-03-25',
        });

        expect(result.isError).toBeFalsy();
        const structured = result.structuredContent as {
          incidents: { id: string }[];
          notice?: string;
        };
        // The floor bounds the archive walk only, and this backend has no archive.
        expect(structured.incidents.map((i) => i.id)).toEqual([
          'recent',
          'after-floor',
          'before-floor',
        ]);
        // since predates the feed's oldest record, so the notice names where it starts (#88).
        expect(structured.notice).toBe(GCP_REACH('2024-03-25'));
      });

      it('filters an until older than the floor like any until (#69)', async () => {
        routeGcpAroundFloor();
        const { result, structured } = await call({
          vendor: 'gcp',
          filter: 'all',
          since: '2024-03-25',
          until: '2024-09-21',
        });

        expect(result.incidents.map((i) => i.id)).toEqual(['before-floor']);
        expect(structured.notice).toBe(GCP_REACH('2024-03-25'));
      });

      it('explains a range older than the floor that left nothing, on a backend with no archive (#69)', async () => {
        routeGcpAroundFloor();
        const result = await runToolContract(devopsGetIncidents, {
          vendor: 'gcp',
          since: '2024-03-01',
          until: '2024-09-01',
        });

        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({
          incidents: [],
          total_returned: 0,
          // No wider range reaches what the feed does not hold, so there is no "Widen the range" (#88).
          notice: `No incidents matching filter "all" for Google Cloud started between 2024-03-01 and 2024-09-01; 3 later matches were left out by until. ${GCP_REACH('2024-03-01')}`,
        });
      });

      it('no longer declares a 24-month rejection for since (#69)', () => {
        const entry = devopsGetIncidents.errors?.find((e) => e.reason === 'invalid_since');
        expect(entry?.when).toContain('"active" or "scheduled"');
        expect(entry?.when).not.toContain('24 months');
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

    /**
     * match and until narrow the matches before offset/limit, so the paging fields and
     * the offset guidance count the narrowed set (#71). The term reading itself is
     * pinned in tests/utils/word-match.test.ts; these prove the wiring.
     */
    describe('match and until (#71)', () => {
      const text = (content: Array<{ type: string; text?: string }>) =>
        content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');

      it('keeps only September incidents with "actions" in the title or components, paging the narrowed set', async () => {
        routeGithub();
        const args = {
          vendor: 'github',
          since: '2026-09-01',
          until: '2026-09-30',
          match: 'actions',
          limit: 1,
        };
        const first = await call(args);

        // kzh5j0mt7qwc matches on its title, 0rn90wk115q9 on its Actions component.
        expect(first.result.incidents.map((i) => i.id)).toEqual(['kzh5j0mt7qwc']);
        expect(first.structured).toMatchObject({
          truncated: true,
          shown: 1,
          cap: 1,
          totalCount: 2,
          nextOffset: 1,
        });
        const second = await call({ ...args, offset: first.structured.nextOffset });
        expect(second.result.incidents.map((i) => i.id)).toEqual(['0rn90wk115q9']);
        expect(second.result.incidents[0]!.affected_components).toContain('Actions');
        expect(second.structured.nextOffset).toBeUndefined();

        const past = await call({ ...args, offset: 2 });
        expect(past.result.total_returned).toBe(0);
        expect(past.structured.notice).toContain(
          'filter "all" (since 2026-09-01, until 2026-09-30) with match "actions" matched 2 incidents',
        );
        expect(past.structured.notice).toContain('0–1');
      });

      it('matches an update-level component name word by word', async () => {
        routeTwilio();
        const { result } = await call({
          vendor: 'twilio',
          filter: 'resolved',
          match: 'sms long code',
        });

        const component = result.incidents.find((i) => i.id === '5hgmnkdyd1pl');
        // The title carries "SMS" only; "long" and "code" come from the component.
        expect(component?.name).toBe('SMS Delivery Failures from Twilio to Multiple Countries');
        expect(component?.affected_components).toContain(
          'CARRIER NETWORK - SMS Long Code, North America',
        );
        expect(result.incidents.map((i) => i.id).sort()).toEqual(
          ['5hgmnkdyd1pl', 'krkfwmsqnf4q', 'pcgzl5svjhkv', 'tnhtkwkxbyst', 'z6d582w9kh93'].sort(),
        );
        // No history archive without since.
        expect(historyRequests()).toEqual([]);
      });

      it('matches a history-archive record on its title', async () => {
        routeGithub();
        const { result } = await call({
          vendor: 'github',
          filter: 'resolved',
          since: '2026-07-01',
          match: 'Hosted-Runners',
        });

        expect(result.incidents).toEqual([
          expect.objectContaining({
            id: '20frdtvv3yg6',
            name: 'Disruption with actions hosted runners',
            source: 'history',
            affected_components: [],
          }),
        ]);

        // The offset guidance reads match back as its terms, a joined phrase kept whole (#95).
        const past = await call({
          vendor: 'github',
          filter: 'resolved',
          since: '2026-07-01',
          match: 'Hosted-Runners',
          offset: 1,
        });
        expect(past.structured.notice).toContain(
          'with match "hosted-runners" matched 1 incident for GitHub',
        );
      });

      it('returns the one day when until equals since', async () => {
        routeGithub();
        const { result } = await call({
          vendor: 'github',
          since: '2026-09-15',
          until: '2026-09-15',
        });

        expect(result.incidents.map((i) => i.id)).toEqual(['bk7zgdcq7s9t', 'qwdwmtqghpk5']);
      });

      it('until alone reads no history archive and points at since, once, when it left nothing', async () => {
        routeGithub();
        const result = await runToolContract(devopsGetIncidents, {
          vendor: 'github',
          filter: 'resolved',
          until: '2026-07-01',
        });

        expect(historyRequests()).toEqual([]);
        expect(result.isError).toBeFalsy();
        // The feed's own 50-record ceiling bounds what until could see, and its notice is the
        // one that names since (#97), so the range sentence does not name it again.
        const notice = `No incidents matching filter "resolved" for GitHub started on or before 2026-07-01: all 50 matches started after it. ${SINCE_CEILING}`;
        expect(result.structuredContent).toMatchObject({ incidents: [], notice });
        expect(notice.match(/since/g)).toHaveLength(1);
        expect(text(result.content).split(notice)).toHaveLength(2);
      });

      it('until alone on a vendor with no archive names where its feed starts, on both surfaces (#94)', async () => {
        http.route({
          match: 'https://status.cloud.google.com/incidents.json',
          respond: () =>
            Response.json([
              {
                id: 'gcp-1',
                external_desc: 'Cloud Run errors',
                begin: '2026-09-20T10:00:00+00:00',
                end: '2026-09-20T11:00:00+00:00',
                severity: 'medium',
                updates: [],
                affected_products: [],
              },
            ]),
        });
        const result = await runToolContract(devopsGetIncidents, {
          vendor: 'gcp',
          until: '2026-09-01',
        });

        // gcp-1 is the one record the feed returned, so its start is where the feed starts.
        const notice =
          'No incidents matching filter "all" for Google Cloud started on or before 2026-09-01: all 1 match started after it. ' +
          "The oldest record Google Cloud's status feed returned starts on 2026-09-20. This tool reads no history archive for Google Cloud, so it cannot return incidents that started before then. " +
          'See https://status.cloud.google.com for earlier history.';
        expect(result.structuredContent).toMatchObject({
          incidents: [],
          total_returned: 0,
          notice,
        });
        expect(text(result.content).split(notice)).toHaveLength(2);
      });

      it('names since and until separately when the range left nothing', async () => {
        routeGithub();
        const { result, structured } = await call({
          vendor: 'github',
          filter: 'resolved',
          since: '2026-09-25',
          until: '2026-09-25',
        });

        expect(result.total_returned).toBe(0);
        expect(structured.notice).toMatch(
          /^No incidents matching filter "resolved" for GitHub started between 2026-09-25 and 2026-09-25; \d+ earlier matches were left out by since\. Widen the range/,
        );
      });

      it('says match emptied the result, with the count it removed, on both surfaces', async () => {
        routeGithub();
        const result = await runToolContract(devopsGetIncidents, {
          vendor: 'github',
          filter: 'resolved',
          since: '2026-09-01',
          match: 'Quantum Teleporter',
        });

        // 13 September v2 incidents start on or after the floor; no archive-only record does.
        const notice =
          '13 incidents for GitHub matched filter "resolved" (since 2026-09-01), but none has every term of "quantum teleporter" in its title or affected components. ' +
          'Use fewer or broader terms, or omit match. History-archive records, and vendors that publish no components, match on title only.';
        expect(result.structuredContent).toMatchObject({ incidents: [], notice });
        expect(text(result.content).split(notice)).toHaveLength(2);
      });

      it('reads a blank match and until as unset, and rejects a match with no letter or digit', async () => {
        routeGithub();
        const { result } = await call({
          vendor: 'github',
          filter: 'resolved',
          match: ' ',
          until: '',
        });
        expect(result.total_returned).toBe(20);
        expect(historyRequests()).toEqual([]);

        const parsed = devopsGetIncidents.input.safeParse({ vendor: 'github', match: '--/--' });
        expect(parsed.success).toBe(false);
        expect(parsed.error?.issues.map((i) => i.path[0])).toEqual(['match']);
      });

      describe('until validation', () => {
        it.each(['active', 'scheduled'] as const)(
          'rejects until with filter %s before any request',
          async (filter) => {
            const result = await runToolContract(devopsGetIncidents, {
              vendor: 'github',
              filter,
              until: '2026-09-01',
            });

            expect(result.isError).toBe(true);
            expect(result.structuredContent).toMatchObject({
              error: {
                code: JsonRpcErrorCode.ValidationError,
                message: expect.stringContaining(`"${filter}"`),
                data: {
                  reason: 'invalid_until',
                  recovery: { hint: expect.stringContaining('on or after since') },
                },
              },
            });
            expect(http.calls).toHaveLength(0);
          },
        );

        it('rejects an until before since before any request', async () => {
          const result = await runToolContract(devopsGetIncidents, {
            vendor: 'github',
            since: '2026-09-02',
            until: '2026-09-01',
          });

          expect(result.isError).toBe(true);
          expect(result.structuredContent).toMatchObject({
            error: {
              data: { reason: 'invalid_until' },
              message: expect.stringContaining('until 2026-09-01 is before since 2026-09-02'),
            },
          });
          expect(http.calls).toHaveLength(0);
        });

        it('reads the feeds for an until more than 24 months back, and names the floor when it left nothing', async () => {
          routeGithub();
          const result = await runToolContract(devopsGetIncidents, {
            vendor: 'github',
            until: '2024-09-24',
          });

          expect(result.isError).toBeFalsy();
          expect(historyRequests()).toEqual([]);
          // The recorded maintenance list starts in 2025, so nothing here started that early.
          // The 50-record ceiling follows and names the status page, so the floor sentence
          // leaves the page to it: the result names it once (#97).
          const notice =
            'No incidents matching filter "all" for GitHub started on or before 2024-09-24: all 53 matches started after it. ' +
            "The status page's history archive is read back 24 months at most, to 2024-09-25, so since cannot reach incidents that started on or before 2024-09-24. " +
            pageCeiling(GITHUB);
          expect(result.structuredContent).toMatchObject({
            incidents: [],
            total_returned: 0,
            upstreamCeiling: 50,
            notice,
          });
          expect(notice.split(GITHUB)).toHaveLength(2);
          expect(text(result.content)).toContain('No incidents matched this filter.');
          expect(text(result.content).split(notice)).toHaveLength(2);
        });

        it.each(['2025-13-01', '09/25/2025', '2025-9-1', '2026-09-01T00:00:00Z'])(
          'rejects the malformed date %s at the schema',
          (until) => {
            const parsed = devopsGetIncidents.input.safeParse({ vendor: 'github', until });
            expect(parsed.success).toBe(false);
            expect(parsed.error?.issues.map((i) => i.code)).not.toContain('unrecognized_keys');
            expect(parsed.error?.issues.every((i) => i.path[0] === 'until')).toBe(true);
          },
        );
      });
    });

    describe('start-date range: the start compared and the feed it reaches', () => {
      const md = new MarkdownIt();
      /** The text a reader sees in each blockquote of content[], read back through a CommonMark parse. */
      function quotedText(content: Array<{ type: string; text?: string }>): string[] {
        const source = content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        const quoted: string[] = [];
        let depth = 0;
        for (const token of md.parse(source, {})) {
          if (token.type === 'blockquote_open') depth++;
          else if (token.type === 'blockquote_close') depth--;
          else if (depth > 0 && token.type === 'inline') {
            quoted.push(
              (token.children ?? [])
                .map((c) => (c.type === 'softbreak' || c.type === 'hardbreak' ? '\n' : c.content))
                .join(''),
            );
          }
        }
        return quoted;
      }

      const GCP_FEED = 'https://status.cloud.google.com/incidents.json';
      /** The recorded Google Cloud feed: four incidents, each `begin` earlier than its `created`. */
      const routeGcpFixture = () =>
        http.route({
          match: GCP_FEED,
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

      const GITHUB_PAGE = (fixture('github-incidents.json') as StatuspageIncidentsResponse).page;
      /** A v2 record with no updates; only its dates matter here. */
      const v2 = (
        id: string,
        created_at: string,
        started_at?: string | null,
        extra: Record<string, unknown> = {},
      ) => ({
        id,
        name: `Incident ${id}`,
        impact: 'minor',
        status: 'resolved',
        created_at,
        ...(started_at === undefined ? {} : { started_at }),
        resolved_at: null,
        monitoring_at: null,
        components: [],
        incident_updates: [],
        ...extra,
      });
      /** GitHub serving these v2 records, and one empty archive quarter holding every since below. */
      function routeGithubRecords(incidents: unknown[], maintenances: unknown[] = []) {
        http.route(
          {
            match: `${GITHUB}/api/v2/incidents.json`,
            respond: () => Response.json({ page: GITHUB_PAGE, incidents }),
          },
          {
            match: `${GITHUB}/api/v2/scheduled-maintenances.json`,
            respond: () =>
              Response.json({ page: GITHUB_PAGE, scheduled_maintenances: maintenances }),
          },
          {
            match: historyPage(GITHUB, 1),
            respond: () => Response.json({ start_time: '2026-07-01T00:00:00Z', months: [] }),
          },
        );
      }
      const ids = async (args: Record<string, unknown>) =>
        (await call(args)).result.incidents.map((i) => i.id);
      const day = (vendor: string, date: string) => ids({ vendor, since: date, until: date });

      /**
       * since and until compare each record's start: scheduled_for for a maintenance
       * window, else the earlier of started_at and created_at that parse (#77). A
       * backdated Statuspage post and every Google Cloud incident carry the event time in
       * started_at; a retroactive Statuspage post carries it in created_at.
       */
      describe('the start since and until compare (#77)', () => {
        it('files a Google Cloud incident under the day it began, not the day it was posted', async () => {
          routeGcpFixture();

          // 3BvH3LVGcupoYqV6F4Nw began 2026-07-15T23:57Z and was posted 2026-07-16T03:30Z.
          expect(await day('gcp', '2026-07-15')).toEqual(['3BvH3LVGcupoYqV6F4Nw']);
          expect(await day('gcp', '2026-07-16')).toEqual([]);
          // 5fGQt4VbkDnr3Yp8PXPr began 2026-06-05, five days before it was posted.
          expect(await day('gcp', '2026-06-05')).toEqual(['5fGQt4VbkDnr3Yp8PXPr']);
          expect(await day('gcp', '2026-06-10')).toEqual([]);
        });

        it('files a backdated Statuspage incident under the day it started', async () => {
          // cloudflare jajp50huvxtz's shape: entered as started late on D, posted on D+1.
          routeGithubRecords([
            v2('backdated', '2026-08-11T01:50:23.037Z', '2026-08-10T23:25:00.000Z'),
          ]);

          expect(await day('github', '2026-08-10')).toEqual(['backdated']);
          expect(await day('github', '2026-08-11')).toEqual([]);
        });

        it('keeps a retroactive post on the day it was created', async () => {
          // github wms44hv62t3p: created 2026-08-21T14:00Z, started 2026-08-24T07:19Z.
          routeGithubRecords([
            v2('retroactive', '2026-08-21T14:00:00.000Z', '2026-08-24T07:19:22.991Z'),
          ]);

          expect(await day('github', '2026-08-21')).toEqual(['retroactive']);
          expect(await day('github', '2026-08-24')).toEqual([]);
        });

        it('filters a record with no parseable started_at on created_at', async () => {
          // new Date(null) is the epoch and Math.min(NaN, x) is NaN: neither may decide the start.
          routeGithubRecords([
            v2('null-start', '2026-08-15T12:00:00Z', null),
            v2('no-start', '2026-08-15T11:00:00Z'),
            v2('blank-start', '2026-08-15T10:00:00Z', ''),
            v2('garbled-start', '2026-08-15T09:00:00Z', 'not a date'),
          ]);
          const all = ['null-start', 'no-start', 'blank-start', 'garbled-start'];

          expect(await day('github', '2026-08-15')).toEqual(all);
          expect(await ids({ vendor: 'github', since: '2026-08-16' })).toEqual([]);
          expect(await ids({ vendor: 'github', since: '2026-08-01', until: '2026-08-14' })).toEqual(
            [],
          );
        });

        it('keeps a maintenance window on its scheduled start, not the earlier dates it was posted on', async () => {
          routeGithubRecords(
            [],
            [
              v2('window', '2026-08-01T10:00:00Z', '2026-08-01T10:00:00Z', {
                impact: 'maintenance',
                status: 'completed',
                scheduled_for: '2026-08-20T02:00:00Z',
                scheduled_until: '2026-08-20T04:00:00Z',
              }),
            ],
          );

          expect(await day('github', '2026-08-20')).toEqual(['window']);
          expect(await day('github', '2026-08-01')).toEqual([]);
        });

        it('still sorts by created_at and pages the admitted records by it', async () => {
          routeGithubRecords([
            v2('plain', '2026-08-11T00:30:00Z', '2026-08-11T00:30:00Z'),
            v2('backdated', '2026-08-11T01:50:00Z', '2026-08-10T23:25:00Z'),
          ]);
          const args = { vendor: 'github', since: '2026-08-10', until: '2026-08-10', limit: 1 };

          // Only the backdated record started on the 10th.
          const first = await call(args);
          expect(first.result.incidents.map((i) => i.id)).toEqual(['backdated']);
          expect(first.structured.nextOffset).toBeUndefined();

          // Across both days, newest created_at first, though plain started later.
          const both = { ...args, until: '2026-08-11' };
          const page1 = await call(both);
          expect(page1.result.incidents.map((i) => i.id)).toEqual(['backdated']);
          expect(page1.structured).toMatchObject({ totalCount: 2, nextOffset: 1 });
          const page2 = await call({ ...both, offset: 1 });
          expect(page2.result.incidents.map((i) => i.id)).toEqual(['plain']);
          expect(page2.structured.nextOffset).toBeUndefined();
        });

        it('counts what since and until left out on the same start, on both surfaces', async () => {
          routeGithubRecords([v2('backdated', '2026-08-11T01:50:00Z', '2026-08-10T23:25:00Z')]);

          const result = await runToolContract(devopsGetIncidents, {
            vendor: 'github',
            since: '2026-08-11',
            until: '2026-08-11',
          });

          const notice =
            'No incidents matching filter "all" for GitHub started between 2026-08-11 and 2026-08-11; 1 earlier match was left out by since. ' +
            'Widen the range, or omit since and until for the most recent incidents regardless of date.';
          expect(result.structuredContent).toMatchObject({
            incidents: [],
            total_returned: 0,
            notice,
          });
          expect(quotedText(result.content)).toEqual([notice]);
        });
      });

      /**
       * A feed with no history archive behind it serves a recent window, so a since
       * earlier than its oldest record asks for incidents this tool cannot return (#88).
       * The date is that record's start, as since compares it.
       */
      describe('a since earlier than a windowed feed reaches (#88)', () => {
        const reach = (since: string, name: string, date: string, url?: string) =>
          `since ${since} is earlier than the oldest record ${name}'s status feed returned, which starts on ${date}. ` +
          `This tool reads no history archive for ${name}, so it cannot return incidents that started before then.` +
          (url === undefined ? '' : ` See ${url} for earlier history.`);
        const GCP_URL = 'https://status.cloud.google.com';

        it('names the oldest start on every page of a populated result', async () => {
          routeGcpFixture();
          const args = { vendor: 'gcp', since: '2026-01-01', limit: 50 };

          // The fixture's oldest record, 41E5S3mkTGDfkZuJZH5k, began 2026-02-27T12:37Z.
          const sentence = reach('2026-01-01', 'Google Cloud', '2026-02-27', GCP_URL);
          const seen: string[] = [];
          let pages = 0;
          for (let offset: number | undefined = 0; offset !== undefined; pages++) {
            const result = await runToolContract(devopsGetIncidents, { ...args, offset });
            const structured = result.structuredContent as {
              incidents: { id: string }[];
              nextOffset?: number;
              notice: string;
            };
            seen.push(...structured.incidents.map((i) => i.id));
            expect(structured.notice.endsWith(sentence)).toBe(true);
            expect(quotedText(result.content).at(-1)).toBe(structured.notice);
            offset = structured.nextOffset;
          }
          // The response size budget splits these records across pages; each page says it.
          expect(pages).toBeGreaterThan(1);
          expect(seen).toHaveLength(4);
          expect(seen.at(-1)).toBe('41E5S3mkTGDfkZuJZH5k');

          const past = await call({ ...args, offset: 99 });
          expect(past.structured.notice).toBe(
            'offset 99 is past the end of this result: filter "all" (since 2026-01-01) matched 4 incidents for Google Cloud, so the valid offsets are 0–3. ' +
              `Call again with a lower offset. ${sentence}`,
          );
        });

        it('adds nothing when since is on or after that date', async () => {
          routeGcpFixture();
          const args = { vendor: 'gcp', since: '2026-02-27', limit: 50 };

          const notices: Array<string | undefined> = [];
          for (let offset: number | undefined = 0; offset !== undefined; ) {
            const { structured } = await call({ ...args, offset });
            notices.push(structured.notice);
            offset = structured.nextOffset;
          }
          expect(notices.at(-1)).toBeUndefined();
          for (const notice of notices) expect(notice ?? '').not.toContain('is earlier than');
        });

        it('replaces "Widen the range" when the whole range is older than the feed, on both surfaces', async () => {
          http.route({
            match: 'https://status.slack.com/api/v2.0.0/history',
            respond: () =>
              Response.json(
                JSON.parse(
                  readFileSync(
                    new URL(
                      '../../../services/status-adapters/fixtures/slack-history.json',
                      import.meta.url,
                    ),
                    'utf-8',
                  ),
                ),
              ),
          });

          const result = await runToolContract(devopsGetIncidents, {
            vendor: 'slack',
            since: '2025-03-01',
            until: '2025-03-31',
          });

          // The fixture's oldest record was created 2026-06-16T08:50:09-07:00.
          const notice =
            'No incidents matching filter "all" for Slack started between 2025-03-01 and 2025-03-31; 3 later matches were left out by until. ' +
            reach('2025-03-01', 'Slack', '2026-06-16', 'https://status.slack.com');
          expect(result.structuredContent).toMatchObject({
            incidents: [],
            total_returned: 0,
            notice,
          });
          expect(quotedText(result.content)).toEqual([notice]);
        });

        it('reads the maintenance list under "all" only, and leaves the page pointer to the ceiling notice', async () => {
          const TWILIO_SUMMARY = JSON.parse(
            readFileSync(
              new URL(
                '../../../services/status-adapters/fixtures/statuspage-twilio-summary.json',
                import.meta.url,
              ),
              'utf-8',
            ),
          ) as { components: Array<{ id: string; name: string }> };
          const smtp = TWILIO_SUMMARY.components.find((c) => c.name === 'SMTP')!;
          type Records = Array<{ id: string; components: unknown[] }>;
          const feed = fixture('twilio-incidents.json') as { incidents: Records };
          // rn73nh540rz6 started 2026-09-23T12:34:37-07:00.
          feed.incidents[3] = { ...feed.incidents[3]!, components: [smtp] };
          const maintenances = fixture('twilio-scheduled-maintenances.json') as {
            scheduled_maintenances: Records;
          };
          // bn6yyz65wk75 is moved to 2026-09-09T18:00-07:00, 2026-09-10 in UTC — before the
          // oldest record of Twilio's whole feed, g88dj9p99bqh, which began 2026-09-16 in UTC.
          maintenances.scheduled_maintenances = maintenances.scheduled_maintenances.map((m) =>
            m.id === 'bn6yyz65wk75'
              ? { ...m, components: [smtp], scheduled_for: '2026-09-09T18:00:00.000-07:00' }
              : m,
          );
          http.route(
            {
              match: `${TWILIO}/api/v2/summary.json`,
              respond: () => Response.json(TWILIO_SUMMARY),
            },
            { match: `${TWILIO}/api/v2/incidents.json`, respond: () => Response.json(feed) },
            {
              match: `${TWILIO}/api/v2/scheduled-maintenances.json`,
              respond: () => Response.json(maintenances),
            },
          );
          const ceiling =
            "The vendor's status API returns at most 50 incidents per fetch and offers no pagination, so incidents older than the oldest one it returned are not reachable through this tool at any offset. " +
            'See https://status.twilio.com for the older history.';

          const all = await call({ vendor: 'sendgrid', filter: 'all', since: '2026-01-01' });
          expect(all.result.incidents.map((i) => i.id)).toEqual(['rn73nh540rz6', 'bn6yyz65wk75']);
          expect(all.structured.notice).toBe(
            `${ceiling} ${reach('2026-01-01', 'SendGrid', '2026-09-10')}`,
          );

          // The reach is the shared feed's, not the oldest SendGrid record's (2026-09-23):
          // a SendGrid incident from 2026-09-16 on would have been in what Twilio returned.
          const resolved = await call({
            vendor: 'sendgrid',
            filter: 'resolved',
            since: '2026-01-01',
          });
          expect(
            resolved.structured.notice?.endsWith(reach('2026-01-01', 'SendGrid', '2026-09-16')),
          ).toBe(true);
          expect(historyRequests()).toEqual([]);
        });

        it('says nothing on redis-cloud, whose payload is its whole history', async () => {
          http.route({
            match: 'https://status.redis.io/data/payload.json',
            respond: () =>
              Response.json(
                JSON.parse(
                  readFileSync(
                    new URL(
                      '../../../services/status-adapters/fixtures/firehydrant-redis.json',
                      import.meta.url,
                    ),
                    'utf-8',
                  ),
                ),
              ),
          });

          // The payload's oldest incident started 2026-01-08, after since.
          const { result, structured } = await call({ vendor: 'redis-cloud', since: '2025-01-01' });
          expect(result.total_returned).toBeGreaterThan(0);
          expect(structured.notice).toBeUndefined();
        });

        it('names no date when the feed returned no record', async () => {
          http.route({ match: GCP_FEED, respond: () => Response.json([]) });

          const { structured } = await call({ vendor: 'gcp', since: '2025-01-01' });
          expect(structured.notice).toBe(
            'Google Cloud currently lists no incidents and no maintenance windows at all. Filter "all" already spans everything its status feed publishes, so the narrower filters have nothing to return either. ' +
              `See ${GCP_URL} to confirm on the vendor's own status page.`,
          );
        });
      });

      /**
       * until with no since leaves the range open below, so on a recent-window feed with no
       * history archive it always reaches past the oldest record the feed returned: the
       * notice names that record's start, on populated and empty results alike (#94). A feed
       * that carries its page's whole history names where that history starts only when an
       * empty range ends before it, since set or not.
       */
      describe('an until with no since, and where a whole-history feed starts (#94)', () => {
        const GCP_URL = 'https://status.cloud.google.com';
        const REDIS_URL = 'https://status.redis.io';
        const start = (name: string, date: string, url?: string) =>
          `The oldest record ${name}'s status feed returned starts on ${date}. This tool reads no history archive for ${name}, so it cannot return incidents that started before then.${url === undefined ? '' : ` See ${url} for earlier history.`}`;
        const whole = (name: string, date: string) =>
          `${name}'s status feed carries its status page's whole history, which starts on ${date}; the page publishes nothing older.`;

        type RedisPayload = {
          incidents: Array<{ id: string; timestamps: Record<string, string> }>;
        };
        /** The recorded Redis Cloud payload: three incidents and one maintenance window, the oldest begun 2026-01-08. */
        function routeRedis(edit: (payload: RedisPayload) => void = () => {}) {
          const payload = JSON.parse(
            readFileSync(
              new URL(
                '../../../services/status-adapters/fixtures/firehydrant-redis.json',
                import.meta.url,
              ),
              'utf-8',
            ),
          ) as RedisPayload;
          edit(payload);
          http.route({
            match: `${REDIS_URL}/data/payload.json`,
            respond: () => Response.json(payload),
          });
        }
        const OLDEST_REDIS = 'c41455be-535b-4bdf-8194-97305b6a03d5';

        it('names the oldest start on a populated result, on both surfaces', async () => {
          routeGcpFixture();
          const result = await runToolContract(devopsGetIncidents, {
            vendor: 'gcp',
            until: '2026-03-01',
          });

          const structured = result.structuredContent as {
            incidents: { id: string }[];
            notice?: string;
          };
          // 41E5S3mkTGDfkZuJZH5k, begun 2026-02-27T12:37Z, is the one record on or before until.
          expect(structured.incidents.map((i) => i.id)).toEqual(['41E5S3mkTGDfkZuJZH5k']);
          expect(structured.notice).toBe(start('Google Cloud', '2026-02-27', GCP_URL));
          expect(quotedText(result.content).at(-1)).toBe(structured.notice);
        });

        it('names the status page once where the ceiling notice already does (sendgrid)', async () => {
          const summary = JSON.parse(
            readFileSync(
              new URL(
                '../../../services/status-adapters/fixtures/statuspage-twilio-summary.json',
                import.meta.url,
              ),
              'utf-8',
            ),
          ) as { components: Array<{ id: string; name: string }> };
          const smtp = summary.components.find((c) => c.name === 'SMTP')!;
          const feed = fixture('twilio-incidents.json') as {
            incidents: Array<{ id: string; components: unknown[] }>;
          };
          // rn73nh540rz6 started 2026-09-23; Twilio's whole feed starts at g88dj9p99bqh, 2026-09-16.
          feed.incidents[3] = { ...feed.incidents[3]!, components: [smtp] };
          const route = () =>
            http.route(
              { match: `${TWILIO}/api/v2/summary.json`, respond: () => Response.json(summary) },
              { match: `${TWILIO}/api/v2/incidents.json`, respond: () => Response.json(feed) },
              {
                match: `${TWILIO}/api/v2/scheduled-maintenances.json`,
                respond: json('twilio-scheduled-maintenances.json'),
              },
            );

          route();
          const empty = await runToolContract(devopsGetIncidents, {
            vendor: 'sendgrid',
            until: '2000-01-01',
          });
          const notice = `No incidents matching filter "all" for SendGrid started on or before 2000-01-01: all 1 match started after it. ${pageCeiling(TWILIO)} ${start('SendGrid', '2026-09-16')}`;
          expect(empty.structuredContent).toMatchObject({
            incidents: [],
            upstreamCeiling: 50,
            notice,
          });
          expect(notice.split(TWILIO)).toHaveLength(2);
          expect(quotedText(empty.content)).toEqual([notice]);

          http.reset();
          route();
          const populated = await call({ vendor: 'sendgrid', until: '2026-10-01' });
          expect(populated.result.incidents.map((i) => i.id)).toEqual(['rn73nh540rz6']);
          expect(populated.structured.notice).toBe(
            `${pageCeiling(TWILIO)} ${start('SendGrid', '2026-09-16')}`,
          );
        });

        it('names where a whole-history feed starts when an empty range ends before it, since set or not', async () => {
          routeRedis();
          const untilOnly = await runToolContract(devopsGetIncidents, {
            vendor: 'redis-cloud',
            until: '2026-01-07',
          });
          const notice = `No incidents matching filter "all" for Redis Cloud started on or before 2026-01-07: all 4 matches started after it. ${whole('Redis Cloud', '2026-01-08')}`;
          expect(untilOnly.structuredContent).toMatchObject({ incidents: [], notice });
          expect(quotedText(untilOnly.content)).toEqual([notice]);
          expect(notice).not.toContain(REDIS_URL);

          // Nothing older than the history exists, so there is no "Widen the range" either.
          const range = await call({
            vendor: 'redis-cloud',
            since: '2025-01-01',
            until: '2025-06-30',
          });
          expect(range.structured.notice).toBe(
            `No incidents matching filter "all" for Redis Cloud started between 2025-01-01 and 2025-06-30; 4 later matches were left out by until. ${whole('Redis Cloud', '2026-01-08')}`,
          );
        });

        it('adds nothing on a whole-history feed when the range reaches where it starts', async () => {
          routeRedis();
          // A populated result: until on the day the history starts.
          const populated = await call({ vendor: 'redis-cloud', until: '2026-01-08' });
          expect(populated.result.incidents.map((i) => i.id)).toEqual([OLDEST_REDIS]);
          expect(populated.structured.notice).toBeUndefined();

          // An empty range inside the history keeps its advice to widen it.
          const gap = await call({
            vendor: 'redis-cloud',
            since: '2026-01-09',
            until: '2026-01-10',
          });
          expect(gap.structured.notice).toBe(
            'No incidents matching filter "all" for Redis Cloud started between 2026-01-09 and 2026-01-10; 1 earlier match was left out by since and 3 later matches were left out by until. ' +
              'Widen the range, or omit since and until for the most recent incidents regardless of date.',
          );

          // An until-only range that the filter, not the history, emptied: the records on or
          // before it are open, so filter "resolved" left them out. The page shows nothing more.
          http.reset();
          routeRedis((payload) => {
            const oldest = payload.incidents.find((i) => i.id === OLDEST_REDIS)!;
            delete oldest.timestamps.resolved;
          });
          const filtered = await call({
            vendor: 'redis-cloud',
            filter: 'resolved',
            until: '2026-02-01',
          });
          expect(filtered.structured.notice).toBe(
            'No incidents matching filter "resolved" for Redis Cloud started on or before 2026-02-01: all 2 matches started after it.',
          );
        });

        /**
         * The wording follows the feed's wholeHistory capability, never the vendor or its
         * api_type: a recent-window backend answered as whole-history gets the whole-history
         * wording, and a whole-history backend answered as a recent window gets the window's.
         */
        it("keys the wording on the feed's wholeHistory capability, not on the vendor", async () => {
          const answerWith = (wholeHistory: boolean) =>
            vi.mocked(vendorHistory).mockImplementationOnce((vendor) => ({
              ...backendHistory(vendor.api_type),
              wholeHistory,
            }));

          routeGcpFixture();
          answerWith(true);
          const gcpEmpty = await call({ vendor: 'gcp', until: '2026-01-15' });
          expect(gcpEmpty.structured.notice).toBe(
            `No incidents matching filter "all" for Google Cloud started on or before 2026-01-15: all 4 matches started after it. ${whole('Google Cloud', '2026-02-27')}`,
          );
          answerWith(true);
          const gcpPopulated = await call({ vendor: 'gcp', until: '2026-03-01' });
          expect(gcpPopulated.result.total_returned).toBe(1);
          expect(gcpPopulated.structured.notice).toBeUndefined();

          routeRedis();
          answerWith(false);
          const redis = await call({ vendor: 'redis-cloud', until: '2026-01-07' });
          expect(redis.structured.notice).toBe(
            `No incidents matching filter "all" for Redis Cloud started on or before 2026-01-07: all 4 matches started after it. ${start('Redis Cloud', '2026-01-08', REDIS_URL)}`,
          );
        });
      });
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
        body: () => Response.json({ result: { status_overall: {}, status: [] } }),
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
        body: () => Response.json({ incidents: [], components: [] }),
        notice: retry('Redis Cloud', '"all" or "resolved" or "scheduled"'),
      },
      {
        backend: 'datadog',
        vendor: 'datadog',
        feed: 'https://status.datadoghq.com/config.json',
        body: () => Response.json({ components: [], incidents: [], maintenances: null }),
        notice: retry('Datadog US1', '"all" or "resolved" or "scheduled"'),
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

  /**
   * Each surface is held to 64,000 bytes, measured as the caller receives it: the
   * serialized structuredContent and the content[] text format() renders, vendor text
   * escaped (#58). The heavy pages are the circleci, gcp, and aws captures from
   * 2026-10-14, re-expressed as the Statuspage feed shape every adapter normalizes to.
   */
  describe('response size budget (#58)', () => {
    const BUDGET = 64_000;
    type Feed = StatuspageIncidentsResponse & {
      scheduled_maintenances?: StatuspageIncidentsResponse['incidents'];
    };
    type Incident = StatuspageIncidentsResponse['incidents'][number];
    type Payload = {
      incidents: Array<{
        id: string;
        updates: { body: string; created_at: string }[];
        affected_components: string[];
        updates_omitted?: number;
      }>;
      total_returned: number;
      truncated?: boolean;
      shown?: number;
      cap?: number;
      totalCount?: number;
      nextOffset?: number;
      notice?: string;
    };

    const heavy = (vendor: string) =>
      JSON.parse(
        readFileSync(
          new URL(`./fixtures/incidents-heavy-${vendor}.json`, import.meta.url),
          'utf-8',
        ),
      ) as Feed;

    async function serve(feed: Feed) {
      const { _mockFetchIncidents, _mockFetchScheduledMaintenances } = (await import(
        '@/services/statuspage/statuspage-service.js'
      )) as unknown as {
        _mockFetchIncidents: ReturnType<typeof vi.fn>;
        _mockFetchScheduledMaintenances: ReturnType<typeof vi.fn>;
      };
      _mockFetchIncidents.mockResolvedValue({
        data: { page: feed.page, incidents: feed.incidents },
        cached: false,
      });
      _mockFetchScheduledMaintenances.mockResolvedValue({
        data: { page: feed.page, scheduled_maintenances: feed.scheduled_maintenances ?? [] },
        cached: false,
      });
    }

    /** One call through the production contract, with each surface's size as received. */
    async function call(args: Record<string, unknown>) {
      const result = await runToolContract(devopsGetIncidents, args as never);
      expect(result.isError).toBeFalsy();
      const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      return {
        payload: result.structuredContent as Payload,
        text,
        structuredBytes: Buffer.byteLength(JSON.stringify(result.structuredContent)),
        contentBytes: Buffer.byteLength(text),
      };
    }

    /** Every page from `offset` 0 on, walked by nextOffset. */
    async function walk(args: Record<string, unknown>) {
      const pages = [await call(args)];
      for (let next = pages[0]!.payload.nextOffset; next !== undefined; ) {
        const page = await call({ ...args, offset: next });
        pages.push(page);
        next = page.payload.nextOffset;
      }
      return pages;
    }

    /** The order the tool lists a feed in at filter "all": newest first across both lists. */
    const listed = (feed: Feed) =>
      [...feed.incidents, ...(feed.scheduled_maintenances ?? [])]
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
        .map((i) => i.id);

    it.each(['circleci', 'gcp'])(
      'holds a recorded %s page at limit 50 to the budget on both surfaces',
      async (capture) => {
        const feed = heavy(capture);
        await serve(feed);
        const page = await call({ vendor: 'circleci', limit: 50 });

        expect(page.structuredBytes).toBeLessThanOrEqual(BUDGET);
        expect(page.contentBytes).toBeLessThanOrEqual(BUDGET);
        const { payload } = page;
        expect(payload.truncated).toBe(true);
        expect(payload.shown).toBe(payload.total_returned);
        expect(payload.shown).toBeGreaterThan(0);
        expect(payload.shown).toBeLessThan(50);
        expect(payload.incidents.map((i) => i.id)).toEqual(listed(feed).slice(0, payload.shown));
        expect(payload.cap).toBe(50);
        expect(payload.nextOffset).toBe(payload.shown);
        expect(payload.notice).toContain(
          `Showing incidents 1–${payload.shown} of ${listed(feed).length}; this page stopped at the 64,000-byte response size budget short of limit 50.`,
        );
        expect(payload.notice).toContain(`offset: ${payload.shown}`);
        // Whole incidents only: nothing on a page is trimmed while another follows it.
        expect(payload.incidents.every((i) => i.updates_omitted === undefined)).toBe(true);
      },
    );

    it('holds the recorded aws page at limit 50 to the budget', async () => {
      const { fetchAwsIncidents } = await import('@/services/status-adapters/aws-adapter.js');
      const feed = heavy('aws');
      vi.mocked(fetchAwsIncidents).mockResolvedValue({ data: feed, cached: false });
      try {
        const page = await call({ vendor: 'aws', limit: 50 });

        expect(page.structuredBytes).toBeLessThanOrEqual(BUDGET);
        expect(page.contentBytes).toBeLessThanOrEqual(BUDGET);
        // 140-odd affected services per event count toward the budget but are never cut.
        const byId = new Map(feed.incidents.map((i) => [i.id, i]));
        for (const inc of page.payload.incidents) {
          const source = byId.get(inc.id)!;
          const components = source.incident_updates[0]!.affected_components!.map((c) => c.name);
          expect(inc.affected_components).toEqual(components);
        }
        expect(page.payload.nextOffset).toBe(page.payload.shown);
      } finally {
        vi.mocked(fetchAwsIncidents).mockReset();
      }
    });

    it.each(['circleci', 'gcp'])(
      'pages a recorded %s feed by nextOffset with no repeat and no skip',
      async (capture) => {
        const feed = heavy(capture);
        await serve(feed);
        const pages = await walk({ vendor: 'circleci', limit: 50, offset: 0 });

        expect(pages.length).toBeGreaterThan(1);
        for (const page of pages) {
          expect(page.structuredBytes).toBeLessThanOrEqual(BUDGET);
          expect(page.contentBytes).toBeLessThanOrEqual(BUDGET);
        }
        expect(pages.flatMap((p) => p.payload.incidents.map((i) => i.id))).toEqual(listed(feed));
      },
    );

    it('a cut page starting past 0 continues at offset + shown', async () => {
      const feed = heavy('circleci');
      await serve(feed);
      const { payload } = await call({ vendor: 'circleci', limit: 50, offset: 5 });

      expect(payload.shown).toBeGreaterThan(0);
      expect(payload.shown).toBeLessThan(50);
      expect(payload.incidents.map((i) => i.id)).toEqual(listed(feed).slice(5, 5 + payload.shown!));
      expect(payload.nextOffset).toBe(5 + payload.shown!);
      expect(payload.notice).toContain(`Showing incidents 6–${5 + payload.shown!} of 50;`);
    });

    /** Bodies of `<` render four times larger in content[] (`&lt;`), `"` twice in JSON. */
    it.each([
      ['<', 'content[]'],
      ['"', 'structuredContent'],
    ])('measures escaped vendor text: bodies of %s weigh most in %s', async (char) => {
      const base = RESOLVED_INCIDENT.incidents[0]!;
      const incidents = Array.from({ length: 50 }, (_, n) => ({
        ...base,
        id: `inc-${n}`,
        created_at: new Date(Date.UTC(2026, 8, 30) - n * 3_600_000).toISOString(),
        incident_updates: [{ ...base.incident_updates[0]!, body: char.repeat(2_500) }],
      }));
      await serve({ ...RESOLVED_INCIDENT, incidents, scheduled_maintenances: [] });

      const pages = await walk({ vendor: 'circleci', limit: 50 });
      for (const page of pages) {
        expect(page.structuredBytes).toBeLessThanOrEqual(BUDGET);
        expect(page.contentBytes).toBeLessThanOrEqual(BUDGET);
      }
      expect(pages.flatMap((p) => p.payload.incidents.map((i) => i.id))).toEqual(
        incidents.map((i) => i.id),
      );
    });

    /** Pages that fill to within a few hundred bytes of the edge still fit with every field set. */
    it.each([1_190, 1_227, 1_264, 1_301])(
      'stays within the budget at the edge (bodies of %i bytes)',
      async (size) => {
        const base = RESOLVED_INCIDENT.incidents[0]!;
        const incidents = Array.from({ length: 50 }, (_, n) => ({
          ...base,
          id: `inc-${n}`,
          created_at: new Date(Date.UTC(2026, 8, 30) - n * 3_600_000).toISOString(),
          incident_updates: [{ ...base.incident_updates[0]!, body: 'x'.repeat(size + n) }],
        }));
        await serve({ ...RESOLVED_INCIDENT, incidents, scheduled_maintenances: [] });

        // The 50-record feed is at its ceiling, so upstreamCeiling and its notice ride along too.
        const page = await call({ vendor: 'circleci', limit: 50, offset: 0 });
        expect(page.payload.notice).toContain('returns at most 50 incidents');
        expect(page.structuredBytes).toBeLessThanOrEqual(BUDGET);
        expect(page.contentBytes).toBeLessThanOrEqual(BUDGET);
        expect(page.structuredBytes).toBeGreaterThan(BUDGET - 4_000);
      },
    );

    describe('an incident over the budget on its own', () => {
      /** The largest circleci incident's 27 updates, repeated past 120 KB with later timestamps. */
      function oversized(): Incident {
        const feed = heavy('circleci');
        const source = feed.incidents.find((i) => i.id === '6cfhhlr4rmm0')!;
        const updates: Incident['incident_updates'] = [];
        for (let round = 0; JSON.stringify(updates).length < 120_000; round++) {
          for (const [n, u] of source.incident_updates.entries()) {
            updates.push({
              ...u,
              id: `u-${round}-${n}`,
              created_at: new Date(Date.parse(u.created_at) + round * 86_400_000).toISOString(),
              affected_components: round === 0 ? u.affected_components : null,
            });
          }
        }
        return { ...source, incident_updates: updates };
      }

      const small = {
        ...RESOLVED_INCIDENT.incidents[0]!,
        id: 'inc-after',
        created_at: '2020-01-01T00:00:00Z',
      };

      it('returns alone with its newest updates, counting the oldest it left out', async () => {
        const big = oversized();
        const total = big.incident_updates.length;
        await serve({ ...RESOLVED_INCIDENT, incidents: [big, small], scheduled_maintenances: [] });

        const page = await call({ vendor: 'circleci', limit: 20 });

        expect(page.structuredBytes).toBeLessThanOrEqual(BUDGET);
        expect(page.contentBytes).toBeLessThanOrEqual(BUDGET);
        const [inc] = page.payload.incidents;
        expect(page.payload.incidents).toHaveLength(1);
        const kept = inc!.updates.length;
        expect(kept).toBeGreaterThan(0);
        expect(inc!.updates_omitted).toBe(total - kept);
        // The newest updates, oldest first, ending at the newest the vendor published.
        const newest = [...big.incident_updates]
          .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
          .slice(total - kept)
          .map((u) => u.created_at);
        expect(inc!.updates.map((u) => u.created_at)).toEqual(newest);
        // Components count toward the budget but stay whole.
        expect(inc!.affected_components).toEqual(
          big.incident_updates[0]!.affected_components!.map((c) => c.name),
        );
        expect(page.text).toContain(
          `**Updates (${kept} of ${total}, ${total - kept} oldest omitted):**`,
        );

        // The incident after it is the next page, and both notices share one string.
        expect(page.payload).toMatchObject({ truncated: true, shown: 1, cap: 20, nextOffset: 1 });
        expect(page.payload.notice).toContain('Showing incidents 1–1 of 2;');
        expect(page.payload.notice).toContain(
          `its ${total - kept} oldest updates were left out (updates_omitted). Call again with the same arguments plus offset: 0, limit: 1, full_updates: true to read every update.`,
        );
        expect(page.text.split(page.payload.notice!)).toHaveLength(2);
        const next = await call({ vendor: 'circleci', limit: 20, offset: 1 });
        expect(next.payload.incidents.map((i) => i.id)).toEqual(['inc-after']);
      });

      it('returns every update with full_updates: true, as the notice says', async () => {
        const big = oversized();
        await serve({ ...RESOLVED_INCIDENT, incidents: [big, small], scheduled_maintenances: [] });

        // The recipe the trim notice prints, run verbatim: same arguments plus these three.
        const args = { vendor: 'circleci', limit: 20 };
        const page = await call({ ...args, offset: 0, limit: 1, full_updates: true });

        const [inc] = page.payload.incidents;
        expect(inc!.updates).toHaveLength(big.incident_updates.length);
        expect(inc!.updates_omitted).toBeUndefined();
        expect(page.text).toContain(`**Updates (${big.incident_updates.length}):**`);
        // The caller asked for the whole record, so the budget no longer bounds it.
        expect(page.structuredBytes).toBeGreaterThan(BUDGET);
        expect(page.payload.notice).not.toContain('updates_omitted');
      });
    });

    it('leaves a page under the budget as it was, with no updates_omitted', async () => {
      await serve({ ...RESOLVED_INCIDENT, scheduled_maintenances: [] });
      const ctx = createMockContext({ errors: devopsGetIncidents.errors });
      const result = await devopsGetIncidents.handler(
        devopsGetIncidents.input.parse({ vendor: 'circleci', filter: 'resolved' }),
        ctx,
      );

      expect(result.incidents).toHaveLength(1);
      expect(Object.keys(result.incidents[0]!)).not.toContain('updates_omitted');
      expect(getEnrichment(ctx)).toEqual({});
      const text = (devopsGetIncidents.format!(result)[0] as { text: string }).text;
      expect(text).toContain('**Updates (2):**');
    });

    it('composes the budget notice with the ceiling and history-gap notices', async () => {
      const feed = fixture('github-incidents.json') as Feed & { page: { time_zone?: string } };
      delete feed.page.time_zone;
      await serve(feed);

      const { payload, structuredBytes, contentBytes, text } = await call({
        vendor: 'github',
        filter: 'resolved',
        since: '2026-01-01',
        limit: 50,
      });

      expect(structuredBytes).toBeLessThanOrEqual(BUDGET);
      expect(contentBytes).toBeLessThanOrEqual(BUDGET);
      expect(payload.notice).toMatch(
        /^Showing incidents 1–\d+ of 50; this page stopped at the 64,000-byte response size budget short of limit 50\. .*returns at most 50 incidents per fetch.*names no page time zone/,
      );
      expect(text.split(payload.notice!)).toHaveLength(2);
    });

    it('holds a clamped limit to the budget on both surfaces, its notice included (#69)', async () => {
      await serve(heavy('circleci'));
      const page = await call({ vendor: 'circleci', limit: 500 });

      expect(page.structuredBytes).toBeLessThanOrEqual(BUDGET);
      expect(page.contentBytes).toBeLessThanOrEqual(BUDGET);
      const { payload } = page;
      expect(payload.cap).toBe(50);
      expect(payload.notice).toContain('short of limit 50.');
      expect(payload.notice).toContain('limit 500 is past the maximum of 50; 50 was used.');
      expect(page.text.split(payload.notice!)).toHaveLength(2);
    });
  });

  describe('limit clamp (#69)', () => {
    /**
     * 60 small records, newest first as `inc-1`…`inc-60`, so paging — not the size budget —
     * ends a page: 45 incidents (under the feed's own 50-incident ceiling, so no ceiling
     * notice) and 15 older maintenance windows, merged under filter "all".
     */
    const record = (n: number) => ({
      ...RESOLVED_INCIDENT.incidents[0]!,
      id: `inc-${n}`,
      created_at: new Date(Date.UTC(2026, 8, 1) - n * 3_600_000).toISOString(),
    });
    const items = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, i) => record(from + i));

    async function call(args: Record<string, unknown>) {
      const { _mockFetchIncidents, _mockFetchScheduledMaintenances } = (await import(
        '@/services/statuspage/statuspage-service.js'
      )) as unknown as {
        _mockFetchIncidents: ReturnType<typeof vi.fn>;
        _mockFetchScheduledMaintenances: ReturnType<typeof vi.fn>;
      };
      _mockFetchIncidents.mockResolvedValue({
        data: { ...RESOLVED_INCIDENT, incidents: items(1, 45) },
        cached: false,
      });
      _mockFetchScheduledMaintenances.mockResolvedValue({
        data: { ...EMPTY_SCHEDULED, scheduled_maintenances: items(46, 60) },
        cached: false,
      });
      const result = await runToolContract(devopsGetIncidents, {
        vendor: 'github',
        filter: 'all',
        ...args,
      } as never);
      const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      return {
        result,
        text,
        payload: result.structuredContent as {
          incidents: { id: string }[];
          total_returned: number;
          truncated?: boolean;
          cap?: number;
          totalCount?: number;
          nextOffset?: number;
          notice?: string;
        },
      };
    }

    const LIMIT_NOTICE = 'limit 51 is past the maximum of 50; 50 was used.';

    it('serves limit 51 as 50, paging from the effective value', async () => {
      const { result, payload, text } = await call({ limit: 51 });

      expect(result.isError).toBeFalsy();
      expect(payload.total_returned).toBe(50);
      expect(payload.incidents.at(-1)!.id).toBe('inc-50');
      expect(payload).toMatchObject({ truncated: true, cap: 50, totalCount: 60, nextOffset: 50 });
      expect(payload.notice).toBe(
        `Showing incidents 1–50 of 60. Call again with offset: 50 for the next page, or narrow with filter, since, until, or match. ${LIMIT_NOTICE}`,
      );
      expect(text.split(LIMIT_NOTICE)).toHaveLength(2);
    });

    it('serves the last page at the effective limit with only the clamp to explain', async () => {
      const { payload } = await call({ limit: 51, offset: 50 });

      expect(payload.incidents.map((i) => i.id)).toEqual(
        Array.from({ length: 10 }, (_, i) => `inc-${51 + i}`),
      );
      expect(payload.truncated).toBeUndefined();
      expect(payload.notice).toBe(LIMIT_NOTICE);
    });

    it('serves limit 50 unchanged, with no clamp notice', async () => {
      const { payload } = await call({ limit: 50 });

      expect(payload.total_returned).toBe(50);
      expect(payload).toMatchObject({ truncated: true, cap: 50, totalCount: 60, nextOffset: 50 });
      expect(payload.notice).toBe(
        'Showing incidents 1–50 of 60. Call again with offset: 50 for the next page, or narrow with filter, since, until, or match.',
      );
    });

    it('keeps rejecting a limit under 1', async () => {
      const { result } = await call({ limit: 0 });
      expect(result.isError).toBe(true);
    });

    it('states the clamp in the limit description', () => {
      const description = devopsGetIncidents.input.shape.limit.description ?? '';
      expect(description).toContain('A value over 50 is served as 50,');
    });
  });

  /**
   * `atlassian` reads an umbrella page that publishes no components; a response serving it
   * closes its notice with the product slugs to check instead (#74). The sentence is pinned
   * where it is built; these cases prove where this tool puts it, on each notice path.
   */
  describe('atlassian umbrella pointer (#74)', () => {
    const pointer = productSlugsNotice(VENDOR_REGISTRY.find((v) => v.slug === 'atlassian')!)!;
    const base = RESOLVED_INCIDENT.incidents[0]!;
    const incidents = [
      { ...base, id: 'inc-new', created_at: '2025-03-04T07:31:46Z' },
      { ...base, id: 'inc-old', created_at: '2024-01-01T00:00:00Z' },
    ];

    async function serve(feed: StatuspageIncidentsResponse['incidents']) {
      const { _mockFetchIncidents, _mockFetchScheduledMaintenances } = (await import(
        '@/services/statuspage/statuspage-service.js'
      )) as unknown as {
        _mockFetchIncidents: ReturnType<typeof vi.fn>;
        _mockFetchScheduledMaintenances: ReturnType<typeof vi.fn>;
      };
      _mockFetchIncidents.mockResolvedValue({
        data: { page: RESOLVED_INCIDENT.page, incidents: feed },
        cached: false,
      });
      _mockFetchScheduledMaintenances.mockResolvedValue({ data: EMPTY_SCHEDULED, cached: false });
    }

    async function call(args: Record<string, unknown>) {
      const result = await runToolContract(devopsGetIncidents, args as never);
      expect(result.isError).toBeFalsy();
      return {
        structured: result.structuredContent as { incidents: { id: string }[]; notice?: string },
        text: result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n'),
      };
    }

    it('names the product slugs', () => {
      expect(pointer).toContain('jira');
      expect(pointer).toContain('bitbucket');
    });

    it('returns the umbrella incidents with the pointer as the whole notice', async () => {
      await serve(incidents);
      const { structured, text } = await call({ vendor: 'atlassian' });

      expect(structured.incidents.map((i) => i.id)).toEqual(['inc-new', 'inc-old']);
      expect(structured.notice).toBe(pointer);
      expect(text.split(pointer)).toHaveLength(2);
    });

    it('closes a truncated page notice, after the paging sentence', async () => {
      await serve(incidents);
      const { structured } = await call({ vendor: 'atlassian', limit: 1 });

      expect(structured.notice).toBe(
        `Showing incidents 1–1 of 2. Call again with offset: 1 for the next page, or narrow with filter, since, until, or match. ${pointer}`,
      );
    });

    it('closes an empty result notice, after the match-miss sentence', async () => {
      await serve(incidents);
      const { structured } = await call({ vendor: 'atlassian', match: 'bitbucket' });

      expect(structured.incidents).toEqual([]);
      expect(structured.notice).toBe(
        '2 incidents for Atlassian (cross-product incidents) matched filter "all", but none has every term of "bitbucket" in its title or affected components. ' +
          'Use fewer or broader terms, or omit match. History-archive records, and vendors that publish no components, match on title only. ' +
          pointer,
      );
    });

    it('adds no pointer for a vendor without product slugs', async () => {
      await serve(incidents);
      const { structured } = await call({ vendor: 'github' });
      expect(structured.notice).toBeUndefined();
    });
  });

  it('names the backends whose scheduled filter lists completed maintenance windows (#85)', () => {
    const filter = devopsGetIncidents.input.shape.filter.description ?? '';
    expect(filter).toContain(
      'scheduled: only maintenance windows — upcoming and in-progress ones, plus completed ones on Atlassian Statuspage, Firehydrant ("redis-cloud"), and Datadog ("datadog", "datadog-eu1") vendors; Status.io vendors ("gitlab", "neon") list upcoming and in-progress windows only.',
    );
    expect(devopsGetIncidents.description).toContain(
      'or maintenance windows: upcoming and in-progress ones, plus completed ones on Atlassian Statuspage, Firehydrant, and Datadog vendors (Status.io vendors list upcoming and in-progress only).',
    );
    expect(devopsGetIncidents.description).not.toContain('upcoming maintenance windows');
  });

  it('says where a whole-history feed gets its start date, in the since and until descriptions alike (#94)', () => {
    const { since, until } = devopsGetIncidents.input.shape;
    const whole =
      'A feed that carries its page\'s whole history (such as "redis-cloud" or "datadog")';
    expect(since.description).toContain(
      `${whole} holds nothing older, so it gets that date only on an empty result whose until is earlier than it.`,
    );
    expect(until.description).toContain(
      `${whole} gets that date only on an empty result whose until is earlier than it.`,
    );
    for (const description of [since.description, until.description]) {
      expect(description).not.toContain('on most is a recent window');
    }
  });
});
