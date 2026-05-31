/**
 * @fileoverview Tool to fetch incident history and scheduled maintenance windows for a vendor.
 * @module mcp-server/tools/definitions/devops-get-incidents.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getStatuspageService } from '@/services/statuspage/statuspage-service.js';
import type { StatuspageIncident } from '@/services/statuspage/types.js';
import { getVendorRegistryService } from '@/services/vendor-registry/vendor-registry-service.js';
import { assertSafeUrl } from '@/utils/ssrf-guard.js';

function durationMinutes(
  startedAt: string | null | undefined,
  resolvedAt: string | null,
): number | null {
  if (!startedAt || !resolvedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = new Date(resolvedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.round((end - start) / 60_000);
}

function normalizeIncident(i: StatuspageIncident, isScheduled: boolean) {
  const updates = [...i.incident_updates].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );

  const affectedComponents = [
    ...new Set(i.incident_updates.flatMap((u) => (u.affected_components ?? []).map((c) => c.name))),
  ];

  return {
    id: i.id,
    name: i.name,
    impact: (isScheduled ? 'maintenance' : i.impact) as
      | 'none'
      | 'minor'
      | 'major'
      | 'critical'
      | 'maintenance',
    status: i.status,
    created_at: i.created_at,
    started_at: i.started_at ?? null,
    resolved_at: i.resolved_at ?? null,
    scheduled_for: i.scheduled_for ?? null,
    scheduled_until: i.scheduled_until ?? null,
    duration_minutes: durationMinutes(i.started_at, i.resolved_at),
    shortlink: i.shortlink ?? null,
    affected_components: affectedComponents,
    updates: updates.map((u) => ({
      status: u.status,
      body: u.body,
      created_at: u.created_at,
    })),
  };
}

export const devopsGetIncidents = tool('devops_get_incidents', {
  description:
    'Fetch incident history and scheduled maintenance windows for a vendor. ' +
    'Returns full incident timeline — each investigator update, affected components, and resolution. ' +
    'Filter by status to focus on active incidents (use before deploy), resolved history (for postmortem), or upcoming maintenance windows.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    vendor: z
      .string()
      .min(1)
      .describe(
        'Vendor slug (e.g., "github") or raw Statuspage base URL. Use devops_list_vendors to find slugs.',
      ),
    filter: z
      .enum(['all', 'active', 'resolved', 'scheduled'])
      .default('all')
      .describe(
        'all: incidents plus scheduled maintenances. active: only incidents with status investigating/identified/monitoring. resolved: only fully resolved incidents. scheduled: only scheduled maintenance windows.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(20)
      .describe(
        'Maximum incidents to return. Statuspage returns at most 50 per call. Use a lower limit for recent-history queries.',
      ),
  }),

  output: z.object({
    vendor: z.string().describe('Vendor slug or URL as provided.'),
    name: z.string().describe('Display name of the vendor.'),
    incidents: z
      .array(
        z
          .object({
            id: z.string().describe('Unique incident identifier from Statuspage.'),
            name: z.string().describe('Incident title.'),
            impact: z
              .enum(['none', 'minor', 'major', 'critical', 'maintenance'])
              .describe(
                'Severity level: none = informational, minor = degraded performance, major = partial outage, critical = full outage, maintenance = scheduled window.',
              ),
            status: z
              .string()
              .describe(
                'Current status: investigating | identified | monitoring | resolved | postmortem | scheduled | in_progress | completed.',
              ),
            created_at: z
              .string()
              .describe('ISO 8601 UTC timestamp when the incident was created.'),
            started_at: z
              .string()
              .nullish()
              .describe(
                'ISO 8601 UTC timestamp when the incident started, or null/absent if not set by the vendor.',
              ),
            resolved_at: z
              .string()
              .nullable()
              .describe('ISO 8601 UTC timestamp when resolved, or null if still active.'),
            scheduled_for: z
              .string()
              .nullable()
              .describe('Present for scheduled maintenances — ISO 8601 UTC start time.'),
            scheduled_until: z
              .string()
              .nullable()
              .describe('Present for scheduled maintenances — ISO 8601 UTC end time.'),
            duration_minutes: z
              .number()
              .nullable()
              .describe(
                'Minutes from started_at to resolved_at. Null for active or scheduled incidents.',
              ),
            shortlink: z
              .string()
              .nullish()
              .describe(
                'Direct URL to the incident page, or null/absent if not provided by the vendor.',
              ),
            affected_components: z
              .array(z.string())
              .describe('Component names affected by this incident.'),
            updates: z
              .array(
                z
                  .object({
                    status: z.string().describe('Incident status at the time of this update.'),
                    body: z.string().describe('Update text from the vendor.'),
                    created_at: z.string().describe('ISO 8601 UTC timestamp of this update.'),
                  })
                  .describe('A single status update from the vendor.'),
              )
              .describe('Chronological list of incident updates (oldest first).'),
          })
          .describe('An incident or scheduled maintenance entry.'),
      )
      .describe('Matching incidents.'),
    total_returned: z.number().describe('Number of incidents in the response.'),
    statuspage_url: z.string().describe('Statuspage base URL used.'),
  }),

  errors: [
    {
      reason: 'vendor_not_found',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Vendor slug not in registry and input is not a valid URL.',
      recovery: 'Call devops_list_vendors to browse slugs or pass the full Statuspage base URL.',
    },
    {
      reason: 'target_blocked',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'A raw URL resolves to a private, loopback, or cloud-metadata address.',
      recovery:
        'Pass a publicly routable Statuspage URL. If internal monitoring is intentional, set DEVOPS_STATUS_ALLOW_PRIVATE_TARGETS=true.',
    },
    {
      reason: 'statuspage_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Statuspage API returned an error or timed out.',
      recovery: 'Retry after 30s. If it persists, check the status page URL in a browser.',
      retryable: true,
    },
  ],

  async handler(input, ctx) {
    const registry = getVendorRegistryService();
    const statuspage = getStatuspageService();

    const resolved = registry.resolve(input.vendor);
    if (!resolved) {
      throw ctx.fail(
        'vendor_not_found',
        `"${input.vendor}" is not a known vendor slug and is not a valid URL.`,
      );
    }

    // SSRF guard: only raw URL inputs need checking — registry entries are pre-verified public URLs.
    if (resolved.slug === null) {
      try {
        await assertSafeUrl(resolved.url);
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.startsWith('SSRF_BLOCKED')) {
          throw ctx.fail('target_blocked', msg.replace('SSRF_BLOCKED: ', ''));
        }
        throw err;
      }
    }

    let incidents: ReturnType<typeof normalizeIncident>[] = [];

    if (input.filter === 'scheduled') {
      const { data } = await statuspage.fetchScheduledMaintenances(resolved.url);
      incidents = data.scheduled_maintenances.map((i) => normalizeIncident(i, true));
    } else if (input.filter === 'active') {
      const { data } = await statuspage.fetchIncidents(resolved.url);
      incidents = data.incidents
        .filter((i) => ['investigating', 'identified', 'monitoring'].includes(i.status))
        .map((i) => normalizeIncident(i, false));
    } else if (input.filter === 'resolved') {
      const { data } = await statuspage.fetchIncidents(resolved.url);
      incidents = data.incidents
        .filter((i) => ['resolved', 'postmortem'].includes(i.status))
        .map((i) => normalizeIncident(i, false));
    } else {
      // all
      const [incData, mainData] = await Promise.all([
        statuspage.fetchIncidents(resolved.url),
        statuspage.fetchScheduledMaintenances(resolved.url),
      ]);
      const inc = incData.data.incidents.map((i) => normalizeIncident(i, false));
      const maint = mainData.data.scheduled_maintenances.map((i) => normalizeIncident(i, true));
      incidents = [...inc, ...maint].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
    }

    const limited = incidents.slice(0, input.limit);
    ctx.log.info('Incidents fetched', {
      vendor: input.vendor,
      filter: input.filter,
      count: limited.length,
    });

    return {
      vendor: input.vendor,
      name: resolved.name,
      incidents: limited,
      total_returned: limited.length,
      statuspage_url: resolved.url,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## ${result.name} (${result.vendor}) — ${result.total_returned} incidents`,
      `**URL:** ${result.statuspage_url}`,
      '',
    ];
    for (const inc of result.incidents) {
      const icon =
        inc.status === 'resolved' || inc.status === 'completed'
          ? '✅'
          : inc.impact === 'critical'
            ? '🔴'
            : '⚠️';
      lines.push(`### ${icon} ${inc.name} \`${inc.id}\``);
      lines.push(
        `**Impact:** ${inc.impact} | **Status:** ${inc.status} | **Created:** ${inc.created_at}${inc.started_at ? ` | **Started:** ${inc.started_at}` : ''}`,
      );
      if (inc.resolved_at)
        lines.push(`**Resolved:** ${inc.resolved_at} (${inc.duration_minutes ?? '?'} min)`);
      if (inc.scheduled_for)
        lines.push(`**Scheduled:** ${inc.scheduled_for} → ${inc.scheduled_until}`);
      if (inc.affected_components.length > 0) {
        lines.push(`**Components:** ${inc.affected_components.join(', ')}`);
      }
      lines.push(`**Updates (${inc.updates.length}):**`);
      for (const u of inc.updates) {
        lines.push(`- [${u.created_at}] ${u.status}: ${u.body}`);
      }
      if (inc.shortlink) lines.push(`[Incident page](${inc.shortlink})`);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
