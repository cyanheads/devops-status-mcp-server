/**
 * @fileoverview Tool to check health of a named vendor stack, persisted via ctx.state where
 * the tenant identifies the caller.
 * @module mcp-server/tools/definitions/devops-watch-stack.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { config } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { clampMax } from '@/utils/input-bounds.js';
import type { PreparedVendorFailure, VendorResult } from './devops-vendor-result.js';
import {
  buildSuggestActionSuggestions,
  DEFAULT_COMPONENT_LIMIT,
  deferredVendorsSentence,
  fetchVendorResults,
  MAX_COMPONENT_LIMIT,
  MAX_VENDORS_INPUT,
  MAX_VENDORS_PER_CALL,
  NextToolSuggestionsSchema,
  prepareVendors,
  renderDeferredVendors,
  renderNextToolSuggestions,
  renderVendorBlock,
  splitVendors,
  summarizeVendorResults,
  VendorResultSchema,
  vendorRating,
} from './devops-vendor-result.js';

const STACK_STATE_PREFIX = 'stack/';

/**
 * Whether this deployment saves stacks: only where the `ctx.state` tenant identifies
 * the caller — stdio (one user per process) or HTTP with `jwt`/`oauth` (tenant from
 * the token). HTTP with `MCP_AUTH_MODE=none` runs every caller as tenant `default`, so
 * a stack saved there would be shared by all of them; the tool then reads and writes
 * no state. This mirrors the framework's own rule for assigning tenant `default`;
 * `ctx.tenantId === 'default'` alone cannot tell that case from stdio.
 */
export function stacksPersist(): boolean {
  return config.mcpTransportType === 'stdio' || config.mcpAuthMode !== 'none';
}

const NOT_PERSISTED_NOTICE =
  'This deployment does not save stacks because callers are not authenticated — pass vendors on every call.';

/**
 * The stack name is concatenated into a `ctx.state` key, and the framework's storage
 * layer accepts only `[a-zA-Z0-9_.-/]` with no `..`. Constraining it here rejects a
 * bad name against the parameter it came from, instead of letting a storage-layer
 * "Key contains invalid characters" surface where nothing names `stack_name`. The
 * accepted set matches the storage charset rather than narrowing it, so no name that
 * previously round-tripped is turned away; a separator must join two segments, which
 * is what excludes `..` and a leading or trailing `.` or `/`.
 */
const STACK_NAME_RE = /^[a-zA-Z0-9_-]+([./][a-zA-Z0-9_-]+)*$/;

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

/**
 * Roll the stack up from each checked vendor's rating — the worse of its indicator and its
 * worst open incident rated minor or worse — the same level `summary` counts it at.
 */
function computeStackHealth(results: VendorResult[]): StackHealth {
  const ratings = results.filter((r) => !r.error).map(vendorRating);
  if (ratings.some((i) => i === 'critical')) return 'major_outage';
  if (ratings.some((i) => i === 'major')) return 'partial_outage';
  if (ratings.some((i) => i === 'minor')) return 'degraded';
  // A vendor carrying a fetch error has an UNKNOWN status — never operational. Its
  // presence forces a non-green rollup, so an all-errored (or partially-errored)
  // stack can never fall through to all_operational.
  if (results.some((r) => r.error)) return 'unknown';
  // A published maintenance window is planned, so it ranks below every outage rung
  // and below unknown — but it is not unqualified health either, and all_operational
  // stays reserved for a stack with nothing open at all.
  if (ratings.some((i) => i === 'maintenance')) return 'maintenance';
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
    'Check the health of a named vendor stack — a saved list of vendors representing your infrastructure dependencies. On the first call, provide vendors to define the stack; subsequent calls can omit vendors to reuse the saved list. Stacks are saved per authenticated caller, or per local server process; a shared deployment that does not authenticate callers saves nothing, so there vendors is required on every call and the response says so. Up to 20 vendors are saved per stack and checked per call; use several stack names for a larger set. Returns a unified health snapshot with an aggregate rollup plus per-vendor detail. A vendor that cannot be resolved or reached is reported in its own row and left out of the saved stack, so one bad entry never discards the sweep. Every vendor with an active problem gets a pre-filled devops_suggest_action call in nextToolSuggestions. Ideal for morning status checks or pre-deploy sweeps. Multiple stacks can coexist (e.g., "production", "staging").',
  // Not read-only: providing `vendors` persists the stack list via ctx.state.set
  // wherever stacksPersist() holds.
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
      .max(MAX_VENDORS_INPUT)
      .optional()
      .describe(
        'Vendor slugs (e.g., "github", "aws") or raw Atlassian Statuspage base URLs. When provided, saves this list as the stack where stacks are saved; a list longer than 20 is then rejected and nothing is saved. When omitted, uses the previously saved list for stack_name; required on every call on a deployment that does not authenticate callers, which saves no stacks — there the first 20 are checked and the rest return in deferred_vendors. Lists longer than 100 are rejected.',
      ),
    stack_name: z
      .string()
      .min(1)
      .max(64)
      .regex(STACK_NAME_RE)
      .default('default')
      .describe(
        'Name for this vendor stack. Defaults to "default". Use distinct names to manage multiple stacks (e.g., "production", "data-layer"). Letters, digits, hyphens, and underscores, optionally separated by single dots or slashes ("prod.eu", "team/prod"); 1-64 characters. No spaces or colons.',
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
        'Case-insensitive substring matched against component names and their group names in detailed mode (e.g., "api" to check just the API components, or a product or region a page groups components under). Applied before component_limit, so it reaches a specific component the cap would otherwise omit; a capped vendor\'s full list continues in devops_status_check from its next_component_offset. A filter that matches nothing for a vendor is reported in notice. Ignored in summary mode.',
      ),
    component_limit: z
      .number()
      .int()
      .min(1)
      .default(DEFAULT_COMPONENT_LIMIT)
      .describe(
        `Maximum components returned per vendor in detailed mode, at least 1. A value above ${MAX_COMPONENT_LIMIT} is reduced to ${MAX_COMPONENT_LIMIT}, and notice says so. Large status pages publish hundreds of components, so a full stack at a high limit returns a very large response; narrow with component_filter instead where possible.`,
      ),
  }),

  output: z.object({
    stack_name: z.string().describe('Name of the stack checked.'),
    health: z
      .enum(STACK_HEALTH_RUNGS)
      .describe(
        "Aggregate health rollup over each checked vendor's rating — the worse of its indicator and its worst open incident rated minor or worse — taking the worst rung that applies: major_outage = a vendor rated critical, partial_outage = a vendor rated major, degraded = a vendor rated minor, unknown = at least one vendor could not be checked (unresolvable entry, blocked target, or failed fetch) and none rated worse, maintenance = a vendor in a scheduled window and nothing worse, all_operational = every vendor checked and rated none. Never all_operational when any vendor errored, is in a window, or has an open incident rated minor or worse.",
      ),
    summary: z
      .object({
        total: z
          .number()
          .describe('Total vendors checked on this call — never counts deferred_vendors.'),
        operational: z
          .number()
          .describe(
            'Vendors rated none — indicator none and no open incident rated minor or worse — and not errored.',
          ),
        degraded: z.number().describe('Vendors rated minor or major.'),
        down: z.number().describe('Vendors rated critical.'),
        maintenance: z
          .number()
          .describe(
            'Vendors rated maintenance — in a scheduled window the vendor published, with no open incident rated minor or worse. Counted apart from degraded and down, which are faults.',
          ),
        unavailable: z
          .number()
          .describe(
            'Vendors that could not be checked (carry an error) — unresolvable entry, blocked target, or failed status fetch. Counted as unknown, never operational.',
          ),
      })
      .describe(
        'Aggregate health counts across all checked vendors. Each vendor is rated by the worse of its indicator and its worst open incident rated minor or worse; an incident rated none or maintenance never raises the rating. Buckets partition the stack: operational + degraded + down + maintenance + unavailable = total.',
      ),
    vendors: z
      .array(VendorResultSchema)
      .describe('Per-vendor status results for the vendors checked, in stack order.'),
    deferred_vendors: z
      .array(z.string().describe('A vendor entry exactly as provided or saved.'))
      .describe(
        'Entries past the first 20, verbatim and in order, that were not checked on this call: the rest of a passed vendors list on a deployment that saves no stacks, or of a saved stack holding more than 20. Resend them in another call. Empty when every entry was checked.',
      ),
    stack_persisted: z
      .boolean()
      .describe(
        'True when the vendor list was saved on this call. Only the vendors that resolved are saved — see omitted_vendors. Always false on a deployment that does not authenticate callers, which saves no stacks (persistence_notice says so).',
      ),
    omitted_vendors: z
      .array(z.string().describe('A vendor entry that cannot be part of a usable stack.'))
      .describe(
        'Entries that could not be resolved or whose URL was blocked; they still appear in vendors[] with an error. A call that saved the stack left them out of the write; a call that reused a saved stack leaves them in it until you re-provide the vendors list. Empty when every entry resolved.',
      ),
    checked_at: z.string().describe('ISO 8601 UTC timestamp of this check.'),
    nextToolSuggestions: NextToolSuggestionsSchema,
  }),

  enrichment: {
    // Populated only via ctx.enrich when a component list is actually capped, when notice
    // has something to say, or when stacks are not saved — all fields must be optional so
    // a plain result passes the effective-output parse.
    truncated: z
      .boolean()
      .optional()
      .describe(
        "True when at least one vendor's component list was capped at component_limit — those vendors carry next_component_offset. Absent when nothing was capped.",
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
        'Plain-language explanation of what this call left out or adjusted, in this order: vendors past the first 20 (listed in deferred_vendors), and for a saved stack how to sweep every one; a component_limit above 500 reduced to 500; in detailed mode, how many components the cap omitted and how to reach them (devops_status_check with that vendor and its next_component_offset as component_offset, component_filter to target one, or component_limit to raise a cap below 500), and which checked vendors component_filter matched no component of, with how many each publishes; and last, for a vendor whose entry reads an umbrella status page with no components (atlassian), the slugs of the entries reading its product pages. Present only when one of these applies.',
      ),
    persistence_notice: z
      .string()
      .optional()
      .describe(
        'Present when this deployment saves no stacks because callers are not authenticated: nothing was saved, and vendors must be passed on every call.',
      ),
  },

  enrichmentTrailer: {
    persistence_notice: { render: (notice) => `> ${notice}` },
  },

  errors: [
    {
      reason: 'no_stack',
      code: JsonRpcErrorCode.NotFound,
      when: 'No vendors provided and no saved stack found for stack_name.',
      recovery: 'Provide a vendors list to define the stack. It will be saved for future calls.',
    },
    {
      reason: 'vendors_required',
      code: JsonRpcErrorCode.ValidationError,
      when: 'No vendors provided on a deployment that saves no stacks because callers are not authenticated',
      recovery:
        'Pass the vendors list on every call — this deployment does not save stacks between calls.',
    },
    /**
     * Saving the first 20 of a longer list would store a stack the caller didn't ask
     * for, so a save over the cap rejects whole. Where nothing is saved the call is a
     * read, and the same list is checked 20 at a time with the rest deferred instead.
     */
    {
      reason: 'stack_too_large',
      code: JsonRpcErrorCode.ValidationError,
      when: 'More than 20 vendors were provided on a deployment that saves stacks, so nothing was saved',
      recovery:
        'Pass at most 20 vendors per stack, and save a larger set under several stack_name values.',
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
     * the only case that skips the state write where stacks persist — a stack with no
     * usable vendor is never saved. A partially-resolvable list saves its resolvable
     * subset and reports the rest in omitted_vendors.
     */
  ],

  async handler(input, ctx) {
    const stateKey = `${STACK_STATE_PREFIX}${input.stack_name}`;
    const provided = input.vendors ?? [];
    const persist = stacksPersist();
    let vendorList: string[];

    if (persist && provided.length > MAX_VENDORS_PER_CALL) {
      throw ctx.fail(
        'stack_too_large',
        `${provided.length} vendors were provided for "${input.stack_name}"; a saved stack holds at most ${MAX_VENDORS_PER_CALL}. Nothing was saved.`,
      );
    }

    if (provided.length > 0) {
      vendorList = provided;
    } else if (!persist) {
      throw ctx.fail(
        'vendors_required',
        `No vendors provided for "${input.stack_name}", and this deployment does not save stacks.`,
      );
    } else {
      const saved = await ctx.state.get<string[]>(stateKey);
      if (!saved || saved.length === 0) {
        throw ctx.fail(
          'no_stack',
          `No saved stack found for "${input.stack_name}". Provide a vendors list.`,
        );
      }
      vendorList = saved;
    }

    // A save over the cap was rejected above, so only a read reaches here with more than 20.
    const batch = splitVendors(vendorList);
    const componentLimit = clampMax('component_limit', input.component_limit, MAX_COMPONENT_LIMIT);
    const prepared = await prepareVendors(batch.served);

    // Nothing in the stack is checkable — degrade to the typed contract rather than
    // a stack of error rows, and write nothing. The message names every failure,
    // and any deferred entries, which an error response has no field for.
    const failures = prepared.filter((p): p is PreparedVendorFailure => !p.ok);
    if (failures.length === prepared.length) {
      const first = failures[0] as PreparedVendorFailure;
      throw ctx.fail(
        first.reason,
        `No vendor in "${input.stack_name}" could be checked. ${failures.map((f) => f.message).join(' ')}${deferredVendorsSentence(batch.deferred)}`,
      );
    }

    const leadNotices: string[] = [];
    if (batch.notice) {
      leadNotices.push(batch.notice);
      // Resending the rest as vendors would overwrite the saved stack, so say how to keep it whole.
      if (provided.length === 0) {
        leadNotices.push(
          `The saved stack "${input.stack_name}" holds ${vendorList.length} vendors; save them under several stack names of at most ${MAX_VENDORS_PER_CALL} each to sweep every one.`,
        );
      }
    }
    if (componentLimit.notice) leadNotices.push(componentLimit.notice);

    // Save only what resolved: persisting an unresolvable slug would put a permanent
    // error row in every future sweep of this stack. omitted_vendors names the drops
    // so the caller knows the saved stack is smaller than what they passed.
    const omittedVendors = failures.map((f) => f.input);
    let stackPersisted = false;
    if (!persist) {
      ctx.enrich({ persistence_notice: NOT_PERSISTED_NOTICE });
    } else if (provided.length > 0) {
      await ctx.state.set(
        stateKey,
        prepared.filter((p) => p.ok).map((p) => p.input),
      );
      stackPersisted = true;
    }

    const vendors = await fetchVendorResults(
      prepared,
      ctx,
      {
        mode: input.mode,
        componentLimit: componentLimit.value,
        // A sweep always reads from the first component; capped lists continue in devops_status_check.
        componentOffset: 0,
        componentFilter: input.component_filter,
      },
      leadNotices,
    );

    const summary = summarizeVendorResults(vendors);
    const health = computeStackHealth(vendors);
    ctx.log.info('Stack checked', {
      stack_name: input.stack_name,
      health,
      vendors: vendors.length,
      omitted: omittedVendors.length,
      deferred: batch.deferred.length,
    });

    return {
      stack_name: input.stack_name,
      health,
      summary,
      vendors,
      deferred_vendors: batch.deferred,
      stack_persisted: stackPersisted,
      omitted_vendors: omittedVendors,
      checked_at: new Date().toISOString(),
      nextToolSuggestions: buildSuggestActionSuggestions(prepared, vendors),
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
    lines.push(...renderDeferredVendors(result.deferred_vendors), '');
    for (const v of result.vendors) {
      lines.push(...renderVendorBlock(v), '');
    }
    lines.push(...renderNextToolSuggestions(result.nextToolSuggestions));
    lines.push(`*Stack checked: ${result.checked_at}*`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
