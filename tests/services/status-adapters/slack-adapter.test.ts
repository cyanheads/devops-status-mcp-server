/**
 * @fileoverview Tests for the Slack status adapter mappers and fetchers.
 * Fixtures are live captures of https://status.slack.com/api/v2.0.0/current
 * and /history (history trimmed to the first 3 items).
 * @module tests/services/status-adapters/slack-adapter.test
 */

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchSlackIncidents,
  fetchSlackScheduledMaintenances,
  fetchSlackSummary,
  mapSlackIncident,
  mapSlackSummary,
  type SlackCurrent,
  type SlackIncident,
  type SlackTarget,
} from '@/services/status-adapters/slack-adapter.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    cacheTtlMs: 60_000,
    fetchTimeoutMs: 5000,
    certTimeoutMs: 5000,
    dnsTimeoutMs: 3000,
  }),
}));

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf-8')) as T;
}

const SLACK: SlackTarget = {
  name: 'Slack',
  url: 'https://status.slack.com',
  slug: 'slack',
};

describe('mapSlackSummary', () => {
  it('maps a healthy live current response to indicator none', () => {
    const summary = mapSlackSummary(fixture<SlackCurrent>('slack-current.json'), SLACK);
    expect(summary.status.indicator).toBe('none');
    expect(summary.status.description).toBe('All Systems Operational');
    expect(summary.page.name).toBe('Slack');
    expect(summary.incidents).toHaveLength(0);
    expect(summary.components).toHaveLength(0);
    expect(summary.scheduled_maintenances).toHaveLength(0);
  });

  it('derives severity from incident type when active (outage → critical)', () => {
    const history = fixture<SlackIncident[]>('slack-history.json');
    const active: SlackCurrent = {
      status: 'active',
      active_incidents: [{ ...history[0]!, status: 'active', type: 'outage' }],
    };
    const summary = mapSlackSummary(active, SLACK);
    expect(summary.status.indicator).toBe('critical');
    expect(summary.incidents).toHaveLength(1);
    expect(summary.incidents[0]!.status).toBe('investigating');
  });

  it('reports at least minor when active with an empty incident list', () => {
    const summary = mapSlackSummary({ status: 'active', active_incidents: [] }, SLACK);
    expect(summary.status.indicator).toBe('minor');
  });
});

describe('mapSlackIncident', () => {
  it('maps a live history item — id, notes as chronological updates, resolution', () => {
    const history = fixture<SlackIncident[]>('slack-history.json');
    const first = history[0]!;
    const inc = mapSlackIncident(first, SLACK);
    expect(inc.id).toBe(String(first.id));
    expect(inc.name).toBe(first.title);
    expect(inc.status).toBe('resolved');
    expect(inc.resolved_at).toBe(first.date_updated);
    expect(inc.impact).toBe('minor'); // type: incident
    expect(inc.shortlink).toBe(first.url);
    expect(inc.incident_updates).toHaveLength(first.notes?.length ?? 0);
    // Chronological (oldest first)
    const times = inc.incident_updates.map((u) => new Date(u.created_at).getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('maps type notice → none and unknown type → minor', () => {
    expect(mapSlackIncident({ type: 'notice', status: 'resolved' }, SLACK).impact).toBe('none');
    expect(mapSlackIncident({ type: 'mystery', status: 'active' }, SLACK).impact).toBe('minor');
  });

  it('does not crash on a sparse item with omitted fields', () => {
    const inc = mapSlackIncident({}, SLACK);
    expect(inc.status).toBe('investigating');
    expect(inc.incident_updates).toHaveLength(0);
    expect(inc.resolved_at).toBeNull();
  });
});

describe('fetchers', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) =>
        Promise.resolve({
          ok: true,
          json: vi
            .fn()
            .mockResolvedValue(
              String(url).includes('/current')
                ? fixture<SlackCurrent>('slack-current.json')
                : fixture<SlackIncident[]>('slack-history.json'),
            ),
        }),
      ),
    );
  });

  it('fetchSlackSummary hits /api/v2.0.0/current on the entry base URL', async () => {
    const target: SlackTarget = { ...SLACK, url: `https://status-${Date.now()}.slack.com` };
    const { data } = await fetchSlackSummary(target);
    expect(data.status.indicator).toBe('none');
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(`${target.url}/api/v2.0.0/current`);
  });

  it('fetchSlackIncidents hits /api/v2.0.0/history and maps items', async () => {
    const target: SlackTarget = { ...SLACK, url: `https://status-h${Date.now()}.slack.com` };
    const { data } = await fetchSlackIncidents(target);
    expect(data.incidents.length).toBeGreaterThan(0);
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(`${target.url}/api/v2.0.0/history`);
  });

  it('fetchSlackScheduledMaintenances returns empty without a network call', async () => {
    const { data } = await fetchSlackScheduledMaintenances(SLACK);
    expect(data.scheduled_maintenances).toHaveLength(0);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
