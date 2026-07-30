/**
 * @fileoverview Tests for the StatuspageService fetch and caching logic.
 * @module tests/services/statuspage/statuspage-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getStatuspageService,
  initStatuspageService,
  StatuspageService,
} from '@/services/statuspage/statuspage-service.js';
import type { StatuspageSummaryResponse } from '@/services/statuspage/types.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    cacheTtlMs: 60_000,
    fetchTimeoutMs: 5000,
    certTimeoutMs: 5000,
    dnsTimeoutMs: 3000,
  }),
}));

const MOCK_SUMMARY: StatuspageSummaryResponse = {
  page: {
    id: 'p1',
    name: 'Test',
    time_zone: 'UTC',
    updated_at: '',
    url: 'https://status.example.com',
  },
  status: { indicator: 'none', description: 'All Systems Operational' },
  components: [],
  incidents: [],
  scheduled_maintenances: [],
};

/** Each test uses a unique URL so the shared in-memory cache never collides. */
let urlCounter = 0;
function freshUrl() {
  return `https://status-${++urlCounter}.example.com`;
}

describe('StatuspageService', () => {
  beforeEach(() => {
    initStatuspageService();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(MOCK_SUMMARY),
      }),
    );
  });

  it('init/accessor pattern works', () => {
    expect(getStatuspageService()).toBeDefined();
  });

  it('fetchSummary returns data from fetch', async () => {
    const service = getStatuspageService();
    const { data, cached } = await service.fetchSummary(freshUrl());
    expect(data.status.indicator).toBe('none');
    expect(cached).toBe(false);
  });

  it('fetchSummary returns cached result on second call', async () => {
    const service = getStatuspageService();
    const url = freshUrl();
    await service.fetchSummary(url);
    const { cached } = await service.fetchSummary(url);
    // Second call should hit cache (same URL)
    expect(cached).toBe(true);
    // fetch should have been called only once for this URL
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it('fetchIncidents calls the incidents endpoint', async () => {
    const MOCK_INCIDENTS = { page: MOCK_SUMMARY.page, incidents: [] };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(MOCK_INCIDENTS),
      }),
    );

    const service = new StatuspageService();
    const { data } = await service.fetchIncidents(freshUrl());
    expect(data.incidents).toBeInstanceOf(Array);

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect(fetchCall?.[0] as string).toContain('/api/v2/incidents.json');
  });

  it('fetchScheduledMaintenances calls the scheduled-maintenances endpoint', async () => {
    const MOCK_MAINT = { page: MOCK_SUMMARY.page, scheduled_maintenances: [] };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: vi.fn().mockResolvedValue(MOCK_MAINT),
      }),
    );

    const service = new StatuspageService();
    const { data } = await service.fetchScheduledMaintenances(freshUrl());
    expect(data.scheduled_maintenances).toBeInstanceOf(Array);

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect(fetchCall?.[0] as string).toContain('/api/v2/scheduled-maintenances.json');
  });

  it('maps a non-ok HTTP response onto the statuspage_unavailable contract (#32)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 503, headers: new Headers() }),
    );
    const service = new StatuspageService();
    const err = await service.fetchSummary(freshUrl()).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect((err as McpError).data).toMatchObject({
      reason: 'statuspage_unavailable',
      status: 503,
    });
    expect((err as McpError).message).toContain('HTTP 503');
  });

  it('maps an unreachable host onto the statuspage_unavailable contract (#32)', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValue(
          new TypeError('Unable to connect. Is the computer able to access the url?'),
        ),
    );
    const service = new StatuspageService();
    const err = await service.fetchSummary(freshUrl()).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect((err as McpError).data).toMatchObject({ reason: 'statuspage_unavailable' });
  });

  it('rejects a 200 carrying valid JSON that is not a Statuspage payload (#32)', async () => {
    // The shape httpbin.org/anything returns — parses fine, has none of the fields
    // buildVendorResult dereferences. Pre-gate this flowed through and TypeError'd
    // downstream on `data.components.filter`.
    const url = freshUrl();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: vi.fn().mockResolvedValue({ args: {}, headers: {}, method: 'GET', url }),
      }),
    );
    const service = new StatuspageService();
    const err = await service.fetchSummary(url).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect((err as McpError).data).toMatchObject({ reason: 'statuspage_unavailable' });
    expect((err as McpError).message).toContain('valid Atlassian Statuspage summary payload');
    // Names the URL, per the contract's recovery guidance.
    expect((err as McpError).message).toContain(url);
  });

  it('rejects a Statuspage payload whose status indicator is not a known value (#32)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: vi.fn().mockResolvedValue({
          ...MOCK_SUMMARY,
          status: { indicator: 'sideways', description: '' },
        }),
      }),
    );
    const service = new StatuspageService();
    const err = await service.fetchSummary(freshUrl()).catch((e: unknown) => e);

    expect((err as McpError).data).toMatchObject({ reason: 'statuspage_unavailable' });
  });

  it('does not cache a payload that failed the shape gate (#32)', async () => {
    const url = freshUrl();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: vi.fn().mockResolvedValue({ not: 'a statuspage' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const service = new StatuspageService();

    await expect(service.fetchSummary(url)).rejects.toThrow();
    await expect(service.fetchSummary(url)).rejects.toThrow();
    // A cached bad body would have made the second call a no-op.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('accepts a real payload carrying fields the schema does not name, unchanged (#32)', async () => {
    const withExtras = {
      ...MOCK_SUMMARY,
      page: { ...MOCK_SUMMARY.page, vendor_specific_flag: true },
      components: [
        {
          id: 'c1',
          name: 'API',
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
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: vi.fn().mockResolvedValue(withExtras),
      }),
    );
    const service = new StatuspageService();
    const { data } = await service.fetchSummary(freshUrl());

    // The gate validates and discards its parse output — the original body is returned,
    // so unknown vendor fields are not stripped.
    expect(data).toEqual(withExtras);
    expect(data.components[0]?.position).toBe(1);
  });

  /**
   * Statuspage reports `impact: 'maintenance'` on every scheduled-maintenance
   * record — a value outside the incident severity scale. Every other fixture
   * here leaves `scheduled_maintenances` empty, so the shape gate never met one.
   */
  it('accepts scheduled maintenances, whose impact is "maintenance" (#32)', async () => {
    const withMaintenance = {
      ...MOCK_SUMMARY,
      scheduled_maintenances: [
        {
          id: 'm1',
          name: 'Network maintenance — AMS',
          impact: 'maintenance',
          status: 'scheduled',
          created_at: '2026-07-20T00:00:00.000Z',
          scheduled_for: '2026-08-01T02:00:00.000Z',
          scheduled_until: '2026-08-01T06:00:00.000Z',
          incident_updates: [
            {
              id: 'u1',
              body: 'Scheduled maintenance window announced.',
              status: 'scheduled',
              created_at: '2026-07-20T00:00:00.000Z',
              display_at: '2026-07-20T00:00:00.000Z',
              affected_components: [{ name: 'Amsterdam, Netherlands - (AMS)' }],
            },
          ],
        },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: vi.fn().mockResolvedValue(withMaintenance),
      }),
    );
    const service = new StatuspageService();
    const { data } = await service.fetchSummary(freshUrl());

    expect(data.scheduled_maintenances?.[0]?.impact).toBe('maintenance');
  });

  /**
   * A page with nothing to report may omit `incidents` / `scheduled_maintenances`
   * entirely instead of sending `[]` (openai, clerk, cohere, brevo, elevenlabs,
   * planetscale all do). Requiring the keys would reject a healthy live page.
   */
  it('accepts a summary that omits the incident arrays entirely (#32)', async () => {
    const sparse = {
      page: MOCK_SUMMARY.page,
      status: MOCK_SUMMARY.status,
      components: [],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: vi.fn().mockResolvedValue(sparse),
      }),
    );
    const service = new StatuspageService();
    const { data } = await service.fetchSummary(freshUrl());

    expect(data.incidents).toBeUndefined();
    expect(data.scheduled_maintenances).toBeUndefined();
  });
});
