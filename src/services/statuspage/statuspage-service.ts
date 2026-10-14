/**
 * @fileoverview Statuspage service — fetches Atlassian Statuspage v2 endpoints and the
 * page's history archive, with an in-memory cache.
 * @module services/statuspage/statuspage-service
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { fetchCached } from '@/utils/cached-fetch.js';
import { htmlToText } from '@/utils/html-to-text.js';
import type {
  StatuspageHistoryResponse,
  StatuspageIncident,
  StatuspageIncidentsResponse,
  StatuspageScheduledMaintenancesResponse,
  StatuspageSummaryResponse,
} from './types.js';
import {
  StatuspageHistoryResponseSchema,
  StatuspageIncidentsResponseSchema,
  StatuspageScheduledMaintenancesResponseSchema,
  StatuspageSummaryResponseSchema,
} from './types.js';

/**
 * Fetch one Statuspage endpoint, gating the decoded body against `schema`
 * before it is cached or returned. The gate runs inside the fetch's parse step so
 * a non-conforming payload is never cached, and it returns the original body so
 * unknown vendor fields survive. `toPlainText` then converts the body's update text
 * in place, so it is converted once per fetch and cached converted. `kind` names the
 * endpoint in the rejection.
 */
async function fetchEndpoint<T>(
  baseUrl: string,
  path: string,
  schema: z.ZodType,
  kind: string,
  toPlainText: (body: T) => void,
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
    toPlainText(body as T);
    return body as T;
  });
}

/** Render every update body of `incidents` — HTML on many pages — as plain text, in place. */
function convertUpdateBodies(incidents: readonly StatuspageIncident[] | undefined): void {
  for (const incident of incidents ?? []) {
    for (const update of incident.incident_updates) update.body = htmlToText(update.body);
  }
}

export class StatuspageService {
  fetchSummary(baseUrl: string): Promise<{ data: StatuspageSummaryResponse; cached: boolean }> {
    return fetchEndpoint<StatuspageSummaryResponse>(
      baseUrl,
      '/api/v2/summary.json',
      StatuspageSummaryResponseSchema,
      'summary',
      (body) => {
        convertUpdateBodies(body.incidents);
        convertUpdateBodies(body.scheduled_maintenances);
      },
    );
  }

  fetchIncidents(baseUrl: string): Promise<{ data: StatuspageIncidentsResponse; cached: boolean }> {
    return fetchEndpoint<StatuspageIncidentsResponse>(
      baseUrl,
      '/api/v2/incidents.json',
      StatuspageIncidentsResponseSchema,
      'incidents',
      (body) => convertUpdateBodies(body.incidents),
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
      (body) => convertUpdateBodies(body.scheduled_maintenances),
    );
  }

  /**
   * One page of the quarterly history archive the status page renders its
   * "Incident History" view from. Undocumented and served per host: some pages
   * answer 404, and a redirecting host may drop `?page=`. Each record's `message`
   * carries the same markup as a v2 update body and is converted the same way.
   */
  fetchHistory(
    baseUrl: string,
    page: number,
  ): Promise<{ data: StatuspageHistoryResponse; cached: boolean }> {
    return fetchEndpoint<StatuspageHistoryResponse>(
      baseUrl,
      `/history.json?page=${page}`,
      StatuspageHistoryResponseSchema,
      'history',
      (body) => {
        for (const month of body.months) {
          for (const record of month.incidents) record.message = htmlToText(record.message);
        }
      },
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
