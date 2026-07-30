/**
 * @fileoverview Tool to check health of a named vendor stack, persisted via ctx.state.
 * @module mcp-server/tools/definitions/devops-watch-stack.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { fetchVendorSummary } from '@/services/status-adapters/status-dispatch.js';
import { getVendorRegistryService } from '@/services/vendor-registry/vendor-registry-service.js';
import { assertSafeUrl } from '@/utils/ssrf-guard.js';
import type { VendorResult } from './devops-vendor-result.js';
import {
  buildVendorResult,
  renderVendorBlock,
  VendorResultSchema,
  vendorErrorMessage,
} from './devops-vendor-result.js';

const STACK_STATE_PREFIX = 'stack/';

function computeStackHealth(
  results: VendorResult[],
): 'all_operational' | 'degraded' | 'partial_outage' | 'major_outage' | 'unknown' {
  const indicators = results.filter((r) => !r.error).map((r) => r.indicator);
  if (indicators.some((i) => i === 'critical')) return 'major_outage';
  if (indicators.some((i) => i === 'major')) return 'partial_outage';
  if (indicators.some((i) => i === 'minor')) return 'degraded';
  // A vendor carrying a fetch error has an UNKNOWN status — never operational. Its
  // presence forces a non-green rollup, so an all-errored (or partially-errored)
  // stack can never fall through to all_operational.
  if (results.some((r) => r.error)) return 'unknown';
  return 'all_operational';
}

export const devopsWatchStack = tool('devops_watch_stack', {
  description:
    'Check the health of a named vendor stack — a saved list of vendors representing your infrastructure dependencies. ' +
    'On the first call, provide vendors to define the stack; subsequent calls can omit vendors to reuse the persisted list. ' +
    'Returns a unified health snapshot with an aggregate rollup plus per-vendor detail. ' +
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
        'summary: indicator + degraded components + active incidents. detailed: adds full component lists and maintenance windows.',
      ),
  }),

  output: z.object({
    stack_name: z.string().describe('Name of the stack checked.'),
    health: z
      .enum(['all_operational', 'degraded', 'partial_outage', 'major_outage', 'unknown'])
      .describe(
        'Aggregate health rollup: all_operational = everything clear, degraded = at least one minor issue, partial_outage = at least one major issue, major_outage = at least one critical outage, unknown = at least one vendor could not be checked (fetch error) and no checked vendor reported a worse issue. Never all_operational when any vendor errored.',
      ),
    summary: z
      .object({
        total: z.number().describe('Total vendors in the stack.'),
        operational: z.number().describe('Vendors with indicator = none and no fetch error.'),
        degraded: z.number().describe('Vendors with indicator = minor or major.'),
        down: z.number().describe('Vendors with indicator = critical.'),
        unavailable: z
          .number()
          .describe(
            'Vendors whose status could not be fetched (carry an error). Counted as unknown — never operational.',
          ),
      })
      .describe(
        'Aggregate health counts across all checked vendors. Buckets partition the stack: operational + degraded + down + unavailable = total.',
      ),
    vendors: z.array(VendorResultSchema).describe('Per-vendor status results.'),
    stack_persisted: z
      .boolean()
      .describe('True when the vendor list was saved to state on this call.'),
    checked_at: z.string().describe('ISO 8601 UTC timestamp of this check.'),
  }),

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
      when: 'A vendor slug is not in the registry and is not a valid URL.',
      recovery:
        'Call devops_list_vendors to find available slugs or pass a full Statuspage base URL.',
    },
    {
      reason: 'target_blocked',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A raw URL in the stack resolves to a private, loopback, or cloud-metadata address.',
      recovery:
        'Pass a publicly routable Statuspage URL. If internal monitoring is intentional, set DEVOPS_STATUS_ALLOW_PRIVATE_TARGETS=true.',
    },
  ],

  async handler(input, ctx) {
    const registry = getVendorRegistryService();

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

    // Validate all vendors
    const resolved = vendorList.map((v) => {
      const target = registry.resolve(v);
      if (!target)
        throw ctx.fail(
          'vendor_not_found',
          `"${v}" is not a known vendor slug and is not a valid URL.`,
          { ...ctx.recoveryFor('vendor_not_found') },
        );
      return { input: v, target };
    });

    // SSRF guard: only raw URL inputs need checking — registry entries are pre-verified public URLs.
    for (const r of resolved) {
      if (r.target.slug === null) {
        try {
          await assertSafeUrl(r.target.url);
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
    }

    // Persist only after resolution + SSRF validation succeed, so a failed call
    // never poisons a saved stack. stack_persisted reflects the actual write.
    let stackPersisted = false;
    if (provided.length > 0) {
      await ctx.state.set(stateKey, vendorList);
      stackPersisted = true;
    }

    const fetched = await Promise.allSettled(
      resolved.map(async (r) => {
        const { data, cached } = await fetchVendorSummary(r.target);
        return buildVendorResult(r.input, r.target.url, r.target.name, data, cached, input.mode);
      }),
    );

    const vendors: VendorResult[] = fetched.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      const res = resolved[i];
      return {
        vendor: res?.input ?? '',
        name: res?.target.name ?? '',
        indicator: 'none' as const,
        description: 'Unknown',
        degraded_components: [],
        active_incidents: [],
        cached: false,
        checked_at: new Date().toISOString(),
        statuspage_url: res?.target.url ?? '',
        error: vendorErrorMessage(r.reason),
      };
    });

    const summary = {
      total: vendors.length,
      operational: vendors.filter((v) => v.indicator === 'none' && !v.error).length,
      degraded: vendors.filter((v) => v.indicator === 'minor' || v.indicator === 'major').length,
      down: vendors.filter((v) => v.indicator === 'critical').length,
      unavailable: vendors.filter((v) => v.error !== undefined).length,
    };

    const health = computeStackHealth(vendors);
    ctx.log.info('Stack checked', {
      stack_name: input.stack_name,
      health,
      vendors: vendors.length,
    });

    return {
      stack_name: input.stack_name,
      health,
      summary,
      vendors,
      stack_persisted: stackPersisted,
      checked_at: new Date().toISOString(),
    };
  },

  format: (result) => {
    const healthIcon =
      result.health === 'all_operational'
        ? '✅'
        : result.health === 'major_outage'
          ? '🔴'
          : result.health === 'unknown'
            ? '❓'
            : '⚠️';
    const lines: string[] = [
      `## ${healthIcon} Stack "${result.stack_name}" — ${result.health}`,
      `${result.summary.total} vendors | ✅ ${result.summary.operational} operational ⚠️ ${result.summary.degraded} degraded 🔴 ${result.summary.down} down ❓ ${result.summary.unavailable} unavailable`,
      result.stack_persisted ? '*(Stack list saved for future calls)*' : '',
      '',
    ];
    for (const v of result.vendors) {
      lines.push(...renderVendorBlock(v), '');
    }
    lines.push(`*Stack checked: ${result.checked_at}*`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
