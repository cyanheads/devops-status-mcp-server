/**
 * @fileoverview Instruction tool — returns an incident-response playbook tailored to a vendor degradation.
 * No external calls; fully static and deterministic.
 * @module mcp-server/tools/definitions/devops-suggest-action.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from '@/config/server-config.js';
import type { VendorCategory } from '@/data/vendor-registry.js';
import { getVendorRegistryService } from '@/services/vendor-registry/vendor-registry-service.js';

/**
 * Playbook templates reference the active-probe tools via placeholder tokens.
 * When DEVOPS_STATUS_DISABLE_ACTIVE_PROBES removes those tools from the surface,
 * the tokens render as equivalent manual commands instead of unregistered tool names.
 */
const DNS_TOOL_TOKEN = '{{DNS_TOOL}}';
const CERT_TOOL_TOKEN = '{{CERT_TOOL}}';

function renderPlaybook(template: string, probesEnabled: boolean): string {
  const dns = probesEnabled
    ? '`devops_check_dns`'
    : '`dig <domain>` against multiple resolvers (e.g. `@1.1.1.1` and `@8.8.8.8`)';
  const certs = probesEnabled
    ? '`devops_check_certs`'
    : '`openssl s_client -connect <domain>:443 -servername <domain>`';
  return template.replaceAll(DNS_TOOL_TOKEN, dns).replaceAll(CERT_TOOL_TOKEN, certs);
}

/**
 * Every indicator devops_status_check can report. The accepted input, the echoed
 * output, and the guidance table below all read from this one list, so a value
 * copied straight out of a status result is always accepted and always has framing
 * behind it.
 */
const VENDOR_INDICATORS = ['none', 'minor', 'major', 'critical', 'maintenance'] as const;

/** Severity-tailored urgency framing, keyed by the vendor_indicator input. */
const SEVERITY_GUIDANCE: Record<(typeof VENDOR_INDICATORS)[number], string> = {
  none: '**Reported severity: none.** The vendor reports normal operations — verify the problem from your side first; the cause may be local (config, credentials, network) rather than vendor-wide.',
  maintenance:
    '**Reported severity: maintenance (scheduled window).** The disruption is planned and time-boxed — check when the window ends before treating this as an incident, and prefer waiting it out over failover.',
  minor:
    '**Reported severity: minor (degraded performance).** Run the diagnostic checks before disruptive mitigations — confirm your own error rates justify failover.',
  major:
    '**Reported severity: major (partial outage).** Prioritize the immediate steps for your affected components and prepare failover paths now.',
  critical:
    '**Reported severity: critical (full outage).** Execute the immediate steps and activate failover or degraded modes now — do not wait for the next vendor update.',
};

/** Category-specific incident response playbooks. */
const PLAYBOOKS: Record<string, string> = {
  cloud: `## Cloud Provider Outage — Incident Response

**Immediate steps:**
1. Confirm scope: check if the outage is region-specific or global via the status page
2. Switch to backup region if your architecture supports multi-region failover
3. Enable read replicas or DR site if primary compute is unavailable
4. Pause non-critical background jobs and batch processing
5. Communicate status to stakeholders via your internal status channel

**Diagnostic checks:**
- Verify your VMs/containers are still reachable (SSH or management console)
- Check if the control plane is affected (API calls failing) vs. data plane (running workloads)
- Review cloud provider's incident timeline for estimated resolution

**Mitigation:**
- For stateless services: redirect traffic to alternate region (update DNS or load balancer)
- For stateful services: assess data replication lag before failover to avoid data loss
- Scale down non-essential resources to reduce blast radius

**Monitor for:**
- Incident status transitioning from "investigating" → "identified" (they know the cause)
- Component-specific updates for your affected services`,

  'cdn-edge': `## CDN / Edge Network Outage — Incident Response

**Immediate steps:**
1. Determine if the CDN layer or origin is affected (check if origin responds directly)
2. Check which PoPs/regions are affected — CDN outages are often partial
3. Update your DNS TTLs to short values (30–60s) to enable rapid failover

**Diagnostic checks:**
- ${DNS_TOOL_TOKEN} — verify DNS resolution is consistent across resolvers
- ${CERT_TOOL_TOKEN} — confirm your origin certificate is still valid if bypassing CDN
- Test origin directly by hitting your origin IP or bypassing CDN via Host header

**Mitigation:**
- If CDN is unreachable, update DNS to point directly to origin (watch for DDoS exposure)
- Enable CDN failover to backup provider if configured
- Consider temporarily increasing origin server capacity (CDN absorbs ~80–95% of traffic)
- Enable browser caching hints to reduce load during recovery

**Monitor for:**
- CDN PoP recovery (often regional — some users recover before others)
- Cache warming time after CDN restores (first requests to each PoP will be slower)`,

  'dev-platform': `## Dev Platform Outage — Incident Response

**Immediate steps:**
1. Check if CI/CD pipelines are blocked — pause non-critical deployments
2. Assess if production deployments already in flight can be safely halted
3. Notify the team not to merge/push during the outage if Git operations are affected

**Diagnostic checks:**
- Test if repository read access (clone/pull) works even if write/push is degraded
- Check if package registry (npm, Docker) is independently affected
- Verify your local build toolchain works offline (cached dependencies)

**Mitigation:**
- For GitHub/GitLab: use cached artifact from last successful build for hotfixes
- For npm/package registries: use \`--prefer-offline\` or a local Verdaccio mirror
- For deployment platforms (Vercel, Netlify, Render): check if previously deployed version can be rolled back without a new push

**Monitor for:**
- Git operations restoring before the full platform (often first to recover)
- Webhook delivery delays even after primary services recover`,

  data: `## Database / Data Platform Outage — Incident Response

**Immediate steps:**
1. Enable read-only mode in your application immediately if writes are failing
2. Check connection pool health — reset pools if connections are stale/hung
3. Assess if any in-flight transactions are at risk of corruption

**Diagnostic checks:**
- Ping the database host directly and check port connectivity
- Verify your connection string and credentials are not affected by a config rollout
- Check if read replicas are available and healthy

**Mitigation:**
- Route all reads to replicas if primary is unavailable
- Queue writes to a durable message queue (Redis, SQS) for replay after recovery
- Enable circuit breaker to prevent cascade failure to dependent services
- Cache recently read data in application layer to serve read traffic

**Monitor for:**
- Connection count recovering to normal (stale connections often linger)
- Replication lag between primary and replicas after recovery
- Query latency spike during the recovery "thundering herd"`,

  comms: `## Communications Platform Outage — Incident Response

**Immediate steps:**
1. Switch to backup communication channel immediately (alternative Slack workspace, email, phone)
2. If email delivery is affected (SendGrid/Mailgun), pause transactional email sends
3. Do not retry email sends aggressively — you may cause a delivery storm on recovery

**Diagnostic checks:**
- Test webhook delivery if your service relies on inbound webhooks from the platform
- Check if API access is affected independently of the user-facing product

**Mitigation:**
- Queue outbound messages with exponential backoff retry logic
- For critical notifications (alerts, 2FA), have a fallback channel configured
- If SMS is affected (Twilio), use email or push as fallback for 2FA

**Monitor for:**
- Message delivery queue draining after recovery (may take time)
- Duplicate deliveries — some platforms replay queued messages on recovery`,

  auth: `## Auth Provider Outage — Incident Response

**Immediate steps:**
1. Assess impact: are existing sessions still valid, or is only new login affected?
2. If login is fully broken, communicate to users immediately with ETA
3. Do not invalidate existing sessions — keep logged-in users working

**Diagnostic checks:**
- Test token validation endpoint directly (verify your API key is not the issue)
- Check if OAuth redirects work even if login UI is degraded
- Verify your JWKS endpoint is reachable if you validate tokens locally

**Mitigation:**
- Extend session TTLs if auth provider is down to keep existing users logged in
- Enable emergency bypass if you have one (for internal admin access)
- Consider temporarily disabling MFA enforcement if the factor provider is down

**Monitor for:**
- New user registrations may have failed silently — audit after recovery
- OAuth token expiry surge when the outage resolves and sessions refresh`,

  monitoring: `## Monitoring Platform Outage — Incident Response

**Immediate steps:**
1. Acknowledge that your visibility is degraded — don't assume silence = healthy
2. Fall back to raw logs, metrics endpoints, and synthetic checks
3. Increase on-call check frequency manually during the blackout

**Diagnostic checks:**
- Test direct metrics/log access (CloudWatch, GCS, S3) if your monitoring platform aggregates them
- Verify alert routing (PagerDuty, Opsgenie) is independently operational
- Check if dashboards are read-only or if data ingestion is also affected

**Mitigation:**
- Enable basic uptime monitoring via external ping service (UptimeRobot, StatusCake)
- Use ${CERT_TOOL_TOKEN} and ${DNS_TOOL_TOKEN} for ground-truth checks on critical endpoints
- Increase logging verbosity in application to compensate for reduced telemetry

**Monitor for:**
- Metric backfill lag after recovery (timestamps may be off)
- Alert storm when monitoring recovers and processes queued events`,

  ai: `## AI / LLM Provider Outage — Incident Response

**Immediate steps:**
1. Enable fallback to cached or degraded AI responses if your app supports it
2. Disable AI-dependent features gracefully rather than letting them error
3. Check if a specific model or all models/endpoints are affected

**Diagnostic checks:**
- Test a minimal API call to confirm the outage scope (specific model vs. all endpoints)
- Check if your API key is rate-limited vs. a platform-wide outage

**Mitigation:**
- Route to a backup AI provider if you have multi-provider failover configured
- Serve cached/pre-computed AI responses for common queries
- Increase user-facing timeout messages — AI calls may succeed with longer waits

**Monitor for:**
- Request queue buildup — AI provider latency often spikes during recovery
- Rate limit resets once service stabilizes (queued retries can saturate your limit)`,
};

const DEFAULT_PLAYBOOK = `## Service Outage — Generic Incident Response

**Immediate steps:**
1. Confirm the outage scope — partial or complete, regional or global
2. Check your own infrastructure to rule out local configuration issues
3. Notify stakeholders with current status and expected investigation timeline

**Diagnostic checks:**
- ${DNS_TOOL_TOKEN} — verify DNS resolution is consistent
- ${CERT_TOOL_TOKEN} — confirm TLS is valid if you can reach the service
- Test the service directly via curl or ping to distinguish network vs. service failure

**Mitigation:**
- Enable circuit breakers to isolate the failing dependency
- Queue retryable operations rather than failing them immediately
- Serve degraded-mode responses where possible (cached data, reduced feature set)

**Monitor for:**
- Status page indicator transitioning from "investigating" to "identified"
- Partial recovery (some regions/components may recover before others)`;

/**
 * Deterministic incident-context tailoring rules. When an affected component or the
 * incident summary contains one of a rule's terms (case-insensitive substring), the
 * rule's targeted section is prepended ahead of the generic category playbook so the
 * targeted advice leads. Scoped by category to keep the advice relevant. Pure matching —
 * no LLM sampling; the category PLAYBOOKS stay the base/fallback when nothing matches.
 */
type ContextRule = {
  category: VendorCategory;
  terms: readonly string[];
  section: string;
};

const CONTEXT_RULES: readonly ContextRule[] = [
  {
    category: 'dev-platform',
    terms: ['actions', 'pipeline', 'workflow', 'runner', 'deploy', 'build'],
    section: `### Affected subsystem: CI/CD pipelines
1. **Deployment impact:** freeze deploys that depend on this pipeline — in-flight runs may finish in an inconsistent state
2. **Queued work:** expect a backlog of queued runs; re-run checks after recovery rather than trusting one that reported before the incident
3. **Cached artifacts:** ship the last known-good build artifact for hotfixes instead of waiting on a fresh pipeline
4. **Deploy-free mitigations:** prefer feature flags, config rollbacks, or redeploying a previously-built release over anything that needs a new build`,
  },
  {
    category: 'cdn-edge',
    terms: ['dns', 'resolver', 'nameserver', 'name server'],
    section: `### Affected subsystem: DNS resolution
1. **Verify resolution** with ${DNS_TOOL_TOKEN} across multiple resolvers before treating this as a generic origin problem — confirm the records agree
2. **Lower TTLs** to 30–60s now so a failover propagates quickly once you cut over
3. **Stage failover:** prepare an alternate origin or secondary DNS provider and confirm the target is healthy before repointing`,
  },
  {
    category: 'data',
    terms: ['replica', 'replication', 'failover', 'primary', 'connection pool'],
    section: `### Affected subsystem: replication / failover
1. **Route reads to a healthy replica** while the primary is degraded
2. **Check replication lag** before promoting a replica — promoting a lagging node risks data loss
3. **Queue writes** to a durable buffer for replay rather than failing them outright`,
  },
  {
    category: 'auth',
    terms: ['login', 'session', 'sign in', 'sign-in', 'token', 'sso', 'oauth', 'mfa'],
    section: `### Affected subsystem: login / sessions
1. **Do not invalidate existing sessions** — keep already-authenticated users working while login is degraded
2. **Extend session TTLs** so active users are not forced to re-authenticate mid-outage
3. **Emergency access:** enable an admin bypass if you have one, and relax MFA enforcement only if the factor provider itself is down`,
  },
];

export const devopsSuggestAction = tool('devops_suggest_action', {
  description:
    'Return an incident-response playbook tailored to a vendor degradation, with pre-filled follow-up tool calls. ' +
    'Synthesizes category-specific guidance (cloud, CDN, dev-platform, auth, etc.) from built-in incident knowledge and the provided context. ' +
    'Use after devops_status_check or devops_get_incidents surfaces a problem to determine what to investigate next.',
  annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },

  input: z.object({
    vendor: z
      .string()
      .min(1)
      .describe(
        'Vendor slug or display name (e.g., "cloudflare", "github"). Used to tailor category-specific guidance (CDN outage vs. CI/CD outage vs. auth provider outage).',
      ),
    incident_summary: z
      .string()
      .optional()
      .describe(
        'Latest incident description or update body from devops_get_incidents. Paste the most recent update to get more targeted advice.',
      ),
    affected_components: z
      .array(z.string())
      .optional()
      .describe(
        'Component names affected (from devops_status_check degraded_components or devops_get_incidents affected_components). Used to tailor suggestions to the impacted subsystem.',
      ),
    your_domain: z
      .string()
      .optional()
      .describe(
        'Your own domain or service URL. When provided, nextToolSuggestions will be pre-filled with your domain for cert and DNS checks.',
      ),
    vendor_indicator: z
      .enum(VENDOR_INDICATORS)
      .optional()
      .describe(
        'Overall vendor status indicator from a prior devops_status_check call (its indicator field). ' +
          'When provided, the playbook leads with severity-tailored urgency guidance. Omit if status has not been checked yet.',
      ),
  }),

  output: z.object({
    vendor: z.string().describe('Vendor as provided.'),
    vendor_category: z
      .string()
      .nullable()
      .describe(
        'Detected category from registry (e.g., "cdn-edge", "auth"). Null for unrecognized vendors.',
      ),
    guidance: z
      .string()
      .describe(
        'Markdown playbook — immediate steps, diagnostic checks, mitigation options, and what to monitor for resolution. Tailored to the vendor category, reported severity, and affected components.',
      ),
    diagnostics_summary: z
      .object({
        vendor_indicator: z
          .enum(VENDOR_INDICATORS)
          .nullable()
          .describe(
            'Vendor status indicator echoed from the vendor_indicator input, or null when not provided.',
          ),
        affected_components: z
          .array(z.string())
          .describe('Affected component names echoed from the affected_components input.'),
        incident_snippet: z
          .string()
          .nullable()
          .describe(
            'The incident_summary input echoed in full for context, or null when not provided.',
          ),
      })
      .describe('Summary of input context used to generate the playbook.'),
    nextToolSuggestions: z
      .array(
        z
          .object({
            toolName: z
              .string()
              .describe('Tool to call next (e.g., "devops_check_dns", "devops_check_certs").'),
            reason: z.string().describe('Why this step is recommended given the incident context.'),
            args: z
              .record(z.string(), z.unknown())
              .describe('Ready-to-use arguments for the suggested tool call.'),
          })
          .describe('A recommended follow-up tool call with pre-filled arguments.'),
      )
      .describe(
        'Recommended follow-up calls with arguments already populated. Execute these in sequence to gather diagnostic data.',
      ),
  }),

  handler(input, ctx) {
    const registry = getVendorRegistryService();
    const { disableActiveProbes } = getServerConfig();
    const entry = registry.getBySlugOrName(input.vendor);
    const category = entry?.category ?? null;

    // Deterministic incident-context tailoring: match the affected components and the
    // incident summary against this category's rules, prepending each matched section
    // ahead of the generic playbook so targeted advice leads. Empty when nothing matches
    // or the vendor is unregistered — the category template stays the fallback.
    const contextHaystack = [...(input.affected_components ?? []), input.incident_summary ?? '']
      .join(' ')
      .toLowerCase();
    const matchedRules = category
      ? CONTEXT_RULES.filter(
          (rule) =>
            rule.category === category && rule.terms.some((term) => contextHaystack.includes(term)),
        )
      : [];

    const template = category ? (PLAYBOOKS[category] ?? DEFAULT_PLAYBOOK) : DEFAULT_PLAYBOOK;
    const sections = [
      input.vendor_indicator ? SEVERITY_GUIDANCE[input.vendor_indicator] : '',
      ...matchedRules.map((rule) => rule.section),
      template,
    ].filter(Boolean);
    const guidance = renderPlaybook(sections.join('\n\n'), !disableActiveProbes);

    // Build nextToolSuggestions based on context
    const suggestions: Array<{
      toolName: string;
      reason: string;
      args: Record<string, unknown>;
    }> = [];

    // Always suggest checking incidents
    suggestions.push({
      toolName: 'devops_get_incidents',
      reason:
        'Get full incident timeline with all investigator updates and affected component history.',
      args: {
        vendor: entry?.slug ?? input.vendor,
        filter: 'active',
        limit: 5,
      },
    });

    // When incident context identifies a subsystem, re-check the vendor in detailed
    // mode so the agent can watch that specific component return to operational.
    if (matchedRules.length > 0 && entry) {
      suggestions.push({
        toolName: 'devops_status_check',
        reason:
          'Re-check this vendor in detailed mode to watch the affected component(s) return to operational.',
        args: {
          vendors: [entry.slug],
          mode: 'detailed',
        },
      });
    }

    // Suggest DNS and cert checks if a domain is provided or can be inferred —
    // but never when active probes are disabled (those tools are not registered).
    const domainToCheck =
      input.your_domain?.replace(/^https?:\/\//i, '').replace(/\/.*$/, '') ?? null;
    if (domainToCheck && !disableActiveProbes) {
      suggestions.push({
        toolName: 'devops_check_dns',
        reason:
          'Verify DNS propagation for your domain — an outage may cause stale records to linger.',
        args: {
          domains: [domainToCheck],
          record_types: ['A', 'AAAA', 'MX'],
        },
      });
      suggestions.push({
        toolName: 'devops_check_certs',
        reason:
          'Confirm your SSL/TLS certificate is valid and HSTS is configured before re-routing traffic.',
        args: {
          domains: [domainToCheck],
          port: 443,
        },
      });
    }

    // If CDN/edge outage, suggest checking the vendor's own domain as a cert check target
    if (category === 'cdn-edge' && entry && domainToCheck) {
      suggestions.push({
        toolName: 'devops_status_check',
        reason:
          'Re-check vendor status to detect partial recovery (CDN outages often recover region by region).',
        args: {
          vendors: [entry.slug],
          mode: 'detailed',
        },
      });
    }

    const incidentSnippet = input.incident_summary ?? null;

    ctx.log.info('Action suggested', { vendor: input.vendor, category });

    // Dedupe follow-ups by tool + args — context tailoring and the CDN-edge branch can
    // re-propose the same detailed status re-check.
    const seen = new Set<string>();
    const nextToolSuggestions = suggestions.filter((s) => {
      const key = `${s.toolName}:${JSON.stringify(s.args)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return {
      vendor: input.vendor,
      vendor_category: category,
      guidance,
      diagnostics_summary: {
        vendor_indicator: input.vendor_indicator ?? null,
        affected_components: input.affected_components ?? [],
        incident_snippet: incidentSnippet,
      },
      nextToolSuggestions,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## Incident Response: ${result.vendor}`,
      result.vendor_category ? `**Category:** ${result.vendor_category}` : '',
      '',
      result.guidance,
      '',
      '---',
      '## Recommended Next Steps',
      '',
    ];
    for (const s of result.nextToolSuggestions) {
      lines.push(`### \`${s.toolName}\``);
      lines.push(`**Why:** ${s.reason}`);
      lines.push(`**Args:** \`${JSON.stringify(s.args)}\``);
      lines.push('');
    }
    if (result.diagnostics_summary.incident_snippet) {
      lines.push('---');
      lines.push('**Incident context:**');
      lines.push(`> ${result.diagnostics_summary.incident_snippet}`);
    }
    if (result.diagnostics_summary.affected_components.length > 0) {
      lines.push(
        `**Affected components:** ${result.diagnostics_summary.affected_components.join(', ')}`,
      );
    }
    lines.push(
      `**Vendor indicator:** ${result.diagnostics_summary.vendor_indicator ?? 'not specified'}`,
    );
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
