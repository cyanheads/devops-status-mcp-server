/**
 * @fileoverview Statuspage API response types (Atlassian Statuspage v2).
 * @module services/statuspage/types
 */

export interface StatuspagePage {
  id: string;
  name: string;
  time_zone: string;
  updated_at: string;
  url: string;
}

export interface StatuspageStatus {
  description: string;
  indicator: 'none' | 'minor' | 'major' | 'critical';
}

export interface StatuspageComponent {
  created_at: string;
  description: string | null;
  group: boolean;
  group_id: string | null;
  id: string;
  name: string;
  only_show_if_degraded: boolean;
  position: number;
  showcase: boolean;
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
  impact: 'none' | 'minor' | 'major' | 'critical';
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

export interface StatuspageSummaryResponse {
  components: StatuspageComponent[];
  incidents: StatuspageIncident[];
  page: StatuspagePage;
  scheduled_maintenances: StatuspageIncident[];
  status: StatuspageStatus;
}
