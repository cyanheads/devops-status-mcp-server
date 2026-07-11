/**
 * @fileoverview Firehydrant adapter — fetches the payload feed every
 * Firehydrant-hosted status page serves at {page}/data/payload.json (the
 * page SPA's own data source; same contract verified on status.redis.io and
 * status.firehydrant.com) and normalizes it into the Atlassian Statuspage
 * shapes the tools consume. Serves redis-cloud; any future Firehydrant vendor
 * slots in via its page URL.
 *
 * Feed notes:
 * - One payload carries everything: components (id + name only, no current
 *   condition), a per-page condition-name table (display name → canonical
 *   OPERATIONAL | DEGRADED | OFFLINE), and the full incident history. Current
 *   health is derived: an incident is active while timestamps.resolved is
 *   absent, and component status comes from active incidents' component
 *   conditions (operational otherwise).
 * - severitySlug values are org-configurable; the defaults observed live are
 *   SEV1…SEV4, MAINTENANCE, UNSET (plus custom ones like INVESTIGATION).
 *   Mapping: SEV1 → critical, SEV2 → major, SEV3/SEV4 → minor,
 *   MAINTENANCE → none, unknown → minor (an active event of unknown severity
 *   is at least a degradation). MAINTENANCE incidents feed the
 *   scheduled-maintenances stream instead of the incident list.
 * - There is no per-incident lifecycle field beyond the timestamps, so
 *   unresolved incidents map to the generic 'investigating' state.
 * - The history is unbounded (~950 incidents on status.redis.io). The full
 *   history is returned unwindowed; devops_get_incidents pages it tool-side
 *   via limit + offset, so older incidents stay reachable.
 * @module services/status-adapters/firehydrant-adapter
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

const FIREHYDRANT_DATA_PATH = '/data/payload.json';

// --- Raw Firehydrant payload types (/data/payload.json) ---

interface FirehydrantTimelineEntry {
  /**
   * Note text. `Note` events carry a plain string; `BulkImpactUpdate` events
   * nest it one level deeper ({ note: { note } }) or omit it entirely
   * (milestone-only updates).
   */
  details?: { note?: string | { note?: string } };
  /** When the update happened (the `time` field is when it was written to the feed). */
  occurredAt?: string;
  time?: string;
}

interface FirehydrantIncidentComponent {
  /** Page-specific condition display name (e.g. "Degraded") — canonicalized via payload.conditions. */
  condition?: string;
  id?: string;
  name?: string;
}

interface FirehydrantIncidentItem {
  components?: FirehydrantIncidentComponent[] | null;
  id?: string;
  /** Org-configurable severity slug: SEV1…SEV4, MAINTENANCE, UNSET, custom. */
  severitySlug?: string;
  timeline?: FirehydrantTimelineEntry[];
  timestamps?: { detected?: string; resolved?: string; started?: string };
  title?: string;
}

interface FirehydrantComponentItem {
  id?: string;
  name?: string;
}

export interface FirehydrantPayload {
  components?: FirehydrantComponentItem[];
  /** Per-page condition table: display name → canonical OPERATIONAL | DEGRADED | OFFLINE. */
  conditions?: Record<string, string>;
  incidents?: FirehydrantIncidentItem[];
}

/** Identifies the vendor the response is being normalized for. */
export interface FirehydrantTarget {
  name: string;
  slug: string | null;
  /** Status page base URL — /data/payload.json is appended. */
  url: string;
}

// --- Mappings ---

const SEVERITY_RANK = { none: 0, minor: 1, major: 2, critical: 3 } as const;

function severityToImpact(slug: string | undefined): StatuspageStatus['indicator'] {
  switch (slug) {
    case 'SEV1':
      return 'critical';
    case 'SEV2':
      return 'major';
    case 'SEV3':
    case 'SEV4':
      return 'minor';
    case 'MAINTENANCE': // planned work — not a degradation
      return 'none';
    default:
      // UNSET or org-custom slug — surface as degraded rather than claiming all-clear.
      return 'minor';
  }
}

/** Map a canonical condition value (OPERATIONAL | DEGRADED | OFFLINE) to a component status. */
function conditionToComponentStatus(canonical: string | undefined): StatuspageComponent['status'] {
  switch (canonical) {
    case 'OPERATIONAL':
      return 'operational';
    case 'DEGRADED':
      return 'degraded_performance';
    case 'OFFLINE':
      return 'major_outage';
    default:
      return 'degraded_performance';
  }
}

/** Extract the note text from a timeline entry — '' when it carries none. */
function noteText(entry: FirehydrantTimelineEntry): string {
  const note = entry.details?.note;
  if (typeof note === 'string') return note;
  return typeof note?.note === 'string' ? note.note : '';
}

function isMaintenance(item: FirehydrantIncidentItem): boolean {
  return item.severitySlug === 'MAINTENANCE';
}

function isActive(item: FirehydrantIncidentItem): boolean {
  return !item.timestamps?.resolved;
}

function buildPage(target: FirehydrantTarget): StatuspagePage {
  return {
    id: target.slug ?? 'firehydrant',
    name: target.name,
    time_zone: 'Etc/UTC',
    updated_at: '', // the payload carries no page-level timestamp
    url: target.url,
  };
}

/** Normalize one Firehydrant incident (or maintenance item) into a Statuspage incident. */
export function mapFirehydrantIncident(
  item: FirehydrantIncidentItem,
  target: FirehydrantTarget,
  maintenanceStatus?: 'scheduled' | 'in_progress',
): StatuspageIncident {
  // Note-less entries (milestone-only BulkImpactUpdates) carry nothing to display — drop them.
  const timeline = (item.timeline ?? [])
    .filter((e) => noteText(e) !== '')
    .sort(
      (a, b) =>
        new Date(a.occurredAt ?? a.time ?? 0).getTime() -
        new Date(b.occurredAt ?? b.time ?? 0).getTime(),
    );
  const affected = (item.components ?? [])
    .filter((c) => c.name)
    .map((c) => ({
      code: c.id ?? '',
      name: c.name ?? '',
      new_status: '',
      old_status: '',
    }));

  const resolved = !isActive(item);
  const status = maintenanceStatus ?? (resolved ? 'resolved' : 'investigating');
  const started = item.timestamps?.started ?? item.timestamps?.detected ?? '';

  return {
    id: item.id ?? item.title ?? 'unknown',
    name: item.title ?? 'Unnamed incident',
    impact: maintenanceStatus ? 'none' : severityToImpact(item.severitySlug),
    status,
    created_at: started,
    started_at: started || null,
    resolved_at: item.timestamps?.resolved ?? null,
    monitoring_at: null,
    page_id: target.slug ?? 'firehydrant',
    components: [],
    ...(maintenanceStatus && {
      scheduled_for: started,
      // The payload carries no planned end time.
      scheduled_until: '',
    }),
    incident_updates: timeline.map((entry, i) => ({
      id: `${item.id ?? 'update'}-${i}`,
      body: noteText(entry),
      status,
      created_at: entry.occurredAt ?? entry.time ?? '',
      display_at: entry.occurredAt ?? entry.time ?? '',
      // Attach the incident-level affected list to the latest update so
      // downstream affected-component extraction sees it.
      affected_components: i === timeline.length - 1 && affected.length > 0 ? affected : null,
    })),
  };
}

/** Active + upcoming maintenance items, normalized (resolved history is dropped). */
function mapMaintenances(raw: FirehydrantPayload, target: FirehydrantTarget): StatuspageIncident[] {
  const now = Date.now();
  return (raw.incidents ?? [])
    .filter((i) => isMaintenance(i) && isActive(i))
    .map((i) => {
      const started = new Date(i.timestamps?.started ?? 0).getTime();
      return mapFirehydrantIncident(i, target, started > now ? 'scheduled' : 'in_progress');
    });
}

/**
 * Non-maintenance incidents, newest first — the complete history. The tool
 * (devops_get_incidents) windows this via limit + offset, so nothing is dropped
 * here; capping upstream would make older history undisclosed and unreachable.
 */
function mapIncidents(raw: FirehydrantPayload, target: FirehydrantTarget): StatuspageIncident[] {
  return (raw.incidents ?? [])
    .filter((i) => !isMaintenance(i))
    .map((i) => mapFirehydrantIncident(i, target))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

/** Normalize a Firehydrant payload into a Statuspage summary. */
export function mapFirehydrantSummary(
  raw: FirehydrantPayload,
  target: FirehydrantTarget,
): StatuspageSummaryResponse {
  const activeItems = (raw.incidents ?? []).filter((i) => isActive(i) && !isMaintenance(i));
  const activeIncidents = activeItems.map((i) => mapFirehydrantIncident(i, target));

  let indicator: StatuspageStatus['indicator'] = 'none';
  for (const inc of activeIncidents) {
    if (SEVERITY_RANK[inc.impact] > SEVERITY_RANK[indicator]) indicator = inc.impact;
  }

  // Component status derives from active incidents: canonicalize each affected
  // component's condition name through the page's condition table (maintenance
  // items pin theirs to under_maintenance); everything else is operational.
  const statusByComponent = new Map<string, StatuspageComponent['status']>();
  for (const item of (raw.incidents ?? []).filter(isActive)) {
    for (const c of item.components ?? []) {
      const key = c.id ?? c.name;
      if (!key) continue;
      statusByComponent.set(
        key,
        isMaintenance(item)
          ? 'under_maintenance'
          : conditionToComponentStatus(raw.conditions?.[c.condition ?? ''] ?? c.condition),
      );
    }
  }
  const components: StatuspageComponent[] = (raw.components ?? []).map((c, i) => ({
    id: c.id ?? `component-${i}`,
    name: c.name ?? 'Unknown',
    status:
      statusByComponent.get(c.id ?? '') ?? statusByComponent.get(c.name ?? '') ?? 'operational',
    created_at: '',
    updated_at: '',
    description: null,
    group: false,
    group_id: null,
    only_show_if_degraded: false,
    position: i,
    showcase: true,
  }));

  return {
    page: buildPage(target),
    status: {
      indicator,
      description:
        activeIncidents.length === 0
          ? 'All Systems Operational'
          : `${activeIncidents.length} active incident${activeIncidents.length === 1 ? '' : 's'}`,
    },
    components,
    incidents: activeIncidents,
    scheduled_maintenances: mapMaintenances(raw, target),
  };
}

/** Normalize into the incidents-endpoint shape. */
export function mapFirehydrantIncidents(
  raw: FirehydrantPayload,
  target: FirehydrantTarget,
): StatuspageIncidentsResponse {
  return { page: buildPage(target), incidents: mapIncidents(raw, target) };
}

/** Normalize into the scheduled-maintenances-endpoint shape. */
export function mapFirehydrantScheduledMaintenances(
  raw: FirehydrantPayload,
  target: FirehydrantTarget,
): StatuspageScheduledMaintenancesResponse {
  return { page: buildPage(target), scheduled_maintenances: mapMaintenances(raw, target) };
}

// --- Fetchers ---

function fetchRaw(
  target: FirehydrantTarget,
): Promise<{ data: FirehydrantPayload; cached: boolean }> {
  const { cacheTtlMs, fetchTimeoutMs } = getServerConfig();
  return fetchJsonCached<FirehydrantPayload>(
    `${target.url}${FIREHYDRANT_DATA_PATH}`,
    cacheTtlMs,
    fetchTimeoutMs,
  );
}

export async function fetchFirehydrantSummary(
  target: FirehydrantTarget,
): Promise<{ data: StatuspageSummaryResponse; cached: boolean }> {
  const { data, cached } = await fetchRaw(target);
  return { data: mapFirehydrantSummary(data, target), cached };
}

export async function fetchFirehydrantIncidents(
  target: FirehydrantTarget,
): Promise<{ data: StatuspageIncidentsResponse; cached: boolean }> {
  const { data, cached } = await fetchRaw(target);
  return { data: mapFirehydrantIncidents(data, target), cached };
}

export async function fetchFirehydrantScheduledMaintenances(
  target: FirehydrantTarget,
): Promise<{ data: StatuspageScheduledMaintenancesResponse; cached: boolean }> {
  const { data, cached } = await fetchRaw(target);
  return { data: mapFirehydrantScheduledMaintenances(data, target), cached };
}
