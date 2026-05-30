/**
 * @fileoverview Tests for the StatuspageService fetch and caching logic.
 * @module tests/services/statuspage/statuspage-service.test
 */

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
    const MOCK_MAINT = { page: MOCK_SUMMARY.page, incidents: [] };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(MOCK_MAINT),
      }),
    );

    const service = new StatuspageService();
    const { data } = await service.fetchScheduledMaintenances(freshUrl());
    expect(data.incidents).toBeInstanceOf(Array);

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect(fetchCall?.[0] as string).toContain('/api/v2/scheduled-maintenances.json');
  });

  it('throws on non-ok HTTP response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const service = new StatuspageService();
    await expect(service.fetchSummary(freshUrl())).rejects.toThrow('HTTP 503');
  });
});
