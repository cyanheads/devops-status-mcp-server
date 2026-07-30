/**
 * @fileoverview Statuspage service — fetches Atlassian Statuspage v2 endpoints with an in-memory cache.
 * @module services/statuspage/statuspage-service
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { fetchCached } from '@/utils/cached-fetch.js';
import type {
  StatuspageIncidentsResponse,
  StatuspageScheduledMaintenancesResponse,
  StatuspageSummaryResponse,
} from './types.js';
import {
  StatuspageIncidentsResponseSchema,
  StatuspageScheduledMaintenancesResponseSchema,
  StatuspageSummaryResponseSchema,
} from './types.js';

/**
 * Fetch one Statuspage v2 endpoint, gating the decoded body against `schema`
 * before it is cached or returned. The gate runs inside the fetch's parse step so
 * a non-conforming payload is never cached, and it returns the original body so
 * unknown vendor fields survive. `kind` names the endpoint in the rejection.
 */
async function fetchEndpoint<T>(
  baseUrl: string,
  path: string,
  schema: z.ZodType,
  kind: string,
): Promise<{ data: T; cached: boolean }> {
  const { cacheTtlMs, fetchTimeoutMs } = getServerConfig();
  const url = `${baseUrl}${path}`;
  return await fetchCached<T>(url, cacheTtlMs, fetchTimeoutMs, async (res) => {
    const body: unknown = await res.json();
    if (!schema.safeParse(body).success) {
      throw serviceUnavailable(
        `${url} did not return a valid Atlassian Statuspage ${kind} payload — ` +
          `the response parsed as JSON but does not carry the expected Statuspage fields.`,
        { reason: 'statuspage_unavailable', url },
      );
    }
    return body as T;
  });
}

export class StatuspageService {
  fetchSummary(baseUrl: string): Promise<{ data: StatuspageSummaryResponse; cached: boolean }> {
    return fetchEndpoint<StatuspageSummaryResponse>(
      baseUrl,
      '/api/v2/summary.json',
      StatuspageSummaryResponseSchema,
      'summary',
    );
  }

  fetchIncidents(baseUrl: string): Promise<{ data: StatuspageIncidentsResponse; cached: boolean }> {
    return fetchEndpoint<StatuspageIncidentsResponse>(
      baseUrl,
      '/api/v2/incidents.json',
      StatuspageIncidentsResponseSchema,
      'incidents',
    );
  }

  fetchScheduledMaintenances(
    baseUrl: string,
  ): Promise<{ data: StatuspageScheduledMaintenancesResponse; cached: boolean }> {
    return fetchEndpoint<StatuspageScheduledMaintenancesResponse>(
      baseUrl,
      '/api/v2/scheduled-maintenances.json',
      StatuspageScheduledMaintenancesResponseSchema,
      'scheduled maintenances',
    );
  }
}

// --- Init/accessor pattern ---

let _service: StatuspageService | undefined;

export function initStatuspageService(): void {
  _service = new StatuspageService();
}

export function getStatuspageService(): StatuspageService {
  if (!_service)
    throw new Error('StatuspageService not initialized — call initStatuspageService() in setup()');
  return _service;
}
