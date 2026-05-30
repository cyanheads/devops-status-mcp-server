/**
 * @fileoverview Tests for the vendor-entry resource.
 * @module tests/mcp-server/resources/definitions/vendor-entry.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { vendorEntryResource } from '@/mcp-server/resources/definitions/vendor-entry.resource.js';
import { initVendorRegistryService } from '@/services/vendor-registry/vendor-registry-service.js';

beforeAll(() => {
  initVendorRegistryService();
});

describe('vendorEntryResource', () => {
  it('returns full entry for a known vendor slug', async () => {
    const ctx = createMockContext({ uri: new URL('devops-status://vendors/github') });
    const params = vendorEntryResource.params.parse({ name: 'github' });
    const result = await vendorEntryResource.handler(params, ctx);

    expect(result.slug).toBe('github');
    expect(result.name).toBeTruthy();
    expect(result.category).toBe('dev-platform');
    expect(result.statuspage_url).toContain('http');
    expect(result.api_type).toBe('statuspage');
  });

  it('is case-insensitive for slug lookup', async () => {
    const ctx = createMockContext({ uri: new URL('devops-status://vendors/GitHub') });
    const params = vendorEntryResource.params.parse({ name: 'GitHub' });
    const result = await vendorEntryResource.handler(params, ctx);
    expect(result.slug).toBe('github');
  });

  it('throws notFound for unknown slug', () => {
    const ctx = createMockContext({ uri: new URL('devops-status://vendors/unknown-xyz') });
    const params = vendorEntryResource.params.parse({ name: 'unknown-xyz-doesnt-exist' });
    expect(() => vendorEntryResource.handler(params, ctx)).toThrow();
  });

  it('returns all required schema fields', async () => {
    const ctx = createMockContext({ uri: new URL('devops-status://vendors/cloudflare') });
    const params = vendorEntryResource.params.parse({ name: 'cloudflare' });
    const result = await vendorEntryResource.handler(params, ctx);

    // Every output field should be populated
    expect(result.slug).toBeTruthy();
    expect(result.name).toBeTruthy();
    expect(result.category).toBeTruthy();
    expect(result.statuspage_url).toBeTruthy();
    expect(result.api_type).toBeTruthy();
  });
});
