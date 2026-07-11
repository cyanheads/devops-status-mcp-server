/**
 * @fileoverview Tests for the Firehydrant adapter mappers and fetchers.
 * Fixture: firehydrant-redis.json is a live capture of status.redis.io's
 * /data/payload.json (trimmed to three real incidents — a SEV2 outage, a
 * MAINTENANCE item with affected components, and an UNSET-severity incident;
 * the page was healthy at capture time, so active-incident cases are derived
 * by clearing the resolved timestamp in-test).
 * @module tests/services/status-adapters/firehydrant-adapter.test
 */

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type FirehydrantPayload,
  type FirehydrantTarget,
  fetchFirehydrantSummary,
  mapFirehydrantIncidents,
  mapFirehydrantScheduledMaintenances,
  mapFirehydrantSummary,
} from '@/services/status-adapters/firehydrant-adapter.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    cacheTtlMs: 60_000,
    fetchTimeoutMs: 5000,
    certTimeoutMs: 5000,
    dnsTimeoutMs: 3000,
  }),
}));

function fixture(): FirehydrantPayload {
  return JSON.parse(
    readFileSync(new URL('fixtures/firehydrant-redis.json', import.meta.url), 'utf-8'),
  ) as FirehydrantPayload;
}

const REDIS: FirehydrantTarget = {
  name: 'Redis Cloud',
  url: 'https://status.redis.io',
  slug: 'redis-cloud',
};

/** The captured SEV2 incident ("AWS me-central-1 Zone Issue"). */
const SEV2_ID = '2f3423b7-2311-4f64-a6fa-297daaff63e4';
/** The captured MAINTENANCE incident with affected components. */
const MAINTENANCE_ID = '79a12500-5452-4148-a0e1-d3cbce47dbb1';

function incident(raw: FirehydrantPayload, id: string) {
  const item = raw.incidents?.find((i) => i.id === id);
  if (!item) throw new Error(`fixture incident ${id} missing`);
  return item;
}

describe('mapFirehydrantSummary', () => {
  it('maps a healthy page (all incidents resolved) to indicator none with operational components', () => {
    const summary = mapFirehydrantSummary(fixture(), REDIS);
    expect(summary.status.indicator).toBe('none');
    expect(summary.status.description).toBe('All Systems Operational');
    expect(summary.page.name).toBe('Redis Cloud');
    expect(summary.page.url).toBe('https://status.redis.io');
    expect(summary.components).toHaveLength(6);
    for (const c of summary.components) expect(c.status).toBe('operational');
    expect(summary.incidents).toHaveLength(0);
    expect(summary.scheduled_maintenances).toHaveLength(0);
  });

  it('surfaces an unresolved incident as active and derives the indicator from its severity', () => {
    const raw = fixture();
    delete incident(raw, SEV2_ID).timestamps?.resolved;
    const summary = mapFirehydrantSummary(raw, REDIS);
    expect(summary.status.indicator).toBe('major'); // SEV2
    expect(summary.status.description).toBe('1 active incident');
    expect(summary.incidents).toHaveLength(1);
    expect(summary.incidents[0]!.status).toBe('investigating');
    expect(summary.incidents[0]!.resolved_at).toBeNull();
  });

  it('marks components affected by an active maintenance as under_maintenance', () => {
    const raw = fixture();
    delete incident(raw, MAINTENANCE_ID).timestamps?.resolved;
    const summary = mapFirehydrantSummary(raw, REDIS);
    // Maintenance is not a degradation — indicator stays none.
    expect(summary.status.indicator).toBe('none');
    expect(summary.incidents).toHaveLength(0);
    expect(summary.scheduled_maintenances).toHaveLength(1);
    const admin = summary.components.find((c) => c.name === 'Admin Console');
    expect(admin?.status).toBe('under_maintenance');
    expect(summary.components.some((c) => c.status === 'operational')).toBe(true);
  });

  it('maps severity slugs to indicators (SEV1 critical, SEV2 major, SEV3/SEV4 minor, custom minor)', () => {
    const withSeverity = (severitySlug: string): FirehydrantPayload => ({
      conditions: {},
      components: [],
      incidents: [
        { id: 'x', title: 'x', severitySlug, timestamps: { started: '2026-01-01T00:00:00Z' } },
      ],
    });
    expect(mapFirehydrantSummary(withSeverity('SEV1'), REDIS).status.indicator).toBe('critical');
    expect(mapFirehydrantSummary(withSeverity('SEV2'), REDIS).status.indicator).toBe('major');
    expect(mapFirehydrantSummary(withSeverity('SEV3'), REDIS).status.indicator).toBe('minor');
    expect(mapFirehydrantSummary(withSeverity('SEV4'), REDIS).status.indicator).toBe('minor');
    expect(mapFirehydrantSummary(withSeverity('INVESTIGATION'), REDIS).status.indicator).toBe(
      'minor',
    );
    expect(mapFirehydrantSummary(withSeverity('UNSET'), REDIS).status.indicator).toBe('minor');
  });

  it('canonicalizes component conditions through the page condition table', () => {
    const raw: FirehydrantPayload = {
      conditions: { Broken: 'OFFLINE', Slow: 'DEGRADED' },
      components: [
        { id: 'a', name: 'API' },
        { id: 'b', name: 'Console' },
      ],
      incidents: [
        {
          id: 'x',
          title: 'x',
          severitySlug: 'SEV3',
          timestamps: { started: '2026-01-01T00:00:00Z' },
          components: [
            { id: 'a', name: 'API', condition: 'Broken' },
            { id: 'b', name: 'Console', condition: 'Slow' },
          ],
        },
      ],
    };
    const summary = mapFirehydrantSummary(raw, REDIS);
    expect(summary.components.find((c) => c.id === 'a')?.status).toBe('major_outage');
    expect(summary.components.find((c) => c.id === 'b')?.status).toBe('degraded_performance');
  });
});

describe('mapFirehydrantIncidents', () => {
  it('maps the captured SEV2 incident with sorted updates and excludes maintenance items', () => {
    const { incidents } = mapFirehydrantIncidents(fixture(), REDIS);
    expect(incidents.map((i) => i.id)).not.toContain(MAINTENANCE_ID);
    const inc = incidents.find((i) => i.id === SEV2_ID);
    expect(inc).toBeDefined();
    expect(inc!.name).toBe('AWS me-central-1 Zone Issue');
    expect(inc!.impact).toBe('major');
    expect(inc!.status).toBe('resolved');
    expect(inc!.created_at).toBe('2026-03-01T14:33:58Z');
    expect(inc!.resolved_at).toBe('2026-03-03T21:29:30Z');
    expect(inc!.incident_updates).toHaveLength(6);
    // Sorted ascending by occurredAt — every update carries the note body.
    const times = inc!.incident_updates.map((u) => new Date(u.created_at).getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(inc!.incident_updates.every((u) => u.body.length > 0)).toBe(true);
  });

  it('returns the full incident history newest first, uncapped (#22)', () => {
    // Regression for #22: the adapter used to .slice(0, 50), discarding older
    // history before the tool could window or disclose it. The full list must
    // reach the tool so devops_get_incidents can page through it via offset.
    const raw: FirehydrantPayload = {
      incidents: Array.from({ length: 60 }, (_, i) => ({
        id: `inc-${i}`,
        title: `Incident ${i}`,
        severitySlug: 'SEV4',
        timestamps: {
          started: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString(),
          resolved: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000 + 3_600_000).toISOString(),
        },
      })),
    };
    const { incidents } = mapFirehydrantIncidents(raw, REDIS);
    expect(incidents).toHaveLength(60); // all 60 reach the tool — nothing capped upstream
    expect(incidents[0]!.id).toBe('inc-59'); // newest first
    expect(incidents[59]!.id).toBe('inc-0'); // oldest retained, not dropped
  });

  it('extracts nested BulkImpactUpdate notes and drops note-less milestone entries', () => {
    // The captured SEV4 incident's timeline is all BulkImpactUpdate events:
    // two carry a nested { note: { note } } body, two are milestone-only.
    const { incidents } = mapFirehydrantIncidents(fixture(), REDIS);
    const inc = incidents.find((i) => i.id === 'e192b971-a298-45cd-b574-627923f0170b');
    expect(inc).toBeDefined();
    expect(inc!.incident_updates).toHaveLength(2);
    expect(inc!.incident_updates[0]!.body).toContain('currently investigating network issues');
    expect(inc!.incident_updates[1]!.body).toContain('Resolved');
  });

  it('does not crash on a sparse incident with omitted fields', () => {
    const { incidents } = mapFirehydrantIncidents({ incidents: [{}] }, REDIS);
    expect(incidents).toHaveLength(1);
    // No resolved timestamp — treated as active.
    expect(incidents[0]!.status).toBe('investigating');
    expect(incidents[0]!.incident_updates).toHaveLength(0);
  });
});

describe('mapFirehydrantScheduledMaintenances', () => {
  it('drops resolved maintenance history', () => {
    const { scheduled_maintenances } = mapFirehydrantScheduledMaintenances(fixture(), REDIS);
    expect(scheduled_maintenances).toHaveLength(0);
  });

  it('maps an unresolved maintenance as in_progress (past start) with affected components', () => {
    const raw = fixture();
    delete incident(raw, MAINTENANCE_ID).timestamps?.resolved;
    const { scheduled_maintenances } = mapFirehydrantScheduledMaintenances(raw, REDIS);
    expect(scheduled_maintenances).toHaveLength(1);
    const m = scheduled_maintenances[0]!;
    expect(m.status).toBe('in_progress');
    expect(m.impact).toBe('none');
    expect(m.scheduled_for).toBe('2026-02-24T04:52:19Z');
    const affected = m.incident_updates.at(-1)?.affected_components?.map((a) => a.name);
    expect(affected).toEqual(expect.arrayContaining(['Admin Console', 'REST API']));
  });

  it('maps a future-start maintenance as scheduled', () => {
    const raw = fixture();
    const item = incident(raw, MAINTENANCE_ID);
    delete item.timestamps?.resolved;
    item.timestamps!.started = new Date(Date.now() + 86_400_000).toISOString();
    const { scheduled_maintenances } = mapFirehydrantScheduledMaintenances(raw, REDIS);
    expect(scheduled_maintenances[0]!.status).toBe('scheduled');
  });
});

describe('fetchFirehydrantSummary', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(fixture()),
      }),
    );
  });

  it('fetches /data/payload.json off the page base URL', async () => {
    const target: FirehydrantTarget = { ...REDIS, url: `https://status.example.com/${Date.now()}` };
    const { data, cached } = await fetchFirehydrantSummary(target);
    expect(cached).toBe(false);
    expect(data.status.indicator).toBe('none');
    const url = vi.mocked(fetch).mock.calls[0]?.[0] as string;
    expect(url).toBe(`${target.url}/data/payload.json`);
  });
});
