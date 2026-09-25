/**
 * @fileoverview Statuspage API response types (Atlassian Statuspage v2), plus the
 * runtime schemas that gate a raw response before it is treated as one.
 * @module services/statuspage/types
 */

import { z } from '@cyanheads/mcp-ts-core';

export interface StatuspagePage {
  id: string;
  name: string;
  /**
   * IANA zone the page displays times in. Absent on some v2-compatible pages that
   * are not hosted by Atlassian (verified on cohere, planetscale, openai).
   */
  time_zone?: string;
  updated_at: string;
  url: string;
}

/**
 * The severity ladder an outage is rated on. The native adapters synthesize an
 * indicator by ranking incident impacts and skip maintenance records while doing
 * it, so they only ever produce a value from this ladder — `maintenance` reaches
 * a caller from a Statuspage page's own `status` block, never from a mapper.
 */
export type StatuspageSeverityIndicator = 'none' | 'minor' | 'major' | 'critical';

export interface StatuspageStatus {
  description: string;
  /**
   * Statuspage publishes `maintenance` here for the duration of an open
   * maintenance window — off the severity ladder, and a planned window rather
   * than a fault. Verified live on brevo.
   */
  indicator: StatuspageSeverityIndicator | 'maintenance';
}

/**
 * Only `id`/`name`/`status` and the timestamps are universal — pages routinely omit
 * the presentational fields entirely rather than sending null (verified on openai).
 */
export interface StatuspageComponent {
  created_at: string;
  description?: string | null;
  group?: boolean;
  group_id?: string | null;
  id: string;
  name: string;
  only_show_if_degraded?: boolean;
  position: number;
  showcase?: boolean;
  status:
    | 'operational'
    | 'degraded_performance'
    | 'partial_outage'
    | 'major_outage'
    | 'under_maintenance';
  updated_at: string;
}

export interface AffectedComponent {
  code: string;
  name: string;
  new_status: string;
  old_status: string;
}

export interface IncidentUpdate {
  affected_components: AffectedComponent[] | null;
  body: string;
  created_at: string;
  display_at: string;
  id: string;
  status: string;
}

export interface StatuspageIncident {
  components: StatuspageComponent[];
  created_at: string;
  id: string;
  /**
   * Statuspage folds maintenance windows into incident history, so `maintenance`
   * appears in the `incidents` array as well as in `scheduled_maintenances` —
   * verified live on vercel and linode.
   */
  impact: 'none' | 'minor' | 'major' | 'critical' | 'maintenance';
  incident_updates: IncidentUpdate[];
  monitoring_at: string | null;
  name: string;
  page_id: string;
  resolved_at: string | null;
  /** Present for scheduled maintenances. */
  scheduled_for?: string;
  /** Present for scheduled maintenances. */
  scheduled_until?: string;
  shortlink?: string | null;
  started_at?: string | null;
  status: string;
}

export interface StatuspageStatusResponse {
  page: StatuspagePage;
  status: StatuspageStatus;
}

export interface StatuspageComponentsResponse {
  components: StatuspageComponent[];
  page: StatuspagePage;
}

export interface StatuspageIncidentsResponse {
  incidents: StatuspageIncident[];
  page: StatuspagePage;
}

export interface StatuspageScheduledMaintenancesResponse {
  page: StatuspagePage;
  scheduled_maintenances: StatuspageIncident[];
}

/**
 * One record of the page's quarterly history archive (`{base_url}/history.json`).
 * `code` is the same identifier as the v2 incident `id`.
 */
export interface StatuspageHistoryIncident {
  code: string;
  impact: 'none' | 'minor' | 'major' | 'critical' | 'maintenance';
  /** The latest update body, with the same markup v2 update bodies carry. */
  message: string;
  name: string;
  /**
   * Rendered display text with no year and a local zone abbreviation, e.g.
   * `Dec <var data-var='date'>31</var>, <var data-var='time'>22:28</var> - Jan
   * <var data-var='date'>1</var>, <var data-var='time'>08:17</var> PST`. A span is
   * filed under the month it ends in.
   */
  timestamp: string;
}

export interface StatuspageHistoryMonth {
  incidents: StatuspageHistoryIncident[];
  /** Full English month name, e.g. `January`. */
  name: string;
  year: number;
}

/**
 * One page of the history archive. Page 1 is the current calendar quarter and
 * each later page one quarter earlier; a page past the end still returns 200.
 */
export interface StatuspageHistoryResponse {
  months: StatuspageHistoryMonth[];
  /** Window start as a local ISO timestamp with offset, e.g. `2026-07-01T00:00:00-07:00`. */
  start_time: string;
}

export interface StatuspageSummaryResponse {
  components: StatuspageComponent[];
  /** Omitted entirely by some pages when there is nothing to report — not always `[]`. */
  incidents?: StatuspageIncident[];
  page: StatuspagePage;
  /** Omitted entirely by some pages when there is nothing to report — not always `[]`. */
  scheduled_maintenances?: StatuspageIncident[];
  status: StatuspageStatus;
}

/**
 * Runtime gate for a raw Statuspage response body.
 *
 * The four native adapters normalize their upstreams through hand-written
 * defensive mappers, so a surprising payload can't reach a consumer. The
 * Statuspage path passes the body straight through to those consumers, which is
 * why a 200 carrying some other service's JSON has to be rejected here rather
 * than dereferenced downstream.
 *
 * Deliberately looser than the interfaces above: it requires the containers and
 * enums that the normalizers actually dereference and leaves everything else
 * optional, so a real page with sparse or unfamiliar fields still passes. Unknown
 * keys are accepted — callers keep the original body, not the parse output.
 */
const PageSchema = z.object({ name: z.string() });

const ComponentSchema = z.object({
  name: z.string(),
  status: z.enum([
    'operational',
    'degraded_performance',
    'partial_outage',
    'major_outage',
    'under_maintenance',
  ]),
  group: z.boolean().optional(),
  description: z.string().nullish(),
});

const IncidentSchema = z.object({
  id: z.string(),
  name: z.string(),
  impact: z.enum(['none', 'minor', 'major', 'critical', 'maintenance']),
  status: z.string(),
  created_at: z.string(),
  incident_updates: z.array(
    z.object({
      body: z.string(),
      status: z.string(),
      created_at: z.string(),
      affected_components: z.array(z.object({ name: z.string() })).nullish(),
    }),
  ),
});

export const StatuspageSummaryResponseSchema = z.object({
  page: PageSchema,
  status: z.object({
    /**
     * `maintenance` is not on the severity ladder but a page publishes it while a
     * window is open (verified live on brevo). Rejecting it failed the whole
     * payload and reported a healthy, well-formed page as not a Statuspage at all.
     */
    indicator: z.enum(['none', 'minor', 'major', 'critical', 'maintenance']),
    description: z.string(),
  }),
  components: z.array(ComponentSchema),
  /**
   * Optional: a page with nothing to report may omit these keys rather than send
   * `[]`, so requiring them would reject live pages (openai, clerk, cohere, brevo,
   * elevenlabs, planetscale all do this). `page`/`status`/`components` are what
   * identify the payload as a Statuspage summary at all.
   */
  incidents: z.array(IncidentSchema).optional(),
  scheduled_maintenances: z.array(IncidentSchema).optional(),
});

export const StatuspageIncidentsResponseSchema = z.object({
  page: PageSchema,
  incidents: z.array(IncidentSchema),
});

export const StatuspageScheduledMaintenancesResponseSchema = z.object({
  page: PageSchema,
  scheduled_maintenances: z.array(IncidentSchema),
});

export const StatuspageHistoryResponseSchema = z.object({
  start_time: z.string(),
  months: z.array(
    z.object({
      name: z.string(),
      // A calendar year: outside this range Date.UTC reads it as 19xx or cannot place it.
      year: z.number().int().min(1970).max(9999),
      incidents: z.array(
        z.object({
          code: z.string(),
          name: z.string(),
          message: z.string(),
          impact: z.enum(['none', 'minor', 'major', 'critical', 'maintenance']),
          timestamp: z.string(),
        }),
      ),
    }),
  ),
});
