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
import { assertSafeUrl } from '@/utils/ssrf-guard.js';

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
 * `component_limit` or narrow with `component_filter`.
 */
export const DEFAULT_COMPONENT_LIMIT = 50;

/** Highest `component_limit` accepted — above the largest published component list. */
export const MAX_COMPONENT_LIMIT = 500;

/** Per-vendor result schema shared by devops_status_check and devops_watch_stack. */
export const VendorResultSchema = z
  .object({
    vendor: z.string().describe('Vendor slug or URL as provided.'),
    name: z.string().describe('Display name of the vendor.'),
    indicator: z
      .enum(['none', 'minor', 'major', 'critical', 'maintenance'])
      .describe(
        'Overall health indicator: none = all clear, minor = some degradation, major = significant outage, critical = complete outage, maintenance = scheduled window in progress, planned rather than a fault.',
      ),
    description: z
      .string()
      .describe('Human-readable status description (e.g., "All Systems Operational").'),
    degraded_components: z
      .array(
        z
          .object({
            name: z.string().describe('Component name.'),
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
                'ISO 8601 UTC timestamp when the incident started, or null/absent if not set by the vendor.',
              ),
            latest_update: z.string().describe('Most recent incident_update body text.'),
          })
          .describe('An active incident entry.'),
      )
      .describe('Active (non-resolved) incidents.'),
    scheduled_maintenances: z
      .array(
        z
          .object({
            name: z.string().describe('Maintenance window name.'),
            scheduled_for: z.string().describe('ISO 8601 UTC start time.'),
            scheduled_until: z.string().describe('ISO 8601 UTC end time.'),
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
            name: z.string().describe('Component name.'),
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
        'Components including operational ones, capped at component_limit per vendor and narrowed by component_filter when given. Present in detailed mode only.',
      ),
    all_components_total: z
      .number()
      .optional()
      .describe(
        'Components matching component_filter for this vendor before the component_limit cap. Larger than the length of all_components when this vendor was capped. Present in detailed mode only.',
      ),
    cached: z.boolean().describe('True when this result was served from the 60s in-memory cache.'),
    checked_at: z.string().describe('ISO 8601 UTC timestamp of this check.'),
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
    (status) => [status, components.filter((c) => c.status === status).map((c) => c.name)] as const,
  ).filter(([, names]) => names.length > 0);

  const lines = [
    `**Degraded (${components.length}):** ${grouped.map(([status, names]) => `${names.length} ${status}`).join(', ')}`,
  ];
  for (const [status, names] of grouped) {
    lines.push(
      `**${status} (${names.length})${status === 'under_maintenance' ? ' — scheduled window, not an outage' : ''}:**`,
    );
    for (const name of names) lines.push(`- ${DEGRADED_STATUS_MARKER[status]} ${name}`);
  }
  return lines;
}

/**
 * Status icon per indicator. A record rather than a ternary chain so a new
 * indicator is a compile error here instead of falling through to the wrong glyph.
 * `maintenance` reuses the 🛠️ the degraded-component list already marks scheduled
 * windows with, so a planned window reads the same wherever it appears.
 */
const INDICATOR_ICON: Record<VendorResult['indicator'], string> = {
  none: '✅',
  minor: '⚠️',
  major: '⚠️',
  critical: '🔴',
  maintenance: '🛠️',
};

/** Render a vendor result block for use in format(). */
export function renderVendorBlock(v: VendorResult): string[] {
  const lines: string[] = [];
  const icon = v.error ? '❓' : INDICATOR_ICON[v.indicator];
  lines.push(`### ${icon} ${v.name} (${v.vendor})`);
  lines.push(`**Status:** ${v.description} | **Indicator:** ${v.indicator}`);
  if (v.error) lines.push(`**Error:** ${v.error}`);
  if (v.degraded_components.length > 0) {
    lines.push(...renderDegradedComponents(v.degraded_components));
  }
  if (v.active_incidents.length > 0) {
    for (const inc of v.active_incidents) {
      lines.push(
        `**Incident [${inc.id}]:** ${inc.name} [${inc.impact}/${inc.status}]${inc.started_at ? ` started ${inc.started_at}` : ''}`,
      );
      lines.push(`  ${inc.latest_update}`);
    }
  }
  if (v.scheduled_maintenances && v.scheduled_maintenances.length > 0) {
    for (const m of v.scheduled_maintenances) {
      lines.push(
        `**Maintenance:** ${m.name} [${m.status}] ${m.scheduled_for} → ${m.scheduled_until}`,
      );
    }
  }
  if (v.all_components && v.all_components.length > 0) {
    const total = v.all_components_total ?? v.all_components.length;
    lines.push(`**Components (${v.all_components.length} of ${total}):**`);
    for (const c of v.all_components) {
      lines.push(`- ${c.name}: ${c.status}${c.description ? ` — ${c.description}` : ''}`);
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
 * Count vendors into the five aggregate buckets.
 *
 * One definition for both tools: a vendor carrying `error` — unresolvable slug,
 * blocked target, or failed fetch — is `unavailable`, never `operational`, so
 * `operational + degraded + down + maintenance + unavailable === total` always
 * holds. `maintenance` is its own bucket rather than folded into `degraded`:
 * the vendor published a planned window, and counting it as a fault would put a
 * scheduled window in the same number as an outage. Every indicator maps to a
 * bucket — a vendor absent from all of them would silently leave the totals.
 */
export function summarizeVendorResults(results: readonly VendorResult[]): VendorSummary {
  return {
    total: results.length,
    operational: results.filter((r) => r.indicator === 'none' && !r.error).length,
    degraded: results.filter((r) => r.indicator === 'minor' || r.indicator === 'major').length,
    down: results.filter((r) => r.indicator === 'critical').length,
    maintenance: results.filter((r) => r.indicator === 'maintenance').length,
    unavailable: results.filter((r) => r.error !== undefined).length,
  };
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
          const msg = (err as Error).message;
          if (!msg.startsWith('SSRF_BLOCKED')) throw err;
          return {
            ok: false,
            input,
            reason: 'target_blocked',
            name: target.name,
            url: target.url,
            message: msg.replace('SSRF_BLOCKED: ', ''),
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
  /** Case-insensitive substring narrowing the component list before the cap. */
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
  /** Components matching the filter before the cap. 0 in summary mode. */
  componentsMatched: number;
  /** Components included in the result. 0 in summary mode. */
  componentsShown: number;
};

/** Build a VendorResult from a Statuspage summary response. */
export function buildVendorResult(args: BuildVendorResultArgs): BuiltVendorResult {
  const { vendorInput, url, name, data, cached, mode, componentLimit, componentFilter } = args;
  const now = new Date().toISOString();
  const degraded = data.components.filter((c) => c.status !== 'operational' && !c.group);
  const activeIncidents = (data.incidents ?? []).filter(
    (i) => i.status !== 'resolved' && i.status !== 'postmortem',
  );

  const result: VendorResult = {
    vendor: vendorInput,
    name: data.page.name || name,
    indicator: data.status.indicator,
    description: data.status.description,
    degraded_components: degraded.map((c) => ({
      name: c.name,
      status: c.status as VendorResult['degraded_components'][number]['status'],
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
    return { result, componentsMatched: 0, componentsShown: 0 };
  }

  result.scheduled_maintenances = (data.scheduled_maintenances ?? []).map((m) => ({
    name: m.name,
    scheduled_for: m.scheduled_for ?? '',
    scheduled_until: m.scheduled_until ?? '',
    status: m.status,
  }));

  const filter = componentFilter?.trim().toLowerCase();
  const matched = data.components.filter(
    (c) => !c.group && (!filter || c.name.toLowerCase().includes(filter)),
  );
  const shown = matched.slice(0, componentLimit);

  result.all_components = shown.map((c) => ({
    name: c.name,
    status: c.status,
    // Pages omit `description` entirely rather than sending null; the output
    // contract promises `string | null`, so normalize instead of widening it.
    description: c.description ?? null,
  }));
  result.all_components_total = matched.length;

  return { result, componentsMatched: matched.length, componentsShown: shown.length };
}

/**
 * Fetch every prepared vendor and return one result per entry, in order.
 *
 * Both tools run the identical check — fan out under `Promise.allSettled` so one
 * unreachable vendor doesn't fail the rest, turn every failure (unfetchable target,
 * rejected fetch) into an `error` row, and disclose capped component lists once for
 * the whole batch. They differ only in what they persist and how they shape the
 * response, so the check itself lives here and cannot drift between them.
 */
export async function fetchVendorResults(
  prepared: readonly PreparedVendor[],
  ctx: Context,
  options: ComponentOptions,
): Promise<VendorResult[]> {
  const settled = await Promise.allSettled(
    prepared.map(async (p): Promise<BuiltVendorResult> => {
      if (!p.ok) {
        return {
          result: vendorErrorResult(p.input, p.name, p.url, p.message),
          componentsMatched: 0,
          componentsShown: 0,
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
  for (const s of settled) {
    if (s.status !== 'fulfilled') continue;
    componentsMatched += s.value.componentsMatched;
    componentsShown += s.value.componentsShown;
  }
  if (componentsShown < componentsMatched) {
    ctx.enrich.total(componentsMatched);
    ctx.enrich.truncated({
      shown: componentsShown,
      cap: options.componentLimit,
      guidance: `${componentsMatched - componentsShown} of ${componentsMatched} components are not shown — component lists are capped at ${options.componentLimit} per vendor. Set component_filter to reach a specific component, or raise component_limit.`,
    });
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
