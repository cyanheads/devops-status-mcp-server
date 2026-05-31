/**
 * @fileoverview Tool to check current health status for one or more vendors via Statuspage.
 * @module mcp-server/tools/definitions/devops-status-check.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getStatuspageService } from '@/services/statuspage/statuspage-service.js';
import { getVendorRegistryService } from '@/services/vendor-registry/vendor-registry-service.js';
import { assertSafeUrl } from '@/utils/ssrf-guard.js';
import type { VendorResult } from './devops-vendor-result.js';
import {
  buildVendorResult,
  renderVendorBlock,
  VendorResultSchema,
} from './devops-vendor-result.js';

export const devopsStatusCheck = tool('devops_status_check', {
  description:
    'Check the current health status for one or more vendors. Accepts registered vendor slugs ' +
    '(e.g., "github", "cloudflare") or raw Statuspage base URLs. Returns per-vendor operational ' +
    'indicator (none = all clear, minor, major, critical), degraded components, and active incidents. ' +
    'Use mode: "detailed" for full component lists and maintenance windows. Batch-friendly — pass a list to check your full stack in one call.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    vendors: z
      .array(
        z.string().min(1).describe('A vendor slug (e.g., "github") or raw Statuspage base URL.'),
      )
      .min(1)
      .max(20)
      .describe(
        'Vendor slugs from the built-in registry (e.g., "github", "cloudflare") or raw Statuspage base URLs. Mix freely. Use devops_list_vendors to discover available slugs.',
      ),
    mode: z
      .enum(['summary', 'detailed'])
      .default('summary')
      .describe(
        'summary: indicator + degraded components + active incidents only. detailed: adds full component list and scheduled maintenance windows.',
      ),
  }),

  output: z.object({
    results: z
      .array(VendorResultSchema)
      .describe('Per-vendor status results in the same order as the input vendors list.'),
    summary: z
      .object({
        total: z.number().describe('Total number of vendors checked.'),
        operational: z.number().describe('Vendors with indicator = none.'),
        degraded: z.number().describe('Vendors with indicator = minor or major.'),
        down: z.number().describe('Vendors with indicator = critical.'),
      })
      .describe('Aggregate health counts across all checked vendors.'),
  }),

  errors: [
    {
      reason: 'vendor_not_found',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'A vendor slug does not match any entry in the built-in registry and is not a valid URL.',
      recovery:
        'Call devops_list_vendors to browse available slugs, or pass a full Statuspage base URL (e.g., "https://www.githubstatus.com").',
    },
    {
      reason: 'target_blocked',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'A raw URL resolves to a private, loopback, or cloud-metadata address.',
      recovery:
        'Pass a publicly routable Statuspage URL. If internal monitoring is intentional, set DEVOPS_STATUS_ALLOW_PRIVATE_TARGETS=true.',
    },
    {
      reason: 'statuspage_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'A Statuspage endpoint returned an error or timed out.',
      recovery:
        'The vendor status page may be unreachable. Retry after 30s. If it persists, check the URL directly in a browser.',
      retryable: true,
    },
  ],

  async handler(input, ctx) {
    const registry = getVendorRegistryService();
    const statuspage = getStatuspageService();

    // Validate all vendors first
    const resolved = input.vendors.map((v) => {
      const r = registry.resolve(v);
      if (!r)
        throw ctx.fail(
          'vendor_not_found',
          `"${v}" is not a known vendor slug and is not a valid URL. Call devops_list_vendors to browse.`,
        );
      return { input: v, ...r };
    });

    // SSRF guard: only raw URL inputs need checking — registry entries are pre-verified public URLs.
    for (const r of resolved) {
      if (r.slug === null) {
        try {
          await assertSafeUrl(r.url);
        } catch (err) {
          const msg = (err as Error).message;
          if (msg.startsWith('SSRF_BLOCKED')) {
            throw ctx.fail('target_blocked', msg.replace('SSRF_BLOCKED: ', ''));
          }
          throw err;
        }
      }
    }

    const fetched = await Promise.allSettled(
      resolved.map(async (r) => {
        const { data, cached } = await statuspage.fetchSummary(r.url);
        return buildVendorResult(r.input, r.url, r.name, data, cached, input.mode);
      }),
    );

    const results: VendorResult[] = fetched.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      // i is always in bounds — fetched and resolved have the same length
      const res = resolved[i] as (typeof resolved)[number];
      return {
        vendor: res.input,
        name: res.name,
        indicator: 'none' as const,
        description: 'Unknown',
        degraded_components: [],
        active_incidents: [],
        cached: false,
        checked_at: new Date().toISOString(),
        statuspage_url: res.url,
        error: (r.reason as Error).message,
      };
    });

    const summary = {
      total: results.length,
      operational: results.filter((r) => r.indicator === 'none' && !r.error).length,
      degraded: results.filter((r) => r.indicator === 'minor' || r.indicator === 'major').length,
      down: results.filter((r) => r.indicator === 'critical').length,
    };

    ctx.log.info('Status check completed', { vendors: input.vendors.length, ...summary });
    return { results, summary };
  },

  format: (result) => {
    const lines: string[] = [
      `## Stack Health — ${result.summary.total} vendors checked`,
      `✅ ${result.summary.operational} operational  ⚠️ ${result.summary.degraded} degraded  🔴 ${result.summary.down} down`,
      '',
    ];
    for (const v of result.results) {
      lines.push(...renderVendorBlock(v), '');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
