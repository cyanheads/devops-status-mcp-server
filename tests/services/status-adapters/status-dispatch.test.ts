/**
 * @fileoverview Tests for the status dispatch layer — each api_type routes to
 * its adapter's endpoint, and statuspage vendors keep hitting the Statuspage
 * v2 paths unchanged (regression).
 * @module tests/services/status-adapters/status-dispatch.test
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
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
        : u.includes('/api/v2.0.0/history')
          ? []
          : u.includes('/api/v2.0.0/')
            ? { status: 'ok', active_incidents: [] }
            : STATUSPAGE_BODY;
      return Promise.resolve({
        ok: true,
        json: vi.fn().mockResolvedValue(body),
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

  it('slack and aws maintenances are empty and skip the network', async () => {
    const before = vi.mocked(fetch).mock.calls.length;
    const slack = await fetchVendorScheduledMaintenances(resolve('slack'));
    const aws = await fetchVendorScheduledMaintenances(resolve('aws'));
    expect(slack.data.scheduled_maintenances).toHaveLength(0);
    expect(aws.data.scheduled_maintenances).toHaveLength(0);
    expect(vi.mocked(fetch).mock.calls.length).toBe(before);
  });
});
