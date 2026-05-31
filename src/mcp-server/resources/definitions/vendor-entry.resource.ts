/**
 * @fileoverview Resource for fetching a full vendor registry entry by slug.
 * @module mcp-server/resources/definitions/vendor-entry.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { notFound } from '@cyanheads/mcp-ts-core/errors';
import { getVendorRegistryService } from '@/services/vendor-registry/vendor-registry-service.js';

export const vendorEntryResource = resource('devops-status://vendors/{name}', {
  name: 'devops-status-vendor',
  description:
    'Full registry entry for a vendor by slug — Statuspage base URL, category, and API type. ' +
    'Read-only, stable. Use devops_list_vendors to discover available slugs.',
  mimeType: 'application/json',

  params: z.object({
    name: z.string().describe('Vendor slug (e.g., "github", "cloudflare"). Case-insensitive.'),
  }),

  output: z.object({
    slug: z.string().describe('Canonical vendor slug used as identifier in all tools.'),
    name: z.string().describe('Display name of the vendor.'),
    category: z.string().describe('Vendor category (e.g., "dev-platform", "ai").'),
    statuspage_url: z.string().describe('Statuspage base URL used to fetch status data.'),
    api_type: z.string().describe('API type — "statuspage" for Atlassian Statuspage.'),
  }),

  handler(params) {
    const entry = getVendorRegistryService().getBySlug(params.name);
    if (!entry) {
      throw notFound(
        `Vendor "${params.name}" not found in the built-in registry. Use devops_list_vendors to discover available slugs.`,
        { slug: params.name },
      );
    }
    return {
      slug: entry.slug,
      name: entry.name,
      category: entry.category,
      statuspage_url: entry.statuspage_url,
      api_type: entry.api_type,
    };
  },
});
