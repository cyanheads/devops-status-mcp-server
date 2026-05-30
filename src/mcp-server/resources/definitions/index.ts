/**
 * @fileoverview Barrel export for all resource definitions.
 * @module mcp-server/resources/definitions/index
 */

export { vendorEntryResource } from './vendor-entry.resource.js';

import { vendorEntryResource } from './vendor-entry.resource.js';

export const allResourceDefinitions = [vendorEntryResource] as const;
