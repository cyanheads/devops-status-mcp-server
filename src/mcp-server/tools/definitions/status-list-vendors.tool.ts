/**
 * @fileoverview Tool to list vendors in the built-in registry, with optional filtering.
 * @module mcp-server/tools/definitions/status-list-vendors.tool
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

export const statusListVendors = tool('status_list_vendors', {
  description:
    'List vendors in the built-in registry, optionally filtered by category or name search. ' +
    'Returns slug, display name, category, and Statuspage base URL for each entry. ' +
    'Use to discover the correct slug to pass to other tools, or to see which vendors are available before configuring a stack.',
  annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },

  input: z.object({
    query: z
      .string()
      .optional()
      .describe(
        'Free-text search against vendor name and slug. Case-insensitive. E.g., "cloud", "auth", "slack".',
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
            statuspage_url: z.string().describe('Statuspage base URL used to fetch status data.'),
          })
          .describe('A vendor entry from the built-in registry.'),
      )
      .describe('Matching vendors from the built-in registry.'),
    total: z.number().describe('Total number of vendors returned.'),
    categories: z
      .array(z.string())
      .describe('All available category values for use in the category filter.'),
  }),

  handler(input, ctx) {
    const registry = getVendorRegistryService();
    const vendors = registry.search(input.query, input.category);
    const categories = registry.getCategories();
    ctx.log.debug('Listed vendors', {
      query: input.query,
      category: input.category,
      count: vendors.length,
    });
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
    const lines: string[] = [
      `**${result.total} vendors** | Categories: ${result.categories.join(', ')}\n`,
    ];
    for (const v of result.vendors) {
      lines.push(`**${v.slug}** — ${v.name} [${v.category}] ${v.statuspage_url}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
