/**
 * @fileoverview Datadog adapter — fetches the document every Datadog status page loads
 * at {page}/config.json (the page's own data source; the same shape on all nine Datadog
 * site pages) and normalizes it into the Atlassian Statuspage shapes the tools consume.
 *
 * Feed notes:
 * - One document carries everything: each component's current status, every incident
 *   the page has published with a per-update timeline, and the maintenance windows
 *   (`null` when there are none). It is the page's whole record, so the incident list is
 *   returned unwindowed and devops_get_incidents pages it via limit + offset.
 * - Component statuses are operational | degraded | partial_outage | major_outage |
 *   maintenance; any other value reads as degraded, never as operational. A
 *   `ComponentGroup` item nests its leaf components and carries no status of its own.
 * - Incidents carry no severity. An incident's impact is the worst component status any
 *   of its updates recorded (degraded → minor, partial_outage → major, major_outage →
 *   critical), and minor when none recorded one: an open incident is at least a
 *   degradation. The peak, not the latest, so an incident in `monitoring` keeps its rating.
 * - Update times come from `startedAt`. `createdAt` is when the update was written: the
 *   page's history was imported, so every imported update's `createdAt` falls in 2026.
 *   An update without `startedAt` (the shape maintenance updates take) uses `createdAt`,
 *   as the page itself does. An update carrying `deletedAt` was deleted and is dropped.
 * - The incident-level `description` and `componentsAffected` repeat the newest update's
 *   text and the components' current statuses, so only the per-update copies are read.
 * - Maintenance windows are scheduled | in_progress | completed | canceled; canceled ones
 *   are dropped, and the summary lists the ones not yet completed.
 * - The document must be an object with `components` and `incidents` arrays and
 *   `maintenances` an array or null. Any other body is some other document, not this
 *   feed, and is rejected rather than read as an all-clear. Item fields inside the
 *   envelope stay unchecked, so a sparse item still maps.
 * @module services/status-adapters/datadog-adapter
 */

import { z } from '@cyanheads/mcp-ts-core';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import type {
  IncidentUpdate,
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

const DATADOG_CONFIG_PATH = '/config.json';

/** The envelope every Datadog status document carries; the items inside are read field by field. */
const ConfigEnvelopeSchema = z.object({
  components: z.array(z.unknown()),
  incidents: z.array(z.unknown()),
  maintenances: z.array(z.unknown()).nullable(),
});

// --- Raw Datadog status page types ({page}/config.json) ---

/** A leaf component, as listed on the page and in an update's `componentsAffected`. */
interface DatadogComponentRef {
  id?: string;
  name?: string;
  /** operational | degraded | partial_outage | major_outage | maintenance */
  status?: string;
}

interface DatadogComponentItem extends DatadogComponentRef {
  /** Leaves of a `ComponentGroup` item. */
  components?: DatadogComponentRef[];
  /** `Component` or `ComponentGroup`. */
  type?: string;
}

interface DatadogTimelineEntry {
  /** Each named component's status as of this update. */
  componentsAffected?: DatadogComponentRef[];
  /** When the update was written — not when it happened. */
  createdAt?: string;
  /** Set on a deleted update. */
  deletedAt?: string | null;
  description?: string;
  id?: string;
  /** When the update happened. */
  startedAt?: string;
  status?: string;
}

interface DatadogIncidentItem {
  /** investigating | identified | monitoring | resolved */
  currentStatus?: string;
  id?: string;
  publishedDate?: string;
  resolved?: boolean;
  resolvedDate?: string | null;
  timeline?: DatadogTimelineEntry[];
  title?: string;
}

interface DatadogMaintenanceItem {
  /** Planned end while scheduled or in progress; the actual end once completed. */
  completedDate?: string;
  /** scheduled | in_progress | completed | canceled */
  currentStatus?: string;
  id?: string;
  publishedDate?: string;
  startDate?: string;
  timeline?: DatadogTimelineEntry[];
  title?: string;
}

export interface DatadogConfig {
  components: DatadogComponentItem[];
  incidents: DatadogIncidentItem[];
  maintenances: DatadogMaintenanceItem[] | null;
}

/** Identifies the vendor the response is being normalized for. */
export interface DatadogTarget {
  name: string;
  slug: string | null;
  /** Status page base URL — /config.json is appended. */
  url: string;
}

// --- Mappings ---

/** A Datadog component status as a Statuspage one; an unrecognized value reads as degraded. */
function componentStatus(status: string | undefined): StatuspageComponent['status'] {
  switch (status) {
    case 'operational':
      return 'operational';
    case 'degraded':
      return 'degraded_performance';
    case 'partial_outage':
      return 'partial_outage';
    case 'major_outage':
      return 'major_outage';
    case 'maintenance':
      return 'under_maintenance';
    default:
      return 'degraded_performance';
  }
}

/** The severity a component status rates; operational and under_maintenance rate none. */
const STATUS_SEVERITY: Record<StatuspageComponent['status'], StatuspageSeverityIndicator> = {
  operational: 'none',
  under_maintenance: 'none',
  degraded_performance: 'minor',
  partial_outage: 'major',
  major_outage: 'critical',
};

/** Component statuses best first, for a group's status: the worst of its leaves'. */
const STATUS_RANK: Record<StatuspageComponent['status'], number> = {
  operational: 0,
  under_maintenance: 1,
  degraded_performance: 2,
  partial_outage: 3,
  major_outage: 4,
};

function worse(
  a: StatuspageSeverityIndicator,
  b: StatuspageSeverityIndicator,
): StatuspageSeverityIndicator {
  return SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a;
}

/** Updates that were not deleted. */
function liveEntries(
  timeline: readonly DatadogTimelineEntry[] | undefined,
): DatadogTimelineEntry[] {
  return (timeline ?? []).filter((e) => typeof e.deletedAt !== 'string');
}

/** When an update happened: `startedAt`, else `createdAt` — '' when it carries neither. */
function entryTime(entry: DatadogTimelineEntry): string {
  return entry.startedAt ?? entry.createdAt ?? '';
}

/** The worst component status any update recorded, rated; minor when none recorded one. */
function incidentImpact(item: DatadogIncidentItem): StatuspageSeverityIndicator {
  let worst: StatuspageSeverityIndicator = 'none';
  for (const entry of liveEntries(item.timeline)) {
    for (const c of entry.componentsAffected ?? []) {
      worst = worse(worst, STATUS_SEVERITY[componentStatus(c.status)]);
    }
  }
  return worst === 'none' ? 'minor' : worst;
}

function newestFirst(a: string, b: string): number {
  return new Date(b).getTime() - new Date(a).getTime();
}

function buildPage(target: DatadogTarget): StatuspagePage {
  return {
    id: target.slug ?? 'datadog',
    name: target.name,
    updated_at: '', // the document carries no page-level timestamp
    url: target.url,
  };
}

/** A record's updates, newest first, each naming the components it recorded with their status. */
function mapUpdates(
  timeline: readonly DatadogTimelineEntry[] | undefined,
  parentId: string,
  parentStatus: string,
): IncidentUpdate[] {
  return liveEntries(timeline)
    .map((entry, i) => {
      const at = entryTime(entry);
      const affected = (entry.componentsAffected ?? [])
        .filter((c) => c.name)
        .map((c) => ({
          code: c.id ?? '',
          name: c.name ?? '',
          new_status: componentStatus(c.status),
          old_status: '',
        }));
      return {
        id: entry.id ?? `${parentId}-${i}`,
        body: htmlToText(entry.description ?? ''),
        status: entry.status ?? parentStatus,
        created_at: at,
        display_at: at,
        affected_components: affected.length > 0 ? affected : null,
      };
    })
    .sort((a, b) => newestFirst(a.created_at, b.created_at));
}

function mapIncident(item: DatadogIncidentItem, target: DatadogTarget): StatuspageIncident {
  const resolved = item.resolved === true;
  const status = item.currentStatus ?? (resolved ? 'resolved' : 'investigating');
  const id = item.id ?? item.title ?? 'unknown';
  const published = item.publishedDate ?? '';
  return {
    id,
    name: item.title ?? 'Unnamed incident',
    impact: incidentImpact(item),
    status,
    created_at: published,
    started_at: published || null,
    resolved_at: resolved ? item.resolvedDate || null : null,
    monitoring_at: null,
    page_id: target.slug ?? 'datadog',
    components: [],
    incident_updates: mapUpdates(item.timeline, id, status),
  };
}

/** A maintenance window, or null for a canceled one. */
function mapMaintenance(
  item: DatadogMaintenanceItem,
  target: DatadogTarget,
): StatuspageIncident | null {
  const status = item.currentStatus ?? 'scheduled';
  if (status === 'canceled') return null;
  const id = item.id ?? item.title ?? 'unknown';
  return {
    id,
    name: item.title ?? 'Unnamed maintenance',
    impact: 'none',
    status,
    created_at: item.publishedDate ?? '',
    started_at: item.startDate ?? null,
    resolved_at: status === 'completed' ? (item.completedDate ?? null) : null,
    monitoring_at: null,
    page_id: target.slug ?? 'datadog',
    components: [],
    ...(item.startDate && { scheduled_for: item.startDate }),
    ...(item.completedDate && { scheduled_until: item.completedDate }),
    incident_updates: mapUpdates(item.timeline, id, status),
  };
}

function mapComponent(
  c: DatadogComponentRef,
  fallbackId: string,
  position: number,
  groupId: string | null,
): StatuspageComponent {
  return {
    id: c.id ?? fallbackId,
    name: c.name ?? 'Unknown',
    status: componentStatus(c.status),
    created_at: '',
    updated_at: '',
    group: false,
    group_id: groupId,
    position,
  };
}

/**
 * The page's components in Statuspage form: a group, then its leaves with its id as
 * `group_id`. A group's status is the worst of its leaves', as on a Statuspage page.
 */
function mapComponents(items: readonly DatadogComponentItem[]): StatuspageComponent[] {
  const out: StatuspageComponent[] = [];
  items.forEach((item, i) => {
    if (item.type !== 'ComponentGroup') {
      out.push(mapComponent(item, `component-${i}`, out.length, null));
      return;
    }
    const groupId = item.id ?? `group-${i}`;
    const at = out.length;
    const leaves = (item.components ?? []).map((c, j) =>
      mapComponent(c, `${groupId}-${j}`, at + 1 + j, groupId),
    );
    const status = leaves.reduce<StatuspageComponent['status']>(
      (worst, c) => (STATUS_RANK[c.status] > STATUS_RANK[worst] ? c.status : worst),
      'operational',
    );
    out.push({ ...mapComponent(item, groupId, at, null), status, group: true }, ...leaves);
  });
  return out;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** Every window that was not canceled, newest start first. */
function mapMaintenances(raw: DatadogConfig, target: DatadogTarget): StatuspageIncident[] {
  return (raw.maintenances ?? [])
    .map((m) => mapMaintenance(m, target))
    .filter((m) => m !== null)
    .sort((a, b) => newestFirst(a.scheduled_for ?? a.created_at, b.scheduled_for ?? b.created_at));
}

/**
 * Normalize a Datadog status document into a Statuspage summary of current health. The
 * indicator is the worse of the worst component status and the worst open-incident
 * impact; with neither rating, an in-progress window sets `maintenance`.
 */
export function mapDatadogSummary(
  raw: DatadogConfig,
  target: DatadogTarget,
): StatuspageSummaryResponse {
  const components = mapComponents(raw.components);
  const open = raw.incidents.filter((i) => i.resolved !== true).map((i) => mapIncident(i, target));
  const windows = mapMaintenances(raw, target).filter((m) => m.status !== 'completed');
  const inProgress = windows.filter((m) => m.status === 'in_progress').length;

  const degraded = components.filter((c) => !c.group && STATUS_SEVERITY[c.status] !== 'none');
  let rated: StatuspageSeverityIndicator = 'none';
  for (const c of degraded) rated = worse(rated, STATUS_SEVERITY[c.status]);
  for (const inc of open) if (inc.impact !== 'maintenance') rated = worse(rated, inc.impact);

  let description = 'All Systems Operational';
  if (open.length > 0) description = plural(open.length, 'active incident');
  else if (degraded.length > 0) description = plural(degraded.length, 'degraded component');
  else if (inProgress > 0) description = `${plural(inProgress, 'maintenance window')} in progress`;

  return {
    page: buildPage(target),
    status: { indicator: rated === 'none' && inProgress > 0 ? 'maintenance' : rated, description },
    components,
    incidents: open,
    scheduled_maintenances: windows,
  };
}

/** Normalize into the incidents-endpoint shape: the page's whole history, newest first. */
export function mapDatadogIncidents(
  raw: DatadogConfig,
  target: DatadogTarget,
): StatuspageIncidentsResponse {
  return {
    page: buildPage(target),
    incidents: raw.incidents
      .map((i) => mapIncident(i, target))
      .sort((a, b) => newestFirst(a.created_at, b.created_at)),
  };
}

/** Normalize into the scheduled-maintenances-endpoint shape: every window not canceled. */
export function mapDatadogScheduledMaintenances(
  raw: DatadogConfig,
  target: DatadogTarget,
): StatuspageScheduledMaintenancesResponse {
  return { page: buildPage(target), scheduled_maintenances: mapMaintenances(raw, target) };
}

// --- Fetchers ---

function fetchRaw(target: DatadogTarget): Promise<{ data: DatadogConfig; cached: boolean }> {
  const { cacheTtlMs, fetchTimeoutMs } = getServerConfig();
  const url = `${target.url}${DATADOG_CONFIG_PATH}`;
  return fetchCached<DatadogConfig>(url, cacheTtlMs, fetchTimeoutMs, async (res) => {
    const body: unknown = await res.json();
    if (!ConfigEnvelopeSchema.safeParse(body).success) {
      throw serviceUnavailable(
        `${url} returned a body without the components and incidents arrays and the maintenances list a Datadog status page document carries.`,
        { reason: 'statuspage_unavailable', url },
      );
    }
    return body as DatadogConfig;
  });
}

export async function fetchDatadogSummary(
  target: DatadogTarget,
): Promise<{ data: StatuspageSummaryResponse; cached: boolean }> {
  const { data, cached } = await fetchRaw(target);
  return { data: mapDatadogSummary(data, target), cached };
}

export async function fetchDatadogIncidents(
  target: DatadogTarget,
): Promise<{ data: StatuspageIncidentsResponse; cached: boolean }> {
  const { data, cached } = await fetchRaw(target);
  return { data: mapDatadogIncidents(data, target), cached };
}

export async function fetchDatadogScheduledMaintenances(
  target: DatadogTarget,
): Promise<{ data: StatuspageScheduledMaintenancesResponse; cached: boolean }> {
  const { data, cached } = await fetchRaw(target);
  return { data: mapDatadogScheduledMaintenances(data, target), cached };
}
