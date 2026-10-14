/**
 * @fileoverview Tests for the status dispatch layer — each api_type routes to
 * its adapter's endpoint, and statuspage vendors keep hitting the Statuspage
 * v2 paths unchanged (regression).
 * @module tests/services/status-adapters/status-dispatch.test
 */

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VENDOR_REGISTRY } from '@/data/vendor-registry.js';
import {
  backendHistory,
  fetchVendorIncidents,
  fetchVendorScheduledMaintenances,
  fetchVendorSummary,
  vendorHistory,
} from '@/services/status-adapters/status-dispatch.js';
import { initStatuspageService } from '@/services/statuspage/statuspage-service.js';
import {
  getVendorRegistryService,
  initVendorRegistryService,
} from '@/services/vendor-registry/vendor-registry-service.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    cacheTtlMs: -1, // entries expire immediately — each dispatch call must hit the (stubbed) network
    fetchTimeoutMs: 5000,
    certTimeoutMs: 5000,
    dnsTimeoutMs: 3000,
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
      const body =
        new URL(u).hostname === 'status.dev.azure.com'
          ? AZURE_DEVOPS_HEALTH_BODY // its _rss feed reads the empty channel below
          : u.includes('hostedstatus.com')
            ? STATUSIO_BODY
            : u.includes('/data/payload.json')
              ? FIREHYDRANT_BODY
              : u.includes('status.cloud.google.com')
                ? [] // the Google Cloud feed is a bare incident array
                : u.includes('/api/v2.0.0/history')
                  ? []
                  : u.includes('/api/v2.0.0/')
                    ? { status: 'ok', active_incidents: [] }
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
    });
  });

  it('slack caps at 50 records and publishes no maintenance feed', () => {
    // fetchSlackScheduledMaintenances returns empty without a network call.
    expect(backendHistory('slack')).toEqual({
      incidentCeiling: 50,
      resolved: 'full',
      scheduledMaintenance: false,
      historyPages: false,
    });
  });

  it('aws serves resolved events only while its feed still lists them, and no maintenance feed', () => {
    // A status-0 event maps to 'resolved' and stays listed for hours before dropping off.
    expect(backendHistory('aws')).toEqual({
      incidentCeiling: null,
      resolved: 'current',
      scheduledMaintenance: false,
      historyPages: false,
    });
  });

  it('statusio serves current incidents only, plus maintenance windows', () => {
    expect(backendHistory('statusio')).toEqual({
      incidentCeiling: null,
      resolved: 'current',
      scheduledMaintenance: true,
      historyPages: false,
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
    });
  });

  it('azure has no resolution lifecycle and no maintenance feed', () => {
    // mapAzureItem pins every item to 'investigating'; a resolved item leaves the feed.
    expect(backendHistory('azure')).toEqual({
      incidentCeiling: null,
      resolved: 'none',
      scheduledMaintenance: false,
      historyPages: false,
    });
  });

  it('firehydrant is unbounded — the payload carries the whole history', () => {
    expect(backendHistory('firehydrant')).toEqual({
      incidentCeiling: null,
      resolved: 'full',
      scheduledMaintenance: true,
      historyPages: false,
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
      ] as const
    ).filter((t) => backendHistory(t).incidentCeiling !== null);
    expect(withCeiling).toEqual(['statuspage', 'slack']);
  });

  it('only statuspage offers a history archive past its ceiling', () => {
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
      ] as const
    ).filter((t) => backendHistory(t).historyPages);
    expect(withHistory).toEqual(['statuspage']);
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
    // The ceiling check reads the feed as Twilio published it.
    expect(incidents.upstreamCount).toBe(50);
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
    const { data, upstreamCount } = await fetchVendorIncidents(resolve('twilio'));
    expect(data.incidents).toHaveLength(50);
    expect(upstreamCount).toBe(50);
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
