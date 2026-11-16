/**
 * @fileoverview Tests for the status dispatch layer — each api_type routes to
 * its adapter's endpoint, and statuspage vendors keep hitting the Statuspage
 * v2 paths unchanged (regression).
 * @module tests/services/status-adapters/status-dispatch.test
 */

import { readFileSync } from 'node:fs';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VENDOR_REGISTRY } from '@/data/vendor-registry.js';
import {
  backendHistory,
  fetchVendorIncidents,
  fetchVendorScheduledMaintenances,
  fetchVendorSummary,
  rawTargetRejection,
  vendorHistory,
} from '@/services/status-adapters/status-dispatch.js';
import { initStatuspageService } from '@/services/statuspage/statuspage-service.js';
import {
  getVendorRegistryService,
  initVendorRegistryService,
  type ResolvedVendor,
} from '@/services/vendor-registry/vendor-registry-service.js';
import { clearFetchCache, MAX_RESPONSE_BODY_BYTES } from '@/utils/cached-fetch.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    cacheTtlMs: -1, // entries expire immediately — each dispatch call must hit the (stubbed) network
    fetchTimeoutMs: 5000,
    certTimeoutMs: 5000,
    dnsTimeoutMs: 3000,
    // Every redirect hop is re-checked by the SSRF guard; off, so a hop resolves no DNS.
    allowPrivateTargets: true,
  }),
}));

const STATUSPAGE_BODY = {
  page: { id: 'p', name: 'X', time_zone: 'UTC', updated_at: '', url: '' },
  status: { indicator: 'none', description: 'All Systems Operational' },
  components: [],
  incidents: [],
  scheduled_maintenances: [],
};

const STATUSIO_BODY = {
  result: {
    status_overall: { updated: '', status: 'Operational', status_code: 100 },
    status: [],
    incidents: [],
    maintenance: { active: [], upcoming: [] },
  },
};

const FIREHYDRANT_BODY = {
  components: [],
  conditions: {},
  incidents: [],
};

/** The nine Datadog site pages, each read through its own {page}/config.json. */
const DATADOG_PAGES = [
  ['datadog', 'https://status.datadoghq.com'],
  ['datadog-us3', 'https://status.us3.datadoghq.com'],
  ['datadog-us5', 'https://status.us5.datadoghq.com'],
  ['datadog-eu1', 'https://status.datadoghq.eu'],
  ['datadog-uk1', 'https://status.uk1.datadoghq.com'],
  ['datadog-ap1', 'https://status.ap1.datadoghq.com'],
  ['datadog-ap2', 'https://status.ap2.datadoghq.com'],
  ['datadog-us1-fed', 'https://status.ddog-gov.com'],
  ['datadog-us2-fed', 'https://status.us2.ddog-gov.com'],
] as const;
const DATADOG_HOSTS = new Set<string>(DATADOG_PAGES.map(([, url]) => new URL(url).hostname));

/** A Datadog status document with nothing on it. */
const DATADOG_BODY = { components: [], incidents: [], maintenances: null };

/** The eight incident.io-hosted pages, each read through its own {page}/proxy/{host} feed. */
const INCIDENTIO_PAGES = [
  ['fly-io', 'https://status.flyio.net'],
  ['planetscale', 'https://www.planetscalestatus.com'],
  ['supabase', 'https://status.supabase.com'],
  ['brevo', 'https://status.brevo.com'],
  ['clerk', 'https://status.clerk.com'],
  ['openai', 'https://status.openai.com'],
  ['elevenlabs', 'https://status.elevenlabs.io'],
  ['cohere', 'https://status.cohere.com'],
] as const;

/** An incident.io page summary with nothing on it, and its empty incident list. */
const INCIDENTIO_SUMMARY_BODY = {
  summary: {
    name: 'OpenAI',
    structure: { items: [] },
    affected_components: [],
    ongoing_incidents: [],
    scheduled_maintenances: [],
  },
};
const INCIDENTIO_LIST_BODY = { incidents: [] };

/** Microsoft's documented all-healthy Health - Get example. */
const AZURE_DEVOPS_HEALTH_BODY: unknown = JSON.parse(
  readFileSync(new URL('fixtures/azure-devops-health-docs-example.json', import.meta.url), 'utf-8'),
);

function lastUrl(): string {
  const calls = vi.mocked(fetch).mock.calls;
  return String(calls[calls.length - 1]?.[0]);
}

beforeEach(() => {
  initVendorRegistryService();
  initStatuspageService();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      const { hostname } = new URL(u);
      const body =
        hostname === 'status.dev.azure.com'
          ? AZURE_DEVOPS_HEALTH_BODY // its _rss feed reads the empty channel below
          : hostname === 'status-api.hostedstatus.com'
            ? STATUSIO_BODY
            : u.includes('/data/payload.json')
              ? FIREHYDRANT_BODY
              : hostname === 'status.cloud.google.com'
                ? [] // the Google Cloud feed is a bare incident array
                : u.includes('/api/v2.0.0/history')
                  ? []
                  : u.includes('/api/v2.0.0/')
                    ? { status: 'ok', active_incidents: [] }
                    : DATADOG_HOSTS.has(hostname)
                      ? DATADOG_BODY
                      : u.includes('/proxy/')
                        ? u.endsWith('/incidents')
                          ? INCIDENTIO_LIST_BODY
                          : INCIDENTIO_SUMMARY_BODY
                        : STATUSPAGE_BODY;
      return Promise.resolve({
        ok: true,
        json: vi.fn().mockResolvedValue(body),
        // The Azure and Azure DevOps feeds are RSS; an empty channel is the all-clear shape.
        text: vi
          .fn()
          .mockResolvedValue(
            '<rss version="2.0"><channel><title>Azure Status</title></channel></rss>',
          ),
        arrayBuffer: vi.fn().mockResolvedValue(new Uint8Array(Buffer.from('[]', 'utf16le')).buffer),
      });
    }),
  );
});

function resolve(slug: string) {
  const target = getVendorRegistryService().resolve(slug);
  if (!target) throw new Error(`slug ${slug} did not resolve`);
  return target;
}

describe('fetchVendorSummary dispatch', () => {
  it('statuspage vendor hits /api/v2/summary.json (regression — unchanged path)', async () => {
    const { data } = await fetchVendorSummary(resolve('github'));
    expect(data.status.indicator).toBe('none');
    expect(lastUrl()).toBe('https://www.githubstatus.com/api/v2/summary.json');
  });

  it('raw URL passthrough dispatches as statuspage', async () => {
    const target = resolve('https://status.example.com');
    expect(target.api_type).toBe('statuspage');
    await fetchVendorSummary(target);
    expect(lastUrl()).toBe('https://status.example.com/api/v2/summary.json');
  });

  it('statusio vendor (gitlab) hits the hostedstatus endpoint with its page ID', async () => {
    const { data } = await fetchVendorSummary(resolve('gitlab'));
    expect(data.status.indicator).toBe('none');
    expect(lastUrl()).toBe(
      'https://status-api.hostedstatus.com/1.0/status/5b36dc6502d06804c08349f7',
    );
  });

  it('statusio vendor (neon) uses its own page ID', async () => {
    await fetchVendorSummary(resolve('neon'));
    expect(lastUrl()).toBe(
      'https://status-api.hostedstatus.com/1.0/status/6878fc85709daa75be6c7e3c',
    );
  });

  it('slack vendor hits the Slack current endpoint', async () => {
    const { data } = await fetchVendorSummary(resolve('slack'));
    expect(data.status.indicator).toBe('none');
    expect(lastUrl()).toBe('https://status.slack.com/api/v2.0.0/current');
  });

  it('aws vendor hits the AWS Health currentevents endpoint', async () => {
    const { data } = await fetchVendorSummary(resolve('aws'));
    expect(data.status.indicator).toBe('none');
    expect(lastUrl()).toBe('https://health.aws.amazon.com/public/currentevents');
  });

  it('gcp vendor hits the Google Cloud incidents feed', async () => {
    const { data } = await fetchVendorSummary(resolve('gcp'));
    expect(data.status.indicator).toBe('none');
    expect(lastUrl()).toBe('https://status.cloud.google.com/incidents.json');
  });

  it('azure vendor hits the Azure status RSS feed', async () => {
    const { data } = await fetchVendorSummary(resolve('azure'));
    expect(data.status.indicator).toBe('none');
    expect(data.page.name).toBe('Microsoft Azure');
    expect(lastUrl()).toBe('https://rssfeed.azure.status.microsoft/en-us/status/feed/');
  });

  it('firehydrant vendor (redis-cloud) hits the page payload feed', async () => {
    const { data } = await fetchVendorSummary(resolve('redis-cloud'));
    expect(data.status.indicator).toBe('none');
    expect(lastUrl()).toBe('https://status.redis.io/data/payload.json');
  });

  /** status.datadoghq.com left Atlassian Statuspage; its /api/v2/*.json paths answer 403 (#90). */
  it('datadog vendor reads the page document, not the Statuspage v2 summary', async () => {
    const { data } = await fetchVendorSummary(resolve('datadog'));
    expect(data.status).toEqual({ indicator: 'none', description: 'All Systems Operational' });
    expect(data.page.name).toBe('Datadog US1');
    expect(vi.mocked(fetch).mock.calls.map((c) => String(c[0]))).toEqual([
      'https://status.datadoghq.com/config.json',
    ]);
  });

  it.each(DATADOG_PAGES)('datadog site %s reads %s/config.json', async (slug, page) => {
    await fetchVendorSummary(resolve(slug));
    expect(lastUrl()).toBe(`${page}/config.json`);
  });

  /** The Statuspage-compatible API on these pages cuts components and incidents at 25 (#98). */
  it('incidentio vendor reads the page summary feed, not the Statuspage v2 summary', async () => {
    const { data } = await fetchVendorSummary(resolve('openai'));
    expect(data.status).toEqual({ indicator: 'none', description: 'All Systems Operational' });
    expect(data.page.name).toBe('OpenAI');
    expect(vi.mocked(fetch).mock.calls.map((c) => String(c[0]))).toEqual([
      'https://status.openai.com/proxy/status.openai.com',
    ]);
  });

  it.each(INCIDENTIO_PAGES)('incident.io page %s reads %s/proxy/{host}', async (slug, page) => {
    await fetchVendorSummary(resolve(slug));
    expect(lastUrl()).toBe(`${page}/proxy/${new URL(page).host}`);
  });

  it('azure-devops vendor reads both the health endpoint and the RSS feed', async () => {
    const { data } = await fetchVendorSummary(resolve('azure-devops'));
    expect(data.status).toEqual({ indicator: 'none', description: 'Everything is looking good' });
    expect(data.page.name).toBe('Azure DevOps');
    expect(data.components).toHaveLength(56);
    const urls = vi.mocked(fetch).mock.calls.map((c) => String(c[0]));
    expect(urls.sort()).toEqual([
      'https://status.dev.azure.com/_apis/status/health?api-version=7.1-preview.1',
      'https://status.dev.azure.com/_rss',
    ]);
  });
});

describe('fetchVendorIncidents / fetchVendorScheduledMaintenances dispatch', () => {
  it('statuspage vendor keeps hitting the v2 incidents and maintenances paths', async () => {
    await fetchVendorIncidents(resolve('github'));
    expect(lastUrl()).toBe('https://www.githubstatus.com/api/v2/incidents.json');
    await fetchVendorScheduledMaintenances(resolve('github'));
    expect(lastUrl()).toBe('https://www.githubstatus.com/api/v2/scheduled-maintenances.json');
  });

  it('slack incidents hit /history; aws incidents hit currentevents', async () => {
    await fetchVendorIncidents(resolve('slack'));
    expect(lastUrl()).toBe('https://status.slack.com/api/v2.0.0/history');
    await fetchVendorIncidents(resolve('aws'));
    expect(lastUrl()).toBe('https://health.aws.amazon.com/public/currentevents');
  });

  it('gcp incidents hit the same incidents feed as the summary', async () => {
    await fetchVendorIncidents(resolve('gcp'));
    expect(lastUrl()).toBe('https://status.cloud.google.com/incidents.json');
  });

  it('azure incidents hit the same RSS feed as the summary', async () => {
    const { data } = await fetchVendorIncidents(resolve('azure'));
    expect(data.incidents).toEqual([]);
    expect(lastUrl()).toBe('https://rssfeed.azure.status.microsoft/en-us/status/feed/');
  });

  it('firehydrant incidents and maintenances both read the payload feed', async () => {
    await fetchVendorIncidents(resolve('redis-cloud'));
    expect(lastUrl()).toBe('https://status.redis.io/data/payload.json');
    await fetchVendorScheduledMaintenances(resolve('redis-cloud'));
    expect(lastUrl()).toBe('https://status.redis.io/data/payload.json');
  });

  it('datadog incidents and maintenances both read the page document', async () => {
    const incidents = await fetchVendorIncidents(resolve('datadog-eu1'));
    expect(incidents.data).toEqual({
      page: {
        id: 'datadog-eu1',
        name: 'Datadog EU1',
        updated_at: '',
        url: 'https://status.datadoghq.eu',
      },
      incidents: [],
    });
    expect(lastUrl()).toBe('https://status.datadoghq.eu/config.json');
    const maintenances = await fetchVendorScheduledMaintenances(resolve('datadog-eu1'));
    expect(maintenances.data.scheduled_maintenances).toEqual([]);
    expect(lastUrl()).toBe('https://status.datadoghq.eu/config.json');
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it('incidentio incidents and maintenances read the summary, then the default incident list', async () => {
    const SUMMARY = 'https://status.clerk.com/proxy/status.clerk.com';
    const incidents = await fetchVendorIncidents(resolve('clerk'));
    expect(incidents.data.incidents).toEqual([]);
    expect(incidents.upstreamIncidents).toEqual([]);
    const maintenances = await fetchVendorScheduledMaintenances(resolve('clerk'));
    expect(maintenances.data.scheduled_maintenances).toEqual([]);
    expect(vi.mocked(fetch).mock.calls.map((c) => String(c[0]))).toEqual([
      SUMMARY,
      `${SUMMARY}/incidents`,
      SUMMARY,
      `${SUMMARY}/incidents`,
    ]);
  });

  it('azure-devops incidents read only the RSS feed', async () => {
    const { data } = await fetchVendorIncidents(resolve('azure-devops'));
    expect(data.incidents).toEqual([]);
    expect(vi.mocked(fetch).mock.calls.map((c) => String(c[0]))).toEqual([
      'https://status.dev.azure.com/_rss',
    ]);
  });

  it('slack, aws, gcp, azure and azure-devops maintenances are empty and skip the network', async () => {
    const before = vi.mocked(fetch).mock.calls.length;
    for (const slug of ['slack', 'aws', 'gcp', 'azure', 'azure-devops']) {
      const { data } = await fetchVendorScheduledMaintenances(resolve(slug));
      expect(data.scheduled_maintenances, slug).toHaveLength(0);
    }
    expect(vi.mocked(fetch).mock.calls.length).toBe(before);
  });
});

/**
 * Normalizing every backend to the Statuspage shapes hides what each feed can
 * actually serve, which is what devops_get_incidents discloses (#25, #34). Each
 * expectation below is the behavior of the adapter in this directory.
 */
describe('backendHistory', () => {
  it('statuspage caps at 50 records and serves both resolved history and maintenances', () => {
    expect(backendHistory('statuspage')).toEqual({
      incidentCeiling: 50,
      resolved: 'full',
      scheduledMaintenance: true,
      historyPages: true,
      wholeHistory: false,
    });
  });

  it('slack caps at 50 records and publishes no maintenance feed', () => {
    // fetchSlackScheduledMaintenances returns empty without a network call.
    expect(backendHistory('slack')).toEqual({
      incidentCeiling: 50,
      resolved: 'full',
      scheduledMaintenance: false,
      historyPages: false,
      wholeHistory: false,
    });
  });

  it('aws serves resolved events only while its feed still lists them, and no maintenance feed', () => {
    // A status-0 event maps to 'resolved' and stays listed for hours before dropping off.
    expect(backendHistory('aws')).toEqual({
      incidentCeiling: null,
      resolved: 'current',
      scheduledMaintenance: false,
      historyPages: false,
      wholeHistory: false,
    });
  });

  it('statusio serves current incidents only, plus maintenance windows', () => {
    expect(backendHistory('statusio')).toEqual({
      incidentCeiling: null,
      resolved: 'current',
      scheduledMaintenance: true,
      historyPages: false,
      wholeHistory: false,
    });
  });

  it('gcp serves resolved history but publishes no maintenance feed', () => {
    // Resolution comes from each incident's `end`, so filter: "resolved" works;
    // fetchGcpScheduledMaintenances returns empty without a network call.
    expect(backendHistory('gcp')).toEqual({
      incidentCeiling: null,
      resolved: 'full',
      scheduledMaintenance: false,
      historyPages: false,
      wholeHistory: false,
    });
  });

  it('azure has no resolution lifecycle and no maintenance feed', () => {
    // mapAzureItem pins every item to 'investigating'; a resolved item leaves the feed.
    expect(backendHistory('azure')).toEqual({
      incidentCeiling: null,
      resolved: 'none',
      scheduledMaintenance: false,
      historyPages: false,
      wholeHistory: false,
    });
  });

  it('firehydrant is unbounded — the payload carries the whole history', () => {
    expect(backendHistory('firehydrant')).toEqual({
      incidentCeiling: null,
      resolved: 'full',
      scheduledMaintenance: true,
      historyPages: false,
      wholeHistory: true,
    });
  });

  it('datadog is unbounded — config.json carries the whole history and the maintenance windows', () => {
    expect(backendHistory('datadog')).toEqual({
      incidentCeiling: null,
      resolved: 'full',
      scheduledMaintenance: true,
      historyPages: false,
      wholeHistory: true,
    });
  });

  it('incidentio is bounded by age, keeps resolved incidents and maintenance, and reads older quarters for since', () => {
    // The default list is the last 90 days with no record cap; readIncidentioHistory reads
    // its quarter windows past that, so the windowed feed is the page's archive.
    expect(backendHistory('incidentio')).toEqual({
      incidentCeiling: null,
      resolved: 'full',
      scheduledMaintenance: true,
      historyPages: true,
      wholeHistory: false,
    });
  });

  it('azure-devops keeps resolved events in a rolling window and publishes no maintenance', () => {
    // The _rss window keeps Resolved items, bounded by age with no record count;
    // fetchAzureDevOpsScheduledMaintenances returns empty without a network call.
    expect(backendHistory('azure-devops')).toEqual({
      incidentCeiling: null,
      resolved: 'full',
      scheduledMaintenance: false,
      historyPages: false,
      wholeHistory: false,
    });
  });

  it('only the two 50-record feeds declare a ceiling', () => {
    // The ceiling drives the upstream-cap disclosure; a wrong null silently
    // restores the "50 is the whole history" bug this replaced.
    const withCeiling = (
      [
        'statuspage',
        'slack',
        'aws',
        'gcp',
        'azure',
        'azure-devops',
        'statusio',
        'firehydrant',
        'datadog',
        'incidentio',
      ] as const
    ).filter((t) => backendHistory(t).incidentCeiling !== null);
    expect(withCeiling).toEqual(['statuspage', 'slack']);
  });

  it('only statuspage and incidentio read history past their default feed', () => {
    // Slack shares the 50-record ceiling but publishes no archive to read past it.
    const withHistory = (
      [
        'statuspage',
        'slack',
        'aws',
        'gcp',
        'azure',
        'azure-devops',
        'statusio',
        'firehydrant',
        'datadog',
        'incidentio',
      ] as const
    ).filter((t) => backendHistory(t).historyPages);
    expect(withHistory).toEqual(['statuspage', 'incidentio']);
  });

  it('only firehydrant and datadog serve their page whole in one fetch', () => {
    // On a whole-history feed nothing older than its oldest record exists, so the
    // feed-start disclosure for windowed feeds must not fire there.
    const whole = (
      [
        'statuspage',
        'slack',
        'aws',
        'gcp',
        'azure',
        'azure-devops',
        'statusio',
        'firehydrant',
        'datadog',
        'incidentio',
      ] as const
    ).filter((t) => backendHistory(t).wholeHistory);
    expect(whole).toEqual(['firehydrant', 'datadog']);
  });

  it('the eight incident.io-hosted entries, and only they, resolve as incidentio', () => {
    // INCIDENTIO_PAGES is in registry order.
    expect(VENDOR_REGISTRY.filter((v) => v.api_type === 'incidentio').map((v) => v.slug)).toEqual(
      INCIDENTIO_PAGES.map(([slug]) => slug),
    );
    for (const [slug, url] of INCIDENTIO_PAGES) {
      expect(resolve(slug), slug).toMatchObject({ slug, url, api_type: 'incidentio' });
    }
  });

  it('every api_type in the registry has a capability row', () => {
    // The switch has no default branch, so a backend added to the registry
    // without a backendHistory case returns undefined here rather than lying.
    for (const apiType of new Set(VENDOR_REGISTRY.map((v) => v.api_type))) {
      const history = backendHistory(apiType);
      expect(history, apiType).toBeDefined();
      expect(['full', 'current', 'none'], apiType).toContain(history.resolved);
      expect(typeof history.scheduledMaintenance, apiType).toBe('boolean');
      expect(typeof history.historyPages, apiType).toBe('boolean');
      expect(typeof history.wholeHistory, apiType).toBe('boolean');
    }
  });
});

/**
 * status.sendgrid.com redirects to status.twilio.com, so the sendgrid entry reads Twilio's
 * page scoped to SendGrid's components (#54). statuspage-twilio-summary.json is a live
 * capture (2026-10-14) with components intact: 13 SendGrid components (two groups, five
 * leaves under them, eight ungrouped), Twilio's degraded CARRIER NETWORK leaves, seven open
 * carrier incidents, and four SendGrid maintenance windows among 32.
 */
describe('component-scoped entry (sendgrid, #54)', () => {
  const TWILIO = 'status.twilio.com';
  const SMTP = 'dh4v9m99t24n'; // under the "SendGrid Mail Sending" group
  const SENDGRID_API = 'sqwjyy7x2sc6'; // ungrouped "SendGrid API"
  const SMS_LATAM = '42zx9w2kmtvf'; // under CARRIER NETWORK, degraded on the capture

  type Summary = {
    page: { name: string };
    status: { indicator: string; description: string };
    components: Array<Record<string, unknown> & { id: string; name: string; status: string }>;
    incidents: Array<Record<string, unknown>>;
    scheduled_maintenances: Array<Record<string, unknown>>;
  };
  const summaryCapture = (): Summary =>
    JSON.parse(
      readFileSync(new URL('fixtures/statuspage-twilio-summary.json', import.meta.url), 'utf-8'),
    ) as Summary;
  const incidentsCapture = () =>
    JSON.parse(
      readFileSync(
        new URL('../statuspage/fixtures/twilio-incidents.json', import.meta.url),
        'utf-8',
      ),
    ) as { incidents: Array<Record<string, unknown>> };

  function componentRef(summary: Summary, id: string) {
    return summary.components.find((c) => c.id === id)!;
  }

  /** An open incident on the captured page, touching the given components. */
  function openIncident(summary: Summary, id: string, impact: string, componentIds: string[]) {
    return {
      ...summary.incidents[0]!,
      id,
      name: `Incident ${id}`,
      impact,
      status: 'investigating',
      components: componentIds.map((c) => componentRef(summary, c)),
    };
  }

  type FeedPath =
    | '/api/v2/summary.json'
    | '/api/v2/incidents.json'
    | '/api/v2/scheduled-maintenances.json';

  function serve(routes: Partial<Record<FeedPath, unknown>>) {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown) => {
        const url = new URL(String(input));
        const body = url.hostname === TWILIO ? routes[url.pathname as FeedPath] : undefined;
        return body === undefined
          ? Promise.reject(new Error(`Unmocked fetch: ${url.href}`))
          : Promise.resolve(Response.json(body));
      }),
    );
  }

  const fetchedPaths = () => vi.mocked(fetch).mock.calls.map((c) => new URL(String(c[0])).pathname);

  it('keeps only SendGrid components, under the SendGrid name, rated by them alone', async () => {
    serve({ '/api/v2/summary.json': summaryCapture() });
    const { data } = await fetchVendorSummary(resolve('sendgrid'));

    expect(data.page.name).toBe('SendGrid');
    const leaves = data.components.filter((c) => !c.group);
    expect(leaves).toHaveLength(13);
    expect(data.components.filter((c) => c.group).map((c) => c.name)).toEqual([
      'SendGrid Mail Sending',
      'SendGrid Webhooks',
    ]);
    expect(leaves.map((c) => c.name)).toContain('SMTP');
    // Twilio's page reads minor on degraded carrier components; none of them are SendGrid's.
    expect(data.components.map((c) => c.id)).not.toContain(SMS_LATAM);
    expect(data.status).toEqual({ indicator: 'none', description: 'All Systems Operational' });
    expect(data.incidents).toEqual([]);
    expect(data.scheduled_maintenances?.map((m) => m.name)).toEqual([
      'Bounce Suppressions Maintenance',
      'Block Suppressions Maintenance',
      'Infrastructure Maintenance: Saturday, October 17, from 2PM-4PM PT',
      'Marketing Campaign Stats Maintenance',
    ]);
  });

  it('leaves the twilio entry reading the whole page unchanged', async () => {
    serve({ '/api/v2/summary.json': summaryCapture() });
    const { data } = await fetchVendorSummary(resolve('twilio'));

    expect(data.page.name).toBe('Twilio');
    expect(data.status.indicator).toBe('minor');
    expect(data.components).toHaveLength(192);
    expect(data.incidents).toHaveLength(7);
    expect(data.scheduled_maintenances).toHaveLength(32);
  });

  it('keeps an open incident touching a SendGrid leaf and drops one touching only carrier components', async () => {
    const summary = summaryCapture();
    summary.incidents.push(
      openIncident(summary, 'smtp-1', 'major', [SMTP]),
      openIncident(summary, 'mixed-1', 'minor', [SMS_LATAM, SENDGRID_API]),
    );
    serve({ '/api/v2/summary.json': summary });
    const { data } = await fetchVendorSummary(resolve('sendgrid'));

    expect(data.incidents?.map((i) => i.id)).toEqual(['smtp-1', 'mixed-1']);
    expect(data.status).toEqual({ indicator: 'major', description: 'Partial System Outage' });
  });

  it('reads the v2 incident and maintenance feeds through the page component table', async () => {
    const summary = summaryCapture();
    const feed = incidentsCapture();
    // The recorded feed has its components stripped; give one record SendGrid's SMTP.
    feed.incidents[3] = { ...feed.incidents[3], components: [componentRef(summary, SMTP)] };
    serve({
      '/api/v2/summary.json': summary,
      '/api/v2/incidents.json': feed,
      '/api/v2/scheduled-maintenances.json': {
        page: summary.page,
        scheduled_maintenances: summary.scheduled_maintenances,
      },
    });

    const incidents = await fetchVendorIncidents(resolve('sendgrid'));
    expect(incidents.data.incidents.map((i) => i.id)).toEqual([feed.incidents[3]!.id]);
    // The ceiling check and the feed's reach read the feed as Twilio published it.
    expect(incidents.upstreamIncidents).toHaveLength(50);
    expect(incidents.data.page.name).toBe('SendGrid');

    const maintenances = await fetchVendorScheduledMaintenances(resolve('sendgrid'));
    expect(maintenances.data.scheduled_maintenances).toHaveLength(4);

    expect(fetchedPaths()).toEqual(
      expect.arrayContaining([
        '/api/v2/summary.json',
        '/api/v2/incidents.json',
        '/api/v2/scheduled-maintenances.json',
      ]),
    );
  });

  it('reports the unscoped feed count for an ordinary entry too', async () => {
    serve({ '/api/v2/incidents.json': incidentsCapture() });
    const { data, upstreamIncidents } = await fetchVendorIncidents(resolve('twilio'));
    expect(data.incidents).toHaveLength(50);
    expect(upstreamIncidents).toHaveLength(50);
    // An unscoped entry needs no component table.
    expect(fetchedPaths()).toEqual(['/api/v2/incidents.json']);
  });

  it('reads no history archive for a scoped entry — archive records carry no components', () => {
    expect(vendorHistory(resolve('sendgrid'))).toEqual({
      ...backendHistory('statuspage'),
      historyPages: false,
    });
    expect(vendorHistory(resolve('twilio'))).toEqual(backendHistory('statuspage'));
  });
});

/**
 * A raw URL is read only as a Statuspage base. Its answers that prove the base serves no
 * Statuspage API leave as `statuspage_not_found`; every answer an outage or challenge page
 * also gives stays `statuspage_unavailable`. Run through the real service, fetch, redirect,
 * and shape-gate path down to a strict fetch fake.
 */
describe('raw URL classification (#103)', () => {
  const http = createFetchMock();
  const BASE = 'https://status.raw-vendor.example';
  const RECOVERY =
    "Pass the vendor's registry slug (devops_list_vendors lists them) or the base URL of a page hosted on Atlassian Statuspage.";

  beforeEach(() => {
    clearFetchCache();
    http.reset();
    http.install();
  });

  afterEach(() => {
    http.restore();
    vi.useRealTimers();
  });

  type Read = (vendor: ResolvedVendor) => Promise<unknown>;
  const READS: Record<'summary' | 'incidents' | 'scheduled-maintenances', Read> = {
    summary: fetchVendorSummary,
    incidents: fetchVendorIncidents,
    'scheduled-maintenances': fetchVendorScheduledMaintenances,
  };

  /** Read `endpoint` of `base` as a raw URL, every /api/v2/ path answering with `respond`. */
  function failure(
    endpoint: keyof typeof READS,
    respond: (request: Request) => Promise<Response> | Response,
    base = BASE,
  ): Promise<McpError> {
    http.route({ match: /\/api\/v2\//, respond });
    return READS[endpoint](resolve(base)).then(
      () => {
        throw new Error(`${endpoint} of ${base} did not fail`);
      },
      (err: unknown) => err as McpError,
    );
  }

  describe.each(['summary', 'incidents'] as const)('%s.json', (endpoint) => {
    it.each([404, 410])(
      'answering %i is statuspage_not_found, naming the endpoint',
      async (status) => {
        const err = await failure(endpoint, () => new Response('Not Found', { status }));

        expect(err).toBeInstanceOf(McpError);
        expect(err.code).toBe(JsonRpcErrorCode.NotFound);
        expect(err.data).toEqual({ reason: 'statuspage_not_found', url: BASE });
        expect(err.message).toBe(
          `${BASE} serves no Atlassian Statuspage API at that base: HTTP ${status} from ${BASE}/api/v2/${endpoint}.json. ${RECOVERY}`,
        );
        expect(http.calls).toHaveLength(1);
      },
    );

    it('answering 404 after a redirect is statuspage_not_found', async () => {
      http.route({
        match: `https://elsewhere.example/api/v2/${endpoint}.json`,
        respond: () => new Response(null, { status: 404 }),
      });
      const err = await failure(
        endpoint,
        () =>
          new Response(null, {
            status: 301,
            headers: { location: `https://elsewhere.example/api/v2/${endpoint}.json` },
          }),
      );

      expect(err.data).toMatchObject({ reason: 'statuspage_not_found' });
      expect(http.calls.map((c) => c.request.url)).toEqual([
        `${BASE}/api/v2/${endpoint}.json`,
        `https://elsewhere.example/api/v2/${endpoint}.json`,
      ]);
    });
  });

  it.each(Object.keys(READS) as (keyof typeof READS)[])(
    '%s.json answering JSON without the Statuspage fields is statuspage_not_found',
    async (endpoint) => {
      const err = await failure(endpoint, () =>
        Response.json({ args: {}, headers: {}, method: 'GET' }),
      );

      expect(err.code).toBe(JsonRpcErrorCode.NotFound);
      expect(err.data).toEqual({ reason: 'statuspage_not_found', url: BASE });
      expect(err.message).toBe(
        `${BASE} serves no Atlassian Statuspage API at that base: ${BASE}/api/v2/${endpoint}.json answered JSON without the Statuspage fields. ${RECOVERY}`,
      );
    },
  );

  it('scheduled-maintenances.json answering 404 stays statuspage_unavailable for its caller to decide', async () => {
    const err = await failure('scheduled-maintenances', () => new Response(null, { status: 404 }));

    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data).toMatchObject({ reason: 'statuspage_unavailable', status: 404 });
  });

  describe('answers an outage or challenge page also gives stay statuspage_unavailable', () => {
    /** Each case with a fragment of the message its own failure branch writes. */
    const cases: [string, (request: Request) => Promise<Response> | Response, string][] = [
      ['403 challenge', () => new Response('<html>challenge</html>', { status: 403 }), 'HTTP 403'],
      [
        '429',
        () => new Response(null, { status: 429, headers: { 'retry-after': '30' } }),
        'HTTP 429',
      ],
      ['500', () => new Response(null, { status: 500 }), 'HTTP 500'],
      ['502', () => new Response(null, { status: 502 }), 'HTTP 502'],
      ['503', () => new Response(null, { status: 503 }), 'HTTP 503'],
      [
        'network error',
        () => {
          throw new TypeError('Unable to connect. Is the computer able to access the url?');
        },
        'Could not reach',
      ],
      ['redirect with no Location', () => new Response(null, { status: 302 }), 'no Location'],
      [
        'redirect past five hops',
        (req) => new Response(null, { status: 302, headers: { location: `${req.url}?hop` } }),
        'More than 5 redirects',
      ],
      [
        'oversized body',
        () =>
          new Response('{}', {
            headers: { 'content-length': String(MAX_RESPONSE_BODY_BYTES + 1) },
          }),
        'over the size limit',
      ],
      [
        '200 body that is not JSON',
        () => new Response('<!doctype html><html></html>'),
        'could not be parsed as JSON',
      ],
      [
        'Statuspage payload with one value off the schema',
        () =>
          Response.json({
            ...STATUSPAGE_BODY,
            status: { indicator: 'sideways', description: '' },
          }),
        'does not carry the expected Statuspage fields',
      ],
    ];

    it.each(cases)('%s', async (_label, respond, branch) => {
      const err = await failure('summary', respond);
      expect(err).toBeInstanceOf(McpError);
      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err.data).toMatchObject({ reason: 'statuspage_unavailable' });
      expect(err.message).toContain(branch);
    });

    it('timeout', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const pending = failure(
        'incidents',
        (req) =>
          new Promise<Response>((_, reject) => {
            req.signal.addEventListener('abort', () => reject(req.signal.reason));
          }),
      );
      await vi.advanceTimersByTimeAsync(5000);
      const err = await pending;

      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err.data).toMatchObject({ reason: 'statuspage_unavailable' });
      expect(err.message).toContain('Timed out');
    });
  });

  it('names every registry entry on the host, without claiming the vendor has no page', async () => {
    const twilio = await failure(
      'summary',
      () => new Response(null, { status: 404 }),
      'https://status.twilio.com/wrong-path',
    );
    expect(twilio.message).toBe(
      'https://status.twilio.com/wrong-path serves no Atlassian Statuspage API at that base: HTTP 404 from https://status.twilio.com/wrong-path/api/v2/summary.json. The registry entries for this host\'s status page are "twilio" and "sendgrid" — pass one of those slugs as the vendor instead.',
    );

    // auth0's page is auth0.statuspage.io; this alias host is not registry data.
    const auth0 = await failure(
      'incidents',
      () => new Response(null, { status: 404 }),
      'https://status.auth0.com',
    );
    expect(auth0.message).toBe(
      `https://status.auth0.com serves no Atlassian Statuspage API at that base: HTTP 404 from https://status.auth0.com/api/v2/incidents.json. ${RECOVERY}`,
    );
  });

  it("leaves a registry entry's own failures as they were", async () => {
    http.route({ match: /\/api\/v2\//, respond: () => new Response(null, { status: 404 }) });
    const notServed = await fetchVendorSummary(resolve('github')).catch((e: unknown) => e);
    expect((notServed as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect((notServed as McpError).data).toMatchObject({
      reason: 'statuspage_unavailable',
      status: 404,
    });

    http.reset();
    http.route({ match: /\/api\/v2\//, respond: () => Response.json({ args: {} }) });
    const wrongShape = await fetchVendorIncidents(resolve('github')).catch((e: unknown) => e);
    expect((wrongShape as McpError).data).toMatchObject({ reason: 'statuspage_unavailable' });
  });

  describe('rawTargetRejection — before any request', () => {
    /**
     * An incident.io page also serves the Statuspage-compatible API, so a raw URL on it is
     * read as Statuspage, as any unknown host is (#98); only the slug reads its own feed.
     */
    const servesStatuspageApi = (e: (typeof VENDOR_REGISTRY)[number]) =>
      e.api_type === 'statuspage' || e.api_type === 'incidentio';
    const unreadable = VENDOR_REGISTRY.filter((e) => !servesStatuspageApi(e));

    it('rejects a URL on each of the 17 adapter-backed status pages, naming its slug', () => {
      expect(unreadable).toHaveLength(17);
      for (const entry of unreadable) {
        const message = rawTargetRejection(resolve(entry.statuspage_url));
        expect(message, entry.slug).toContain(
          `The registry entry for this host's status page is "${entry.slug}" — pass that slug as the vendor instead.`,
        );
      }
      expect(rawTargetRejection(resolve('https://status.gitlab.com'))).toBe(
        'https://status.gitlab.com serves no Atlassian Statuspage API at that base: its status page runs on another backend, which this server reads only by the vendor\'s registry slug. The registry entry for this host\'s status page is "gitlab" — pass that slug as the vendor instead.',
      );
      expect(http.calls).toHaveLength(0);
    });

    it('lets every Statuspage and incident.io host, an unknown host, and a registry slug through', () => {
      const readable = VENDOR_REGISTRY.filter(servesStatuspageApi);
      expect(readable.filter((e) => e.api_type === 'incidentio')).toHaveLength(8);
      for (const entry of readable) {
        expect(
          rawTargetRejection(resolve(`${entry.statuspage_url}/any/path`)),
          entry.slug,
        ).toBeNull();
      }
      expect(resolve('https://status.openai.com').api_type).toBe('statuspage');
      expect(rawTargetRejection(resolve(BASE))).toBeNull();
      expect(rawTargetRejection(resolve('gitlab'))).toBeNull();
    });
  });
});
