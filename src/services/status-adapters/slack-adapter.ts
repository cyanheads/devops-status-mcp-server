/**
 * @fileoverview Slack status adapter — fetches Slack's own status API
 * (https://status.slack.com/api/v2.0.0/current + /history; both 301 to
 * slack-status.com, which fetch follows) and normalizes into the Atlassian
 * Statuspage shapes the tools consume.
 *
 * Slack's schema carries no impact level, so severity derives from the
 * incident `type`: 'outage' → critical, 'incident' → minor, 'notice' → none,
 * unknown → minor (an active event of unknown kind is at least a degradation).
 * @module services/status-adapters/slack-adapter
 */

import { getServerConfig } from '@/config/server-config.js';
import type {
  StatuspageIncident,
  StatuspageIncidentsResponse,
  StatuspagePage,
  StatuspageScheduledMaintenancesResponse,
  StatuspageStatus,
  StatuspageSummaryResponse,
} from '@/services/statuspage/types.js';
import { fetchJsonCached } from '@/utils/cached-fetch.js';

// --- Raw Slack status API types (v2.0.0) ---

interface SlackNote {
  body?: string;
  date_created?: string;
}

export interface SlackIncident {
  date_created?: string;
  date_updated?: string;
  id?: number | string;
  notes?: SlackNote[];
  services?: unknown[];
  /** 'active' | 'resolved' */
  status?: string;
  title?: string;
  /** 'incident' | 'notice' | 'outage' */
  type?: string;
  url?: string;
}

export interface SlackCurrent {
  active_incidents?: SlackIncident[];
  date_created?: string;
  date_updated?: string;
  /** 'ok' | 'active' */
  status?: string;
}

/** Identifies the vendor the response is being normalized for. */
export interface SlackTarget {
  name: string;
  slug: string | null;
  /** Status page base URL — /api/v2.0.0/* is appended. */
  url: string;
}

// --- Mappings ---

const SEVERITY_RANK = { none: 0, minor: 1, major: 2, critical: 3 } as const;

function typeToImpact(type: string | undefined): StatuspageStatus['indicator'] {
  switch (type) {
    case 'outage':
      return 'critical';
    case 'incident':
      return 'minor';
    case 'notice':
      return 'none';
    default:
      return 'minor';
  }
}

function serviceName(s: unknown): string | null {
  if (typeof s === 'string') return s;
  if (s && typeof s === 'object' && 'name' in s) return String((s as { name: unknown }).name);
  return null;
}

function buildPage(target: SlackTarget, updatedAt: string | undefined): StatuspagePage {
  return {
    id: target.slug ?? 'slack',
    name: target.name,
    time_zone: 'Etc/UTC',
    updated_at: updatedAt ?? '',
    url: target.url,
  };
}

/** Normalize one Slack incident (current or history item) into a Statuspage incident. */
export function mapSlackIncident(item: SlackIncident, target: SlackTarget): StatuspageIncident {
  const notes = [...(item.notes ?? [])].sort(
    (a, b) => new Date(a.date_created ?? 0).getTime() - new Date(b.date_created ?? 0).getTime(),
  );
  const resolved = item.status === 'resolved';
  const status = resolved ? 'resolved' : 'investigating';
  const affected = (item.services ?? [])
    .map(serviceName)
    .filter((n): n is string => n !== null)
    .map((n) => ({ code: n, name: n, new_status: '', old_status: '' }));

  return {
    id: String(item.id ?? item.url ?? 'unknown'),
    name: item.title ?? 'Unnamed incident',
    impact: typeToImpact(item.type),
    status,
    created_at: item.date_created ?? '',
    started_at: item.date_created ?? null,
    resolved_at: resolved ? (item.date_updated ?? null) : null,
    monitoring_at: null,
    page_id: target.slug ?? 'slack',
    shortlink: item.url ?? null,
    components: [],
    incident_updates: notes.map((n, i) => ({
      id: `${item.id ?? 'note'}-${i}`,
      body: n.body ?? '',
      status,
      created_at: n.date_created ?? '',
      display_at: n.date_created ?? '',
      affected_components: i === notes.length - 1 && affected.length > 0 ? affected : null,
    })),
  };
}

/** Normalize the /current response into a Statuspage summary. */
export function mapSlackSummary(raw: SlackCurrent, target: SlackTarget): StatuspageSummaryResponse {
  const active = (raw.active_incidents ?? []).map((i) => mapSlackIncident(i, target));
  const ok = raw.status === 'ok';
  let indicator: StatuspageStatus['indicator'] = 'none';
  if (!ok) {
    indicator = 'minor'; // active but empty/unknown incident list — at least a degradation
    for (const inc of active) {
      if (SEVERITY_RANK[inc.impact] > SEVERITY_RANK[indicator]) indicator = inc.impact;
    }
  }
  return {
    page: buildPage(target, raw.date_updated),
    status: {
      indicator,
      description: ok ? 'All Systems Operational' : 'Active incidents reported',
    },
    components: [], // Slack's API exposes no global component list
    incidents: active,
    scheduled_maintenances: [],
  };
}

/** Normalize the /history response into the incidents-endpoint shape. */
export function mapSlackIncidents(
  raw: SlackIncident[],
  target: SlackTarget,
): StatuspageIncidentsResponse {
  return {
    page: buildPage(target, undefined),
    incidents: (raw ?? []).map((i) => mapSlackIncident(i, target)),
  };
}

// --- Fetchers ---

export async function fetchSlackSummary(
  target: SlackTarget,
): Promise<{ data: StatuspageSummaryResponse; cached: boolean }> {
  const { cacheTtlMs, fetchTimeoutMs } = getServerConfig();
  const { data, cached } = await fetchJsonCached<SlackCurrent>(
    `${target.url}/api/v2.0.0/current`,
    cacheTtlMs,
    fetchTimeoutMs,
  );
  return { data: mapSlackSummary(data, target), cached };
}

export async function fetchSlackIncidents(
  target: SlackTarget,
): Promise<{ data: StatuspageIncidentsResponse; cached: boolean }> {
  const { cacheTtlMs, fetchTimeoutMs } = getServerConfig();
  const { data, cached } = await fetchJsonCached<SlackIncident[]>(
    `${target.url}/api/v2.0.0/history`,
    cacheTtlMs,
    fetchTimeoutMs,
  );
  return { data: mapSlackIncidents(data, target), cached };
}

/** Slack publishes no maintenance feed — always empty, no network call. */
export function fetchSlackScheduledMaintenances(
  target: SlackTarget,
): Promise<{ data: StatuspageScheduledMaintenancesResponse; cached: boolean }> {
  return Promise.resolve({
    data: { page: buildPage(target, undefined), scheduled_maintenances: [] },
    cached: false,
  });
}
