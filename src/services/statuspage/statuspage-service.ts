/**
 * @fileoverview Statuspage service — fetches Atlassian Statuspage v2 endpoints with an in-memory cache.
 * @module services/statuspage/statuspage-service
 */

import { getServerConfig } from '@/config/server-config.js';
import { fetchJsonCached } from '@/utils/cached-fetch.js';
import type {
  StatuspageIncidentsResponse,
  StatuspageScheduledMaintenancesResponse,
  StatuspageSummaryResponse,
} from './types.js';

export class StatuspageService {
  async fetchSummary(
    baseUrl: string,
  ): Promise<{ data: StatuspageSummaryResponse; cached: boolean }> {
    const { cacheTtlMs, fetchTimeoutMs } = getServerConfig();
    return await fetchJsonCached<StatuspageSummaryResponse>(
      `${baseUrl}/api/v2/summary.json`,
      cacheTtlMs,
      fetchTimeoutMs,
    );
  }

  async fetchIncidents(
    baseUrl: string,
  ): Promise<{ data: StatuspageIncidentsResponse; cached: boolean }> {
    const { cacheTtlMs, fetchTimeoutMs } = getServerConfig();
    return await fetchJsonCached<StatuspageIncidentsResponse>(
      `${baseUrl}/api/v2/incidents.json`,
      cacheTtlMs,
      fetchTimeoutMs,
    );
  }

  async fetchScheduledMaintenances(
    baseUrl: string,
  ): Promise<{ data: StatuspageScheduledMaintenancesResponse; cached: boolean }> {
    const { cacheTtlMs, fetchTimeoutMs } = getServerConfig();
    return await fetchJsonCached<StatuspageScheduledMaintenancesResponse>(
      `${baseUrl}/api/v2/scheduled-maintenances.json`,
      cacheTtlMs,
      fetchTimeoutMs,
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
