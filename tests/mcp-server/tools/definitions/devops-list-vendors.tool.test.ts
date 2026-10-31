/**
 * @fileoverview Tests for the devops_list_vendors tool.
 * @module tests/mcp-server/tools/definitions/devops-list-vendors.tool.test
 */

import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { VENDOR_REGISTRY, type VendorEntry } from '@/data/vendor-registry.js';
import { devopsListVendors } from '@/mcp-server/tools/definitions/devops-list-vendors.tool.js';
import {
  getVendorRegistryService,
  initVendorRegistryService,
} from '@/services/vendor-registry/vendor-registry-service.js';

beforeAll(() => {
  initVendorRegistryService();
});

function contentText(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
}

describe('devopsListVendors', () => {
  it('returns all vendors when no filters provided', async () => {
    const ctx = createMockContext();
    const input = devopsListVendors.input.parse({});
    const result = await devopsListVendors.handler(input, ctx);
    expect(result.vendors.length).toBeGreaterThan(10);
    expect(result.total).toBe(result.vendors.length);
    expect(result.categories.length).toBeGreaterThan(0);
    for (const v of result.vendors) {
      expect(v.slug).toBeTruthy();
      expect(v.name).toBeTruthy();
      expect(v.category).toBeTruthy();
      expect(v.statuspage_url).toContain('http');
    }
  });

  it('filters by category', async () => {
    const ctx = createMockContext();
    const input = devopsListVendors.input.parse({ category: 'ai' });
    const result = await devopsListVendors.handler(input, ctx);
    expect(result.total).toBeGreaterThan(0);
    for (const v of result.vendors) {
      expect(v.category).toBe('ai');
    }
  });

  it('filters by query (case-insensitive)', async () => {
    const ctx = createMockContext();
    const input = devopsListVendors.input.parse({ query: 'github' });
    const result = await devopsListVendors.handler(input, ctx);
    expect(result.total).toBeGreaterThan(0);
    expect(result.vendors.some((v) => v.slug === 'github')).toBe(true);
  });

  it('lists the atlassian umbrella and its ten product entries for "atlassian" (#74)', async () => {
    const result = await runToolContract(devopsListVendors, { query: 'atlassian' });
    const structured = result.structuredContent as {
      vendors: Array<{ slug: string; name: string }>;
      total: number;
    };
    expect(structured.total).toBe(11);
    expect(structured.vendors.map((v) => v.slug).sort()).toEqual(
      [
        'atlassian',
        'atlassian-compass',
        'atlassian-developer',
        'atlassian-guard',
        'atlassian-statuspage',
        'bitbucket',
        'confluence',
        'jira',
        'jira-service-management',
        'opsgenie',
        'trello',
      ].sort(),
    );
    expect(structured.vendors.find((v) => v.slug === 'atlassian')?.name).toBe(
      'Atlassian (cross-product incidents)',
    );

    const jira = await runToolContract(devopsListVendors, { query: 'jira' });
    expect(
      (jira.structuredContent as { vendors: Array<{ slug: string }> }).vendors.map((v) => v.slug),
    ).toEqual(['jira', 'jira-service-management']);
  });

  it('returns empty list for non-matching query', async () => {
    const ctx = createMockContext();
    const input = devopsListVendors.input.parse({ query: 'zzz-nonexistent-xyz-abc' });
    const result = await devopsListVendors.handler(input, ctx);
    expect(result.total).toBe(0);
    expect(result.vendors).toHaveLength(0);
  });

  it('formats an empty result with a reason and next step (#17)', async () => {
    // The reason and next step moved from format() to the notice enrichment (#73),
    // which the framework renders into content[] after format()'s own line.
    const result = await runToolContract(devopsListVendors, { query: 'zzz-nonexistent-xyz-abc' });
    const text = contentText(result);
    expect(text).toMatch(/no vendors matched/i);
    expect(text).toContain('"zzz-nonexistent-xyz-abc"');
    expect(text).toContain('Call devops_list_vendors with no arguments');
  });

  it('formats output with slugs and categories', async () => {
    const ctx = createMockContext();
    const input = devopsListVendors.input.parse({ category: 'cloud' });
    const result = await devopsListVendors.handler(input, ctx);
    const blocks = devopsListVendors.format!(result);
    expect(blocks).toHaveLength(1);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('cloud');
    // Each vendor should appear in the output
    for (const v of result.vendors) {
      expect(text).toContain(v.slug);
    }
  });

  describe('empty-result notice (#73)', () => {
    const contains = (v: VendorEntry, query: string) =>
      v.slug.includes(query) || v.name.toLowerCase().includes(query);
    const routing = () =>
      ` Call devops_list_vendors with no arguments to browse all ${getVendorRegistryService().getAll().length} vendors. A vendor outside the registry still works if its status page runs on Atlassian Statuspage: pass the page's base URL (e.g., https://status.example.com) as the vendor to devops_status_check, devops_get_incidents, or devops_watch_stack.`;

    /** Asserts the notice reaches structuredContent and appears exactly once in content[]. */
    async function expectNotice(input: Record<string, unknown>, notice: string) {
      const result = await runToolContract(devopsListVendors, input);
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({
        vendors: [],
        total: 0,
        categories: getVendorRegistryService().getCategories(),
        notice,
      });
      const text = contentText(result);
      expect(text).toContain('No vendors matched.');
      expect(text.split(notice)).toHaveLength(2);
      expect(text).not.toContain('Clear or broaden');
    }

    it('declares notice as an optional enrichment field', () => {
      expect(Object.keys(devopsListVendors.enrichment ?? {})).toEqual(['notice']);
      expect(devopsListVendors.enrichment!.notice.safeParse(undefined).success).toBe(true);
    });

    it('a query matching nothing names the query and routes to browsing or a raw URL', async () => {
      expect(VENDOR_REGISTRY.some((v) => contains(v, 'fastly'))).toBe(false);
      await expectNotice(
        { query: 'fastly' },
        `No registry vendor's slug or display name contains "fastly".${routing()}`,
      );
    });

    it('reads the registry size at runtime rather than a fixed count', async () => {
      // A registry of 7 entries, a size no fixed count in the tool could match.
      const getAll = vi
        .spyOn(getVendorRegistryService(), 'getAll')
        .mockReturnValue(VENDOR_REGISTRY.slice(0, 7));
      try {
        const result = await runToolContract(devopsListVendors, { query: 'fastly' });
        const { notice } = result.structuredContent as { notice: string };
        expect(notice).toContain('browse all 7 vendors');
      } finally {
        getAll.mockRestore();
      }
    });

    it('a query matching nothing in or out of the category says so', async () => {
      await expectNotice(
        { query: 'fastly', category: 'cdn-edge' },
        `No registry vendor's slug or display name contains "fastly", in category "cdn-edge" or any other.${routing()}`,
      );
    });

    it('a query that matches only outside the category lists those vendors', async () => {
      const outside = VENDOR_REGISTRY.filter((v) => contains(v, 'github') && v.category !== 'ai');
      expect(outside.map((v) => v.slug)).toContain('github');
      await expectNotice(
        { query: 'github', category: 'ai' },
        `No vendor in category "ai" has a slug or display name containing "github"; outside it: ${outside
          .map((v) => `${v.slug} (${v.category})`)
          .join(', ')}. Drop category to see them.`,
      );
    });

    it('lists every outside match, in registry order, for a broad mixed-case query', async () => {
      const outside = VENDOR_REGISTRY.filter((v) => contains(v, 'cloud') && v.category !== 'ai');
      expect(VENDOR_REGISTRY.some((v) => contains(v, 'cloud') && v.category === 'ai')).toBe(false);
      expect(outside.length).toBeGreaterThan(1);
      const listed = outside.map((v) => `${v.slug} (${v.category})`).join(', ');
      await expectNotice(
        { query: 'Cloud', category: 'ai' },
        `No vendor in category "ai" has a slug or display name containing "Cloud"; outside it: ${listed}. Drop category to see them.`,
      );
    });

    it('trims the query, so surrounding whitespace still matches', async () => {
      const result = await runToolContract(devopsListVendors, { query: ' github' });
      expect(result.isError).toBeFalsy();
      const sc = result.structuredContent as { vendors: { slug: string }[]; notice?: string };
      expect(sc.vendors.map((v) => v.slug)).toContain('github');
      expect(sc).not.toHaveProperty('notice');
    });

    it('trims the query inside the notice too', async () => {
      await expectNotice(
        { query: '  fastly  ' },
        `No registry vendor's slug or display name contains "fastly".${routing()}`,
      );
    });

    it.each([
      { name: 'no arguments', input: {} },
      { name: 'a category', input: { category: 'auth' as const } },
      { name: 'a whitespace-only query', input: { query: '   ' } },
    ])('a non-empty result carries no notice ($name)', async ({ input }) => {
      const result = await runToolContract(devopsListVendors, input);
      const sc = result.structuredContent as { total: number; notice?: string };
      expect(sc.total).toBeGreaterThan(0);
      expect(sc).not.toHaveProperty('notice');
      expect(contentText(result)).not.toContain('No vendors matched');
    });
  });
});
