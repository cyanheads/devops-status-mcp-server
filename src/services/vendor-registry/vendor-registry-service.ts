/**
 * @fileoverview Vendor registry service — in-memory slug→entry resolution from the static data file.
 * @module services/vendor-registry/vendor-registry-service
 */

import { VENDOR_REGISTRY, type VendorEntry } from '@/data/vendor-registry.js';

/** Regex matching a raw URL (starts with http:// or https://). */
const URL_RE = /^https?:\/\//i;

/**
 * A resolved vendor target — carries the api_type (plus adapter-specific fields)
 * so the status dispatch layer can route to the right adapter.
 */
export type ResolvedVendor = {
  url: string;
  name: string;
  slug: string | null;
} & (
  | { api_type: 'statuspage' | 'slack' | 'aws' | 'firehydrant' }
  | { api_type: 'statusio'; statusio_page_id: string }
);

export class VendorRegistryService {
  private readonly bySlug: Map<string, VendorEntry> = new Map();
  private readonly all: readonly VendorEntry[] = VENDOR_REGISTRY;

  constructor() {
    for (const entry of VENDOR_REGISTRY) {
      this.bySlug.set(entry.slug.toLowerCase(), entry);
    }
  }

  /**
   * Resolve a vendor input to a status endpoint target.
   * Input may be a slug ("github") or a raw Atlassian Statuspage base URL —
   * raw URLs always resolve as api_type 'statuspage'.
   * Returns null when not found and not a URL.
   */
  resolve(input: string): ResolvedVendor | null {
    const lower = input.trim().toLowerCase();
    const entry = this.bySlug.get(lower);
    if (entry) {
      const base = { url: entry.statuspage_url, name: entry.name, slug: entry.slug };
      return entry.api_type === 'statusio'
        ? { ...base, api_type: 'statusio', statusio_page_id: entry.statusio_page_id }
        : { ...base, api_type: entry.api_type };
    }
    // Raw URL passthrough
    if (URL_RE.test(input.trim())) {
      return {
        url: input.trim().replace(/\/$/, ''),
        name: input.trim(),
        slug: null,
        api_type: 'statuspage',
      };
    }
    return null;
  }

  /** Look up a vendor entry by exact slug (case-insensitive). */
  getBySlug(slug: string): VendorEntry | undefined {
    return this.bySlug.get(slug.toLowerCase());
  }

  /**
   * Resolve a slug or display name to its registry entry. Layered lookup: exact slug
   * (case-insensitive), the whitespace-hyphenated form of the input, then an exact
   * case-insensitive match against the display name. Returns undefined when nothing
   * matches — deliberately avoids the substring search() path so an ambiguous word
   * (e.g. "cloud", which appears in "Redis Cloud", "Grafana Cloud") never resolves to
   * an arbitrary first hit.
   */
  getBySlugOrName(input: string): VendorEntry | undefined {
    const trimmed = input.trim();
    const bySlug =
      this.getBySlug(trimmed) ?? this.getBySlug(trimmed.toLowerCase().replace(/\s+/g, '-'));
    if (bySlug) return bySlug;
    const lowerName = trimmed.toLowerCase();
    return this.all.find((v) => v.name.toLowerCase() === lowerName);
  }

  /** Filter vendors by optional query and/or category. */
  search(query?: string, category?: string): VendorEntry[] {
    let results = [...this.all];
    if (category) {
      results = results.filter((v) => v.category === category);
    }
    if (query) {
      const q = query.toLowerCase();
      results = results.filter((v) => v.slug.includes(q) || v.name.toLowerCase().includes(q));
    }
    return results;
  }

  /** All unique category values. */
  getCategories(): string[] {
    const cats = new Set<string>();
    for (const v of this.all) cats.add(v.category);
    return [...cats].sort();
  }

  getAll(): readonly VendorEntry[] {
    return this.all;
  }
}

// --- Init/accessor pattern ---

let _service: VendorRegistryService | undefined;

export function initVendorRegistryService(): void {
  _service = new VendorRegistryService();
}

export function getVendorRegistryService(): VendorRegistryService {
  if (!_service)
    throw new Error(
      'VendorRegistryService not initialized — call initVendorRegistryService() in setup()',
    );
  return _service;
}
