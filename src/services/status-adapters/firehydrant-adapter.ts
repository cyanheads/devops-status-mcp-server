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
 *   Mapping: SEV1 → critical, SEV2 → major, SEV3/SEV4 → minor, unknown →
 *   minor (an active event of unknown severity is at least a degradation).
 * - MAINTENANCE items are maintenance windows and never reach the incident
 *   list. The scheduled-maintenances stream carries every one, newest start
 *   first: a resolved item is `completed`; an unresolved one is `in_progress`
 *   once its start (`timestamps.started`, else `detected`) is not after now and
 *   `scheduled` before. That one start test also decides whether a window pins
 *   its components to `under_maintenance` and sets the `maintenance` indicator,
 *   which it does only while no active incident rates — an outage outranks a
 *   window, on the indicator and on a component both name. The summary lists
 *   unresolved windows only, as a Statuspage summary does.
 * - There is no per-incident lifecycle field beyond the timestamps, so
 *   unresolved incidents map to the generic 'investigating' state.
 * - The history is unbounded (~950 incidents on status.redis.io). The full
 *   history is returned unwindowed; devops_get_incidents pages it tool-side
 *   via limit + offset, so older incidents stay reachable.
 * - The payload must be an object carrying `incidents` and `components` arrays.
 *   Any other body (an error envelope, `{}`, an array) is some other document,
 *   not this feed, and is rejected rather than read as an all-clear. Item fields
 *   inside the envelope stay unchecked, so a sparse item still maps.
 * @module services/status-adapters/firehydrant-adapter
 */

import { z } from '@cyanheads/mcp-ts-core';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
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
import { SEVERITY_RANK } from '@/services/statuspage/types.js';
import { fetchCached } from '@/utils/cached-fetch.js';
import { htmlToText } from '@/utils/html-to-text.js';

const FIREHYDRANT_DATA_PATH = '/data/payload.json';

/** The envelope every Firehydrant payload carries; the items inside are read field by field. */
const PayloadEnvelopeSchema = z.object({
  components: z.array(z.unknown()),
  incidents: z.array(z.unknown()),
});

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
  components: FirehydrantComponentItem[];
  /** Per-page condition table: display name → canonical OPERATIONAL | DEGRADED | OFFLINE. */
  conditions?: Record<string, string>;
  incidents: FirehydrantIncidentItem[];
}

/** Identifies the vendor the response is being normalized for. */
export interface FirehydrantTarget {
  name: string;
  slug: string | null;
  /** Status page base URL — /data/payload.json is appended. */
  url: string;
}

// --- Mappings ---

function severityToImpact(slug: string | undefined): StatuspageSeverityIndicator {
  switch (slug) {
    case 'SEV1':
      return 'critical';
    case 'SEV2':
      return 'major';
    case 'SEV3':
    case 'SEV4':
      return 'minor';
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

/** When an item began: `timestamps.started`, else `detected` — '' when it carries neither. */
function startedAt(item: FirehydrantIncidentItem): string {
  return item.timestamps?.started ?? item.timestamps?.detected ?? '';
}

/**
 * Whether an item starts after `now` — the one test that decides a window's list status,
 * the status of the components it touches, and whether it sets the indicator. An item
 * with no readable start counts as started.
 */
function startsAfter(item: FirehydrantIncidentItem, now: number): boolean {
  return new Date(startedAt(item)).getTime() > now;
}

type WindowStatus = 'scheduled' | 'in_progress' | 'completed';

/** A MAINTENANCE item's window status: completed once resolved, else by its start. */
function windowStatus(item: FirehydrantIncidentItem, now: number): WindowStatus {
  if (!isActive(item)) return 'completed';
  return startsAfter(item, now) ? 'scheduled' : 'in_progress';
}

function newestFirst(a: StatuspageIncident, b: StatuspageIncident): number {
  return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
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

/**
 * Normalize one Firehydrant incident into a Statuspage incident, or a MAINTENANCE item
 * into a maintenance window when `maintenanceStatus` is given.
 */
function mapFirehydrantIncident(
  item: FirehydrantIncidentItem,
  target: FirehydrantTarget,
  maintenanceStatus?: WindowStatus,
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
  const started = startedAt(item);

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
    // The payload carries no planned end time, so scheduled_until stays unset.
    ...(maintenanceStatus && { scheduled_for: started }),
    incident_updates: timeline.map((entry, i) => ({
      id: `${item.id ?? 'update'}-${i}`,
      body: htmlToText(noteText(entry)),
      status,
      created_at: entry.occurredAt ?? entry.time ?? '',
      display_at: entry.occurredAt ?? entry.time ?? '',
      // Attach the incident-level affected list to the latest update so
      // downstream affected-component extraction sees it.
      affected_components: i === timeline.length - 1 && affected.length > 0 ? affected : null,
    })),
  };
}

/**
 * The MAINTENANCE items among `items` as maintenance windows, newest start first. Given
 * the whole payload that is every window, completed ones included; the tool pages it via
 * limit + offset in this order.
 */
function mapMaintenances(
  items: readonly FirehydrantIncidentItem[],
  target: FirehydrantTarget,
  now: number,
): StatuspageIncident[] {
  return items
    .filter(isMaintenance)
    .map((i) => mapFirehydrantIncident(i, target, windowStatus(i, now)))
    .sort(newestFirst);
}

/**
 * Non-maintenance incidents, newest first — the complete history. The tool
 * (devops_get_incidents) windows this via limit + offset, so nothing is dropped
 * here; capping upstream would make older history undisclosed and unreachable.
 */
function mapIncidents(raw: FirehydrantPayload, target: FirehydrantTarget): StatuspageIncident[] {
  return raw.incidents
    .filter((i) => !isMaintenance(i))
    .map((i) => mapFirehydrantIncident(i, target))
    .sort(newestFirst);
}

/**
 * Normalize a Firehydrant payload into a Statuspage summary of current health. Active
 * incidents rate the indicator; with none, a started window sets `maintenance`. A
 * window that has not started touches neither the indicator nor any component.
 */
export function mapFirehydrantSummary(
  raw: FirehydrantPayload,
  target: FirehydrantTarget,
): StatuspageSummaryResponse {
  const now = Date.now();
  const open = raw.incidents.filter(isActive);
  const activeItems = open.filter((i) => !isMaintenance(i));
  const activeIncidents = activeItems.map((i) => mapFirehydrantIncident(i, target));
  const startedWindows = open.filter((i) => isMaintenance(i) && !startsAfter(i, now));

  let rated: StatuspageSeverityIndicator = 'none';
  for (const inc of activeIncidents) {
    if (inc.impact !== 'maintenance' && SEVERITY_RANK[inc.impact] > SEVERITY_RANK[rated])
      rated = inc.impact;
  }

  let description = 'All Systems Operational';
  if (activeIncidents.length > 0) {
    description = `${activeIncidents.length} active incident${activeIncidents.length === 1 ? '' : 's'}`;
  } else if (startedWindows.length > 0) {
    description = `${startedWindows.length} maintenance window${startedWindows.length === 1 ? '' : 's'} in progress`;
  }

  /**
   * Component status: a started window pins its components to under_maintenance, then
   * each active incident's condition (canonicalized through the page's condition table)
   * overrides it — an outage outranks a window. Everything else is operational.
   */
  const statusByComponent = new Map<string, StatuspageComponent['status']>();
  for (const item of [...startedWindows, ...activeItems]) {
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
  const components: StatuspageComponent[] = raw.components.map((c, i) => ({
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
      indicator: rated === 'none' && startedWindows.length > 0 ? 'maintenance' : rated,
      description,
    },
    components,
    incidents: activeIncidents,
    scheduled_maintenances: mapMaintenances(open, target, now),
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
  return {
    page: buildPage(target),
    scheduled_maintenances: mapMaintenances(raw.incidents, target, Date.now()),
  };
}

// --- Fetchers ---

function fetchRaw(
  target: FirehydrantTarget,
): Promise<{ data: FirehydrantPayload; cached: boolean }> {
  const { cacheTtlMs, fetchTimeoutMs } = getServerConfig();
  const url = `${target.url}${FIREHYDRANT_DATA_PATH}`;
  return fetchCached<FirehydrantPayload>(url, cacheTtlMs, fetchTimeoutMs, async (res) => {
    const body: unknown = await res.json();
    if (!PayloadEnvelopeSchema.safeParse(body).success) {
      throw serviceUnavailable(
        `${url} returned a body without the incidents and components arrays a Firehydrant status payload carries.`,
        { reason: 'statuspage_unavailable', url },
      );
    }
    return body as FirehydrantPayload;
  });
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
