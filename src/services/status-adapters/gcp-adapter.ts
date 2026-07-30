/**
 * @fileoverview Google Cloud adapter — fetches the public Google Cloud status
 * feed (https://status.cloud.google.com/incidents.json) and normalizes it into
 * the Atlassian Statuspage shapes the tools consume.
 *
 * Feed notes:
 * - The body is a bare top-level JSON array of incidents — there is no `page`
 *   or `status` envelope, so page-level fields are synthesized from the target.
 *   A body that is not an array is some other document, not this feed, and is
 *   rejected rather than mapped to an empty incident list.
 * - The feed's own published schema (incidents.schema.json) documents `severity`
 *   as "(high, medium)", but `low` is emitted live, so the vocabulary is not
 *   closed. Mapping: low → minor, medium → major, high → critical, plus a named
 *   `critical` passthrough so an escalation past `high` is not silently
 *   downgraded. Anything unrecognized degrades to `minor` — a published
 *   incident is at least a degradation — rather than being dropped.
 * - Resolution comes from `end`, never from an update's `status`. Each update
 *   carries the service status when it was posted (AVAILABLE /
 *   SERVICE_DISRUPTION / SERVICE_INFORMATION), not a lifecycle word, and an
 *   incident can post an AVAILABLE update while still open. Updates arrive
 *   newest-first and are re-sorted oldest-first here.
 * - `status_impact: SERVICE_INFORMATION` stays in the incident stream. It marks
 *   a low-impact incident, not planned work: the live example is a
 *   root-caused report of elevated Vertex Gemini API error rates. Routing it to
 *   scheduled_maintenances would relabel a past disruption as a planned window.
 *   Google Cloud publishes no maintenance feed at all, so scheduled
 *   maintenances are always empty.
 * - `affected_products[]` is the component concept. Product display names use
 *   `current_title` (the product's name today) over `title` (its name at
 *   incident time), which can be stale — the live feed carries a record whose
 *   `title` is "Vertex Gemini API" and whose `current_title` is "Gemini on
 *   Agent Platform". The location lists have no normalized counterpart and are
 *   not mapped.
 * - `number`, `service_key`, and `service_name` are marked deprecated upstream
 *   in favour of `id` and `affected_products`; only `id` is relied on.
 * @module services/status-adapters/gcp-adapter
 */

import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import type {
  AffectedComponent,
  StatuspageComponent,
  StatuspageIncident,
  StatuspageIncidentsResponse,
  StatuspagePage,
  StatuspageScheduledMaintenancesResponse,
  StatuspageStatus,
  StatuspageSummaryResponse,
} from '@/services/statuspage/types.js';
import { fetchCached } from '@/utils/cached-fetch.js';

const GCP_INCIDENTS_URL = 'https://status.cloud.google.com/incidents.json';

// --- Raw Google Cloud feed types ---

interface GcpLocation {
  /** Stable region ID (e.g. "us-central1", "global"). */
  id?: string;
  title?: string;
}

interface GcpProduct {
  /** Product's current marketing display name. */
  current_title?: string;
  /** Stable product ID. */
  id?: string;
  /** Product name at incident time — upstream marks it unstable. */
  title?: string;
}

interface GcpUpdate {
  affected_locations?: GcpLocation[];
  created?: string;
  modified?: string;
  /** Service status when the update was posted: AVAILABLE | SERVICE_DISRUPTION | SERVICE_INFORMATION. */
  status?: string;
  text?: string;
  when?: string;
}

export interface GcpIncident {
  affected_products?: GcpProduct[];
  /** RFC3339 time the incident started. */
  begin?: string;
  created?: string;
  currently_affected_locations?: GcpLocation[];
  /** RFC3339 time the incident ended — absent or empty while it is open. */
  end?: string;
  /** Incident summary — the dashboard's headline for it. */
  external_desc?: string;
  id?: string;
  modified?: string;
  most_recent_update?: GcpUpdate;
  previously_affected_locations?: GcpLocation[];
  /** Documented as "(high, medium)"; `low` is also emitted live. */
  severity?: string;
  /** SERVICE_DISRUPTION | SERVICE_INFORMATION. */
  status_impact?: string;
  updates?: GcpUpdate[];
  /** Dashboard-relative permalink (e.g. "incidents/3BvH3LVGcupoYqV6F4Nw"). */
  uri?: string;
}

/** Identifies the vendor the response is being normalized for. */
export interface GcpTarget {
  name: string;
  slug: string | null;
  /** Public dashboard URL (display and permalink base — the feed endpoint is fixed). */
  url: string;
}

// --- Mappings ---

const SEVERITY_RANK = { none: 0, minor: 1, major: 2, critical: 3 } as const;

/** Google Cloud severity → normalized indicator; see module fileoverview. */
function severityToImpact(severity: string | undefined): StatuspageStatus['indicator'] {
  switch (severity) {
    case 'low':
      return 'minor';
    case 'medium':
      return 'major';
    case 'high':
    case 'critical':
      return 'critical';
    default:
      return 'minor';
  }
}

/**
 * Service status carried by an update, as a readable label. These are not
 * lifecycle states — an update says what the service was doing when it was
 * posted, so they are surfaced as-is rather than mapped onto
 * investigating/identified/monitoring, which would invent a lifecycle the feed
 * does not publish.
 */
function updateStatusLabel(status: string | undefined): string {
  switch (status) {
    case 'AVAILABLE':
      return 'available';
    case 'SERVICE_DISRUPTION':
      return 'disruption';
    case 'SERVICE_INFORMATION':
      return 'information';
    default:
      return 'update';
  }
}

/** An incident is resolved once `end` carries a timestamp. */
function isResolved(incident: GcpIncident): boolean {
  return (incident.end ?? '').trim() !== '';
}

/** Current display name for an affected product — '' when the entry carries none. */
function productName(product: GcpProduct): string {
  return product.current_title ?? product.title ?? '';
}

function updateTime(update: GcpUpdate): string {
  return update.when ?? update.created ?? '';
}

function buildPage(target: GcpTarget): StatuspagePage {
  return {
    id: target.slug ?? 'gcp',
    name: target.name,
    time_zone: 'Etc/UTC',
    updated_at: '', // the feed carries no page-level timestamp
    url: target.url,
  };
}

/** Absolute dashboard permalink for an incident, or null when the feed omits `uri`. */
function permalink(incident: GcpIncident, target: GcpTarget): string | null {
  if (!incident.uri) return null;
  return URL.parse(incident.uri, `${target.url}/`)?.href ?? null;
}

/** Normalize one Google Cloud incident into a Statuspage incident. */
export function mapGcpIncident(incident: GcpIncident, target: GcpTarget): StatuspageIncident {
  // The feed lists updates newest-first; consumers render them oldest-first.
  const updates = [...(incident.updates ?? [])].sort(
    (a, b) => new Date(updateTime(a)).getTime() - new Date(updateTime(b)).getTime(),
  );
  const affected: AffectedComponent[] = (incident.affected_products ?? [])
    .map((p) => ({ code: p.id ?? '', name: productName(p), new_status: '', old_status: '' }))
    .filter((c) => c.name !== '');

  const resolved = isResolved(incident);
  const status = resolved ? 'resolved' : 'investigating';
  const started = incident.begin ?? incident.created ?? '';

  return {
    id: incident.id ?? 'unknown',
    name: incident.external_desc ?? 'Unnamed incident',
    impact: severityToImpact(incident.severity),
    status,
    created_at: incident.created ?? started,
    started_at: started || null,
    resolved_at: resolved ? (incident.end ?? null) : null,
    monitoring_at: null,
    page_id: target.slug ?? 'gcp',
    shortlink: permalink(incident, target),
    components: [],
    incident_updates: updates.map((update, i) => ({
      id: `${incident.id ?? 'update'}-${i}`,
      body: update.text ?? '',
      status: updateStatusLabel(update.status),
      created_at: updateTime(update),
      display_at: updateTime(update),
      // Attach the incident-level product list to the latest update so
      // downstream affected-component extraction sees it.
      affected_components: i === updates.length - 1 && affected.length > 0 ? affected : null,
    })),
  };
}

/** Component status for a product carried by an active incident of this impact. */
function impactToComponentStatus(
  impact: StatuspageStatus['indicator'],
): StatuspageComponent['status'] {
  switch (impact) {
    case 'critical':
      return 'major_outage';
    case 'major':
      return 'partial_outage';
    default:
      return 'degraded_performance';
  }
}

/**
 * Normalize the feed into a Statuspage summary. The feed has no product catalog
 * and no per-product health, so current health derives from the incidents that
 * have no `end`: their affected products are the components, everything else is
 * simply absent rather than asserted operational.
 */
export function mapGcpSummary(
  incidents: GcpIncident[],
  target: GcpTarget,
): StatuspageSummaryResponse {
  const active = (incidents ?? []).filter((i) => !isResolved(i));
  const activeIncidents = active.map((i) => mapGcpIncident(i, target));

  // One component per product touched by an active incident, at the worst
  // impact affecting it — a product named by two incidents appears once.
  let indicator: StatuspageStatus['indicator'] = 'none';
  const worstByProduct = new Map<string, { name: string; impact: StatuspageStatus['indicator'] }>();
  for (const incident of active) {
    const impact = severityToImpact(incident.severity);
    if (SEVERITY_RANK[impact] > SEVERITY_RANK[indicator]) indicator = impact;
    for (const product of incident.affected_products ?? []) {
      const name = productName(product);
      if (!name) continue;
      const key = product.id ?? name;
      const current = worstByProduct.get(key);
      if (!current || SEVERITY_RANK[impact] > SEVERITY_RANK[current.impact])
        worstByProduct.set(key, { name, impact });
    }
  }
  const components: StatuspageComponent[] = [...worstByProduct].map(([id, entry], i) => ({
    id,
    name: entry.name,
    status: impactToComponentStatus(entry.impact),
    created_at: '',
    updated_at: '',
    description: null,
    group: false,
    group_id: null,
    only_show_if_degraded: true,
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
    scheduled_maintenances: [],
  };
}

/** Normalize into the incidents-endpoint shape, newest first. */
export function mapGcpIncidents(
  incidents: GcpIncident[],
  target: GcpTarget,
): StatuspageIncidentsResponse {
  return {
    page: buildPage(target),
    incidents: (incidents ?? [])
      .map((i) => mapGcpIncident(i, target))
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
  };
}

// --- Fetchers ---

function fetchRaw(): Promise<{ data: GcpIncident[]; cached: boolean }> {
  const { cacheTtlMs, fetchTimeoutMs } = getServerConfig();
  return fetchCached<GcpIncident[]>(GCP_INCIDENTS_URL, cacheTtlMs, fetchTimeoutMs, async (res) => {
    const body: unknown = await res.json();
    if (!Array.isArray(body)) {
      throw serviceUnavailable(
        `${GCP_INCIDENTS_URL} returned a ${typeof body} rather than the incident array the feed publishes.`,
        { reason: 'statuspage_unavailable', url: GCP_INCIDENTS_URL },
      );
    }
    return body as GcpIncident[];
  });
}

export async function fetchGcpSummary(
  target: GcpTarget,
): Promise<{ data: StatuspageSummaryResponse; cached: boolean }> {
  const { data, cached } = await fetchRaw();
  return { data: mapGcpSummary(data, target), cached };
}

export async function fetchGcpIncidents(
  target: GcpTarget,
): Promise<{ data: StatuspageIncidentsResponse; cached: boolean }> {
  const { data, cached } = await fetchRaw();
  return { data: mapGcpIncidents(data, target), cached };
}

/** Google Cloud publishes no maintenance feed — always empty, no network call. */
export function fetchGcpScheduledMaintenances(
  target: GcpTarget,
): Promise<{ data: StatuspageScheduledMaintenancesResponse; cached: boolean }> {
  return Promise.resolve({
    data: { page: buildPage(target), scheduled_maintenances: [] },
    cached: false,
  });
}
