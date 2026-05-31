/**
 * @fileoverview Barrel export for all tool definitions.
 * @module mcp-server/tools/definitions/index
 */

export { devopsCheckCerts } from './devops-check-certs.tool.js';
export { devopsCheckDns } from './devops-check-dns.tool.js';
export { devopsGetIncidents } from './devops-get-incidents.tool.js';
export { devopsListVendors } from './devops-list-vendors.tool.js';
export { devopsStatusCheck } from './devops-status-check.tool.js';
export { devopsSuggestAction } from './devops-suggest-action.tool.js';
export { devopsWatchStack } from './devops-watch-stack.tool.js';

import { devopsCheckCerts } from './devops-check-certs.tool.js';
import { devopsCheckDns } from './devops-check-dns.tool.js';
import { devopsGetIncidents } from './devops-get-incidents.tool.js';
import { devopsListVendors } from './devops-list-vendors.tool.js';
import { devopsStatusCheck } from './devops-status-check.tool.js';
import { devopsSuggestAction } from './devops-suggest-action.tool.js';
import { devopsWatchStack } from './devops-watch-stack.tool.js';

export const allToolDefinitions = [
  devopsListVendors,
  devopsStatusCheck,
  devopsGetIncidents,
  devopsWatchStack,
  devopsCheckCerts,
  devopsCheckDns,
  devopsSuggestAction,
] as const;
