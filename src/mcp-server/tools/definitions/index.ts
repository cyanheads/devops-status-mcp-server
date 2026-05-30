/**
 * @fileoverview Barrel export for all tool definitions.
 * @module mcp-server/tools/definitions/index
 */

export { statusCheck } from './status-check.tool.js';
export { statusCheckCerts } from './status-check-certs.tool.js';
export { statusCheckDns } from './status-check-dns.tool.js';
export { statusGetIncidents } from './status-get-incidents.tool.js';
export { statusListVendors } from './status-list-vendors.tool.js';
export { statusSuggestAction } from './status-suggest-action.tool.js';
export { statusWatchStack } from './status-watch-stack.tool.js';

import { statusCheck } from './status-check.tool.js';
import { statusCheckCerts } from './status-check-certs.tool.js';
import { statusCheckDns } from './status-check-dns.tool.js';
import { statusGetIncidents } from './status-get-incidents.tool.js';
import { statusListVendors } from './status-list-vendors.tool.js';
import { statusSuggestAction } from './status-suggest-action.tool.js';
import { statusWatchStack } from './status-watch-stack.tool.js';

export const allToolDefinitions = [
  statusListVendors,
  statusCheck,
  statusGetIncidents,
  statusWatchStack,
  statusCheckCerts,
  statusCheckDns,
  statusSuggestAction,
] as const;
