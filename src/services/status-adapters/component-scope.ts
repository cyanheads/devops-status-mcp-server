/**
 * @fileoverview Component scoping for a registry entry that publishes on a status page it
 * shares with other products. The entry's prefix selects its components; incidents and
 * maintenance windows are kept when they touch one of them, by component id, and the
 * page's overall indicator — which rates every product on the page — is derived again
 * from the scoped records alone.
 * @module services/status-adapters/component-scope
 */

import type {
  StatuspageComponent,
  StatuspageIncident,
  StatuspageSeverityIndicator,
  StatuspageStatus,
  StatuspageSummaryResponse,
} from '@/services/statuspage/types.js';
import { SEVERITY_RANK } from '@/services/statuspage/types.js';

/**
 * Ids of the components in scope: those whose own name, or whose group's name, starts
 * with `prefix`. A group in scope is kept too, so its leaves keep their group name.
 */
export function inScopeComponentIds(
  components: readonly StatuspageComponent[],
  prefix: string,
): Set<string> {
  const names = new Map(components.map((c) => [c.id, c.name]));
  return new Set(
    components
      .filter(
        (c) =>
          c.name.startsWith(prefix) ||
          (c.group_id != null && (names.get(c.group_id)?.startsWith(prefix) ?? false)),
      )
      .map((c) => c.id),
  );
}

/** The records that list at least one in-scope component. */
export function scopeRecords(
  records: readonly StatuspageIncident[],
  ids: ReadonlySet<string>,
): StatuspageIncident[] {
  return records.filter((r) => (r.components ?? []).some((c) => ids.has(c.id)));
}

const COMPONENT_SEVERITY: Partial<
  Record<StatuspageComponent['status'], StatuspageSeverityIndicator>
> = {
  degraded_performance: 'minor',
  partial_outage: 'major',
  major_outage: 'critical',
};

/** Statuspage's own wording for each indicator, so a scoped page reads like any other. */
const INDICATOR_DESCRIPTION: Record<StatuspageStatus['indicator'], string> = {
  none: 'All Systems Operational',
  minor: 'Partially Degraded Service',
  major: 'Partial System Outage',
  critical: 'Major System Outage',
  maintenance: 'Service Under Maintenance',
};

const OPEN_WINDOW_STATUSES = new Set(['in_progress', 'verifying']);

/**
 * The indicator for the scoped records: the worse of the worst open-incident impact and
 * the worst component status, `maintenance` when nothing is wrong but an in-scope window
 * is open (a window in progress, or a component under maintenance), else `none`.
 */
function scopedStatus(
  components: readonly StatuspageComponent[],
  incidents: readonly StatuspageIncident[],
  maintenances: readonly StatuspageIncident[],
): StatuspageStatus {
  let worst: StatuspageSeverityIndicator = 'none';
  const raise = (level: StatuspageSeverityIndicator | undefined) => {
    if (level !== undefined && SEVERITY_RANK[level] > SEVERITY_RANK[worst]) worst = level;
  };
  for (const c of components) raise(COMPONENT_SEVERITY[c.status]);
  for (const i of incidents) {
    if (i.status === 'resolved' || i.status === 'postmortem') continue;
    if (i.impact !== 'maintenance') raise(i.impact);
  }

  // Statuspage folds maintenance windows into the incident list as well.
  const windowOpen =
    components.some((c) => c.status === 'under_maintenance') ||
    [...maintenances, ...incidents.filter((i) => i.impact === 'maintenance')].some((m) =>
      OPEN_WINDOW_STATUSES.has(m.status),
    );
  const indicator = worst === 'none' && windowOpen ? 'maintenance' : worst;
  return { indicator, description: INDICATOR_DESCRIPTION[indicator] };
}

/**
 * Narrow a shared page's summary to one vendor's components. The result carries the
 * vendor's own name and an indicator rated on its components, open incidents, and
 * maintenance windows alone. Builds new objects — the cached page is never modified.
 */
export function scopeSummary(
  data: StatuspageSummaryResponse,
  prefix: string,
  name: string,
): StatuspageSummaryResponse {
  const ids = inScopeComponentIds(data.components, prefix);
  const components = data.components.filter((c) => ids.has(c.id));
  const incidents = scopeRecords(data.incidents ?? [], ids);
  const maintenances = scopeRecords(data.scheduled_maintenances ?? [], ids);
  return {
    page: { ...data.page, name },
    status: scopedStatus(components, incidents, maintenances),
    components,
    incidents,
    scheduled_maintenances: maintenances,
  };
}
