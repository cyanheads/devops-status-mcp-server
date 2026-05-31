#!/usr/bin/env node
/**
 * @fileoverview devops-status-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { allResourceDefinitions } from './mcp-server/resources/definitions/index.js';
import { allToolDefinitions } from './mcp-server/tools/definitions/index.js';
import { initCertService } from './services/cert/cert-service.js';
import { initDnsService } from './services/dns/dns-service.js';
import { initStatuspageService } from './services/statuspage/statuspage-service.js';
import { initVendorRegistryService } from './services/vendor-registry/vendor-registry-service.js';

await createApp({
  tools: [...allToolDefinitions],
  resources: [...allResourceDefinitions],
  prompts: [],
  instructions:
    'Infrastructure health and incident intelligence for DevOps agents. ' +
    'No API keys required — fully public data sources. ' +
    'Vendor registry: 26 verified vendors across cloud, CDN, dev-platform, data, comms, auth, monitoring, and AI categories. ' +
    'Workflow: devops_list_vendors (discover slugs) → devops_status_check (health snapshot) → devops_get_incidents (incident history) → devops_suggest_action (response playbook). ' +
    'devops_watch_stack persists a named vendor list in session state for repeat health sweeps. ' +
    'devops_check_certs and devops_check_dns work for any domain — not just registered vendors.',

  setup() {
    initVendorRegistryService();
    initStatuspageService();
    initCertService();
    initDnsService();
  },
});
