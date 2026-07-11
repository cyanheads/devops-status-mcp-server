/**
 * @fileoverview Tests for the VendorRegistryService.
 * @module tests/services/vendor-registry/vendor-registry-service.test
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { VENDOR_REGISTRY } from '@/data/vendor-registry.js';
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

  it('resolves a raw URL passthrough as api_type statuspage', () => {
    const service = getVendorRegistryService();
    const url = 'https://status.example.com';
    const result = service.resolve(url);
    expect(result).not.toBeNull();
    expect(result?.url).toBe(url);
    expect(result?.slug).toBeNull();
    expect(result?.api_type).toBe('statuspage');
  });

  it('resolves adapter-backed slugs with their api_type', () => {
    const service = getVendorRegistryService();
    expect(service.resolve('github')?.api_type).toBe('statuspage');
    expect(service.resolve('slack')?.api_type).toBe('slack');
    expect(service.resolve('aws')?.api_type).toBe('aws');
    expect(service.resolve('redis-cloud')?.api_type).toBe('firehydrant');

    const gitlab = service.resolve('gitlab');
    expect(gitlab?.api_type).toBe('statusio');
    if (gitlab?.api_type === 'statusio') {
      expect(gitlab.statusio_page_id).toBe('5b36dc6502d06804c08349f7');
    }
    const neon = service.resolve('neon');
    expect(neon?.api_type).toBe('statusio');
    if (neon?.api_type === 'statusio') {
      expect(neon.statusio_page_id).toBe('6878fc85709daa75be6c7e3c');
    }
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

  describe('getBySlugOrName (#20)', () => {
    it('resolves an exact slug', () => {
      const service = getVendorRegistryService();
      expect(service.getBySlugOrName('github')?.slug).toBe('github');
    });

    it('resolves a display name to the canonical slug', () => {
      const service = getVendorRegistryService();
      expect(service.getBySlugOrName('Amazon Web Services')?.slug).toBe('aws');
    });

    it('resolves a display name case-insensitively', () => {
      const service = getVendorRegistryService();
      expect(service.getBySlugOrName('amazon web services')?.slug).toBe('aws');
    });

    it('resolves a multi-word name via its hyphenated slug', () => {
      const service = getVendorRegistryService();
      expect(service.getBySlugOrName('Redis Cloud')?.slug).toBe('redis-cloud');
    });

    it('does not resolve an ambiguous substring to an arbitrary entry', () => {
      const service = getVendorRegistryService();
      // "cloud" appears in several display names but is neither a slug nor an exact name.
      expect(service.getBySlugOrName('cloud')).toBeUndefined();
    });

    it('returns undefined for an unregistered vendor', () => {
      const service = getVendorRegistryService();
      expect(service.getBySlugOrName('nonexistent-vendor-xyz')).toBeUndefined();
    });
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

describe('VENDOR_REGISTRY integrity', () => {
  it('has 50 entries with unique slugs', () => {
    expect(VENDOR_REGISTRY).toHaveLength(50);
    const slugs = VENDOR_REGISTRY.map((v) => v.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('has unique display names (getBySlugOrName resolution depends on it)', () => {
    const names = VENDOR_REGISTRY.map((v) => v.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  it('every entry has an https URL (the auth0 http exception is gone)', () => {
    for (const v of VENDOR_REGISTRY) {
      expect(v.statuspage_url, v.slug).toMatch(/^https:\/\//);
    }
    expect(VENDOR_REGISTRY.find((v) => v.slug === 'auth0')?.statuspage_url).toBe(
      'https://auth0.statuspage.io',
    );
  });

  it('every statusio entry carries a page ID', () => {
    const statusio = VENDOR_REGISTRY.filter((v) => v.api_type === 'statusio');
    expect(statusio.map((v) => v.slug).sort()).toEqual(['gitlab', 'neon']);
    for (const v of statusio) {
      if (v.api_type === 'statusio') expect(v.statusio_page_id).toMatch(/^[0-9a-f]{24}$/);
    }
  });
});
