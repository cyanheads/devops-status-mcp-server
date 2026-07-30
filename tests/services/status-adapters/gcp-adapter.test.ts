/**
 * @fileoverview Tests for the Google Cloud adapter. gcp-incidents.json is an
 * unmodified capture of https://status.cloud.google.com/incidents.json, so every
 * field shape asserted below is the live feed's, not a hand-written model of it.
 * The capture carries only resolved incidents, so the open-incident cases are
 * built by removing `end` from a real record rather than by inventing one.
 * @module tests/services/status-adapters/gcp-adapter.test
 */

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchGcpIncidents,
  fetchGcpScheduledMaintenances,
  fetchGcpSummary,
  type GcpIncident,
  mapGcpIncident,
  mapGcpIncidents,
  mapGcpSummary,
} from '@/services/status-adapters/gcp-adapter.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    // Entries expire immediately: the feed URL is fixed, so a live cache would
    // let one test's response satisfy the next test's fetch.
    cacheTtlMs: -1,
    fetchTimeoutMs: 5000,
    certTimeoutMs: 5000,
    dnsTimeoutMs: 3000,
  }),
}));

const GCP = { name: 'Google Cloud', url: 'https://status.cloud.google.com', slug: 'gcp' };

function liveIncidents(): GcpIncident[] {
  return JSON.parse(
    readFileSync(new URL('fixtures/gcp-incidents.json', import.meta.url), 'utf8'),
  ) as GcpIncident[];
}

/** The multi-product europe-west4 outage — severity "medium", status_impact SERVICE_DISRUPTION. */
function disruptionRecord(): GcpIncident {
  const record = liveIncidents().find((i) => i.id === '3BvH3LVGcupoYqV6F4Nw');
  if (!record) throw new Error('fixture no longer carries incident 3BvH3LVGcupoYqV6F4Nw');
  return record;
}

/** The Vertex Gemini API report — severity "low", status_impact SERVICE_INFORMATION. */
function informationRecord(): GcpIncident {
  const record = liveIncidents().find((i) => i.id === '41E5S3mkTGDfkZuJZH5k');
  if (!record) throw new Error('fixture no longer carries incident 41E5S3mkTGDfkZuJZH5k');
  return record;
}

describe('live capture', () => {
  it('is a bare array of incidents that all carry an end timestamp', () => {
    const incidents = liveIncidents();
    expect(Array.isArray(incidents)).toBe(true);
    expect(incidents.length).toBeGreaterThan(0);
    for (const i of incidents) expect(i.end).toBeTruthy();
  });

  it('carries severities the published schema does not document', () => {
    // incidents.schema.json documents severity as "(high, medium)" — `low` is
    // emitted anyway, which is why the mapper never rejects an unknown value.
    const severities = new Set(liveIncidents().map((i) => i.severity));
    expect(severities.has('low')).toBe(true);
    expect(severities.has('medium')).toBe(true);
  });

  it('orders updates newest-first, the opposite of the normalized order', () => {
    const record = disruptionRecord();
    const first = new Date(record.updates?.[0]?.when ?? 0).getTime();
    const last = new Date(record.updates?.at(-1)?.when ?? 0).getTime();
    expect(first).toBeGreaterThan(last);
  });
});

describe('mapGcpIncident', () => {
  it('maps the live disruption record — id, summary, severity, resolution from end', () => {
    const record = disruptionRecord();
    const incident = mapGcpIncident(record, GCP);

    expect(incident.id).toBe(record.id);
    expect(incident.name).toBe(record.external_desc);
    expect(incident.impact).toBe('major'); // severity "medium"
    expect(incident.status).toBe('resolved');
    expect(incident.resolved_at).toBe(record.end);
    expect(incident.started_at).toBe(record.begin);
    expect(incident.created_at).toBe(record.created);
    expect(incident.page_id).toBe('gcp');
  });

  it('resolves the relative uri into an absolute dashboard permalink', () => {
    const incident = mapGcpIncident(disruptionRecord(), GCP);
    expect(incident.shortlink).toBe(
      'https://status.cloud.google.com/incidents/3BvH3LVGcupoYqV6F4Nw',
    );
  });

  it('re-sorts the newest-first updates into oldest-first', () => {
    const record = disruptionRecord();
    const incident = mapGcpIncident(record, GCP);
    expect(incident.incident_updates).toHaveLength(record.updates?.length ?? 0);
    const times = incident.incident_updates.map((u) => new Date(u.created_at).getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(incident.incident_updates[0]?.body).toBe(record.updates?.at(-1)?.text);
  });

  it('labels each update by the service status it carries, not a lifecycle word', () => {
    const incident = mapGcpIncident(disruptionRecord(), GCP);
    const labels = new Set(incident.incident_updates.map((u) => u.status));
    for (const label of labels) expect(['available', 'disruption', 'information']).toContain(label);
    // The final update of a resolved incident reports the service back up.
    expect(incident.incident_updates.at(-1)?.status).toBe('available');
  });

  it('carries affected_products as components on the latest update, using current_title', () => {
    const incident = mapGcpIncident(informationRecord(), GCP);
    const affected = incident.incident_updates.at(-1)?.affected_components;
    expect(affected?.map((c) => c.name)).toContain('Gemini on Agent Platform'); // title: "Vertex Gemini API"
    expect(affected?.map((c) => c.name)).not.toContain('Vertex Gemini API');
    expect(affected?.[0]?.code).toBeTruthy(); // the stable product id
    // Only the latest update carries them.
    expect(incident.incident_updates[0]?.affected_components).toBeNull();
  });

  it('keeps a SERVICE_INFORMATION incident in the incident stream at its own severity', () => {
    // status_impact is not a maintenance signal: this record is a root-caused
    // report of elevated error rates, so relabelling it maintenance would be wrong.
    const record = informationRecord();
    expect(record.status_impact).toBe('SERVICE_INFORMATION');
    const incident = mapGcpIncident(record, GCP);
    expect(incident.impact).toBe('minor'); // severity "low"
    expect(incident.scheduled_for).toBeUndefined();
    expect(incident.status).toBe('resolved');
  });

  it('treats a record with no end as open, whether the field is absent or empty', () => {
    const { end: _dropped, ...withoutEnd } = disruptionRecord();
    for (const record of [withoutEnd, { ...withoutEnd, end: '' }, { ...withoutEnd, end: '  ' }]) {
      const incident = mapGcpIncident(record, GCP);
      expect(incident.status).toBe('investigating');
      expect(incident.resolved_at).toBeNull();
    }
  });

  it('does not drop or reject an incident whose severity is not in the mapping', () => {
    for (const severity of ['high', 'critical', 'catastrophic', '', undefined]) {
      const incident = mapGcpIncident({ ...disruptionRecord(), severity }, GCP);
      expect(incident.id).toBe('3BvH3LVGcupoYqV6F4Nw');
      expect(['minor', 'major', 'critical']).toContain(incident.impact);
    }
    expect(mapGcpIncident({ ...disruptionRecord(), severity: 'high' }, GCP).impact).toBe(
      'critical',
    );
    expect(mapGcpIncident({ ...disruptionRecord(), severity: 'nonsense' }, GCP).impact).toBe(
      'minor',
    );
  });

  it('does not crash on a sparse record with every optional field omitted', () => {
    const incident = mapGcpIncident({}, GCP);
    expect(incident.id).toBe('unknown');
    expect(incident.impact).toBe('minor');
    expect(incident.status).toBe('investigating');
    expect(incident.created_at).toBe('');
    expect(incident.started_at).toBeNull();
    expect(incident.shortlink).toBeNull();
    expect(incident.incident_updates).toHaveLength(0);
  });
});

describe('mapGcpSummary', () => {
  it('reports all clear when every incident in the live capture is resolved', () => {
    const summary = mapGcpSummary(liveIncidents(), GCP);
    expect(summary.status.indicator).toBe('none');
    expect(summary.status.description).toBe('All Systems Operational');
    expect(summary.incidents).toHaveLength(0);
    expect(summary.components).toHaveLength(0);
    expect(summary.scheduled_maintenances).toHaveLength(0);
    expect(summary.page.url).toBe('https://status.cloud.google.com');
  });

  it('surfaces an open incident and its products as degraded components', () => {
    const { end: _dropped, ...open } = disruptionRecord();
    const summary = mapGcpSummary([open, informationRecord()], GCP);

    expect(summary.status.indicator).toBe('major'); // the open record's severity "medium"
    expect(summary.status.description).toBe('1 active incident');
    expect(summary.incidents).toHaveLength(1); // the resolved record is not current health
    expect(summary.components.map((c) => c.name).sort()).toEqual([
      'Bare Metal Solution',
      'Google Cloud NetApp Volumes',
      'VMWare engine',
    ]);
    for (const component of summary.components) expect(component.status).toBe('partial_outage');
  });

  it('lists a product named by two open incidents once, at the worse impact', () => {
    const { end: _dropped, ...open } = disruptionRecord();
    const summary = mapGcpSummary(
      [
        { ...open, id: 'low-one', severity: 'low' },
        { ...open, id: 'high-one', severity: 'high' },
      ],
      GCP,
    );
    expect(summary.status.indicator).toBe('critical');
    expect(summary.components).toHaveLength(3);
    for (const component of summary.components) expect(component.status).toBe('major_outage');
  });
});

describe('mapGcpIncidents', () => {
  it('returns the whole capture newest-first', () => {
    const incidents = mapGcpIncidents(liveIncidents(), GCP).incidents;
    expect(incidents).toHaveLength(liveIncidents().length);
    const times = incidents.map((i) => new Date(i.created_at).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });
});

describe('fetchers', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: vi.fn().mockResolvedValue(liveIncidents()),
      }),
    );
  });

  it('fetchGcpSummary reads the fixed incidents.json endpoint', async () => {
    const { data } = await fetchGcpSummary(GCP);
    expect(data.status.indicator).toBe('none');
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      'https://status.cloud.google.com/incidents.json',
    );
  });

  it('fetchGcpIncidents returns every record in the capture', async () => {
    const { data } = await fetchGcpIncidents(GCP);
    expect(data.incidents).toHaveLength(liveIncidents().length);
    expect(data.page.name).toBe('Google Cloud');
  });

  it('fetchGcpScheduledMaintenances returns empty without a network call', async () => {
    const { data } = await fetchGcpScheduledMaintenances(GCP);
    expect(data.scheduled_maintenances).toHaveLength(0);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('rejects a 200 carrying something other than the incident array', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: vi.fn().mockResolvedValue({ page: {}, incidents: [] }),
      }),
    );
    await expect(fetchGcpIncidents(GCP)).rejects.toThrow(/rather than the incident array/);
  });
});
