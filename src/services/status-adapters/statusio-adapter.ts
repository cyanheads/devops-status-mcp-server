/**
 * @fileoverview Status.io adapter — fetches the Public Status API
 * (https://status-api.hostedstatus.com/1.0/status/{page_id}) and normalizes
 * the response into the Atlassian Statuspage shapes the tools consume.
 * Serves gitlab and neon; any future Status.io vendor slots in via a page ID.
 *
 * Code tables (kb.status.io/developers/status-codes/):
 * - Incident/overall status (severity): 100 Operational, 200 Planned Maintenance,
 *   300 Degraded Performance, 400 Partial Service Disruption, 500 Service Disruption,
 *   600 Security Event.
 * - Incident state (lifecycle): 100 Investigating, 200 Identified, 300 Monitoring,
 *   400 Resolved.
 * The incident/maintenance item shape is doc-derived (both live pages were healthy
 * during validation) — the mapper reads every field defensively.
 * @module services/status-adapters/statusio-adapter
 */

import { getServerConfig } from '@/config/server-config.js';
import type {
  StatuspageComponent,
  StatuspageIncident,
  StatuspageIncidentsResponse,
  StatuspagePage,
  StatuspageScheduledMaintenancesResponse,
  StatuspageStatus,
  StatuspageSummaryResponse,
} from '@/services/statuspage/types.js';
import { fetchJsonCached } from '@/utils/cached-fetch.js';

const STATUSIO_API_BASE = 'https://status-api.hostedstatus.com/1.0/status/';

// --- Raw Status.io response types (Public Status API) ---

interface StatusioMessage {
  datetime?: string;
  details?: string;
  /** Lifecycle state code: 100 Investigating … 400 Resolved. */
  state?: number;
  /** Severity status code: 100 Operational … 600 Security Event. */
  status?: number;
}

interface StatusioAffected {
  _id?: string;
  name?: string;
}

interface StatusioIncidentItem {
  _id?: string;
  components_affected?: StatusioAffected[];
  containers_affected?: StatusioAffected[];
  datetime_open?: string;
  datetime_planned_end?: string;
  datetime_planned_start?: string;
  messages?: StatusioMessage[];
  name?: string;
}

interface StatusioComponentItem {
  id?: string;
  name?: string;
  status?: string;
  status_code?: number;
  updated?: string;
}

export interface StatusioResponse {
  result: {
    status_overall: { updated?: string; status?: string; status_code?: number };
    status?: StatusioComponentItem[];
    incidents?: StatusioIncidentItem[];
    maintenance?: { active?: StatusioIncidentItem[]; upcoming?: StatusioIncidentItem[] };
  };
}

/** Identifies the vendor the response is being normalized for. */
export interface StatusioTarget {
  name: string;
  slug: string | null;
  statusio_page_id: string;
  /** Public status page URL (display only). */
  url: string;
}

// --- Code mappings ---

function severityToIndicator(code: number | undefined): StatuspageStatus['indicator'] {
  switch (code) {
    case 100:
      return 'none';
    case 200: // Planned Maintenance — not a degradation
      return 'none';
    case 300:
      return 'minor';
    case 400:
      return 'major';
    case 500:
    case 600:
      return 'critical';
    default:
      // Unknown code — surface as degraded rather than crashing or claiming all-clear.
      return 'minor';
  }
}

function severityToComponentStatus(code: number | undefined): StatuspageComponent['status'] {
  switch (code) {
    case 100:
      return 'operational';
    case 200:
      return 'under_maintenance';
    case 300:
      return 'degraded_performance';
    case 400:
      return 'partial_outage';
    case 500:
    case 600:
      return 'major_outage';
    default:
      return 'degraded_performance';
  }
}

function stateToStatus(code: number | undefined): string {
  switch (code) {
    case 100:
      return 'investigating';
    case 200:
      return 'identified';
    case 300:
      return 'monitoring';
    case 400:
      return 'resolved';
    default:
      return 'investigating';
  }
}

// --- Mappers (exported for tests) ---

function buildPage(raw: StatusioResponse, target: StatusioTarget): StatuspagePage {
  return {
    id: target.slug ?? target.statusio_page_id,
    name: target.name,
    time_zone: 'Etc/UTC',
    updated_at: raw.result.status_overall?.updated ?? '',
    url: target.url,
  };
}

function mapIncident(
  item: StatusioIncidentItem,
  target: StatusioTarget,
  maintenanceStatus?: 'scheduled' | 'in_progress',
): StatuspageIncident {
  const messages = [...(item.messages ?? [])].sort(
    (a, b) => new Date(a.datetime ?? 0).getTime() - new Date(b.datetime ?? 0).getTime(),
  );
  const latest = messages[messages.length - 1];
  const affected = [...(item.components_affected ?? []), ...(item.containers_affected ?? [])]
    .filter((a) => a.name)
    .map((a) => ({
      code: a._id ?? '',
      name: a.name ?? '',
      new_status: '',
      old_status: '',
    }));

  const lifecycle = maintenanceStatus ?? stateToStatus(latest?.state);
  const isResolved = lifecycle === 'resolved';

  return {
    id: item._id ?? item.name ?? 'unknown',
    name: item.name ?? 'Unnamed incident',
    impact: maintenanceStatus ? 'none' : severityToIndicator(latest?.status),
    status: lifecycle,
    created_at: item.datetime_open ?? '',
    started_at: item.datetime_open ?? null,
    resolved_at: isResolved ? (latest?.datetime ?? null) : null,
    monitoring_at: null,
    page_id: target.statusio_page_id,
    components: [],
    ...(maintenanceStatus && {
      scheduled_for: item.datetime_planned_start ?? '',
      scheduled_until: item.datetime_planned_end ?? '',
    }),
    incident_updates: messages.map((m, i) => ({
      id: `${item._id ?? 'msg'}-${i}`,
      body: m.details ?? '',
      status: maintenanceStatus ?? stateToStatus(m.state),
      created_at: m.datetime ?? '',
      display_at: m.datetime ?? '',
      // Attach the incident-level affected lists to the latest update so
      // downstream affected-component extraction sees them.
      affected_components: i === messages.length - 1 && affected.length > 0 ? affected : null,
    })),
  };
}

function mapMaintenances(raw: StatusioResponse, target: StatusioTarget): StatuspageIncident[] {
  const active = (raw.result.maintenance?.active ?? []).map((m) =>
    mapIncident(m, target, 'in_progress'),
  );
  const upcoming = (raw.result.maintenance?.upcoming ?? []).map((m) =>
    mapIncident(m, target, 'scheduled'),
  );
  return [...active, ...upcoming];
}

/** Normalize a Status.io Public Status API response into a Statuspage summary. */
export function mapStatusioSummary(
  raw: StatusioResponse,
  target: StatusioTarget,
): StatuspageSummaryResponse {
  const overall = raw.result.status_overall ?? {};
  const components: StatuspageComponent[] = (raw.result.status ?? []).map((c, i) => ({
    id: c.id ?? `component-${i}`,
    name: c.name ?? 'Unknown',
    status: severityToComponentStatus(c.status_code),
    created_at: '',
    updated_at: c.updated ?? '',
    description: null,
    group: false,
    group_id: null,
    only_show_if_degraded: false,
    position: i,
    showcase: true,
  }));
  return {
    page: buildPage(raw, target),
    status: {
      indicator: severityToIndicator(overall.status_code),
      description: overall.status ?? 'Unknown',
    },
    components,
    incidents: (raw.result.incidents ?? []).map((i) => mapIncident(i, target)),
    scheduled_maintenances: mapMaintenances(raw, target),
  };
}

/** Normalize into the incidents-endpoint shape. */
export function mapStatusioIncidents(
  raw: StatusioResponse,
  target: StatusioTarget,
): StatuspageIncidentsResponse {
  return {
    page: buildPage(raw, target),
    incidents: (raw.result.incidents ?? []).map((i) => mapIncident(i, target)),
  };
}

/** Normalize into the scheduled-maintenances-endpoint shape. */
export function mapStatusioScheduledMaintenances(
  raw: StatusioResponse,
  target: StatusioTarget,
): StatuspageScheduledMaintenancesResponse {
  return {
    page: buildPage(raw, target),
    scheduled_maintenances: mapMaintenances(raw, target),
  };
}

// --- Fetchers ---

function fetchRaw(pageId: string): Promise<{ data: StatusioResponse; cached: boolean }> {
  const { cacheTtlMs, fetchTimeoutMs } = getServerConfig();
  return fetchJsonCached<StatusioResponse>(
    `${STATUSIO_API_BASE}${pageId}`,
    cacheTtlMs,
    fetchTimeoutMs,
  );
}

export async function fetchStatusioSummary(
  target: StatusioTarget,
): Promise<{ data: StatuspageSummaryResponse; cached: boolean }> {
  const { data, cached } = await fetchRaw(target.statusio_page_id);
  return { data: mapStatusioSummary(data, target), cached };
}

export async function fetchStatusioIncidents(
  target: StatusioTarget,
): Promise<{ data: StatuspageIncidentsResponse; cached: boolean }> {
  const { data, cached } = await fetchRaw(target.statusio_page_id);
  return { data: mapStatusioIncidents(data, target), cached };
}

export async function fetchStatusioScheduledMaintenances(
  target: StatusioTarget,
): Promise<{ data: StatuspageScheduledMaintenancesResponse; cached: boolean }> {
  const { data, cached } = await fetchRaw(target.statusio_page_id);
  return { data: mapStatusioScheduledMaintenances(data, target), cached };
}
