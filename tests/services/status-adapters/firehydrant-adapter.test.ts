/**
 * @fileoverview Tests for the Firehydrant adapter mappers and fetchers.
 * Fixture: firehydrant-redis.json is a live capture of status.redis.io's
 * /data/payload.json (trimmed to four real incidents — a SEV2 outage, a
 * MAINTENANCE item with affected components, an UNSET-severity incident, and a
 * SEV4 incident whose timeline is BulkImpactUpdate events; the page was healthy
 * at capture time, so active-incident cases are derived by clearing the
 * resolved timestamp in-test).
 * @module tests/services/status-adapters/firehydrant-adapter.test
 */

import { readFileSync } from 'node:fs';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type FirehydrantPayload,
  type FirehydrantTarget,
  fetchFirehydrantIncidents,
  fetchFirehydrantScheduledMaintenances,
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
  const item = raw.incidents.find((i) => i.id === id);
  if (!item) throw new Error(`fixture incident ${id} missing`);
  return item;
}

/** The fixed clock for maintenance-window cases, and a start on either side of it. */
const NOW = new Date('2026-10-30T12:00:00Z');
const PAST = '2026-10-30T11:00:00Z';
const FUTURE = '2026-11-06T12:00:00Z';

/** Fix `Date` (only) at NOW for the enclosing describe, so "started" turns on timestamps alone. */
function useFixedClock() {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
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
    expect(summary.incidents![0]!.status).toBe('investigating');
    expect(summary.incidents![0]!.resolved_at).toBeNull();
  });

  it('marks components affected by an active maintenance as under_maintenance', () => {
    const raw = fixture();
    delete incident(raw, MAINTENANCE_ID).timestamps?.resolved;
    const summary = mapFirehydrantSummary(raw, REDIS);
    // A started, unresolved window with no active incident is the maintenance state (#79).
    expect(summary.status).toEqual({
      indicator: 'maintenance',
      description: '1 maintenance window in progress',
    });
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

describe('mapFirehydrantSummary maintenance windows (#79)', () => {
  useFixedClock();

  /** One API component and one unresolved MAINTENANCE item touching it. */
  const windowPayload = (
    timestamps: NonNullable<FirehydrantPayload['incidents'][number]['timestamps']>,
  ): FirehydrantPayload => ({
    conditions: { Maintenance: 'DEGRADED' },
    components: [{ id: 'a', name: 'API' }],
    incidents: [
      {
        id: 'm',
        title: 'Upgrade',
        severitySlug: 'MAINTENANCE',
        timestamps,
        components: [{ id: 'a', name: 'API', condition: 'Maintenance' }],
      },
    ],
  });

  it('lets an active incident outrank an in-progress window', () => {
    const raw = fixture();
    delete incident(raw, MAINTENANCE_ID).timestamps?.resolved;
    delete incident(raw, SEV2_ID).timestamps?.resolved;
    const summary = mapFirehydrantSummary(raw, REDIS);
    expect(summary.status).toEqual({ indicator: 'major', description: '1 active incident' });
    expect(summary.scheduled_maintenances?.map((m) => m.status)).toEqual(['in_progress']);
  });

  it('keeps a window that has not started out of the indicator and component statuses', () => {
    const raw = fixture();
    const item = incident(raw, MAINTENANCE_ID);
    item.timestamps = { started: FUTURE, detected: FUTURE };
    const summary = mapFirehydrantSummary(raw, REDIS);
    expect(summary.status).toEqual({ indicator: 'none', description: 'All Systems Operational' });
    for (const c of summary.components) expect(c.status).toBe('operational');
    expect(summary.scheduled_maintenances?.map((m) => m.status)).toEqual(['scheduled']);
  });

  /**
   * One start test — `timestamps.started`, else `detected`, not after now — decides the
   * window's list status, its components, and the indicator together.
   */
  it.each([
    ['started an hour ago', { started: PAST }, 'in_progress', 'under_maintenance', 'maintenance'],
    ['starting next week', { started: FUTURE }, 'scheduled', 'operational', 'none'],
    [
      'detected an hour ago (no started)',
      { detected: PAST },
      'in_progress',
      'under_maintenance',
      'maintenance',
    ],
    ['detected next week (no started)', { detected: FUTURE }, 'scheduled', 'operational', 'none'],
    [
      'starting next week, detected earlier',
      { started: FUTURE, detected: PAST },
      'scheduled',
      'operational',
      'none',
    ],
  ] as const)(
    'reads a window %s the same way everywhere',
    (_label, timestamps, listStatus, componentStatus, indicator) => {
      const raw = windowPayload(timestamps);
      const summary = mapFirehydrantSummary(raw, REDIS);
      expect(summary.scheduled_maintenances?.map((m) => m.status)).toEqual([listStatus]);
      expect(summary.components.map((c) => c.status)).toEqual([componentStatus]);
      expect(summary.status.indicator).toBe(indicator);
      const { scheduled_maintenances } = mapFirehydrantScheduledMaintenances(raw, REDIS);
      expect(scheduled_maintenances.map((m) => m.status)).toEqual([listStatus]);
    },
  );

  it('counts every in-progress window in the description', () => {
    const raw = windowPayload({ started: PAST });
    raw.incidents.push({
      id: 'm2',
      title: 'Second',
      severitySlug: 'MAINTENANCE',
      timestamps: { started: PAST },
    });
    expect(mapFirehydrantSummary(raw, REDIS).status).toEqual({
      indicator: 'maintenance',
      description: '2 maintenance windows in progress',
    });
  });

  /** An outage outranks a window on a component both name, whichever the payload lists first. */
  it.each([
    ['incident first', false],
    ['window first', true],
  ])('rates a shared component by the active incident (%s)', (_label, windowFirst) => {
    const raw = windowPayload({ started: PAST });
    raw.components.push({ id: 'b', name: 'Console' });
    raw.incidents[0]!.components!.push({ id: 'b', name: 'Console', condition: 'Maintenance' });
    raw.conditions = { ...raw.conditions, Broken: 'OFFLINE' };
    const outage = {
      id: 'x',
      title: 'API down',
      severitySlug: 'SEV3',
      timestamps: { started: PAST },
      components: [{ id: 'a', name: 'API', condition: 'Broken' }],
    };
    if (windowFirst) raw.incidents.push(outage);
    else raw.incidents.unshift(outage);
    const summary = mapFirehydrantSummary(raw, REDIS);
    expect(summary.components.map((c) => [c.name, c.status])).toEqual([
      ['API', 'major_outage'],
      ['Console', 'under_maintenance'],
    ]);
    expect(summary.status.indicator).toBe('minor');
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
      components: [],
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
    const { incidents } = mapFirehydrantIncidents({ components: [], incidents: [{}] }, REDIS);
    expect(incidents).toHaveLength(1);
    // No resolved timestamp — treated as active.
    expect(incidents[0]!.status).toBe('investigating');
    expect(incidents[0]!.incident_updates).toHaveLength(0);
  });

  /**
   * A note recorded from status.redis.io opens an anchor and never closes it; the
   * markdown notes the fixture captures carry no HTML and must come back unchanged.
   */
  it('renders an HTML note as plain text and leaves a markdown note unchanged (#63)', () => {
    const raw = fixture();
    const markdownNotes = (mapFirehydrantIncidents(raw, REDIS).incidents ?? []).flatMap((i) =>
      i.incident_updates.map((u) => u.body),
    );
    const { incidents } = mapFirehydrantIncidents(
      {
        components: [],
        incidents: [
          {
            id: 'html',
            timestamps: { started: '2026-05-13T18:00:00Z', resolved: '2026-05-13T18:50:45Z' },
            timeline: [
              {
                occurredAt: '2026-05-13T18:50:45Z',
                details: {
                  note: 'The issue has been fully resolved. Should you encounter any remaining issues, please contact our support team via our <a href="https://support.redislabs.com/hc/en-us/requests/new">support portal.\n\nThank you for your patience.',
                },
              },
            ],
          },
        ],
      },
      REDIS,
    );
    expect(incidents[0]!.incident_updates[0]!.body).toBe(
      [
        'The issue has been fully resolved. Should you encounter any remaining issues, please contact our support team via our support portal.',
        'Thank you for your patience. (https://support.redislabs.com/hc/en-us/requests/new)',
      ].join('\n'),
    );

    const sources = (raw.incidents ?? []).flatMap((i) =>
      (i.timeline ?? []).map((e) =>
        typeof e.details?.note === 'string' ? e.details.note : (e.details?.note?.note ?? ''),
      ),
    );
    expect(markdownNotes.length).toBeGreaterThan(0);
    for (const body of markdownNotes) expect(sources).toContain(body);
  });
});

describe('mapFirehydrantScheduledMaintenances', () => {
  useFixedClock();

  /** The newest MAINTENANCE record on status.redis.io as of 2026-10-30, trimmed to what the mapper reads. */
  const RECORDED_WINDOW = {
    id: '8f78fc33-be82-42e7-9550-8313bb84ed24',
    title: 'Redis Cloud – Temporary Connectivity Issues to Admin Console',
    severitySlug: 'MAINTENANCE',
    timestamps: {
      started: '2026-06-28T08:52:09Z',
      detected: '2026-06-28T08:52:09Z',
      resolved: '2026-06-28T09:09:12Z',
    },
    components: [{ name: 'Admin Console', condition: 'Maintenance' }],
  };

  /** The fixture plus an in-progress, the recorded completed, and an upcoming window — in no date order. */
  function mixedWindows(): FirehydrantPayload {
    const raw = fixture();
    raw.incidents.push(
      { id: 'now', title: 'Now', severitySlug: 'MAINTENANCE', timestamps: { started: PAST } },
      RECORDED_WINDOW,
      { id: 'next', title: 'Next', severitySlug: 'MAINTENANCE', timestamps: { started: FUTURE } },
    );
    return raw;
  }

  it('keeps the resolved maintenance item as a completed window, out of the summary (#85)', () => {
    const raw = fixture();
    const { scheduled_maintenances } = mapFirehydrantScheduledMaintenances(raw, REDIS);
    expect(scheduled_maintenances.map((m) => [m.id, m.status, m.resolved_at])).toEqual([
      [MAINTENANCE_ID, 'completed', '2026-02-24T04:52:19Z'],
    ]);
    expect(scheduled_maintenances[0]!.scheduled_for).toBe('2026-02-24T04:52:19Z');
    expect(mapFirehydrantSummary(raw, REDIS).scheduled_maintenances).toEqual([]);
  });

  it('lists every window newest first — upcoming, in progress, then completed (#85)', () => {
    const { scheduled_maintenances } = mapFirehydrantScheduledMaintenances(mixedWindows(), REDIS);
    expect(scheduled_maintenances.map((m) => [m.id, m.status])).toEqual([
      ['next', 'scheduled'],
      ['now', 'in_progress'],
      [RECORDED_WINDOW.id, 'completed'],
      [MAINTENANCE_ID, 'completed'],
    ]);
    const recorded = scheduled_maintenances[2]!;
    expect(recorded.resolved_at).toBe('2026-06-28T09:09:12Z');
    expect(recorded.scheduled_for).toBe('2026-06-28T08:52:09Z');
  });

  it('leaves completed windows out of the summary list, its components, and its indicator (#85)', () => {
    const summary = mapFirehydrantSummary(mixedWindows(), REDIS);
    expect(summary.scheduled_maintenances?.map((m) => [m.id, m.status])).toEqual([
      ['next', 'scheduled'],
      ['now', 'in_progress'],
    ]);
    // Only the in-progress window rates, and it names no component.
    expect(summary.status).toEqual({
      indicator: 'maintenance',
      description: '1 maintenance window in progress',
    });
    for (const c of summary.components) expect(c.status).toBe('operational');
  });

  /** The payload carries no planned end, so no window — upcoming, in progress, or completed — gets one. */
  it('leaves scheduled_until unset on every window, on both lists (#91)', () => {
    const raw = mixedWindows();
    const { scheduled_maintenances } = mapFirehydrantScheduledMaintenances(raw, REDIS);
    const summary = mapFirehydrantSummary(raw, REDIS).scheduled_maintenances ?? [];
    expect(scheduled_maintenances.map((m) => m.status)).toEqual([
      'scheduled',
      'in_progress',
      'completed',
      'completed',
    ]);
    expect(summary).toHaveLength(2);
    for (const m of [...scheduled_maintenances, ...summary]) {
      expect(m.scheduled_for).toBe(m.created_at);
      expect(Object.hasOwn(m, 'scheduled_until')).toBe(false);
    }
  });

  it('puts every payload record in exactly one of the incident and maintenance lists (#85)', () => {
    const raw = mixedWindows();
    const ids = [
      ...mapFirehydrantIncidents(raw, REDIS).incidents,
      ...mapFirehydrantScheduledMaintenances(raw, REDIS).scheduled_maintenances,
    ].map((i) => i.id);
    expect(ids.sort()).toEqual(raw.incidents.map((i) => i.id).sort());
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

/**
 * A body without the payload envelope is some other document — an error envelope, a
 * placeholder — never an all-clear. The check runs in the fetch's parse step, so a
 * rejected body never reaches the response cache (#78).
 */
describe('payload envelope (#78)', () => {
  const http = createFetchMock();
  let pages = 0;
  /** A page no other case has fetched, so the shared response cache holds nothing for it. */
  const freshPage = (): { target: FirehydrantTarget; feed: string } => {
    const url = `https://status-envelope-${++pages}.example.com`;
    return { target: { ...REDIS, url }, feed: `${url}/data/payload.json` };
  };

  beforeEach(() => {
    http.reset();
    http.install();
  });

  afterEach(() => {
    http.restore();
  });

  it.each([
    ['an error envelope', { error: 'upstream payload unavailable' }],
    ['an empty object', {}],
    ['incidents without components', { incidents: [] }],
    ['components without incidents', { components: [] }],
    ['a top-level array', []],
    ['null', null],
  ])('rejects %s as statuspage_unavailable naming the feed URL', async (_label, body) => {
    const { target, feed } = freshPage();
    http.route({ match: feed, respond: () => Response.json(body) });
    const err = await fetchFirehydrantSummary(target).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect((err as McpError).data).toMatchObject({ reason: 'statuspage_unavailable', url: feed });
  });

  it.each([
    ['incidents', fetchFirehydrantIncidents],
    ['scheduled maintenances', fetchFirehydrantScheduledMaintenances],
  ] as const)('fails the %s read on the same check', async (_label, fetcher) => {
    const { target, feed } = freshPage();
    http.route({ match: feed, respond: () => Response.json({ error: 'x' }) });
    await expect(fetcher(target)).rejects.toMatchObject({
      data: { reason: 'statuspage_unavailable', url: feed },
    });
  });

  it('caches nothing from a rejected body — the valid body served next is read on the following call', async () => {
    const { target, feed } = freshPage();
    const raw = fixture();
    delete incident(raw, SEV2_ID).timestamps?.resolved;
    http.route(
      { match: feed, once: true, respond: () => Response.json({ error: 'x' }) },
      { match: feed, respond: () => Response.json(raw) },
    );
    await expect(fetchFirehydrantSummary(target)).rejects.toMatchObject({
      data: { reason: 'statuspage_unavailable' },
    });
    const { data, cached } = await fetchFirehydrantSummary(target);
    expect(cached).toBe(false);
    expect(data.status.indicator).toBe('major');
    expect(http.calls).toHaveLength(2);
  });

  it('reads the bare envelope as all clear and still maps a sparse item inside it', async () => {
    const empty = freshPage();
    http.route({
      match: empty.feed,
      respond: () => Response.json({ incidents: [], components: [] }),
    });
    const { data: summary } = await fetchFirehydrantSummary(empty.target);
    expect(summary.status).toEqual({ indicator: 'none', description: 'All Systems Operational' });

    const sparse = freshPage();
    http.route({
      match: sparse.feed,
      respond: () => Response.json({ incidents: [{}], components: [] }),
    });
    const { data: list } = await fetchFirehydrantIncidents(sparse.target);
    expect(list.incidents.map((i) => [i.id, i.status])).toEqual([['unknown', 'investigating']]);
  });
});
