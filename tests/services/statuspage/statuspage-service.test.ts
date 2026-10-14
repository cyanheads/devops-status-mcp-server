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
import type {
  StatuspageHistoryResponse,
  StatuspageIncidentsResponse,
  StatuspageSummaryResponse,
} from '@/services/statuspage/types.js';

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

    it('requests the given history page and returns the recorded body, messages as plain text (#63)', async () => {
      const base = freshUrl();
      const body = historyFixture('github-history-p2.json') as StatuspageHistoryResponse;
      http.route({ match: `${base}/history.json?page=2`, respond: () => Response.json(body) });

      const { data, cached } = await new StatuspageService().fetchHistory(base, 2);

      expect(http.calls.map((c) => c.request.url)).toEqual([`${base}/history.json?page=2`]);
      expect(cached).toBe(false);
      // Only `message` changes: every other recorded field comes back as served.
      const withoutMessages = (h: StatuspageHistoryResponse) => ({
        ...h,
        months: h.months.map((m) => ({
          ...m,
          incidents: m.incidents.map(({ message: _message, ...rest }) => rest),
        })),
      });
      expect(withoutMessages(data)).toEqual(withoutMessages(body));
      const messages = data.months.flatMap((m) => m.incidents.map((r) => r.message));
      expect(messages.some((m) => m.includes('<'))).toBe(false);
      expect(data.months[0]!.incidents.find((r) => r.code === 'mc4yx9f8x1hk')!.message).toBe(
        [
          'Between 15:19 UTC and 15:49 UTC on June 30, 2026, users were unable to complete the signup flow for GitHub.com/signup. Approximately 62% of new user signups failed for about 30 minutes during this window.',
          'This was caused by a configuration change to the signup flow that unintentionally blocked users from completing signup.',
          'We mitigated the incident by reverting the change, which restored successful signups. To reduce the likelihood and impact of similar issues, we are adopting staged, incremental rollouts for changes on the signup path, improving our ability to test these changes before they reach production, and adding checks to verify signup health before and during any change that affects this flow.',
        ].join('\n'),
      );
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

  /**
   * Statuspage bodies are HTML on many pages (`<p>`, `<br />`, `<a href>`), mixed with
   * text `<` that is not markup. Each v2 endpoint converts every update body once, in
   * its parse step, so the cached payload already holds plain text.
   */
  describe('update bodies as plain text (#63)', () => {
    function fixture(name: string): unknown {
      return JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf-8'));
    }
    const bodies = (incidents: { incident_updates: { body: string }[] }[] | undefined) =>
      (incidents ?? []).flatMap((i) => i.incident_updates.map((u) => u.body));

    /** Recorded from linode's page (incident rqk60hj08b6z). */
    const LINODE_BODY =
      'At this time we have been able to correct the issue affecting the Cloud Manager logins. We will be monitoring this to ensure that the service remains stable. If you are still experiencing issues and unable to receive verification codes please <a href="https://cloud.linode.com/support/tickets">open a Support ticket</a>, call us at 855-454-6633 (+1-609-380-7100 Intl.), or send an email to support@linode.com.';

    const incident = (id: string, body: string, impact = 'minor') => ({
      id,
      name: `Incident ${id}`,
      impact,
      status: 'investigating',
      created_at: '2026-10-09T05:23:47.049Z',
      incident_updates: [
        {
          id: `${id}-u`,
          body,
          status: 'investigating',
          created_at: '2026-10-09T05:23:47.049Z',
          display_at: '2026-10-09T05:23:47.049Z',
          affected_components: null,
        },
      ],
    });

    it('fetchIncidents: GitHub bodies lose their markup and keep a text "(<1%)"', async () => {
      const body = fixture('github-incidents.json') as StatuspageIncidentsResponse;
      expect(bodies(body.incidents).filter((b) => b.includes('<br />')).length).toBeGreaterThan(30);
      http.route(endpoint('incidents', body));

      const { data } = await new StatuspageService().fetchIncidents(freshUrl());

      expect(bodies(data.incidents).some((b) => /<br|<p>|<\/?strong>/.test(b))).toBe(false);
      const billing = data.incidents
        .find((i) => i.id === '5bn0vk444m1w')!
        .incident_updates.find((u) => u.id === 'j71pnfjbbk0k')!.body;
      const lines = billing.split('\n');
      expect(lines).toHaveLength(3);
      expect(lines[0]).toMatch(/a small number of customers \(<1%\)\.$/);
      expect(lines[1]).toMatch(/^This was caused by a concentrated workload/);
      // Unrelated fields come back as served.
      expect(data.incidents.map((i) => i.id)).toEqual(body.incidents.map((i) => i.id));
    });

    it('fetchSummary converts incident and maintenance bodies, a link as its text and URL', async () => {
      http.route(
        endpoint('summary', {
          ...MOCK_SUMMARY,
          incidents: [incident('rqk60hj08b6z', LINODE_BODY)],
          scheduled_maintenances: [
            {
              ...incident(
                'm1',
                '<p>Window one.&nbsp;</p><p>AT&amp;T handsets <1MB.</p>',
                'maintenance',
              ),
              scheduled_for: '2026-10-14T20:00:00Z',
              scheduled_until: '2026-10-14T23:00:00Z',
            },
          ],
        }),
      );

      const { data } = await new StatuspageService().fetchSummary(freshUrl());

      expect(bodies(data.incidents)).toEqual([
        'At this time we have been able to correct the issue affecting the Cloud Manager logins. We will be monitoring this to ensure that the service remains stable. If you are still experiencing issues and unable to receive verification codes please open a Support ticket (https://cloud.linode.com/support/tickets), call us at 855-454-6633 (+1-609-380-7100 Intl.), or send an email to support@linode.com.',
      ]);
      expect(bodies(data.scheduled_maintenances)).toEqual(['Window one.\nAT&T handsets <1MB.']);
    });

    it('fetchScheduledMaintenances converts the recorded Twilio <p> bodies', async () => {
      http.route(endpoint('scheduled-maintenances', fixture('twilio-scheduled-maintenances.json')));

      const { data } = await new StatuspageService().fetchScheduledMaintenances(freshUrl());

      const all = bodies(data.scheduled_maintenances);
      expect(all.some((b) => b.includes('<p>'))).toBe(false);
      const att = all.find((b) => b.includes('AT&T United States'))!;
      expect(att.split('\n')).toHaveLength(2);
      expect(att).toMatch(/^Our MMS carrier partner in the United States/);
    });

    it('converts once: a cached read returns the stored text, a decoded reference undecoded again', async () => {
      const url = freshUrl();
      http.route(
        endpoint('incidents', {
          page: MOCK_SUMMARY.page,
          incidents: [incident('i1', '<p>Literal &amp;lt;b&amp;gt; stays text.</p>')],
        }),
      );
      const service = new StatuspageService();

      const first = await service.fetchIncidents(url);
      const second = await service.fetchIncidents(url);

      expect(second.cached).toBe(true);
      expect(http.calls).toHaveLength(1);
      for (const { data } of [first, second]) {
        expect(bodies(data.incidents)).toEqual(['Literal &lt;b&gt; stays text.']);
      }
    });

    it('passes a body with no HTML element tag and no character reference through unchanged', async () => {
      const plain = 'Line one\n\n  - indented <FUNCTIONALITY IMPACTED> for <SOME/ALL> users';
      http.route(
        endpoint('incidents', { page: MOCK_SUMMARY.page, incidents: [incident('i2', plain)] }),
      );

      const { data } = await new StatuspageService().fetchIncidents(freshUrl());

      expect(bodies(data.incidents)).toEqual([plain]);
    });
  });
});
