/**
 * @fileoverview incident.io adapter — reads the feed every incident.io-hosted status page
 * loads for itself, {page}/proxy/{host} (the summary) and {page}/proxy/{host}/incidents
 * (the incident list), and normalizes it into the Atlassian Statuspage shapes the tools
 * consume. `host` is the page URL's own host: the route serves whichever page the path
 * names.
 *
 * Feed notes:
 * - The summary's `structure` is the component table: leaves inside their groups, plus
 *   ungrouped leaves. Its flat `components` list carries no groups and is empty on a
 *   parent page, so it is not read. A leaf's current status comes from
 *   `affected_components` and is operational when the leaf is not listed there. Statuses
 *   are operational | degraded_performance | partial_outage | full_outage |
 *   under_maintenance; full_outage reads as major_outage and any other value as
 *   degraded_performance, never operational.
 * - A parent page (`page_type: parent`) aggregates regional subpages: its `structure` and
 *   incident list cover theirs, and `subpages[].worst_component_status` rates the
 *   indicator alongside its own components and incidents.
 * - Records carry `type: incident | maintenance`. Incidents move through investigating |
 *   identified | monitoring | resolved; maintenance through maintenance_scheduled |
 *   maintenance_in_progress | maintenance_complete, read as scheduled | in_progress |
 *   completed. A maintenance record is rated `maintenance`, as Statuspage rates one in its
 *   incident history, so it stays distinct wherever records are listed together.
 * - An incident's impact is the worst `worst_component_status` across its
 *   `status_summaries` (degraded_performance → minor, partial_outage → major, full_outage →
 *   critical, else none) — the impact incident.io's Statuspage-compatible API publishes for
 *   the same record. The earliest `status_summaries` start is when it started, and a
 *   maintenance record's earliest start and latest end are its window. `published_at` is
 *   when it was posted, and keeps a backdated or imported record's own time. It resolved
 *   at its newest `resolved` update, so a reopened incident resolves at its last.
 * - The incident list with no parameters covers the last 90 days by impact overlap
 *   (the edge sat between 89.6 and 94.4 days back on 2026-11-16), maintenance scheduled
 *   ahead included. With `start_at` and `end_at`, sent together and at most three months
 *   apart, it lists the records overlapping that window, back to the page's
 *   `data_available_since`; readIncidentioHistory reads it one calendar quarter at a time.
 * - The summary must carry `summary.structure.items`, `summary.affected_components`,
 *   `summary.ongoing_incidents`, and `summary.scheduled_maintenances` arrays, and the
 *   incident list an `incidents` array. The route answers an unknown host with HTTP 200
 *   `{}` (`{"incidents":[]}` on the list), so any other body is rejected rather than read
 *   as an all-clear, and the incident list is requested only after a valid summary for the
 *   same host. Item fields inside the envelope stay unchecked, so a sparse item still maps.
 * - No incident.io page carried an ongoing incident or an affected component on
 *   2026-11-16, so the degraded-state mapping follows the page bundle's model and the
 *   records' own statuses.
 * @module services/status-adapters/incidentio-adapter
 */

import { z } from '@cyanheads/mcp-ts-core';
import { McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import {
  HISTORY_DEADLINE_MS,
  type HistoryWalk,
  utcQuarter,
} from '@/services/statuspage/incident-history.js';
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
import { newestFirst } from '@/utils/newest-first.js';

/** How far the incident list reaches back when it is read with no window. */
export const INCIDENTIO_DEFAULT_WINDOW_DAYS = 90;

/** The summary envelope; the items inside are read field by field. */
const SummaryEnvelopeSchema = z.object({
  summary: z.object({
    structure: z.object({ items: z.array(z.unknown()) }),
    affected_components: z.array(z.unknown()),
    ongoing_incidents: z.array(z.unknown()),
    scheduled_maintenances: z.array(z.unknown()),
  }),
  subpages: z.array(z.unknown()).nullish(),
});

/** The incident-list envelope; the records inside are read field by field. */
const IncidentListEnvelopeSchema = z.object({ incidents: z.array(z.unknown()) });

// --- Raw incident.io status page types ({page}/proxy/{host}) ---

interface IncidentioStructureComponent {
  component_id?: string;
  description?: string;
  name?: string;
}

interface IncidentioStructureItem {
  /** An ungrouped leaf. */
  component?: IncidentioStructureComponent;
  group?: {
    components?: IncidentioStructureComponent[];
    description?: string;
    id?: string;
    name?: string;
  };
}

interface IncidentioComponentStatus {
  component_id?: string;
  /** operational | degraded_performance | partial_outage | full_outage | under_maintenance */
  status?: string;
}

interface IncidentioUpdate {
  /** Each named component's status as of this update. */
  component_statuses?: IncidentioComponentStatus[];
  id?: string;
  message?: { markdown?: string };
  message_string?: string;
  published_at?: string;
  to_status?: string;
}

interface IncidentioStatusSummary {
  end_at?: string;
  start_at?: string;
  worst_component_status?: string;
}

export interface IncidentioRecord {
  /** The components the record touched, each at the status it recorded for it. */
  affected_components?: IncidentioComponentStatus[];
  id?: string;
  name?: string;
  published_at?: string;
  status?: string;
  /** Consecutive spans of the record's impact, each rated by its worst component status. */
  status_summaries?: IncidentioStatusSummary[];
  /** incident | maintenance */
  type?: string;
  updates?: IncidentioUpdate[];
}

interface IncidentioSubpage {
  name?: string;
  subpath?: string;
  worst_component_status?: string;
}

export interface IncidentioSummaryDocument {
  /** Present on a parent page. */
  subpages?: IncidentioSubpage[] | null;
  summary: {
    affected_components: IncidentioComponentStatus[];
    data_available_since?: string;
    name?: string;
    ongoing_incidents: IncidentioRecord[];
    scheduled_maintenances: IncidentioRecord[];
    structure: { items: IncidentioStructureItem[] };
  };
}

export interface IncidentioIncidentList {
  incidents: IncidentioRecord[];
}

/** Identifies the vendor the response is being normalized for. */
export interface IncidentioTarget {
  name: string;
  slug: string | null;
  /** Status page base URL — /proxy/{host} is appended. */
  url: string;
}

/**
 * What one `since` read of the windowed incident list returned, in the shape the
 * Statuspage history archive walk reports, with full records in place of archive rows.
 */
export type IncidentioHistoryWalk = Omit<HistoryWalk, 'records'> & {
  /** Every record the windows listed, incidents and maintenance alike, once each, newest first. */
  records: StatuspageIncident[];
};

// --- Mappings ---

type ComponentStatus = StatuspageComponent['status'];

/** An incident.io component status as a Statuspage one; an unrecognized value reads as degraded. */
function componentStatus(status: string | undefined): ComponentStatus {
  switch (status) {
    case 'operational':
    case 'degraded_performance':
    case 'partial_outage':
    case 'under_maintenance':
      return status;
    case 'full_outage':
      return 'major_outage';
    default:
      return 'degraded_performance';
  }
}

/** The severity a component status rates; operational and under_maintenance rate none. */
const STATUS_SEVERITY: Record<ComponentStatus, StatuspageSeverityIndicator> = {
  operational: 'none',
  under_maintenance: 'none',
  degraded_performance: 'minor',
  partial_outage: 'major',
  major_outage: 'critical',
};

/** Component statuses best first, for a group's status: the worst of its leaves'. */
const STATUS_RANK: Record<ComponentStatus, number> = {
  operational: 0,
  under_maintenance: 1,
  degraded_performance: 2,
  partial_outage: 3,
  major_outage: 4,
};

/** Maintenance lifecycle statuses as the Statuspage ones; incident statuses pass through. */
const MAINTENANCE_STATUS = new Map([
  ['maintenance_scheduled', 'scheduled'],
  ['maintenance_in_progress', 'in_progress'],
  ['maintenance_complete', 'completed'],
]);

function recordStatus(status: string): string {
  return MAINTENANCE_STATUS.get(status) ?? status;
}

function worse(
  a: StatuspageSeverityIndicator,
  b: StatuspageSeverityIndicator,
): StatuspageSeverityIndicator {
  return SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function isMaintenance(record: IncidentioRecord): boolean {
  return record.type === 'maintenance';
}

/** The records, the first copy of each id kept; a record without an id is always kept. */
function uniqueById(records: readonly IncidentioRecord[]): IncidentioRecord[] {
  const seen = new Set<string>();
  return records.filter((r) => {
    if (r.id === undefined) return true;
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
}

/** The page's components and the lookups its records are named through. */
interface PageContext {
  /** Every group and leaf from `structure`, in page order, current statuses applied. */
  components: StatuspageComponent[];
  /** Leaves by component id. */
  leaves: Map<string, StatuspageComponent>;
  page: StatuspagePage;
  target: IncidentioTarget;
}

/**
 * The page's components in Statuspage form: each group followed by its leaves, which name
 * it as `group_id`, and ungrouped leaves in place. A group's status is the worst of its
 * leaves'. Items that are neither a group nor a component are skipped.
 */
function mapComponents(
  items: readonly IncidentioStructureItem[],
  statuses: ReadonlyMap<string, ComponentStatus>,
): StatuspageComponent[] {
  const rows: Omit<StatuspageComponent, 'position'>[] = [];
  const leaf = (c: IncidentioStructureComponent, fallbackId: string, groupId: string | null) => {
    const id = c.component_id ?? fallbackId;
    return {
      id,
      name: c.name ?? 'Unknown',
      status: statuses.get(id) ?? 'operational',
      created_at: '',
      updated_at: '',
      group: false,
      group_id: groupId,
      ...(c.description && { description: c.description }),
    };
  };
  items.forEach((item, i) => {
    if (item.component) {
      rows.push(leaf(item.component, `component-${i}`, null));
      return;
    }
    if (!item.group) return;
    const g = item.group;
    const groupId = g.id ?? `group-${i}`;
    const leaves = (g.components ?? []).map((c, j) => leaf(c, `${groupId}-${j}`, groupId));
    const status = leaves.reduce<ComponentStatus>(
      (worst, c) => (STATUS_RANK[c.status] > STATUS_RANK[worst] ? c.status : worst),
      'operational',
    );
    rows.push(
      {
        id: groupId,
        name: g.name ?? 'Unknown',
        status,
        created_at: '',
        updated_at: '',
        group: true,
        group_id: null,
        ...(g.description && { description: g.description }),
      },
      ...leaves,
    );
  });
  return rows.map((row, position) => ({ ...row, position }));
}

function readPage(doc: IncidentioSummaryDocument, target: IncidentioTarget): PageContext {
  const statuses = new Map<string, ComponentStatus>();
  for (const a of doc.summary.affected_components) {
    if (a.component_id !== undefined) statuses.set(a.component_id, componentStatus(a.status));
  }
  const components = mapComponents(doc.summary.structure.items, statuses);
  return {
    components,
    leaves: new Map(components.filter((c) => !c.group).map((c) => [c.id, c])),
    page: {
      id: target.slug ?? 'incidentio',
      name: doc.summary.name ?? target.name,
      updated_at: '', // the summary carries no page-level timestamp
      url: target.url,
    },
    target,
  };
}

/** Earliest start and latest end across the spans; no end while any span is still open. */
function spanOf(summaries: readonly IncidentioStatusSummary[]): { start?: string; end?: string } {
  let start: string | undefined;
  let end: string | undefined;
  let open = false;
  for (const s of summaries) {
    if (
      s.start_at !== undefined &&
      (start === undefined || Date.parse(s.start_at) < Date.parse(start))
    ) {
      start = s.start_at;
    }
    if (s.end_at === undefined) open = true;
    else if (end === undefined || Date.parse(s.end_at) > Date.parse(end)) end = s.end_at;
  }
  return { ...(start && { start }), ...(!open && end && { end }) };
}

function impactOf(record: IncidentioRecord): StatuspageIncident['impact'] {
  if (isMaintenance(record)) return 'maintenance';
  let worst: StatuspageSeverityIndicator = 'none';
  for (const s of record.status_summaries ?? []) {
    if (s.worst_component_status !== undefined) {
      worst = worse(worst, STATUS_SEVERITY[componentStatus(s.worst_component_status)]);
    }
  }
  return worst;
}

/** The page's leaves among `refs`, each at the status the ref records. */
function namedComponents(
  refs: readonly IncidentioComponentStatus[] | undefined,
  page: PageContext,
): StatuspageComponent[] {
  return (refs ?? []).flatMap((ref) => {
    const leaf = ref.component_id === undefined ? undefined : page.leaves.get(ref.component_id);
    return leaf ? [{ ...leaf, status: componentStatus(ref.status) }] : [];
  });
}

/** A record's updates, newest first, each naming the components it recorded with their status. */
function mapUpdates(
  updates: readonly IncidentioUpdate[],
  parentId: string,
  parentStatus: string,
  page: PageContext,
): IncidentUpdate[] {
  return updates
    .map((u, i) => {
      const at = u.published_at ?? '';
      const affected = namedComponents(u.component_statuses, page).map((c) => ({
        code: c.id,
        name: c.name,
        new_status: c.status,
        old_status: '',
      }));
      return {
        id: u.id ?? `${parentId}-${i}`,
        body: htmlToText(u.message?.markdown ?? u.message_string ?? ''),
        status: u.to_status === undefined ? parentStatus : recordStatus(u.to_status),
        created_at: at,
        display_at: at,
        affected_components: affected.length > 0 ? affected : null,
      };
    })
    .sort((a, b) => newestFirst(a.created_at, b.created_at));
}

/** The record's own status, else its newest update's — the two agree on every live record. */
function rawStatus(record: IncidentioRecord): string {
  const newest = record.updates?.toSorted((a, b) =>
    newestFirst(a.published_at ?? '', b.published_at ?? ''),
  )[0];
  return (
    record.status ??
    newest?.to_status ??
    (isMaintenance(record) ? 'maintenance_scheduled' : 'investigating')
  );
}

function mapRecord(record: IncidentioRecord, page: PageContext): StatuspageIncident {
  const maintenance = isMaintenance(record);
  const id = record.id ?? record.name ?? 'unknown';
  const status = recordStatus(rawStatus(record));
  const updates = mapUpdates(record.updates ?? [], id, status, page);
  const span = spanOf(record.status_summaries ?? []);
  const final =
    status === 'resolved' || status === 'completed'
      ? updates.find((u) => u.status === status)
      : undefined;
  return {
    id,
    name: record.name ?? (maintenance ? 'Unnamed maintenance' : 'Unnamed incident'),
    impact: impactOf(record),
    status,
    created_at: record.published_at ?? '',
    started_at: span.start ?? null,
    resolved_at: final?.created_at || null,
    monitoring_at: null,
    page_id: page.page.id,
    components: namedComponents(record.affected_components, page),
    ...(record.id && { shortlink: `${page.target.url}/incidents/${record.id}` }),
    ...(maintenance && span.start && { scheduled_for: span.start }),
    ...(maintenance && span.end && { scheduled_until: span.end }),
    incident_updates: updates,
  };
}

function newestStartFirst(a: StatuspageIncident, b: StatuspageIncident): number {
  return newestFirst(a.scheduled_for ?? a.created_at, b.scheduled_for ?? b.created_at);
}

/**
 * Normalize a summary into a Statuspage summary of current health. The indicator is the
 * worst of the affected components' statuses, the open incidents' impacts, and a parent
 * page's subpage statuses; with none rating, a maintenance in progress — a window, a
 * component, or a subpage under maintenance — sets `maintenance`.
 */
function mapSummary(
  doc: IncidentioSummaryDocument,
  target: IncidentioTarget,
): StatuspageSummaryResponse {
  const page = readPage(doc, target);
  const records = uniqueById([
    ...doc.summary.ongoing_incidents,
    ...doc.summary.scheduled_maintenances,
  ]).map((r) => mapRecord(r, page));
  const incidents = records.filter((r) => r.impact !== 'maintenance');
  const windows = records
    .filter((r) => r.impact === 'maintenance' && r.status !== 'completed')
    .sort(newestStartFirst);
  const inProgress = windows.filter((w) => w.status === 'in_progress').length;

  let rated: StatuspageSeverityIndicator = 'none';
  let underMaintenance = false;
  let degraded = 0;
  for (const a of doc.summary.affected_components) {
    const status = componentStatus(a.status);
    if (status === 'under_maintenance') underMaintenance = true;
    if (STATUS_SEVERITY[status] === 'none') continue;
    degraded++;
    rated = worse(rated, STATUS_SEVERITY[status]);
  }
  const degradedSubpages: string[] = [];
  for (const sub of doc.subpages ?? []) {
    if (sub.worst_component_status === undefined) continue;
    const status = componentStatus(sub.worst_component_status);
    if (status === 'under_maintenance') underMaintenance = true;
    if (STATUS_SEVERITY[status] === 'none') continue;
    degradedSubpages.push(sub.name ?? sub.subpath ?? 'unnamed subpage');
    rated = worse(rated, STATUS_SEVERITY[status]);
  }
  const open = incidents.filter((i) => i.status !== 'resolved');
  for (const inc of open) if (inc.impact !== 'maintenance') rated = worse(rated, inc.impact);

  const description = (() => {
    if (open.length > 0) return plural(open.length, 'active incident');
    if (degraded > 0) return plural(degraded, 'degraded component');
    if (degradedSubpages.length > 0) {
      return `${plural(degradedSubpages.length, 'degraded subpage')}: ${degradedSubpages.join(', ')}`;
    }
    if (inProgress > 0) return `${plural(inProgress, 'maintenance window')} in progress`;
    return underMaintenance ? 'Service Under Maintenance' : 'All Systems Operational';
  })();

  return {
    page: page.page,
    status: {
      indicator: rated === 'none' && (inProgress > 0 || underMaintenance) ? 'maintenance' : rated,
      description,
    },
    components: page.components,
    incidents,
    scheduled_maintenances: windows,
  };
}

// --- Fetchers ---

function summaryUrl(target: IncidentioTarget): string {
  return `${target.url}/proxy/${new URL(target.url).host}`;
}

/** The summary document. Every reader of the summary URL parses it here, the same way. */
function fetchSummaryDocument(
  target: IncidentioTarget,
  timeoutMs: number,
): Promise<{ data: IncidentioSummaryDocument; cached: boolean }> {
  const url = summaryUrl(target);
  return fetchCached<IncidentioSummaryDocument>(
    url,
    getServerConfig().cacheTtlMs,
    timeoutMs,
    async (res) => {
      const body: unknown = await res.json();
      if (!SummaryEnvelopeSchema.safeParse(body).success) {
        throw serviceUnavailable(
          `${url} returned a body without the structure, affected_components, ongoing_incidents, and scheduled_maintenances an incident.io status page summary carries.`,
          { reason: 'statuspage_unavailable', url },
        );
      }
      return body as IncidentioSummaryDocument;
    },
  );
}

/** The incident list, unwindowed or for `window`. Every reader of a list URL parses it here. */
function fetchIncidentList(
  target: IncidentioTarget,
  timeoutMs: number,
  window?: { start: number; end: number },
): Promise<{ data: IncidentioIncidentList; cached: boolean }> {
  const query = window
    ? `?start_at=${new Date(window.start).toISOString()}&end_at=${new Date(window.end).toISOString()}`
    : '';
  const url = `${summaryUrl(target)}/incidents${query}`;
  return fetchCached<IncidentioIncidentList>(
    url,
    getServerConfig().cacheTtlMs,
    timeoutMs,
    async (res) => {
      const body: unknown = await res.json();
      if (!IncidentListEnvelopeSchema.safeParse(body).success) {
        throw serviceUnavailable(
          `${url} returned a body without the incidents array an incident.io status page's incident list carries.`,
          { reason: 'statuspage_unavailable', url },
        );
      }
      return body as IncidentioIncidentList;
    },
  );
}

/** The summary, then the default incident list — only once the summary vouches for the host. */
async function fetchPage(target: IncidentioTarget): Promise<{
  doc: IncidentioSummaryDocument;
  list: IncidentioIncidentList;
  cached: boolean;
}> {
  const { fetchTimeoutMs } = getServerConfig();
  const summary = await fetchSummaryDocument(target, fetchTimeoutMs);
  const list = await fetchIncidentList(target, fetchTimeoutMs);
  return { doc: summary.data, list: list.data, cached: summary.cached && list.cached };
}

/** Current health: components, open incidents, and the maintenance windows not completed. */
export async function fetchIncidentioSummary(
  target: IncidentioTarget,
): Promise<{ data: StatuspageSummaryResponse; cached: boolean }> {
  const { data, cached } = await fetchSummaryDocument(target, getServerConfig().fetchTimeoutMs);
  return { data: mapSummary(data, target), cached };
}

/** The incidents of the default 90-day window, newest first; maintenance records are left out. */
export async function fetchIncidentioIncidents(
  target: IncidentioTarget,
): Promise<{ data: StatuspageIncidentsResponse; cached: boolean }> {
  const { doc, list, cached } = await fetchPage(target);
  const page = readPage(doc, target);
  const incidents = list.incidents
    .filter((r) => !isMaintenance(r))
    .map((r) => mapRecord(r, page))
    .sort((a, b) => newestFirst(a.created_at, b.created_at));
  return { data: { page: page.page, incidents }, cached };
}

/**
 * Every maintenance window the summary and the default 90-day window list — completed
 * ones included — newest start first, the summary's copy kept where both list one.
 */
export async function fetchIncidentioScheduledMaintenances(
  target: IncidentioTarget,
): Promise<{ data: StatuspageScheduledMaintenancesResponse; cached: boolean }> {
  const { doc, list, cached } = await fetchPage(target);
  const page = readPage(doc, target);
  const windows = uniqueById([
    ...doc.summary.scheduled_maintenances,
    ...doc.summary.ongoing_incidents,
    ...list.incidents,
  ])
    .filter(isMaintenance)
    .map((r) => mapRecord(r, page))
    .sort(newestStartFirst);
  return { data: { page: page.page, scheduled_maintenances: windows }, cached };
}

/** The page's `data_available_since` — how far back it publishes records — or null when absent. */
export async function fetchIncidentioDataAvailableSince(
  target: IncidentioTarget,
): Promise<string | null> {
  const { data } = await fetchSummaryDocument(target, getServerConfig().fetchTimeoutMs);
  return data.summary.data_available_since ?? null;
}

function quarterStart(quarter: number): number {
  return Date.UTC(Math.floor(quarter / 4), (quarter % 4) * 3, 1);
}

/**
 * Read the windowed incident list one calendar quarter per request, from the current
 * quarter back to the one holding `floorMs`, after the summary that names the records'
 * components. Nine requests reach 24 months back. Every request shares one 30-second
 * limit: each runs under what is left of it, capped at the configured fetch timeout, and
 * none is sent once it has passed.
 *
 * Every way the read can stop short — the summary or a window failing, or the limit
 * passing — comes back as a `gap` naming it, with the records of the quarters read so far
 * and `readBackTo` the start of the oldest of them. The read supplements the default
 * window and never fails the call. Records are full records, maintenance included; a
 * record listed in two windows is returned once.
 */
export async function readIncidentioHistory(
  target: IncidentioTarget,
  floorMs: number,
): Promise<IncidentioHistoryWalk> {
  const { fetchTimeoutMs } = getServerConfig();
  const deadline = Date.now() + HISTORY_DEADLINE_MS;
  const timeLeft = () => Math.min(fetchTimeoutMs, deadline - Date.now());

  let page: PageContext;
  try {
    page = readPage((await fetchSummaryDocument(target, timeLeft())).data, target);
  } catch (err) {
    if (!(err instanceof McpError)) throw err;
    return {
      records: [],
      reachedFloor: false,
      readBackTo: null,
      gap: `the page summary failed: ${err.message}`,
    };
  }

  const read: IncidentioRecord[] = [];
  let readBackTo: string | null = null;
  const walk = (gap: string | null): IncidentioHistoryWalk => ({
    records: uniqueById(read)
      .map((r) => mapRecord(r, page))
      .sort((a, b) => newestFirst(a.created_at, b.created_at)),
    reachedFloor: gap === null,
    readBackTo,
    gap,
  });
  const limitPassed = (from: string) =>
    `the ${HISTORY_DEADLINE_MS / 1000}-second limit on the read passed before the quarter starting ${from}`;

  const newest = utcQuarter(Date.now());
  const oldest = Math.min(utcQuarter(floorMs), newest);
  for (let quarter = newest; quarter >= oldest; quarter--) {
    const start = quarterStart(quarter);
    const from = new Date(start).toISOString().slice(0, 10);
    if (deadline - Date.now() <= 0) return walk(limitPassed(from));
    try {
      const window = { start, end: quarterStart(quarter + 1) };
      read.push(...(await fetchIncidentList(target, timeLeft(), window)).data.incidents);
    } catch (err) {
      if (!(err instanceof McpError)) throw err;
      return walk(
        Date.now() >= deadline
          ? limitPassed(from)
          : `the quarter starting ${from} failed: ${err.message}`,
      );
    }
    readBackTo = from;
  }
  return walk(null);
}
