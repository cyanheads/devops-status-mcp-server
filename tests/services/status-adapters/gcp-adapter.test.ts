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
      const { severity: _replaced, ...base } = disruptionRecord();
      const incident = mapGcpIncident(
        { ...base, ...(severity === undefined ? {} : { severity }) },
        GCP,
      );
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

  /** Google Cloud writes update text as markdown, never HTML — no conversion may touch it. */
  it('keeps every markdown update body byte-identical, blank lines and indentation included (#63)', () => {
    const records = liveIncidents();
    const sources = records.flatMap((r) => (r.updates ?? []).map((u) => u.text ?? ''));
    const bodies = records.flatMap((r) =>
      mapGcpIncident(r, GCP).incident_updates.map((u) => u.body),
    );
    expect(bodies.length).toBeGreaterThan(0);
    expect([...bodies].sort()).toEqual([...sources].sort());

    const markdown =
      '**Summary:**\n\nError rates rose (<1%) in us-central1.\n\n**Workaround:**\n\n- Retry with backoff:\n\n      gcloud run deploy --region=us-east1\n\n  - then confirm';
    const [update] = mapGcpIncident(
      { id: 'md', updates: [{ text: markdown, when: '2026-10-01T00:00:00Z' }] },
      GCP,
    ).incident_updates;
    expect(update!.body).toBe(markdown);
  });

  /**
   * Google lists an incident's regions apart from its products, in
   * `currently_affected_locations` and `previously_affected_locations` (#84).
   */
  describe('affected locations (#84)', () => {
    it('carries the previously affected regions of the live record in feed order, title as name', () => {
      const incident = mapGcpIncident(informationRecord(), GCP);
      expect(incident.affected_locations).toEqual([
        { id: 'global', name: 'Global', current: false },
        {
          id: 'northamerica-northeast1',
          name: 'Montréal (northamerica-northeast1)',
          current: false,
        },
        { id: 'southamerica-east1', name: 'São Paulo (southamerica-east1)', current: false },
        { id: 'us-central1', name: 'Iowa (us-central1)', current: false },
        { id: 'us-east1', name: 'South Carolina (us-east1)', current: false },
        { id: 'us-east4', name: 'Northern Virginia (us-east4)', current: false },
        { id: 'us-east5', name: 'Columbus (us-east5)', current: false },
        { id: 'us-west1', name: 'Oregon (us-west1)', current: false },
      ]);
      // Locations are not components: the product list is unchanged.
      expect(incident.incident_updates.at(-1)?.affected_components?.map((c) => c.name)).toEqual(
        (informationRecord().affected_products ?? []).map((p) => p.current_title ?? p.title),
      );
    });

    it('lists current locations first, each list in feed order, a location in both once as current', () => {
      const incident = mapGcpIncident(
        {
          ...disruptionRecord(),
          currently_affected_locations: [
            { id: 'us-east1', title: 'South Carolina (us-east1)' },
            { id: 'us-central1', title: 'Iowa (us-central1)' },
          ],
          previously_affected_locations: [
            { id: 'us-central1', title: 'Iowa (us-central1)' },
            { id: 'europe-west4', title: 'Netherlands (europe-west4)' },
            { id: 'global', title: 'Global' },
          ],
        },
        GCP,
      );
      expect(incident.affected_locations).toEqual([
        { id: 'us-east1', name: 'South Carolina (us-east1)', current: true },
        { id: 'us-central1', name: 'Iowa (us-central1)', current: true },
        { id: 'europe-west4', name: 'Netherlands (europe-west4)', current: false },
        { id: 'global', name: 'Global', current: false },
      ]);
    });

    it('omits the field when the incident lists no location, absent or empty', () => {
      const {
        currently_affected_locations: _c,
        previously_affected_locations: _p,
        ...bare
      } = disruptionRecord();
      for (const record of [
        bare,
        { ...bare, currently_affected_locations: [], previously_affected_locations: [] },
        {},
      ]) {
        expect(mapGcpIncident(record, GCP)).not.toHaveProperty('affected_locations');
      }
    });

    it('skips an entry with no id and names a title-less entry by its id', () => {
      const incident = mapGcpIncident(
        {
          id: 'sparse',
          currently_affected_locations: [{ title: 'Nowhere' }, { id: '' }],
          previously_affected_locations: [{ id: 'asia-south2' }],
        },
        GCP,
      );
      expect(incident.affected_locations).toEqual([
        { id: 'asia-south2', name: 'asia-south2', current: false },
      ]);
      const none = mapGcpIncident(
        { id: 'none', previously_affected_locations: [{ title: 'Nowhere' }] },
        GCP,
      );
      expect(none).not.toHaveProperty('affected_locations');
    });
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

  it.each([
    [{ page: {}, incidents: [] }, 'an object'],
    [null, 'null'],
    ['incidents', 'a string'],
    [42, 'a number'],
  ])('rejects a 200 carrying %j, naming it as %s', async (body, named) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: vi.fn().mockResolvedValue(body),
      }),
    );
    await expect(fetchGcpIncidents(GCP)).rejects.toThrow(
      `https://status.cloud.google.com/incidents.json returned ${named} rather than the incident array the feed publishes.`,
    );
  });
});
