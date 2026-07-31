/**
 * @fileoverview AWS Health adapter — fetches the public AWS Health Dashboard
 * feed (https://health.aws.amazon.com/public/currentevents) and normalizes it
 * into the Atlassian Statuspage shapes the tools consume.
 *
 * Feed quirks:
 * - The body is UTF-16 encoded (Content-Type: application/json;charset=utf-16,
 *   observed live as UTF-16BE with a BOM) — `response.json()` would mangle it,
 *   so the adapter decodes raw bytes with a BOM-sniffing TextDecoder.
 * - It is one global list of currently-OPEN events, not a per-page feed: there
 *   is no history, so resolved incidents and scheduled maintenances are always
 *   empty for AWS.
 * - The per-event `status` codes are undocumented. Empirical mapping (observed
 *   live 2026-07: operational services carry previous_status "0"; open events
 *   carried status "3" during a multi-AZ regional disruption, with event_log
 *   severities escalating 1 → 2 → 3):
 *     '0' → none, '1' → minor, '2' → major, '3' → major, unknown → minor.
 *   'critical' is intentionally never emitted — every feed event is
 *   region/service-scoped, so even the most severe published event is a
 *   partial outage of AWS as a whole, not a complete outage.
 * @module services/status-adapters/aws-adapter
 */

import { getServerConfig } from '@/config/server-config.js';
import type {
  StatuspageComponent,
  StatuspageIncident,
  StatuspageIncidentsResponse,
  StatuspagePage,
  StatuspageScheduledMaintenancesResponse,
  StatuspageSeverityIndicator,
  StatuspageSummaryResponse,
} from '@/services/statuspage/types.js';
import { fetchCached } from '@/utils/cached-fetch.js';

const AWS_CURRENT_EVENTS_URL = 'https://health.aws.amazon.com/public/currentevents';

// --- Raw AWS feed types ---

interface AwsEventLogEntry {
  message?: string;
  status?: number | string;
  summary?: string;
  /** Epoch seconds. */
  timestamp?: number | string;
}

export interface AwsEvent {
  arn?: string;
  /** Epoch seconds (string). */
  date?: string | number;
  event_log?: AwsEventLogEntry[];
  impacted_services?: Record<string, { service_name?: string; current?: string; max?: string }>;
  region_name?: string;
  service?: string;
  service_name?: string;
  status?: string | number;
  summary?: string;
}

/** Identifies the vendor the response is being normalized for. */
export interface AwsTarget {
  name: string;
  slug: string | null;
  /** Public dashboard URL (display only — the feed endpoint is fixed). */
  url: string;
}

// --- Decoding ---

/**
 * Decode the UTF-16 feed body. BOM-sniffed: FE FF → big-endian (what the live
 * endpoint serves), anything else → little-endian. TextDecoder strips a
 * matching BOM automatically.
 */
export function decodeUtf16(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const encoding = bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-16le';
  return new TextDecoder(encoding).decode(buf);
}

// --- Mappings ---

/** Empirical severity mapping — see module fileoverview for the rationale. */
function statusToImpact(status: string | number | undefined): StatuspageSeverityIndicator {
  switch (String(status)) {
    case '0':
      return 'none';
    case '1':
      return 'minor';
    case '2':
    case '3':
      return 'major';
    default:
      return 'minor';
  }
}

/** AWS dashboard severity vocabulary for event_log entries. */
function logStatusLabel(status: string | number | undefined): string {
  switch (String(status)) {
    case '1':
      return 'informational';
    case '2':
      return 'degradation';
    case '3':
      return 'disruption';
    default:
      return 'update';
  }
}

function epochSecondsToIso(value: string | number | undefined): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  return new Date(n * 1000).toISOString();
}

const SEVERITY_RANK = { none: 0, minor: 1, major: 2, critical: 3 } as const;

function buildPage(target: AwsTarget): StatuspagePage {
  return {
    id: target.slug ?? 'aws',
    name: target.name,
    time_zone: 'Etc/UTC',
    updated_at: new Date().toISOString(),
    url: target.url,
  };
}

/** Normalize one open AWS event into a Statuspage incident. */
export function mapAwsEvent(event: AwsEvent, target: AwsTarget): StatuspageIncident {
  const log = [...(event.event_log ?? [])].sort(
    (a, b) => Number(a.timestamp ?? 0) - Number(b.timestamp ?? 0),
  );
  const affected = Object.entries(event.impacted_services ?? {})
    .map(([key, svc]) => ({
      code: key,
      name: svc.service_name ?? key,
      new_status: logStatusLabel(svc.current),
      old_status: '',
    }))
    .filter((a) => a.name);

  return {
    id: event.arn ?? `${event.service ?? 'aws'}-${event.date ?? 'unknown'}`,
    name: `${event.summary ?? 'AWS event'} — ${event.service_name ?? 'Unknown service'} (${event.region_name ?? 'Unknown region'})`,
    impact: statusToImpact(event.status),
    // The feed only lists open events — there is no lifecycle field, so every
    // event maps to the generic active state.
    status: 'investigating',
    created_at: epochSecondsToIso(event.date),
    started_at: epochSecondsToIso(event.date) || null,
    resolved_at: null,
    monitoring_at: null,
    page_id: target.slug ?? 'aws',
    components: [],
    incident_updates: log.map((entry, i) => ({
      id: `${event.arn ?? 'event'}-${i}`,
      body: entry.message ?? entry.summary ?? '',
      status: logStatusLabel(entry.status),
      created_at: epochSecondsToIso(entry.timestamp),
      display_at: epochSecondsToIso(entry.timestamp),
      affected_components: i === log.length - 1 && affected.length > 0 ? affected : null,
    })),
  };
}

/** Normalize the open-events feed into a Statuspage summary. */
export function mapAwsSummary(events: AwsEvent[], target: AwsTarget): StatuspageSummaryResponse {
  const incidents = (events ?? []).map((e) => mapAwsEvent(e, target));
  let indicator: StatuspageSeverityIndicator = 'none';
  for (const inc of incidents) {
    if (inc.impact !== 'maintenance' && SEVERITY_RANK[inc.impact] > SEVERITY_RANK[indicator])
      indicator = inc.impact;
  }
  // One component per open event — a compact "what is degraded" signal.
  const components: StatuspageComponent[] = incidents.map((inc, i) => {
    const event = events[i];
    return {
      id: inc.id,
      name: `${event?.service_name ?? 'Unknown service'} (${event?.region_name ?? 'Unknown region'})`,
      status: inc.impact === 'major' ? 'partial_outage' : 'degraded_performance',
      created_at: '',
      updated_at: inc.created_at,
      description: null,
      group: false,
      group_id: null,
      only_show_if_degraded: true,
      position: i,
      showcase: true,
    };
  });
  return {
    page: buildPage(target),
    status: {
      indicator,
      description:
        incidents.length === 0
          ? 'All Systems Operational'
          : `${incidents.length} open event${incidents.length === 1 ? '' : 's'} on the AWS Health Dashboard`,
    },
    components,
    incidents,
    scheduled_maintenances: [],
  };
}

// --- Fetchers ---

function fetchRaw(): Promise<{ data: AwsEvent[]; cached: boolean }> {
  const { cacheTtlMs, fetchTimeoutMs } = getServerConfig();
  return fetchCached<AwsEvent[]>(
    AWS_CURRENT_EVENTS_URL,
    cacheTtlMs,
    fetchTimeoutMs,
    async (res) => JSON.parse(decodeUtf16(await res.arrayBuffer())) as AwsEvent[],
  );
}

export async function fetchAwsSummary(
  target: AwsTarget,
): Promise<{ data: StatuspageSummaryResponse; cached: boolean }> {
  const { data, cached } = await fetchRaw();
  return { data: mapAwsSummary(data, target), cached };
}

export async function fetchAwsIncidents(
  target: AwsTarget,
): Promise<{ data: StatuspageIncidentsResponse; cached: boolean }> {
  const { data, cached } = await fetchRaw();
  return {
    data: { page: buildPage(target), incidents: data.map((e) => mapAwsEvent(e, target)) },
    cached,
  };
}

/** The feed carries no maintenance data — always empty, no network call. */
export function fetchAwsScheduledMaintenances(
  target: AwsTarget,
): Promise<{ data: StatuspageScheduledMaintenancesResponse; cached: boolean }> {
  return Promise.resolve({
    data: { page: buildPage(target), scheduled_maintenances: [] },
    cached: false,
  });
}
