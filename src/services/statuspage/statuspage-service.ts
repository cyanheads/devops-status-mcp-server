/**
 * @fileoverview Statuspage service — fetches Atlassian Statuspage v2 endpoints with an in-memory cache.
 * @module services/statuspage/statuspage-service
 */

import { getServerConfig } from '@/config/server-config.js';
import type { StatuspageIncidentsResponse, StatuspageSummaryResponse } from './types.js';

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

/** Shared in-memory cache across all tenants — Statuspage data is public. */
const CACHE = new Map<string, CacheEntry<unknown>>();

function cacheGet<T>(key: string): T | null {
  const entry = CACHE.get(key) as CacheEntry<T> | undefined;
  if (!entry || Date.now() > entry.expiresAt) {
    CACHE.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet<T>(key: string, value: T, ttlMs: number): void {
  CACHE.set(key, { value, expiresAt: Date.now() + ttlMs });
}

/** Fetch a Statuspage endpoint, with timeout and cache. */
async function fetchStatuspage<T>(
  url: string,
  ttlMs: number,
  timeoutMs: number,
): Promise<{ data: T; cached: boolean }> {
  const cached = cacheGet<T>(url);
  if (cached !== null) return { data: cached, cached: true };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    const data = (await res.json()) as T;
    cacheSet(url, data, ttlMs);
    return { data, cached: false };
  } finally {
    clearTimeout(timer);
  }
}

export class StatuspageService {
  async fetchSummary(
    baseUrl: string,
  ): Promise<{ data: StatuspageSummaryResponse; cached: boolean }> {
    const { cacheTtlMs, fetchTimeoutMs } = getServerConfig();
    return await fetchStatuspage<StatuspageSummaryResponse>(
      `${baseUrl}/api/v2/summary.json`,
      cacheTtlMs,
      fetchTimeoutMs,
    );
  }

  async fetchIncidents(
    baseUrl: string,
  ): Promise<{ data: StatuspageIncidentsResponse; cached: boolean }> {
    const { cacheTtlMs, fetchTimeoutMs } = getServerConfig();
    return await fetchStatuspage<StatuspageIncidentsResponse>(
      `${baseUrl}/api/v2/incidents.json`,
      cacheTtlMs,
      fetchTimeoutMs,
    );
  }

  async fetchScheduledMaintenances(
    baseUrl: string,
  ): Promise<{ data: StatuspageIncidentsResponse; cached: boolean }> {
    const { cacheTtlMs, fetchTimeoutMs } = getServerConfig();
    return await fetchStatuspage<StatuspageIncidentsResponse>(
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
