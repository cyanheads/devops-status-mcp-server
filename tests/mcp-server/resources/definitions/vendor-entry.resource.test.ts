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

/**
 * The definition declares `params`, but the builder types the field optional for
 * resources that take none — narrow it once here rather than at every call site.
 */
const paramsSchema = vendorEntryResource.params;
if (!paramsSchema) throw new Error('vendorEntryResource is expected to declare params');

describe('vendorEntryResource', () => {
  it('returns full entry for a known vendor slug', async () => {
    const ctx = createMockContext({ uri: new URL('devops-status://vendors/github') });
    const params = paramsSchema.parse({ name: 'github' });
    const result = await vendorEntryResource.handler(params, ctx);

    expect(result.slug).toBe('github');
    expect(result.name).toBeTruthy();
    expect(result.category).toBe('dev-platform');
    expect(result.statuspage_url).toContain('http');
    expect(result.api_type).toBe('statuspage');
  });

  it('is case-insensitive for slug lookup', async () => {
    const ctx = createMockContext({ uri: new URL('devops-status://vendors/GitHub') });
    const params = paramsSchema.parse({ name: 'GitHub' });
    const result = await vendorEntryResource.handler(params, ctx);
    expect(result.slug).toBe('github');
  });

  it('returns the azure-devops entry with its own backend (#56)', async () => {
    const ctx = createMockContext({ uri: new URL('devops-status://vendors/azure-devops') });
    const result = await vendorEntryResource.handler(
      paramsSchema.parse({ name: 'azure-devops' }),
      ctx,
    );
    expect(result).toEqual({
      slug: 'azure-devops',
      name: 'Azure DevOps',
      category: 'dev-platform',
      statuspage_url: 'https://status.dev.azure.com',
      api_type: 'azure-devops',
    });
    expect(vendorEntryResource.output?.shape.api_type.description).toContain('"azure-devops"');
  });

  it('carries the component scope of an entry on a shared page, and none otherwise', async () => {
    const read = (name: string) =>
      vendorEntryResource.handler(
        paramsSchema.parse({ name }),
        createMockContext({ uri: new URL(`devops-status://vendors/${name}`) }),
      );
    const sendgrid = await read('sendgrid');
    expect(sendgrid.component_scope_prefix).toBe('SendGrid');
    expect(vendorEntryResource.output?.parse(sendgrid)).toEqual(sendgrid);
    const twilio = await read('twilio');
    expect(twilio).not.toHaveProperty('component_scope_prefix');
  });

  it('carries product_slugs on the atlassian umbrella entry, and none on a product (#74)', async () => {
    const read = (name: string) =>
      vendorEntryResource.handler(
        paramsSchema.parse({ name }),
        createMockContext({ uri: new URL(`devops-status://vendors/${name}`) }),
      );
    const atlassian = await read('atlassian');
    expect(atlassian).toEqual({
      slug: 'atlassian',
      name: 'Atlassian (cross-product incidents)',
      category: 'dev-platform',
      statuspage_url: 'https://status.atlassian.com',
      api_type: 'statuspage',
      product_slugs: [
        'jira',
        'confluence',
        'bitbucket',
        'jira-service-management',
        'atlassian-compass',
        'atlassian-developer',
        'trello',
        'opsgenie',
        'atlassian-statuspage',
        'atlassian-guard',
      ],
    });
    expect(vendorEntryResource.output?.parse(atlassian)).toEqual(atlassian);
    const jira = await read('jira');
    expect(jira).not.toHaveProperty('product_slugs');
    expect(jira.statuspage_url).toBe('https://jira-software.status.atlassian.com');
  });

  it('throws notFound for unknown slug', () => {
    const ctx = createMockContext({ uri: new URL('devops-status://vendors/unknown-xyz') });
    const params = paramsSchema.parse({ name: 'unknown-xyz-doesnt-exist' });
    expect(() => vendorEntryResource.handler(params, ctx)).toThrow();
  });

  /**
   * The hint reaches 2026-07-28 clients as the lifetime they may cache a read for.
   * `public` is only correct while the payload stays caller-independent — a future
   * field derived from tenant, auth, or request state has to drop it back to private.
   */
  it('declares a public cache hint for its compiled-in payload', () => {
    expect(vendorEntryResource.cacheHint).toEqual({ ttlMs: 3_600_000, cacheScope: 'public' });
  });

  it('returns all required schema fields', async () => {
    const ctx = createMockContext({ uri: new URL('devops-status://vendors/cloudflare') });
    const params = paramsSchema.parse({ name: 'cloudflare' });
    const result = await vendorEntryResource.handler(params, ctx);

    // Every output field should be populated
    expect(result.slug).toBeTruthy();
    expect(result.name).toBeTruthy();
    expect(result.category).toBeTruthy();
    expect(result.statuspage_url).toBeTruthy();
    expect(result.api_type).toBeTruthy();
  });
});
