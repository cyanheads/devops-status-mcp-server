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
import type { HistoryRecord, HistoryWalk } from '@/services/statuspage/incident-history.js';
import { readIncidentHistory } from '@/services/statuspage/incident-history.js';
import type { StatuspageIncident } from '@/services/statuspage/types.js';
import type { ResolvedVendor } from '@/services/vendor-registry/vendor-registry-service.js';
import { getVendorRegistryService } from '@/services/vendor-registry/vendor-registry-service.js';
import { assertSafeUrl, ssrfRejectionMessage } from '@/utils/ssrf-guard.js';

/** How far back `since` may reach, which bounds the history pages one call reads. */
const SINCE_MAX_MONTHS = 24;

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

type IncidentSource = 'api' | 'history';

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
    source: 'api' as IncidentSource,
  };
}

type Incident = ReturnType<typeof normalizeIncident>;

/**
 * A history-archive record in the incident shape. The archive carries only the
 * title, impact, displayed span, and latest update message, so the fields it has
 * no counterpart for are null or empty rather than inferred. A record with no end
 * has no published lifecycle stage — it may be open, in progress, or cancelled —
 * so its status is `unknown`.
 */
function normalizeHistoryRecord(r: HistoryRecord, baseUrl: string): Incident {
  const status = r.end ? 'resolved' : 'unknown';
  return {
    id: r.code,
    name: r.name,
    impact: r.impact,
    status,
    created_at: r.start,
    started_at: null,
    resolved_at: r.end,
    scheduled_for: null,
    scheduled_until: null,
    duration_minutes: null,
    shortlink: `${baseUrl}/incidents/${r.code}`,
    affected_components: [],
    updates: [{ status, body: r.message, created_at: r.end ?? r.start }],
    source: 'history',
  };
}

/**
 * Scheduled maintenances, or none when the page serves no maintenance endpoint. A
 * 404 is tolerable only because the incidents fetch beside this one proves the base
 * URL is a real Statuspage — filter: 'scheduled' has no such proof and still errors.
 */
function fetchPublishedMaintenances(vendor: ResolvedVendor): Promise<StatuspageIncident[]> {
  return fetchVendorScheduledMaintenances(vendor).then(
    ({ data }) => data.scheduled_maintenances,
    (err: unknown) => {
      if (err instanceof McpError && (err.data as { status?: number } | undefined)?.status === 404)
        return [];
      throw err;
    },
  );
}

/** Incident statuses each non-scheduled filter keeps; null keeps every incident. */
const INCIDENT_STATUSES: Record<'all' | 'active' | 'resolved', readonly string[] | null> = {
  all: null,
  active: ['investigating', 'identified', 'monitoring'],
  resolved: ['resolved', 'postmortem'],
};

/** The earliest `since` accepted on the UTC date of `now`. */
function earliestSince(now: Date): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - SINCE_MAX_MONTHS, now.getUTCDate()),
  )
    .toISOString()
    .slice(0, 10);
}

type IncidentFilter = 'all' | 'active' | 'resolved' | 'scheduled';

/**
 * The filters that can return more than the one that just came back empty, rendered
 * for a guidance sentence, or null when none can. Recommending the filter the caller
 * passed, or one the backend can never satisfy, sends them back for a second empty result.
 *
 * `active`, `resolved`, and `scheduled` are disjoint, and `all` is their union, so only
 * the other disjoint filters this backend serves can hold anything new — and `all` adds
 * something only when one of them can. On a feed with no resolved history and no
 * maintenance windows, an empty `active` leaves nothing to offer. An empty `all` never
 * reaches here — it is answered on its own below, because every narrower filter is empty
 * by construction once `all` is.
 */
function alternativeFilters(history: BackendHistory, used: IncidentFilter): string | null {
  const disjoint: IncidentFilter[] = ['active'];
  if (history.resolved !== 'none') disjoint.push('resolved');
  if (history.scheduledMaintenance) disjoint.push('scheduled');
  const others = disjoint.filter((f) => f !== used);
  if (others.length === 0) return null;
  return ['all', ...others].map((f) => `"${f}"`).join(' or ');
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
  floor: { since: string; dropped: number } | null,
): string {
  if (matched > 0) {
    return (
      `offset ${offset} is past the end of this result: filter "${filter}" matched ${matched} ` +
      `incident${matched === 1 ? '' : 's'} for ${name}, so the valid offsets are 0–${matched - 1}. ` +
      'Call again with a lower offset.'
    );
  }
  if (floor && floor.dropped > 0) {
    return (
      `No incidents matching filter "${filter}" for ${name} started on or after ${floor.since}; ` +
      `${floor.dropped} older match${floor.dropped === 1 ? ' was' : 'es were'} left out by since. ` +
      'Pass an earlier since, or omit it for the most recent incidents regardless of date.'
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
  if (alternatives === null) {
    // `active` is always servable, so only an empty `active` can leave nothing to offer.
    return (
      `${name} currently lists no open incidents. Its status feed publishes only currently-open ` +
      'events and keeps no resolved history or maintenance windows, so no other filter can ' +
      `return more. See ${url} to confirm on the vendor's own status page.`
    );
  }
  if (filter === 'resolved' && history.resolved === 'none') {
    return (
      `${name} publishes currently-open events with no resolution lifecycle, so ` +
      `filter: "resolved" can never return incidents for it. Try filter: ${alternatives}.`
    );
  }
  if (filter === 'resolved' && history.resolved === 'current') {
    return (
      `${name} publishes only the incidents its status page currently lists, and it lists no ` +
      `resolved one now; older resolved history is not retrievable from it. Try filter: ${alternatives}.`
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

/**
 * State how far the history archive was read when it stopped short of `since`, so
 * the result is not taken as complete back to that date.
 */
function historyGapGuidance(name: string, since: string, walk: HistoryWalk): string {
  return walk.readBackTo === null
    ? `The ${name} history archive could not be read: ${walk.gap}. Incidents between ` +
        `${since} and the oldest one the status API returned may be missing.`
    : `The ${name} history archive was read back to ${walk.readBackTo}, not to ${since}: ` +
        `${walk.gap}. Incidents between those two dates may be missing.`;
}

export const devopsGetIncidents = tool('devops_get_incidents', {
  description:
    'Fetch incident history and scheduled maintenance windows for a vendor. Returns full incident timeline — each investigator update, affected components, and resolution. Filter by status to focus on active incidents (use before deploy), resolved history (for postmortem), or upcoming maintenance windows. Page through long histories with limit + offset — a truncated result discloses the total and returns the value to page with in nextOffset. Some vendor feeds cap their own history: when upstreamCeiling is present the vendor API returned everything it will serve, and older incidents are not reachable at a higher offset. On Atlassian Statuspage vendors, since (a date up to 24 months back) also reads the status page\'s quarterly history archive back to that date where the page publishes one; those records are marked source: "history" and carry the title, impact, start and end times, and final update message only. An empty result, or a history read that stopped short of since, explains itself in notice.',
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
        'all: incidents plus scheduled maintenances. active: only incidents with status investigating/identified/monitoring. resolved: only fully resolved incidents. scheduled: only scheduled maintenance windows. Not every vendor backend serves every filter — "aws" lists a resolved event only until it drops off its feed, "azure" lists open items only (never resolved), and "aws", "azure", "gcp", and "slack" publish no maintenance windows. An empty result names which case applied.',
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
    since: z
      .union([
        z.literal(''),
        z.iso
          .date()
          .describe('Earliest start date to include, as YYYY-MM-DD (UTC), e.g. "2025-10-01".'),
      ])
      .optional()
      .describe(
        'Earliest start date to include, as YYYY-MM-DD (UTC), at most 24 months back. Accepted with filter "all" or "resolved". Incidents that started before it are left out, and limit/offset page the rest. On Atlassian Statuspage vendors it also reads the status page\'s quarterly history archive back to this date, reaching incidents older than the 50 the status API serves. Omit to read only the status API.',
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
                'Current status: investigating | identified | monitoring | resolved | postmortem | scheduled | in_progress | completed | unknown. unknown marks a history-archive record with no end time, whose lifecycle stage the archive does not publish.',
              ),
            created_at: z
              .string()
              .describe(
                'ISO 8601 timestamp when the incident was created, carrying the UTC offset the vendor published (Z, +00:00, or a local offset such as -07:00). For a history-archive record, the start time its status page displays, to the minute, in UTC.',
              ),
            started_at: z
              .string()
              .nullish()
              .describe(
                "ISO 8601 timestamp, with the vendor's UTC offset, when the incident started, or null/absent if not set by the vendor.",
              ),
            resolved_at: z
              .string()
              .nullable()
              .describe(
                "ISO 8601 timestamp, with the vendor's UTC offset, when resolved, or null if still active. For a history-archive record, to the minute, in UTC.",
              ),
            scheduled_for: z
              .string()
              .nullable()
              .describe(
                "Present for scheduled maintenances — ISO 8601 start time with the vendor's UTC offset.",
              ),
            scheduled_until: z
              .string()
              .nullable()
              .describe(
                "Present for scheduled maintenances — ISO 8601 end time with the vendor's UTC offset.",
              ),
            duration_minutes: z
              .number()
              .nullable()
              .describe(
                'Minutes from started_at to resolved_at. Null for active or scheduled incidents, or when the vendor-authored timestamps are missing, invalid, or inverted.',
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
                    created_at: z
                      .string()
                      .describe("ISO 8601 timestamp of this update, with the vendor's UTC offset."),
                  })
                  .describe('A single status update from the vendor.'),
              )
              .describe(
                'Chronological list of incident updates (oldest first). A history-archive record carries only its final update, dated at its end time (or its start when it has none).',
              ),
            source: z
              .enum(['api', 'history'])
              .describe(
                "Where this record came from. api: the vendor's status API, with the full update timeline and affected components. history: the status page's quarterly history archive, read only when since is set — title, impact, start and end times, and the final update message, with no components and no started_at, scheduled window, or duration.",
              ),
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
        "Maximum incidents the vendor's own status API serves in one fetch, present only when that ceiling was reached on this call. It bounds the history independently of limit and offset: incidents older than the oldest one returned cannot be fetched at any offset. On Atlassian Statuspage vendors, since reads past it from the page's history archive. Absent when the vendor feed is unbounded, returned less than its ceiling, or since was set and the history archive was read back to it.",
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Plain-language explanation of this result — how to page onward, why it came back empty (the vendor currently publishes nothing at all, a filter the backend cannot satisfy, an offset past the end, or a since date that left everything out), that the vendor feed capped the history, or how far the history archive was read when it stopped short of since. Absent when the result needs no explanation.',
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
      reason: 'invalid_since',
      code: JsonRpcErrorCode.ValidationError,
      when: 'since was passed with filter "active" or "scheduled", or is more than 24 months back.',
      recovery:
        'Pass since as a YYYY-MM-DD date within the last 24 months, with filter "all" or "resolved".',
    },
    {
      reason: 'statuspage_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: "The vendor's status API returned an error or timed out.",
      recovery: 'Retry after 30s. If it persists, check the status page URL in a browser.',
      retryable: true,
      // Raised below the handler: every transport failure in the shared cached-fetch
      // helper leaves as a ServiceUnavailable carrying this reason.
      thrownBy: 'service',
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
        const blocked = ssrfRejectionMessage(err);
        if (blocked === null) throw err;
        throw ctx.fail('target_blocked', blocked, { ...ctx.recoveryFor('target_blocked') });
      }
    }

    const history = backendHistory(resolved.api_type);
    // Form clients send an optional field they left blank as "", which means unset.
    const since = input.since || undefined;
    if (since !== undefined) {
      if (input.filter === 'active' || input.filter === 'scheduled') {
        throw ctx.fail(
          'invalid_since',
          `since reads incident history, so it accepts filter "all" or "resolved", not "${input.filter}".`,
          { ...ctx.recoveryFor('invalid_since') },
        );
      }
      const earliest = earliestSince(new Date());
      if (since < earliest) {
        throw ctx.fail(
          'invalid_since',
          `since ${since} is more than ${SINCE_MAX_MONTHS} months back; the earliest date accepted today is ${earliest}.`,
          { ...ctx.recoveryFor('invalid_since') },
        );
      }
    }
    const floorMs = since === undefined ? null : Date.parse(`${since}T00:00:00Z`);
    const readsHistory = floorMs !== null && history.historyPages;

    let incidents: Incident[] = [];
    /**
     * Records the vendor's incident feed returned before this tool filtered them —
     * the only number that reveals whether the feed hit its own ceiling. Null when
     * the incident feed was not fetched at all (filter: 'scheduled').
     */
    let upstreamIncidentCount: number | null = null;
    let walk: HistoryWalk | null = null;

    if (input.filter === 'scheduled') {
      const { data } = await fetchVendorScheduledMaintenances(resolved);
      incidents = data.scheduled_maintenances.map((i) => normalizeIncident(i, true));
    } else {
      /**
       * The maintenance list is part of an `all` result, where a failed read fails the
       * call as it does without since. With history it is also half of what a history
       * record must be absent from to be added; under `resolved` that is its only use,
       * so there a failed read costs the archive, never the v2 result.
       */
      const [{ data }, maintenances] = await Promise.all([
        fetchVendorIncidents(resolved),
        input.filter === 'all' || readsHistory
          ? fetchPublishedMaintenances(resolved).catch((err: unknown) => {
              if (input.filter === 'all') throw err;
              return err as Error;
            })
          : [],
      ]);
      const published = maintenances instanceof Error ? [] : maintenances;
      upstreamIncidentCount = data.incidents.length;
      const statuses = INCIDENT_STATUSES[input.filter];
      incidents = data.incidents
        .filter((i) => statuses === null || statuses.includes(i.status))
        .map((i) => normalizeIncident(i, false));
      if (input.filter === 'all') {
        incidents.push(...published.map((i) => normalizeIncident(i, true)));
      }

      if (readsHistory) {
        walk =
          maintenances instanceof Error
            ? {
                records: [],
                reachedFloor: false,
                readBackTo: null,
                gap: `its records are matched against the scheduled-maintenances list, which failed: ${maintenances.message}`,
              }
            : await readIncidentHistory(resolved.url, data.page.time_zone, floorMs);
        // v2 wins: a history record joins on `code` = v2 `id` and is added only when
        // neither v2 list carries it.
        const known = new Set([...data.incidents, ...published].map((i) => i.id));
        for (const record of walk.records) {
          if (known.has(record.code)) continue;
          known.add(record.code);
          const incident = normalizeHistoryRecord(record, resolved.url);
          if (input.filter === 'all' || incident.status === 'resolved') incidents.push(incident);
        }
      }
      if (input.filter === 'all' || walk !== null) {
        incidents.sort(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
        );
      }
    }

    // Floor on each record's start: a maintenance window created before `since` but
    // scheduled after it is still inside the range asked for.
    let floorDropped = 0;
    if (floorMs !== null) {
      const matched = incidents.length;
      incidents = incidents.filter(
        (i) => new Date(i.scheduled_for ?? i.created_at).getTime() >= floorMs,
      );
      floorDropped = matched - incidents.length;
    }

    const windowed = incidents.slice(input.offset, input.offset + input.limit);
    const nextOffset = input.offset + windowed.length;
    const truncated = nextOffset < incidents.length;

    /**
     * The ceiling the vendor's own feed imposed on this call, or null when it has
     * none or returned less than it. A reached ceiling is a different bound from
     * truncation: paging cannot get past it, so it is disclosed on its own. History
     * read back to `since` lifts it for this call.
     */
    const upstreamCeiling =
      history.incidentCeiling !== null &&
      upstreamIncidentCount !== null &&
      upstreamIncidentCount >= history.incidentCeiling &&
      !walk?.reachedFloor
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
          since === undefined ? null : { since, dropped: floorDropped },
        ),
      );
    }
    if (upstreamCeiling !== null) {
      ctx.enrich({ upstreamCeiling });
      notices.push(upstreamCeilingGuidance(upstreamCeiling, resolved.url));
    }
    if (since !== undefined && walk?.gap) {
      notices.push(historyGapGuidance(resolved.name, since, walk));
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
      ...(since === undefined ? {} : { since, historyGap: walk?.gap ?? null }),
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
        `**Impact:** ${inc.impact} | **Status:** ${inc.status} | **Source:** ${inc.source} | **Created:** ${inc.created_at}${inc.started_at ? ` | **Started:** ${inc.started_at}` : ''}`,
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
