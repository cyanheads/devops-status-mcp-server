/**
 * @fileoverview Tests for the AWS Health adapter — UTF-16 decoding and event
 * normalization. aws-currentevents.utf16be.bin is the raw byte capture of the
 * live feed (UTF-16BE with BOM, two open events at capture time).
 * @module tests/services/status-adapters/aws-adapter.test
 */

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AwsEvent,
  decodeUtf16,
  fetchAwsIncidents,
  fetchAwsScheduledMaintenances,
  fetchAwsSummary,
  mapAwsEvent,
  mapAwsSummary,
} from '@/services/status-adapters/aws-adapter.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    cacheTtlMs: 60_000,
    fetchTimeoutMs: 5000,
    certTimeoutMs: 5000,
    dnsTimeoutMs: 3000,
  }),
}));

const AWS = { name: 'Amazon Web Services', url: 'https://health.aws.amazon.com', slug: 'aws' };

function liveBytes(): ArrayBuffer {
  const buf = readFileSync(new URL('fixtures/aws-currentevents.utf16be.bin', import.meta.url));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function liveEvents(): AwsEvent[] {
  return JSON.parse(decodeUtf16(liveBytes())) as AwsEvent[];
}

/** A resolved event as the feed lists it: status "0", `[RESOLVED]` summary. */
const RESOLVED_EVENT: AwsEvent = {
  arn: 'a',
  status: '0',
  service_name: 'Amazon EC2',
  region_name: 'N. Virginia',
  date: '1772043269',
  summary: '[RESOLVED] Increased Error Rates',
  event_log: [
    { status: 1, message: 'Investigating.', timestamp: 1772043269 },
    { status: 0, message: 'Resolved.', timestamp: 1772052712 },
  ],
};

const OPEN_EVENT: AwsEvent = {
  arn: 'open-arn',
  status: '3',
  service_name: 'Amazon S3',
  region_name: 'N. Virginia',
  date: '1772050000',
  summary: 'Increased Error Rates',
  event_log: [{ status: 3, message: 'We are investigating.', timestamp: 1772050000 }],
};

describe('decodeUtf16', () => {
  it('decodes the real UTF-16BE (BOM FE FF) feed bytes into parseable JSON', () => {
    const text = decodeUtf16(liveBytes());
    expect(text.startsWith('[')).toBe(true); // BOM stripped
    const events = JSON.parse(text) as AwsEvent[];
    expect(events).toHaveLength(2);
    expect(events[0]!.arn).toContain('arn:aws:health');
  });

  it('decodes UTF-16LE bytes (no BOM) as the fallback branch', () => {
    const le = new Uint8Array(Buffer.from('[]', 'utf16le'));
    expect(JSON.parse(decodeUtf16(le.buffer as ArrayBuffer))).toEqual([]);
  });
});

describe('mapAwsSummary', () => {
  it('maps the live capture (two open status-3 events) to indicator major', () => {
    const summary = mapAwsSummary(liveEvents(), AWS);
    expect(summary.status.indicator).toBe('major');
    expect(summary.status.description).toContain('2 open events');
    expect(summary.incidents).toHaveLength(2);
    expect(summary.components).toHaveLength(2);
    expect(summary.components[0]!.status).toBe('partial_outage');
    expect(summary.page.url).toBe('https://health.aws.amazon.com');
    expect(summary.scheduled_maintenances).toHaveLength(0);
  });

  it('maps an empty feed to indicator none', () => {
    const summary = mapAwsSummary([], AWS);
    expect(summary.status.indicator).toBe('none');
    expect(summary.status.description).toBe('All Systems Operational');
    expect(summary.incidents).toHaveLength(0);
  });

  it('never emits critical — even the worst observed severity maps to major', () => {
    for (const status of ['1', '2', '3', '9', undefined]) {
      const event: AwsEvent = { summary: 'x', ...(status === undefined ? {} : { status }) };
      const summary = mapAwsSummary([event], AWS);
      expect(['minor', 'major']).toContain(summary.status.indicator);
    }
  });

  it('maps each open status to its indicator and component status', () => {
    const cases = [
      ['1', 'minor', 'degraded_performance'],
      ['2', 'major', 'partial_outage'],
      ['3', 'major', 'partial_outage'],
      ['9', 'minor', 'degraded_performance'],
    ] as const;
    for (const [status, indicator, component] of cases) {
      const summary = mapAwsSummary([{ ...OPEN_EVENT, status }], AWS);
      expect(summary.status.indicator, status).toBe(indicator);
      expect(
        summary.components.map((c) => c.status),
        status,
      ).toEqual([component]);
      expect(
        summary.incidents?.map((i) => i.status),
        status,
      ).toEqual(['investigating']);
      expect(summary.status.description, status).toBe('1 open event on the AWS Health Dashboard');
    }
  });

  /**
   * The feed keeps a resolved event listed for hours, with status "0" and a
   * `[RESOLVED]` summary prefix; it is history, not current health.
   */
  it('leaves a resolved (status 0) event out of the summary entirely', () => {
    const summary = mapAwsSummary([RESOLVED_EVENT], AWS);
    expect(summary.status.indicator).toBe('none');
    expect(summary.status.description).toBe('All Systems Operational');
    expect(summary.components).toEqual([]);
    expect(summary.incidents).toEqual([]);
  });

  it('counts and componentizes only the open event when a resolved one is listed beside it', () => {
    const summary = mapAwsSummary([RESOLVED_EVENT, OPEN_EVENT], AWS);
    expect(summary.status.indicator).toBe('major');
    expect(summary.status.description).toBe('1 open event on the AWS Health Dashboard');
    expect(summary.components.map((c) => [c.name, c.status])).toEqual([
      ['Amazon S3 (N. Virginia)', 'partial_outage'],
    ]);
    expect(summary.incidents?.map((i) => i.id)).toEqual(['open-arn']);
  });
});

describe('mapAwsEvent', () => {
  it('maps a live event — arn id, epoch timestamps, log entries as updates', () => {
    const event = liveEvents()[0]!;
    const inc = mapAwsEvent(event, AWS);
    expect(inc.id).toBe(event.arn);
    expect(inc.name).toContain(event.service_name!);
    expect(inc.name).toContain(event.region_name!);
    expect(inc.impact).toBe('major'); // event status "3"
    expect(inc.status).toBe('investigating'); // feed lists only open events
    expect(inc.resolved_at).toBeNull();
    expect(inc.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/); // epoch seconds → ISO
    expect(inc.incident_updates).toHaveLength(event.event_log!.length);
    // Severity vocabulary on updates
    expect(inc.incident_updates[0]!.status).toBe('informational'); // log status 1
    // Impacted services ride the latest update as affected components
    const last = inc.incident_updates[inc.incident_updates.length - 1]!;
    expect(last.affected_components?.length).toBeGreaterThan(0);
  });

  it('maps a status-0 event to a resolved incident, dated by its newest log entry', () => {
    const inc = mapAwsEvent(RESOLVED_EVENT, AWS);
    expect(inc.status).toBe('resolved');
    expect(inc.resolved_at).toBe('2026-02-25T20:51:52.000Z');
    expect(inc.started_at).toBe('2026-02-25T18:14:29.000Z');
    // The highest severity its log reached, not the resolved event's own "0".
    expect(inc.impact).toBe('minor');
    expect(inc.incident_updates.map((u) => u.status)).toEqual(['informational', 'resolved']);
  });

  it('walks every log entry for a resolved event, whatever order the feed lists them in', () => {
    const inc = mapAwsEvent(
      {
        ...RESOLVED_EVENT,
        event_log: [
          { status: 0, message: 'Resolved.', timestamp: 1772060000 },
          { status: 1, message: 'Investigating.', timestamp: 1772043269 },
          { status: 3, message: 'Disruption.', timestamp: 1772050000 },
          { status: 2, message: 'Recovering.', timestamp: 1772055000 },
        ],
      },
      AWS,
    );
    expect(inc.impact).toBe('major');
    expect(inc.resolved_at).toBe(new Date(1772060000 * 1000).toISOString());
    expect(inc.incident_updates.map((u) => u.status)).toEqual([
      'informational',
      'disruption',
      'degradation',
      'resolved',
    ]);
  });

  it('rates a resolved event whose log never rose above 0 as none', () => {
    const inc = mapAwsEvent(
      {
        ...RESOLVED_EVENT,
        event_log: [{ status: 0, message: 'Resolved.', timestamp: 1772052712 }],
      },
      AWS,
    );
    expect(inc.impact).toBe('none');
    expect(inc.status).toBe('resolved');
  });

  it('keeps a resolved event with no log resolved, with no resolution time and minor impact', () => {
    const inc = mapAwsEvent({ ...RESOLVED_EVENT, event_log: [] }, AWS);
    expect(inc.status).toBe('resolved');
    expect(inc.resolved_at).toBeNull();
    expect(inc.impact).toBe('minor'); // unknown severity — the adapter's conservative default
  });

  it('labels a recovered impacted service resolved on the latest update', () => {
    const inc = mapAwsEvent(
      {
        ...RESOLVED_EVENT,
        impacted_services: { ec2: { service_name: 'Amazon EC2', current: '0', max: '1' } },
      },
      AWS,
    );
    expect(inc.incident_updates.at(-1)?.affected_components).toEqual([
      { code: 'ec2', name: 'Amazon EC2', new_status: 'resolved', old_status: '' },
    ]);
  });

  it('does not crash on a sparse event with omitted fields', () => {
    const inc = mapAwsEvent({}, AWS);
    expect(inc.impact).toBe('minor'); // unknown status — conservative default
    expect(inc.created_at).toBe('');
    expect(inc.incident_updates).toHaveLength(0);
  });
});

describe('fetchers', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(liveBytes()),
        json: vi.fn().mockRejectedValue(new Error('json() must not be used on UTF-16 body')),
      }),
    );
  });

  it('fetchAwsSummary decodes raw bytes from the currentevents endpoint', async () => {
    const { data } = await fetchAwsSummary(AWS);
    expect(data.incidents).toHaveLength(2);
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      'https://health.aws.amazon.com/public/currentevents',
    );
  });

  it('fetchAwsIncidents keeps a listed resolved event beside the open ones', async () => {
    const bytes = new Uint8Array(
      Buffer.from(JSON.stringify([RESOLVED_EVENT, OPEN_EVENT]), 'utf16le'),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(bytes.buffer),
      }),
    );
    // The feed URL is fixed, so a fresh module graph is what keeps the shared
    // response cache from serving another case's capture.
    vi.resetModules();
    const fresh = await import('@/services/status-adapters/aws-adapter.js');
    const { data } = await fresh.fetchAwsIncidents(AWS);
    expect(data.incidents.map((i) => [i.id, i.status])).toEqual([
      ['a', 'resolved'],
      ['open-arn', 'investigating'],
    ]);
  });

  it('fetchAwsIncidents returns all open events; second call hits the cache', async () => {
    const { data } = await fetchAwsIncidents(AWS);
    expect(data.incidents).toHaveLength(2);
    const again = await fetchAwsIncidents(AWS);
    expect(again.cached).toBe(true);
  });

  it('fetchAwsScheduledMaintenances returns empty without a network call', async () => {
    const { data } = await fetchAwsScheduledMaintenances(AWS);
    expect(data.scheduled_maintenances).toHaveLength(0);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
