/**
 * @fileoverview Tests for the status_list_vendors tool.
 * @module tests/mcp-server/tools/definitions/status-list-vendors.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { statusListVendors } from '@/mcp-server/tools/definitions/status-list-vendors.tool.js';
import { initVendorRegistryService } from '@/services/vendor-registry/vendor-registry-service.js';

beforeAll(() => {
  initVendorRegistryService();
});

describe('statusListVendors', () => {
  it('returns all vendors when no filters provided', async () => {
    const ctx = createMockContext();
    const input = statusListVendors.input.parse({});
    const result = await statusListVendors.handler(input, ctx);
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
    const input = statusListVendors.input.parse({ category: 'ai' });
    const result = await statusListVendors.handler(input, ctx);
    expect(result.total).toBeGreaterThan(0);
    for (const v of result.vendors) {
      expect(v.category).toBe('ai');
    }
  });

  it('filters by query (case-insensitive)', async () => {
    const ctx = createMockContext();
    const input = statusListVendors.input.parse({ query: 'github' });
    const result = await statusListVendors.handler(input, ctx);
    expect(result.total).toBeGreaterThan(0);
    expect(result.vendors.some((v) => v.slug === 'github')).toBe(true);
  });

  it('returns empty list for non-matching query', async () => {
    const ctx = createMockContext();
    const input = statusListVendors.input.parse({ query: 'zzz-nonexistent-xyz-abc' });
    const result = await statusListVendors.handler(input, ctx);
    expect(result.total).toBe(0);
    expect(result.vendors).toHaveLength(0);
  });

  it('formats output with slugs and categories', async () => {
    const ctx = createMockContext();
    const input = statusListVendors.input.parse({ category: 'cloud' });
    const result = await statusListVendors.handler(input, ctx);
    const blocks = statusListVendors.format!(result);
    expect(blocks).toHaveLength(1);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('cloud');
    // Each vendor should appear in the output
    for (const v of result.vendors) {
      expect(text).toContain(v.slug);
    }
  });
});
