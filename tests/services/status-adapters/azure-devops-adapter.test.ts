/**
 * @fileoverview Tests for the Azure DevOps status adapter — health and feed parsing, the
 * mappings, the fetchers, and the result through devops_status_check and
 * devops_get_incidents. Fixtures are raw captures:
 * - azure-devops-health-20261014.json — live Health - Get response, 2026-10-14T18:30Z
 *   (overall advisory, "Service maintenance is in effect", only Core services / AU off healthy)
 * - azure-devops-health-docs-example.json — the all-healthy example response documented
 *   for Health - Get (api-version 7.1)
 * - azure-devops-rss-20261014.xml — live https://status.dev.azure.com/_rss, 2026-10-14T18:31Z
 *   (9 items: one Active, eight Resolved; not in date order)
 * @module tests/services/status-adapters/azure-devops-adapter.test
 */

import { readFileSync } from 'node:fs';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { devopsGetIncidents } from '@/mcp-server/tools/definitions/devops-get-incidents.tool.js';
import { devopsStatusCheck } from '@/mcp-server/tools/definitions/devops-status-check.tool.js';
import {
  type AzureDevOpsFeedItem,
  type AzureDevOpsTarget,
  fetchAzureDevOpsIncidents,
  fetchAzureDevOpsScheduledMaintenances,
  fetchAzureDevOpsSummary,
  mapAzureDevOpsIncidents,
  mapAzureDevOpsItem,
  mapAzureDevOpsSummary,
  parseAzureDevOpsFeed,
  parseAzureDevOpsHealth,
  updateTime,
} from '@/services/status-adapters/azure-devops-adapter.js';
import { initStatuspageService } from '@/services/statuspage/statuspage-service.js';
import { initVendorRegistryService } from '@/services/vendor-registry/vendor-registry-service.js';

/** Entries expire at once, so every fetch case reaches the fetch fake. */
vi.mock('@/config/server-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/server-config.js')>();
  return { getServerConfig: () => ({ ...actual.getServerConfig(), cacheTtlMs: -1 }) };
});

const HOST = 'status.dev.azure.com';
const HEALTH_URL = 'https://status.dev.azure.com/_apis/status/health?api-version=7.1-preview.1';
const FEED_URL = 'https://status.dev.azure.com/_rss';
const ACTIVE_TITLE = 'Higher latency and intermittent failures for the organizations in Australia';

const AZDO: AzureDevOpsTarget = {
  name: 'Azure DevOps',
  slug: 'azure-devops',
  url: 'https://status.dev.azure.com',
};

function fixture(name: string): string {
  return readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf-8');
}

const ADVISORY = () =>
  parseAzureDevOpsHealth(JSON.parse(fixture('azure-devops-health-20261014.json')));
const HEALTHY = () =>
  parseAzureDevOpsHealth(JSON.parse(fixture('azure-devops-health-docs-example.json')));
const FEED = () => parseAzureDevOpsFeed(fixture('azure-devops-rss-20261014.xml'));

/** A feed whose channel holds the given `<item>` bodies. */
function feed(...items: string[]): string {
  return `<rss version="2.0" xmlns:status="https://status.dev.azure.com/" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Azure DevOps - Recent Events</title>${items.map((i) => `<item>${i}</item>`).join('')}</channel></rss>`;
}

/** Entity-escape HTML the way the feed carries it inside `content:encoded`. */
const escaped = (html: string) =>
  html.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** A feed item with the given fields, its updates newest first as the feed lists them. */
function rssItem(fields: {
  event?: string;
  state?: string;
  geographies?: string[];
  pubDate?: string;
  sections?: string[];
}): string {
  const link = fields.event ? `https://status.dev.azure.com/_event/${fields.event}` : '';
  return (
    `<title>T${fields.event ?? ''}</title><link>${link}</link><guid isPermaLink="true">${link}</guid>` +
    `<pubDate>${fields.pubDate ?? ''}</pubDate>` +
    (fields.geographies ?? []).map((g) => `<status:geography>${g}</status:geography>`).join('') +
    `<status:state>${fields.state ?? 'Active'}</status:state>` +
    `<content:encoded>${escaped((fields.sections ?? []).join('\n<hr>\n'))}</content:encoded>`
  );
}

const section = (label: string, stamp: string, body: string) =>
  `<p><strong>${label}</strong><br>Engineer, ${stamp}</p>\n<p>${body}</p>`;

describe('parseAzureDevOpsHealth', () => {
  it('accepts the live and documented bodies', () => {
    expect(ADVISORY().status).toEqual({
      health: 'advisory',
      message: 'Service maintenance is in effect',
    });
    expect(ADVISORY().services).toHaveLength(7);
    expect(HEALTHY().status.health).toBe('healthy');
  });

  it.each([
    ['an empty object', {}],
    ['a body with no services', { status: { health: 'healthy' } }],
    ['a body with no status', { services: [] }],
    ['a status that is not an object', { status: 'healthy', services: [] }],
    ['services that are not a list', { status: {}, services: {} }],
    ['an array', []],
    ['null', null],
  ])('rejects %s as statuspage_unavailable', (_label, body) => {
    expect(() => parseAzureDevOpsHealth(body)).toThrow(
      expect.objectContaining({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: expect.objectContaining({ reason: 'statuspage_unavailable', url: HEALTH_URL }),
      }),
    );
  });
});

describe('parseAzureDevOpsFeed', () => {
  it('extracts all nine live items with event ids, state, and geographies', () => {
    const items = FEED();
    expect(items).toHaveLength(9);
    expect(items.map((i) => i.state).filter((s) => s === 'Active')).toHaveLength(1);
    const active = items.find((i) => i.state === 'Active');
    expect(active).toMatchObject({
      eventId: '876939898',
      title: ACTIVE_TITLE,
      pubDate: 'Thu, 08 Oct 2026 16:36:20 GMT',
      geographies: ['Australia'],
    });
    const everywhere = items.find((i) => i.eventId === '881067311');
    expect(everywhere?.geographies).toHaveLength(8);
  });

  it('splits content:encoded at <hr> into plain-text updates, newest first', () => {
    const item = FEED().find((i) => i.eventId === '876715443');
    expect(item?.updates).toHaveLength(5);
    expect(item?.updates[0]).toBe(
      [
        'Final update',
        'Merlyn Oppenheim, 9/30/2026 3:42:17 AM',
        "The issue is now fully mitigated. Our engineers will be investigating this further to learn from and reduce the risk of potential recurrences. We apologize for the impact this had on our customers. We've updated the duration of this incident to reflect the detected impact.",
      ].join('\n'),
    );
    expect(item?.updates[4]).toMatch(/^Initial communication\nAzure DevOps Incident Scout, /);
    for (const update of FEED().flatMap((i) => i.updates)) {
      expect(update).not.toMatch(/<p>|<strong>|<br>|<hr>|&lt;|&gt;|&amp;/);
    }
  });

  it('reads every spelling of <hr>, drops empty sections, and keeps CDATA bodies', () => {
    const [item] = parseAzureDevOpsFeed(
      feed(
        '<guid>https://status.dev.azure.com/_event/1</guid><content:encoded><![CDATA[' +
          '<p>c</p><HR /><p>b</p><hr class="x"><hr/><p>a</p><hr>  ]]></content:encoded>',
      ),
    );
    expect(item?.updates).toEqual(['c', 'b', 'a']);
  });

  it('falls back to <description> when an item has no content:encoded', () => {
    const [item] = parseAzureDevOpsFeed(
      feed(`<guid>x</guid><description>${escaped('<p>Only the latest</p>')}</description>`),
    );
    expect(item).toEqual({
      eventId: '',
      title: '',
      pubDate: '',
      state: '',
      geographies: [],
      updates: ['Only the latest'],
    });
  });

  it('reads the event number from <link> when <guid> is absent', () => {
    const [item] = parseAzureDevOpsFeed(
      feed('<link>https://status.dev.azure.com/_event/42</link>'),
    );
    expect(item?.eventId).toBe('42');
  });

  it.each([
    ['an HTML error page', '<!DOCTYPE html><html><body><h1>Service Unavailable</h1></body></html>'],
    ['a JSON body', '{"status":{"health":"healthy"}}'],
    ['a truncated feed', '<?xml version="1.0"?><rss version="2.0"><channel><title>Azure'],
    ['an empty body', ''],
  ])('rejects %s with no <channel> as statuspage_unavailable', (_label, body) => {
    expect(() => parseAzureDevOpsFeed(body)).toThrow(
      expect.objectContaining({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: expect.objectContaining({ reason: 'statuspage_unavailable', url: FEED_URL }),
      }),
    );
  });

  /**
   * Update bodies are upstream-sized. Each shape is timed at 5k and 320k characters (64×)
   * in this thread's CPU time: linear work grows about 64×, quadratic work about 4,096×.
   */
  describe('linear time', () => {
    const SMALL = 5_000;
    const LARGE = 320_000;
    const repeat = (unit: string, n: number) => unit.repeat(Math.ceil(n / unit.length));
    const shapes: [string, (n: number) => string][] = [
      ['<hr openers never closed', (n) => repeat('&lt;hr ', n)],
      ['bare <hr runs', (n) => repeat('&lt;hr', n)],
      ['one <hr with an attribute run to the end', (n) => `&lt;hr ${repeat('a', n)}`],
      ['empty sections', (n) => repeat('&lt;hr&gt;', n)],
      ['one-word sections', (n) => repeat('&lt;hr&gt;x', n)],
      ['near-stamps with no AM/PM', (n) => repeat('1/1/2026 1:01:01 ', n)],
    ];

    function cpuMicros(body: string): number {
      const xml = feed(`<content:encoded>${body}</content:encoded>`);
      parseAzureDevOpsFeed(xml);
      let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 3; i++) {
        const start = process.threadCpuUsage();
        const [item] = parseAzureDevOpsFeed(xml);
        for (const update of item?.updates ?? []) updateTime(update);
        const used = process.threadCpuUsage(start);
        best = Math.min(best, used.user + used.system);
      }
      return best;
    }

    it.each(shapes)('%s', (_label, build) => {
      const small = cpuMicros(build(SMALL));
      const large = cpuMicros(build(LARGE));
      // A floor on the small run keeps timer granularity from inflating the ratio.
      expect(large / Math.max(small, 200)).toBeLessThan(256);
      expect(large).toBeLessThan(1_000_000);
    });
  });
});

describe('updateTime', () => {
  it.each([
    ['Final update\nMerlyn Oppenheim, 9/30/2026 3:42:17 AM\nBody', '2026-09-30T03:42:17.000Z'],
    ['Update\nA, 10/8/2026 4:36:20 PM\nBody', '2026-10-08T16:36:20.000Z'],
    ['Update\nA, 1/2/2026 12:05:00 AM', '2026-01-02T00:05:00.000Z'],
    ['Update\nA, 1/2/2026 12:05:00 PM', '2026-01-02T12:05:00.000Z'],
    ['Update\nA, 1/2/2026 12:05:00pm', '2026-01-02T12:05:00.000Z'],
  ])('reads the header stamp of %j', (text, iso) => {
    expect(updateTime(text)).toBe(iso);
  });

  it.each([
    ['no stamp', 'Update\nA\nBody'],
    ['an impossible day', 'Update\nA, 2/30/2026 1:00:00 AM'],
    ['an impossible month', 'Update\nA, 13/1/2026 1:00:00 AM'],
    ['hour 0', 'Update\nA, 1/1/2026 0:00:00 AM'],
    ['a stamp only in the body', 'Update\nA\nResumed at 1/1/2026 1:00:00 AM'],
  ])('reads %s as no time', (_label, text) => {
    expect(updateTime(text)).toBe('');
  });
});

describe('mapAzureDevOpsSummary', () => {
  it('reads the live advisory: minor, its message, one degraded cell of 56', () => {
    const summary = mapAzureDevOpsSummary(ADVISORY(), FEED(), AZDO);
    expect(summary.status).toEqual({
      indicator: 'minor',
      description: 'Service maintenance is in effect',
    });
    expect(summary.components).toHaveLength(56);
    const degraded = summary.components.filter((c) => c.status !== 'operational');
    expect(degraded.map((c) => [c.name, c.status])).toEqual([
      ['Core services (Australia)', 'degraded_performance'],
    ]);
    expect(summary.components.filter((c) => c.status === 'operational')).toHaveLength(55);
    // Ungrouped: the geography name always rides with its service.
    expect(summary.components.every((c) => c.group === false && c.group_id === null)).toBe(true);
    expect(new Set(summary.components.map((c) => c.name)).size).toBe(56);
    expect(summary.components.at(-1)?.name).toBe('Other services (India)');
    expect(summary.page).toMatchObject({
      name: 'Azure DevOps',
      url: AZDO.url,
      updated_at: '2026-10-08T16:36:20.617Z',
    });
    expect(summary.scheduled_maintenances).toEqual([]);
  });

  it('lists only the Active item as an open incident', () => {
    const summary = mapAzureDevOpsSummary(ADVISORY(), FEED(), AZDO);
    expect(summary.incidents?.map((i) => [i.name, i.status, i.resolved_at])).toEqual([
      [ACTIVE_TITLE, 'investigating', null],
    ]);
  });

  it('reads the documented example as none with no degraded components', () => {
    const summary = mapAzureDevOpsSummary(HEALTHY(), [], AZDO);
    expect(summary.status).toEqual({
      indicator: 'none',
      description: 'Everything is looking good',
    });
    expect(summary.components).toHaveLength(56);
    expect(summary.components.filter((c) => c.status !== 'operational')).toEqual([]);
    expect(summary.incidents).toEqual([]);
  });

  it.each([
    ['healthy', 'none', 'operational'],
    ['advisory', 'minor', 'degraded_performance'],
    ['degraded', 'major', 'partial_outage'],
    ['unhealthy', 'major', 'major_outage'],
    ['unknown', 'minor', 'degraded_performance'],
    ['a value outside the enum', 'minor', 'degraded_performance'],
  ])('maps %s to indicator %s and component status %s', (health, indicator, status) => {
    const summary = mapAzureDevOpsSummary(
      {
        status: { health, message: 'm' },
        services: [{ id: 'Boards', geographies: [{ id: 'EU', name: 'Europe', health }] }],
      },
      [],
      AZDO,
    );
    expect(summary.status.indicator).toBe(indicator);
    expect(summary.components.map((c) => [c.name, c.status])).toEqual([
      ['Boards (Europe)', status],
    ]);
  });

  it('describes a body with no message by its overall health', () => {
    const summary = mapAzureDevOpsSummary(
      { status: { health: 'degraded' }, services: [] },
      [],
      AZDO,
    );
    expect(summary.status).toEqual({ indicator: 'major', description: 'Overall health: degraded' });
  });

  it('skips cells with nothing to name them by and services with no geography list', () => {
    const summary = mapAzureDevOpsSummary(
      {
        status: { health: 'healthy' },
        services: [
          { id: 'Repos', geographies: [{ id: 'US', health: 'healthy' }, { health: 'degraded' }] },
          { geographies: [{ id: 'UK', name: 'United Kingdom', health: 'unhealthy' }] },
          { id: 'Pipelines' },
        ],
      },
      [],
      AZDO,
    );
    expect(summary.components.map((c) => [c.id, c.name, c.position])).toEqual([
      ['Repos/US', 'Repos (US)', 0],
    ]);
  });
});

describe('mapAzureDevOpsIncidents / mapAzureDevOpsItem', () => {
  it('maps all nine live items, newest first by start', () => {
    const { incidents } = mapAzureDevOpsIncidents(FEED(), AZDO);
    expect(incidents).toHaveLength(9);
    const starts = incidents.map((i) => Date.parse(i.created_at));
    expect(starts).toEqual([...starts].sort((a, b) => b - a));
    expect(incidents[0]?.name).toBe('Availability Degradation in East US');
    expect(incidents.every((i) => i.impact === 'minor')).toBe(true);
  });

  it('keeps the Active item open and resolves the rest at pubDate', () => {
    const { incidents } = mapAzureDevOpsIncidents(FEED(), AZDO);
    const active = incidents.filter((i) => i.status !== 'resolved');
    expect(active.map((i) => [i.id, i.status, i.resolved_at])).toEqual([
      ['876939898', 'investigating', null],
    ]);
    const east = incidents.find((i) => i.id === '885607752');
    expect(east).toMatchObject({
      status: 'resolved',
      started_at: '2026-10-14T08:27:01.000Z',
      created_at: '2026-10-14T08:27:01.000Z',
      resolved_at: '2026-10-14T10:14:38.000Z',
      shortlink: 'https://status.dev.azure.com/_event/885607752',
      page_id: 'azure-devops',
    });
    expect(incidents.filter((i) => i.status === 'resolved')).toHaveLength(8);
    for (const inc of incidents.filter((i) => i.status === 'resolved')) {
      // The final update's stamp is the item's pubDate.
      expect(inc.resolved_at, inc.id).toBe(inc.incident_updates.at(-1)?.created_at);
    }
  });

  it('lists updates oldest first, the latest carrying the status and the geographies', () => {
    const east = mapAzureDevOpsIncidents(FEED(), AZDO).incidents.find((i) => i.id === '885607752');
    expect(east?.incident_updates.map((u) => [u.status, u.created_at])).toEqual([
      ['investigating', '2026-10-14T08:27:01.000Z'],
      ['investigating', '2026-10-14T09:09:57.000Z'],
      ['investigating', '2026-10-14T10:08:14.000Z'],
      ['resolved', '2026-10-14T10:14:38.000Z'],
    ]);
    expect(east?.incident_updates.slice(0, 3).every((u) => u.affected_components === null)).toBe(
      true,
    );
    expect(east?.incident_updates.at(-1)?.affected_components).toEqual([
      { code: 'United States', name: 'United States', new_status: '', old_status: '' },
    ]);
    expect(east?.incident_updates[0]?.body).toMatch(/^Initial communication\n/);
  });

  it('starts an item at its oldest stamp even when sections arrive out of order', () => {
    const [item] = parseAzureDevOpsFeed(
      feed(
        rssItem({
          event: '7',
          state: 'Resolved',
          pubDate: 'Mon, 12 Oct 2026 12:00:00 GMT',
          sections: [
            section('Update', '10/12/2026 9:00:00 AM', 'middle'),
            section('Final update', '10/12/2026 12:00:00 PM', 'end'),
            section('Initial communication', '10/12/2026 8:00:00 AM', 'start'),
          ],
        }),
      ),
    );
    const inc = mapAzureDevOpsItem(item!, AZDO);
    expect(inc.started_at).toBe('2026-10-12T08:00:00.000Z');
    expect(inc.resolved_at).toBe('2026-10-12T12:00:00.000Z');
  });

  it('starts an item with no readable stamp at null, created at pubDate', () => {
    const [item] = parseAzureDevOpsFeed(
      feed(
        rssItem({
          event: '9',
          pubDate: 'Mon, 12 Oct 2026 12:00:00 GMT',
          sections: ['<p>No header here</p>'],
        }),
      ),
    );
    const inc = mapAzureDevOpsItem(item!, AZDO);
    expect(inc).toMatchObject({
      status: 'investigating',
      started_at: null,
      created_at: '2026-10-12T12:00:00.000Z',
      resolved_at: null,
    });
    expect(inc.incident_updates.map((u) => [u.body, u.created_at])).toEqual([
      ['No header here', ''],
    ]);
  });

  it('does not crash on a sparse item with omitted fields', () => {
    const sparse: AzureDevOpsFeedItem = {
      eventId: '',
      title: '',
      pubDate: 'not a date',
      state: 'Resolved',
      geographies: [],
      updates: [],
    };
    const inc = mapAzureDevOpsItem(sparse, AZDO);
    expect(inc).toMatchObject({
      id: 'unknown',
      name: 'Unnamed incident',
      status: 'resolved',
      created_at: '',
      started_at: null,
      resolved_at: null,
      shortlink: null,
      incident_updates: [],
    });
  });
});

describe('fetchers', () => {
  const http = createFetchMock();
  const isHealth = (req: Request) => {
    const url = new URL(req.url);
    return url.hostname === HOST && url.pathname === '/_apis/status/health';
  };
  const isFeed = (req: Request) => {
    const url = new URL(req.url);
    return url.hostname === HOST && url.pathname === '/_rss';
  };

  beforeEach(() => {
    http.reset();
    http.install();
  });

  afterEach(() => {
    http.restore();
  });

  function routeLive() {
    http.route(
      {
        match: isHealth,
        respond: () => Response.json(JSON.parse(fixture('azure-devops-health-20261014.json'))),
      },
      { match: isFeed, respond: () => new Response(fixture('azure-devops-rss-20261014.xml')) },
    );
  }

  it('fetchAzureDevOpsSummary reads the health endpoint and the feed', async () => {
    routeLive();
    const { data, cached } = await fetchAzureDevOpsSummary(AZDO);
    expect(data.status.indicator).toBe('minor');
    expect(data.incidents?.map((i) => i.name)).toEqual([ACTIVE_TITLE]);
    expect(cached).toBe(false);
    expect(http.calls.map((c) => c.request.url).sort()).toEqual([HEALTH_URL, FEED_URL]);
  });

  it('fetchAzureDevOpsIncidents reads only the feed', async () => {
    routeLive();
    const { data } = await fetchAzureDevOpsIncidents(AZDO);
    expect(data.incidents).toHaveLength(9);
    expect(http.calls.map((c) => c.request.url)).toEqual([FEED_URL]);
  });

  it('fetchAzureDevOpsScheduledMaintenances returns empty without a network call', async () => {
    const { data } = await fetchAzureDevOpsScheduledMaintenances(AZDO);
    expect(data.scheduled_maintenances).toEqual([]);
    expect(http.calls).toHaveLength(0);
  });

  it.each([
    ['a health body without status and services', { services: undefined }, 'services list'],
    ['a feed body without <channel>', 'feed', '<channel>'],
  ])('fails the summary on %s as statuspage_unavailable', async (_label, which, message) => {
    http.route(
      {
        match: isHealth,
        respond: () =>
          which === 'feed'
            ? Response.json(JSON.parse(fixture('azure-devops-health-20261014.json')))
            : Response.json({ lastUpdated: '2026-10-14T00:00:00Z' }),
      },
      {
        match: isFeed,
        respond: () =>
          which === 'feed'
            ? new Response('<html><body>Sign in</body></html>')
            : new Response(fixture('azure-devops-rss-20261014.xml')),
      },
    );
    const err = await fetchAzureDevOpsSummary(AZDO).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect((err as McpError).data).toMatchObject({ reason: 'statuspage_unavailable' });
    expect((err as McpError).message).toContain(message);
  });

  it('fails on a health body that is not JSON', async () => {
    http.route(
      { match: isHealth, respond: () => new Response('<html>maintenance</html>') },
      { match: isFeed, respond: () => new Response(fixture('azure-devops-rss-20261014.xml')) },
    );
    const err = await fetchAzureDevOpsSummary(AZDO).catch((e: unknown) => e);
    expect((err as McpError).data).toMatchObject({
      reason: 'statuspage_unavailable',
      url: HEALTH_URL,
    });
  });

  it('a non-2xx from the feed throws ServiceUnavailable', async () => {
    http.route({ match: isFeed, respond: () => new Response(null, { status: 503 }) });
    const err = await fetchAzureDevOpsIncidents(AZDO).catch((e: unknown) => e);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect((err as McpError).message).toContain('HTTP 503');
  });
});

/**
 * The 2026-10-14 pair through the registry entry and the real tools, fetch faked at the
 * HTTP boundary only.
 */
describe('through the tools', () => {
  const http = createFetchMock();

  beforeAll(() => {
    initVendorRegistryService();
    initStatuspageService();
  });

  beforeEach(() => {
    http.reset();
    http.install();
    http.route(
      {
        match: (req) =>
          new URL(req.url).hostname === HOST &&
          new URL(req.url).pathname === '/_apis/status/health',
        respond: () => Response.json(JSON.parse(fixture('azure-devops-health-20261014.json'))),
      },
      {
        match: (req) => new URL(req.url).hostname === HOST && new URL(req.url).pathname === '/_rss',
        respond: () => new Response(fixture('azure-devops-rss-20261014.xml')),
      },
    );
  });

  afterEach(() => {
    http.restore();
  });

  it('devops_status_check gives one suggestion naming the cell and the active title', async () => {
    const call = await runToolContract(devopsStatusCheck, { vendors: ['azure-devops'] });
    expect(call.isError).toBeFalsy();
    const out = devopsStatusCheck.output.parse(call.structuredContent);
    expect(out.results[0]).toMatchObject({
      vendor: 'azure-devops',
      name: 'Azure DevOps',
      indicator: 'minor',
      description: 'Service maintenance is in effect',
      degraded_components: [
        { name: 'Core services (Australia)', group: null, status: 'degraded_performance' },
      ],
    });
    expect(out.results[0]?.active_incidents.map((i) => i.name)).toEqual([ACTIVE_TITLE]);
    expect(out.summary).toMatchObject({ total: 1, degraded: 1 });
    expect(out.nextToolSuggestions).toEqual([
      {
        toolName: 'devops_suggest_action',
        reason: expect.any(String),
        args: {
          vendor: 'azure-devops',
          vendor_indicator: 'minor',
          affected_components: ['Core services (Australia)'],
          incident_summary: ACTIVE_TITLE,
        },
      },
    ]);
    const text = call.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    expect(text).toContain('Core services (Australia)');
    expect(text).toContain(ACTIVE_TITLE);
  });

  it('devops_get_incidents filter "scheduled" is empty with the no-maintenance notice', async () => {
    const call = await runToolContract(devopsGetIncidents, {
      vendor: 'azure-devops',
      filter: 'scheduled',
    });
    expect(call.isError).toBeFalsy();
    const out = call.structuredContent as { incidents: unknown[]; notice?: string };
    expect(out.incidents).toEqual([]);
    expect(out.notice).toContain('publishes no scheduled-maintenance feed');
    expect(http.calls).toHaveLength(0);
  });

  it('devops_get_incidents filter "resolved" lists the eight resolved items', async () => {
    const call = await runToolContract(devopsGetIncidents, {
      vendor: 'azure-devops',
      filter: 'resolved',
    });
    const out = call.structuredContent as { incidents: { id: string; status: string }[] };
    expect(out.incidents).toHaveLength(8);
    expect(out.incidents.every((i) => i.status === 'resolved')).toBe(true);
  });
});
