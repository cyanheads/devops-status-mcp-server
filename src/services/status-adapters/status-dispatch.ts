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
  }
}
