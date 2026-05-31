# devops-status-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `devops_status_check` | Check current health status for one or more vendors. Returns per-vendor operational indicator, affected components, and active incident summaries. Accepts registered vendor names or raw Statuspage base URLs. Batch-friendly — pass a list to check your full stack in one call. | `vendors: string[]`, `mode?: 'summary' \| 'detailed'` | `readOnlyHint`, `openWorldHint: true` |
| `devops_get_incidents` | Fetch incident history for a vendor — active, resolved, or scheduled maintenance windows. Returns full timeline of updates (created → investigating → monitoring → resolved), affected components, and postmortem links. | `vendor: string`, `filter?: 'active' \| 'resolved' \| 'scheduled'`, `limit?: number` | `readOnlyHint`, `openWorldHint: true` |
| `devops_watch_stack` | Register a named vendor list as your "stack" and get a unified health snapshot across all entries. Persists the stack in tenant-scoped state so subsequent calls omit the list. Use for morning checks or pre-deploy status sweeps. Returns an aggregate health rollup plus per-vendor detail. | `vendors?: string[]`, `stack_name?: string`, `mode?: 'summary' \| 'detailed'` | `readOnlyHint`, `openWorldHint: true` |
| `devops_check_certs` | Inspect SSL/TLS certificate health for one or more domains. Pure TypeScript — direct TLS handshake, no external API. Reports: days to expiry (flags < 30 and < 7), chain depth, TLS protocol version (flags 1.0/1.1), subject/issuer/SANs, and HSTS header presence (via follow-up HTTP GET over the TLS connection). Works for any domain, not just registered vendors. | `domains: string[]`, `port?: number` | `readOnlyHint`, `openWorldHint: true` |
| `devops_check_dns` | Resolve DNS records and verify propagation for one or more domains. Pure TypeScript — queries `node:dns` against multiple public resolvers (Google 8.8.8.8, Cloudflare 1.1.1.1, Quad9 9.9.9.9). Reports: A/AAAA/CNAME/MX/TXT/NS records, resolution latency per resolver, and resolver discrepancies (propagation gaps). Works for any domain. | `domains: string[]`, `record_types?: Array<'A' \| 'AAAA' \| 'CNAME' \| 'MX' \| 'TXT' \| 'NS'>` | `readOnlyHint`, `openWorldHint: true` |
| `devops_suggest_action` | Instruction tool — given a vendor name and detected status/incident, returns a tailored incident-response playbook and pre-filled follow-up tool calls. Does not perform any actions. Use after `devops_status_check` surfaces a degradation to get mitigation steps: check your own DNS and certs, identify alternative regions/routes, when to enable fallback. | `vendor: string`, `incident_summary?: string`, `affected_components?: string[]` | `readOnlyHint`, `openWorldHint: false` |
| `devops_list_vendors` | List vendors in the built-in registry. Returns name, category, Statuspage base URL, and hosted endpoint type. Accepts an optional search query or category filter. Use to discover available vendors and find the correct name to pass to other tools. | `query?: string`, `category?: string` | `readOnlyHint`, `openWorldHint: false` |

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `devops-status://vendors/{name}` | Full registry entry for a vendor by slug — Statuspage base URL, category, API type. Read-only, stable. | None — single record |

Resources are supplementary. All data is reachable through tools; tool-only agents are fully supported.

### Prompts

None. The tool surface is the complete interface.

---

## Overview

Infrastructure health and incident intelligence for DevOps agents. Aggregates vendor status pages (Atlassian Statuspage convention, keyless), incident history, SSL/TLS certificate health, and DNS propagation checks into a single operational picture.

Two source types:
- **Statuspage API** — vendor status, component health, incidents, and scheduled maintenance windows for any vendor running on Atlassian Statuspage. Probed base URL + `/api/v2/{status,components,incidents,scheduled-maintenances}.json`. No auth required.
- **Pure TypeScript** — TLS certificate inspection (`node:tls`) and DNS resolution (`node:dns`). Zero external dependencies. Works for any domain.

**Vendor registry:** a curated TypeScript data file (`src/data/vendor-registry.ts`) mapping vendor slugs to Statuspage base URLs and categories. Not fetched at runtime. Users can bypass it with raw Statuspage URLs.

Target users: DevOps engineers, SREs, platform teams, and developers who manage upstream dependencies — anyone who needs to distinguish "is my code broken?" from "is my vendor down?"

---

## Requirements

- No API keys — fully public data sources, fully hostable without credentials
- Vendor registry is a static TypeScript data file committed in the repo, not fetched at runtime
- Short-TTL in-memory cache (~60s) on Statuspage reads to avoid thundering-herd on batch calls
- `devops_check_certs` and `devops_check_dns` use only Node.js stdlib (`node:tls`, `node:dns`) — zero additional deps
- Raw Statuspage base URLs accepted everywhere a vendor name is accepted
- All tools operate read-only; no writes, no persistent external effects
- `devops_watch_stack` persists stack configuration via `ctx.state` (tenant-scoped KV)
- `devops_suggest_action` outputs guidance and `nextToolSuggestions` pre-filled from incident context — no external calls, fully deterministic

---

## Vendor Registry Design

**File:** `src/data/vendor-registry.ts`

**Shape per entry:**
```ts
interface VendorEntry {
  slug: string;           // canonical identifier used in tool inputs (e.g., "github", "cloudflare")
  name: string;           // display name (e.g., "GitHub", "Cloudflare")
  category: VendorCategory;
  statuspage_url: string; // Statuspage base URL — typically https:// but may be http:// (e.g., auth0)
  api_type: 'statuspage'; // future: 'custom' for vendors with bespoke APIs
}

type VendorCategory =
  | 'cloud'
  | 'cdn-edge'
  | 'dev-platform'
  | 'data'
  | 'comms'
  | 'auth'
  | 'monitoring'
  | 'ai';
```

**Starter vendor list (26 entries):**

Includes only vendors with verified working Statuspage `/api/v2/status.json` endpoints. Vendors confirmed NOT on Atlassian Statuspage (AWS, GCP, Azure, Hetzner, GitLab, Railway, Fastly, PagerDuty, Okta, Docker Hub, CockroachDB) are excluded from the registry; users can still reach them via raw URL passthrough or future bespoke adapter support.

| Category | Vendors |
|:---------|:--------|
| cloud | digitalocean, linode |
| cdn-edge | cloudflare, akamai |
| dev-platform | github, npm, vercel, netlify, render, fly-io |
| data | mongodb-atlas, planetscale, supabase, neon, redis-cloud |
| comms | slack, discord, twilio, sendgrid, mailgun |
| auth | auth0, clerk |
| monitoring | datadog, sentry |
| ai | openai, anthropic |

Notes on specific entries:
- `anthropic` — Statuspage URL is `https://status.claude.com` (the page is branded "Claude"); `status.anthropic.com` redirects there.
- `auth0` — Statuspage at `http://status.auth0.com` (HTTP, not HTTPS); the URL for Zod validation must allow `http://` for this entry.
- `redis-cloud` — Statuspage at `https://status.redis.io` (not `status.redis.com` or `status.redislabs.com`).
- `neon` — `status.neon.tech` returned a 522 (Cloudflare timeout) during verification; include but mark as may-be-unstable.

Vendor registry is the source of truth for `devops_list_vendors`. Any tool accepting a vendor name resolves it by slug (case-insensitive) against the registry first; if no match and the input looks like a URL, it's treated as a raw Statuspage base URL.

---

## Live API Shapes (verified)

All Statuspage vendors respond to `{base_url}/api/v2/{endpoint}.json` — no auth, no pagination on status/components (incidents returns up to 50 most recent).

### `GET /api/v2/status.json`

```jsonc
{
  "page": {
    "id": "kctbh9vrtdwd",
    "name": "GitHub",
    "url": "https://www.githubstatus.com",
    "time_zone": "Etc/UTC",
    "updated_at": "2026-05-30T10:35:19.208Z"
  },
  "status": {
    "indicator": "none",           // enum: "none" | "minor" | "major" | "critical"
    "description": "All Systems Operational"
  }
}
```

**Indicator enum:** `none` (all operational), `minor`, `major`, `critical`.

### `GET /api/v2/components.json`

```jsonc
{
  "page": { /* same page block */ },
  "components": [{
    "id": "8l4ygp009s5s",
    "name": "Git Operations",
    "status": "operational",  // enum: "operational" | "degraded_performance" | "partial_outage" | "major_outage" | "under_maintenance"
    "created_at": "2017-01-31T20:05:05.370Z",
    "updated_at": "2026-05-27T13:16:53.905Z",
    "position": 1,
    "description": "Performance of git clones, pulls, pushes...",
    "showcase": true,
    "group_id": null,            // present when component belongs to a group
    "group": false,
    "only_show_if_degraded": false
  }]
}
```

**Component status enum:** `operational`, `degraded_performance`, `partial_outage`, `major_outage`, `under_maintenance`.

### `GET /api/v2/incidents.json`

Returns up to 50 most recent resolved incidents plus any active incidents.

```jsonc
{
  "page": { /* same page block */ },
  "incidents": [{
    "id": "rhqcgg8lg6mm",
    "name": "Disruption with OpenAI Models",
    "status": "resolved",     // enum: "investigating" | "identified" | "monitoring" | "resolved" | "postmortem"
    "impact": "critical",     // enum: "none" | "minor" | "major" | "critical"
    "created_at": "2026-05-28T19:01:00.375Z",
    "started_at": "2026-05-28T19:01:00.362Z",
    "resolved_at": "2026-05-28T20:41:58.586Z",
    "monitoring_at": null,
    "shortlink": "https://stspg.io/d82bfd7406c6",
    "page_id": "kctbh9vrtdwd",
    "components": [{ /* component snapshot at incident time */ }],
    "incident_updates": [{
      "id": "csql28v99tck",
      "status": "resolved",
      "body": "This incident has been resolved...",
      "created_at": "2026-05-28T20:41:58.586Z",
      "display_at": "2026-05-28T20:41:58.586Z",
      "affected_components": [{
        "code": "pjmpxvq2cmr2",
        "name": "Copilot",
        "old_status": "degraded_performance",
        "new_status": "operational"
      }]
    }]
  }]
}
```

### `GET /api/v2/scheduled-maintenances.json`

Same shape as incidents; additional fields: `scheduled_for`, `scheduled_until`. Status values include `scheduled`, `in_progress`, `completed`.

### `GET /api/v2/summary.json`

Returns merged object with `status`, `components`, `incidents`, and `scheduled_maintenances` in a single call. Used by `devops_status_check` in `detailed` mode to minimize round trips.

---

## Tool Detail

### `devops_status_check`

**Description:** Check the current health status for one or more vendors. Accepts registered vendor slugs (e.g., `"github"`, `"cloudflare"`) or raw Statuspage base URLs. Returns per-vendor operational indicator (`none` = all clear, `minor`, `major`, `critical`), a list of degraded components with their current status, and summaries of any active incidents. Use `mode: "detailed"` to include component lists even when all are operational, and to surface scheduled maintenance windows.

**Input:**
```ts
z.object({
  vendors: z.array(z.string().min(1))
    .min(1).max(20)
    .describe('Vendor slugs from the built-in registry (e.g., "github", "cloudflare") or raw Statuspage base URLs (e.g., "https://www.githubstatus.com"). Mix freely. Use devops_list_vendors to discover available slugs.'),
  mode: z.enum(['summary', 'detailed']).default('summary')
    .describe('summary: indicator + degraded components + active incidents only. detailed: adds full component list and scheduled maintenance windows. Summary is faster; use detailed when preparing an incident report or checking maintenance schedules.'),
})
```

**Output:**
```ts
z.object({
  results: z.array(z.object({
    vendor: z.string().describe('Vendor slug or URL as provided.'),
    name: z.string().describe('Display name from registry or Statuspage page.name.'),
    indicator: z.enum(['none', 'minor', 'major', 'critical']).describe('Overall health indicator from Statuspage status.json.'),
    description: z.string().describe('Human-readable status description (e.g., "All Systems Operational").'),
    degraded_components: z.array(z.object({
      name: z.string(),
      status: z.enum(['degraded_performance', 'partial_outage', 'major_outage', 'under_maintenance']),
    })).describe('Components not in operational state. Empty when all clear.'),
    active_incidents: z.array(z.object({
      id: z.string(),
      name: z.string(),
      impact: z.enum(['none', 'minor', 'major', 'critical']),
      status: z.string(),
      started_at: z.string().describe('ISO 8601 UTC.'),
      latest_update: z.string().describe('Most recent incident_update.body text.'),
    })).describe('Active (non-resolved) incidents.'),
    scheduled_maintenances: z.array(z.object({
      name: z.string(),
      scheduled_for: z.string(),
      scheduled_until: z.string(),
      status: z.string(),
    })).optional().describe('Upcoming or in-progress maintenance windows. Present in detailed mode only.'),
    all_components: z.array(z.object({
      name: z.string(),
      status: z.string(),
      description: z.string().nullable(),
    })).optional().describe('All components. Present in detailed mode only.'),
    cached: z.boolean().describe('True when this result was served from the 60s in-memory cache.'),
    checked_at: z.string().describe('ISO 8601 UTC timestamp of this check.'),
    statuspage_url: z.string().describe('Statuspage base URL used.'),
  })).describe('Per-vendor status results in the same order as the input vendors list.'),
  summary: z.object({
    total: z.number(),
    operational: z.number(),
    degraded: z.number(),
    down: z.number(),
  }).describe('Aggregate health counts across all checked vendors.'),
})
```

**Errors:**
```ts
errors: [
  {
    reason: 'vendor_not_found',
    code: JsonRpcErrorCode.InvalidParams,
    when: 'A vendor slug does not match any entry in the built-in registry and is not a valid URL.',
    recovery: 'Call devops_list_vendors to browse available slugs, or pass a full Statuspage base URL (e.g., "https://www.githubstatus.com").',
  },
  {
    reason: 'statuspage_unavailable',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'A Statuspage endpoint returned an error or timed out.',
    recovery: 'The vendor status page may be unreachable. Retry after 30s. If it persists, check the URL directly in a browser.',
    retryable: true,
  },
]
```

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`

Handler fans out all vendor fetches with `Promise.allSettled`, so one failed vendor does not block the others. Failed vendors surface in results with an `error` field rather than throwing.

---

### `devops_get_incidents`

**Description:** Fetch incident history and scheduled maintenance windows for a vendor. Returns the full incident timeline — each investigator update, affected components at each step, and when the incident was resolved. Filter by status to focus on active incidents (use before deploy), resolved history (use for postmortem), or upcoming maintenance windows. Returns up to 50 incidents by default (Statuspage's page limit); use `limit` to constrain.

**Input:**
```ts
z.object({
  vendor: z.string().min(1)
    .describe('Vendor slug (e.g., "github") or raw Statuspage base URL. Use devops_list_vendors to find slugs.'),
  filter: z.enum(['all', 'active', 'resolved', 'scheduled']).default('all')
    .describe('all: incidents plus scheduled maintenances. active: only incidents with status investigating/identified/monitoring. resolved: only fully resolved incidents. scheduled: only scheduled maintenance windows.'),
  limit: z.number().int().min(1).max(50).default(20)
    .describe('Maximum incidents to return. Statuspage returns at most 50 per call. Use a lower limit for recent-history queries.'),
})
```

**Output:**
```ts
z.object({
  vendor: z.string(),
  name: z.string(),
  incidents: z.array(z.object({
    id: z.string(),
    name: z.string(),
    impact: z.enum(['none', 'minor', 'major', 'critical', 'maintenance']),
    status: z.string().describe('Current status: investigating | identified | monitoring | resolved | postmortem | scheduled | in_progress | completed'),
    created_at: z.string(),
    started_at: z.string(),
    resolved_at: z.string().nullable(),
    scheduled_for: z.string().nullable().describe('Present for scheduled maintenances.'),
    scheduled_until: z.string().nullable().describe('Present for scheduled maintenances.'),
    duration_minutes: z.number().nullable().describe('Minutes from started_at to resolved_at. Null for active or scheduled incidents.'),
    shortlink: z.string().describe('Direct URL to the incident page.'),
    affected_components: z.array(z.string()).describe('Component names affected by this incident.'),
    updates: z.array(z.object({
      status: z.string(),
      body: z.string(),
      created_at: z.string(),
    })).describe('Chronological list of incident updates (oldest first).'),
  })),
  total_returned: z.number(),
  statuspage_url: z.string(),
})
```

**Errors:**
```ts
errors: [
  {
    reason: 'vendor_not_found',
    code: JsonRpcErrorCode.InvalidParams,
    when: 'Vendor slug not in registry and input is not a valid URL.',
    recovery: 'Call devops_list_vendors to browse slugs or pass the full Statuspage base URL.',
  },
  {
    reason: 'statuspage_unavailable',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'Statuspage API returned an error or timed out.',
    recovery: 'Retry after 30s. If it persists, check the status page URL in a browser.',
    retryable: true,
  },
]
```

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`

---

### `devops_watch_stack`

**Description:** Check the health of a named vendor stack — a saved list of vendors representing your infrastructure dependencies. On the first call, provide `vendors` to define the stack; subsequent calls can omit `vendors` to reuse the persisted list. Returns a unified health snapshot: an aggregate rollup (all green / N degraded) plus per-vendor detail. Ideal for morning status checks or pre-deploy sweeps.

Stack configuration is persisted per tenant via `ctx.state` using the `stack_name` as the key. Multiple stacks can coexist (e.g., `"production"`, `"staging"`).

**Input:**
```ts
z.object({
  vendors: z.array(z.string()).optional()
    .describe('Vendor slugs or raw Statuspage URLs. When provided, saves this list as the stack. When omitted, uses the previously saved list for stack_name. At least one must exist (provided or saved) to proceed.'),
  stack_name: z.string().default('default')
    .describe('Name for this vendor stack. Defaults to "default". Use distinct names to manage multiple stacks (e.g., "production", "data-layer").'),
  mode: z.enum(['summary', 'detailed']).default('summary')
    .describe('summary: indicator + degraded components + active incidents. detailed: adds full component lists and maintenance windows.'),
})
```

**Output:**
```ts
z.object({
  stack_name: z.string(),
  health: z.enum(['all_operational', 'degraded', 'partial_outage', 'major_outage']),
  summary: z.object({
    total: z.number(),
    operational: z.number(),
    degraded: z.number(),
    down: z.number(),
  }),
  vendors: z.array(/* same per-vendor shape as devops_status_check results[] */),
  stack_persisted: z.boolean().describe('True when the vendor list was saved to state on this call.'),
  checked_at: z.string(),
})
```

**Errors:**
```ts
errors: [
  {
    reason: 'no_stack',
    code: JsonRpcErrorCode.InvalidParams,
    when: 'No vendors provided and no saved stack found for stack_name.',
    recovery: 'Provide a vendors list to define the stack. It will be saved for future calls.',
  },
  {
    reason: 'vendor_not_found',
    code: JsonRpcErrorCode.InvalidParams,
    when: 'A vendor slug is not in the registry and is not a valid URL.',
    recovery: 'Call devops_list_vendors to find available slugs or pass a full Statuspage base URL.',
  },
]
```

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`

---

### `devops_check_certs`

**Description:** Inspect SSL/TLS certificate health for one or more domains by performing a real TLS handshake. Pure TypeScript — no external API. Reports: days to expiry (flagged at < 30 days warning and < 7 days critical), certificate subject and SANs, issuer, chain depth, TLS protocol version negotiated (flags TLS 1.0 and 1.1 as insecure), cipher suite, and HSTS presence (detected via an HTTP GET over the TLS socket to read the `Strict-Transport-Security` response header — reported in `flags` as "HSTS present" / "HSTS not configured"). Works for any internet-accessible domain, not just registered vendors.

**Input:**
```ts
z.object({
  domains: z.array(z.string().regex(/^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)*$/).describe('Domain name without protocol (e.g., "api.github.com", "example.com")'))
    .min(1).max(10)
    .describe('Domains to inspect. Do not include "https://" — pass the bare hostname. Up to 10 per call.'),
  port: z.number().int().min(1).max(65535).default(443)
    .describe('TLS port. Defaults to 443. Use 8443 or custom ports for non-standard HTTPS endpoints.'),
  timeout_ms: z.number().int().min(1000).max(15000).default(5000)
    .describe('Connection timeout per domain in milliseconds. Increase for slow or geographically distant endpoints.'),
})
```

**Output:**
```ts
z.object({
  results: z.array(z.object({
    domain: z.string(),
    port: z.number(),
    status: z.enum(['ok', 'warning', 'critical', 'error']),
    flags: z.array(z.string()).describe('Human-readable warnings and issues found: "expires in 12 days", "TLS 1.1 in use", "self-signed certificate", etc.'),
    cert: z.object({
      subject: z.string().describe('Certificate subject CN.'),
      san: z.array(z.string()).describe('Subject Alternative Names covered by this certificate.'),
      issuer: z.string().describe('Issuer common name.'),
      valid_from: z.string().describe('ISO 8601 UTC.'),
      valid_until: z.string().describe('ISO 8601 UTC.'),
      days_until_expiry: z.number().int(),
      chain_depth: z.number().int().describe('Number of certificates in the chain (1 = self-signed).'),
      serial: z.string(),
    }).nullable().describe('Null when connection failed (error status).'),
    tls: z.object({
      protocol: z.string().describe('Negotiated TLS version, e.g., "TLSv1.3".'),
      cipher: z.string().describe('Negotiated cipher suite name.'),
    }).nullable(),
    checked_at: z.string().describe('ISO 8601 UTC.'),
    error: z.string().nullable().describe('Connection error message when status is "error".'),
  })),
})
```

**Errors:**
- Connection failures per-domain are reported inline (status: `'error'`) rather than throwing — batch semantics, partial results are useful. Only systemic errors (invalid input) throw.

```ts
errors: [
  {
    reason: 'invalid_domain',
    code: JsonRpcErrorCode.InvalidParams,
    when: 'A domain string contains a protocol prefix or invalid characters.',
    recovery: 'Remove "https://" and pass the bare hostname only (e.g., "api.github.com" not "https://api.github.com").',
  },
]
```

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`

Implementation: `node:tls` socket with `checkServerIdentity` (allow to proceed regardless to capture cert data), `timeout_ms` enforced with `AbortController`. After the TLS handshake, send a minimal HTTP/1.1 GET request over the same socket to read response headers (captures `Strict-Transport-Security` for HSTS detection). Per-domain results collected with `Promise.allSettled`.

---

### `devops_check_dns`

**Description:** Resolve DNS records and verify propagation for one or more domains across multiple public resolvers. Pure TypeScript — uses `node:dns` with custom resolver addresses. Reports records found (A/AAAA/CNAME/MX/TXT/NS), resolution latency per resolver, and discrepancies between resolvers (propagation gaps). Works for any domain.

**Input:**
```ts
z.object({
  domains: z.array(z.string().min(1)).min(1).max(10)
    .describe('Domain names to query. Up to 10 per call.'),
  record_types: z.array(z.enum(['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS']))
    .default(['A', 'AAAA', 'MX', 'TXT'])
    .describe('DNS record types to resolve. Defaults to A, AAAA, MX, and TXT. Add NS to check nameserver delegation. Add CNAME when investigating redirect chains.'),
  resolvers: z.array(z.string()).default(['8.8.8.8', '1.1.1.1', '9.9.9.9'])
    .describe('Resolver IP addresses to query. Defaults to Google (8.8.8.8), Cloudflare (1.1.1.1), and Quad9 (9.9.9.9). Add custom resolvers to check internal DNS or test resolver-specific behavior.'),
  timeout_ms: z.number().int().min(1000).max(10000).default(3000)
    .describe('Query timeout per domain+resolver combination in milliseconds.'),
})
```

**Output:**
```ts
z.object({
  results: z.array(z.object({
    domain: z.string(),
    records: z.record(
      z.enum(['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS']),
      z.array(z.string())
    ).describe('Resolved records from the primary resolver (8.8.8.8 or first in list). Keyed by record type.'),
    resolver_results: z.array(z.object({
      resolver: z.string().describe('Resolver IP address.'),
      latency_ms: z.number().int(),
      records: z.record(z.string(), z.array(z.string())),
      error: z.string().nullable(),
    })).describe('Per-resolver breakdown for propagation analysis.'),
    propagation_discrepancies: z.array(z.object({
      record_type: z.string(),
      resolvers_agree: z.boolean(),
      values_by_resolver: z.record(z.string(), z.array(z.string())),
    })).describe('Record types where resolvers returned different values. Empty when all resolvers agree.'),
    flags: z.array(z.string()).describe('Human-readable observations: "propagation mismatch on A records", "no MX records found", "CNAME detected — further records resolve via the CNAME target", etc.'),
    error: z.string().nullable(),
  })),
})
```

**Errors:**
```ts
errors: [
  {
    reason: 'invalid_domain',
    code: JsonRpcErrorCode.InvalidParams,
    when: 'A domain string contains a protocol prefix or invalid format.',
    recovery: 'Pass bare hostnames without "https://" (e.g., "example.com").',
  },
]
```

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`

Implementation: `node:dns` `Resolver` class, instantiate one per resolver address, fan out all domain × resolver × record-type queries with `Promise.allSettled`, collect latency with `performance.now()`.

---

### `devops_suggest_action`

**Description:** Instruction tool — returns an incident-response playbook tailored to a vendor degradation, with pre-filled follow-up tool calls. Does not call any external APIs; synthesizes guidance from built-in incident knowledge and the provided context. Use after `devops_status_check` or `devops_get_incidents` surfaces a problem to determine what to investigate next. Output includes static mitigation steps specific to the vendor/component category and `nextToolSuggestions` with arguments pre-populated from `affected_components`.

**Input:**
```ts
z.object({
  vendor: z.string().min(1)
    .describe('Vendor slug or display name (e.g., "cloudflare", "github"). Used to tailor category-specific guidance (CDN outage vs. CI/CD outage vs. auth provider outage).'),
  incident_summary: z.string().optional()
    .describe('Latest incident description or update body from devops_get_incidents. Paste the most recent update to get more targeted advice.'),
  affected_components: z.array(z.string()).optional()
    .describe('Component names affected (from devops_status_check degraded_components or devops_get_incidents affected_components). Tailor suggestions to which subsystem is impacted.'),
  your_domain: z.string().optional()
    .describe('Your own domain or service URL. When provided, nextToolSuggestions will be pre-filled with your domain for cert and DNS checks.'),
})
```

**Output:**
```ts
z.object({
  vendor: z.string(),
  vendor_category: z.string().nullable().describe('Detected category from registry (e.g., "cdn-edge", "auth"). Null for unrecognized vendors.'),
  guidance: z.string().describe('Markdown playbook — immediate steps, diagnostic checks, mitigation options, and what to monitor for resolution. Tailored to the vendor category and affected components.'),
  diagnostics_summary: z.object({
    vendor_indicator: z.string().nullable(),
    affected_components: z.array(z.string()),
    incident_snippet: z.string().nullable(),
  }),
  nextToolSuggestions: z.array(z.object({
    toolName: z.string().describe('Tool to call next (e.g., "devops_check_dns", "devops_check_certs").'),
    reason: z.string().describe('Why this step is recommended given the incident context.'),
    args: z.record(z.unknown()).describe('Arguments pre-filled from provided context (vendor name, your_domain if provided, affected component names).'),
  })).describe('Recommended follow-up calls with arguments already populated. Execute these in sequence to gather diagnostic data.'),
})
```

**Errors:** None expected — no external calls. Fallback to generic guidance when vendor is not in registry.

**Annotations:** `readOnlyHint: true`, `openWorldHint: false`

---

### `devops_list_vendors`

**Description:** List vendors in the built-in registry, optionally filtered by category or name search. Returns slug, display name, category, and Statuspage base URL for each entry. Use to discover the correct slug to pass to other tools, or to see which vendors are available before configuring a stack.

**Input:**
```ts
z.object({
  query: z.string().optional()
    .describe('Free-text search against vendor name and slug. Case-insensitive. E.g., "cloud", "auth", "slack".'),
  category: z.enum(['cloud', 'cdn-edge', 'dev-platform', 'data', 'comms', 'auth', 'monitoring', 'ai']).optional()
    .describe('Filter to one category.'),
})
```

**Output:**
```ts
z.object({
  vendors: z.array(z.object({
    slug: z.string().describe('Use this as the vendor identifier in other tools.'),
    name: z.string(),
    category: z.string(),
    statuspage_url: z.string(),
  })),
  total: z.number(),
  categories: z.array(z.string()).describe('All available category values for use in the category filter.'),
})
```

**Annotations:** `readOnlyHint: true`, `openWorldHint: false`

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `statuspage-service` | Atlassian Statuspage public API (`/api/v2/status.json`, `/components.json`, `/incidents.json`, `/scheduled-maintenances.json`, `/summary.json`). In-memory cache (60s TTL keyed by URL). `fetchWithTimeout` + retry via `/utils`. | `devops_status_check`, `devops_get_incidents`, `devops_watch_stack` |
| `vendor-registry-service` | In-memory registry loaded from `src/data/vendor-registry.ts` at startup. Resolves vendor slugs → Statuspage URLs. Provides category listing and slug→name lookup. | all status tools, `devops_list_vendors`, `devops_suggest_action` |
| `cert-service` | `node:tls` — direct TLS handshake, no external API. Parses X.509 fields from `tls.DetailedPeerCertificate`. | `devops_check_certs` |
| `dns-service` | `node:dns` `Resolver` class — one instance per resolver IP, fanout across record types. | `devops_check_dns` |

**No external SDK dependencies.** All HTTP calls use `fetchWithTimeout` from the framework utilities. TLS and DNS use Node.js stdlib only.

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `MCP_TRANSPORT_TYPE` | No | `stdio` (default) or `http`. Framework standard. |
| `MCP_HTTP_PORT` | No | HTTP port when transport is HTTP. Framework standard. |
| `DEVOPS_STATUS_CACHE_TTL_MS` | No | In-memory cache TTL for Statuspage reads. Default: `60000` (60s). |
| `DEVOPS_STATUS_FETCH_TIMEOUT_MS` | No | Per-request timeout for Statuspage API calls. Default: `8000` (8s). |
| `DEVOPS_STATUS_CERT_TIMEOUT_MS` | No | Per-domain TLS handshake timeout. Default: `5000` (5s). |
| `DEVOPS_STATUS_DNS_TIMEOUT_MS` | No | Per-query DNS timeout. Default: `3000` (3s). |

No API keys. No vendor credentials.

---

## Implementation Order

1. **Vendor registry data file** — `src/data/vendor-registry.ts` with the 26-entry starter list and the `VendorEntry` / `VendorCategory` types. Independently verifiable.
2. **vendor-registry-service** — init/accessor pattern, slug normalization, URL validation for raw inputs.
3. **`devops_list_vendors`** — first tool, validates the registry shape and slug resolution.
4. **statuspage-service** — `fetchSummary()`, `fetchIncidents()`, `fetchScheduledMaintenances()`. Cache layer. Verified against live GitHub and Netlify endpoints.
5. **`devops_status_check`** — fan-out with `Promise.allSettled`, aggregate health rollup.
6. **`devops_get_incidents`** — filter mode (active/resolved/scheduled), duration computation.
7. **`devops_watch_stack`** — `ctx.state` read/write for persisted stack, delegates to statuspage-service.
8. **cert-service** — `node:tls` wrapper, `DetailedPeerCertificate` parsing, expiry flagging.
9. **`devops_check_certs`** — per-domain `Promise.allSettled`, status classification.
10. **dns-service** — multi-resolver `node:dns.Resolver`, propagation discrepancy detection.
11. **`devops_check_dns`** — fan-out across domains × resolvers × record types.
12. **`devops_suggest_action`** — static playbook dispatch by `vendor_category`, `nextToolSuggestions` assembly.
13. **Resource** — `devops-status://vendors/{name}`.
14. **`devcheck`** + field tests against live Statuspage endpoints.

Each step is independently testable. Steps 4–7 can proceed in parallel once vendor-registry-service is ready. Steps 8–9 and 10–11 can proceed in parallel after step 3.

---

## Design Decisions

### Why accept raw Statuspage URLs alongside vendor slugs?

The vendor registry is curated and finite. Any tool that requires a slug forces users to wait for the registry to grow before they can check a vendor they care about. Raw URL passthrough costs nothing to implement — `vendor_not_found` becomes `use_raw_url` instead of a dead end. Users who know a vendor is on Statuspage don't need to know their slug. This also makes the server useful for internal status pages that are on Statuspage infrastructure.

### Why not auto-detect whether a vendor uses Statuspage?

The alternative is: probe the URL, detect Statuspage by content type or page shape, fall back to bespoke parsing. This is unreliable (non-Statuspage pages can have similar paths), slower (extra round trip), and unpredictable for users. The registry is the known-good set; raw URL passthrough is the explicit escape hatch. Bespoke vendor parsing (GCP, Azure Health Dashboard) is a future addition.

### Why `devops_watch_stack` rather than a polling/subscription model?

MCP tools are synchronous request-response. The "watch" name signals intent (monitor a group of vendors over time) not implementation (polling). Each call is a fresh check; `ctx.state` just saves re-specifying the vendor list. Users who want continuous monitoring set up their own polling outside the server. This matches how the tool surface actually works and avoids designing server-side polling that MCP doesn't support.

### Why is there no `devops_status_check_uptime` (HTTP HEAD + latency)?

The idea doc mentions it as a consideration. A latency check against a vendor's primary domain tells you the CDN is reachable, not whether their API or specific services are healthy. It also conflates network path latency (between the server host and the vendor) with actual service health. Statuspage data is self-reported by the vendor — also imperfect, but scoped to the right level. A "latency check" tool would generate false positives (slow from one region, fine globally) and false negatives (fast 200 from a CDN, service internally broken). Cut.

### Why `Promise.allSettled` everywhere?

Batch tools (`devops_status_check`, `devops_watch_stack`, `devops_check_certs`, `devops_check_dns`) accept multiple inputs. One failing target should not block the others — the value of a batch check is the full picture. Failed items are surfaced inline with an `error` field. `allSettled` is the correct primitive: `Promise.all` would throw on the first failure and lose all other results.

### Instruction tool vs. LLM sampling

`devops_suggest_action` could use `ctx.sample` to ask the client's LLM for dynamic guidance. The risk: non-deterministic output, client dependency, potential latency. The value proposition of this tool is predictable, category-specific playbooks — "Cloudflare CDN is down, here are the known mitigation patterns." Static playbook dispatch by vendor category is deterministic, fast, and works in all clients. If `ctx.sample` is present and the vendor/incident is complex, the handler can optionally enrich the response — but the base path is always static.

### Caching strategy

Statuspage APIs are designed for polling (vendors use them for their own dashboards). 60s TTL is conservative — the official Statuspage dashboard polls more frequently. The TTL is configurable via `DEVOPS_STATUS_CACHE_TTL_MS` for users who want fresher data. Cache is in-memory (not `ctx.state`) because it's shared across all tenants — Statuspage data is public and identical for everyone. Cache key: the full Statuspage endpoint URL.

---

## Known Limitations

- **Non-Statuspage vendors:** Many major vendors do NOT use Atlassian Statuspage: AWS (health.aws.amazon.com), GCP (status.cloud.google.com), Azure (status.azure.com), Hetzner (status.hetzner.com), GitLab (status.io-based), Railway (custom), Fastly (access-restricted), PagerDuty (custom endpoint), Okta (auth-gated), Docker Hub (custom), CockroachDB (unreachable). These are excluded from the built-in registry. Users can attempt raw URL passthrough for any that may use Statuspage under a different subdomain, but the server makes no guarantees. Future bespoke adapters could cover the major cloud providers.
- **Vendor self-reporting:** Statuspage data is vendor-published. Vendors may lag incident acknowledgment. `devops_check_certs` and `devops_check_dns` provide ground-truth checks that complement self-reported status.
- **TLS inspection from server host:** `devops_check_certs` connects from wherever the MCP server runs. If the server is hosted, cert checks reflect connectivity from that host — a cert served correctly to the host may still be broken in a specific region. For complete coverage, run the server locally.
- **DNS propagation scope:** `devops_check_dns` queries three public resolvers. Propagation completeness across all global resolvers requires a larger resolver set or a dedicated propagation service.
- **`ctx.state` scope:** Stack configuration persisted by `devops_watch_stack` is tenant-scoped (per client session in stdio mode, per JWT tenant in HTTP mode). Stack configurations do not persist across server restarts in the default memory storage backend.
