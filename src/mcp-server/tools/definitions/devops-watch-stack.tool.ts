/**
 * @fileoverview Tool to check health of a named vendor stack, persisted via ctx.state.
 * @module mcp-server/tools/definitions/devops-watch-stack.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { PreparedVendorFailure, VendorResult } from './devops-vendor-result.js';
import {
  DEFAULT_COMPONENT_LIMIT,
  fetchVendorResults,
  MAX_COMPONENT_LIMIT,
  prepareVendors,
  renderVendorBlock,
  summarizeVendorResults,
  VendorResultSchema,
} from './devops-vendor-result.js';

const STACK_STATE_PREFIX = 'stack/';

/** The health rungs, best first — one list behind the output enum and the icon table. */
const STACK_HEALTH_RUNGS = [
  'all_operational',
  'maintenance',
  'degraded',
  'partial_outage',
  'major_outage',
  'unknown',
] as const;

type StackHealth = (typeof STACK_HEALTH_RUNGS)[number];

function computeStackHealth(results: VendorResult[]): StackHealth {
  const indicators = results.filter((r) => !r.error).map((r) => r.indicator);
  if (indicators.some((i) => i === 'critical')) return 'major_outage';
  if (indicators.some((i) => i === 'major')) return 'partial_outage';
  if (indicators.some((i) => i === 'minor')) return 'degraded';
  // A vendor carrying a fetch error has an UNKNOWN status — never operational. Its
  // presence forces a non-green rollup, so an all-errored (or partially-errored)
  // stack can never fall through to all_operational.
  if (results.some((r) => r.error)) return 'unknown';
  // A published maintenance window is planned, so it ranks below every outage rung
  // and below unknown — but it is not unqualified health either, and all_operational
  // stays reserved for a stack with nothing open at all.
  if (indicators.some((i) => i === 'maintenance')) return 'maintenance';
  return 'all_operational';
}

/** Rollup icon per health rung — a record so a new rung is a compile error here. */
const HEALTH_ICON: Record<StackHealth, string> = {
  all_operational: '✅',
  maintenance: '🛠️',
  degraded: '⚠️',
  partial_outage: '⚠️',
  major_outage: '🔴',
  unknown: '❓',
};

export const devopsWatchStack = tool('devops_watch_stack', {
  description:
    'Check the health of a named vendor stack — a saved list of vendors representing your infrastructure dependencies. ' +
    'On the first call, provide vendors to define the stack; subsequent calls can omit vendors to reuse the persisted list. ' +
    'Returns a unified health snapshot with an aggregate rollup plus per-vendor detail. ' +
    'A vendor that cannot be resolved or reached is reported in its own row and left out of the saved stack, so one bad entry never discards the sweep. ' +
    'Ideal for morning status checks or pre-deploy sweeps. Multiple stacks can coexist (e.g., "production", "staging").',
  // Not read-only: providing `vendors` persists the stack list via ctx.state.set.
  // Not destructive: the only write is an upsert of the caller-named stack key.
  // Idempotent: repeating a call with the same arguments re-saves the same list.
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },

  input: z.object({
    vendors: z
      .array(
        z.string().describe('A vendor slug (e.g., "github") or raw Atlassian Statuspage base URL.'),
      )
      .optional()
      .describe(
        'Vendor slugs (e.g., "github", "aws") or raw Atlassian Statuspage base URLs. When provided, saves this list as the stack. When omitted, uses the previously saved list for stack_name.',
      ),
    stack_name: z
      .string()
      .default('default')
      .describe(
        'Name for this vendor stack. Defaults to "default". Use distinct names to manage multiple stacks (e.g., "production", "data-layer").',
      ),
    mode: z
      .enum(['summary', 'detailed'])
      .default('summary')
      .describe(
        'summary: indicator + degraded components + active incidents. detailed: adds component lists and maintenance windows.',
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
        'Maximum components returned per vendor in detailed mode (1-500). Large status pages publish hundreds of components, so a full stack at a high limit returns a very large response; narrow with component_filter instead where possible.',
      ),
  }),

  output: z.object({
    stack_name: z.string().describe('Name of the stack checked.'),
    health: z
      .enum(STACK_HEALTH_RUNGS)
      .describe(
        'Aggregate health rollup: all_operational = everything clear, maintenance = at least one vendor in a scheduled window and nothing worse open, degraded = at least one minor issue, partial_outage = at least one major issue, major_outage = at least one critical outage, unknown = at least one vendor could not be checked (unresolvable entry, blocked target, or failed fetch) and no checked vendor reported a worse issue. Never all_operational when any vendor errored or is in a window.',
      ),
    summary: z
      .object({
        total: z.number().describe('Total vendors in the stack.'),
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
            'Vendors that could not be checked (carry an error) — unresolvable entry, blocked target, or failed status fetch. Counted as unknown, never operational.',
          ),
      })
      .describe(
        'Aggregate health counts across all checked vendors. Buckets partition the stack: operational + degraded + down + maintenance + unavailable = total.',
      ),
    vendors: z.array(VendorResultSchema).describe('Per-vendor status results.'),
    stack_persisted: z
      .boolean()
      .describe(
        'True when the vendor list was saved to state on this call. Only the vendors that resolved are saved — see omitted_vendors.',
      ),
    omitted_vendors: z
      .array(z.string().describe('A vendor entry that cannot be part of a usable stack.'))
      .describe(
        'Entries that could not be resolved or whose URL was blocked; they still appear in vendors[] with an error. A call that saved the stack left them out of the write; a call that reused a saved stack leaves them in it until you re-provide the vendors list. Empty when every entry resolved.',
      ),
    checked_at: z.string().describe('ISO 8601 UTC timestamp of this check.'),
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
      .describe('Components returned across the stack. Present only when truncated.'),
    cap: z
      .number()
      .optional()
      .describe('The per-vendor component_limit that was applied. Present only when truncated.'),
    totalCount: z
      .number()
      .optional()
      .describe(
        'Components matching component_filter across the stack before the cap. Present only when truncated.',
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
      reason: 'no_stack',
      code: JsonRpcErrorCode.NotFound,
      when: 'No vendors provided and no saved stack found for stack_name.',
      recovery: 'Provide a vendors list to define the stack. It will be saved for future calls.',
    },
    {
      reason: 'vendor_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No vendor in the stack could be checked and the first failure was a slug that is not in the registry and is not a valid URL.',
      recovery:
        'Call devops_list_vendors to find available slugs or pass a full Statuspage base URL.',
    },
    {
      reason: 'target_blocked',
      code: JsonRpcErrorCode.ValidationError,
      when: 'No vendor in the stack could be checked and the first failure was a raw URL resolving to a private, loopback, or cloud-metadata address.',
      recovery:
        'Pass a publicly routable Statuspage URL. If internal monitoring is intentional, set DEVOPS_STATUS_ALLOW_PRIVATE_TARGETS=true.',
    },
    /**
     * Both entries fire only when nothing in the stack is checkable, which is also
     * the only case that skips the state write — a stack with no usable vendor is
     * never saved. A partially-resolvable list saves its resolvable subset and
     * reports the rest in omitted_vendors.
     */
  ],

  async handler(input, ctx) {
    const stateKey = `${STACK_STATE_PREFIX}${input.stack_name}`;
    const provided = input.vendors ?? [];
    let vendorList: string[];

    if (provided.length > 0) {
      vendorList = provided;
    } else {
      const saved = await ctx.state.get<string[]>(stateKey);
      if (!saved || saved.length === 0) {
        throw ctx.fail(
          'no_stack',
          `No saved stack found for "${input.stack_name}". Provide a vendors list.`,
          { ...ctx.recoveryFor('no_stack') },
        );
      }
      vendorList = saved;
    }

    const prepared = await prepareVendors(vendorList);

    // Nothing in the stack is checkable — degrade to the typed contract rather than
    // a stack of error rows, and write nothing. The message names every failure.
    const failures = prepared.filter((p): p is PreparedVendorFailure => !p.ok);
    if (failures.length === prepared.length) {
      const first = failures[0] as PreparedVendorFailure;
      throw ctx.fail(
        first.reason,
        `No vendor in "${input.stack_name}" could be checked. ${failures.map((f) => f.message).join(' ')}`,
        { ...ctx.recoveryFor(first.reason) },
      );
    }

    // Save only what resolved: persisting an unresolvable slug would put a permanent
    // error row in every future sweep of this stack. omitted_vendors names the drops
    // so the caller knows the saved stack is smaller than what they passed.
    const omittedVendors = failures.map((f) => f.input);
    let stackPersisted = false;
    if (provided.length > 0) {
      await ctx.state.set(
        stateKey,
        prepared.filter((p) => p.ok).map((p) => p.input),
      );
      stackPersisted = true;
    }

    const vendors = await fetchVendorResults(prepared, ctx, {
      mode: input.mode,
      componentLimit: input.component_limit,
      componentFilter: input.component_filter,
    });

    const summary = summarizeVendorResults(vendors);
    const health = computeStackHealth(vendors);
    ctx.log.info('Stack checked', {
      stack_name: input.stack_name,
      health,
      vendors: vendors.length,
      omitted: omittedVendors.length,
    });

    return {
      stack_name: input.stack_name,
      health,
      summary,
      vendors,
      stack_persisted: stackPersisted,
      omitted_vendors: omittedVendors,
      checked_at: new Date().toISOString(),
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## ${HEALTH_ICON[result.health]} Stack "${result.stack_name}" — ${result.health}`,
      `${result.summary.total} vendors | ✅ ${result.summary.operational} operational ⚠️ ${result.summary.degraded} degraded 🔴 ${result.summary.down} down 🛠️ ${result.summary.maintenance} maintenance ❓ ${result.summary.unavailable} unavailable`,
      result.stack_persisted ? '*(Stack list saved for future calls)*' : '',
    ];
    if (result.omitted_vendors.length > 0) {
      lines.push(
        `**Unusable entries:** ${result.omitted_vendors.join(', ')} — left out when the stack is saved; see the error on each below.`,
      );
    }
    lines.push('');
    for (const v of result.vendors) {
      lines.push(...renderVendorBlock(v), '');
    }
    lines.push(`*Stack checked: ${result.checked_at}*`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
