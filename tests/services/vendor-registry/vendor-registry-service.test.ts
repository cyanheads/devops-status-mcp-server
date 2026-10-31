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
    expect(service.resolve('gcp')?.api_type).toBe('gcp');
    expect(service.resolve('redis-cloud')?.api_type).toBe('firehydrant');
    expect(service.resolve('Azure')).toEqual({
      url: 'https://azure.status.microsoft/en-us/status/',
      name: 'Microsoft Azure',
      slug: 'azure',
      api_type: 'azure',
    });

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

  it('search ignores whitespace around the query (#73)', () => {
    const service = getVendorRegistryService();
    expect(service.search(' github ')).toEqual(service.search('github'));
    expect(service.search('\tGitHub\n', 'dev-platform').map((v) => v.slug)).toContain('github');
  });

  it('search treats a whitespace-only query as no query (#73)', () => {
    const service = getVendorRegistryService();
    expect(service.search('   ')).toEqual(service.getAll());
    expect(service.search('  ', 'auth')).toEqual(service.search(undefined, 'auth'));
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
  it('has 63 entries with unique slugs', () => {
    expect(VENDOR_REGISTRY).toHaveLength(63);
    const slugs = VENDOR_REGISTRY.map((v) => v.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('routes Azure DevOps to its own adapter and portal, apart from the azure entry (#56)', () => {
    expect(getVendorRegistryService().getBySlugOrName('Azure DevOps')?.slug).toBe('azure-devops');
    expect(getVendorRegistryService().resolve('azure-devops')).toEqual({
      url: 'https://status.dev.azure.com',
      name: 'Azure DevOps',
      slug: 'azure-devops',
      api_type: 'azure-devops',
    });
    expect(
      getVendorRegistryService()
        .search(undefined, 'dev-platform')
        .map((v) => v.slug),
    ).toContain('azure-devops');
  });

  it('lists aws, gcp and azure under the cloud category', () => {
    const cloud = VENDOR_REGISTRY.filter((v) => v.category === 'cloud').map((v) => v.slug);
    expect(cloud).toEqual(['digitalocean', 'linode', 'aws', 'gcp', 'azure']);
  });

  it('routes the Google Cloud entry to the gcp adapter, not a Statuspage URL', () => {
    const gcp = VENDOR_REGISTRY.find((v) => v.slug === 'gcp');
    expect(gcp?.name).toBe('Google Cloud');
    expect(gcp?.api_type).toBe('gcp');
    expect(gcp?.statuspage_url).toBe('https://status.cloud.google.com');
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

  /**
   * status.akamai.com 302s to www.akamaistatus.com and the redirect drops the query
   * string, so every history page requested through the old host came back as page 1.
   */
  it('points akamai at the canonical host rather than the one that redirects', () => {
    expect(VENDOR_REGISTRY.find((v) => v.slug === 'akamai')?.statuspage_url).toBe(
      'https://www.akamaistatus.com',
    );
  });

  /**
   * status.sendgrid.com 302s to status.twilio.com, whose page also carries Twilio's SMS,
   * voice, and carrier components; the entry is scoped to SendGrid's components on it.
   */
  it('points sendgrid at the Twilio page, scoped to SendGrid components (#54)', () => {
    const service = getVendorRegistryService();
    expect(service.resolve('sendgrid')).toEqual({
      url: 'https://status.twilio.com',
      name: 'SendGrid',
      slug: 'sendgrid',
      api_type: 'statuspage',
      component_scope_prefix: 'SendGrid',
    });
    expect(service.resolve('twilio')).toEqual({
      url: 'https://status.twilio.com',
      name: 'Twilio',
      slug: 'twilio',
      api_type: 'statuspage',
    });
  });

  it('scopes only sendgrid — no other entry shares a page or declares a scope (#54)', () => {
    expect(
      VENDOR_REGISTRY.filter((v) => v.component_scope_prefix !== undefined).map((v) => v.slug),
    ).toEqual(['sendgrid']);
    const unscoped = VENDOR_REGISTRY.filter((v) => v.component_scope_prefix === undefined);
    const urls = unscoped.map((v) => v.statuspage_url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  /**
   * status.atlassian.com is an umbrella page with no components; Atlassian posts product
   * outages on per-product pages. Each product a software team ships on or runs incidents
   * on gets its own entry, and `atlassian` stays on the umbrella, naming them (#74).
   */
  describe('Atlassian products (#74)', () => {
    const PRODUCTS = [
      ['jira', 'Atlassian Jira', 'dev-platform', 'https://jira-software.status.atlassian.com'],
      [
        'confluence',
        'Atlassian Confluence',
        'dev-platform',
        'https://confluence.status.atlassian.com',
      ],
      [
        'bitbucket',
        'Atlassian Bitbucket',
        'dev-platform',
        'https://bitbucket.status.atlassian.com',
      ],
      [
        'jira-service-management',
        'Atlassian Jira Service Management',
        'dev-platform',
        'https://jira-service-management.status.atlassian.com',
      ],
      [
        'atlassian-compass',
        'Atlassian Compass',
        'dev-platform',
        'https://compass.status.atlassian.com',
      ],
      [
        'atlassian-developer',
        'Atlassian Developer',
        'dev-platform',
        'https://developer.status.atlassian.com',
      ],
      ['trello', 'Atlassian Trello', 'dev-platform', 'https://trello.status.atlassian.com'],
      ['opsgenie', 'Atlassian Opsgenie', 'monitoring', 'https://opsgenie.status.atlassian.com'],
      ['atlassian-statuspage', 'Atlassian Statuspage', 'monitoring', 'https://metastatuspage.com'],
      ['atlassian-guard', 'Atlassian Guard', 'auth', 'https://guard.status.atlassian.com'],
    ] as const;
    const PRODUCT_SLUGS = PRODUCTS.map(([slug]) => slug);

    it('registers each product page as its own Statuspage entry', () => {
      const service = getVendorRegistryService();
      for (const [slug, name, category, url] of PRODUCTS) {
        expect(service.getBySlug(slug), slug).toEqual({
          slug,
          name,
          category,
          statuspage_url: url,
          api_type: 'statuspage',
        });
        expect(service.resolve(slug), slug).toEqual({
          url,
          name,
          slug,
          api_type: 'statuspage',
        });
      }
    });

    it('keeps atlassian on the umbrella page, renamed, naming the product slugs', () => {
      const service = getVendorRegistryService();
      expect(service.getBySlug('atlassian')).toEqual({
        slug: 'atlassian',
        name: 'Atlassian (cross-product incidents)',
        category: 'dev-platform',
        statuspage_url: 'https://status.atlassian.com',
        api_type: 'statuspage',
        product_slugs: PRODUCT_SLUGS,
      });
      expect(service.resolve('Atlassian')).toEqual({
        url: 'https://status.atlassian.com',
        name: 'Atlassian (cross-product incidents)',
        slug: 'atlassian',
        api_type: 'statuspage',
        product_slugs: PRODUCT_SLUGS,
      });
    });

    it('declares product_slugs on atlassian alone, each naming a product entry', () => {
      const service = getVendorRegistryService();
      expect(
        VENDOR_REGISTRY.filter((v) => v.product_slugs !== undefined).map((v) => v.slug),
      ).toEqual(['atlassian']);
      for (const slug of PRODUCT_SLUGS) {
        expect(service.getBySlug(slug)?.product_slugs, slug).toBeUndefined();
      }
    });

    it('finds the whole family by "atlassian", and each product by its own name', () => {
      const service = getVendorRegistryService();
      expect(
        service
          .search('atlassian')
          .map((v) => v.slug)
          .sort(),
      ).toEqual(['atlassian', ...PRODUCT_SLUGS].sort());
      expect(service.search('jira').map((v) => v.slug)).toEqual([
        'jira',
        'jira-service-management',
      ]);
      expect(service.getBySlugOrName('Jira')?.slug).toBe('jira');
      expect(service.getBySlugOrName('Atlassian Bitbucket')?.slug).toBe('bitbucket');
    });
  });

  it('every statusio entry carries a page ID', () => {
    const statusio = VENDOR_REGISTRY.filter((v) => v.api_type === 'statusio');
    expect(statusio.map((v) => v.slug).sort()).toEqual(['gitlab', 'neon']);
    for (const v of statusio) {
      if (v.api_type === 'statusio') expect(v.statusio_page_id).toMatch(/^[0-9a-f]{24}$/);
    }
  });
});
