#!/usr/bin/env node
/**
 * @fileoverview Registry drift probe — fetches every vendor registry entry
 * through its adapter-appropriate endpoint (the same dispatch path the tools
 * use) and reports failures.
 *
 * Standalone by design: this hits ~50 live endpoints, so it is NOT part of
 * devcheck (which must stay offline). Run before releases or when a vendor
 * tool starts failing: `bun run verify:registry`
 *
 * Exit code: 0 when every entry responds with a parseable status, 1 otherwise.
 * @module scripts/verify-registry
 */

import { VENDOR_REGISTRY } from '../src/data/vendor-registry.js';
import { fetchVendorSummary } from '../src/services/status-adapters/status-dispatch.js';
import { initStatuspageService } from '../src/services/statuspage/statuspage-service.js';
import {
  getVendorRegistryService,
  initVendorRegistryService,
} from '../src/services/vendor-registry/vendor-registry-service.js';

const CONCURRENCY = 8;

interface ProbeResult {
  api_type: string;
  detail: string;
  ok: boolean;
  slug: string;
}

async function probe(slug: string): Promise<ProbeResult> {
  const target = getVendorRegistryService().resolve(slug);
  if (!target) return { slug, api_type: '?', ok: false, detail: 'slug did not resolve' };
  try {
    const { data } = await fetchVendorSummary(target);
    const indicator = data.status?.indicator;
    if (!indicator) {
      return {
        slug,
        api_type: target.api_type,
        ok: false,
        detail: 'no status.indicator in response',
      };
    }
    return {
      slug,
      api_type: target.api_type,
      ok: true,
      detail: `${indicator} — ${data.status.description}`,
    };
  } catch (err) {
    return { slug, api_type: target.api_type, ok: false, detail: (err as Error).message };
  }
}

const slugs = VENDOR_REGISTRY.map((v) => v.slug);
initVendorRegistryService();
initStatuspageService();

console.log(`Probing ${slugs.length} registry entries (concurrency ${CONCURRENCY})…\n`);

const results: ProbeResult[] = [];
for (let i = 0; i < slugs.length; i += CONCURRENCY) {
  const batch = slugs.slice(i, i + CONCURRENCY);
  results.push(...(await Promise.all(batch.map(probe))));
}

const width = Math.max(...results.map((r) => r.slug.length));
for (const r of results.sort((a, b) => a.slug.localeCompare(b.slug))) {
  const mark = r.ok ? 'OK  ' : 'FAIL';
  console.log(`${mark}  ${r.slug.padEnd(width)}  [${r.api_type}]  ${r.detail}`);
}

const failures = results.filter((r) => !r.ok);
console.log(`\n${results.length - failures.length}/${results.length} entries healthy.`);
if (failures.length > 0) {
  console.error(`${failures.length} entries failed — registry drift or transient outage.`);
  process.exit(1);
}
