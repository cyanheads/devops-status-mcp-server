/**
 * @fileoverview Status dispatch — routes a resolved vendor to the adapter for
 * its api_type and returns data normalized into the Statuspage shapes, so
 * every tool consumes one shape regardless of the vendor's backend.
 * @module services/status-adapters/status-dispatch
 */

import { getStatuspageService } from '@/services/statuspage/statuspage-service.js';
import type {
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

/** Fetch the status summary for a resolved vendor via its backend adapter. */
export function fetchVendorSummary(
  vendor: ResolvedVendor,
): Promise<{ data: StatuspageSummaryResponse; cached: boolean }> {
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
    case 'firehydrant':
      return fetchFirehydrantSummary(vendor);
  }
}

/** Fetch the incident list for a resolved vendor via its backend adapter. */
export function fetchVendorIncidents(
  vendor: ResolvedVendor,
): Promise<{ data: StatuspageIncidentsResponse; cached: boolean }> {
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
    case 'firehydrant':
      return fetchFirehydrantIncidents(vendor);
  }
}

/** Fetch scheduled maintenances for a resolved vendor via its backend adapter. */
export function fetchVendorScheduledMaintenances(
  vendor: ResolvedVendor,
): Promise<{ data: StatuspageScheduledMaintenancesResponse; cached: boolean }> {
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
    case 'firehydrant':
      return fetchFirehydrantScheduledMaintenances(vendor);
  }
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
      // (page 2 comes back with the same first record).
      return { incidentCeiling: 50, resolved: 'full', scheduledMaintenance: true };
    case 'slack':
      // /api/v2.0.0/history has the same 50-record ceiling and no working page
      // parameter; fetchSlackScheduledMaintenances is empty with no network call.
      return { incidentCeiling: 50, resolved: 'full', scheduledMaintenance: false };
    case 'aws':
      // The public health feed lists currently-open events only — mapAwsEvent pins
      // every one to 'investigating' because the feed carries no lifecycle field,
      // and fetchAwsScheduledMaintenances is empty with no network call.
      return { incidentCeiling: null, resolved: 'none', scheduledMaintenance: false };
    case 'gcp':
      // incidents.json returns a bare array with no record cap and no paging
      // parameter — it is a rolling recent window, so history is bounded by age
      // rather than by a count this tool can disclose. Resolved incidents stay in
      // it (mapGcpIncident reads resolution from `end`), and Google Cloud
      // publishes no maintenance feed: fetchGcpScheduledMaintenances is empty
      // with no network call.
      return { incidentCeiling: null, resolved: 'full', scheduledMaintenance: false };
    case 'statusio':
      // The Public Status API serves the page's current incidents plus its active
      // and upcoming maintenance windows; resolved incidents drop off the feed.
      return { incidentCeiling: null, resolved: 'current', scheduledMaintenance: true };
    case 'firehydrant':
      // /data/payload.json carries the complete incident history unwindowed —
      // devops_get_incidents pages it via limit + offset.
      return { incidentCeiling: null, resolved: 'full', scheduledMaintenance: true };
  }
}
