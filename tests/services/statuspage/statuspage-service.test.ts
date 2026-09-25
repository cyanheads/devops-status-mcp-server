/**
 * @fileoverview Tests for the StatuspageService fetch and caching logic.
 * @module tests/services/statuspage/statuspage-service.test
 */

import { readFileSync } from 'node:fs';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

/**
 * Strict upstream fake: a request to an endpoint no test routed throws instead of
 * reaching the network, so the route set doubles as the assertion that the service
 * called the endpoint it was supposed to.
 */
const http = createFetchMock();

/** Answer `/api/v2/<endpoint>.json` with `body`, as a real Response. */
function endpoint(name: string, body: unknown) {
  return {
    match: new RegExp(`/api/v2/${name}\\.json$`),
    respond: () => Response.json(body),
  };
}

beforeEach(() => {
  initStatuspageService();
  http.reset();
  http.install();
});

afterEach(() => {
  http.restore();
});

describe('StatuspageService', () => {
  it('init/accessor pattern works', () => {
    expect(getStatuspageService()).toBeDefined();
  });

  it('fetchSummary returns data from fetch', async () => {
    http.route(endpoint('summary', MOCK_SUMMARY));
    const service = getStatuspageService();
    const { data, cached } = await service.fetchSummary(freshUrl());
    expect(data.status.indicator).toBe('none');
    expect(cached).toBe(false);
  });

  it('fetchSummary returns cached result on second call', async () => {
    http.route(endpoint('summary', MOCK_SUMMARY));
    const service = getStatuspageService();
    const url = freshUrl();
    await service.fetchSummary(url);
    const { cached } = await service.fetchSummary(url);
    // Second call should hit cache (same URL)
    expect(cached).toBe(true);
    // fetch should have been called only once for this URL
    expect(http.calls).toHaveLength(1);
  });

  it('fetchIncidents calls the incidents endpoint', async () => {
    http.route(endpoint('incidents', { page: MOCK_SUMMARY.page, incidents: [] }));

    const service = new StatuspageService();
    const { data } = await service.fetchIncidents(freshUrl());
    expect(data.incidents).toBeInstanceOf(Array);
    expect(http.calls[0]?.request.url).toContain('/api/v2/incidents.json');
  });

  it('fetchScheduledMaintenances calls the scheduled-maintenances endpoint', async () => {
    http.route(
      endpoint('scheduled-maintenances', {
        page: MOCK_SUMMARY.page,
        scheduled_maintenances: [],
      }),
    );

    const service = new StatuspageService();
    const { data } = await service.fetchScheduledMaintenances(freshUrl());
    expect(data.scheduled_maintenances).toBeInstanceOf(Array);
    expect(http.calls[0]?.request.url).toContain('/api/v2/scheduled-maintenances.json');
  });

  it('maps a non-ok HTTP response onto the statuspage_unavailable contract (#32)', async () => {
    http.route({
      match: /\/api\/v2\/summary\.json$/,
      respond: () => new Response(null, { status: 503 }),
    });
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
    http.route({
      match: /\/api\/v2\/summary\.json$/,
      respond: () => {
        throw new TypeError('Unable to connect. Is the computer able to access the url?');
      },
    });
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
    http.route(endpoint('summary', { args: {}, headers: {}, method: 'GET', url }));
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
    http.route(
      endpoint('summary', {
        ...MOCK_SUMMARY,
        status: { indicator: 'sideways', description: '' },
      }),
    );
    const service = new StatuspageService();
    const err = await service.fetchSummary(freshUrl()).catch((e: unknown) => e);

    expect((err as McpError).data).toMatchObject({ reason: 'statuspage_unavailable' });
  });

  it('does not cache a payload that failed the shape gate (#32)', async () => {
    const url = freshUrl();
    http.route(endpoint('summary', { not: 'a statuspage' }));
    const service = new StatuspageService();

    await expect(service.fetchSummary(url)).rejects.toThrow();
    await expect(service.fetchSummary(url)).rejects.toThrow();
    // A cached bad body would have made the second call a no-op.
    expect(http.calls).toHaveLength(2);
  });

  /**
   * A body that is not JSON at all reaches the same contract entry as a body that is
   * JSON of the wrong shape, and neither echoes the parser's own diagnostic.
   */
  it('maps a body that is not JSON onto the same contract (#32)', async () => {
    http.route({
      match: /\/api\/v2\/summary\.json$/,
      respond: () => new Response('<html>maintenance</html>', { status: 200 }),
    });
    const service = new StatuspageService();
    const err = await service.fetchSummary(freshUrl()).catch((e: unknown) => e);

    expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect((err as McpError).data).toMatchObject({ reason: 'statuspage_unavailable' });
    expect((err as McpError).message).toContain('could not be parsed as JSON');
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
    http.route(endpoint('summary', withExtras));
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
    http.route(endpoint('summary', withMaintenance));
    const service = new StatuspageService();
    const { data } = await service.fetchSummary(freshUrl());

    expect(data.scheduled_maintenances?.[0]?.impact).toBe('maintenance');
  });

  /**
   * A page publishes `status.indicator: "maintenance"` for the duration of an open
   * window (verified live on brevo). It sits outside the severity ladder, and
   * rejecting it failed the entire payload — reporting a well-formed, reachable
   * page as not a Statuspage at all.
   */
  it('accepts a summary whose status indicator is "maintenance" (#44)', async () => {
    http.route(
      endpoint('summary', {
        ...MOCK_SUMMARY,
        status: { indicator: 'maintenance', description: 'Under Maintenance' },
      }),
    );
    const service = new StatuspageService();
    const { data } = await service.fetchSummary(freshUrl());

    expect(data.status.indicator).toBe('maintenance');
    expect(data.status.description).toBe('Under Maintenance');
  });

  /**
   * The quarterly history archive is paged by `?page=N` and served beside the v2
   * API, not under it. Its body is gated like every v2 payload.
   */
  describe('fetchHistory', () => {
    function historyFixture(name: string): unknown {
      return JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf-8'));
    }

    it('requests the given history page and returns the recorded body unchanged', async () => {
      const base = freshUrl();
      const body = historyFixture('github-history-p2.json');
      http.route({ match: `${base}/history.json?page=2`, respond: () => Response.json(body) });

      const { data, cached } = await new StatuspageService().fetchHistory(base, 2);

      expect(http.calls.map((c) => c.request.url)).toEqual([`${base}/history.json?page=2`]);
      expect(cached).toBe(false);
      expect(data).toEqual(body);
      expect(data.start_time).toBe('2026-04-01T00:00:00Z');
      expect(data.months.map((m) => `${m.name} ${m.year}`)).toEqual([
        'June 2026',
        'May 2026',
        'April 2026',
      ]);
    });

    it('rejects a 200 whose body is not a history payload, naming the endpoint', async () => {
      const base = freshUrl();
      http.route({
        match: `${base}/history.json?page=1`,
        respond: () => Response.json({ page: { name: 'X' }, incidents: [] }),
      });

      const err = await new StatuspageService().fetchHistory(base, 1).catch((e: unknown) => e);

      expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect((err as McpError).data).toMatchObject({ reason: 'statuspage_unavailable' });
      expect((err as McpError).message).toContain('history payload');
    });

    it('rejects a history record whose impact is off the known scale', async () => {
      const base = freshUrl();
      const body = historyFixture('github-history-p2.json') as {
        months: { incidents: { impact: string }[] }[];
      };
      body.months[0]!.incidents[0]!.impact = 'catastrophic';
      http.route({ match: `${base}/history.json?page=1`, respond: () => Response.json(body) });

      await expect(new StatuspageService().fetchHistory(base, 1)).rejects.toMatchObject({
        data: { reason: 'statuspage_unavailable' },
      });
    });

    it('surfaces a 404 with its status, which callers read as "no archive"', async () => {
      const base = freshUrl();
      http.route({
        match: `${base}/history.json?page=1`,
        respond: () =>
          Response.json(
            { errors: [{ code: 1001, message: 'no matching operation was found' }] },
            { status: 404 },
          ),
      });

      const err = await new StatuspageService().fetchHistory(base, 1).catch((e: unknown) => e);

      expect((err as McpError).data).toMatchObject({ status: 404 });
    });
  });

  /**
   * A page with nothing to report may omit `incidents` / `scheduled_maintenances`
   * entirely instead of sending `[]` (openai, clerk, cohere, brevo, elevenlabs,
   * planetscale all do). Requiring the keys would reject a healthy live page.
   */
  it('accepts a summary that omits the incident arrays entirely (#32)', async () => {
    http.route(
      endpoint('summary', {
        page: MOCK_SUMMARY.page,
        status: MOCK_SUMMARY.status,
        components: [],
      }),
    );
    const service = new StatuspageService();
    const { data } = await service.fetchSummary(freshUrl());

    expect(data.incidents).toBeUndefined();
    expect(data.scheduled_maintenances).toBeUndefined();
  });
});
