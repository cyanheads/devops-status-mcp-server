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
      const summary = mapAwsSummary([{ status, summary: 'x' }], AWS);
      expect(['minor', 'major']).toContain(summary.status.indicator);
    }
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
