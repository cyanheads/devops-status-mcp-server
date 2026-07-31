/**
 * @fileoverview Tool to check current health status for one or more vendors via their status APIs.
 * @module mcp-server/tools/definitions/devops-status-check.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { PreparedVendorFailure } from './devops-vendor-result.js';
import {
  DEFAULT_COMPONENT_LIMIT,
  fetchVendorResults,
  MAX_COMPONENT_LIMIT,
  prepareVendors,
  renderVendorBlock,
  summarizeVendorResults,
  VendorResultSchema,
} from './devops-vendor-result.js';

export const devopsStatusCheck = tool('devops_status_check', {
  description:
    'Check the current health status for one or more vendors. Accepts registered vendor slugs ' +
    '(e.g., "github", "aws", "gcp", "gitlab") or raw Atlassian Statuspage base URLs. Registry entries are served ' +
    "by each vendor's native status API (Statuspage, Status.io, Slack, AWS Health, Google Cloud Service Health, Firehydrant) and normalized to one shape. " +
    'Returns per-vendor operational indicator (none = all clear, minor, major, critical, maintenance = scheduled window), degraded components, and active incidents. ' +
    'Use mode: "detailed" for component lists and maintenance windows, narrowed with component_filter and bounded by component_limit. ' +
    'Batch-friendly — pass a list to check your full stack in one call; a vendor that cannot be resolved or reached is reported in its own result row, so one bad entry never discards the rest.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    vendors: z
      .array(
        z
          .string()
          .min(1)
          .describe('A vendor slug (e.g., "github") or raw Atlassian Statuspage base URL.'),
      )
      .min(1)
      .max(20)
      .describe(
        'Vendor slugs from the built-in registry (e.g., "github", "aws") or raw Atlassian Statuspage base URLs (non-Statuspage backends are supported via registry slugs only). Mix freely. Use devops_list_vendors to discover available slugs.',
      ),
    mode: z
      .enum(['summary', 'detailed'])
      .default('summary')
      .describe(
        'summary: indicator + degraded components + active incidents only. detailed: adds the component list and scheduled maintenance windows.',
      ),
    component_filter: z
      .string()
      .optional()
      .describe(
        'Case-insensitive substring matched against component names in detailed mode (e.g., "api" to check just the API components). Applied before component_limit, so it is the way to reach a component that the cap would otherwise omit. Ignored in summary mode.',
      ),
    component_limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_COMPONENT_LIMIT)
      .default(DEFAULT_COMPONENT_LIMIT)
      .describe(
        'Maximum components returned per vendor in detailed mode (1-500). Large status pages publish hundreds of components, so a multi-vendor batch at a high limit returns a very large response; narrow with component_filter instead where possible.',
      ),
  }),

  output: z.object({
    results: z
      .array(VendorResultSchema)
      .describe('Per-vendor status results in the same order as the input vendors list.'),
    summary: z
      .object({
        total: z.number().describe('Total number of vendors checked.'),
        operational: z.number().describe('Vendors with indicator = none and no error.'),
        degraded: z.number().describe('Vendors with indicator = minor or major.'),
        down: z.number().describe('Vendors with indicator = critical.'),
        maintenance: z
          .number()
          .describe(
            'Vendors with indicator = maintenance — in a scheduled window the vendor published. Counted apart from degraded and down, which are faults.',
          ),
        unavailable: z
          .number()
          .describe(
            'Vendors that could not be checked (carry an error) — unresolvable slug, blocked target, or failed status fetch. Counted as unknown, never operational.',
          ),
      })
      .describe(
        'Aggregate health counts across all checked vendors. Buckets partition the batch: operational + degraded + down + maintenance + unavailable = total.',
      ),
  }),

  enrichment: {
    // Populated only via ctx.enrich when a component list is actually capped —
    // all fields must be optional so uncapped results pass the effective-output parse.
    truncated: z
      .boolean()
      .optional()
      .describe(
        "True when at least one vendor's component list was capped at component_limit. Absent when nothing was capped.",
      ),
    shown: z
      .number()
      .optional()
      .describe('Components returned across all vendors. Present only when truncated.'),
    cap: z
      .number()
      .optional()
      .describe('The per-vendor component_limit that was applied. Present only when truncated.'),
    totalCount: z
      .number()
      .optional()
      .describe(
        'Components matching component_filter across all vendors before the cap. Present only when truncated.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Plain-language explanation of the capped component lists — how many components were omitted and how to reach them (component_filter to target one, component_limit to raise the cap). Present only when truncated.',
      ),
  },

  errors: [
    {
      reason: 'vendor_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No requested vendor could be checked and the first failure was a slug that matches no registry entry and is not a valid URL.',
      recovery:
        'Call devops_list_vendors to browse available slugs, or pass a full Statuspage base URL (e.g., "https://www.githubstatus.com").',
    },
    {
      reason: 'target_blocked',
      code: JsonRpcErrorCode.ValidationError,
      when: 'No requested vendor could be checked and the first failure was a raw URL resolving to a private, loopback, or cloud-metadata address.',
      recovery:
        'Pass a publicly routable Statuspage URL. If internal monitoring is intentional, set DEVOPS_STATUS_ALLOW_PRIVATE_TARGETS=true.',
    },
    /**
     * Both contract entries fire only for an all-failed batch. When at least one
     * vendor resolves, an unresolvable slug or blocked URL is reported as that
     * vendor's `error` row instead — partial failure is data, total failure is an
     * error, and one typed error carrying a recovery hint beats N error rows under
     * a summary reading `operational: 0`.
     */
    /**
     * A vendor whose status API errors or times out is not a failure mode of this
     * tool: every vendor is fetched under Promise.allSettled so one unreachable
     * vendor doesn't fail the batch, and the failure is reported in that vendor's
     * `error` field instead of thrown. No contract entry can describe it.
     */
  ],

  async handler(input, ctx) {
    const prepared = await prepareVendors(input.vendors);

    // Nothing to return — degrade to the typed contract rather than a batch of
    // error rows. The message names every failure so one round trip fixes them all.
    const failures = prepared.filter((p): p is PreparedVendorFailure => !p.ok);
    if (failures.length === prepared.length) {
      const first = failures[0] as PreparedVendorFailure;
      throw ctx.fail(
        first.reason,
        `None of the ${prepared.length} requested vendors could be checked. ${failures.map((f) => f.message).join(' ')}`,
        { ...ctx.recoveryFor(first.reason) },
      );
    }

    const results = await fetchVendorResults(prepared, ctx, {
      mode: input.mode,
      componentLimit: input.component_limit,
      componentFilter: input.component_filter,
    });

    const summary = summarizeVendorResults(results);

    ctx.log.info('Status check completed', { vendors: input.vendors.length, ...summary });
    return { results, summary };
  },

  format: (result) => {
    const lines: string[] = [
      `## Stack Health — ${result.summary.total} vendors checked`,
      `✅ ${result.summary.operational} operational  ⚠️ ${result.summary.degraded} degraded  🔴 ${result.summary.down} down  🛠️ ${result.summary.maintenance} maintenance  ❓ ${result.summary.unavailable} unavailable`,
      '',
    ];
    for (const v of result.results) {
      lines.push(...renderVendorBlock(v), '');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
