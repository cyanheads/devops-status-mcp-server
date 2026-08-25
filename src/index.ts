#!/usr/bin/env node
/**
 * @fileoverview devops-status-mcp-server MCP server entry point.
 * @module index
 */

import type { CacheHints } from '@cyanheads/mcp-ts-core';
import { createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from './config/server-config.js';
import { allResourceDefinitions } from './mcp-server/resources/definitions/index.js';
import {
  ACTIVE_PROBE_TOOL_NAMES,
  allToolDefinitions,
} from './mcp-server/tools/definitions/index.js';
import { initCertService } from './services/cert/cert-service.js';
import { initDnsService } from './services/dns/dns-service.js';
import { initStatuspageService } from './services/statuspage/statuspage-service.js';
import { initVendorRegistryService } from './services/vendor-registry/vendor-registry-service.js';

const { disableActiveProbes } = getServerConfig();

const tools = disableActiveProbes
  ? allToolDefinitions.filter((t) => !ACTIVE_PROBE_TOOL_NAMES.has(t.name))
  : [...allToolDefinitions];

const baseInstructions =
  'Infrastructure health and incident intelligence for DevOps agents. ' +
  'No API keys required — fully public data sources. ' +
  'Vendor registry: 51 verified vendors across cloud, CDN, dev-platform, data, comms, auth, monitoring, and AI categories — ' +
  'Atlassian Statuspage plus native adapters for AWS Health, Google Cloud Service Health, Status.io (GitLab, Neon), Slack, and Firehydrant (Redis Cloud), all normalized to one shape. ' +
  'Workflow: devops_list_vendors (discover slugs) → devops_status_check (health snapshot) → devops_get_incidents (incident history) → devops_suggest_action (response playbook). ' +
  'devops_watch_stack persists a named vendor list in session state for repeat health sweeps.';

const instructions = disableActiveProbes
  ? baseInstructions
  : `${baseInstructions} devops_check_certs and devops_check_dns work for any domain — not just registered vendors.`;

/**
 * The discovery surface is fixed for the life of the process: the tool list is
 * decided once from DEVOPS_STATUS_DISABLE_ACTIVE_PROBES above, and the resource
 * and prompt lists are compiled in. Nothing here emits a `*Changed` notification,
 * so a client re-listing on every turn is re-fetching a constant. Vendor status
 * itself is not covered — it moves minute to minute and is served by tools, which
 * are not a cacheable result. `public` because none of it varies by caller.
 */
const DISCOVERY_CACHE_TTL_MS = 3_600_000;

const cacheHints = {
  'tools/list': { ttlMs: DISCOVERY_CACHE_TTL_MS, cacheScope: 'public' },
  'prompts/list': { ttlMs: DISCOVERY_CACHE_TTL_MS, cacheScope: 'public' },
  'resources/list': { ttlMs: DISCOVERY_CACHE_TTL_MS, cacheScope: 'public' },
  'resources/templates/list': { ttlMs: DISCOVERY_CACHE_TTL_MS, cacheScope: 'public' },
  'server/discover': { ttlMs: DISCOVERY_CACHE_TTL_MS, cacheScope: 'public' },
} satisfies CacheHints;

await createApp({
  name: 'devops-status-mcp-server',
  title: 'devops-status-mcp-server',
  tools,
  resources: [...allResourceDefinitions],
  prompts: [],
  instructions,
  cacheHints,

  setup() {
    initVendorRegistryService();
    initStatuspageService();
    initCertService();
    initDnsService();
  },
});
