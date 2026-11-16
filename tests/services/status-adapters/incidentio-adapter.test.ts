/**
 * @fileoverview Tests for the incident.io adapter (#98), run through its fetchers with
 * `fetch` stubbed below `fetchCached`, so envelope checks, caching, and mapping all run.
 *
 * Fixtures are live captures taken 2026-11-16, with each update's `message.text_node`
 * (a rich-text tree the adapter never reads) removed:
 * - incidentio-clerk-summary.json — status.clerk.com's summary, whole: 8 groups, 18 leaves,
 *   all clear.
 * - incidentio-clerk-incidents.json — its default incident list, trimmed to a
 *   partial_outage incident, a completed maintenance window, and an incident resolved,
 *   reopened, and resolved again.
 * - incidentio-supabase-summary.json — status.supabase.com's summary, trimmed to two
 *   groups of three leaves and two ungrouped leaves, with its scheduled maintenance.
 * - incidentio-supabase-incidents.json — its default list, trimmed to that maintenance, a
 *   degraded_performance incident, a full_outage incident, and a completed window that
 *   names no components and publishes no window.
 * - incidentio-elevenlabs-summary.json — status.elevenlabs.io, a parent page: an empty
 *   `components` list, three groups in `structure`, four subpages.
 * - incidentio-unknown-host-*.json — what the route answers for an invented host.
 *
 * No incident.io page carried an ongoing incident, an affected component, or a degraded
 * subpage on 2026-11-16, so those states are built in-test from the captured records and
 * the field shapes the page bundle and the records themselves use.
 * @module tests/services/status-adapters/incidentio-adapter.test
 */

import { readFileSync } from 'node:fs';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchIncidentioDataAvailableSince,
  fetchIncidentioIncidents,
  fetchIncidentioScheduledMaintenances,
  fetchIncidentioSummary,
  type IncidentioIncidentList,
  type IncidentioRecord,
  type IncidentioSummaryDocument,
  type IncidentioTarget,
  readIncidentioHistory,
} from '@/services/status-adapters/incidentio-adapter.js';
import { clearFetchCache, fetchCacheStats } from '@/utils/cached-fetch.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    cacheTtlMs: 60_000,
    fetchTimeoutMs: 5000,
    certTimeoutMs: 5000,
    dnsTimeoutMs: 3000,
  }),
}));

function fixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(new URL(`fixtures/incidentio-${name}.json`, import.meta.url), 'utf-8'),
  ) as T;
}

const CLERK: IncidentioTarget = { name: 'Clerk', slug: 'clerk', url: 'https://status.clerk.com' };
const CLERK_SUMMARY = 'https://status.clerk.com/proxy/status.clerk.com';
const CLERK_LIST = `${CLERK_SUMMARY}/incidents`;

const SUPABASE: IncidentioTarget = {
  name: 'Supabase',
  slug: 'supabase',
  url: 'https://status.supabase.com',
};
const SUPABASE_SUMMARY = 'https://status.supabase.com/proxy/status.supabase.com';

const ELEVENLABS: IncidentioTarget = {
  name: 'ElevenLabs',
  slug: 'elevenlabs',
  url: 'https://status.elevenlabs.io',
};
const ELEVENLABS_SUMMARY = 'https://status.elevenlabs.io/proxy/status.elevenlabs.io';

const UNKNOWN: IncidentioTarget = {
  name: 'Nobody',
  slug: null,
  url: 'https://status.notarealpage-cyz.example',
};
const UNKNOWN_SUMMARY =
  'https://status.notarealpage-cyz.example/proxy/status.notarealpage-cyz.example';

// Captured records.
const SMS_ID = '01M64BZ539EBV61Y908QHE84C4'; // partial_outage, 2026-10-29
const CLERK_WINDOW_ID = '01M39R8WAV5ZXHKQPK3HSV6FEK'; // maintenance_complete, 2026-09-26
const REOPENED_ID = '01M2N3706GY2Z4BNNZYFGXP4Y7'; // resolved 13:39, reopened 14:33, resolved 15:20
const SUPABASE_WINDOW_ID = '01M7AHYK73ZAAYG8CSRJBMDTWH'; // maintenance_scheduled, 2026-11-30
const STORAGE_ID = '01M783P2MAAXZ8TR7ZRJSTNJEZ'; // degraded_performance
const MIGRATION_ID = '01M3T5X0M7MY87TX29CFN1HCJS'; // maintenance_complete, no window
const DASHBOARD_OUTAGE_ID = '01M39HXNPNY21MKAJEPYEZDRM5'; // full_outage

// Clerk components.
const CORE_SERVICES = '01K528PMQ5WNEBJKW66EB828C4';
const AUTH_AND_USER = '01K41ZBMSBHW3SN4CMJRPPAYG9'; // in Core services
const COMMUNICATION = '01KZ4WT40P4D1TQDR78YSR2C9W';
const EMAIL_DELIVERY = '01K41ZBMSBC8ZX3XBYYF6VDHB1'; // in Communication services
const SMS_DELIVERY = '01K41ZBMSBGGJCYCY10NJJ8099'; // in Communication services

function clerkList(): IncidentioIncidentList {
  return fixture<IncidentioIncidentList>('clerk-incidents');
}

function clerkRecord(id: string): IncidentioRecord {
  const record = clerkList().incidents.find((r) => r.id === id);
  if (!record) throw new Error(`fixture record ${id} missing`);
  return record;
}

/** The reopened record as it stood at 14:33, reopened and investigating. */
function reopenedOpen(): IncidentioRecord {
  const record = clerkRecord(REOPENED_ID);
  record.status = 'investigating';
  record.updates = record.updates!.slice(0, 4);
  record.status_summaries = record.status_summaries!.slice(0, 4);
  delete record.status_summaries[3]!.end_at;
  return record;
}

/** The captured Clerk window as it stood while in progress. */
function clerkWindowInProgress(): IncidentioRecord {
  const record = clerkRecord(CLERK_WINDOW_ID);
  record.status = 'maintenance_in_progress';
  record.updates = record.updates!.slice(0, 2);
  return record;
}

describe('incident.io adapter', () => {
  const http = createFetchMock();

  beforeEach(() => {
    clearFetchCache();
    http.reset();
    http.install();
  });

  afterEach(() => {
    http.restore();
    vi.useRealTimers();
  });

  const serve = (url: string, body: unknown) =>
    http.route({ match: url, respond: () => Response.json(body) });
  const requested = () => http.calls.map((c) => c.request.url);

  describe('fetchIncidentioSummary', () => {
    it('reads the captured Clerk page as all clear, its groups each followed by their leaves', async () => {
      serve(CLERK_SUMMARY, fixture('clerk-summary'));
      const { data, cached } = await fetchIncidentioSummary(CLERK);

      expect(cached).toBe(false);
      expect(requested()).toEqual([CLERK_SUMMARY]);
      expect(data.page).toEqual({
        id: 'clerk',
        name: 'Clerk',
        updated_at: '',
        url: 'https://status.clerk.com',
      });
      expect(data.status).toEqual({ indicator: 'none', description: 'All Systems Operational' });
      expect([data.incidents, data.scheduled_maintenances]).toEqual([[], []]);
      expect(data.components.filter((c) => c.group).map((c) => c.name)).toEqual([
        'Core services',
        'Session management',
        'Enterprise / Multi-tenant',
        'Protect',
        'Billing',
        'Communication services',
        'Dashboard & Administration',
        'Documentation',
      ]);
      expect(data.components.filter((c) => !c.group)).toHaveLength(18);
      expect(data.components.slice(0, 3)).toEqual([
        {
          id: CORE_SERVICES,
          name: 'Core services',
          status: 'operational',
          created_at: '',
          updated_at: '',
          group: true,
          group_id: null,
          position: 0,
        },
        {
          id: AUTH_AND_USER,
          name: 'Authentication & User',
          status: 'operational',
          created_at: '',
          updated_at: '',
          group: false,
          group_id: CORE_SERVICES,
          position: 1,
        },
        expect.objectContaining({ name: 'Machine authentication', group_id: CORE_SERVICES }),
      ]);
      expect(data.components.map((c) => c.position)).toEqual(data.components.map((_, i) => i));
      for (const c of data.components) expect(c.status).toBe('operational');
    });

    it('lists grouped and ungrouped leaves with their descriptions, and the scheduled window', async () => {
      serve(SUPABASE_SUMMARY, fixture('supabase-summary'));
      const { data } = await fetchIncidentioSummary(SUPABASE);

      expect(data.page.name).toBe('Supabase');
      expect(
        data.components.map((c) => [c.name, c.group, c.group_id ?? null, c.description ?? null]),
      ).toEqual([
        [
          'Connection Pooler',
          true,
          null,
          'Supavisor is a cloud-native, multi-tenant Postgres connection pooler.',
        ],
        ['eu-central-2', false, '01M32RZSPCRHRNBK9T3WKSDQF4', null],
        ['eu-west-1', false, '01M32RZSPCRHRNBK9T3WKSDQF4', null],
        ['us-east-2', false, '01M32RZSPCRHRNBK9T3WKSDQF4', null],
        ['Storage', true, null, 'Store and serve any type of digital content'],
        ['ap-southeast-1', false, '01M32R99QD6031NTQDBBP6NCEF', null],
        ['eu-west-1', false, '01M32R99QD6031NTQDBBP6NCEF', null],
        ['us-east-1', false, '01M32R99QD6031NTQDBBP6NCEF', null],
        ['Auth', false, null, 'Authenticate and authorize users'],
        ['Dashboard', false, null, 'The studio, docs and primary website at https://supabase.com'],
      ]);
      // A component without a description has no description key, rather than an invented one.
      expect(data.components[1]).not.toHaveProperty('description');

      // A scheduled window does not set the indicator; only one in progress does.
      expect(data.status).toEqual({ indicator: 'none', description: 'All Systems Operational' });
      expect(data.incidents).toEqual([]);
      expect(data.scheduled_maintenances).toHaveLength(1);
      expect(data.scheduled_maintenances![0]).toMatchObject({
        id: SUPABASE_WINDOW_ID,
        name: 'Scheduled maintenance: Shared Pooler (Supavisor), eu-central-2',
        impact: 'maintenance',
        status: 'scheduled',
        created_at: '2026-11-13T13:36:00.738Z',
        started_at: '2026-11-30T13:00:00Z',
        resolved_at: null,
        scheduled_for: '2026-11-30T13:00:00Z',
        scheduled_until: '2026-11-30T15:00:00Z',
        shortlink: `https://status.supabase.com/incidents/${SUPABASE_WINDOW_ID}`,
        components: [
          expect.objectContaining({
            id: '01M32ZK4PSECRCVCVHEC8G82QP',
            name: 'eu-central-2',
            status: 'under_maintenance',
          }),
        ],
      });
    });

    it.each([
      ['full_outage', 'major_outage', 'critical', '1 degraded component'],
      ['partial_outage', 'partial_outage', 'major', '1 degraded component'],
      ['degraded_performance', 'degraded_performance', 'minor', '1 degraded component'],
      ['under_maintenance', 'under_maintenance', 'maintenance', 'Service Under Maintenance'],
      ['operational', 'operational', 'none', 'All Systems Operational'],
      ['an unrecognized value', 'degraded_performance', 'minor', '1 degraded component'],
      ['no value', 'degraded_performance', 'minor', '1 degraded component'],
    ] as const)(
      'reads an affected component at %s as %s, rated %s',
      async (raw, status, indicator, description) => {
        const doc = fixture<IncidentioSummaryDocument>('clerk-summary');
        doc.summary.affected_components = [
          {
            component_id: SMS_DELIVERY,
            ...(raw === 'no value'
              ? {}
              : { status: raw === 'an unrecognized value' ? 'flaky' : raw }),
          },
        ];
        serve(CLERK_SUMMARY, doc);
        const { data } = await fetchIncidentioSummary(CLERK);

        expect(data.components.find((c) => c.id === SMS_DELIVERY)?.status).toBe(status);
        expect(data.components.find((c) => c.id === COMMUNICATION)?.status).toBe(status);
        expect(data.components.find((c) => c.id === EMAIL_DELIVERY)?.status).toBe('operational');
        expect(data.status).toEqual({ indicator, description });
      },
    );

    it("gives a group the worst of its leaves' statuses and counts only the leaves", async () => {
      const doc = fixture<IncidentioSummaryDocument>('clerk-summary');
      doc.summary.affected_components = [
        { component_id: EMAIL_DELIVERY, status: 'degraded_performance' },
        { component_id: SMS_DELIVERY, status: 'partial_outage' },
      ];
      serve(CLERK_SUMMARY, doc);
      const { data } = await fetchIncidentioSummary(CLERK);

      expect(data.components.find((c) => c.id === COMMUNICATION)?.status).toBe('partial_outage');
      expect(data.components.find((c) => c.id === CORE_SERVICES)?.status).toBe('operational');
      expect(data.status).toEqual({ indicator: 'major', description: '2 degraded components' });
    });

    it('lists an ongoing incident as active, rated by its worst span, with no resolution yet', async () => {
      const doc = fixture<IncidentioSummaryDocument>('clerk-summary');
      doc.summary.ongoing_incidents = [reopenedOpen()];
      serve(CLERK_SUMMARY, doc);
      const { data } = await fetchIncidentioSummary(CLERK);

      expect(data.status).toEqual({ indicator: 'minor', description: '1 active incident' });
      expect(data.incidents).toHaveLength(1);
      expect(data.incidents![0]).toMatchObject({
        id: REOPENED_ID,
        impact: 'minor',
        status: 'investigating',
        started_at: '2026-09-16T12:31:37.167Z',
        // An earlier update resolved it, but it is open again.
        resolved_at: null,
      });
      expect(data.incidents![0]!.incident_updates.map((u) => u.status)).toEqual([
        'investigating',
        'resolved',
        'monitoring',
        'identified',
      ]);
    });

    it('reads a window in progress as maintenance while nothing rates, and an open incident over it', async () => {
      const doc = fixture<IncidentioSummaryDocument>('clerk-summary');
      // A maintenance record listed among the ongoing incidents is still a window.
      doc.summary.ongoing_incidents = [clerkWindowInProgress()];
      serve(CLERK_SUMMARY, doc);
      const alone = (await fetchIncidentioSummary(CLERK)).data;
      expect(alone.status).toEqual({
        indicator: 'maintenance',
        description: '1 maintenance window in progress',
      });
      expect(alone.incidents).toEqual([]);
      expect(alone.scheduled_maintenances).toMatchObject([
        { id: CLERK_WINDOW_ID, status: 'in_progress', impact: 'maintenance' },
      ]);

      clearFetchCache();
      http.reset();
      doc.summary.ongoing_incidents = [reopenedOpen()];
      doc.summary.scheduled_maintenances = [clerkWindowInProgress()];
      serve(CLERK_SUMMARY, doc);
      expect((await fetchIncidentioSummary(CLERK)).data.status).toEqual({
        indicator: 'minor',
        description: '1 active incident',
      });
    });

    it('rates the page by the worst of its components and its open incidents', async () => {
      const doc = fixture<IncidentioSummaryDocument>('clerk-summary');
      doc.summary.affected_components = [
        { component_id: SMS_DELIVERY, status: 'degraded_performance' },
      ];
      const sms = clerkRecord(SMS_ID);
      sms.status = 'investigating';
      doc.summary.ongoing_incidents = [sms];
      serve(CLERK_SUMMARY, doc);
      expect((await fetchIncidentioSummary(CLERK)).data.status).toEqual({
        indicator: 'major',
        description: '1 active incident',
      });
    });

    it('does not rate a resolved incident the summary still lists as ongoing', async () => {
      const doc = fixture<IncidentioSummaryDocument>('clerk-summary');
      // As captured: partial_outage spans, resolved.
      doc.summary.ongoing_incidents = [clerkRecord(SMS_ID)];
      serve(CLERK_SUMMARY, doc);
      expect((await fetchIncidentioSummary(CLERK)).data.status).toEqual({
        indicator: 'none',
        description: 'All Systems Operational',
      });
    });

    it('leaves a completed window out of the upcoming windows', async () => {
      const doc = fixture<IncidentioSummaryDocument>('supabase-summary');
      // As captured: maintenance_complete.
      doc.summary.scheduled_maintenances.push(clerkRecord(CLERK_WINDOW_ID));
      serve(SUPABASE_SUMMARY, doc);
      const { data } = await fetchIncidentioSummary(SUPABASE);
      expect(data.scheduled_maintenances!.map((w) => w.id)).toEqual([SUPABASE_WINDOW_ID]);
      expect(data.status).toEqual({ indicator: 'none', description: 'All Systems Operational' });
    });

    describe('a parent page', () => {
      it('lists the components its structure names though its components list is empty', async () => {
        const doc = fixture<{ summary: { components: unknown[] } }>('elevenlabs-summary');
        expect(doc.summary.components).toEqual([]);
        serve(ELEVENLABS_SUMMARY, doc);
        const { data } = await fetchIncidentioSummary(ELEVENLABS);

        expect(data.components.filter((c) => c.group).map((c) => c.name)).toEqual([
          'ElevenAPI',
          'ElevenAgents',
          'ElevenCreative',
        ]);
        expect(data.components.filter((c) => !c.group)).toHaveLength(11);
        expect(data.status).toEqual({ indicator: 'none', description: 'All Systems Operational' });
      });

      it.each([
        ['partial_outage', 'major', '1 degraded subpage: EU (Enterprise-only)'],
        ['full_outage', 'critical', '1 degraded subpage: EU (Enterprise-only)'],
        ['an unrecognized value', 'minor', '1 degraded subpage: EU (Enterprise-only)'],
        ['under_maintenance', 'maintenance', 'Service Under Maintenance'],
      ] as const)('rates a subpage at %s as %s', async (raw, indicator, description) => {
        const doc = fixture<IncidentioSummaryDocument>('elevenlabs-summary');
        doc.subpages![1]!.worst_component_status = raw === 'an unrecognized value' ? 'flaky' : raw;
        serve(ELEVENLABS_SUMMARY, doc);
        expect((await fetchIncidentioSummary(ELEVENLABS)).data.status).toEqual({
          indicator,
          description,
        });
      });

      it('does not rate a subpage that publishes no status', async () => {
        const doc = fixture<IncidentioSummaryDocument>('elevenlabs-summary');
        delete doc.subpages![1]!.worst_component_status;
        serve(ELEVENLABS_SUMMARY, doc);
        expect((await fetchIncidentioSummary(ELEVENLABS)).data.status).toEqual({
          indicator: 'none',
          description: 'All Systems Operational',
        });
      });
    });
  });

  describe('fetchIncidentioIncidents', () => {
    it('reads the summary, then the default list, and maps each incident', async () => {
      serve(CLERK_SUMMARY, fixture('clerk-summary'));
      serve(CLERK_LIST, clerkList());
      const { data, cached } = await fetchIncidentioIncidents(CLERK);

      expect(cached).toBe(false);
      expect(requested()).toEqual([CLERK_SUMMARY, CLERK_LIST]);
      // The maintenance window is left out of the incident list, which is newest first.
      expect(data.incidents.map((i) => i.id)).toEqual([SMS_ID, REOPENED_ID]);

      const authAndUser = {
        id: AUTH_AND_USER,
        name: 'Authentication & User',
        created_at: '',
        updated_at: '',
        group: false,
        group_id: CORE_SERVICES,
        position: 1,
      };
      const sms = data.incidents[0]!;
      expect({ ...sms, incident_updates: [] }).toEqual({
        id: SMS_ID,
        name: 'SMS Delivery Issues',
        impact: 'major',
        status: 'resolved',
        created_at: '2026-10-29T17:40:19.176Z',
        started_at: '2026-10-29T17:40:19.176Z',
        resolved_at: '2026-10-29T18:16:44.935Z',
        monitoring_at: null,
        page_id: 'clerk',
        components: [{ ...authAndUser, status: 'partial_outage' }],
        shortlink: `https://status.clerk.com/incidents/${SMS_ID}`,
        incident_updates: [],
      });
      expect(sms.incident_updates.map((u) => [u.id, u.status, u.created_at])).toEqual([
        ['01M64E1VKGGVFP8DJN2GE55HYE', 'resolved', '2026-10-29T18:16:44.935Z'],
        ['01M64DCFDVCHBD7K4PZ0RSJCS8', 'monitoring', '2026-10-29T18:05:04.342Z'],
        ['01M64D3CWVFMDAXF6JGB94060R', 'investigating', '2026-10-29T18:00:06.835Z'],
        ['01M64CRFB63GNATC798P9M9JNW', 'investigating', '2026-10-29T17:54:08.888Z'],
        ['01M64CA64NNS3DHJ9GGQYFPS2K', 'investigating', '2026-10-29T17:46:20.744Z'],
        ['01M64BZ539C5M76VJSJQPAXQY8', 'investigating', '2026-10-29T17:40:19.176Z'],
      ]);
      expect(sms.incident_updates[0]).toEqual({
        id: '01M64E1VKGGVFP8DJN2GE55HYE',
        body: 'The SMS delivery issue is resolved. Delivery and verification completion rates have returned to normal following our upstream provider’s switch to an alternate route.',
        status: 'resolved',
        created_at: '2026-10-29T18:16:44.935Z',
        display_at: '2026-10-29T18:16:44.935Z',
        affected_components: [
          {
            code: AUTH_AND_USER,
            name: 'Authentication & User',
            new_status: 'operational',
            old_status: '',
          },
        ],
      });
      expect(sms.incident_updates.at(-1)?.affected_components).toEqual([
        {
          code: AUTH_AND_USER,
          name: 'Authentication & User',
          new_status: 'partial_outage',
          old_status: '',
        },
      ]);
    });

    it('resolves a reopened incident at its final resolution, not its first', async () => {
      serve(CLERK_SUMMARY, fixture('clerk-summary'));
      serve(CLERK_LIST, clerkList());
      const reopened = (await fetchIncidentioIncidents(CLERK)).data.incidents.find(
        (i) => i.id === REOPENED_ID,
      )!;
      expect(reopened).toMatchObject({
        status: 'resolved',
        created_at: '2026-09-16T12:31:37.167Z',
        started_at: '2026-09-16T12:31:37.167Z',
        resolved_at: '2026-09-16T15:20:58.791Z',
        // degraded_performance, degraded_performance, operational, degraded_performance
        impact: 'minor',
      });
    });

    it('rates a full_outage incident critical and dates it from its spans, not its posting', async () => {
      serve(SUPABASE_SUMMARY, fixture('supabase-summary'));
      serve(`${SUPABASE_SUMMARY}/incidents`, fixture('supabase-incidents'));
      const { incidents } = (await fetchIncidentioIncidents(SUPABASE)).data;

      expect(incidents.map((i) => [i.id, i.impact])).toEqual([
        [STORAGE_ID, 'minor'],
        [DASHBOARD_OUTAGE_ID, 'critical'],
      ]);
      expect(incidents[1]).toMatchObject({
        created_at: '2026-09-24T10:37:32.362Z',
        started_at: '2026-09-24T10:37:32.455Z',
        resolved_at: '2026-09-24T11:49:44.19Z',
        components: [expect.objectContaining({ name: 'Dashboard', status: 'major_outage' })],
      });
    });

    it.each([
      [['degraded_performance'], 'minor'],
      [['partial_outage'], 'major'],
      [['full_outage'], 'critical'],
      [['under_maintenance'], 'none'],
      [['operational'], 'none'],
      [['flaky'], 'minor'],
      [[], 'none'],
      [['operational', 'full_outage', 'degraded_performance'], 'critical'],
    ] as const)('rates spans %j as %s', async (worst, impact) => {
      const list = clerkList();
      const sms = list.incidents.find((r) => r.id === SMS_ID)!;
      sms.status_summaries = worst.map((w, i) => ({
        start_at: `2026-10-29T1${7 + i}:00:00Z`,
        end_at: `2026-10-29T1${7 + i}:30:00Z`,
        worst_component_status: w,
      }));
      serve(CLERK_SUMMARY, fixture('clerk-summary'));
      serve(CLERK_LIST, list);
      const mapped = (await fetchIncidentioIncidents(CLERK)).data.incidents[0]!;
      expect(mapped.impact).toBe(impact);
      expect(mapped.started_at).toBe(worst.length === 0 ? null : '2026-10-29T17:00:00Z');
    });

    it('takes the earliest span start even when the spans are out of order', async () => {
      const list = clerkList();
      list.incidents.find((r) => r.id === SMS_ID)!.status_summaries = [
        { start_at: '2026-10-29T18:00:00Z', worst_component_status: 'operational' },
        { start_at: '2026-10-29T17:00:00Z', worst_component_status: 'operational' },
      ];
      serve(CLERK_SUMMARY, fixture('clerk-summary'));
      serve(CLERK_LIST, list);
      expect((await fetchIncidentioIncidents(CLERK)).data.incidents[0]!.started_at).toBe(
        '2026-10-29T17:00:00Z',
      );
    });

    it('renders an HTML body as plain text and falls back to message_string', async () => {
      const list = clerkList();
      const updates = list.incidents.find((r) => r.id === SMS_ID)!.updates!;
      updates[0]!.message = { markdown: 'Line one<br>Line <b>two</b>' };
      delete updates[1]!.message;
      updates[1]!.message_string = 'Only the plain string';
      serve(CLERK_SUMMARY, fixture('clerk-summary'));
      serve(CLERK_LIST, list);
      const bodies = (
        await fetchIncidentioIncidents(CLERK)
      ).data.incidents[0]!.incident_updates.map((u) => u.body);
      expect(bodies.at(-1)).toBe('Line one\nLine two');
      expect(bodies.at(-2)).toBe('Only the plain string');
      // A markdown body without markup is returned exactly as published.
      expect(bodies.at(-3)).toBe(
        "We're continuing to investigate SMS delivery issues with an upstream vendor impacting users on AT&T.",
      );
    });

    it('maps sparse records without inventing facts', async () => {
      serve(CLERK_SUMMARY, fixture('clerk-summary'));
      serve(CLERK_LIST, {
        incidents: [
          {},
          {
            id: 'r',
            updates: [
              { published_at: '2026-10-01T10:00:00Z', to_status: 'investigating' },
              {
                published_at: '2026-10-01T11:00:00Z',
                to_status: 'resolved',
                component_statuses: [
                  { component_id: 'not-on-this-page', status: 'operational' },
                  { component_id: SMS_DELIVERY },
                ],
              },
            ],
            affected_components: [{ component_id: 'not-on-this-page', status: 'full_outage' }],
          },
        ],
      });
      const { incidents } = (await fetchIncidentioIncidents(CLERK)).data;

      expect(incidents.find((i) => i.id === 'unknown')).toEqual({
        id: 'unknown',
        name: 'Unnamed incident',
        impact: 'none',
        status: 'investigating',
        created_at: '',
        started_at: null,
        resolved_at: null,
        monitoring_at: null,
        page_id: 'clerk',
        components: [],
        incident_updates: [],
      });
      // No status of its own: its newest update's is the record's.
      const r = incidents.find((i) => i.id === 'r')!;
      expect([r.status, r.resolved_at, r.created_at, r.started_at]).toEqual([
        'resolved',
        '2026-10-01T11:00:00Z',
        '',
        null,
      ]);
      expect(r.components).toEqual([]);
      expect(r.incident_updates.map((u) => [u.id, u.body, u.affected_components])).toEqual([
        [
          'r-1',
          '',
          [
            {
              code: SMS_DELIVERY,
              name: 'SMS delivery',
              new_status: 'degraded_performance',
              old_status: '',
            },
          ],
        ],
        ['r-0', '', null],
      ]);
    });

    it('orders an update with no timestamp after the dated ones, which name the newest status', async () => {
      serve(CLERK_SUMMARY, fixture('clerk-summary'));
      serve(CLERK_LIST, {
        incidents: [
          {
            id: 'r',
            updates: [
              { published_at: '2026-10-01T10:00:00Z', to_status: 'identified' },
              { to_status: 'investigating' },
              { published_at: '2026-10-01T11:00:00Z', to_status: 'resolved' },
            ],
          },
        ],
      });
      const [r] = (await fetchIncidentioIncidents(CLERK)).data.incidents;

      expect(r!.status).toBe('resolved');
      expect(r!.incident_updates.map((u) => [u.id, u.status, u.created_at])).toEqual([
        ['r-2', 'resolved', '2026-10-01T11:00:00Z'],
        ['r-0', 'identified', '2026-10-01T10:00:00Z'],
        ['r-1', 'investigating', ''],
      ]);
    });
  });

  describe('fetchIncidentioScheduledMaintenances', () => {
    it('lists completed windows from the default list, mapping the maintenance lifecycle', async () => {
      serve(CLERK_SUMMARY, fixture('clerk-summary'));
      serve(CLERK_LIST, clerkList());
      const { data } = await fetchIncidentioScheduledMaintenances(CLERK);

      expect(data.scheduled_maintenances).toHaveLength(1);
      const window = data.scheduled_maintenances[0]!;
      expect({ ...window, components: [], incident_updates: [] }).toEqual({
        id: CLERK_WINDOW_ID,
        name: 'Scheduled Database Maintenance',
        impact: 'maintenance',
        status: 'completed',
        created_at: '2026-09-24T13:04:27.482Z',
        started_at: '2026-09-26T14:00:00Z',
        resolved_at: '2026-09-26T14:30:00.755Z',
        monitoring_at: null,
        page_id: 'clerk',
        components: [],
        shortlink: `https://status.clerk.com/incidents/${CLERK_WINDOW_ID}`,
        scheduled_for: '2026-09-26T14:00:00Z',
        scheduled_until: '2026-09-26T14:30:00Z',
        incident_updates: [],
      });
      expect(window.components).toHaveLength(14);
      for (const c of window.components) expect(c.status).toBe('under_maintenance');
      expect(window.incident_updates.map((u) => [u.status, u.body])).toEqual([
        ['completed', 'Maintenance has completed'],
        ['in_progress', 'Maintenance has started'],
        ['scheduled', expect.stringContaining('planned database maintenance on Saturday')],
      ]);
    });

    it("merges the summary's windows with the list's by id, the summary's copy kept", async () => {
      const doc = fixture<IncidentioSummaryDocument>('supabase-summary');
      doc.summary.scheduled_maintenances[0]!.name = 'The summary copy';
      serve(SUPABASE_SUMMARY, doc);
      serve(`${SUPABASE_SUMMARY}/incidents`, fixture('supabase-incidents'));
      const windows = (await fetchIncidentioScheduledMaintenances(SUPABASE)).data
        .scheduled_maintenances;

      expect(windows.map((w) => [w.id, w.name, w.status])).toEqual([
        [SUPABASE_WINDOW_ID, 'The summary copy', 'scheduled'],
        [MIGRATION_ID, 'Statuspage Migration', 'completed'],
      ]);
      // A window that names no components publishes no window, and none is invented.
      const migration = windows[1]!;
      expect(migration).not.toHaveProperty('scheduled_for');
      expect(migration).not.toHaveProperty('scheduled_until');
      expect(migration).toMatchObject({
        started_at: null,
        created_at: '2026-09-30T22:08:26.542Z',
        resolved_at: '2026-10-07T17:03:34.639Z',
        components: [],
      });
    });

    it('leaves the end unset while a span of the window is still open', async () => {
      const list = clerkList();
      const window = list.incidents.find((r) => r.id === CLERK_WINDOW_ID)!;
      // A closed span ahead of the open one: its end is not the window's.
      window.status_summaries = [
        { start_at: '2026-09-26T14:00:00Z', end_at: '2026-09-26T14:10:00Z' },
        { start_at: '2026-09-26T14:10:00Z' },
      ];
      serve(CLERK_SUMMARY, fixture('clerk-summary'));
      serve(CLERK_LIST, list);
      const mapped = (await fetchIncidentioScheduledMaintenances(CLERK)).data
        .scheduled_maintenances[0]!;
      expect(mapped.scheduled_for).toBe('2026-09-26T14:00:00Z');
      expect(mapped).not.toHaveProperty('scheduled_until');
    });

    it('takes the latest span end even when the spans are out of order', async () => {
      const list = clerkList();
      list.incidents.find((r) => r.id === CLERK_WINDOW_ID)!.status_summaries = [
        { start_at: '2026-09-26T14:10:00Z', end_at: '2026-09-26T14:30:00Z' },
        { start_at: '2026-09-26T14:00:00Z', end_at: '2026-09-26T14:10:00Z' },
      ];
      serve(CLERK_SUMMARY, fixture('clerk-summary'));
      serve(CLERK_LIST, list);
      expect(
        (await fetchIncidentioScheduledMaintenances(CLERK)).data.scheduled_maintenances[0],
      ).toMatchObject({
        scheduled_for: '2026-09-26T14:00:00Z',
        scheduled_until: '2026-09-26T14:30:00Z',
      });
    });

    it('names a sparse maintenance record as maintenance, scheduled', async () => {
      serve(CLERK_SUMMARY, fixture('clerk-summary'));
      serve(CLERK_LIST, { incidents: [{ id: 'm', type: 'maintenance', updates: [{}] }] });
      const [m] = (await fetchIncidentioScheduledMaintenances(CLERK)).data.scheduled_maintenances;
      expect(m).toMatchObject({
        id: 'm',
        name: 'Unnamed maintenance',
        impact: 'maintenance',
        status: 'scheduled',
        resolved_at: null,
        incident_updates: [
          { id: 'm-0', body: '', status: 'scheduled', created_at: '', affected_components: null },
        ],
      });
    });
  });

  describe('caching', () => {
    it('reads each URL once for the summary, incident, maintenance, and coverage reads', async () => {
      serve(CLERK_SUMMARY, fixture('clerk-summary'));
      serve(CLERK_LIST, clerkList());

      expect((await fetchIncidentioSummary(CLERK)).cached).toBe(false);
      expect((await fetchIncidentioIncidents(CLERK)).cached).toBe(false);
      expect((await fetchIncidentioScheduledMaintenances(CLERK)).cached).toBe(true);
      expect(await fetchIncidentioDataAvailableSince(CLERK)).toBe('2025-02-27T11:20:00Z');
      expect(requested()).toEqual([CLERK_SUMMARY, CLERK_LIST]);
    });

    it('shares one summary request between a concurrent summary and incident read', async () => {
      serve(CLERK_SUMMARY, fixture('clerk-summary'));
      serve(CLERK_LIST, clerkList());
      const [summary, incidents] = await Promise.all([
        fetchIncidentioSummary(CLERK),
        fetchIncidentioIncidents(CLERK),
      ]);

      expect(requested().filter((url) => url === CLERK_SUMMARY)).toHaveLength(1);
      expect(requested()).toHaveLength(2);
      expect(summary.data.components).toHaveLength(26);
      expect(summary.data.status.indicator).toBe('none');
      expect(incidents.data.incidents.map((i) => i.id)).toEqual([SMS_ID, REOPENED_ID]);
      expect(incidents.data.incidents[0]!.components[0]?.name).toBe('Authentication & User');
    });

    it('reports null coverage when the summary publishes no data_available_since', async () => {
      const doc = fixture<IncidentioSummaryDocument>('clerk-summary');
      delete doc.summary.data_available_since;
      serve(CLERK_SUMMARY, doc);
      expect(await fetchIncidentioDataAvailableSince(CLERK)).toBeNull();
    });
  });

  /**
   * The route answers any host, an unknown one with HTTP 200 `{}`, so the envelope is what
   * tells a page's summary from nothing. The check runs in the fetch's parse step, so a
   * rejected body never reaches the response cache.
   */
  describe('envelope', () => {
    const summaryWith = (patch: Record<string, unknown>) => {
      const doc = fixture<IncidentioSummaryDocument>('clerk-summary');
      return { ...doc, summary: { ...doc.summary, ...patch } };
    };

    it.each([
      ['the unknown-host answer', fixture('unknown-host-summary')],
      ['an error envelope', { error: 'not found' }],
      ['structure missing', summaryWith({ structure: undefined })],
      ['structure.items as an object', summaryWith({ structure: { items: {} } })],
      ['affected_components missing', summaryWith({ affected_components: undefined })],
      ['ongoing_incidents as null', summaryWith({ ongoing_incidents: null })],
      ['scheduled_maintenances missing', summaryWith({ scheduled_maintenances: undefined })],
      ['subpages as an object', { ...fixture<object>('clerk-summary'), subpages: {} }],
      ['a top-level array', []],
      ['null', null],
    ])(
      'rejects a summary that is %s as statuspage_unavailable naming the URL',
      async (_label, body) => {
        serve(CLERK_SUMMARY, body);
        const err = await fetchIncidentioSummary(CLERK).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(McpError);
        expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect((err as McpError).data).toMatchObject({
          reason: 'statuspage_unavailable',
          url: CLERK_SUMMARY,
        });
        expect((err as McpError).message).toContain(CLERK_SUMMARY);
        expect(fetchCacheStats().entries).toBe(0);
      },
    );

    it('requests no incident list for a host whose summary is not a page', async () => {
      serve(UNKNOWN_SUMMARY, fixture('unknown-host-summary'));
      serve(`${UNKNOWN_SUMMARY}/incidents`, fixture('unknown-host-incidents'));
      for (const fetcher of [fetchIncidentioIncidents, fetchIncidentioScheduledMaintenances]) {
        await expect(fetcher(UNKNOWN)).rejects.toMatchObject({
          data: { reason: 'statuspage_unavailable', url: UNKNOWN_SUMMARY },
        });
      }
      expect(requested()).toEqual([UNKNOWN_SUMMARY, UNKNOWN_SUMMARY]);
      expect(fetchCacheStats().entries).toBe(0);
    });

    it.each([
      ['an empty object', {}],
      ['incidents as an object', { incidents: {} }],
      ['an error envelope', { error: 'x' }],
      ['null', null],
    ])('rejects an incident list that is %s, caching only the summary', async (_label, body) => {
      serve(CLERK_SUMMARY, fixture('clerk-summary'));
      serve(CLERK_LIST, body);
      await expect(fetchIncidentioIncidents(CLERK)).rejects.toMatchObject({
        data: { reason: 'statuspage_unavailable', url: CLERK_LIST },
        message: expect.stringContaining(CLERK_LIST),
      });
      expect(fetchCacheStats().entries).toBe(1);
    });

    it('reads a corrected body on the same URL after a rejected one, summary and list alike', async () => {
      http.route(
        { match: CLERK_SUMMARY, once: true, respond: () => Response.json({}) },
        { match: CLERK_SUMMARY, respond: () => Response.json(fixture('clerk-summary')) },
        { match: CLERK_LIST, once: true, respond: () => Response.json({ error: 'x' }) },
        { match: CLERK_LIST, respond: () => Response.json(clerkList()) },
      );
      await expect(fetchIncidentioIncidents(CLERK)).rejects.toMatchObject({
        data: { url: CLERK_SUMMARY },
      });
      await expect(fetchIncidentioIncidents(CLERK)).rejects.toMatchObject({
        data: { url: CLERK_LIST },
      });
      const { data, cached } = await fetchIncidentioIncidents(CLERK);
      expect(cached).toBe(false);
      expect(data.incidents).toHaveLength(2);
      expect(requested()).toEqual([CLERK_SUMMARY, CLERK_SUMMARY, CLERK_LIST, CLERK_LIST]);
    });

    it('maps the bare envelope as an all-clear page with nothing on it', async () => {
      serve(CLERK_SUMMARY, {
        summary: {
          structure: { items: [{}, { group: {} }, { component: {} }] },
          affected_components: [],
          ongoing_incidents: [],
          scheduled_maintenances: [],
        },
      });
      const { data } = await fetchIncidentioSummary(CLERK);
      expect(data.page.name).toBe('Clerk');
      expect(data.status).toEqual({ indicator: 'none', description: 'All Systems Operational' });
      // The item that is neither a group nor a component is skipped.
      expect(data.components.map((c) => [c.id, c.name, c.group])).toEqual([
        ['group-1', 'Unknown', true],
        ['component-2', 'Unknown', false],
      ]);
    });
  });

  describe('readIncidentioHistory', () => {
    const NOW = Date.parse('2026-11-16T08:00:00Z');
    const day = (date: string) => Date.parse(`${date}T00:00:00Z`);
    const quarterUrl = (start: string, end: string) =>
      `${CLERK_LIST}?start_at=${start}T00:00:00.000Z&end_at=${end}T00:00:00.000Z`;
    const windowRequests = () => requested().filter((url) => url.startsWith(`${CLERK_LIST}?`));

    /** Serves each quarter window its records, keyed by the window's start date. */
    const serveWindows = (
      byStart: Record<string, IncidentioRecord[]>,
      respond?: (request: Request, body: unknown) => Promise<Response> | Response,
    ) =>
      http.route({
        match: (request) => request.url.startsWith(`${CLERK_LIST}?`),
        respond: (request) => {
          const start = new URL(request.url).searchParams.get('start_at')?.slice(0, 10) ?? '';
          const body = { incidents: byStart[start] ?? [] };
          return respond ? respond(request, body) : Response.json(body);
        },
      });

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      vi.setSystemTime(NOW);
      serve(CLERK_SUMMARY, fixture('clerk-summary'));
    });

    it('reads one window per calendar quarter, newest first, back to the quarter holding the floor', async () => {
      serveWindows({});
      const walk = await readIncidentioHistory(CLERK, day('2026-01-15'));

      expect(requested()[0]).toBe(CLERK_SUMMARY);
      expect(windowRequests()).toEqual([
        quarterUrl('2026-10-01', '2027-01-01'),
        quarterUrl('2026-07-01', '2026-10-01'),
        quarterUrl('2026-04-01', '2026-07-01'),
        quarterUrl('2026-01-01', '2026-04-01'),
      ]);
      expect(walk).toEqual({
        records: [],
        reachedFloor: true,
        readBackTo: '2026-01-01',
        gap: null,
      });
    });

    it.each([
      ['on a quarter start', '2026-07-01', 2, '2026-07-01'],
      ['the day before one', '2026-06-30', 3, '2026-04-01'],
      ['across a year boundary', '2025-12-31', 5, '2025-10-01'],
      ['in the future', '2027-03-01', 1, '2026-10-01'],
    ])('stops at a floor %s', async (_label, floor, windows, readBackTo) => {
      serveWindows({});
      const walk = await readIncidentioHistory(CLERK, day(floor));
      expect(windowRequests()).toHaveLength(windows);
      expect(walk).toMatchObject({ reachedFloor: true, readBackTo, gap: null });
    });

    it('reads 24 months back in nine windows, the oldest the quarter of the floor', async () => {
      serveWindows({});
      const walk = await readIncidentioHistory(CLERK, day('2024-11-16'));
      expect(windowRequests()).toHaveLength(9);
      expect(windowRequests().at(-1)).toBe(quarterUrl('2024-10-01', '2025-01-01'));
      expect(requested()).toHaveLength(10);
      expect(walk.readBackTo).toBe('2024-10-01');
    });

    it('returns full records from every window once each, newest first, maintenance included', async () => {
      const sms = clerkRecord(SMS_ID);
      serveWindows({
        '2026-10-01': [sms],
        // The incident's impact overlaps both quarters, so both windows list it.
        '2026-07-01': [clerkRecord(REOPENED_ID), clerkRecord(CLERK_WINDOW_ID), sms],
      });
      const walk = await readIncidentioHistory(CLERK, day('2026-07-01'));

      expect(walk.gap).toBeNull();
      expect(walk.records.map((r) => [r.id, r.impact, r.status])).toEqual([
        [SMS_ID, 'major', 'resolved'],
        [CLERK_WINDOW_ID, 'maintenance', 'completed'],
        [REOPENED_ID, 'minor', 'resolved'],
      ]);
      expect(walk.records[0]).toMatchObject({
        shortlink: `https://status.clerk.com/incidents/${SMS_ID}`,
        resolved_at: '2026-10-29T18:16:44.935Z',
        components: [expect.objectContaining({ name: 'Authentication & User' })],
      });
      expect(walk.records[1]).toMatchObject({
        scheduled_for: '2026-09-26T14:00:00Z',
        scheduled_until: '2026-09-26T14:30:00Z',
      });
    });

    it('stops at a failing window, keeping the quarters read before it', async () => {
      serveWindows({ '2026-10-01': [clerkRecord(SMS_ID)] }, (request, body) =>
        request.url.includes('start_at=2026-04-01')
          ? new Response('upstream down', { status: 503 })
          : Response.json(body),
      );
      const walk = await readIncidentioHistory(CLERK, day('2024-11-16'));

      expect(windowRequests()).toHaveLength(3);
      expect(walk).toEqual({
        records: [expect.objectContaining({ id: SMS_ID })],
        reachedFloor: false,
        readBackTo: '2026-07-01',
        gap: `the quarter starting 2026-04-01 failed: HTTP 503 from ${quarterUrl('2026-04-01', '2026-07-01')}`,
      });
    });

    it('stops at a window without the incident-list envelope and caches nothing from it', async () => {
      let malformed = true;
      serveWindows({}, (request, body) =>
        request.url.includes('start_at=2026-07-01') && malformed
          ? Response.json({})
          : Response.json(body),
      );
      const first = await readIncidentioHistory(CLERK, day('2026-04-01'));
      expect(first).toMatchObject({ reachedFloor: false, readBackTo: '2026-10-01' });
      expect(first.gap).toContain('the quarter starting 2026-07-01 failed: ');
      expect(first.gap).toContain(quarterUrl('2026-07-01', '2026-10-01'));

      malformed = false;
      const second = await readIncidentioHistory(CLERK, day('2026-04-01'));
      expect(second).toMatchObject({ reachedFloor: true, readBackTo: '2026-04-01', gap: null });
      // The Q4 window came from the cache; the rejected Q3 body did not.
      expect(windowRequests()).toEqual([
        quarterUrl('2026-10-01', '2027-01-01'),
        quarterUrl('2026-07-01', '2026-10-01'),
        quarterUrl('2026-07-01', '2026-10-01'),
        quarterUrl('2026-04-01', '2026-07-01'),
      ]);
    });

    it('reads no window when the summary fails, and says so', async () => {
      http.reset();
      serve(CLERK_SUMMARY, {});
      serveWindows({});
      const walk = await readIncidentioHistory(CLERK, day('2026-01-01'));
      expect(walk).toEqual({
        records: [],
        reachedFloor: false,
        readBackTo: null,
        gap: expect.stringMatching(/^the page summary failed: .*proxy\/status\.clerk\.com /),
      });
      expect(windowRequests()).toEqual([]);
    });

    it('gives a window the full fetch timeout while the limit leaves more, and names its own failure', async () => {
      // The newest window would answer at 9 s; the 5 s fetch timeout cuts it first.
      const aborted: string[] = [];
      serveWindows({}, (request, body) => {
        const start = new URL(request.url).searchParams.get('start_at')?.slice(0, 10) ?? '';
        if (start !== '2026-10-01') return Response.json(body);
        return new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => resolve(Response.json(body)), 9000);
          request.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              aborted.push(start);
              reject(request.signal.reason);
            },
            { once: true },
          );
        });
      });
      let walk: Awaited<ReturnType<typeof readIncidentioHistory>> | undefined;
      const pending = readIncidentioHistory(CLERK, day('2026-04-01')).then((w) => {
        walk = w;
      });

      await vi.advanceTimersByTimeAsync(5000);
      expect(walk).toEqual({
        records: [],
        reachedFloor: false,
        readBackTo: null,
        gap: `the quarter starting 2026-10-01 failed: Timed out after 5000ms fetching ${quarterUrl('2026-10-01', '2027-01-01')}`,
      });
      await pending;
      expect(aborted).toEqual(['2026-10-01']);
      expect(Date.now() - NOW).toBe(5000);
      expect(windowRequests()).toEqual([quarterUrl('2026-10-01', '2027-01-01')]);
    });

    it('settles at the 30-second limit when slow windows would run past it', async () => {
      // Every window answers after 4 s, under the 5 s fetch timeout, so only the shared
      // limit can stop the read: seven windows fit in 28 s, the eighth is cut at 30 s.
      serveWindows(
        { '2026-10-01': [clerkRecord(SMS_ID)] },
        (request, body) =>
          new Promise<Response>((resolve, reject) => {
            const timer = setTimeout(() => resolve(Response.json(body)), 4000);
            request.signal.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                reject(request.signal.reason);
              },
              { once: true },
            );
          }),
      );
      let walk: Awaited<ReturnType<typeof readIncidentioHistory>> | undefined;
      const pending = readIncidentioHistory(CLERK, day('2024-11-16')).then((w) => {
        walk = w;
      });

      await vi.advanceTimersByTimeAsync(29_999);
      expect(walk).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await pending;

      expect(Date.now() - NOW).toBe(30_000);
      expect(windowRequests()).toHaveLength(8);
      expect(walk).toEqual({
        records: [expect.objectContaining({ id: SMS_ID })],
        reachedFloor: false,
        readBackTo: '2025-04-01',
        gap: 'the 30-second limit on the read passed before the quarter starting 2025-01-01',
      });
    });

    it('sends no window request once no time is left, keeping the quarters read before', async () => {
      serveWindows({ '2026-10-01': [clerkRecord(SMS_ID)] }, (request, body) => {
        // The clock reaches the limit while this window answers, leaving no time for the next.
        if (request.url.includes('start_at=2026-07-01')) vi.setSystemTime(NOW + 30_000);
        return Response.json(body);
      });
      const walk = await readIncidentioHistory(CLERK, day('2024-11-16'));

      expect(windowRequests()).toEqual([
        quarterUrl('2026-10-01', '2027-01-01'),
        quarterUrl('2026-07-01', '2026-10-01'),
      ]);
      expect(walk).toEqual({
        records: [expect.objectContaining({ id: SMS_ID })],
        reachedFloor: false,
        readBackTo: '2026-07-01',
        gap: 'the 30-second limit on the read passed before the quarter starting 2026-04-01',
      });
    });
  });
});
