/**
 * @fileoverview Status dispatch — routes a resolved vendor to the adapter for
 * its api_type and returns data normalized into the Statuspage shapes, so
 * every tool consumes one shape regardless of the vendor's backend.
 * @module services/status-adapters/status-dispatch
 */

import { getStatuspageService } from '@/services/statuspage/statuspage-service.js';
import type {
  StatuspageIncident,
  StatuspageIncidentsResponse,
  StatuspageScheduledMaintenancesResponse,
  StatuspageSummaryResponse,
} from '@/services/statuspage/types.js';
import type { ResolvedVendor } from '@/services/vendor-registry/vendor-registry-service.js';
import {
  fetchAwsIncidents,
  fetchAwsScheduledMaintenances,
  fetchAwsSummary,
} from './aws-adapter.js';
import {
  fetchAzureIncidents,
  fetchAzureScheduledMaintenances,
  fetchAzureSummary,
} from './azure-adapter.js';
import {
  fetchAzureDevOpsIncidents,
  fetchAzureDevOpsScheduledMaintenances,
  fetchAzureDevOpsSummary,
} from './azure-devops-adapter.js';
import { inScopeComponentIds, scopeRecords, scopeSummary } from './component-scope.js';
import {
  fetchDatadogIncidents,
  fetchDatadogScheduledMaintenances,
  fetchDatadogSummary,
} from './datadog-adapter.js';
import {
  fetchFirehydrantIncidents,
  fetchFirehydrantScheduledMaintenances,
  fetchFirehydrantSummary,
} from './firehydrant-adapter.js';
import {
  fetchGcpIncidents,
  fetchGcpScheduledMaintenances,
  fetchGcpSummary,
} from './gcp-adapter.js';
import {
  fetchSlackIncidents,
  fetchSlackScheduledMaintenances,
  fetchSlackSummary,
} from './slack-adapter.js';
import {
  fetchStatusioIncidents,
  fetchStatusioScheduledMaintenances,
  fetchStatusioSummary,
} from './statusio-adapter.js';

type Fetched<T> = Promise<{ data: T; cached: boolean }>;

/** The backend's summary for a resolved vendor, before any component scope. */
function backendSummary(vendor: ResolvedVendor): Fetched<StatuspageSummaryResponse> {
  switch (vendor.api_type) {
    case 'statuspage':
      return getStatuspageService().fetchSummary(vendor.url);
    case 'statusio':
      return fetchStatusioSummary(vendor);
    case 'slack':
      return fetchSlackSummary(vendor);
    case 'aws':
      return fetchAwsSummary(vendor);
    case 'gcp':
      return fetchGcpSummary(vendor);
    case 'azure':
      return fetchAzureSummary(vendor);
    case 'azure-devops':
      return fetchAzureDevOpsSummary(vendor);
    case 'firehydrant':
      return fetchFirehydrantSummary(vendor);
    case 'datadog':
      return fetchDatadogSummary(vendor);
  }
}

/** The backend's incident list for a resolved vendor, before any component scope. */
function backendIncidents(vendor: ResolvedVendor): Fetched<StatuspageIncidentsResponse> {
  switch (vendor.api_type) {
    case 'statuspage':
      return getStatuspageService().fetchIncidents(vendor.url);
    case 'statusio':
      return fetchStatusioIncidents(vendor);
    case 'slack':
      return fetchSlackIncidents(vendor);
    case 'aws':
      return fetchAwsIncidents(vendor);
    case 'gcp':
      return fetchGcpIncidents(vendor);
    case 'azure':
      return fetchAzureIncidents(vendor);
    case 'azure-devops':
      return fetchAzureDevOpsIncidents(vendor);
    case 'firehydrant':
      return fetchFirehydrantIncidents(vendor);
    case 'datadog':
      return fetchDatadogIncidents(vendor);
  }
}

/** The backend's maintenance windows for a resolved vendor, before any component scope. */
function backendScheduledMaintenances(
  vendor: ResolvedVendor,
): Fetched<StatuspageScheduledMaintenancesResponse> {
  switch (vendor.api_type) {
    case 'statuspage':
      return getStatuspageService().fetchScheduledMaintenances(vendor.url);
    case 'statusio':
      return fetchStatusioScheduledMaintenances(vendor);
    case 'slack':
      return fetchSlackScheduledMaintenances(vendor);
    case 'aws':
      return fetchAwsScheduledMaintenances(vendor);
    case 'gcp':
      return fetchGcpScheduledMaintenances(vendor);
    case 'azure':
      return fetchAzureScheduledMaintenances(vendor);
    case 'azure-devops':
      return fetchAzureDevOpsScheduledMaintenances(vendor);
    case 'firehydrant':
      return fetchFirehydrantScheduledMaintenances(vendor);
    case 'datadog':
      return fetchDatadogScheduledMaintenances(vendor);
  }
}

/**
 * Ids of a scoped vendor's components. Incident and maintenance records name their
 * components by id and group id but carry no group names, so the page's component
 * table — the summary, shared with the status check through the response cache — is
 * what resolves a group id to its name.
 */
async function scopedComponentIds(vendor: ResolvedVendor, prefix: string): Promise<Set<string>> {
  const { data } = await backendSummary(vendor);
  return inScopeComponentIds(data.components, prefix);
}

/**
 * Fetch the status summary for a resolved vendor via its backend adapter, narrowed to
 * the entry's components when it declares a component scope.
 */
export async function fetchVendorSummary(
  vendor: ResolvedVendor,
): Fetched<StatuspageSummaryResponse> {
  const prefix = vendor.component_scope_prefix;
  if (prefix === undefined) return backendSummary(vendor);
  const { data, cached } = await backendSummary(vendor);
  return { data: scopeSummary(data, prefix, vendor.name), cached };
}

/**
 * Fetch the incident list for a resolved vendor via its backend adapter, narrowed to
 * the records touching the entry's components when it declares a component scope.
 * `upstreamIncidents` are the records the feed returned before that narrowing: their
 * count shows whether the feed hit its own ceiling, and their oldest start is how far
 * back the feed reaches.
 */
export async function fetchVendorIncidents(vendor: ResolvedVendor): Promise<{
  data: StatuspageIncidentsResponse;
  cached: boolean;
  upstreamIncidents: StatuspageIncident[];
}> {
  const prefix = vendor.component_scope_prefix;
  if (prefix === undefined) {
    const { data, cached } = await backendIncidents(vendor);
    return { data, cached, upstreamIncidents: data.incidents };
  }
  const [{ data, cached }, ids] = await Promise.all([
    backendIncidents(vendor),
    scopedComponentIds(vendor, prefix),
  ]);
  return {
    data: {
      page: { ...data.page, name: vendor.name },
      incidents: scopeRecords(data.incidents, ids),
    },
    cached,
    upstreamIncidents: data.incidents,
  };
}

/**
 * Fetch scheduled maintenances for a resolved vendor via its backend adapter, narrowed
 * to the windows touching the entry's components when it declares a component scope.
 */
export async function fetchVendorScheduledMaintenances(
  vendor: ResolvedVendor,
): Fetched<StatuspageScheduledMaintenancesResponse> {
  const prefix = vendor.component_scope_prefix;
  if (prefix === undefined) return backendScheduledMaintenances(vendor);
  const [{ data, cached }, ids] = await Promise.all([
    backendScheduledMaintenances(vendor),
    scopedComponentIds(vendor, prefix),
  ]);
  return {
    data: {
      page: { ...data.page, name: vendor.name },
      scheduled_maintenances: scopeRecords(data.scheduled_maintenances, ids),
    },
    cached,
  };
}

/**
 * What a backend's upstream feed can serve, independent of any windowing this
 * server applies. Normalizing every backend to the Statuspage shapes hides these
 * differences, so a caller asking for history the feed never carries gets an
 * empty list with no explanation unless the tool states the difference.
 */
export type BackendHistory = {
  /**
   * Most incident records the upstream incident feed returns in one fetch, or
   * null when the feed is unbounded and this server pages it itself.
   */
  incidentCeiling: number | null;
  /**
   * How far resolved incidents reach back:
   * - `full` — the feed carries resolved incidents (bounded by incidentCeiling).
   * - `current` — only the incidents the page currently lists; resolved entries drop off.
   * - `none` — the feed has no resolution lifecycle, so no incident is ever resolved.
   */
  resolved: 'full' | 'current' | 'none';
  /** Whether the backend publishes scheduled-maintenance windows at all. */
  scheduledMaintenance: boolean;
  /**
   * Whether the backend family can publish a quarterly history archive that reaches
   * past incidentCeiling. A capability of the family, not a promise for every host:
   * some pages do not serve it, which a call discloses in its notice.
   */
  historyPages: boolean;
  /**
   * Whether one fetch returns every record the page publishes. Nothing older than such
   * a feed's oldest record exists on the page; a feed without it (and without
   * historyPages) is a recent window that stops short of what the page once listed.
   */
  wholeHistory: boolean;
};

/**
 * Feed capabilities for a resolved vendor's backend.
 *
 * Exhaustive over `api_type` for the same reason the fetchers above are: a new
 * backend cannot be added without stating what its feed can and cannot serve.
 */
export function backendHistory(apiType: ResolvedVendor['api_type']): BackendHistory {
  switch (apiType) {
    case 'statuspage':
      // /api/v2/incidents.json returns at most 50 records and ignores ?page=
      // (page 2 comes back with the same first record). The page's own
      // {base_url}/history.json?page=N archive pages back by calendar quarter.
      return {
        incidentCeiling: 50,
        resolved: 'full',
        scheduledMaintenance: true,
        historyPages: true,
        wholeHistory: false,
      };
    case 'slack':
      // /api/v2.0.0/history has the same 50-record ceiling and no working page
      // parameter; fetchSlackScheduledMaintenances is empty with no network call.
      return {
        incidentCeiling: 50,
        resolved: 'full',
        scheduledMaintenance: false,
        historyPages: false,
        wholeHistory: false,
      };
    case 'aws':
      // The public health feed lists current events: a resolved one (status "0")
      // stays listed for hours and then drops off, so resolved history reaches back
      // only that far. fetchAwsScheduledMaintenances is empty with no network call.
      return {
        incidentCeiling: null,
        resolved: 'current',
        scheduledMaintenance: false,
        historyPages: false,
        wholeHistory: false,
      };
    case 'gcp':
      // incidents.json returns a bare array with no record cap and no paging
      // parameter — it is a rolling recent window, so history is bounded by age
      // rather than by a count this tool can disclose. Resolved incidents stay in
      // it (mapGcpIncident reads resolution from `end`), and Google Cloud
      // publishes no maintenance feed: fetchGcpScheduledMaintenances is empty
      // with no network call.
      return {
        incidentCeiling: null,
        resolved: 'full',
        scheduledMaintenance: false,
        historyPages: false,
        wholeHistory: false,
      };
    case 'azure':
      // The RSS feed lists posted items only — nothing marks one resolved, it just
      // leaves the feed — so every item maps to 'investigating'. The feed carries no
      // maintenance data: fetchAzureScheduledMaintenances is empty with no network call.
      return {
        incidentCeiling: null,
        resolved: 'none',
        scheduledMaintenance: false,
        historyPages: false,
        wholeHistory: false,
      };
    case 'azure-devops':
      // The _rss feed is a rolling window bounded by age, with no record count to
      // disclose, and it keeps resolved events (status:state Resolved). Neither source
      // publishes maintenance: fetchAzureDevOpsScheduledMaintenances is empty with no
      // network call.
      return {
        incidentCeiling: null,
        resolved: 'full',
        scheduledMaintenance: false,
        historyPages: false,
        wholeHistory: false,
      };
    case 'statusio':
      // The Public Status API serves the page's current incidents plus its active
      // and upcoming maintenance windows; resolved incidents drop off the feed.
      return {
        incidentCeiling: null,
        resolved: 'current',
        scheduledMaintenance: true,
        historyPages: false,
        wholeHistory: false,
      };
    case 'firehydrant':
      // /data/payload.json carries the complete incident history unwindowed —
      // devops_get_incidents pages it via limit + offset.
      return {
        incidentCeiling: null,
        resolved: 'full',
        scheduledMaintenance: true,
        historyPages: false,
        wholeHistory: true,
      };
    case 'datadog':
      // {page}/config.json is the page's whole record — every incident it has published
      // plus its maintenance windows — returned unwindowed, like Firehydrant's payload.
      return {
        incidentCeiling: null,
        resolved: 'full',
        scheduledMaintenance: true,
        historyPages: false,
        wholeHistory: true,
      };
  }
}

/**
 * Feed capabilities for one resolved vendor: its backend's, except that an entry with a
 * component scope reads no history archive — archive records list no components, so
 * they cannot be narrowed to the entry's. The incident ceiling still applies, counted on
 * the unscoped feed.
 */
export function vendorHistory(vendor: ResolvedVendor): BackendHistory {
  const history = backendHistory(vendor.api_type);
  return vendor.component_scope_prefix === undefined
    ? history
    : { ...history, historyPages: false };
}
