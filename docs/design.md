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

All Statuspage vendors respond to `{base_url}/api/v2/{endpoint}.json` — no auth, no pagination anywhere. `incidents.json` returns the 50 most recent and ignores a `?page=` parameter, so 50 is a hard ceiling on reachable history; `devops_get_incidents` discloses it when a call hits it.

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
    .describe('summary: indicator + degraded components + active incidents only. detailed: adds the component list and scheduled maintenance windows. Summary is faster; use detailed when preparing an incident report or checking maintenance schedules.'),
  component_filter: z.string().optional()
    .describe('Case-insensitive substring matched against component names in detailed mode. Applied before component_limit, so it is the way to reach a component the cap would otherwise omit.'),
  component_limit: z.number().int().min(1).max(500).default(50)
    .describe('Maximum components returned per vendor in detailed mode.'),
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
    })).optional().describe('Components, narrowed by component_filter and capped at component_limit. Present in detailed mode only.'),
    all_components_total: z.number().optional()
      .describe('Components matching component_filter for this vendor before the cap. Present in detailed mode only.'),
    cached: z.boolean().describe('True when this result was served from the 60s in-memory cache.'),
    checked_at: z.string().describe('ISO 8601 UTC timestamp of this check.'),
    statuspage_url: z.string().describe('Statuspage base URL used. Empty for a vendor entry that resolved to no target.'),
    error: z.string().optional().describe('Why this vendor could not be checked. Absent on success.'),
  })).describe('Per-vendor status results in the same order as the input vendors list.'),
  summary: z.object({
    total: z.number(),
    operational: z.number(),
    degraded: z.number(),
    down: z.number(),
    unavailable: z.number(),
  }).describe('Aggregate health counts across all checked vendors. Buckets partition the batch: operational + degraded + down + unavailable = total.'),
})
```

**Enrichment:** `truncated` / `shown` / `cap` / `totalCount`, written once after the fan-out when at least one vendor's component list was capped. `buildVendorResult()` runs per vendor with no `ctx`, so it returns the matched and shown component counts and the handler aggregates them into a single `ctx.enrich.truncated()` call for the whole batch.

**Errors:**
```ts
errors: [
  {
    reason: 'vendor_not_found',
    code: JsonRpcErrorCode.NotFound,
    when: 'No requested vendor could be checked and the first failure was a slug that matches no registry entry and is not a valid URL.',
    recovery: 'Call devops_list_vendors to browse available slugs, or pass a full Statuspage base URL (e.g., "https://www.githubstatus.com").',
  },
  {
    reason: 'target_blocked',
    code: JsonRpcErrorCode.ValidationError,
    when: 'No requested vendor could be checked and the first failure was a raw URL resolving to a private, loopback, or cloud-metadata address.',
    recovery: 'Pass a publicly routable Statuspage URL. If internal monitoring is intentional, set DEVOPS_STATUS_ALLOW_PRIVATE_TARGETS=true.',
  },
]
```

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`

Handler fans out all vendor fetches with `Promise.allSettled`, so one failed vendor does not block the others. Failed vendors surface in results with an `error` field rather than throwing. Because no fetch failure reaches a top-level throw, this tool declares no `statuspage_unavailable` contract — an unreachable status page is per-vendor data, not a tool error.

The same rule covers a vendor entry that never reaches a fetch: an unresolvable slug or an SSRF-blocked URL becomes an `error` row in `results[]`, counted in the `unavailable` bucket, so one bad entry cannot discard the rest of the batch. Both contract entries above fire only when *nothing* resolved — partial failure is data, total failure is an error, and one typed error carrying a recovery hint beats a batch of error rows under a summary reading `operational: 0`. The all-failed message names every failing entry so one round trip corrects them all.

---

### `devops_get_incidents`

**Description:** Fetch incident history and scheduled maintenance windows for a vendor. Returns the full incident timeline — each investigator update, affected components at each step, and when the incident was resolved. Filter by status to focus on active incidents (use before deploy), resolved history (use for postmortem), or upcoming maintenance windows. Page long histories with `limit` + `offset`.

**Input:**
```ts
z.object({
  vendor: z.string().min(1)
    .describe('Vendor slug (e.g., "github") or raw Statuspage base URL. Use devops_list_vendors to find slugs.'),
  filter: z.enum(['all', 'active', 'resolved', 'scheduled']).default('all')
    .describe('all: incidents plus scheduled maintenances. active: only incidents with status investigating/identified/monitoring. resolved: only fully resolved incidents. scheduled: only scheduled maintenance windows. Not every backend serves every filter — an empty result names which case applied.'),
  limit: z.number().int().min(1).max(50).default(20)
    .describe('Maximum incidents to return per call (1–50). Page through longer history with offset rather than raising this.'),
  offset: z.number().int().min(0).default(0)
    .describe('Matching incidents to skip before applying limit. A truncated result returns the value to use next in the nextOffset enrichment field.'),
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

**Enrichment:** every field is optional and written only on the path that produces it, so a plain result carries none of them. All reach both `structuredContent` and the `content[]` trailer via `output.extend(enrichment)`.

| Field | Written when |
|:---|:---|
| `truncated`, `shown`, `cap`, `totalCount` | more incidents matched the filter than `limit` returned |
| `nextOffset` | same — the `offset` to pass next, already computed. Its absence is the stop condition for an agent paging in a loop |
| `upstreamCeiling` | the vendor's own feed returned as many records as it will ever serve (see below). Independent of `truncated`: a full window can be the vendor's cap rather than this tool's |
| `notice` | any of the above, or an empty result. Composed into one string because the framework's `notice` is last-wins across `ctx.enrich` calls |

**Empty results** explain themselves through `notice`, in terms of the call that produced them: an `offset` past the end names the valid range; a filter the backend cannot satisfy says so; otherwise the message names the filters that vendor *can* serve, never the one just used.

**Errors:**
```ts
errors: [
  {
    reason: 'vendor_not_found',
    code: JsonRpcErrorCode.NotFound,
    when: 'Vendor slug not in registry and input is not a valid URL.',
    recovery: 'Call devops_list_vendors to browse slugs or pass the full Statuspage base URL.',
  },
  {
    reason: 'target_blocked',
    code: JsonRpcErrorCode.ValidationError,
    when: 'A raw URL resolves to a private, loopback, or cloud-metadata address.',
    recovery: 'Pass a publicly routable Statuspage URL. If internal monitoring is intentional, set DEVOPS_STATUS_ALLOW_PRIVATE_TARGETS=true.',
  },
  {
    reason: 'statuspage_unavailable',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: "The vendor's status API returned an error or timed out.",
    recovery: 'Retry after 30s. If it persists, check the status page URL in a browser.',
    retryable: true,
  },
]
```

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`, `idempotentHint: true`

#### Backend history capabilities

Normalizing five backends to the Statuspage shapes hides what each feed can actually serve. `backendHistory()` in `status-dispatch.ts` states it, exhaustively over `api_type` so a new backend cannot be added without answering all three questions:

| Backend | Incident ceiling | Resolved history | Maintenance windows |
|:---|:---|:---|:---|
| Statuspage | 50 per fetch, `?page=` ignored | full (within the ceiling) | yes |
| Slack | 50 per fetch, `?page=` ignored | full (within the ceiling) | none — empty with no network call |
| AWS Health | unbounded (open events only) | none — no lifecycle field, every event maps to `investigating` | none — empty with no network call |
| Status.io | unbounded (current incidents only) | current only — resolved incidents drop off the feed | yes |
| FireHydrant | unbounded — the payload carries the whole history | full | yes |

---

### `devops_watch_stack`

**Description:** Check the health of a named vendor stack — a saved list of vendors representing your infrastructure dependencies. On the first call, provide `vendors` to define the stack; subsequent calls can omit `vendors` to reuse the persisted list. Returns a unified health snapshot: an aggregate rollup (all green / N degraded) plus per-vendor detail. Ideal for morning status checks or pre-deploy sweeps.

Stack configuration is persisted per tenant via `ctx.state` using the `stack_name` as the key. Multiple stacks can coexist (e.g., `"production"`, `"staging"`).

Only the vendors that resolve are saved. Persisting an entry that resolves to no target would put a permanent error row in every future sweep of that stack, so the write covers the resolvable subset and `omitted_vendors` names what was left out — the caller is told the saved stack is smaller than what they passed. A list where *nothing* resolves throws and writes nothing at all. A call that reuses a saved stack does not rewrite it, so an entry that stopped resolving since it was saved stays listed in `omitted_vendors` on every call until the caller re-provides `vendors`.

**Input:**
```ts
z.object({
  vendors: z.array(z.string()).optional()
    .describe('Vendor slugs or raw Statuspage URLs. When provided, saves the resolvable ones as the stack. When omitted, uses the previously saved list for stack_name. At least one must exist (provided or saved) to proceed.'),
  stack_name: z.string().default('default')
    .describe('Name for this vendor stack. Defaults to "default". Use distinct names to manage multiple stacks (e.g., "production", "data-layer").'),
  mode: z.enum(['summary', 'detailed']).default('summary')
    .describe('summary: indicator + degraded components + active incidents. detailed: adds component lists and maintenance windows.'),
  component_filter: z.string().optional()
    .describe('Case-insensitive substring matched against component names in detailed mode. Applied before component_limit.'),
  component_limit: z.number().int().min(1).max(500).default(50)
    .describe('Maximum components returned per vendor in detailed mode.'),
})
```

**Output:**
```ts
z.object({
  stack_name: z.string(),
  health: z.enum(['all_operational', 'degraded', 'partial_outage', 'major_outage', 'unknown']),
  summary: z.object({
    total: z.number(),
    operational: z.number(),
    degraded: z.number(),
    down: z.number(),
    unavailable: z.number(),
  }),
  vendors: z.array(/* same per-vendor shape as devops_status_check results[] */),
  stack_persisted: z.boolean().describe('True when the vendor list was saved to state on this call.'),
  omitted_vendors: z.array(z.string()).describe('Entries that could not be resolved or were blocked, and so are left out whenever the stack is saved. They still appear in vendors[] with an error.'),
  checked_at: z.string(),
})
```

**Enrichment:** `truncated` / `shown` / `cap` / `totalCount`, identical to `devops_status_check` — both tools share `buildVendorResult()` and aggregate its component counts once after the fan-out.

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
    code: JsonRpcErrorCode.NotFound,
    when: 'No vendor in the stack could be checked and the first failure was a slug that is not in the registry and is not a valid URL.',
    recovery: 'Call devops_list_vendors to find available slugs or pass a full Statuspage base URL.',
  },
  {
    reason: 'target_blocked',
    code: JsonRpcErrorCode.ValidationError,
    when: 'No vendor in the stack could be checked and the first failure was a raw URL resolving to a private, loopback, or cloud-metadata address.',
    recovery: 'Pass a publicly routable Statuspage URL. If internal monitoring is intentional, set DEVOPS_STATUS_ALLOW_PRIVATE_TARGETS=true.',
  },
]
```

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`

---

### `devops_check_certs`

**Description:** Inspect SSL/TLS certificate health for one or more domains by performing a real TLS handshake. Pure TypeScript — no external API. Reports: days to expiry (flagged at < 30 days warning and < 7 days critical), certificate subject and SANs, issuer, hostname coverage, chain-trust verification, chain depth where the runtime exposes it, TLS protocol version negotiated (flags TLS 1.0 and 1.1 as insecure), cipher suite, and HSTS presence (detected via an HTTP GET over the TLS socket to read the `Strict-Transport-Security` response header — reported in `flags` as "HSTS present" / "HSTS not configured"). Works for any internet-accessible domain, not just registered vendors.

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
    status: z.enum(['ok', 'warning', 'critical', 'error']).describe('critical = expired or < 7 days, hostname mismatch, chain-trust failure, or insecure TLS; warning = < 30 days; error = connection failed.'),
    flags: z.array(z.string()).describe('Human-readable warnings and issues found: "Expires in 12 days (warning)", "Insecure TLS version in use: TLSv1.1", "Self-signed certificate", "Hostname mismatch — the certificate does not cover <domain>; clients will reject it", "Certificate chain not trusted (<CODE>); clients will reject it", etc.'),
    cert: z.object({
      subject: z.string().describe('Certificate subject CN.'),
      san: z.array(z.string()).describe('Subject Alternative Names covered by this certificate.'),
      issuer: z.string().describe('Issuer common name.'),
      valid_from: z.string().describe('ISO 8601 UTC.'),
      valid_until: z.string().describe('ISO 8601 UTC.'),
      days_until_expiry: z.number().int(),
      chain_depth: z.number().int().nullable().describe('Number of certificates the server sent, counting the leaf. Null when the runtime does not expose the issuer chain. Not a self-signed indicator.'),
      chain_depth_unavailable_reason: z.string().nullable().describe('Why chain_depth is null, or null when a depth was measured.'),
      hostname_verification_error: z.string().nullable().describe('tls.checkServerIdentity() message when the requested hostname is not covered by the CN or SANs, else null.'),
      authorization_error: z.string().nullable().describe('OpenSSL chain-verification code (DEPTH_ZERO_SELF_SIGNED_CERT, SELF_SIGNED_CERT_IN_CHAIN, UNABLE_TO_VERIFY_LEAF_SIGNATURE, CERT_HAS_EXPIRED), else null. The authoritative chain-trust signal.'),
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

Implementation: `node:tls` socket with `rejectUnauthorized: false` and an overridden `checkServerIdentity`, so a certificate ordinary clients reject is still inspected rather than collapsing into a connection error. The override does not discard the hostname check: it calls `tls.checkServerIdentity(host, cert)` explicitly, records the result in `hostname_verification_error`, and returns `undefined` to let the handshake finish. Chain trust comes from `socket.authorizationError`, read independently — it is populated even under `rejectUnauthorized: false`, and is normalized from the bare OpenSSL code string some runtimes return. `timeout_ms` enforced with a timer that destroys the socket. After the TLS handshake, send a minimal HTTP/1.1 GET request over the same socket to read response headers (captures `Strict-Transport-Security` for HSTS detection). Per-domain results collected with `Promise.allSettled`.

---

### `devops_check_dns`

**Description:** Resolve DNS records for one or more domains across multiple public resolvers and compare what each resolver returned. Pure TypeScript — uses `node:dns` with custom resolver addresses. Reports records found (A/AAAA/CNAME/MX/TXT/NS), resolution latency per resolver, a typed outcome per resolver and record type (`ok` / `nodata` / `nxdomain` / `servfail` / `refused` / `timeout` / `error`), and resolver disagreements labelled by kind rather than by an asserted cause. Works for any domain.

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
    ).describe('Resolved records from one resolver — the primary (first in list), or the first resolver that returned records when the primary returned none. Keyed by record type.'),
    records_source: z.string().nullable().describe('Resolver IP whose answers populated `records`, or null when no resolver was queried.'),
    resolver_results: z.array(z.object({
      resolver: z.string().describe('Resolver IP address.'),
      latency_ms: z.number().int(),
      records: z.record(z.string(), z.array(z.string())),
      status: z.enum(DNS_QUERY_STATUSES).describe('Headline outcome: ok when any requested type resolved, else the most actionable failure across types.'),
      status_by_type: z.record(z.string(), z.enum(DNS_QUERY_STATUSES)).describe('Outcome per requested record type. nodata = the domain exists but has no record of this type; nxdomain = the domain does not exist; servfail = the resolver could not answer, commonly DNSSEC.'),
      error: z.string().nullable().describe('Failure summary such as "SERVFAIL on A, MX", or null when every type resolved or returned nodata.'),
    })).describe('Per-resolver breakdown for propagation analysis.'),
    propagation_discrepancies: z.array(z.object({
      record_type: z.string(),
      resolvers_agree: z.boolean(),
      kind: z.enum(['value_variation', 'partial_resolution']).describe('partial_resolution = some resolvers answered and some did not (the signal worth investigating); value_variation = every resolver answered with different values (anycast/geo-steering, or an in-flight change).'),
      values_by_resolver: z.record(z.string(), z.array(z.string())),
      status_by_resolver: z.record(z.string(), z.enum(DNS_QUERY_STATUSES)).describe('Per-resolver outcome for this record type — explains why an entry in values_by_resolver is empty.'),
    })).describe('Record types where resolvers returned different answers, labelled by kind. Empty when all resolvers agree.'),
    flags: z.array(z.string()).describe('Observations needing attention: "NXDOMAIN from 8.8.8.8 on A — the domain does not exist …", "SERVFAIL from 1.1.1.1 on A — …", "Partial resolution on A records — 9.9.9.9 (nodata) returned nothing while 8.8.8.8 answered", "No MX records found", "CNAME detected — further records resolve via the CNAME target". A value_variation is deliberately not flagged.'),
    error: z.string().nullable().describe('Set only when every resolver failed and none returned records; names each resolver with its own outcome so a split result stays visible.'),
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

Implementation: `node:dns` `Resolver` class, instantiate one per resolver address, fan out all domain × resolver × record-type queries with `Promise.allSettled`, collect latency with `performance.now()`. Each query's error code is mapped to a typed status (`ENODATA` → nodata, `ESERVFAIL` → servfail, `EREFUSED`/`ECONNREFUSED` → refused, `ETIMEOUT`/`ETIMEDOUT` → timeout, unmapped → error). `ENOTFOUND` is handled separately: c-ares raises it both for a true NXDOMAIN and for a NOERROR response with an empty answer section on some record types, so nxdomain is claimed only when every requested type for that resolver came back `ENOTFOUND` — otherwise the name demonstrably resolves and the empty type is a nodata.

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

### Why an all-failed batch still throws

Resolution failures follow the same inline rule as fetch failures — an unresolvable slug or a blocked URL is an `error` row, not a thrown error — but only while something else in the batch survives. When nothing resolves there is no data to return, and a typed error carrying a recovery hint is more actionable than N error rows under a summary reading `operational: 0`. The threshold is the presence of a result, not the count of failures. The all-failed message names every failing entry so a caller with several bad slugs fixes them in one round trip rather than one per correction.

### Why `devops_watch_stack` saves only the resolvable subset

A saved stack is replayed on every later call, so persisting an entry that resolves to no target would manufacture a permanent error row for as long as the stack exists. Dropping it silently is equally wrong — the caller would keep believing the stack holds what they passed. The write covers the resolvable subset and `omitted_vendors` reports the difference.

### Why detailed-mode component lists are capped

Component lists are unbounded upstream — a single large page publishes several hundred, and a full-stack detailed sweep runs to six figures of response bytes, most of it operational rows nobody asked about. `component_limit` (default 50) bounds it, `component_filter` reaches a specific component past the cap, and `ctx.enrich.truncated()` discloses what was dropped rather than silently returning a partial list. The disclosure is aggregated across the fan-out because `buildVendorResult()` has no `ctx`; it returns component counts and the handler emits one signal for the batch.

### Why the upstream history cap is disclosed rather than paged around

Atlassian's `/api/v2/incidents.json` returns at most 50 records and ignores `?page=`, and Slack's `/api/v2.0.0/history` behaves identically. The tool used to present a full 50-record window as complete history, so a caller doing postmortem work could not tell a vendor whose incidents genuinely stop there from one whose older incidents were simply out of reach. Reaching further means a second, undocumented surface with its own shape and failure modes; that is a separate change, and pretending it exists is worse than naming the ceiling. So the fix is disclosure: `upstreamCeiling` and a `notice` state the cap when it was hit and point at the vendor status page, which is where the omitted incidents actually live. The tool never claims history it did not fetch.

### Why empty-result guidance is enrichment, not output

`format()` receives only the domain object, which carries no `filter`, `offset`, or backend — so a single static sentence was the most it could say, and that sentence recommended the filter the caller had just used and history from backends that publish none. Widening `output` to carry the call's parameters back into `format()` would put request echo in the domain payload of every response, including the ones that need no explanation. `ctx.enrich.notice()` is the framework's success-path channel for exactly this: it reaches `structuredContent` and the `content[]` trailer without touching the domain contract, and it is written only when there is something to say. `format()`'s empty branch is correspondingly narrowed to stating the empty result, since anything it named would contradict the trailer beside it.

### Why the DNS outcome is a typed enum rather than a message

`queryResolver()` collapsed `ENODATA`, `ENOTFOUND`, and `ESERVFAIL` into one silent "no records of this type", so a domain that does not exist, a resolver that could not answer, and a record that is genuinely absent produced byte-identical output. Those three call for different operator actions — register or fix the name, fix the zone signing or delegation, add the record — and a DNSSEC validation failure is one of the outage causes the tool most needs to name. The outcome is an enum (`status_by_type`, rolled up into `status`) rather than prose in `error` because two consumers branch on it programmatically: the disagreement classifier below needs to tell "this resolver returned nothing" from "this resolver returned something different", and an agent triaging an incident needs a stable value to key on. `nodata` stays the only silent case, since it is a valid DNS answer rather than a failure.

### Why geo-steering is not reported as a propagation mismatch

`findDiscrepancies()` compared resolver answers for exact equality and labelled every difference `Propagation mismatch on <type> records`, asserting an in-flight DNS change the data never established. Anycast and geo-steered domains return different addresses per resolver at steady state — a CDN-fronted hostname trips this on every call while nothing is wrong. The two cases are now separated by `kind`: `partial_resolution` (at least one resolver answered and at least one returned nothing) is the shape that actually indicates propagation lag, a broken resolver, or a partial delegation, and it is flagged; `value_variation` (every resolver answered, values differ) is recorded in `propagation_discrepancies` with its per-resolver values but deliberately not flagged, so it does not read as a fault. Neither value names a cause on its own — the tool reports what it observed and leaves the diagnosis to the reader.

### Why the domain-level flags and error span every resolver

Both were derived from a single resolver: `records` and the "no A or AAAA records found" flag came from `resolverResults[0]`, and the domain `error` took the first erroring resolver's message. A failing primary therefore reported a healthy domain as record-less, and a split outcome — one resolver NXDOMAIN, another SERVFAIL — lost exactly the divergence worth seeing. Flags are now derived from every resolver, grouped per condition and naming the resolvers and record types affected. `records` falls back to the first resolver that answered, with `records_source` naming which one, so the summary is never emptier than the data. The domain-level `error` is reserved for "could not be queried at all" — every resolver failed and none returned records — and lists each resolver's own outcome; a partial failure leaves `error` null and surfaces in `flags` instead.

### Why `chain_depth` is nullable rather than defaulted to 1

`inspectCert()` initialized depth to 1 and walked `getPeerCertificate(true).issuerCertificate`, but that link is not populated on every supported runtime — under Bun it is absent even for CA-issued chains, so an ordinary three-certificate chain collapsed to `chain_depth: 1` while the output contract documented `1` as self-signed. A consumer reading that for a major site concludes "leaf only, no intermediates", which is false. Reading the served chain another way would mean shelling out to `openssl` — a process dependency well out of proportion to one diagnostic field. So the field reports what it can actually measure: a count when the chain is traversable, `null` plus `chain_depth_unavailable_reason` when it is not. A missing number is honest; a wrong one is not. Self-signed detection is detached from depth entirely and now comes from `authorization_error`, which is populated regardless.

### Why hostname and chain trust are read as two separate signals

`inspectCert()` connects with `rejectUnauthorized: false` and overrides `checkServerIdentity` so a broken certificate can still be inspected rather than failing the connection — but the override discarded Node's hostname-validation result, letting a wrong-host certificate report `ok`. `socket.authorized` does not cover the gap: with `checkServerIdentity` overridden it is `true` even for a hostname mismatch, so it reflects chain trust only. The two are therefore read independently — `tls.checkServerIdentity(host, cert)` called explicitly inside the callback (which still returns `undefined` to keep the connection open) for hostname coverage, and `socket.authorizationError` for chain verification, which catches an untrusted root that the issuer-versus-subject heuristic cannot see. Both land at `critical`: a hostname mismatch, a self-signed leaf, and an untrusted root are all hard client-side rejections, the same tier as expiry, which is why self-signed was raised from `warning`.

### Instruction tool vs. LLM sampling

`devops_suggest_action` could use `ctx.sample` to ask the client's LLM for dynamic guidance. The risk: non-deterministic output, client dependency, potential latency. The value proposition of this tool is predictable, category-specific playbooks — "Cloudflare CDN is down, here are the known mitigation patterns." Static playbook dispatch by vendor category is deterministic, fast, and works in all clients. If `ctx.sample` is present and the vendor/incident is complex, the handler can optionally enrich the response — but the base path is always static.

### Caching strategy

Statuspage APIs are designed for polling (vendors use them for their own dashboards). 60s TTL is conservative — the official Statuspage dashboard polls more frequently. The TTL is configurable via `DEVOPS_STATUS_CACHE_TTL_MS` for users who want fresher data. Cache is in-memory (not `ctx.state`) because it's shared across all tenants — Statuspage data is public and identical for everyone. Cache key: the full Statuspage endpoint URL.

---

## Known Limitations

- **Non-Statuspage vendors:** Many major vendors do NOT use Atlassian Statuspage: AWS (health.aws.amazon.com), GCP (status.cloud.google.com), Azure (status.azure.com), Hetzner (status.hetzner.com), GitLab (status.io-based), Railway (custom), Fastly (access-restricted), PagerDuty (custom endpoint), Okta (auth-gated), Docker Hub (custom), CockroachDB (unreachable). These are excluded from the built-in registry. Users can attempt raw URL passthrough for any that may use Statuspage under a different subdomain, but the server makes no guarantees. Future bespoke adapters could cover the major cloud providers.
- **Upstream history ceilings:** Atlassian Statuspage and Slack both serve at most 50 incident records per fetch with no working pagination parameter, so `devops_get_incidents` cannot reach older incidents for those backends at any `offset`. It discloses the ceiling (`upstreamCeiling` + `notice`) when a call hits it rather than presenting the window as complete history; older incidents remain on the vendor's own status page. AWS Health, Status.io, and FireHydrant have no such ceiling — see the backend history table under `devops_get_incidents`.
- **Vendor self-reporting:** Statuspage data is vendor-published. Vendors may lag incident acknowledgment. `devops_check_certs` and `devops_check_dns` provide ground-truth checks that complement self-reported status.
- **TLS inspection from server host:** `devops_check_certs` connects from wherever the MCP server runs. If the server is hosted, cert checks reflect connectivity from that host — a cert served correctly to the host may still be broken in a specific region. For complete coverage, run the server locally.
- **DNS propagation scope:** `devops_check_dns` queries three public resolvers. Propagation completeness across all global resolvers requires a larger resolver set or a dedicated propagation service.
- **No raw DNS response code:** `node:dns` surfaces per-query error codes, not the response rcode, and `ENOTFOUND` covers both NXDOMAIN and an empty answer on some record types. `nxdomain` is therefore inferred — claimed only when every requested type for a resolver returns `ENOTFOUND`. A name that exists with no records of any requested type (an empty non-terminal) is indistinguishable from NXDOMAIN at this layer and reports as `nxdomain`.
- **Certificate chain depth:** `chain_depth` depends on `getPeerCertificate(true).issuerCertificate`, which the Bun runtime does not populate for a real handshake. On Bun the field is `null` with a reason rather than a count; chain validity is still reported in full via `authorization_error`.
- **`ctx.state` scope:** Stack configuration persisted by `devops_watch_stack` is tenant-scoped (per client session in stdio mode, per JWT tenant in HTTP mode). Stack configurations do not persist across server restarts in the default memory storage backend.
