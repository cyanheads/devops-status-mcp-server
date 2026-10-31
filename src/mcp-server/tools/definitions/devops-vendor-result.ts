/**
 * @fileoverview The vendor check shared by devops_status_check and devops_watch_stack —
 * input resolution, the per-vendor result schema and builder, the fan-out, and the
 * aggregate health buckets.
 * @module mcp-server/tools/definitions/devops-vendor-result
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { z } from '@cyanheads/mcp-ts-core';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { fetchVendorSummary } from '@/services/status-adapters/status-dispatch.js';
import type { StatuspageSummaryResponse } from '@/services/statuspage/types.js';
import type { ResolvedVendor } from '@/services/vendor-registry/vendor-registry-service.js';
import { getVendorRegistryService } from '@/services/vendor-registry/vendor-registry-service.js';
import { deferralNotice, splitBatch } from '@/utils/input-bounds.js';
import { assertSafeUrl, ssrfRejectionMessage } from '@/utils/ssrf-guard.js';
import { vendorInline, vendorQuote } from '@/utils/vendor-markdown.js';

/**
 * Render a settled-rejection as the per-vendor `error` string.
 *
 * `devops_status_check` and `devops_watch_stack` fetch every vendor under
 * `Promise.allSettled` so one bad vendor doesn't fail the batch, which means a
 * rejection is reported inline instead of thrown. Only `McpError` messages are
 * written for a caller to read — every transport failure arrives as one. Anything
 * else is a runtime fault whose message (`undefined is not an object (evaluating
 * 'data.components.filter')`) would put internal expression text on the wire.
 */
export function vendorErrorMessage(reason: unknown): string {
  if (reason instanceof McpError) return reason.message;
  return (
    'The vendor status API returned an unexpected response. ' +
    'Retry after 30s, or open the status page URL in a browser to check it directly.'
  );
}

/**
 * Components returned per vendor in detailed mode when the caller sets no limit.
 * Large pages publish hundreds (one vendor alone can exceed 400), which is a
 * six-figure-byte response across a full batch; callers who need more raise
 * `component_limit`, page with `component_offset`, or narrow with `component_filter`.
 */
export const DEFAULT_COMPONENT_LIMIT = 50;

/**
 * Highest `component_limit` applied. It bounds one call's response rather than any page's
 * size — some pages publish more — so a longer list is reached through `component_offset`.
 * A larger request is clamped to it rather than rejected.
 */
export const MAX_COMPONENT_LIMIT = 500;

/**
 * Vendors checked per call. Each one is its own upstream fetch, all in parallel, so the
 * entries past it are returned for the caller to resend rather than fetched.
 */
export const MAX_VENDORS_PER_CALL = 20;

/**
 * Longest vendors list accepted at all. Deferred entries are echoed back, so this bounds
 * the response; it sits above the registry's size, so a list of every slug is served in
 * part rather than rejected.
 */
export const MAX_VENDORS_INPUT = 100;

/** A vendors list split at {@link MAX_VENDORS_PER_CALL}, with the notice for the deferral. */
export type VendorBatch = {
  served: string[];
  deferred: string[];
  /** Present only when entries were deferred. */
  notice?: string;
};

/** Split a vendors list into the entries checked on this call and the ones to resend. */
export function splitVendors(vendors: readonly string[]): VendorBatch {
  const { served, deferred } = splitBatch(vendors, MAX_VENDORS_PER_CALL);
  if (deferred.length === 0) return { served, deferred };
  return {
    served,
    deferred,
    notice: deferralNotice({
      cap: MAX_VENDORS_PER_CALL,
      deferredCount: deferred.length,
      field: 'deferred_vendors',
      noun: 'vendors',
      verb: 'checked',
    }),
  };
}

/**
 * The sentence naming deferred entries in a message about the checked ones, e.g.
 * " 1 more past the first 20 was not checked: github." Empty when nothing was deferred.
 */
export function deferredVendorsSentence(deferred: readonly string[]): string {
  if (deferred.length === 0) return '';
  const verb = deferred.length === 1 ? 'was' : 'were';
  return ` ${deferred.length} more past the first ${MAX_VENDORS_PER_CALL} ${verb} not checked: ${deferred.join(', ')}.`;
}

/** The `deferred_vendors` line for format(); empty when nothing was deferred. */
export function renderDeferredVendors(deferred: readonly string[]): string[] {
  if (deferred.length === 0) return [];
  return [`**Deferred (${deferred.length}, not checked):** ${deferred.join(', ')}`];
}

const COMPONENT_NAME_DESCRIPTION =
  'Component name as the status page publishes it — the leaf alone, without its group. Several leaves can share a name (one per region or product); group tells them apart.';

const COMPONENT_GROUP_DESCRIPTION =
  'Name of the group the status page files this component under — typically the product or region it belongs to — or null when it is not in a group.';

/** Per-vendor result schema shared by devops_status_check and devops_watch_stack. */
export const VendorResultSchema = z
  .object({
    vendor: z.string().describe('Vendor slug or URL as provided.'),
    name: z.string().describe('Display name of the vendor.'),
    indicator: z
      .enum(['none', 'minor', 'major', 'critical', 'maintenance'])
      .describe(
        "Overall health indicator, as the vendor published it: none = no degradation reported, minor = some degradation, major = significant outage, critical = complete outage, maintenance = scheduled window in progress, planned rather than a fault. A page can rate it from component statuses alone, so it can read none or maintenance while active_incidents lists an open incident rated minor or worse; summary, and devops_watch_stack's health, rate the vendor by the worse of the two.",
      ),
    description: z
      .string()
      .describe('Human-readable status description (e.g., "All Systems Operational").'),
    degraded_components: z
      .array(
        z
          .object({
            name: z.string().describe(COMPONENT_NAME_DESCRIPTION),
            group: z.string().nullable().describe(COMPONENT_GROUP_DESCRIPTION),
            status: z
              .enum(['degraded_performance', 'partial_outage', 'major_outage', 'under_maintenance'])
              .describe(
                'Degradation level: degraded_performance = slow/intermittent, partial_outage = some requests failing, major_outage = most requests failing, under_maintenance = scheduled maintenance in progress.',
              ),
          })
          .describe('A degraded component entry.'),
      )
      .describe(
        'Every component not in an operational state, uncapped — a vendor with a large edge-node fleet routinely publishes dozens. Includes in-progress maintenance windows (status under_maintenance) alongside genuine outages; read status to tell a planned window from a fault. Empty when all clear.',
      ),
    active_incidents: z
      .array(
        z
          .object({
            id: z.string().describe("Unique incident identifier from the vendor's status API."),
            name: z.string().describe('Incident title.'),
            impact: z
              .enum(['none', 'minor', 'major', 'critical', 'maintenance'])
              .describe(
                'Severity level: none = informational, minor = degraded performance, major = partial outage, critical = full outage, maintenance = scheduled window folded into incident history.',
              ),
            status: z
              .string()
              .describe('Current incident status (e.g., investigating, monitoring, resolved).'),
            started_at: z
              .string()
              .nullish()
              .describe(
                "ISO 8601 timestamp, with the vendor's UTC offset (Z, +00:00, or a local offset such as -07:00), when the incident started, or null/absent if not set by the vendor.",
              ),
            latest_update: z
              .string()
              .describe(
                'Most recent update text, as plain text: HTML markup the vendor published is converted, and any other < is text the vendor wrote.',
              ),
          })
          .describe('An active incident entry.'),
      )
      .describe('Active (non-resolved) incidents.'),
    scheduled_maintenances: z
      .array(
        z
          .object({
            name: z.string().describe('Maintenance window name.'),
            scheduled_for: z
              .string()
              .describe("ISO 8601 start time, with the vendor's UTC offset."),
            scheduled_until: z
              .string()
              .nullable()
              .describe(
                "ISO 8601 end time, with the vendor's UTC offset, or null when the vendor's feed publishes no planned end.",
              ),
            status: z.string().describe('Maintenance status (scheduled, in_progress, completed).'),
          })
          .describe('A scheduled maintenance entry.'),
      )
      .optional()
      .describe('Upcoming or in-progress maintenance windows. Present in detailed mode only.'),
    all_components: z
      .array(
        z
          .object({
            name: z.string().describe(COMPONENT_NAME_DESCRIPTION),
            group: z.string().nullable().describe(COMPONENT_GROUP_DESCRIPTION),
            status: z.string().describe('Component operational status.'),
            description: z
              .string()
              .nullable()
              .describe('Component description, or null if not provided.'),
          })
          .describe('A component entry.'),
      )
      .optional()
      .describe(
        'Components including operational ones, narrowed by component_filter (matched against name and group) when given, starting at component_offset (devops_status_check only; the first component otherwise), and at most component_limit per vendor. Present in detailed mode only.',
      ),
    all_components_total: z
      .number()
      .optional()
      .describe(
        'Components matching component_filter for this vendor, before component_offset and component_limit — the length of the whole list all_components is a page of. Present in detailed mode only.',
      ),
    next_component_offset: z
      .number()
      .int()
      .optional()
      .describe(
        'Where this vendor\'s component list continues. Present in detailed mode only, and only when components remain past the returned page: pass it as component_offset to devops_status_check, with this vendor, mode "detailed", and the same component_filter. Absent on the last page.',
      ),
    cached: z
      .boolean()
      .describe(
        'True when this result was served from the in-memory status cache, shared across callers (60 s TTL by default), so its data can be up to that TTL older than checked_at.',
      ),
    checked_at: z
      .string()
      .describe(
        'ISO 8601 UTC timestamp of this check — when this result was built, not when the status data was fetched; see cached.',
      ),
    statuspage_url: z.string().describe('Status page base URL used for this vendor.'),
    error: z
      .string()
      .optional()
      .describe(
        'Why this vendor could not be checked — unreachable status API, timeout, non-2xx, or a response that is not a Statuspage payload. Reported here rather than thrown so one bad vendor does not fail the batch. Absent when the vendor was fetched successfully.',
      ),
  })
  .describe('Status result for a single vendor.');

export type VendorResult = z.infer<typeof VendorResultSchema>;

type DegradedStatus = VendorResult['degraded_components'][number]['status'];

/**
 * Degraded statuses in the order they are rendered — worst first, with the scheduled
 * window last. `under_maintenance` is a planned window rather than a fault, so it is
 * grouped and marked separately instead of reading as one more outage in the list.
 */
const DEGRADED_STATUS_ORDER = [
  'major_outage',
  'partial_outage',
  'degraded_performance',
  'under_maintenance',
] as const satisfies readonly DegradedStatus[];

const DEGRADED_STATUS_MARKER: Record<DegradedStatus, string> = {
  major_outage: '🔴',
  partial_outage: '⚠️',
  degraded_performance: '⚠️',
  under_maintenance: '🛠️',
};

/**
 * A component as one string — `Group / Leaf`, or the leaf alone when ungrouped — for the
 * surfaces with no separate group field: content[] lines and the devops_suggest_action
 * pre-fill and its reason. Never parsed back: `/` also occurs inside real component names.
 */
function qualifiedName(c: { name: string; group: string | null }): string {
  return c.group === null ? c.name : `${c.group} / ${c.name}`;
}

/**
 * Render the degraded-component block: a count-led headline with the per-status
 * breakdown, then every component on its own line under its status.
 *
 * Nothing is capped. A vendor with a large edge-node fleet publishes dozens of
 * non-operational components and those are the signal this tool exists to surface —
 * dropping any of them would hide an outage. The list is grouped and counted so a
 * long one stays readable rather than shortened.
 */
function renderDegradedComponents(components: VendorResult['degraded_components']): string[] {
  const grouped = DEGRADED_STATUS_ORDER.map(
    (status) => [status, components.filter((c) => c.status === status).map(qualifiedName)] as const,
  ).filter(([, names]) => names.length > 0);

  const lines = [
    `**Degraded (${components.length}):** ${grouped.map(([status, names]) => `${names.length} ${status}`).join(', ')}`,
  ];
  for (const [status, names] of grouped) {
    lines.push(
      `**${status} (${names.length})${status === 'under_maintenance' ? ' — scheduled window, not an outage' : ''}:**`,
    );
    for (const name of names)
      lines.push(`- ${DEGRADED_STATUS_MARKER[status]} ${vendorInline(name)}`);
  }
  return lines;
}

/**
 * Status icon per rating ({@link vendorRating}), so a vendor's heading agrees with the
 * summary bucket it counts in — a page reading `none` beside an open major incident is not
 * shown ✅. A record rather than a ternary chain so a new indicator is a compile error here
 * instead of falling through to the wrong glyph. `maintenance` reuses the 🛠️ the
 * degraded-component list already marks scheduled windows with, so a planned window reads
 * the same wherever it appears.
 */
const RATING_ICON: Record<VendorResult['indicator'], string> = {
  none: '✅',
  minor: '⚠️',
  major: '⚠️',
  critical: '🔴',
  maintenance: '🛠️',
};

/**
 * A maintenance window's end for a content[] line — the vendor's timestamp, escaped, or a
 * statement that its feed publishes none. Shared with devops_get_incidents so both tools
 * word a missing end the same way.
 */
export function renderWindowEnd(scheduledUntil: string | null): string {
  return scheduledUntil === null ? 'end not published' : vendorInline(scheduledUntil);
}

/**
 * Render a vendor result block for use in format(). Every string the status page wrote
 * — the page name, status description, component names and descriptions, incident and
 * maintenance fields — is flattened and escaped inline, and each incident's latest update
 * is quoted beneath it.
 */
export function renderVendorBlock(v: VendorResult): string[] {
  const lines: string[] = [];
  const icon = v.error ? '❓' : RATING_ICON[vendorRating(v)];
  lines.push(`### ${icon} ${vendorInline(v.name)} (${v.vendor})`);
  lines.push(`**Status:** ${vendorInline(v.description)} | **Indicator:** ${v.indicator}`);
  if (v.error) lines.push(`**Error:** ${v.error}`);
  if (v.degraded_components.length > 0) {
    lines.push(...renderDegradedComponents(v.degraded_components));
  }
  if (v.active_incidents.length > 0) {
    for (const inc of v.active_incidents) {
      lines.push(
        `**Incident [${vendorInline(inc.id)}]:** ${vendorInline(inc.name)} [${inc.impact}/${vendorInline(inc.status)}]${inc.started_at ? ` started ${vendorInline(inc.started_at)}` : ''}`,
      );
      const quote = vendorQuote(inc.latest_update);
      // The blank line ends the quote, which would otherwise take in the next line.
      if (quote.length > 0) lines.push(...quote, '');
    }
  }
  if (v.scheduled_maintenances && v.scheduled_maintenances.length > 0) {
    for (const m of v.scheduled_maintenances) {
      lines.push(
        `**Maintenance:** ${vendorInline(m.name)} [${vendorInline(m.status)}] ${vendorInline(m.scheduled_for)} → ${renderWindowEnd(m.scheduled_until)}`,
      );
    }
  }
  if (v.all_components && v.all_components.length > 0) {
    const shown = v.all_components.length;
    const total = v.all_components_total ?? shown;
    // A page ends where the next one starts, or at the end of the list when it is the last.
    const start = (v.next_component_offset ?? total) - shown;
    const range = start === 0 ? `${shown}` : `${start + 1}–${start + shown}`;
    lines.push(`**Components (${range} of ${total}):**`);
    for (const c of v.all_components) {
      lines.push(
        `- ${vendorInline(qualifiedName(c))}: ${vendorInline(c.status)}${c.description ? ` — ${vendorInline(c.description)}` : ''}`,
      );
    }
    if (v.next_component_offset !== undefined) {
      lines.push(
        `**next_component_offset:** ${v.next_component_offset} — the list continues past this page.`,
      );
    }
  }
  lines.push(
    `*Cached: ${v.cached} | Checked: ${v.checked_at} | URL: ${v.statuspage_url || 'n/a'}*`,
  );
  return lines;
}

/**
 * Build the per-vendor entry for a vendor that could not be checked.
 *
 * Covers all three ways a vendor fails to produce a status: an input that resolves
 * to no target, a raw URL the SSRF guard blocks, and a status API that rejects.
 * `indicator: 'none'` is the schema's only neutral value — the `error` field, the
 * ❓ icon, and the `unavailable` summary bucket are what mark it as unchecked, so
 * it is never counted as operational.
 */
export function vendorErrorResult(
  vendor: string,
  name: string,
  statuspageUrl: string,
  error: string,
): VendorResult {
  return {
    vendor,
    name,
    indicator: 'none',
    description: 'Unknown',
    degraded_components: [],
    active_incidents: [],
    cached: false,
    checked_at: new Date().toISOString(),
    statuspage_url: statuspageUrl,
    error,
  };
}

/**
 * A pre-filled follow-up tool call — the same `{ toolName, reason, args }` shape
 * `devops_suggest_action` returns, so a caller handles suggestions from every tool alike.
 */
const NextToolSuggestionSchema = z
  .object({
    toolName: z.string().describe('Tool to call next — "devops_suggest_action".'),
    reason: z
      .string()
      .describe(
        'Why the vendor qualifies: its reported indicator, or the open incident behind it.',
      ),
    args: z
      .record(z.string(), z.unknown())
      .describe(
        'Ready-to-use devops_suggest_action arguments: vendor (registry slug, or the normalized status page URL for a raw URL), vendor_indicator (only for minor, major, or critical), affected_components (degraded components outside a maintenance window, each written "Group / Leaf" when it is in a group), incident_summary (title of the most recently started open incident rated minor or worse).',
      ),
  })
  .describe('A recommended follow-up tool call with pre-filled arguments.');

type NextToolSuggestion = z.infer<typeof NextToolSuggestionSchema>;

/** The `nextToolSuggestions` output field shared by devops_status_check and devops_watch_stack. */
export const NextToolSuggestionsSchema = z
  .array(NextToolSuggestionSchema)
  .describe(
    "One devops_suggest_action call per vendor with an active problem — an indicator of minor, major, or critical, or an open incident of that impact even while the indicator reads none or maintenance; these are the vendors summary counts as degraded or down — with its arguments filled from that vendor's result. Vendors that could not be checked never appear. Empty when no checked vendor has an active problem.",
  );

/**
 * Indicator and incident-impact values that mark an active problem, each with the label
 * devops_suggest_action frames it with. `none` and `maintenance` are all-clear and a planned
 * window, never a problem.
 */
const PROBLEM_SEVERITY_LABEL = {
  minor: 'degraded performance',
  major: 'partial outage',
  critical: 'full outage',
} as const;

type ProblemSeverity = keyof typeof PROBLEM_SEVERITY_LABEL;

function isProblemSeverity(value: VendorResult['indicator']): value is ProblemSeverity {
  return Object.hasOwn(PROBLEM_SEVERITY_LABEL, value);
}

/**
 * Each indicator value's place in a vendor's rating, best first. A planned window sits above
 * all clear and below every fault, so an open outage outranks it.
 */
const RATING_RANK: Record<VendorResult['indicator'], number> = {
  none: 0,
  maintenance: 1,
  minor: 2,
  major: 3,
  critical: 4,
};

/**
 * The level a vendor is counted at in `summary` and rolled up at in devops_watch_stack's
 * `health`: the worse of its published indicator and its worst open incident rated minor or
 * worse. Statuspage blends the indicator from component statuses while an incident's impact
 * can be set by override, so a page can read `none` or `maintenance` beside an open incident
 * rated major. An incident rated `none` (an advisory) or `maintenance` (a window listed as an
 * incident) never raises it, so a window never counts as an outage, and an incident never
 * lowers what the vendor published. The vendors this rates minor or worse are exactly the
 * ones {@link buildSuggestActionSuggestions} suggests. `indicator` itself stays as published.
 */
export function vendorRating(result: VendorResult): VendorResult['indicator'] {
  let rating = result.indicator;
  for (const { impact } of result.active_incidents) {
    if (isProblemSeverity(impact) && RATING_RANK[impact] > RATING_RANK[rating]) rating = impact;
  }
  return rating;
}

/** Component names named in a reason before the rest are counted instead. */
const REASON_COMPONENT_LIMIT = 3;

type ActiveIncident = VendorResult['active_incidents'][number];

/**
 * The open incident with the latest `started_at`, compared as instants — pages publish
 * mixed UTC offsets, so string order is wrong. An undated or unparseable start ranks last,
 * and ties keep the order the page listed them in.
 */
function latestIncident(incidents: readonly ActiveIncident[]): ActiveIncident | undefined {
  let latest: ActiveIncident | undefined;
  let latestAt = Number.NEGATIVE_INFINITY;
  for (const incident of incidents) {
    const parsed = incident.started_at ? Date.parse(incident.started_at) : Number.NaN;
    const at = Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
    if (latest === undefined || at > latestAt) {
      latest = incident;
      latestAt = at;
    }
  }
  return latest;
}

/** Semicolon-joined, because component names routinely carry commas ("SMS, Latin America"). */
function componentList(names: readonly string[]): string {
  const shown = names.slice(0, REASON_COMPONENT_LIMIT).join('; ');
  const rest = names.length - REASON_COMPONENT_LIMIT;
  return rest > 0 ? `${shown} and ${rest} more` : shown;
}

/**
 * Build a `devops_suggest_action` suggestion for every vendor with an active problem.
 *
 * `prepared` and `results` are index-aligned — `fetchVendorResults` returns one result
 * per prepared entry, in order. The pairing is what supplies the canonical slug:
 * `VendorResult.vendor` echoes the caller's input ("GitHub"), while the registry slug
 * ("github") lives only on the resolved target. A raw URL has no slug, so it passes the
 * normalized URL the status page was fetched from.
 *
 * A vendor qualifies on its indicator or on an open incident rated minor or worse; a page
 * can read `none` while such an incident is open. `vendor_indicator` is passed only when it
 * names the problem itself — `none` or `maintenance` would frame the playbook as all-clear or
 * a planned window. Inputs that resolve to the same vendor yield one entry, the first.
 */
export function buildSuggestActionSuggestions(
  prepared: readonly PreparedVendor[],
  results: readonly VendorResult[],
): NextToolSuggestion[] {
  const suggestions: NextToolSuggestion[] = [];
  const seen = new Set<string>();

  results.forEach((result, i) => {
    // An unresolved entry always produces an error row; the `ok` check narrows the pairing.
    const entry = prepared[i];
    if (result.error !== undefined || !entry?.ok) return;

    const vendor = entry.target.slug ?? entry.target.url;
    const severity = isProblemSeverity(result.indicator) ? result.indicator : undefined;
    const incident = latestIncident(
      result.active_incidents.filter((inc) => isProblemSeverity(inc.impact)),
    );
    const components = result.degraded_components
      .filter((c) => c.status !== 'under_maintenance')
      .map(qualifiedName);

    /**
     * The indicator is the vendor's overall rating, not each component's — a minor page
     * routinely carries components in partial or major outage — so the components are
     * listed apart from it rather than as the thing the indicator describes.
     */
    let reason: string;
    if (severity) {
      const scope =
        components.length > 0 ? `; affected components: ${componentList(components)}` : '';
      reason = `${vendor} reports ${severity} (${PROBLEM_SEVERITY_LABEL[severity]}) overall${scope}.`;
    } else if (incident) {
      reason = `${vendor} reports ${result.indicator} overall but has an open ${incident.impact} incident: "${incident.name}".`;
    } else {
      return;
    }

    if (seen.has(vendor)) return;
    seen.add(vendor);

    const args: Record<string, unknown> = { vendor };
    if (severity) args.vendor_indicator = severity;
    if (components.length > 0) args.affected_components = components;
    if (incident) args.incident_summary = incident.name;

    suggestions.push({ toolName: 'devops_suggest_action', reason, args });
  });

  return suggestions;
}

/**
 * Render `nextToolSuggestions` for format(), in the layout devops_suggest_action uses. Empty
 * when there are none. A reason quotes incident and component names, so it is escaped
 * inline like any vendor text.
 */
export function renderNextToolSuggestions(suggestions: readonly NextToolSuggestion[]): string[] {
  if (suggestions.length === 0) return [];
  const lines = ['## Recommended Next Steps', ''];
  for (const s of suggestions) {
    lines.push(
      `### \`${s.toolName}\``,
      `**Why:** ${vendorInline(s.reason)}`,
      `**Args:** \`${JSON.stringify(s.args)}\``,
      '',
    );
  }
  return lines;
}

/** Aggregate health counts. The buckets partition the result set. */
export type VendorSummary = {
  total: number;
  operational: number;
  degraded: number;
  down: number;
  maintenance: number;
  unavailable: number;
};

/**
 * The bucket a checked vendor's rating counts in — a record, so a new indicator value is a
 * compile error here rather than a vendor silently left out of the totals.
 */
const RATING_BUCKET: Record<
  VendorResult['indicator'],
  Exclude<keyof VendorSummary, 'total' | 'unavailable'>
> = {
  none: 'operational',
  minor: 'degraded',
  major: 'degraded',
  critical: 'down',
  maintenance: 'maintenance',
};

/**
 * Count vendors into the five aggregate buckets, each vendor in exactly one.
 *
 * One definition for both tools: a vendor carrying `error` — unresolvable slug,
 * blocked target, or failed fetch — is `unavailable`, never `operational`, and every
 * other vendor counts at its {@link vendorRating}, so
 * `operational + degraded + down + maintenance + unavailable === total` always holds.
 * `maintenance` is its own bucket rather than folded into `degraded`: the vendor
 * published a planned window, and counting it as a fault would put a scheduled window
 * in the same number as an outage.
 */
export function summarizeVendorResults(results: readonly VendorResult[]): VendorSummary {
  const summary: VendorSummary = {
    total: results.length,
    operational: 0,
    degraded: 0,
    down: 0,
    maintenance: 0,
    unavailable: 0,
  };
  for (const r of results) {
    summary[r.error === undefined ? RATING_BUCKET[vendorRating(r)] : 'unavailable'] += 1;
  }
  return summary;
}

/** A vendor input that resolved to a fetchable target. */
export type PreparedVendorTarget = {
  ok: true;
  input: string;
  target: ResolvedVendor;
};

/** A vendor input that can never be fetched, with the reason a caller would throw. */
export type PreparedVendorFailure = {
  ok: false;
  input: string;
  reason: 'vendor_not_found' | 'target_blocked';
  name: string;
  url: string;
  message: string;
};

export type PreparedVendor = PreparedVendorTarget | PreparedVendorFailure;

/**
 * Resolve every vendor input and SSRF-check the raw URLs among them, returning one
 * entry per input in the order given.
 *
 * Failures are returned rather than thrown so a batch keeps the vendors it can
 * check — one bad slug or blocked URL used to discard every already-resolved
 * vendor in the same call. The caller decides what to do with an all-failed batch.
 */
export function prepareVendors(inputs: readonly string[]): Promise<PreparedVendor[]> {
  const registry = getVendorRegistryService();

  return Promise.all(
    inputs.map(async (input): Promise<PreparedVendor> => {
      const target = registry.resolve(input);
      if (!target) {
        return {
          ok: false,
          input,
          reason: 'vendor_not_found',
          name: input,
          url: '',
          message: `"${input}" is not a known vendor slug and is not a valid URL. Call devops_list_vendors to browse.`,
        };
      }

      // Only raw URL inputs need the guard — registry entries are pre-verified public URLs.
      if (target.slug === null) {
        try {
          await assertSafeUrl(target.url);
        } catch (err) {
          const blocked = ssrfRejectionMessage(err);
          if (blocked === null) throw err;
          return {
            ok: false,
            input,
            reason: 'target_blocked',
            name: target.name,
            url: target.url,
            message: blocked,
          };
        }
      }

      return { ok: true, input, target };
    }),
  );
}

/** Component shaping applied to every vendor in a check. */
export type ComponentOptions = {
  /** summary omits component lists entirely; detailed includes the capped list. */
  mode: 'summary' | 'detailed';
  /** Maximum components to include per vendor in detailed mode. */
  componentLimit: number;
  /**
   * Components skipped per vendor in detailed mode, after the filter and before the limit.
   * devops_watch_stack takes no offset and always passes 0.
   */
  componentOffset: number;
  /** Case-insensitive substring narrowing the component list before the offset and cap. */
  componentFilter?: string | undefined;
};

/** Arguments for {@link buildVendorResult}. */
export type BuildVendorResultArgs = ComponentOptions & {
  /** Vendor slug or URL exactly as the caller provided it. */
  vendorInput: string;
  /** Status page base URL the data was fetched from. */
  url: string;
  /** Registry display name, used when the page omits its own. */
  name: string;
  /** Normalized status payload. */
  data: StatuspageSummaryResponse;
  /** True when the payload came from the in-memory cache. */
  cached: boolean;
};

/**
 * A built vendor result plus the component counts the caller needs to disclose
 * truncation. `buildVendorResult` runs once per vendor inside a fan-out and gets no
 * `ctx`, so it reports the counts and the tool aggregates them into one
 * `ctx.enrich.truncated()` call across the batch.
 */
export type BuiltVendorResult = {
  result: VendorResult;
  /** Components matching the filter before the offset and cap. 0 in summary mode. */
  componentsMatched: number;
  /** Components included in the result. 0 in summary mode. */
  componentsShown: number;
  /**
   * Matching components after the returned page — what `next_component_offset` continues
   * with. Those skipped before the page are never counted. 0 in summary mode.
   */
  componentsPast: number;
  /** Components the page publishes, groups excluded — what a filter could have matched. */
  componentsPublished: number;
};

/** Build a VendorResult from a Statuspage summary response. */
export function buildVendorResult(args: BuildVendorResultArgs): BuiltVendorResult {
  const {
    vendorInput,
    url,
    name,
    data,
    cached,
    mode,
    componentLimit,
    componentOffset,
    componentFilter,
  } = args;
  const now = new Date().toISOString();
  // A group is a container, never a component a caller checks; its name labels its leaves.
  const groupNames = new Map(data.components.filter((c) => c.group).map((c) => [c.id, c.name]));
  const leaves = data.components
    .filter((c) => !c.group)
    .map((c) => ({ component: c, group: groupNames.get(c.group_id ?? '') ?? null }));
  const degraded = leaves.filter(({ component }) => component.status !== 'operational');
  const activeIncidents = (data.incidents ?? []).filter(
    (i) => i.status !== 'resolved' && i.status !== 'postmortem',
  );

  const result: VendorResult = {
    vendor: vendorInput,
    name: data.page.name || name,
    indicator: data.status.indicator,
    description: data.status.description,
    degraded_components: degraded.map(({ component, group }) => ({
      name: component.name,
      group,
      status: component.status as DegradedStatus,
    })),
    active_incidents: activeIncidents.map((i) => {
      const updates = [...i.incident_updates].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
      return {
        id: i.id,
        name: i.name,
        impact: i.impact,
        status: i.status,
        started_at: i.started_at ?? null,
        latest_update: updates[0]?.body ?? '',
      };
    }),
    cached,
    checked_at: now,
    statuspage_url: url,
  };

  if (mode === 'summary') {
    return {
      result,
      componentsMatched: 0,
      componentsShown: 0,
      componentsPast: 0,
      componentsPublished: leaves.length,
    };
  }

  result.scheduled_maintenances = (data.scheduled_maintenances ?? []).map((m) => ({
    name: m.name,
    scheduled_for: m.scheduled_for ?? '',
    scheduled_until: m.scheduled_until ?? null,
    status: m.status,
  }));

  const filter = componentFilter?.trim().toLowerCase();
  const matched = filter
    ? leaves.filter(
        ({ component, group }) =>
          component.name.toLowerCase().includes(filter) ||
          (group?.toLowerCase().includes(filter) ?? false),
      )
    : leaves;
  const pageEnd = componentOffset + componentLimit;
  const shown = matched.slice(componentOffset, pageEnd);
  const componentsPast = Math.max(matched.length - pageEnd, 0);

  result.all_components = shown.map(({ component, group }) => ({
    name: component.name,
    group,
    status: component.status,
    // Pages omit `description` entirely rather than sending null; the output
    // contract promises `string | null`, so normalize instead of widening it.
    description: component.description ?? null,
  }));
  result.all_components_total = matched.length;
  if (componentsPast > 0) result.next_component_offset = pageEnd;

  return {
    result,
    componentsMatched: matched.length,
    componentsShown: shown.length,
    componentsPast,
    componentsPublished: leaves.length,
  };
}

/**
 * The `notice` sentence for a vendor whose registry entry reads an umbrella page — one
 * that publishes no components and only cross-product incidents — naming the entries
 * that read its products' own pages. Undefined for every vendor without `product_slugs`.
 * Shared by every tool that serves such a vendor, and always the last sentence of the
 * composed notice.
 */
export function productSlugsNotice(
  vendor: Pick<ResolvedVendor, 'slug' | 'product_slugs'>,
): string | undefined {
  if (!vendor.product_slugs) return undefined;
  return `${vendor.slug} reads an umbrella status page that publishes no components and only cross-product incidents; product outages are posted on each product's own page — check those by slug: ${vendor.product_slugs.join(', ')}.`;
}

/**
 * The notice for a component_filter that matched no component of one or more checked
 * vendors. A vendor that errored is left out: it was never checked, and its row says so.
 */
function filterMissNotice(filter: string, missed: readonly BuiltVendorResult[]): string {
  const vendors = missed
    .map((m) => `${m.result.vendor} (${m.componentsPublished} published)`)
    .join(', ');
  return (
    `component_filter ${JSON.stringify(filter)} matched no component of ${vendors}. ` +
    'It matches component and group names as a case-insensitive substring; call again without component_filter to list them.'
  );
}

/**
 * The notice for a component_offset at or past the end of one or more checked vendors'
 * lists, which leaves their all_components empty. A vendor the filter matched nothing of
 * is a filter miss instead, and one that errored is left out.
 */
function offsetPastEndNotice(
  offset: number,
  filtered: boolean,
  past: readonly BuiltVendorResult[],
): string {
  const matching = filtered ? ' matching component_filter' : '';
  const vendors = past
    .map(
      (p) =>
        `${p.result.vendor} (${p.componentsMatched} component${p.componentsMatched === 1 ? '' : 's'}${matching})`,
    )
    .join(', ');
  return `component_offset ${offset} is past the last component of ${vendors}, so all_components is empty there. Pass a smaller component_offset, or 0 to start from the first component.`;
}

/**
 * Fetch every prepared vendor and return one result per entry, in order.
 *
 * Both tools run the identical check — fan out under `Promise.allSettled` so one
 * unreachable vendor doesn't fail the rest, turn every failure (unfetchable target,
 * rejected fetch) into an `error` row, and disclose capped component lists once for
 * the whole batch. They differ only in what they persist and how they shape the
 * response, so the check itself lives here and cannot drift between them.
 *
 * `leadNotices` are the caller's own adjustments (deferred vendors, a clamped
 * component_limit). `notice` is last-wins across enrich calls, so they are composed
 * here, ahead of the component notices, into the one notice this function writes.
 */
export async function fetchVendorResults(
  prepared: readonly PreparedVendor[],
  ctx: Context,
  options: ComponentOptions,
  leadNotices: readonly string[] = [],
): Promise<VendorResult[]> {
  const settled = await Promise.allSettled(
    prepared.map(async (p): Promise<BuiltVendorResult> => {
      if (!p.ok) {
        return {
          result: vendorErrorResult(p.input, p.name, p.url, p.message),
          componentsMatched: 0,
          componentsShown: 0,
          componentsPast: 0,
          componentsPublished: 0,
        };
      }
      const { data, cached } = await fetchVendorSummary(p.target);
      return buildVendorResult({
        vendorInput: p.input,
        url: p.target.url,
        name: p.target.name,
        data,
        cached,
        ...options,
      });
    }),
  );

  let componentsMatched = 0;
  let componentsShown = 0;
  let componentsPast = 0;
  const built: BuiltVendorResult[] = [];
  for (const s of settled) {
    if (s.status !== 'fulfilled') continue;
    built.push(s.value);
    componentsMatched += s.value.componentsMatched;
    componentsShown += s.value.componentsShown;
    componentsPast += s.value.componentsPast;
  }

  /**
   * `notice` is last-wins across enrich calls, so every reason composes into one string,
   * in a fixed order: the caller's lead notices, truncation with its continuation, an
   * offset past the end, a filter miss, and the umbrella pointer last.
   */
  const notices = [...leadNotices];
  const filter = options.componentFilter?.trim();
  // Truncation follows the page: only components after it count, never those skipped before it.
  const truncated = componentsPast > 0;
  if (truncated) {
    const after = options.componentOffset > 0 ? ' after this page' : '';
    // The offset indexes the filtered list, so a continuation that drops the filter lands elsewhere.
    const sameFilter = filter ? ' the same component_filter,' : '';
    // At the maximum there is no higher limit to point at.
    const raise = options.componentLimit < MAX_COMPONENT_LIMIT ? ', or raise component_limit' : '';
    notices.push(
      `${componentsPast} of ${componentsMatched} components${after} are not shown — component lists are capped at ${options.componentLimit} per vendor. Continue a capped list with devops_status_check, passing that vendor, mode: "detailed",${sameFilter} and its next_component_offset as component_offset. Set component_filter to reach a specific component${raise}.`,
    );
  }
  if (options.mode === 'detailed') {
    const checked = built.filter((b) => b.result.error === undefined);
    const missed = filter ? checked.filter((b) => b.componentsMatched === 0) : [];
    const pastEnd =
      options.componentOffset > 0
        ? checked.filter((b) => b.componentsShown === 0 && !missed.includes(b))
        : [];
    if (pastEnd.length > 0) {
      notices.push(offsetPastEndNotice(options.componentOffset, Boolean(filter), pastEnd));
    }
    if (filter && missed.length > 0) notices.push(filterMissNotice(filter, missed));
  }
  // An entry is the umbrella whether or not its page answered, so a failed fetch keeps the pointer.
  notices.push(
    ...new Set(prepared.flatMap((p) => (p.ok ? (productSlugsNotice(p.target) ?? []) : []))),
  );

  if (truncated) {
    ctx.enrich.total(componentsMatched);
    ctx.enrich.truncated({
      shown: componentsShown,
      cap: options.componentLimit,
      guidance: notices.join(' '),
    });
  } else if (notices.length > 0) {
    ctx.enrich.notice(notices.join(' '));
  }

  return settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value.result;
    // i is always in bounds — settled and prepared have the same length
    const p = prepared[i] as PreparedVendor;
    return vendorErrorResult(
      p.input,
      p.ok ? p.target.name : p.name,
      p.ok ? p.target.url : p.url,
      vendorErrorMessage(s.reason),
    );
  });
}
