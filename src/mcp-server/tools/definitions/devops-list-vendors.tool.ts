/**
 * @fileoverview Tool to list vendors in the built-in registry, with optional filtering.
 * @module mcp-server/tools/definitions/devops-list-vendors.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getVendorRegistryService } from '@/services/vendor-registry/vendor-registry-service.js';

const CATEGORIES = [
  'cloud',
  'cdn-edge',
  'dev-platform',
  'data',
  'comms',
  'auth',
  'monitoring',
  'ai',
] as const;

/**
 * Explain an empty result: list the vendors the query matches outside the requested
 * category when there are any, otherwise route to browsing the registry or to a raw
 * Statuspage URL, which the status tools accept for vendors the registry lacks.
 */
function emptyResultNotice(query: string, category: string | undefined): string {
  const registry = getVendorRegistryService();
  const outside = category ? registry.search(query) : [];
  if (category && outside.length > 0) {
    const listed = outside.map((v) => `${v.slug} (${v.category})`).join(', ');
    return `No vendor in category "${category}" has a slug or display name containing "${query}"; outside it: ${listed}. Drop category to see them.`;
  }
  const miss = category
    ? `No registry vendor's slug or display name contains "${query}", in category "${category}" or any other.`
    : `No registry vendor's slug or display name contains "${query}".`;
  return (
    `${miss} Call devops_list_vendors with no arguments to browse all ${registry.getAll().length} vendors. ` +
    "A vendor outside the registry still works if its status page runs on Atlassian Statuspage: pass the page's base URL (e.g., https://status.example.com) as the vendor to devops_status_check, devops_get_incidents, or devops_watch_stack."
  );
}

export const devopsListVendors = tool('devops_list_vendors', {
  description:
    'List vendors in the built-in registry, optionally filtered by category or name search. Returns slug, display name, category, and status page URL for each entry. Use to discover the correct slug to pass to other tools, or to see which vendors are available before configuring a stack.',
  annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },

  input: z.object({
    query: z
      .string()
      .optional()
      .describe(
        'Substring search against vendor slug and display name. Case-insensitive; surrounding whitespace is ignored. E.g., "cloud", "auth", "slack".',
      ),
    category: z
      .enum(CATEGORIES)
      .optional()
      .describe(
        'Filter to one category: cloud, cdn-edge, dev-platform, data, comms, auth, monitoring, or ai.',
      ),
  }),

  output: z.object({
    vendors: z
      .array(
        z
          .object({
            slug: z.string().describe('Use this as the vendor identifier in other tools.'),
            name: z.string().describe('Display name of the vendor.'),
            category: z.string().describe('Vendor category (e.g., "dev-platform", "ai").'),
            statuspage_url: z
              .string()
              .describe(
                'Status page base URL — the Statuspage API base for Statuspage-backed vendors, the public status page URL for adapter-backed vendors (aws, gcp, azure, azure-devops, gitlab, slack, neon, redis-cloud).',
              ),
          })
          .describe('A vendor entry from the built-in registry.'),
      )
      .describe('Matching vendors from the built-in registry.'),
    total: z.number().describe('Total number of vendors returned.'),
    categories: z
      .array(z.string())
      .describe('All available category values for use in the category filter.'),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Why nothing matched and what to call next. Present only when vendors is empty.'),
  },

  handler(input, ctx) {
    const registry = getVendorRegistryService();
    const vendors = registry.search(input.query, input.category);
    const categories = registry.getCategories();
    ctx.log.debug('Listed vendors', {
      query: input.query,
      category: input.category,
      count: vendors.length,
    });
    // Every category has entries, so only a query can empty the result.
    if (vendors.length === 0) {
      ctx.enrich.notice(emptyResultNotice(input.query?.trim() ?? '', input.category));
    }
    return {
      vendors: vendors.map((v) => ({
        slug: v.slug,
        name: v.name,
        category: v.category,
        statuspage_url: v.statuspage_url,
      })),
      total: vendors.length,
      categories,
    };
  },

  format: (result) => {
    // The why and the next step ride in the notice enrichment, which the framework
    // renders into content[] after this block.
    if (result.total === 0) return [{ type: 'text', text: 'No vendors matched.' }];
    const lines: string[] = [
      `**${result.total} vendors** | Categories: ${result.categories.join(', ')}\n`,
    ];
    for (const v of result.vendors) {
      lines.push(`**${v.slug}** — ${v.name} [${v.category}] ${v.statuspage_url}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
