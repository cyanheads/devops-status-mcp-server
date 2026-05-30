/**
 * @fileoverview Tests for the VendorRegistryService.
 * @module tests/services/vendor-registry/vendor-registry-service.test
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  getVendorRegistryService,
  initVendorRegistryService,
} from '@/services/vendor-registry/vendor-registry-service.js';

beforeAll(() => {
  initVendorRegistryService();
});

describe('VendorRegistryService', () => {
  it('resolves a known slug to a URL and name', () => {
    const service = getVendorRegistryService();
    const result = service.resolve('github');
    expect(result).not.toBeNull();
    expect(result?.url).toContain('http');
    expect(result?.name).toBeTruthy();
    expect(result?.slug).toBe('github');
  });

  it('resolves a raw URL passthrough', () => {
    const service = getVendorRegistryService();
    const url = 'https://status.example.com';
    const result = service.resolve(url);
    expect(result).not.toBeNull();
    expect(result?.url).toBe(url);
    expect(result?.slug).toBeNull();
  });

  it('returns null for unknown slug', () => {
    const service = getVendorRegistryService();
    expect(service.resolve('nonexistent-vendor-xyz')).toBeNull();
  });

  it('returns null for empty string', () => {
    const service = getVendorRegistryService();
    expect(service.resolve('')).toBeNull();
  });

  it('getBySlug returns the entry for a known slug', () => {
    const service = getVendorRegistryService();
    const entry = service.getBySlug('cloudflare');
    expect(entry).toBeDefined();
    expect(entry?.slug).toBe('cloudflare');
    expect(entry?.category).toBe('cdn-edge');
  });

  it('getBySlug returns undefined for unknown slug', () => {
    const service = getVendorRegistryService();
    expect(service.getBySlug('unknown-xyz')).toBeUndefined();
  });

  it('search returns all entries when no filters', () => {
    const service = getVendorRegistryService();
    const all = service.search();
    expect(all.length).toBeGreaterThan(10);
  });

  it('search filters by category', () => {
    const service = getVendorRegistryService();
    const cloud = service.search(undefined, 'cloud');
    expect(cloud.length).toBeGreaterThan(0);
    for (const v of cloud) {
      expect(v.category).toBe('cloud');
    }
  });

  it('search filters by query (name match)', () => {
    const service = getVendorRegistryService();
    const results = service.search('github');
    expect(results.some((v) => v.slug === 'github')).toBe(true);
  });

  it('getCategories returns sorted unique categories', () => {
    const service = getVendorRegistryService();
    const cats = service.getCategories();
    expect(cats.length).toBeGreaterThan(0);
    expect(cats).toEqual([...cats].sort());
    expect(new Set(cats).size).toBe(cats.length);
  });

  it('getAll returns all vendors', () => {
    const service = getVendorRegistryService();
    const all = service.getAll();
    expect(all.length).toBeGreaterThan(10);
  });
});
