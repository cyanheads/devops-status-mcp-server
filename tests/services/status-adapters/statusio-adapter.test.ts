/**
 * @fileoverview Tests for the Status.io adapter mappers and fetchers.
 * Fixtures: statusio-gitlab.json is a live capture of GitLab's page (healthy);
 * statusio-incident-doc-derived.json reproduces the detailed example from
 * Status.io's Public Status API docs (both live pages were incident-free at
 * capture time, so the incident/maintenance item shape is doc-derived).
 * @module tests/services/status-adapters/statusio-adapter.test
 */

import { readFileSync } from 'node:fs';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchStatusioIncidents,
  fetchStatusioScheduledMaintenances,
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

  /**
   * statusio-neon.json is a live capture of Neon's page (2026-10-14): 12 components, 11
   * of them published per region through `containers`, 96 containers in all.
   */
  describe('per-container components (#62)', () => {
    const NEON: StatusioTarget = {
      statusio_page_id: '6878fc85709daa75be6c7e3c',
      name: 'Neon',
      url: 'https://neonstatus.com',
      slug: 'neon',
    };

    it('splits each multi-container component into one leaf per container under a group', () => {
      const { components } = mapStatusioSummary(fixture('statusio-neon.json'), NEON);
      const groups = components.filter((c) => c.group);
      const leaves = components.filter((c) => !c.group);
      expect(groups).toHaveLength(11);
      expect(leaves).toHaveLength(96);
      const byId = new Map(components.map((c) => [c.id, c]));
      const connectivity = leaves.filter(
        (c) => byId.get(c.group_id ?? '')?.name === 'Database Connectivity',
      );
      expect(connectivity).toHaveLength(11);
      expect(connectivity.map((c) => c.name)).toContain('AWS us-east-2');
      // Leaf ids stay unique although every component lists the same region containers.
      expect(new Set(components.map((c) => c.id)).size).toBe(components.length);
    });

    it('keeps a single-container component a flat, ungrouped leaf', () => {
      const { components } = mapStatusioSummary(fixture('statusio-neon.json'), NEON);
      const website = components.filter((c) => c.name === 'Website');
      expect(website).toHaveLength(1);
      expect(website[0]).toMatchObject({ group: false, group_id: null, status: 'operational' });
    });

    it("rates each leaf by its own container's status, not its component's", () => {
      const raw = fixture('statusio-neon.json');
      const connectivity = raw.result.status!.find((c) => c.name === 'Database Connectivity')!;
      const east2 = connectivity.containers!.find((c) => c.name === 'AWS us-east-2')!;
      east2.status_code = 400;
      const { components } = mapStatusioSummary(raw, NEON);
      const degraded = components.filter((c) => !c.group && c.status !== 'operational');
      expect(degraded.map((c) => [c.name, c.status])).toEqual([
        ['AWS us-east-2', 'partial_outage'],
      ]);
      expect(components.find((c) => c.id === degraded[0]!.group_id)).toMatchObject({
        name: 'Database Connectivity',
        group: true,
      });
    });

    it('splits the one multi-container component on the gitlab capture and leaves the rest', () => {
      const { components } = mapStatusioSummary(fixture('statusio-gitlab.json'), GITLAB);
      const groups = components.filter((c) => c.group);
      expect(groups.map((c) => c.name)).toEqual(['CI/CD - Hosted runners on macOS']);
      expect(components.filter((c) => c.group_id === groups[0]!.id).map((c) => c.name)).toEqual([
        'Google Compute Engine',
        'AWS',
      ]);
      expect(components.filter((c) => !c.group && c.group_id === null)).toHaveLength(22);
    });
  });

  /**
   * Status.io's documented example: overall 200 (Planned Maintenance) and an active window,
   * beside an open incident whose latest status is 300 — the incident outranks the window (#79).
   */
  it('rates overall maintenance (code 200) by the open incident beside it', () => {
    const summary = mapStatusioSummary(fixture('statusio-incident-doc-derived.json'), GITLAB);
    expect(summary.status.indicator).toBe('minor');
    expect(summary.status.description).toBe('Planned Maintenance');
  });

  it('maps severity codes to indicators (300 minor, 400 major, 500/600 critical, unknown minor)', () => {
    const base = fixture('statusio-gitlab.json');
    const withCode = (code: number | undefined): StatusioResponse => ({
      result: {
        ...base.result,
        status_overall: {
          updated: '',
          status: 'x',
          ...(code === undefined ? {} : { status_code: code }),
        },
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

describe('mapStatusioSummary maintenance indicator (#79)', () => {
  /** The documented example without its incident: overall 200, one active window, one upcoming. */
  const windowOnly = (): StatusioResponse => {
    const raw = fixture('statusio-incident-doc-derived.json');
    raw.result.incidents = [];
    return raw;
  };

  it('reads overall 200 with no open incident as maintenance', () => {
    const summary = mapStatusioSummary(windowOnly(), GITLAB);
    expect(summary.status).toEqual({
      indicator: 'maintenance',
      description: 'Planned Maintenance',
    });
    expect(summary.components.find((c) => c.name === 'Website')?.status).toBe('under_maintenance');
    expect(summary.scheduled_maintenances?.map((m) => [m.name, m.status])).toEqual([
      ['Network Upgrade', 'in_progress'],
      ['Mobile App Upgrade', 'scheduled'],
    ]);
  });

  it.each([
    ['latest status 100', 100, 200, 'maintenance'],
    ['latest status 200 (a maintenance event)', 200, 200, 'maintenance'],
    ['resolved (state 400) at status 300', 300, 400, 'maintenance'],
    ['latest status 300', 300, 200, 'minor'],
    ['latest status 400', 400, 200, 'major'],
    ['latest status 500', 500, 200, 'critical'],
    ['latest status 600', 600, 300, 'critical'],
  ] as const)(
    'reads overall 200 beside an incident at %s (status %i, state %i) as %s',
    (_label, status, state, indicator) => {
      const raw = fixture('statusio-incident-doc-derived.json');
      raw.result.incidents![0]!.messages = [
        { details: 'x', state, status, datetime: '2021-12-06T17:00:00.000Z' },
      ];
      expect(mapStatusioSummary(raw, GITLAB).status.indicator).toBe(indicator);
    },
  );

  it('rates by the worst open incident when several are open, wherever it is listed', () => {
    const raw = fixture('statusio-incident-doc-derived.json');
    const [open] = raw.result.incidents!;
    raw.result.incidents!.push(
      {
        ...open,
        _id: 'second',
        messages: [{ details: 'x', state: 100, status: 400, datetime: '2021-12-06T17:00:00.000Z' }],
      },
      { ...open, _id: 'third' },
    );
    expect(mapStatusioSummary(raw, GITLAB).status.indicator).toBe('major');
  });

  it.each([
    [300, 'minor'],
    [400, 'major'],
    [500, 'critical'],
    [600, 'critical'],
  ] as const)(
    'lets overall %i beside an active window set its own indicator',
    (code, indicator) => {
      const raw = windowOnly();
      raw.result.status_overall.status_code = code;
      expect(mapStatusioSummary(raw, GITLAB).status.indicator).toBe(indicator);
    },
  );

  it('reads overall 100 with only an upcoming window as none', () => {
    const raw = windowOnly();
    raw.result.status_overall = { updated: '', status: 'Operational', status_code: 100 };
    raw.result.maintenance!.active = [];
    expect(mapStatusioSummary(raw, GITLAB).status.indicator).toBe('none');
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
        status: [],
        incidents: [{}],
      },
    };
    const { incidents } = mapStatusioIncidents(raw, GITLAB);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.status).toBe('investigating');
    expect(incidents[0]!.incident_updates).toHaveLength(0);
  });

  it('renders HTML message details as plain text and keeps plain details unchanged (#63)', () => {
    const raw = fixture('statusio-incident-doc-derived.json');
    const plain = raw.result.incidents![0]!.messages!.map((m) => m.details);
    raw.result.incidents![0]!.messages!.push({
      details:
        '<p>Fixed &amp; verified.</p><p>See <a href="https://status.gitlab.com/x">the RCA</a>.</p>',
      state: 400,
      status: 100,
      datetime: '2021-12-06T17:00:00.000Z',
    });
    const bodies = mapStatusioIncidents(raw, GITLAB).incidents[0]!.incident_updates.map(
      (u) => u.body,
    );
    expect(bodies).toEqual([
      ...plain,
      'Fixed & verified.\nSee the RCA (https://status.gitlab.com/x).',
    ]);
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

  /** A window with no datetime_planned_end has no end to report; one with it keeps it (#91). */
  it('leaves scheduled_until unset on a window with no planned end, on both lists', () => {
    const raw = fixture('statusio-incident-doc-derived.json');
    delete raw.result.maintenance!.upcoming![0]!.datetime_planned_end;
    for (const windows of [
      mapStatusioScheduledMaintenances(raw, GITLAB).scheduled_maintenances,
      mapStatusioSummary(raw, GITLAB).scheduled_maintenances ?? [],
    ]) {
      expect(windows.map((m) => [m.name, m.scheduled_for, m.scheduled_until])).toEqual([
        ['Network Upgrade', '2021-12-06T16:50:00.000Z', '2021-12-06T17:50:00.000Z'],
        ['Mobile App Upgrade', '2021-12-22T15:00:00.000Z', undefined],
      ]);
      expect(Object.hasOwn(windows[1]!, 'scheduled_until')).toBe(false);
    }
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

/**
 * A body without `result.status_overall` (an object) and `result.status` (a list) is
 * some other document, never a health report. The check runs in the fetch's parse
 * step, so a rejected body never reaches the response cache (#78).
 */
describe('response envelope (#78)', () => {
  const http = createFetchMock();
  let pages = 0;
  /** A page ID no other case has fetched, so the shared response cache holds nothing for it. */
  const freshPage = () => {
    const id = `envelope-${++pages}`;
    return {
      target: { ...GITLAB, statusio_page_id: id },
      feed: `https://status-api.hostedstatus.com/1.0/status/${id}`,
    };
  };

  beforeEach(() => {
    http.reset();
    http.install();
  });

  afterEach(() => {
    http.restore();
  });

  it.each([
    ['an empty result', { result: {} }],
    ['an empty object', {}],
    ['a result without the component list', { result: { status_overall: {} } }],
    ['a result without status_overall', { result: { status: [] } }],
    ['a null status_overall', { result: { status_overall: null, status: [] } }],
    ['null', null],
  ])('rejects %s as statuspage_unavailable naming the feed URL', async (_label, body) => {
    const { target, feed } = freshPage();
    http.route({ match: feed, respond: () => Response.json(body) });
    const err = await fetchStatusioSummary(target).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect((err as McpError).data).toMatchObject({ reason: 'statuspage_unavailable', url: feed });
  });

  it.each([
    ['incidents', fetchStatusioIncidents],
    ['scheduled maintenances', fetchStatusioScheduledMaintenances],
  ] as const)('fails the %s read on the same check', async (_label, fetcher) => {
    const { target, feed } = freshPage();
    http.route({ match: feed, respond: () => Response.json({}) });
    await expect(fetcher(target)).rejects.toMatchObject({
      data: { reason: 'statuspage_unavailable', url: feed },
    });
  });

  it('caches nothing from a rejected body — the valid body served next is read on the following call', async () => {
    const { target, feed } = freshPage();
    http.route(
      { match: feed, once: true, respond: () => Response.json({ result: {} }) },
      { match: feed, respond: () => Response.json(fixture('statusio-gitlab.json')) },
    );
    await expect(fetchStatusioSummary(target)).rejects.toMatchObject({
      data: { reason: 'statuspage_unavailable' },
    });
    const { data, cached } = await fetchStatusioSummary(target);
    expect(cached).toBe(false);
    expect(data.status).toEqual({ indicator: 'none', description: 'Operational' });
    expect(http.calls).toHaveLength(2);
  });

  it('maps a sparse incident inside a valid envelope', async () => {
    const { target, feed } = freshPage();
    http.route({
      match: feed,
      respond: () => Response.json({ result: { status_overall: {}, status: [], incidents: [{}] } }),
    });
    const { data } = await fetchStatusioIncidents(target);
    expect(data.incidents.map((i) => [i.id, i.status])).toEqual([['unknown', 'investigating']]);
  });
});
