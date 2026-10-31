/**
 * @fileoverview Tests for the Datadog adapter mappers and fetchers (#90).
 * Fixture: datadog-us1.json is a live capture of status.datadoghq.com/config.json taken
 * 2026-10-31, trimmed to its 40 components and seven real incidents — peaks of
 * partial_outage, major_outage, degraded, and operational only, one with an HTML update
 * body, one from 2017-04-24 with no component status recorded, and the page's oldest
 * (2014-03-19) — with the base64 logo and favicon removed. `maintenances` is null, as on
 * every Datadog page at capture time.
 *
 * No Datadog page carried an open incident, a degraded component, a component group, a
 * maintenance window, or a deleted update on 2026-10-31, so those are built in-test: an
 * open incident by reopening a captured one at an earlier update, a degraded component by
 * setting a captured component's status, and the group, window, and deleted-update
 * shapes from the page bundle's own parser and demo data.
 * @module tests/services/status-adapters/datadog-adapter.test
 */

import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type DatadogConfig,
  type DatadogTarget,
  fetchDatadogIncidents,
  fetchDatadogScheduledMaintenances,
  fetchDatadogSummary,
  mapDatadogIncidents,
  mapDatadogScheduledMaintenances,
  mapDatadogSummary,
} from '@/services/status-adapters/datadog-adapter.js';
import { clearFetchCache, fetchCacheStats } from '@/utils/cached-fetch.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    cacheTtlMs: 60_000,
    fetchTimeoutMs: 5000,
    certTimeoutMs: 5000,
    dnsTimeoutMs: 3000,
  }),
}));

type Incident = DatadogConfig['incidents'][number];
type Maintenance = NonNullable<DatadogConfig['maintenances']>[number];

function fixture(): DatadogConfig {
  return JSON.parse(
    readFileSync(new URL('fixtures/datadog-us1.json', import.meta.url), 'utf-8'),
  ) as DatadogConfig;
}

const US1: DatadogTarget = {
  name: 'Datadog US1',
  url: 'https://status.datadoghq.com',
  slug: 'datadog',
};
const FEED = 'https://status.datadoghq.com/config.json';

// The captured incidents, newest first as the page lists them.
const METRICS_ID = '21ae57fe-1a8a-489c-b86e-88ae90b4b9f1'; // peak partial_outage, 2026-10-28
const WORKFLOW_ID = '0cefa72b-8a25-4b40-a133-765f875c6ebd'; // peak major_outage, 2026-10-26
const SERVICE_CHECK_ID = '446172d4-2819-5238-8208-323f6248b5e5'; // peak degraded
const NOTIFICATIONS_ID = 'c5c2c0ea-db68-5758-af0c-fc302cc76efe'; // operational only
const AGENTS_ID = '5862fb64-0ad8-5012-8864-f39bac3b5537'; // an HTML update body, 2020
const EMPTY_GRAPHS_ID = '57f4985c-381c-563f-ae78-270b16753b61'; // 2017-04-24, no status recorded
const OLDEST_ID = '6650262c-b424-5847-a642-258714eaa859'; // 2014-03-19

const MONITORS = 'e727cd93-80f6-4b7a-b8a1-54b784578288';
const METRICS_COMPONENT = 'd8c43023-2ad0-4d96-9b5f-9049a1e67a59';

function incident(raw: DatadogConfig, id: string): Incident {
  const item = raw.incidents.find((i) => i.id === id);
  if (!item) throw new Error(`fixture incident ${id} missing`);
  return item;
}

/**
 * The captured incident as it stood at an earlier update: open, at that update's status,
 * with only the updates up to it. The page lists updates newest first, so `fromIndex` is
 * the position of the update that is newest once reopened.
 */
function reopen(raw: DatadogConfig, id: string, fromIndex: number): Incident {
  const item = incident(raw, id);
  item.timeline = item.timeline!.slice(fromIndex);
  item.resolved = false;
  item.currentStatus = item.timeline[0]!.status!;
  delete item.resolvedDate;
  return item;
}

/** A window in the page bundle's shape — its updates carry `createdAt` but no `startedAt`. */
function window(
  id: string,
  currentStatus: string,
  startDate: string,
  completedDate?: string,
): Maintenance {
  return {
    id,
    title: `Window ${id}`,
    currentStatus,
    publishedDate: '2026-10-20T09:00:00Z',
    startDate,
    ...(completedDate && { completedDate }),
    timeline: [
      {
        componentsAffected: [{ id: MONITORS, name: 'Monitors', status: 'maintenance' }],
        createdAt: '2026-10-20T09:00:00Z',
        description: 'We will be performing scheduled maintenance on <b>Monitors</b>.',
        id: `${id}-tl-1`,
        status: 'scheduled',
      },
    ],
  };
}

describe('mapDatadogSummary', () => {
  it('reads the captured page as all clear: 40 operational components, nothing open', () => {
    const summary = mapDatadogSummary(fixture(), US1);
    expect(summary.page).toEqual({
      id: 'datadog',
      name: 'Datadog US1',
      updated_at: '',
      url: 'https://status.datadoghq.com',
    });
    expect(summary.status).toEqual({ indicator: 'none', description: 'All Systems Operational' });
    expect(summary.components).toHaveLength(40);
    expect(summary.components[0]).toEqual({
      id: '160c87ae-0269-4f83-a471-7dec9c4e3514',
      name: 'APM',
      status: 'operational',
      created_at: '',
      updated_at: '',
      group: false,
      group_id: null,
      position: 0,
    });
    expect(summary.components.at(-1)?.name).toBe('www.datadoghq.com');
    for (const c of summary.components) expect(c.status).toBe('operational');
    expect(summary.incidents).toEqual([]);
    expect(summary.scheduled_maintenances).toEqual([]);
  });

  it('lists an open incident whose latest update is partial_outage as active, rated major', () => {
    const raw = fixture();
    reopen(raw, METRICS_ID, 4); // the 16:56 update: still investigating
    const summary = mapDatadogSummary(raw, US1);
    expect(summary.status).toEqual({ indicator: 'major', description: '1 active incident' });
    expect(summary.incidents?.map((i) => [i.id, i.status, i.impact, i.resolved_at])).toEqual([
      [METRICS_ID, 'investigating', 'major', null],
    ]);
    const latest = summary.incidents![0]!.incident_updates[0]!;
    expect(latest.created_at).toBe('2026-10-28T16:56:24.237747Z');
    expect(latest.affected_components?.find((c) => c.code === METRICS_COMPONENT)?.new_status).toBe(
      'partial_outage',
    );
  });

  /** Peak, not latest: an incident keeps the worst rating any of its updates recorded. */
  it('rates an open incident by the worst status recorded, past an update that recorded none', () => {
    const raw = fixture();
    const item = reopen(raw, WORKFLOW_ID, 2); // newest update records no component
    expect(item.timeline![0]).not.toHaveProperty('componentsAffected');
    const summary = mapDatadogSummary(raw, US1);
    expect(summary.status).toEqual({ indicator: 'critical', description: '1 active incident' });
    expect(summary.incidents?.[0]?.impact).toBe('critical');
  });

  it('rates an open incident with no component status recorded as minor', () => {
    const raw = fixture();
    reopen(raw, EMPTY_GRAPHS_ID, 1);
    const summary = mapDatadogSummary(raw, US1);
    expect(summary.status).toEqual({ indicator: 'minor', description: '1 active incident' });
    expect(summary.incidents?.map((i) => [i.id, i.impact, i.status])).toEqual([
      [EMPTY_GRAPHS_ID, 'minor', 'monitoring'],
    ]);
  });

  it('rates the vendor minor on a degraded component with no open incident', () => {
    const raw = fixture();
    raw.components.find((c) => c.id === MONITORS)!.status = 'degraded';
    const summary = mapDatadogSummary(raw, US1);
    expect(summary.status).toEqual({ indicator: 'minor', description: '1 degraded component' });
    expect(summary.components.filter((c) => c.status !== 'operational')).toEqual([
      expect.objectContaining({ id: MONITORS, name: 'Monitors', status: 'degraded_performance' }),
    ]);
    expect(summary.incidents).toEqual([]);
  });

  /** Each component status Datadog publishes, and one it does not, onto the Statuspage ladder. */
  it.each([
    ['operational', 'operational', 'none'],
    ['degraded', 'degraded_performance', 'minor'],
    ['partial_outage', 'partial_outage', 'major'],
    ['major_outage', 'major_outage', 'critical'],
    ['maintenance', 'under_maintenance', 'none'],
    ['elevated_errors', 'degraded_performance', 'minor'],
    [undefined, 'degraded_performance', 'minor'],
  ])('maps component status %s to %s, rating the page %s', (status, mapped, indicator) => {
    const raw: DatadogConfig = {
      components: [{ id: 'c', name: 'API', type: 'Component', ...(status && { status }) }],
      incidents: [],
      maintenances: null,
    };
    const summary = mapDatadogSummary(raw, US1);
    expect(summary.components.map((c) => c.status)).toEqual([mapped]);
    expect(summary.status.indicator).toBe(indicator);
  });

  it('rates the page by the worse of its components and its open incidents', () => {
    const raw = fixture();
    reopen(raw, SERVICE_CHECK_ID, 1); // degraded → minor
    raw.components.find((c) => c.id === METRICS_COMPONENT)!.status = 'major_outage';
    const summary = mapDatadogSummary(raw, US1);
    expect(summary.status).toEqual({ indicator: 'critical', description: '1 active incident' });
    expect(summary.incidents?.[0]?.impact).toBe('minor');
  });

  /**
   * A ComponentGroup item nests its leaves and carries no status; read as a component it
   * would map through the unknown-value rule and fake a degradation.
   */
  describe('component groups', () => {
    const grouped = (): DatadogConfig => ({
      components: [
        {
          id: 'g-americas',
          name: 'Americas',
          type: 'ComponentGroup',
          components: [
            { id: 'a-dash', name: 'Dashboard', status: 'operational' },
            { id: 'a-checkout', name: 'Checkout', status: 'partial_outage' },
            { id: 'a-api', name: 'API', status: 'degraded' },
          ],
        },
        { id: 'website', name: 'Website', status: 'operational', type: 'Component' },
        {
          id: 'g-retired',
          name: 'Legacy Reporting (retired)',
          type: 'ComponentGroup',
          components: [],
        },
      ],
      incidents: [],
      maintenances: null,
    });

    it('emits each group followed by its leaves, the leaves naming it as their group', () => {
      const { components } = mapDatadogSummary(grouped(), US1);
      expect(components.map((c) => [c.id, c.name, c.group, c.group_id, c.position])).toEqual([
        ['g-americas', 'Americas', true, null, 0],
        ['a-dash', 'Dashboard', false, 'g-americas', 1],
        ['a-checkout', 'Checkout', false, 'g-americas', 2],
        ['a-api', 'API', false, 'g-americas', 3],
        ['website', 'Website', false, null, 4],
        ['g-retired', 'Legacy Reporting (retired)', true, null, 5],
      ]);
    });

    it('gives a group the worst status of its leaves, and an empty group operational', () => {
      const { components } = mapDatadogSummary(grouped(), US1);
      expect(components.filter((c) => c.group).map((c) => [c.name, c.status])).toEqual([
        ['Americas', 'partial_outage'],
        ['Legacy Reporting (retired)', 'operational'],
      ]);
    });

    it('rates and counts the leaves alone', () => {
      expect(mapDatadogSummary(grouped(), US1).status).toEqual({
        indicator: 'major',
        description: '2 degraded components',
      });
      const healthy = grouped();
      for (const leaf of healthy.components[0]!.components!) leaf.status = 'operational';
      expect(mapDatadogSummary(healthy, US1).status).toEqual({
        indicator: 'none',
        description: 'All Systems Operational',
      });
    });
  });
});

describe('maintenance windows', () => {
  const IN_PROGRESS = window('now', 'in_progress', '2026-10-31T10:00:00Z', '2026-10-31T14:00:00Z');
  const SCHEDULED = window('next', 'scheduled', '2026-11-07T10:00:00Z', '2026-11-07T12:00:00Z');
  const COMPLETED = window('done', 'completed', '2026-10-24T10:00:00Z', '2026-10-24T11:30:00Z');
  const CANCELED = window('off', 'canceled', '2026-11-14T10:00:00Z', '2026-11-14T12:00:00Z');

  function withWindows(...windows: Maintenance[]): DatadogConfig {
    const raw = fixture();
    raw.maintenances = structuredClone(windows);
    return raw;
  }

  it('reads an in_progress window with nothing else wrong as maintenance', () => {
    const summary = mapDatadogSummary(withWindows(IN_PROGRESS), US1);
    expect(summary.status).toEqual({
      indicator: 'maintenance',
      description: '1 maintenance window in progress',
    });
    expect(summary.scheduled_maintenances?.map((m) => [m.id, m.status])).toEqual([
      ['now', 'in_progress'],
    ]);
  });

  it('leaves the indicator none for a scheduled window', () => {
    const summary = mapDatadogSummary(withWindows(SCHEDULED), US1);
    expect(summary.status).toEqual({ indicator: 'none', description: 'All Systems Operational' });
    expect(summary.scheduled_maintenances?.map((m) => [m.id, m.status])).toEqual([
      ['next', 'scheduled'],
    ]);
  });

  it('lets an open incident outrank an in_progress window', () => {
    const raw = withWindows(IN_PROGRESS);
    reopen(raw, METRICS_ID, 4);
    const summary = mapDatadogSummary(raw, US1);
    expect(summary.status).toEqual({ indicator: 'major', description: '1 active incident' });
    expect(summary.scheduled_maintenances?.map((m) => m.status)).toEqual(['in_progress']);
  });

  it('lists a canceled window nowhere', () => {
    const raw = withWindows(CANCELED);
    const summary = mapDatadogSummary(raw, US1);
    expect(summary.status).toEqual({ indicator: 'none', description: 'All Systems Operational' });
    expect(summary.scheduled_maintenances).toEqual([]);
    expect(mapDatadogScheduledMaintenances(raw, US1).scheduled_maintenances).toEqual([]);
    expect(mapDatadogIncidents(raw, US1).incidents.map((i) => i.id)).not.toContain('off');
  });

  it('lists every window not canceled newest start first, the summary only those not completed', () => {
    const raw = withWindows(COMPLETED, CANCELED, IN_PROGRESS, SCHEDULED);
    const { scheduled_maintenances } = mapDatadogScheduledMaintenances(raw, US1);
    expect(scheduled_maintenances.map((m) => [m.id, m.status])).toEqual([
      ['next', 'scheduled'],
      ['now', 'in_progress'],
      ['done', 'completed'],
    ]);
    expect(mapDatadogSummary(raw, US1).scheduled_maintenances?.map((m) => m.id)).toEqual([
      'next',
      'now',
    ]);
  });

  it('maps a window: start and planned end, resolved only once completed, updates by createdAt', () => {
    const { scheduled_maintenances } = mapDatadogScheduledMaintenances(
      withWindows(IN_PROGRESS, COMPLETED),
      US1,
    );
    const [now, done] = scheduled_maintenances;
    expect(now).toEqual({
      id: 'now',
      name: 'Window now',
      impact: 'none',
      status: 'in_progress',
      created_at: '2026-10-20T09:00:00Z',
      started_at: '2026-10-31T10:00:00Z',
      resolved_at: null,
      monitoring_at: null,
      page_id: 'datadog',
      components: [],
      scheduled_for: '2026-10-31T10:00:00Z',
      scheduled_until: '2026-10-31T14:00:00Z',
      incident_updates: [
        {
          id: 'now-tl-1',
          body: 'We will be performing scheduled maintenance on Monitors.',
          status: 'scheduled',
          created_at: '2026-10-20T09:00:00Z',
          display_at: '2026-10-20T09:00:00Z',
          affected_components: [
            { code: MONITORS, name: 'Monitors', new_status: 'under_maintenance', old_status: '' },
          ],
        },
      ],
    });
    expect([done?.status, done?.resolved_at, done?.scheduled_until]).toEqual([
      'completed',
      '2026-10-24T11:30:00Z',
      '2026-10-24T11:30:00Z',
    ]);
  });

  it('leaves scheduled_until unset on a window that publishes no end', () => {
    const open = window('open-ended', 'in_progress', '2026-10-31T10:00:00Z');
    const [m] = mapDatadogScheduledMaintenances(withWindows(open), US1).scheduled_maintenances;
    expect(m?.scheduled_for).toBe('2026-10-31T10:00:00Z');
    expect(Object.hasOwn(m!, 'scheduled_until')).toBe(false);
  });
});

describe('mapDatadogIncidents', () => {
  it('returns the whole captured history newest first, oldest 2014-03-19', () => {
    const { page, incidents } = mapDatadogIncidents(fixture(), US1);
    expect(page.name).toBe('Datadog US1');
    expect(incidents.map((i) => [i.id, i.created_at])).toEqual([
      [METRICS_ID, '2026-10-28T16:10:14.685871Z'],
      [WORKFLOW_ID, '2026-10-26T17:26:42.005771Z'],
      [SERVICE_CHECK_ID, '2026-07-30T07:44:26.506Z'],
      [NOTIFICATIONS_ID, '2024-07-24T14:16:10.139Z'],
      [AGENTS_ID, '2020-05-30T11:50:31.478Z'],
      [EMPTY_GRAPHS_ID, '2017-04-24T22:21:52.126Z'],
      [OLDEST_ID, '2014-03-19T16:55:03.908Z'],
    ]);
    for (const i of incidents) {
      expect(i.status).toBe('resolved');
      expect(i.started_at).toBe(i.created_at);
      expect(i.resolved_at).not.toBeNull();
    }
  });

  it('rates each captured incident by the worst status any update recorded', () => {
    const { incidents } = mapDatadogIncidents(fixture(), US1);
    expect(incidents.map((i) => [i.id, i.impact])).toEqual([
      [METRICS_ID, 'major'],
      [WORKFLOW_ID, 'critical'],
      [SERVICE_CHECK_ID, 'minor'],
      [NOTIFICATIONS_ID, 'minor'], // recorded operational only
      [AGENTS_ID, 'critical'],
      [EMPTY_GRAPHS_ID, 'minor'], // recorded none
      [OLDEST_ID, 'minor'],
    ]);
  });

  /** Every update's createdAt on the page falls in 2026, a 2017 incident's included. */
  it('dates each update by when it happened, not when it was written (2017-04-24 reads 2017)', () => {
    const raw = fixture();
    const source = incident(raw, EMPTY_GRAPHS_ID);
    for (const e of source.timeline!) expect(e.createdAt).toMatch(/^2026-10-28T/);

    const inc = mapDatadogIncidents(raw, US1).incidents.find((i) => i.id === EMPTY_GRAPHS_ID)!;
    expect(inc.name).toBe('Empty graphs in dashboards');
    expect([inc.created_at, inc.resolved_at]).toEqual([
      '2017-04-24T22:21:52.126Z',
      '2017-04-24T22:55:53.965Z',
    ]);
    expect(inc.incident_updates.map((u) => [u.status, u.created_at, u.display_at])).toEqual([
      ['resolved', '2017-04-24T22:55:53.965Z', '2017-04-24T22:55:53.965Z'],
      ['monitoring', '2017-04-24T22:49:18.711Z', '2017-04-24T22:49:18.711Z'],
      ['identified', '2017-04-24T22:28:11.864Z', '2017-04-24T22:28:11.864Z'],
      ['identified', '2017-04-24T22:21:52.126Z', '2017-04-24T22:21:52.126Z'],
    ]);
  });

  it('orders updates by when they happened when the write time disagrees', () => {
    // The 17:31 update was written 2026-10-28, after the incident resolved on 2026-10-26.
    const raw = fixture();
    const late = incident(raw, WORKFLOW_ID).timeline!.find((e) =>
      e.createdAt?.startsWith('2026-10-28'),
    );
    expect(late?.startedAt).toBe('2026-10-26T17:31:54.225Z');
    const inc = mapDatadogIncidents(raw, US1).incidents.find((i) => i.id === WORKFLOW_ID)!;
    expect(inc.incident_updates.map((u) => [u.status, u.created_at])).toEqual([
      ['resolved', '2026-10-26T18:23:20.621168Z'],
      ['monitoring', '2026-10-26T17:40:12.473004Z'],
      ['identified', '2026-10-26T17:31:54.225Z'],
      ['identified', '2026-10-26T17:30:47.315542Z'],
      ['investigating', '2026-10-26T17:26:42.005771Z'],
    ]);
  });

  it("names each update's components with their status at that update", () => {
    const inc = mapDatadogIncidents(fixture(), US1).incidents.find((i) => i.id === WORKFLOW_ID)!;
    const byStatus = inc.incident_updates.map((u) =>
      (u.affected_components ?? []).map((c) => `${c.name}=${c.new_status}`),
    );
    expect(byStatus).toEqual([
      ['App Builder=operational', 'Workflow Automation=operational', 'Bits AI=operational'],
      [
        'App Builder=degraded_performance',
        'Workflow Automation=degraded_performance',
        'Bits AI=degraded_performance',
      ],
      [],
      [
        'App Builder=degraded_performance',
        'Workflow Automation=partial_outage',
        'Bits AI=degraded_performance',
      ],
      [
        'Workflow Automation=major_outage',
        'App Builder=degraded_performance',
        'Bits AI=degraded_performance',
      ],
    ]);
    // An update that records no component carries none, as a Statuspage update does.
    expect(inc.incident_updates[2]!.affected_components).toBeNull();
  });

  it('renders an HTML update body as plain text and leaves plain bodies unchanged', () => {
    const raw = fixture();
    const { incidents } = mapDatadogIncidents(raw, US1);
    const agents = incidents.find((i) => i.id === AGENTS_ID)!;
    const html = agents.incident_updates.find((u) => u.created_at === '2020-05-30T16:49:48.632Z')!;
    expect(html.body).toMatch(/^What happened\?\nOn Saturday May 30th, 2020, at 10:48 UTC/);
    expect(html.body).not.toContain('<b>');

    const sources = raw.incidents.flatMap((i) => (i.timeline ?? []).map((e) => e.description));
    const plain = incidents
      .flatMap((i) => i.incident_updates)
      .filter((u) => u !== html)
      .map((u) => u.body);
    expect(plain).toHaveLength(35);
    for (const body of plain) expect(sources).toContain(body);
  });

  it('drops a deleted update — from the list and from the rating', () => {
    const raw = fixture();
    const item = incident(raw, NOTIFICATIONS_ID);
    const kept = item.timeline!.length;
    item.timeline!.push({
      id: 'deleted-update',
      createdAt: '2024-07-24T14:20:00Z',
      startedAt: '2024-07-24T14:20:00Z',
      deletedAt: '2024-07-24T14:25:00Z',
      status: 'identified',
      description: 'Posted in error.',
      componentsAffected: [{ id: MONITORS, name: 'Monitors', status: 'major_outage' }],
    });
    const inc = mapDatadogIncidents(raw, US1).incidents.find((i) => i.id === NOTIFICATIONS_ID)!;
    expect(inc.incident_updates).toHaveLength(kept);
    expect(inc.incident_updates.map((u) => u.id)).not.toContain('deleted-update');
    expect(inc.impact).toBe('minor');
  });

  it('maps sparse incidents and updates without inventing facts', () => {
    const { incidents } = mapDatadogIncidents(
      {
        components: [],
        incidents: [{}, { id: 'r', resolved: true, timeline: [{}] }],
        maintenances: null,
      },
      US1,
    );
    expect(incidents).toHaveLength(2);
    const bare = incidents.find((i) => i.id === 'unknown')!;
    expect(bare).toMatchObject({
      name: 'Unnamed incident',
      status: 'investigating',
      impact: 'minor',
      created_at: '',
      started_at: null,
      resolved_at: null,
      incident_updates: [],
    });
    const resolved = incidents.find((i) => i.id === 'r')!;
    expect([resolved.status, resolved.resolved_at]).toEqual(['resolved', null]);
    expect(resolved.incident_updates).toEqual([
      {
        id: 'r-0',
        body: '',
        status: 'resolved',
        created_at: '',
        display_at: '',
        affected_components: null,
      },
    ]);
  });
});

describe('fetchers', () => {
  const http = createFetchMock();

  beforeEach(() => {
    clearFetchCache();
    http.reset();
    http.install();
  });

  afterEach(() => {
    http.restore();
  });

  it('reads {page}/config.json once for the summary, incident, and maintenance reads', async () => {
    const raw = fixture();
    http.route({ match: FEED, respond: () => Response.json(raw) });

    const summary = await fetchDatadogSummary(US1);
    expect(summary.cached).toBe(false);
    expect(summary.data.status.indicator).toBe('none');
    expect(summary.data.components).toHaveLength(40);

    const incidents = await fetchDatadogIncidents(US1);
    expect(incidents.cached).toBe(true);
    expect(incidents.data.incidents).toHaveLength(7);

    const maintenances = await fetchDatadogScheduledMaintenances(US1);
    expect(maintenances).toEqual({
      data: { page: summary.data.page, scheduled_maintenances: [] },
      cached: true,
    });
    expect(http.calls).toHaveLength(1);
    // The cache holds the document as fetched; each read normalizes from it.
    expect(fetchCacheStats()).toEqual({
      entries: 1,
      bytes: Buffer.byteLength(JSON.stringify(raw)),
    });
  });

  /**
   * A body without the document's envelope is some other document — an error envelope, a
   * placeholder — never an all-clear. The check runs in the fetch's parse step, so a
   * rejected body never reaches the response cache (#78).
   */
  describe('document envelope (#78)', () => {
    it.each([
      ['an error envelope', { error: 'not found' }],
      ['an empty object', {}],
      ['no maintenances key', { components: [], incidents: [] }],
      ['incidents missing', { components: [], maintenances: null }],
      ['components missing', { incidents: [], maintenances: null }],
      ['maintenances as an object', { components: [], incidents: [], maintenances: {} }],
      ['components as an object', { components: {}, incidents: [], maintenances: null }],
      ['a top-level array', []],
      ['null', null],
    ])('rejects %s as statuspage_unavailable naming the URL', async (_label, body) => {
      http.route({ match: FEED, respond: () => Response.json(body) });
      const err = await fetchDatadogSummary(US1).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect((err as McpError).data).toMatchObject({ reason: 'statuspage_unavailable', url: FEED });
      expect((err as McpError).message).toContain(FEED);
      expect(fetchCacheStats().entries).toBe(0);
    });

    it.each([
      ['incidents', fetchDatadogIncidents],
      ['scheduled maintenances', fetchDatadogScheduledMaintenances],
    ] as const)('fails the %s read on the same check', async (_label, fetcher) => {
      http.route({ match: FEED, respond: () => Response.json({ error: 'x' }) });
      await expect(fetcher(US1)).rejects.toMatchObject({
        data: { reason: 'statuspage_unavailable', url: FEED },
      });
    });

    it('caches nothing from a rejected body — the valid body served next is read on the following call', async () => {
      const raw = fixture();
      reopen(raw, METRICS_ID, 4);
      http.route(
        { match: FEED, once: true, respond: () => Response.json({ error: 'x' }) },
        { match: FEED, respond: () => Response.json(raw) },
      );
      await expect(fetchDatadogSummary(US1)).rejects.toMatchObject({
        data: { reason: 'statuspage_unavailable' },
      });
      const { data, cached } = await fetchDatadogSummary(US1);
      expect(cached).toBe(false);
      expect(data.status.indicator).toBe('major');
      expect(http.calls).toHaveLength(2);
    });

    it.each([
      ['maintenances null', { components: [], incidents: [], maintenances: null }],
      ['maintenances empty', { components: [], incidents: [], maintenances: [] }],
    ])('reads the bare envelope (%s) as all clear', async (_label, body) => {
      http.route({ match: FEED, respond: () => Response.json(body) });
      const { data } = await fetchDatadogSummary(US1);
      expect(data.status).toEqual({ indicator: 'none', description: 'All Systems Operational' });
      expect([data.components, data.incidents, data.scheduled_maintenances]).toEqual([[], [], []]);
    });
  });
});
