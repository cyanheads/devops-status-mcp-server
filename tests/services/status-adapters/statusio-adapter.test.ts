/**
 * @fileoverview Tests for the Status.io adapter mappers and fetchers.
 * Fixtures: statusio-gitlab.json is a live capture of GitLab's page (healthy);
 * statusio-incident-doc-derived.json reproduces the detailed example from
 * Status.io's Public Status API docs (both live pages were incident-free at
 * capture time, so the incident/maintenance item shape is doc-derived).
 * @module tests/services/status-adapters/statusio-adapter.test
 */

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchStatusioSummary,
  mapStatusioIncidents,
  mapStatusioScheduledMaintenances,
  mapStatusioSummary,
  type StatusioResponse,
  type StatusioTarget,
} from '@/services/status-adapters/statusio-adapter.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    cacheTtlMs: 60_000,
    fetchTimeoutMs: 5000,
    certTimeoutMs: 5000,
    dnsTimeoutMs: 3000,
  }),
}));

function fixture(name: string): StatusioResponse {
  return JSON.parse(
    readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf-8'),
  ) as StatusioResponse;
}

const GITLAB: StatusioTarget = {
  statusio_page_id: '5b36dc6502d06804c08349f7',
  name: 'GitLab',
  url: 'https://status.gitlab.com',
  slug: 'gitlab',
};

describe('mapStatusioSummary', () => {
  it('maps a healthy live page (gitlab) to indicator none with components', () => {
    const summary = mapStatusioSummary(fixture('statusio-gitlab.json'), GITLAB);
    expect(summary.status.indicator).toBe('none');
    expect(summary.status.description).toBe('Operational');
    expect(summary.page.name).toBe('GitLab');
    expect(summary.page.url).toBe('https://status.gitlab.com');
    expect(summary.components.length).toBeGreaterThan(0);
    for (const c of summary.components) expect(c.status).toBe('operational');
    expect(summary.incidents).toHaveLength(0);
    expect(summary.scheduled_maintenances).toHaveLength(0);
  });

  it('maps overall maintenance (code 200) to indicator none', () => {
    const summary = mapStatusioSummary(fixture('statusio-incident-doc-derived.json'), GITLAB);
    expect(summary.status.indicator).toBe('none');
    expect(summary.status.description).toBe('Planned Maintenance');
  });

  it('maps severity codes to indicators (300 minor, 400 major, 500/600 critical, unknown minor)', () => {
    const base = fixture('statusio-gitlab.json');
    const withCode = (code: number | undefined): StatusioResponse => ({
      result: {
        ...base.result,
        status_overall: { updated: '', status: 'x', status_code: code },
      },
    });
    expect(mapStatusioSummary(withCode(300), GITLAB).status.indicator).toBe('minor');
    expect(mapStatusioSummary(withCode(400), GITLAB).status.indicator).toBe('major');
    expect(mapStatusioSummary(withCode(500), GITLAB).status.indicator).toBe('critical');
    expect(mapStatusioSummary(withCode(600), GITLAB).status.indicator).toBe('critical');
    expect(mapStatusioSummary(withCode(999), GITLAB).status.indicator).toBe('minor');
    expect(mapStatusioSummary(withCode(undefined), GITLAB).status.indicator).toBe('minor');
  });
});

describe('mapStatusioIncidents', () => {
  it('maps the doc-derived incident with lifecycle, severity, updates, and affected components', () => {
    const { incidents } = mapStatusioIncidents(
      fixture('statusio-incident-doc-derived.json'),
      GITLAB,
    );
    expect(incidents).toHaveLength(1);
    const inc = incidents[0]!;
    expect(inc.id).toBe('61ae3daa9c768905d9f0f6fd');
    expect(inc.name).toBe('Authentication Issues');
    expect(inc.impact).toBe('minor'); // status 300 = Degraded Performance
    expect(inc.status).toBe('identified'); // latest message state 200
    expect(inc.created_at).toBe('2021-12-06T16:43:22.431Z');
    expect(inc.resolved_at).toBeNull();
    expect(inc.incident_updates).toHaveLength(2);
    expect(inc.incident_updates[0]!.status).toBe('investigating');
    expect(inc.incident_updates[1]!.status).toBe('identified');
    // Affected component/container names ride the latest update
    const affected = inc.incident_updates[1]!.affected_components?.map((a) => a.name);
    expect(affected).toEqual(expect.arrayContaining(['Mobile App', 'Virginia', 'Ireland']));
  });

  it('resolves the incident when the latest message state is 400', () => {
    const raw = fixture('statusio-incident-doc-derived.json');
    raw.result.incidents![0]!.messages!.push({
      details: 'Resolved.',
      state: 400,
      status: 100,
      datetime: '2021-12-06T17:00:00.000Z',
    });
    const { incidents } = mapStatusioIncidents(raw, GITLAB);
    expect(incidents[0]!.status).toBe('resolved');
    expect(incidents[0]!.resolved_at).toBe('2021-12-06T17:00:00.000Z');
  });

  it('does not crash on a sparse incident item with omitted fields', () => {
    const raw: StatusioResponse = {
      result: {
        status_overall: { updated: '', status: 'Operational', status_code: 100 },
        incidents: [{}],
      },
    };
    const { incidents } = mapStatusioIncidents(raw, GITLAB);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.status).toBe('investigating');
    expect(incidents[0]!.incident_updates).toHaveLength(0);
  });
});

describe('mapStatusioScheduledMaintenances', () => {
  it('maps active and upcoming maintenance windows with planned times', () => {
    const { scheduled_maintenances } = mapStatusioScheduledMaintenances(
      fixture('statusio-incident-doc-derived.json'),
      GITLAB,
    );
    expect(scheduled_maintenances).toHaveLength(2);
    const active = scheduled_maintenances.find((m) => m.name === 'Network Upgrade')!;
    expect(active.status).toBe('in_progress');
    expect(active.scheduled_for).toBe('2021-12-06T16:50:00.000Z');
    expect(active.scheduled_until).toBe('2021-12-06T17:50:00.000Z');
    const upcoming = scheduled_maintenances.find((m) => m.name === 'Mobile App Upgrade')!;
    expect(upcoming.status).toBe('scheduled');
  });
});

describe('fetchStatusioSummary', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(fixture('statusio-gitlab.json')),
      }),
    );
  });

  it('fetches the hostedstatus endpoint keyed by page ID', async () => {
    const target: StatusioTarget = { ...GITLAB, statusio_page_id: `test-${Date.now()}` };
    const { data, cached } = await fetchStatusioSummary(target);
    expect(cached).toBe(false);
    expect(data.status.indicator).toBe('none');
    const url = vi.mocked(fetch).mock.calls[0]?.[0] as string;
    expect(url).toBe(`https://status-api.hostedstatus.com/1.0/status/${target.statusio_page_id}`);
  });
});
