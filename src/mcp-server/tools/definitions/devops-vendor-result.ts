/**
 * @fileoverview Shared VendorResult schema and builder used by devops_status_check and devops_watch_stack.
 * @module mcp-server/tools/definitions/devops-vendor-result
 */

import { z } from '@cyanheads/mcp-ts-core';
import type { StatuspageSummaryResponse } from '@/services/statuspage/types.js';

/** Per-vendor result schema shared by devops_status_check and devops_watch_stack. */
export const VendorResultSchema = z
  .object({
    vendor: z.string().describe('Vendor slug or URL as provided.'),
    name: z.string().describe('Display name of the vendor.'),
    indicator: z
      .enum(['none', 'minor', 'major', 'critical'])
      .describe(
        'Overall health indicator: none = all clear, minor = some degradation, major = significant outage, critical = complete outage.',
      ),
    description: z
      .string()
      .describe('Human-readable status description (e.g., "All Systems Operational").'),
    degraded_components: z
      .array(
        z
          .object({
            name: z.string().describe('Component name.'),
            status: z
              .enum(['degraded_performance', 'partial_outage', 'major_outage', 'under_maintenance'])
              .describe(
                'Degradation level: degraded_performance = slow/intermittent, partial_outage = some requests failing, major_outage = most requests failing, under_maintenance = scheduled maintenance in progress.',
              ),
          })
          .describe('A degraded component entry.'),
      )
      .describe('Components not in operational state. Empty when all clear.'),
    active_incidents: z
      .array(
        z
          .object({
            id: z.string().describe('Unique incident identifier from Statuspage.'),
            name: z.string().describe('Incident title.'),
            impact: z
              .enum(['none', 'minor', 'major', 'critical'])
              .describe(
                'Severity level: none = informational, minor = degraded performance, major = partial outage, critical = full outage.',
              ),
            status: z
              .string()
              .describe('Current incident status (e.g., investigating, monitoring, resolved).'),
            started_at: z
              .string()
              .nullish()
              .describe(
                'ISO 8601 UTC timestamp when the incident started, or null/absent if not set by the vendor.',
              ),
            latest_update: z.string().describe('Most recent incident_update body text.'),
          })
          .describe('An active incident entry.'),
      )
      .describe('Active (non-resolved) incidents.'),
    scheduled_maintenances: z
      .array(
        z
          .object({
            name: z.string().describe('Maintenance window name.'),
            scheduled_for: z.string().describe('ISO 8601 UTC start time.'),
            scheduled_until: z.string().describe('ISO 8601 UTC end time.'),
            status: z.string().describe('Maintenance status (scheduled, in_progress, completed).'),
          })
          .describe('A scheduled maintenance entry.'),
      )
      .optional()
      .describe('Upcoming or in-progress maintenance windows. Present in detailed mode only.'),
    all_components: z
      .array(
        z
          .object({
            name: z.string().describe('Component name.'),
            status: z.string().describe('Component operational status.'),
            description: z
              .string()
              .nullable()
              .describe('Component description, or null if not provided.'),
          })
          .describe('A component entry.'),
      )
      .optional()
      .describe('All components including operational ones. Present in detailed mode only.'),
    cached: z.boolean().describe('True when this result was served from the 60s in-memory cache.'),
    checked_at: z.string().describe('ISO 8601 UTC timestamp of this check.'),
    statuspage_url: z.string().describe('Statuspage base URL used for this vendor.'),
    error: z
      .string()
      .optional()
      .describe('Fetch error message. Absent when the vendor was fetched successfully.'),
  })
  .describe('Status result for a single vendor.');

export type VendorResult = z.infer<typeof VendorResultSchema>;

/** Render a vendor result block for use in format(). */
export function renderVendorBlock(v: VendorResult): string[] {
  const lines: string[] = [];
  const icon = v.error
    ? '❓'
    : v.indicator === 'none'
      ? '✅'
      : v.indicator === 'critical'
        ? '🔴'
        : '⚠️';
  lines.push(`### ${icon} ${v.name} (${v.vendor})`);
  lines.push(`**Status:** ${v.description} | **Indicator:** ${v.indicator}`);
  if (v.error) lines.push(`**Error:** ${v.error}`);
  if (v.degraded_components.length > 0) {
    lines.push(
      `**Degraded:** ${v.degraded_components.map((c) => `${c.name} (${c.status})`).join(', ')}`,
    );
  }
  if (v.active_incidents.length > 0) {
    for (const inc of v.active_incidents) {
      lines.push(
        `**Incident [${inc.id}]:** ${inc.name} [${inc.impact}/${inc.status}]${inc.started_at ? ` started ${inc.started_at}` : ''}`,
      );
      lines.push(`  ${inc.latest_update}`);
    }
  }
  if (v.scheduled_maintenances && v.scheduled_maintenances.length > 0) {
    for (const m of v.scheduled_maintenances) {
      lines.push(
        `**Maintenance:** ${m.name} [${m.status}] ${m.scheduled_for} → ${m.scheduled_until}`,
      );
    }
  }
  if (v.all_components && v.all_components.length > 0) {
    lines.push(`**Components (${v.all_components.length}):**`);
    for (const c of v.all_components) {
      lines.push(`- ${c.name}: ${c.status}${c.description ? ` — ${c.description}` : ''}`);
    }
  }
  lines.push(`*Cached: ${v.cached} | Checked: ${v.checked_at} | URL: ${v.statuspage_url}*`);
  return lines;
}

/** Build a VendorResult from a Statuspage summary response. */
export function buildVendorResult(
  vendorInput: string,
  url: string,
  name: string,
  data: StatuspageSummaryResponse,
  cached: boolean,
  mode: 'summary' | 'detailed',
): VendorResult {
  const now = new Date().toISOString();
  const degraded = data.components.filter((c) => c.status !== 'operational' && !c.group);
  const activeIncidents = data.incidents.filter(
    (i) => i.status !== 'resolved' && i.status !== 'postmortem',
  );

  const result: VendorResult = {
    vendor: vendorInput,
    name: data.page.name || name,
    indicator: data.status.indicator,
    description: data.status.description,
    degraded_components: degraded.map((c) => ({
      name: c.name,
      status: c.status as VendorResult['degraded_components'][number]['status'],
    })),
    active_incidents: activeIncidents.map((i) => {
      const updates = [...i.incident_updates].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
      return {
        id: i.id,
        name: i.name,
        impact: i.impact,
        status: i.status,
        started_at: i.started_at ?? null,
        latest_update: updates[0]?.body ?? '',
      };
    }),
    cached,
    checked_at: now,
    statuspage_url: url,
  };

  if (mode === 'detailed') {
    result.scheduled_maintenances = data.scheduled_maintenances.map((m) => ({
      name: m.name,
      scheduled_for: m.scheduled_for ?? '',
      scheduled_until: m.scheduled_until ?? '',
      status: m.status,
    }));
    result.all_components = data.components
      .filter((c) => !c.group)
      .map((c) => ({
        name: c.name,
        status: c.status,
        description: c.description,
      }));
  }

  return result;
}
