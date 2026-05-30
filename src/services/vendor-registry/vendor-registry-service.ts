/**
 * @fileoverview Vendor registry service — in-memory slug→entry resolution from the static data file.
 * @module services/vendor-registry/vendor-registry-service
 */

import { VENDOR_REGISTRY, type VendorEntry } from '@/data/vendor-registry.js';

/** Regex matching a raw URL (starts with http:// or https://). */
const URL_RE = /^https?:\/\//i;

export class VendorRegistryService {
  private readonly bySlug: Map<string, VendorEntry> = new Map();
  private readonly all: readonly VendorEntry[] = VENDOR_REGISTRY;

  constructor() {
    for (const entry of VENDOR_REGISTRY) {
      this.bySlug.set(entry.slug.toLowerCase(), entry);
    }
  }

  /**
   * Resolve a vendor input to a Statuspage base URL and display name.
   * Input may be a slug ("github") or a raw Statuspage base URL.
   * Returns null when not found and not a URL.
   */
  resolve(input: string): { url: string; name: string; slug: string | null } | null {
    const lower = input.trim().toLowerCase();
    const entry = this.bySlug.get(lower);
    if (entry) {
      return { url: entry.statuspage_url, name: entry.name, slug: entry.slug };
    }
    // Raw URL passthrough
    if (URL_RE.test(input.trim())) {
      return { url: input.trim().replace(/\/$/, ''), name: input.trim(), slug: null };
    }
    return null;
  }

  /** Look up a vendor entry by exact slug (case-insensitive). */
  getBySlug(slug: string): VendorEntry | undefined {
    return this.bySlug.get(slug.toLowerCase());
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
