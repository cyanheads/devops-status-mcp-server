/**
 * @fileoverview Slack status adapter — fetches Slack's own status API
 * (https://status.slack.com/api/v2.0.0/current + /history; both 301 to
 * slack-status.com, which fetch follows) and normalizes into the Atlassian
 * Statuspage shapes the tools consume.
 *
 * Slack's schema carries no impact level, so severity derives from the
 * incident `type`: 'outage' → critical, 'incident' → minor, 'notice' → none,
 * unknown → minor (an active event of unknown kind is at least a degradation).
 *
 * /current must be an object with a string `status` and /history an array. Any
 * other body is some other document, not this API, and is rejected rather than
 * read as a health report or an empty history. Incident fields stay unchecked, so
 * a sparse item still maps.
 * @module services/status-adapters/slack-adapter
 */

import { z } from '@cyanheads/mcp-ts-core';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import type {
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

/** The /current envelope; the active incidents inside are read field by field. */
const CurrentEnvelopeSchema = z.object({ status: z.string() });

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
  status: string;
}

/** Identifies the vendor the response is being normalized for. */
export interface SlackTarget {
  name: string;
  slug: string | null;
  /** Status page base URL — /api/v2.0.0/* is appended. */
  url: string;
}

// --- Mappings ---

function typeToImpact(type: string | undefined): StatuspageSeverityIndicator {
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
      // Every note is HTML (`<p>…</p>`, `&nbsp;`); bodies leave here as plain text.
      body: htmlToText(n.body ?? ''),
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
  let indicator: StatuspageSeverityIndicator = 'none';
  if (!ok) {
    /**
     * Not ok with nothing listed is at least a degradation. A listed item carries its
     * own impact — a notice is informational, an item of unknown kind already rates
     * minor — so the worst of them is the indicator.
     */
    if (active.length === 0) indicator = 'minor';
    for (const inc of active) {
      if (inc.impact !== 'maintenance' && SEVERITY_RANK[inc.impact] > SEVERITY_RANK[indicator])
        indicator = inc.impact;
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
    incidents: raw.map((i) => mapSlackIncident(i, target)),
  };
}

// --- Fetchers ---

export async function fetchSlackSummary(
  target: SlackTarget,
): Promise<{ data: StatuspageSummaryResponse; cached: boolean }> {
  const { cacheTtlMs, fetchTimeoutMs } = getServerConfig();
  const url = `${target.url}/api/v2.0.0/current`;
  const { data, cached } = await fetchCached<SlackCurrent>(
    url,
    cacheTtlMs,
    fetchTimeoutMs,
    async (res) => {
      const body: unknown = await res.json();
      if (!CurrentEnvelopeSchema.safeParse(body).success) {
        throw serviceUnavailable(
          `${url} returned a body without the string status Slack's /current endpoint publishes.`,
          { reason: 'statuspage_unavailable', url },
        );
      }
      return body as SlackCurrent;
    },
  );
  return { data: mapSlackSummary(data, target), cached };
}

export async function fetchSlackIncidents(
  target: SlackTarget,
): Promise<{ data: StatuspageIncidentsResponse; cached: boolean }> {
  const { cacheTtlMs, fetchTimeoutMs } = getServerConfig();
  const url = `${target.url}/api/v2.0.0/history`;
  const { data, cached } = await fetchCached<SlackIncident[]>(
    url,
    cacheTtlMs,
    fetchTimeoutMs,
    async (res) => {
      const body: unknown = await res.json();
      if (!Array.isArray(body)) {
        throw serviceUnavailable(
          `${url} returned a body that is not the incident array Slack's /history endpoint publishes.`,
          { reason: 'statuspage_unavailable', url },
        );
      }
      return body as SlackIncident[];
    },
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
