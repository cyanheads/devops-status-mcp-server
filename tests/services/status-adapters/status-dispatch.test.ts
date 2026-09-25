/**
 * @fileoverview Tests for the status dispatch layer — each api_type routes to
 * its adapter's endpoint, and statuspage vendors keep hitting the Statuspage
 * v2 paths unchanged (regression).
 * @module tests/services/status-adapters/status-dispatch.test
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VENDOR_REGISTRY } from '@/data/vendor-registry.js';
import {
  backendHistory,
  fetchVendorIncidents,
  fetchVendorScheduledMaintenances,
  fetchVendorSummary,
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
      const body = u.includes('hostedstatus.com')
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
        // The Azure feed is RSS; an empty channel is its all-clear shape.
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

  it('slack, aws, gcp and azure maintenances are empty and skip the network', async () => {
    const before = vi.mocked(fetch).mock.calls.length;
    for (const slug of ['slack', 'aws', 'gcp', 'azure']) {
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

  it('only the two 50-record feeds declare a ceiling', () => {
    // The ceiling drives the upstream-cap disclosure; a wrong null silently
    // restores the "50 is the whole history" bug this replaced.
    const withCeiling = (
      ['statuspage', 'slack', 'aws', 'gcp', 'azure', 'statusio', 'firehydrant'] as const
    ).filter((t) => backendHistory(t).incidentCeiling !== null);
    expect(withCeiling).toEqual(['statuspage', 'slack']);
  });

  it('only statuspage offers a history archive past its ceiling', () => {
    // Slack shares the 50-record ceiling but publishes no archive to read past it.
    const withHistory = (
      ['statuspage', 'slack', 'aws', 'gcp', 'azure', 'statusio', 'firehydrant'] as const
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
