/**
 * @fileoverview Tool to fetch incident history and scheduled maintenance windows for a vendor.
 * @module mcp-server/tools/definitions/devops-get-incidents.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { BackendHistory } from '@/services/status-adapters/status-dispatch.js';
import {
  backendHistory,
  fetchVendorIncidents,
  fetchVendorScheduledMaintenances,
} from '@/services/status-adapters/status-dispatch.js';
import type { StatuspageIncident } from '@/services/statuspage/types.js';
import { getVendorRegistryService } from '@/services/vendor-registry/vendor-registry-service.js';
import { assertSafeUrl } from '@/utils/ssrf-guard.js';

function durationMinutes(
  startedAt: string | null | undefined,
  resolvedAt: string | null,
): number | null {
  if (!startedAt || !resolvedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = new Date(resolvedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  // Statuspage data is vendor-authored — inverted timestamps (resolved_at before
  // started_at) occur in the wild and would yield a nonsense negative duration.
  if (end < start) return null;
  return Math.round((end - start) / 60_000);
}

function normalizeIncident(i: StatuspageIncident, isScheduled: boolean) {
  const updates = [...i.incident_updates].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );

  const affectedComponents = [
    ...new Set(i.incident_updates.flatMap((u) => (u.affected_components ?? []).map((c) => c.name))),
  ];

  return {
    id: i.id,
    name: i.name,
    impact: (isScheduled ? 'maintenance' : i.impact) as
      | 'none'
      | 'minor'
      | 'major'
      | 'critical'
      | 'maintenance',
    status: i.status,
    created_at: i.created_at,
    started_at: i.started_at ?? null,
    resolved_at: i.resolved_at ?? null,
    scheduled_for: i.scheduled_for ?? null,
    scheduled_until: i.scheduled_until ?? null,
    duration_minutes: durationMinutes(i.started_at, i.resolved_at),
    shortlink: i.shortlink ?? null,
    affected_components: affectedComponents,
    updates: updates.map((u) => ({
      status: u.status,
      body: u.body,
      created_at: u.created_at,
    })),
  };
}

type IncidentFilter = 'all' | 'active' | 'resolved' | 'scheduled';

/**
 * The filters this backend can actually serve, minus the one just used, rendered
 * for a guidance sentence. Recommending the filter the caller passed, or one the
 * backend can never satisfy, sends them back for a second empty result.
 *
 * Every branch that renders this string passes `active`, `resolved`, or `scheduled`,
 * and those three are disjoint, so nothing offered here is a subset of the filter that
 * just came back empty. An empty `all` never reaches it — it is answered on its own
 * below, because every narrower filter is empty by construction once `all` is.
 */
function alternativeFilters(history: BackendHistory, used: IncidentFilter): string {
  const servable: IncidentFilter[] = ['all', 'active'];
  if (history.resolved !== 'none') servable.push('resolved');
  if (history.scheduledMaintenance) servable.push('scheduled');
  return servable
    .filter((f) => f !== used)
    .map((f) => `"${f}"`)
    .join(' or ');
}

/**
 * Why this call returned nothing, in terms of what the caller asked for and what
 * the vendor's backend can serve. `matched` counts the incidents the filter matched
 * before offset/limit windowing, so a positive value means the offset overshot them.
 */
function emptyResultGuidance(
  name: string,
  filter: IncidentFilter,
  offset: number,
  matched: number,
  history: BackendHistory,
  url: string,
): string {
  if (matched > 0) {
    return (
      `offset ${offset} is past the end of this result: filter "${filter}" matched ${matched} ` +
      `incident${matched === 1 ? '' : 's'} for ${name}, so the valid offsets are 0–${matched - 1}. ` +
      'Call again with a lower offset.'
    );
  }
  if (filter === 'all') {
    /**
     * "all" spans every event the vendor's feed publishes, so the narrower filters are
     * empty by construction — naming one here would send the caller back for another
     * empty result. The vendor's own page is the only place left to look.
     */
    return (
      `${name} currently lists no incidents and no maintenance windows at all. Filter "all" ` +
      'already spans everything its status feed publishes, so the narrower filters have ' +
      `nothing to return either. See ${url} to confirm on the vendor's own status page.`
    );
  }

  const alternatives = alternativeFilters(history, filter);
  if (filter === 'resolved' && history.resolved === 'none') {
    return (
      `${name} publishes currently-open events with no resolution lifecycle, so ` +
      `filter: "resolved" can never return incidents for it. Try filter: ${alternatives}.`
    );
  }
  if (filter === 'resolved' && history.resolved === 'current') {
    return (
      `${name} publishes only the incidents its status page currently lists, so resolved ` +
      `history is not retrievable from it. Try filter: ${alternatives}.`
    );
  }
  if (filter === 'scheduled' && !history.scheduledMaintenance) {
    return (
      `${name} publishes no scheduled-maintenance feed, so filter: "scheduled" is always ` +
      `empty for it. Try filter: ${alternatives}.`
    );
  }
  return `No incidents matched filter "${filter}" for ${name}. Try filter: ${alternatives}.`;
}

/**
 * State that the vendor's own feed, not this tool's window, bounded the history.
 * The omitted incidents are unreachable at any offset, so the only path to them
 * is the vendor's status page.
 */
function upstreamCeilingGuidance(ceiling: number, url: string): string {
  return (
    `The vendor's status API returns at most ${ceiling} incidents per fetch and offers no ` +
    'pagination, so incidents older than the oldest one it returned are not reachable through ' +
    `this tool at any offset. See ${url} for the older history.`
  );
}

export const devopsGetIncidents = tool('devops_get_incidents', {
  description:
    'Fetch incident history and scheduled maintenance windows for a vendor. ' +
    'Returns full incident timeline — each investigator update, affected components, and resolution. ' +
    'Filter by status to focus on active incidents (use before deploy), resolved history (for postmortem), or upcoming maintenance windows. ' +
    'Page through long histories with limit + offset — a truncated result discloses the total and returns the value to page with in nextOffset. ' +
    'Some vendor feeds cap their own history: when upstreamCeiling is present the vendor API returned everything it will serve, and older incidents ' +
    'are reachable only on the vendor status page, not at a higher offset. An empty result explains itself in notice.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    vendor: z
      .string()
      .min(1)
      .describe(
        'Vendor slug (e.g., "github", "aws") or raw Atlassian Statuspage base URL. Use devops_list_vendors to find slugs.',
      ),
    filter: z
      .enum(['all', 'active', 'resolved', 'scheduled'])
      .default('all')
      .describe(
        'all: incidents plus scheduled maintenances. active: only incidents with status investigating/identified/monitoring. resolved: only fully resolved incidents. scheduled: only scheduled maintenance windows. ' +
          'Not every vendor backend serves every filter — "aws" publishes currently-open events only (never resolved, no maintenance windows), and "gcp" and "slack" publish no maintenance windows. An empty result names which case applied.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(20)
      .describe(
        'Maximum incidents to return per call (1–50). Page through longer history with offset rather than raising this.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Number of matching incidents to skip before applying limit, for paging through history. 0 (default) returns the most recent page; a truncated result returns the value to use next in the nextOffset field. Raising offset past the number of matches returns an empty list and says so.',
      ),
  }),

  output: z.object({
    vendor: z.string().describe('Vendor slug or URL as provided.'),
    name: z.string().describe('Display name of the vendor.'),
    incidents: z
      .array(
        z
          .object({
            id: z.string().describe("Unique incident identifier from the vendor's status API."),
            name: z.string().describe('Incident title.'),
            impact: z
              .enum(['none', 'minor', 'major', 'critical', 'maintenance'])
              .describe(
                'Severity level: none = informational, minor = degraded performance, major = partial outage, critical = full outage, maintenance = scheduled window.',
              ),
            status: z
              .string()
              .describe(
                'Current status: investigating | identified | monitoring | resolved | postmortem | scheduled | in_progress | completed.',
              ),
            created_at: z
              .string()
              .describe('ISO 8601 UTC timestamp when the incident was created.'),
            started_at: z
              .string()
              .nullish()
              .describe(
                'ISO 8601 UTC timestamp when the incident started, or null/absent if not set by the vendor.',
              ),
            resolved_at: z
              .string()
              .nullable()
              .describe('ISO 8601 UTC timestamp when resolved, or null if still active.'),
            scheduled_for: z
              .string()
              .nullable()
              .describe('Present for scheduled maintenances — ISO 8601 UTC start time.'),
            scheduled_until: z
              .string()
              .nullable()
              .describe('Present for scheduled maintenances — ISO 8601 UTC end time.'),
            duration_minutes: z
              .number()
              .nullable()
              .describe(
                'Minutes from started_at to resolved_at. Null for active or scheduled incidents, ' +
                  'or when the vendor-authored timestamps are missing, invalid, or inverted.',
              ),
            shortlink: z
              .string()
              .nullish()
              .describe(
                'Direct URL to the incident page, or null/absent if not provided by the vendor.',
              ),
            affected_components: z
              .array(z.string())
              .describe('Component names affected by this incident.'),
            updates: z
              .array(
                z
                  .object({
                    status: z.string().describe('Incident status at the time of this update.'),
                    body: z.string().describe('Update text from the vendor.'),
                    created_at: z.string().describe('ISO 8601 UTC timestamp of this update.'),
                  })
                  .describe('A single status update from the vendor.'),
              )
              .describe('Chronological list of incident updates (oldest first).'),
          })
          .describe('An incident or scheduled maintenance entry.'),
      )
      .describe('Matching incidents.'),
    total_returned: z.number().describe('Number of incidents in the response.'),
    statuspage_url: z.string().describe('Status page base URL used.'),
  }),

  enrichment: {
    // Each field is written only on the path that produces it — a truncated page, an
    // empty result, or a vendor feed that hit its own ceiling — so all are optional
    // and a plain result passes the effective-output parse with none of them set.
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when more incidents matched than the limit returned. Absent when the result was not capped.',
      ),
    shown: z
      .number()
      .optional()
      .describe(
        'Number of incidents returned after applying the limit. Present only when truncated.',
      ),
    cap: z.number().optional().describe('The limit that was applied. Present only when truncated.'),
    totalCount: z
      .number()
      .optional()
      .describe(
        'Total incidents matching the filter, across all pages, before offset/limit windowing. Present only when the result was truncated.',
      ),
    nextOffset: z
      .number()
      .optional()
      .describe(
        'The offset to pass on the next call to continue from where this page stopped, already computed as offset + the number returned. Present only when truncated — its absence means this page reached the end of what the filter matched.',
      ),
    upstreamCeiling: z
      .number()
      .optional()
      .describe(
        "Maximum incidents the vendor's own status API serves in one fetch, present only when that ceiling was reached on this call. It bounds the history independently of limit and offset: incidents older than the oldest one returned cannot be fetched at any offset, only browsed on the vendor status page. Absent when the vendor feed is unbounded or returned less than its ceiling.",
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Plain-language explanation of this result — how to page onward, why it came back empty (the vendor currently publishes nothing at all, a filter the backend cannot satisfy, or an offset past the end), or that the vendor feed capped the history. Absent when the result needs no explanation.',
      ),
  },

  errors: [
    {
      reason: 'vendor_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Vendor slug not in registry and input is not a valid URL.',
      recovery: 'Call devops_list_vendors to browse slugs or pass the full Statuspage base URL.',
    },
    {
      reason: 'target_blocked',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A raw URL resolves to a private, loopback, or cloud-metadata address.',
      recovery:
        'Pass a publicly routable Statuspage URL. If internal monitoring is intentional, set DEVOPS_STATUS_ALLOW_PRIVATE_TARGETS=true.',
    },
    {
      reason: 'statuspage_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: "The vendor's status API returned an error or timed out.",
      recovery: 'Retry after 30s. If it persists, check the status page URL in a browser.',
      retryable: true,
    },
  ],

  async handler(input, ctx) {
    const registry = getVendorRegistryService();

    const resolved = registry.resolve(input.vendor);
    if (!resolved) {
      throw ctx.fail(
        'vendor_not_found',
        `"${input.vendor}" is not a known vendor slug and is not a valid URL.`,
        { ...ctx.recoveryFor('vendor_not_found') },
      );
    }

    // SSRF guard: only raw URL inputs need checking — registry entries are pre-verified public URLs.
    if (resolved.slug === null) {
      try {
        await assertSafeUrl(resolved.url);
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.startsWith('SSRF_BLOCKED')) {
          throw ctx.fail('target_blocked', msg.replace('SSRF_BLOCKED: ', ''), {
            ...ctx.recoveryFor('target_blocked'),
          });
        }
        throw err;
      }
    }

    let incidents: ReturnType<typeof normalizeIncident>[] = [];
    /**
     * Records the vendor's incident feed returned before this tool filtered them —
     * the only number that reveals whether the feed hit its own ceiling. Null when
     * the incident feed was not fetched at all (filter: 'scheduled').
     */
    let upstreamIncidentCount: number | null = null;

    if (input.filter === 'scheduled') {
      const { data } = await fetchVendorScheduledMaintenances(resolved);
      incidents = data.scheduled_maintenances.map((i) => normalizeIncident(i, true));
    } else if (input.filter === 'active') {
      const { data } = await fetchVendorIncidents(resolved);
      upstreamIncidentCount = data.incidents.length;
      incidents = data.incidents
        .filter((i) => ['investigating', 'identified', 'monitoring'].includes(i.status))
        .map((i) => normalizeIncident(i, false));
    } else if (input.filter === 'resolved') {
      const { data } = await fetchVendorIncidents(resolved);
      upstreamIncidentCount = data.incidents.length;
      incidents = data.incidents
        .filter((i) => ['resolved', 'postmortem'].includes(i.status))
        .map((i) => normalizeIncident(i, false));
    } else {
      // all
      const [incData, mainData] = await Promise.all([
        fetchVendorIncidents(resolved),
        // Some pages serve no scheduled-maintenances endpoint at all. A 404 here is
        // tolerable only because the incidents fetch above proves the base URL is a
        // real Statuspage — filter:'scheduled' has no such proof and still errors.
        fetchVendorScheduledMaintenances(resolved).catch((err: unknown) => {
          if (
            err instanceof McpError &&
            (err.data as { status?: number } | undefined)?.status === 404
          )
            return { data: { scheduled_maintenances: [] } };
          throw err;
        }),
      ]);
      upstreamIncidentCount = incData.data.incidents.length;
      const inc = incData.data.incidents.map((i) => normalizeIncident(i, false));
      const maint = mainData.data.scheduled_maintenances.map((i) => normalizeIncident(i, true));
      incidents = [...inc, ...maint].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
    }

    const history = backendHistory(resolved.api_type);
    const windowed = incidents.slice(input.offset, input.offset + input.limit);
    const nextOffset = input.offset + windowed.length;
    const truncated = nextOffset < incidents.length;

    /**
     * The ceiling the vendor's own feed imposed on this call, or null when it has
     * none or returned less than it. A reached ceiling is a different bound from
     * truncation: paging cannot get past it, so it is disclosed on its own.
     */
    const upstreamCeiling =
      history.incidentCeiling !== null &&
      upstreamIncidentCount !== null &&
      upstreamIncidentCount >= history.incidentCeiling
        ? history.incidentCeiling
        : null;

    // `notice` is last-wins across every enrich call, so the reasons compose into
    // one string rather than overwriting each other.
    const notices: string[] = [];
    if (truncated) {
      notices.push(
        `Showing incidents ${input.offset + 1}–${nextOffset} of ${incidents.length}. ` +
          `Call again with offset: ${nextOffset} for the next page, or filter by status to narrow.`,
      );
    } else if (windowed.length === 0) {
      notices.push(
        emptyResultGuidance(
          resolved.name,
          input.filter,
          input.offset,
          incidents.length,
          history,
          resolved.url,
        ),
      );
    }
    if (upstreamCeiling !== null) {
      ctx.enrich({ upstreamCeiling });
      notices.push(upstreamCeilingGuidance(upstreamCeiling, resolved.url));
    }

    if (truncated) {
      // More history exists beyond this window. Disclose the true total and the
      // next offset as a value — raising limit alone can't reach older incidents.
      ctx.enrich.total(incidents.length);
      ctx.enrich({ nextOffset });
      ctx.enrich.truncated({
        shown: windowed.length,
        cap: input.limit,
        guidance: notices.join(' '),
      });
    } else if (notices.length > 0) {
      ctx.enrich.notice(notices.join(' '));
    }

    ctx.log.info('Incidents fetched', {
      vendor: input.vendor,
      filter: input.filter,
      offset: input.offset,
      count: windowed.length,
    });

    return {
      vendor: input.vendor,
      name: resolved.name,
      incidents: windowed,
      total_returned: windowed.length,
      statuspage_url: resolved.url,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## ${result.name} (${result.vendor}) — ${result.total_returned} incidents`,
      `**URL:** ${result.statuspage_url}`,
      '',
    ];
    if (result.total_returned === 0) {
      // What to do next depends on the filter, the offset, and what the vendor's
      // backend can serve — none of which reach format(). The handler writes that
      // guidance to the `notice` enrichment field, which the framework renders into
      // this same content[] block as a trailer, so naming a filter here would be a
      // guess that contradicts it.
      lines.push('No incidents matched this filter.');
      return [{ type: 'text', text: lines.join('\n') }];
    }
    for (const inc of result.incidents) {
      const icon =
        inc.status === 'resolved' || inc.status === 'completed'
          ? '✅'
          : inc.impact === 'critical'
            ? '🔴'
            : '⚠️';
      lines.push(`### ${icon} ${inc.name} \`${inc.id}\``);
      lines.push(
        `**Impact:** ${inc.impact} | **Status:** ${inc.status} | **Created:** ${inc.created_at}${inc.started_at ? ` | **Started:** ${inc.started_at}` : ''}`,
      );
      if (inc.resolved_at) {
        const duration = inc.duration_minutes !== null ? ` (${inc.duration_minutes} min)` : '';
        lines.push(`**Resolved:** ${inc.resolved_at}${duration}`);
      }
      if (inc.scheduled_for)
        lines.push(`**Scheduled:** ${inc.scheduled_for} → ${inc.scheduled_until}`);
      if (inc.affected_components.length > 0) {
        lines.push(`**Components:** ${inc.affected_components.join(', ')}`);
      }
      lines.push(`**Updates (${inc.updates.length}):**`);
      for (const u of inc.updates) {
        lines.push(`- [${u.created_at}] ${u.status}: ${u.body}`);
      }
      if (inc.shortlink) lines.push(`[Incident page](${inc.shortlink})`);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
