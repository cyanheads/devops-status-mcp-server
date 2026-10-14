# devops-status-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `devops_status_check` | Check current health status for one or more vendors. Returns per-vendor operational indicator, affected components, and active incident summaries. Accepts registered vendor names or raw Statuspage base URLs. Batch-friendly — pass a list to check your full stack in one call. | `vendors: string[]` (20 checked per call, 100 accepted), `mode?: 'summary' \| 'detailed'` | `readOnlyHint`, `openWorldHint: true` |
| `devops_get_incidents` | Fetch incident history for a vendor — active, resolved, or scheduled maintenance windows. Returns full timeline of updates (created → investigating → monitoring → resolved), affected components, and postmortem links. `since` reads a Statuspage page's quarterly history archive past the status API's 50-record ceiling. | `vendor: string`, `filter?: 'all' \| 'active' \| 'resolved' \| 'scheduled'`, `limit?: number`, `offset?: number`, `since?: string` (YYYY-MM-DD), `until?: string` (YYYY-MM-DD), `match?: string`, `full_updates?: boolean` | `readOnlyHint`, `openWorldHint: true` |
| `devops_watch_stack` | Register a named vendor list as your "stack" and get a unified health snapshot across all entries. Saves the stack in tenant-scoped state where the tenant identifies the caller (stdio; HTTP with jwt/oauth), so subsequent calls omit the list; on HTTP with auth `none` nothing is saved and `vendors` is required. Use for morning checks or pre-deploy status sweeps. Returns an aggregate health rollup plus per-vendor detail. | `vendors?: string[]` (20 checked or saved per call, 100 accepted), `stack_name?: string`, `mode?: 'summary' \| 'detailed'` | `readOnlyHint: false` (saves the stack), `idempotentHint`, `openWorldHint: true` |
| `devops_check_certs` | Inspect SSL/TLS certificate health for one or more domains. Pure TypeScript — direct TLS handshake, no external API. Reports: days to expiry (flags < 30 and < 7), chain depth, TLS protocol version (flags 1.0/1.1), subject/issuer/SANs, and HSTS header presence when the port answers HTTP (via follow-up HTTP GET over the TLS connection). Works for any domain, not just registered vendors. | `domains: string[]` (10 inspected per call, 100 accepted), `port?: number` | `readOnlyHint`, `openWorldHint: true` |
| `devops_check_dns` | Resolve DNS records and verify propagation for one or more domains. Pure TypeScript — queries each resolver directly over the DNS wire protocol (UDP with EDNS0, TCP on truncation) against multiple public resolvers (Google 8.8.8.8, Cloudflare 1.1.1.1, Quad9 9.9.9.9). Reports: A/AAAA/CNAME/MX/TXT/NS/CAA/SOA records, resolution latency per resolver, and resolver discrepancies (propagation gaps). Works for any domain. | `domains: string[]` (10 queried per call, 100 accepted), `record_types?: Array<'A' \| 'AAAA' \| 'CNAME' \| 'MX' \| 'TXT' \| 'NS' \| 'CAA' \| 'SOA'>`, `resolvers?: string[]` (5 distinct queried, 20 accepted) | `readOnlyHint`, `openWorldHint: true` |
| `devops_suggest_action` | Instruction tool — given a vendor name and detected status/incident, returns a tailored incident-response playbook and pre-filled follow-up tool calls. Does not perform any actions. Use after `devops_status_check` surfaces a degradation to get mitigation steps: check your own DNS and certs, identify alternative regions/routes, when to enable fallback. | `vendor: string`, `incident_summary?: string`, `affected_components?: string[]` | `readOnlyHint`, `openWorldHint: false` |
| `devops_list_vendors` | List vendors in the built-in registry. Returns slug, display name, category, and status page URL. Accepts an optional search query or category filter. Use to discover available vendors and find the correct name to pass to other tools. | `query?: string`, `category?: string` | `readOnlyHint`, `openWorldHint: false` |

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `devops-status://vendors/{name}` | Full registry entry for a vendor by slug — Statuspage base URL, category, API type, and `component_scope_prefix` for an entry scoped to part of a shared page. Read-only, stable. | None — single record |

Resources are supplementary. All data is reachable through tools; tool-only agents are fully supported.

### Prompts

None. The tool surface is the complete interface.

---

## Overview

Infrastructure health and incident intelligence for DevOps agents. Aggregates vendor status pages (Atlassian Statuspage convention, keyless), incident history, SSL/TLS certificate health, and DNS propagation checks into a single operational picture.

Two source types:
- **Statuspage API** — vendor status, component health, incidents, and scheduled maintenance windows for any vendor running on Atlassian Statuspage. Probed base URL + `/api/v2/{status,components,incidents,scheduled-maintenances}.json`, plus the page's own `/history.json?page=N` archive when `devops_get_incidents` is given `since`. No auth required.
- **Pure TypeScript** — TLS certificate inspection (`node:tls`) and DNS resolution (a wire client on `node:dgram` / `node:net`). Zero external dependencies. Works for any domain.

**Vendor registry:** a curated TypeScript data file (`src/data/vendor-registry.ts`) mapping vendor slugs to Statuspage base URLs and categories. Not fetched at runtime. Users can bypass it with raw Statuspage URLs.

Target users: DevOps engineers, SREs, platform teams, and developers who manage upstream dependencies — anyone who needs to distinguish "is my code broken?" from "is my vendor down?"

---

## Requirements

- No API keys — fully public data sources, fully hostable without credentials
- Vendor registry is a static TypeScript data file committed in the repo, not fetched at runtime
- Short-TTL in-memory cache (~60s, `DEVOPS_STATUS_CACHE_TTL_MS`) on every status read (`src/utils/cached-fetch.ts`): keyed by the WHATWG-normalized URL (`new URL(url).href`); total held size bounded by `FETCH_CACHE_BUDGET_BYTES` (32 MiB, serialized size of each cached value), oldest-first eviction; a value over `FETCH_CACHE_MAX_ENTRY_BYTES` (4 MiB) is returned but not cached; expired entries swept on every insert. Every upstream body is read under `MAX_RESPONSE_BODY_BYTES` (8 MiB); a larger body (or a declared `Content-Length` past it) fails that read with `ServiceUnavailable`, `reason: statuspage_unavailable`
- `devops_check_certs` and `devops_check_dns` use only Node.js stdlib (`node:tls`; `node:dgram` / `node:net`) — zero additional deps
- Raw Statuspage base URLs accepted everywhere a vendor name is accepted
- No tool writes upstream or has a persistent external effect; the only write is `devops_watch_stack` saving its own stack record
- `devops_watch_stack` persists stack configuration via `ctx.state` (tenant-scoped KV), only where the tenant identifies the caller — see `stacksPersist()` in the tool file
- `devops_suggest_action` outputs guidance and `nextToolSuggestions` pre-filled from incident context — no external calls, fully deterministic

---

## Vendor Registry Design

**File:** `src/data/vendor-registry.ts`

**Shape per entry:**
```ts
type VendorEntry = {
  slug: string;           // canonical identifier used in tool inputs (e.g., "github", "cloudflare")
  name: string;           // display name (e.g., "GitHub", "Cloudflare")
  category: VendorCategory;
  statuspage_url: string; // always https://; the Statuspage API base for 'statuspage',
                          // the vendor's public status page for every other api_type
  component_scope_prefix?: string; // set when the vendor publishes on a status page it shares with
                                   // other products: only components whose name, or whose group's
                                   // name, starts with this prefix belong to it
} & (
  | { api_type: 'statuspage' | 'slack' | 'aws' | 'gcp' | 'azure' | 'azure-devops' | 'firehydrant' }
  | { api_type: 'statusio'; statusio_page_id: string } // keys the Status.io Public Status API
);

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

**Vendor list (53 entries):**

Every entry is verified against its live status source (`bun run verify:registry` probes them all). 45 run on Atlassian Statuspage; the other eight are served by native-API adapters in `src/services/status-adapters/` that normalize into the Statuspage shapes: `aws` (AWS Health), `gcp` (Google Cloud Service Health), `azure` (Azure status RSS feed), `azure-devops` (Azure DevOps health API and status RSS feed), `gitlab` and `neon` (Status.io), `slack` (Slack status API), and `redis-cloud` (FireHydrant). Vendors with no public machine-readable status source this server can read (Hetzner, Railway, Fastly, PagerDuty, Okta, Docker Hub, CockroachDB) are not in the registry; see Known Limitations.

| Category | Vendors |
|:---------|:--------|
| cloud | digitalocean, linode, aws, gcp, azure |
| cdn-edge | cloudflare, akamai |
| dev-platform | gitlab, github, azure-devops, npm, vercel, netlify, render, fly-io, circleci, travis-ci, snyk, atlassian, figma, launchdarkly |
| data | mongodb-atlas, planetscale, supabase, neon, redis-cloud, elastic, influxdb, upstash, cloudinary, segment |
| comms | slack, discord, twilio, sendgrid, mailgun, hubspot, brevo, courier, loops |
| auth | auth0, clerk, workos |
| monitoring | datadog, sentry, new-relic, grafana-cloud, honeycomb |
| ai | openai, anthropic, elevenlabs, pinecone, cohere |

Notes on specific entries:
- `anthropic` — Statuspage URL is `https://status.claude.com` (the page is branded "Claude"); `status.anthropic.com` redirects there.
- `akamai` — Statuspage URL is `https://www.akamaistatus.com`; `status.akamai.com` 302s there and the redirect drops the query string, which collapses every history-archive page to page 1.
- `auth0` — Statuspage at `https://auth0.statuspage.io`; `status.auth0.com` serves HTTP only.
- `redis-cloud` — `https://status.redis.io` moved from Atlassian Statuspage to FireHydrant; the adapter reads its `/data/payload.json`.
- `neon` — `https://neonstatus.com` is a Status.io page; the former `status.neon.tech` Statuspage is gone.
- `azure` — `statuspage_url` is the public page `https://azure.status.microsoft/en-us/status/`; the adapter reads the RSS feed that page links (see Live API Shapes).
- `azure-devops` — `statuspage_url` is `https://status.dev.azure.com` (display only); the adapter reads that portal's Health API and `_rss` feed at fixed endpoints (see Live API Shapes).
- `sendgrid` — `statuspage_url` is `https://status.twilio.com` with `component_scope_prefix: 'SendGrid'`: `status.sendgrid.com` redirects to Twilio's page, and the entry reports only SendGrid's components (see Design Decisions).

Vendor registry is the source of truth for `devops_list_vendors`. Any tool accepting a vendor name resolves it by slug (case-insensitive) against the registry first; if no match and the input looks like a URL, it's treated as a raw Statuspage base URL.

---

## Live API Shapes (verified)

All Statuspage vendors respond to `{base_url}/api/v2/{endpoint}.json` — no auth, and no pagination on any v2 endpoint. `incidents.json` returns the 50 most recent and ignores a `?page=` parameter, so 50 is a hard ceiling on the v2 feed; `devops_get_incidents` discloses it when a call hits it. The page's history archive (below) is the only surface that reaches past it.

`page.time_zone` is an IANA zone name (`Etc/UTC`, `America/Los_Angeles`) on Atlassian-hosted pages. Some v2-compatible pages that are not hosted by Atlassian omit it (cohere, planetscale, openai), so it is optional in `StatuspagePage`.

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
    "indicator": "none",           // enum: "none" | "minor" | "major" | "critical" | "maintenance"
    "description": "All Systems Operational"
  }
}
```

**Indicator enum:** `none` (all operational), `minor`, `major`, `critical`, plus `maintenance` while a window is open (verified live on brevo — `{"description":"Under Maintenance","indicator":"maintenance"}`). `maintenance` sits outside the severity ladder: it is a window the vendor scheduled, not a fault.

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

### `GET {base_url}/history.json?page=N` (undocumented)

The JSON behind a page's "Incident History" view — not in the page's own `/api` endpoint list. Served per host, not per backend: 7 of the registry's 45 Statuspage hosts answer 404 (`cloudflare` with a JSON error body; `planetscale`, `brevo`, `clerk`, `openai`, `elevenlabs`, `cohere` with an HTML 404 — they serve an Atlassian-compatible `/api/v2` only).

```jsonc
{
  "page_status": { "page": { "name": "Twilio", "time_zone": "Pacific Time (US & Canada)" /* Rails name, not IANA */ } },
  "components": [ /* … */ ],
  "months": [{
    "name": "January", "year": 2026, "starts_on": 4, "days": 31,
    "incidents": [{
      "code": "bchpvm9st7h2",        // = the v2 incident `id`
      "name": "SMS Delivery Failures From Subset of Twilio Numbers",
      "message": "…",                // the latest update body — same markup as v2 bodies, converted to plain text the same way
      "impact": "minor",             // none | minor | major | critical | maintenance
      "timestamp": "Dec <var data-var='date'>31</var>, <var data-var='time'>22:28</var> - Jan <var data-var='date'>1</var>, <var data-var='time'>08:17</var> PST"
    }]
  }],
  "start_time": "2026-01-01T00:00:00-08:00",   // window start, page-local with offset
  "end_time": "2026-03-31T23:59:59-07:00"
}
```

- **Paging:** page 1 is the current calendar quarter (partial), and page N is N−1 quarters earlier. There is no end signal: a page past the end returns 200 with empty months dated in 1996, and a quiet page can have a genuinely empty current quarter.
- **Redirects drop `?page=`:** a host that 302s to another page's `history.json` (e.g. `status.sendgrid.com` → `status.twilio.com`) serves every page as page 1. (`status.akamai.com` did the same; the registry now points at `www.akamaistatus.com`.)
- **`timestamp`:** `Mon D, HH:MM[ - [Mon D, ]HH:MM] ZONE` with the date and times in `<var>` markup — matched by 5,943 of 5,943 recorded records. It carries no year, and its zone label names only the span's end. The year comes from the enclosing `months[]` entry, which files a span under the month it **ends** in, so a start month later than the bucket's belongs to the year before. The zone comes from the v2 `page.time_zone`. An end without a date falls on the start's date. A record with no end is open, in progress, or a cancelled maintenance — the archive does not say which.
- **Fidelity:** the parsed start equals v2 `created_at` to the minute on 833 of 839 joined records (the rest are vendor-edited times), and the parsed end equals v2 `resolved_at` on 815 of 815. `name` and `impact` match v2 on every joined pair.
- **Size:** 7–122 KB per page on GitHub; 0.44–0.51 MB on Twilio, which publishes ~900 records a quarter.

### `GET /api/v2/summary.json`

Returns merged object with `status`, `components`, `incidents`, and `scheduled_maintenances` in a single call. Used by `devops_status_check` in `detailed` mode to minimize round trips.

### `GET https://status.cloud.google.com/incidents.json` (Google Cloud)

Keyless, `content-type: application/json`, no auth and no rate limit. The body is a **bare top-level array** of incidents — no `page`/`status` envelope — so the adapter synthesizes the page block from the registry entry. Query parameters are ignored (`?page=2` and `?limit=100` both return the identical array), and there is no record cap: the feed is a rolling recent window, so history is bounded by age rather than by a count `devops_get_incidents` could disclose. Google publishes a JSON Schema for it at `incidents.schema.json`, and a product catalog at `products.json` that this server does not consume.

```jsonc
[{
  "id": "3BvH3LVGcupoYqV6F4Nw",          // stable; `number` is deprecated upstream
  "begin": "2026-07-15T23:57:00+00:00",  // when the incident started
  "created": "2026-07-16T03:30:59+00:00",
  "end": "2026-07-16T12:25:00+00:00",    // absent/empty while open — the only resolution signal
  "modified": "2026-07-25T13:16:55+00:00",
  "external_desc": "…",                  // the dashboard headline; there is no separate title
  "severity": "medium",                  // schema documents "(high, medium)"; `low` is emitted live
  "status_impact": "SERVICE_DISRUPTION", // or SERVICE_INFORMATION
  "uri": "incidents/3BvH3LVGcupoYqV6F4Nw", // dashboard-relative permalink → `shortlink`
  "affected_products": [                 // the component concept
    { "id": "…", "title": "Vertex Gemini API", "current_title": "Gemini on Agent Platform" }
  ],
  "currently_affected_locations": [],    // region pairs; no normalized counterpart, not mapped
  "previously_affected_locations": [{ "title": "Netherlands (europe-west4)", "id": "europe-west4" }],
  "updates": [{                          // newest-first; re-sorted oldest-first when normalized
    "when": "2026-07-25T13:16:55+00:00",
    "created": "2026-07-25T13:16:55+00:00",
    "text": "…",
    "status": "AVAILABLE",               // service status when posted, not a lifecycle word
    "affected_locations": []
  }],
  "most_recent_update": { /* duplicate of updates[0] */ },
  "service_key": "zall",                 // deprecated upstream in favour of affected_products
  "service_name": "Multiple Products"    // deprecated upstream in favour of affected_products
}]
```

**Normalized mapping** (`gcp-adapter.ts`):

| Google Cloud | Statuspage shape | Notes |
|:---|:---|:---|
| `severity` | `impact` | `low` → `minor`, `medium` → `major`, `high` → `critical`; unrecognized → `minor` |
| `end` present | `status`, `resolved_at` | `resolved` when set, `investigating` otherwise |
| `external_desc` | `name` | the feed publishes no separate title |
| `begin` / `created` | `started_at` / `created_at` | |
| `uri` | `shortlink` | resolved against the dashboard base into an absolute URL |
| `affected_products[]` | `affected_components` on the latest update, and summary `components` | display name from `current_title`, falling back to `title` |
| `updates[].status` | update `status` | `AVAILABLE` → `available`, `SERVICE_DISRUPTION` → `disruption`, `SERVICE_INFORMATION` → `information` |
| — | `scheduled_maintenances` | always empty; Google Cloud publishes no maintenance feed |

**Not mapped:** `currently_affected_locations` / `previously_affected_locations` / `updates[].affected_locations` (no normalized counterpart), `most_recent_update` (duplicates `updates[0]`), `number` / `service_key` / `service_name` (deprecated upstream). Summary `components` cover only the products named by currently-open incidents — the feed carries no product health table, so unmentioned products are absent rather than asserted operational.

### `GET https://rssfeed.azure.status.microsoft/en-us/status/feed/` (Azure)

Keyless RSS 2.0, `content-type: text/xml; charset=utf-8`, the feed the [Azure status page](https://azure.status.microsoft/en-us/status/) links. `azurestatuscdn.azureedge.net/en-us/status/feed/` and `azure.status.microsoft/en-us/status/feed/` serve the same envelope. The channel is **empty while nothing is posted** (577 bytes, `lastBuildDate` only), which is its steady state: Microsoft posts here only for broad-impact service issues or ones its targeted notifications cannot reach, and a resolved item leaves the feed. No other keyless machine-readable Azure platform source exists — Azure Service Health (ARM `Microsoft.ResourceHealth/events`) needs Azure AD auth, and the status page's service × region matrix is ~6.9 MB of undocumented HTML.

```xml
<item>
  <guid isPermaLink="false">issues-connecting-to-resources-in-west-us</guid> <!-- a title slug; reused across incidents -->
  <link>https://azurestatusprodncus.azurewebsites.net/en-us/status/</link>  <!-- generic page; not relayed -->
  <category>API Management</category>  <!-- zero or more, services and regions mixed -->
  <category>West US</category>
  <title>Issues connecting to resources in West US </title>              <!-- trailing space -->
  <description>&lt;p&gt;We are investigating a networking issue …&lt;/p&gt;</description>
  <pubDate>Thu, 23 Jul 2026 16:29:09 Z</pubDate>
</item>
```

**Fixtures** (`tests/services/status-adapters/fixtures/`), from 112 archived captures (2019–2026) of the four hostnames, of which 7 carry an item (one each) and 105 are empty:

| File | Source | Shape |
|:---|:---|:---|
| `azure-feed-20260723.xml` | `web.archive.org/web/20260723164925id_/https://rssfeed.azure.status.microsoft/en-us/status/feed/` | nine services plus one region, HTML description, internal `<link>` host |
| `azure-feed-20240721.xml` | `web.archive.org/web/20240721181144id_/https://azure.status.microsoft/en-us/status/feed/` | no `<category>`, plain-text description |
| `azure-feed-20220907.xml` | `web.archive.org/web/20220907194758id_/https://azurestatuscdn.azureedge.net/en-us/status/feed/` | `azure-front-door-connectivity-issues`, `&amp;nbsp;` and `<strong>` in the description |
| `azure-feed-20251029.xml` | `web.archive.org/web/20251029175916id_/https://rssfeed.azure.status.microsoft/en-us/status/feed/` | the same `guid` for a separate incident, a link in the description |
| `azure-feed-empty.xml` | the live feed, 2026-09-25 | empty channel |

Across the archive the item text is always entity-escaped (no CDATA), `guid isPermaLink` is the only attribute, and after XML decoding `&nbsp;` is the only HTML entity; the description's tags are `p`, `strong`, `a`, `ul`, and `li`. The extractor still reads the other forms RSS 2.0 allows — CDATA sections as text (so tag names inside one never read as elements), comments dropped, attributes on any open tag, self-closing elements as empty, whitespace inside end tags. Entity names resolve against the known table only, never an inherited object property. Element, link, and tag matching run in time linear in the body, so unclosed tags, comments, or malformed links cannot stall the process.

**Normalized mapping** (`azure-adapter.ts`):

| Azure | Statuspage shape | Notes |
|:---|:---|:---|
| item listed | `impact`, `status`, `resolved_at` | always `minor`, `investigating`, `null` — the feed has no severity or lifecycle field |
| any item listed | summary `indicator` | `minor` while any item is listed, `none` otherwise |
| `guid` + `pubDate` | `id` | `guid@<pubDate as ISO>`; a `guid` alone has been reused for separate incidents |
| `title` | `name` | trimmed |
| `pubDate` | `created_at`, `started_at`, the update's `created_at` | parsed to ISO 8601 UTC |
| `description` | the single update's `body` | HTML rendered as plain text by the shared `htmlToText` (`src/utils/html-to-text.ts`): paragraphs, block ends, and `<br>` one per line, list items as `- ` lines, a link as its text with the URL after it when they differ. Only a tag naming an HTML element is markup; any other `<` stays text. |
| `<category>[]` | `affected_components` on the single update | verbatim; an item with none has none |
| — | summary `components`, `scheduled_maintenances` | always empty |

**Not mapped:** `<link>` (the generic status page, and one capture points it at an internal `azurewebsites.net` origin), `lastBuildDate`.

### `GET https://status.dev.azure.com/_apis/status/health?api-version=7.1-preview.1` and `/_rss` (Azure DevOps)

Two keyless sources at fixed endpoints (the entry's `statuspage_url` is display only). The RSS feed is served as RSS even with `Accept: application/json` (verified 2026-10-14).

- **Health** (Health - Get, `application/json`): `{ lastUpdated, status: { health, message }, services: [{ id, geographies: [{ id, name, health }] }] }`. Seven services (`Core services`, `Boards`, `Repos`, `Pipelines`, `Test Plans`, `Artifacts`, `Other services`) × eight geographies (`US`, `CA`, `BR`, `EU`, `UK`, `APAC`, `AU`, `IN`) = 56 cells. `health` is the documented `ScopeHealth` enum: `healthy | advisory | degraded | unhealthy | unknown`. Live 2026-10-14: overall `advisory` / "Service maintenance is in effect", with only `Core services`/`AU` at `advisory`. Every Wayback capture from 2021–2026 is all-`healthy`.
- **RSS item** (`application/rss+xml`): `title`, `link`/`guid` = `https://status.dev.azure.com/_event/<n>`, `pubDate` (latest update), `status:state` (`Active` / `Resolved`), one or more `status:geography`, an entity-escaped HTML `description` (latest update), and `content:encoded` (every update, `<hr>`-separated, newest first, each headed `<strong>Label</strong><br>Author, M/D/YYYY h:mm:ss AM`, UTC). Items are not in date order, and there is no severity and no service field. Live 2026-10-14: 9 items, 1 `Active` and 8 `Resolved`; the final update's stamp equals `pubDate` on every resolved item.

**Fixtures** (`tests/services/status-adapters/fixtures/`): `azure-devops-health-20261014.json`, `azure-devops-health-docs-example.json` (Microsoft's documented all-healthy example), `azure-devops-rss-20261014.xml`.

**Normalized mapping** (`azure-devops-adapter.ts`):

| Azure DevOps | Statuspage shape | Notes |
|:---|:---|:---|
| cell `health` | component `status` | healthy → operational, advisory → degraded_performance, degraded → partial_outage, unhealthy → major_outage, unknown or unrecognized → degraded_performance |
| `<service> (<geography name>)` | component `name` | ungrouped (`group: null`); id `<service>/<geography id>`; a cell with no service or geography name is skipped |
| overall `status.health` | summary `indicator` | healthy → none, advisory → minor, degraded and unhealthy → major, unknown or unrecognized → minor |
| `status.message` | summary `description` | "Overall health: <value>" when the message is absent |
| `lastUpdated` | `page.updated_at`, components' `updated_at` | |
| `_event/<n>` | incident `id`, `shortlink` (`https://status.dev.azure.com/_event/<n>`) | `unknown` / null when absent |
| `status:state` | `status`, `resolved_at` | `Resolved` → resolved at `pubDate`; anything else → investigating, `resolved_at` null |
| — | `impact` | fixed `minor` (no severity in the feed) |
| `content:encoded` sections | `incident_updates`, oldest first | plain text via `htmlToText`; each timed by its header stamp (unparseable → ''); the latest carries the incident status, earlier ones `investigating`; falls back to `description` when `content:encoded` is absent |
| oldest header stamp | `started_at`, `created_at` | `started_at` null and `created_at` = `pubDate` when no stamp parses |
| `status:geography[]` | `affected_components` on the latest update | verbatim |
| `Active` items | summary `incidents` | newest first by start |

A health body without the `status` object and `services` list, or an RSS body without `<channel>`, fails as `statuspage_unavailable` (never an all-clear). The summary needs both sources, fetched in parallel; the incident list reads only the feed; maintenances are empty with no network call. The RSS extractor (`rss-extract.ts`: `rssItems`, `elementText`, `elementTexts`) is shared with the `azure` adapter.

---

## Vendor Text

### Update bodies

Vendors publish update bodies as HTML on many backends: Slack (every note — `<p>`, `<br>`, `&nbsp;`, links wrapping a `<span>`), Statuspage v2 bodies and history `message` (GitHub `<br /><br />` pairs, Linode/MongoDB `<a href>`, Twilio/SendGrid `<p>`, Snyk `<b>`), AWS `event_log` messages (`<a href>` reference lists), Firehydrant notes (an `<a href>` that is never closed), and Status.io messages. Google Cloud writes markdown.

One converter, `htmlToText` (`src/utils/html-to-text.ts`), runs once per body where raw vendor text enters the normalized shape: `statuspage-service.ts` (v2 incidents, scheduled maintenances, summary incidents and maintenances, history `message`), `slack-adapter.ts`, `aws-adapter.ts`, `firehydrant-adapter.ts`, `statusio-adapter.ts`, `gcp-adapter.ts`, `azure-adapter.ts` (the RSS description, after XML decoding), and `azure-devops-adapter.ts`.

- Only a tag whose name is on the WHATWG HTML "List of elements" (any case) is markup — `<name>`, `</name>`, or the name followed by whitespace or `/` and an attribute run with no `<` before its `>`. Every other `<` is text: "(<1%)", "<30min", placeholders such as `<FUNCTIONALITY IMPACTED>` and `<SOME/ALL>`, autolinks such as `<https://…>`.
- `<br>`, `<hr>`, and the end tag of a block element break lines; `<li>` starts a `- ` line; a link renders as `text (url)` — the URL alone when the text is the URL or empty — with `href` double-quoted, single-quoted, or bare; an anchor left open runs to the next anchor or the end of the body.
- Comments are dropped whole (an unterminated `<!--` is text). Named references `lt gt amp quot apos nbsp` and numeric references decode once, so `&amp;lt;` becomes `&lt;`, never `<`, and a decoded `<b>` is never stripped. Whitespace is collapsed within each line and blank lines dropped.
- A body with no element tag, comment, or decodable reference is returned byte-identical, so markdown bodies (Google Cloud, DigitalOcean postmortems, Firehydrant markdown notes) keep blank lines and indentation.
- The scan is one forward pass, linear in the body; tests time 12 adversarial shapes at 16k and 1,024k characters (unclosed tags, nested `<a<a<a…>>>` openers, `<!--` runs, lone `<` and `&` runs, `</p >` runs, anchors never closed).

### `format()` rendering of vendor text

- `structuredContent` carries the converted plain text unescaped.
- In `content[]`, every vendor-authored string is escaped at the render boundary: `<` → `&lt;`, and an `&` that begins a CommonMark character reference (`&name;`, `&#digits;`, `&#xhex;`) → `&amp;`; a bare `&` ("Debugger & Alarms") stays.
- Inline values (incident and component names, statuses, timestamps, maintenance names and statuses, the page name and status description, component descriptions, the `**Why:**` suggestion reason) have CR/LF runs flattened to one space, so a newline in vendor text cannot open a heading or list item.
- Update bodies (`devops_get_incidents`) and `latest_update` (`devops_status_check`, `devops_watch_stack` — both render through `renderVendorBlock`) render as a blockquote indented two spaces, every line prefixed `  >`, under their update line; a blank line follows the quote where the next line would otherwise continue it. An empty body renders no quote.
- `devops_get_incidents` update lines read `- [created_at] status:` followed by the quoted body, and a blank line precedes `[Incident page](…)`. The incident id in the heading stays in a code span (which renders `<` and `&` literally); only line breaks are flattened there.
- Text that comes from the probed target rather than a status page renders the same way, as inline values: `devops_check_dns` record values on the domain-level, per-resolver, and resolver-disagreement lines, and `devops_check_certs` subject, SANs, issuer, and hostname-mismatch message. So does the caller's `vendor` in the `devops_suggest_action` heading, trimmed, and its `affected_components` line; its `incident_summary` renders as a quoted body. `structuredContent` keeps all of them as received.

---

## Tool Detail

### `devops_status_check`

**Description:** Check the current health status for one or more vendors. Accepts registered vendor slugs (e.g., `"github"`, `"cloudflare"`) or raw Statuspage base URLs. Returns per-vendor operational indicator (`none` = all clear, `minor`, `major`, `critical`, `maintenance` = scheduled window), a list of degraded components with their current status, and summaries of any active incidents. Use `mode: "detailed"` to include component lists even when all are operational, and to surface scheduled maintenance windows. Up to 20 vendors are checked per call; entries past the 20th come back in `deferred_vendors` to resend.

**Input:**
```ts
z.object({
  vendors: z.array(z.string().min(1))
    .min(1).max(100)
    .describe('Vendor slugs from the built-in registry (e.g., "github", "cloudflare") or raw Statuspage base URLs (e.g., "https://www.githubstatus.com"). Mix freely. Use devops_list_vendors to discover available slugs. The first 20 are checked, in the order given; entries past the 20th are returned unchecked in deferred_vendors to resend in another call. Lists longer than 100 are rejected.'),
  mode: z.enum(['summary', 'detailed']).default('summary')
    .describe('summary: indicator + degraded components + active incidents only. detailed: adds the component list and scheduled maintenance windows. Summary is faster; use detailed when preparing an incident report or checking maintenance schedules.'),
  component_filter: z.string().optional()
    .describe('Case-insensitive substring matched against component names and their group names in detailed mode (e.g., "api" to check just the API components, or a product or region a page groups components under). Applied before component_limit, so it is the way to reach a component that the cap would otherwise omit. A filter that matches nothing for a vendor is reported in notice. Ignored in summary mode.'),
  component_limit: z.number().int().min(1).default(50)
    .describe('Maximum components returned per vendor in detailed mode, at least 1. A value above 500 is reduced to 500, and notice says so.'),
})
```

**Output:**
```ts
z.object({
  results: z.array(z.object({
    vendor: z.string().describe('Vendor slug or URL as provided.'),
    name: z.string().describe('Display name from registry or Statuspage page.name.'),
    indicator: z.enum(['none', 'minor', 'major', 'critical', 'maintenance']).describe('Overall health indicator from Statuspage status.json. maintenance = scheduled window in progress, planned rather than a fault.'),
    description: z.string().describe('Human-readable status description (e.g., "All Systems Operational").'),
    degraded_components: z.array(z.object({
      name: z.string().describe('Component name as the status page publishes it — the leaf alone, without its group. Several leaves can share a name (one per region or product); group tells them apart.'),
      group: z.string().nullable().describe('Name of the group the status page files this component under — typically the product or region it belongs to — or null when it is not in a group.'),
      status: z.enum(['degraded_performance', 'partial_outage', 'major_outage', 'under_maintenance']),
    })).describe('Every component not in an operational state, uncapped. Includes in-progress maintenance windows (under_maintenance) alongside genuine outages — read status to tell a planned window from a fault. Empty when all clear.'),
    active_incidents: z.array(z.object({
      id: z.string(),
      name: z.string(),
      impact: z.enum(['none', 'minor', 'major', 'critical']),
      status: z.string(),
      started_at: z.string().describe("ISO 8601, with the vendor's UTC offset."),
      latest_update: z.string().describe('Most recent update text, as plain text: HTML markup the vendor published is converted, and any other < is text the vendor wrote.'),
    })).describe('Active (non-resolved) incidents.'),
    scheduled_maintenances: z.array(z.object({
      name: z.string(),
      scheduled_for: z.string(),
      scheduled_until: z.string(),
      status: z.string(),
    })).optional().describe('Upcoming or in-progress maintenance windows. Present in detailed mode only.'),
    all_components: z.array(z.object({
      name: z.string(),
      group: z.string().nullable(),
      status: z.string(),
      description: z.string().nullable(),
    })).optional().describe('Components, narrowed by component_filter (matched against name and group) and capped at component_limit. Present in detailed mode only.'),
    all_components_total: z.number().optional()
      .describe('Components matching component_filter for this vendor before the cap. Present in detailed mode only.'),
    cached: z.boolean().describe('True when this result was served from the 60s in-memory cache.'),
    checked_at: z.string().describe('ISO 8601 UTC timestamp of this check.'),
    statuspage_url: z.string().describe('Statuspage base URL used. Empty for a vendor entry that resolved to no target.'),
    error: z.string().optional().describe('Why this vendor could not be checked. Absent on success.'),
  })).describe('Per-vendor status results for the vendors checked, in the same order as the input vendors list.'),
  deferred_vendors: z.array(z.string()).describe('Entries past the first 20 in vendors, verbatim and in input order. They were not checked; resend them in another call. Empty when every entry was checked.'),
  summary: z.object({
    total: z.number(),
    operational: z.number(),
    degraded: z.number(),
    down: z.number(),
    maintenance: z.number(),
    unavailable: z.number(),
  }).describe('Aggregate health counts across all checked vendors — never counts deferred_vendors. Buckets partition the batch: operational + degraded + down + maintenance + unavailable = total.'),
  nextToolSuggestions: z.array(z.object({
    toolName: z.string(),        // always "devops_suggest_action"
    reason: z.string(),
    args: z.record(z.string(), z.unknown()),
  })).describe('One devops_suggest_action call per vendor with an active problem, arguments pre-filled. Empty when none qualifies.'),
})
```

**`nextToolSuggestions`:** a vendor qualifies when its `indicator` is `minor`, `major`, or `critical`, or when it has an open incident of one of those impacts — a page can read `none` while such an incident is open. A vendor carrying `error` never qualifies. Arguments are built per vendor, one entry per distinct `args.vendor`, in results order:

| Arg | Value |
|:----|:------|
| `vendor` | Registry slug even when the caller typed another case (`GitHub` → `github`); a raw URL passes its normalized URL (`statuspage_url`). |
| `vendor_indicator` | The indicator, only when it is `minor`/`major`/`critical` — `none` or `maintenance` would frame the playbook as all-clear or a planned window. |
| `affected_components` | `degraded_components` outside `under_maintenance`, each written `Group / Leaf` when it is in a group (the leaf alone otherwise); omitted when none remain. The `reason` names components the same way. |
| `incident_summary` | `name` of the qualifying incident with the latest `started_at`, compared as instants (pages publish mixed offsets); undated incidents rank last, ties keep `active_incidents` order. Omitted when no incident qualifies. |

`VendorResult.vendor` echoes the caller's input, so the builder pairs each result with its `PreparedVendor` (index-aligned) to read `target.slug`. `format()` renders the list under a `## Recommended Next Steps` heading in `devops_suggest_action`'s layout, only when it is non-empty.

**Enrichment:** `truncated` / `shown` / `cap` / `totalCount`, written once after the fan-out when at least one vendor's component list was capped. `buildVendorResult()` runs per vendor with no `ctx`, so it returns the matched and shown component counts and the handler aggregates them into a single `ctx.enrich.truncated()` call for the whole batch.

`notice` carries, in this order and as one string (the framework's `notice` is last-wins across `ctx.enrich` calls), the deferral notice, the `component_limit` clamp notice, then the component truncation and filter-miss notices. `fetchVendorResults(prepared, ctx, options, leadNotices)` takes the tool's own notices and composes them with its component notices. The truncation notice drops "or raise component_limit" when the effective limit is already 500. In detailed mode it is also written when `component_filter` matched no component of one or more checked (non-errored) vendors. Pinned text: `component_filter "<filter>" matched no component of <vendor> (<N> published)[, <vendor> (<N> published)…]. It matches component and group names as a case-insensitive substring; call again without component_filter to list them.` `<vendor>` is the vendor input as the caller passed it; `<N>` counts the page's non-group components (0 for a page with none, e.g. azure, slack, a healthy aws). When a list was also capped, the truncation guidance comes first and the filter sentence follows. Summary mode never writes it.

**Errors:**
```ts
errors: [
  {
    reason: 'vendor_not_found',
    code: JsonRpcErrorCode.NotFound,
    when: 'No requested vendor among the first 20 could be checked and the first failure was a slug that matches no registry entry and is not a valid URL.',
    recovery: 'Call devops_list_vendors to browse available slugs, or pass a full Statuspage base URL (e.g., "https://www.githubstatus.com").',
  },
  {
    reason: 'target_blocked',
    code: JsonRpcErrorCode.ValidationError,
    when: 'No requested vendor among the first 20 could be checked and the first failure was a raw URL resolving to a private, loopback, or cloud-metadata address.',
    recovery: 'Pass a publicly routable Statuspage URL. If internal monitoring is intentional, set DEVOPS_STATUS_ALLOW_PRIVATE_TARGETS=true.',
  },
]
```

When entries were deferred, the all-failed message reads "None of the first 20 requested vendors could be checked. … N more past the first 20 was/were not checked: a, b." (the error envelope has no `deferred_vendors` field, so the message names them).

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`

Handler fans out all vendor fetches with `Promise.allSettled`, so one failed vendor does not block the others. Failed vendors surface in results with an `error` field rather than throwing. Because no fetch failure reaches a top-level throw, this tool declares no `statuspage_unavailable` contract — an unreachable status page is per-vendor data, not a tool error.

The same rule covers a vendor entry that never reaches a fetch: an unresolvable slug or an SSRF-blocked URL becomes an `error` row in `results[]`, counted in the `unavailable` bucket, so one bad entry cannot discard the rest of the batch. Both contract entries above fire only when *nothing* resolved — partial failure is data, total failure is an error, and one typed error carrying a recovery hint beats a batch of error rows under a summary reading `operational: 0`. The all-failed message names every failing entry so one round trip corrects them all.

---

### `devops_get_incidents`

**Description:** Fetch incident history and scheduled maintenance windows for a vendor. Returns the full incident timeline — each investigator update, affected components at each step, and when the incident was resolved. Filter by status to focus on active incidents (use before deploy), resolved history (use for postmortem), or upcoming maintenance windows. Page long histories with `limit` + `offset`. `match` (words in the title or affected component names) and `since` / `until` (a start-date range) narrow before paging, so totals count only what they keep. Each response is held to 64,000 bytes per surface: a page can stop short of `limit` at that budget, and an incident too large on its own keeps only its newest updates (`updates_omitted` counts the rest; `full_updates: true` returns them all). On Statuspage vendors, `since` also reads the page's quarterly history archive back to that date, past the v2 feed's 50-record ceiling — except on a vendor that covers only part of a shared page (`sendgrid`), whose archive records carry no components to scope by.

Order of operations, binding everywhere it is described: status filter → `since`/`until` → `match` → sort (newest first when two lists were merged) → `offset`/`limit` → byte budget.

**Input:**
```ts
z.object({
  vendor: z.string().min(1)
    .describe('Vendor slug (e.g., "github") or raw Statuspage base URL. Use devops_list_vendors to find slugs.'),
  filter: z.enum(['all', 'active', 'resolved', 'scheduled']).default('all')
    .describe('all: incidents plus scheduled maintenances. active: only incidents with status investigating/identified/monitoring. resolved: only fully resolved incidents. scheduled: only scheduled maintenance windows. Not every backend serves every filter — an empty result names which case applied.'),
  limit: z.number().int().min(1).default(20)
    .describe('Maximum incidents to return per call, at least 1. A value over 50 is served as 50, and the notice says so. Page through longer history with offset rather than raising this.'),
  offset: z.number().int().min(0).default(0)
    .describe('Matching incidents to skip before applying limit. A truncated result returns the value to use next in the nextOffset enrichment field.'),
  since: z.union([z.literal(''), z.iso.date()]).optional()
    .describe('Earliest start date (YYYY-MM-DD, UTC). With filter all or resolved. On Statuspage vendors, also reads the history archive back to it, 24 months back at most; an earlier date still filters as sent, and the notice gives the date the archive was read back to.'),
  until: z.union([z.literal(''), z.iso.date()]).optional()
    .describe('Latest start date (YYYY-MM-DD, UTC), the whole day; with filter all or resolved, on or after since. Reads no history archive on its own.'),
  match: z.string().max(200).refine(blank or at least one letter/digit).optional()
    .describe('Words matched in the title and affected component names, ignoring case and punctuation; every word must appear. History records and component-less vendors match on title alone.'),
  full_updates: z.boolean().default(false)
    .describe('Return every update of an incident too large for the response budget on its own.'),
})
```

`""` is read as omitted for `since`, `until`, and `match`, since form-based clients send a blank optional field that way. `since` or `until` with `active` or `scheduled` is an error raised before any request (`invalid_since` and `invalid_until`), and so is an `until` earlier than `since` (`invalid_until`), compared on the dates as sent. The 24-month floor bounds only how far back the history archive is read: `since` and `until` filter every record as sent, so a `since` older than the floor keeps older records the live feeds still return (Statuspage maintenance lists keep completed windows for years), with a notice giving the requested `since` and the date the archive was read back to, and an `until` older than the floor filters like any other. A `match` with no letter or digit fails the schema; a malformed date fails the schema.

**With `since`:**

1. The v2 incident list is fetched as before. On a Statuspage backend the maintenance list is fetched too, under `resolved` as well as `all`, because a history record is added only when neither v2 list carries its `code`. Under `resolved` that match is its only use, so a failed maintenance read there skips the archive with a `notice` rather than failing the call; under `all` it fails the call, as it does without `since`.
2. The history archive is read from page 1, one quarter per page, until a page's window starts at or before the floor (`since` at 00:00 UTC, or the date 24 months back when `since` is earlier). Each page must be exactly one quarter before the last; one that is not ends the walk. The walk also ends after one page per quarter from today's back to the floor's plus one at each end (the page counts quarters in its own zone), so an archive whose pages do not count back from today is cut off there rather than read indefinitely.
3. History records join on `code` = v2 `id`, and the v2 record wins. Under `resolved`, only history records with an end are added.
4. The merged list is narrowed to the date range on each record's start (`scheduled_for`, else `created_at`) — at or after `since` 00:00 UTC, before `until` + 1 day 00:00 UTC — then by `match`, sorted by `created_at` descending, windowed by `limit`/`offset`, and cut to the response budget.

`until` alone filters what the status API returns and reads no archive (the walk is bounded by the date it reads back to). Non-Statuspage backends — and a Statuspage entry scoped to part of a shared page — apply the range and read no history. A history record maps as `id` = `code`; `name`, `impact` verbatim; `created_at`/`resolved_at` = the parsed start/end in UTC; `status` = `resolved` with an end, else `unknown`; `updates` = one entry carrying `message`, dated at the end (or the start); `shortlink` = `{base_url}/incidents/{code}`; `started_at`, `scheduled_for`, `scheduled_until`, `duration_minutes` null; `affected_components` empty; `source: 'history'`.

**Output:**
```ts
z.object({
  vendor: z.string(),
  name: z.string(),
  incidents: z.array(z.object({
    id: z.string(),
    name: z.string(),
    impact: z.enum(['none', 'minor', 'major', 'critical', 'maintenance']),
    status: z.string().describe('Current status: investigating | identified | monitoring | resolved | postmortem | scheduled | in_progress | completed | unknown (a history record with no end)'),
    created_at: z.string(),
    started_at: z.string().nullish().describe('Null/absent when the vendor does not set it, and always null on a history record.'),
    resolved_at: z.string().nullable(),
    scheduled_for: z.string().nullable().describe('Present for scheduled maintenances.'),
    scheduled_until: z.string().nullable().describe('Present for scheduled maintenances.'),
    duration_minutes: z.number().nullable().describe('Minutes from started_at to resolved_at. Null for active or scheduled incidents.'),
    shortlink: z.string().nullish().describe('Direct URL to the incident page, or null/absent if the vendor provides none.'),
    affected_components: z.array(z.string()).describe('Component names affected by this incident.'),
    updates: z.array(z.object({
      status: z.string(),
      body: z.string().describe('Update text from the vendor, as plain text: HTML markup the vendor published is converted (a link reads as its text, then its URL), and any other < is text the vendor wrote.'),
      created_at: z.string(),
    })).describe('Chronological list of incident updates (oldest first). An incident too large for the budget on its own carries only its newest updates.'),
    updates_omitted: z.number().int().optional().describe('Oldest updates left out because the incident alone exceeds the response size budget; absent when every update is returned.'),
    source: z.enum(['api', 'history']).describe('api: the status API. history: the page\'s history archive, read only with since.'),
  })),
  total_returned: z.number(),
  statuspage_url: z.string(),
})
```

**Enrichment:** every field is optional and written only on the path that produces it, so a plain result carries none of them. All reach both `structuredContent` and the `content[]` trailer via `output.extend(enrichment)`.

| Field | Written when |
|:---|:---|
| `truncated`, `shown`, `cap`, `totalCount` | more incidents matched (after the filter, date range, and `match`) than this page returned — because of `limit`, or because the page stopped at the response size budget, where `shown` < `cap`. `cap` is the limit that was applied: the requested limit, or 50 when a larger one was requested |
| `nextOffset` | same — the `offset` to pass next, already computed. Its absence is the stop condition for an agent paging in a loop |
| `upstreamCeiling` | the vendor's own feed returned as many records as it will ever serve (see below). Independent of `truncated`: a full window can be the vendor's cap rather than this tool's. Absent when `since` was set and the history archive was read back to it (or to the 24-month floor, when `since` is earlier) |
| `notice` | any of the above, a `limit` over 50 served as 50 (with the requested and effective values), a `since` older than the 24-month history-archive floor (with the date the archive was read back to), the page stopping at the response size budget, the first incident's oldest updates left out (naming `offset`, `limit: 1`, and `full_updates: true`), a date range or `match` emptying the result, an empty result, or a history walk that stopped short of `since` or the floor — naming the date it reached and why (no archive, a transport or shape failure, an unreadable timestamp, a page that did not step back a quarter, more pages than the floor needs, a failed maintenance-list read under `resolved`). Composed into one string because the framework's `notice` is last-wins across `ctx.enrich` calls |

**Empty results** explain themselves through `notice`, in terms of the call that produced them: an `offset` past the end names the valid range, the filter, the range (`(since X, until Y)`), and the `match` words that defined the set; a `match` that emptied the result reports how many incidents it removed and suggests fewer or broader words (archive records and component-less vendors match on title only); a date range that left every match out reports what `since` and `until` each left out, adding on a Statuspage vendor whose range starts before the archive floor that only records the status API still returns are reachable before it; `until` alone on a Statuspage vendor suggests adding `since` to read the archive — or, for an `until` older than the floor, says the archive does not reach it — and on other backends says the feed returns nothing older; a filter the backend cannot satisfy says so; otherwise the message names only the filters that can return more than the one just used. `all` is offered only when another disjoint filter is — on a backend with no resolved history and no maintenance feed (`azure`), an empty `active` says the vendor lists no open incidents and suggests no retry.

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
    reason: 'invalid_since',
    code: JsonRpcErrorCode.ValidationError,
    when: 'since was passed with filter "active" or "scheduled"',
    recovery: 'Pass since with filter "all" or "resolved", or omit it. It reads the history archive back 24 months at most.',
  },
  {
    reason: 'invalid_until',
    code: JsonRpcErrorCode.ValidationError,
    when: 'until was passed with filter "active" or "scheduled", or names a date earlier than the since date',
    recovery: 'Pass until as a YYYY-MM-DD date on or after since, with filter "all" or "resolved".',
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

A history-archive failure is never `statuspage_unavailable`: it becomes a `notice` on the v2 result.

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`, `idempotentHint: true`

#### Backend history capabilities

Normalizing eight backends to the Statuspage shapes hides what each feed can actually serve. `backendHistory()` in `status-dispatch.ts` states it, exhaustively over `api_type` so a new backend cannot be added without answering all four questions. `vendorHistory(vendor)` is the same table per resolved entry, with `historyPages: false` for an entry scoped to part of a shared Statuspage page (`sendgrid`): history-archive records list no components, so `since` reads no archive for it, and its ceiling disclosure counts the page's unfiltered feed.

| Backend | Incident ceiling | Resolved history | Maintenance windows | History archive (`historyPages`) |
|:---|:---|:---|:---|:---|
| Statuspage | 50 per fetch, `?page=` ignored | full (within the ceiling) | yes | yes — read with `since`; per-host availability is disclosed per call |
| Slack | 50 per fetch, `?page=` ignored | full (within the ceiling) | none — empty with no network call | no |
| AWS Health | unbounded (current events only) | current only — a resolved event (status `0`, summary prefixed `[RESOLVED]`) stays listed for hours, then drops off | none — empty with no network call | no |
| Google Cloud | no record cap; query parameters ignored — a rolling recent window bounded by age, not by a count | full — resolution comes from each incident's `end` | none — empty with no network call | no |
| Azure | unbounded (posted items only) | none — no lifecycle field, every item maps to `investigating` and leaves the feed when resolved | none — empty with no network call | no |
| Azure DevOps | no record cap — a rolling recent window bounded by age | full — Resolved items stay in the feed | none — empty with no network call | no |
| Status.io | unbounded (current incidents only) | current only — resolved incidents drop off the feed | yes | no |
| FireHydrant | unbounded — the payload carries the whole history | full | yes | no |

---

### `devops_watch_stack`

**Description:** Check the health of a named vendor stack — a saved list of vendors representing your infrastructure dependencies. On the first call, provide `vendors` to define the stack; subsequent calls can omit `vendors` to reuse the persisted list. Stacks are saved per authenticated caller, or per local server process; a shared deployment that does not authenticate callers saves nothing, so there `vendors` is required on every call and the response says so. Up to 20 vendors are saved per stack and checked per call; use several stack names for a larger set. Returns a unified health snapshot: an aggregate rollup (all green / N degraded) plus per-vendor detail. Ideal for morning status checks or pre-deploy sweeps.

Stack configuration is persisted per tenant via `ctx.state` using the `stack_name` as the key, only where the tenant identifies the caller (`stacksPersist()`: `mcpTransportType === 'stdio' || mcpAuthMode !== 'none'`). Multiple stacks can coexist (e.g., `"production"`, `"staging"`).

Only the vendors that resolve are saved. Persisting an entry that resolves to no target would put a permanent error row in every future sweep of that stack, so the write covers the resolvable subset and `omitted_vendors` names what was left out — the caller is told the saved stack is smaller than what they passed. A list where *nothing* resolves throws and writes nothing at all. A call that reuses a saved stack does not rewrite it, so an entry that stopped resolving since it was saved stays listed in `omitted_vendors` on every call until the caller re-provides `vendors`.

**Input:**
```ts
z.object({
  vendors: z.array(z.string()).max(100).optional()
    .describe('Vendor slugs (e.g., "github", "aws") or raw Statuspage base URLs. When provided, saves this list as the stack where stacks are saved; a list longer than 20 is then rejected and nothing is saved. When omitted, uses the previously saved list for stack_name; required on every call on a deployment that does not authenticate callers, which saves no stacks — there the first 20 are checked and the rest return in deferred_vendors. Lists longer than 100 are rejected.'),
  stack_name: z.string().min(1).max(64).regex(STACK_NAME_RE).default('default')
    .describe('Name for this vendor stack. Defaults to "default". Use distinct names to manage multiple stacks (e.g., "production", "data-layer"). Letters, digits, hyphens, and underscores, optionally separated by single dots or slashes ("prod.eu", "team/prod"); 1-64 characters. No spaces or colons.'),
  mode: z.enum(['summary', 'detailed']).default('summary')
    .describe('summary: indicator + degraded components + active incidents. detailed: adds component lists and maintenance windows.'),
  component_filter: z.string().optional()
    .describe('Case-insensitive substring matched against component names and their group names in detailed mode (e.g., "api" to check just the API components, or a product or region a page groups components under). Applied before component_limit, so it is the way to reach a component that the cap would otherwise omit. A filter that matches nothing for a vendor is reported in notice. Ignored in summary mode.'),
  component_limit: z.number().int().min(1).default(50)
    .describe('Maximum components returned per vendor in detailed mode, at least 1. A value above 500 is reduced to 500, and notice says so.'),
})
```

**Output:**
```ts
z.object({
  stack_name: z.string(),
  health: z.enum(['all_operational', 'maintenance', 'degraded', 'partial_outage', 'major_outage', 'unknown']),
  summary: z.object({ // total = vendors checked on this call, never counts deferred_vendors
    total: z.number(),
    operational: z.number(),
    degraded: z.number(),
    down: z.number(),
    maintenance: z.number(),
    unavailable: z.number(),
  }),
  vendors: z.array(/* same per-vendor shape as devops_status_check results[] */),
  deferred_vendors: z.array(z.string()).describe('Entries past the first 20, verbatim and in order, that were not checked on this call: the rest of a passed vendors list on a deployment that saves no stacks, or of a saved stack holding more than 20.'),
  stack_persisted: z.boolean().describe('True when the vendor list was saved on this call. Only the vendors that resolved are saved — see omitted_vendors. Always false on a deployment that does not authenticate callers, which saves no stacks (persistence_notice says so).'),
  omitted_vendors: z.array(z.string()).describe('Entries that could not be resolved or were blocked, and so are left out whenever the stack is saved. They still appear in vendors[] with an error.'),
  checked_at: z.string(),
  nextToolSuggestions: z.array(/* same suggestion shape and rules as devops_status_check */),
})
```

**Enrichment:** `truncated` / `shown` / `cap` / `totalCount` and `notice`, identical to `devops_status_check` — both tools share `buildVendorResult()` and `fetchVendorResults()` and aggregate its component counts once after the fan-out. A saved stack holding more than 20 vendors adds its own sentence to `notice`: save them under several stack names of at most 20 each. `persistence_notice` (optional string, rendered as a blockquote in `content[]`) is separate and coexists with `notice`: "This deployment does not save stacks because callers are not authenticated — pass vendors on every call." Present on every successful call on HTTP with auth `none`, absent elsewhere.

**Errors:**
```ts
errors: [
  {
    reason: 'no_stack',
    code: JsonRpcErrorCode.NotFound,
    when: 'No vendors provided and no saved stack found for stack_name.',
    recovery: 'Provide a vendors list to define the stack. It will be saved for future calls.',
  },
  {
    reason: 'vendors_required',
    code: JsonRpcErrorCode.ValidationError,
    when: 'No vendors provided on a deployment that saves no stacks because callers are not authenticated',
    recovery: 'Pass the vendors list on every call — this deployment does not save stacks between calls.',
  },
  {
    reason: 'stack_too_large',
    code: JsonRpcErrorCode.ValidationError,
    when: 'More than 20 vendors were provided on a deployment that saves stacks, so nothing was saved',
    recovery: 'Pass at most 20 vendors per stack, and save a larger set under several stack_name values.',
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

**Annotations:** `readOnlyHint: false` (providing `vendors` saves the stack wherever `stacksPersist()` holds), `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true`

---

### `devops_check_certs`

**Description:** Inspect SSL/TLS certificate health for one or more domains by performing a real TLS handshake. Pure TypeScript — no external API. Reports: days to expiry (flagged at < 30 days warning and < 7 days critical), certificate subject and SANs, issuer, hostname coverage, chain-trust verification, chain depth where the runtime exposes it, TLS protocol version negotiated (flags TLS 1.0 and 1.1 as insecure; a server offering only those is still inspected and graded `critical`), cipher suite, and HSTS presence when the port answers HTTP (detected via an HTTP GET over the TLS socket to read the `Strict-Transport-Security` response header — reported in `flags` as "HSTS present" / "HSTS not configured"; a port that gives no HTTP reply reports `HSTS not checked — no HTTP response on port <port>`). Works for any internet-accessible domain, not just registered vendors. When a certificate fails to issue or renew, `devops_check_dns` with `record_types: ["CAA"]` shows which certificate authorities the domain allows.

**Input:**
```ts
z.object({
  domains: z.array(z.string().min(1).describe('A host to inspect: a hostname ("api.github.com"), an IP address, a host with a port ("example.com:8443", "[2606:4700:4700::1111]:853"), or a URL ("https://example.com/login"), which is reduced to its host.'))
    .min(1).max(100)
    .describe('Hosts to inspect. The first 10 entries are inspected; up to 100 are accepted, and entries past the 10th come back uninspected and verbatim in deferred_domains, to resend in another call. Each entry is read as one host: …'), // full text in the tool file
  port: z.number().int().min(1).max(65535).default(443)
    .describe('TLS port for entries that do not carry their own. Defaults to 443. Use 8443 or custom ports for non-standard HTTPS endpoints, or 993, 465, 853, and the like for other TLS services. A port written on an entry ("example.com:8443") wins for that entry.'),
  timeout_ms: z.number().int().min(1000).default(5000)
    .describe('Time limit in milliseconds for each domain, covering the connection, the handshake, a second handshake with TLS 1.0/1.1 enabled when the server offers nothing newer, and the HSTS request. … At least 1000; a value over 15000 is served as 15000, and the notice says so. Defaults to 5000 unless the server is configured otherwise.'), // full text in the tool file
})
```

Each `domains` entry is read as one host by the shared normalizer (see Design Decisions): surrounding whitespace and letter case are ignored, a scheme, path, query, or fragment is dropped, an internationalized name is converted to its ASCII form, and a port written on the entry is used for that entry in place of `port`. An entry with no single host gets its own `error` row and is never connected to.

**Output:**
```ts
z.object({
  results: z.array(z.object({
    domain: z.string().describe('The host that was inspected, as read from the submitted entry (lowercase, ASCII, no scheme, port, or path; an IPv6 address without brackets). For an entry with no single host, the submitted string as given.'),
    port: z.number().describe('The port used for the TLS connection: the port written on the entry, otherwise the "port" input.'),
    status: z.enum(['ok', 'warning', 'critical', 'error']).describe('critical = expired or < 7 days, hostname mismatch, chain-trust failure, or insecure TLS (including a server that offers nothing newer than 1.1); warning = < 30 days; error = no certificate retrieved (entry rejected, connection failure, timeout, or no certificate presented), reason in error. Graded from the certificate and session alone: HSTS never changes it.'),
    flags: z.array(z.string()).describe('Findings about the certificate and TLS session that were read: "Expires in 12 days (warning)", "Insecure TLS version in use: TLSv1.1", "Self-signed certificate", "Hostname mismatch — the certificate does not cover <domain>; clients will reject it", "Certificate chain not trusted (<CODE>); clients will reject it", and one HSTS finding: "HSTS present" or "HSTS not configured" when the port answered the HTTP request, or "HSTS not checked — no HTTP response on port 993" when it did not. Empty when no handshake completed (rejected entry or target, connection failure, timeout); a handshake with no certificate keeps its TLS-session findings.'),
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
    }).nullable().describe('Null when no certificate was retrieved (error status).'),
    tls: z.object({
      protocol: z.string().describe('Negotiated TLS version, e.g., "TLSv1.3".'),
      cipher: z.string().describe('Negotiated cipher suite name.'),
    }).nullable().describe('Null when no TLS handshake completed.'),
    checked_at: z.string().describe('ISO 8601 UTC.'),
    error: z.string().nullable().describe('Why status is "error": no handshake completed (an entry with no single host, a rejected target, a connection failure, or a timeout — cert and tls null, flags empty; for a server offering only TLS 1.0/1.1 that still refuses, the failure of the legacy-version attempt), or the handshake completed without a certificate (cert null, tls and session flags kept). Null for every other status, including a completed handshake whose port never answered HTTP.'),
  })),
  deferred_domains: z.array(z.string()).describe('Host entries past the first 10, not inspected on this call, verbatim and in input order. Resend them in another call. Empty when every entry was inspected.'),
})
```

**Enrichment:** `notice`, present when the call was served at a bound: hosts past the per-call cap (named in `deferred_domains`), or a `timeout_ms` over 15000 served as 15000. Both notices come from `src/utils/input-bounds.ts`.

**Errors:**
- Connection failures per-domain are reported inline (status: `'error'`) rather than throwing — batch semantics, partial results are useful. An entry with no single host (a user name before `@`, a bad port, a malformed label) is an inline `error` row with no network call, never a thrown error. Caller cancellation rejects the call (`RequestCancelled`), never a row.
- A domain that is never inspected — rejected by the SSRF guard, a socket error, or a timeout — reports the reason in `error` alone and returns `flags: []`: `flags` holds findings about a certificate that was read, and repeating the failure there rendered it twice. A guard rejection drops the internal `SSRF_BLOCKED: ` sentinel, as every other rejection path does.
- A handshake that completes without the server presenting a certificate is also `status: 'error'`, with `error` naming that cause. The TLS session was read, so `tls` and its findings in `flags` (insecure protocol, HSTS) stay reported; only `cert` is null. Every `status: 'error'` row carries a reason.

The tool declares no `errors[]` contract.

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`

Implementation: `node:tls` socket with `rejectUnauthorized: false` and an overridden `checkServerIdentity`, so a certificate ordinary clients reject is still inspected rather than collapsing into a connection error. The override does not discard the hostname check: it calls `tls.checkServerIdentity(host, cert)` explicitly, records the result in `hostname_verification_error`, and returns `undefined` to let the handshake finish. Chain trust comes from `socket.authorizationError`, read independently — it is populated even under `rejectUnauthorized: false`, and is normalized from the bare OpenSSL code string some runtimes return. One `timeout_ms` deadline (combined with the caller's `ctx.signal`) spans the handshake, a single legacy retry on `ERR_SSL_UNSUPPORTED_PROTOCOL` / `ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION` (`minVersion: 'TLSv1'` on Bun; `minVersion: 'TLSv1'` plus ``ciphers: `${tls.DEFAULT_CIPHERS}:@SECLEVEL=0` `` on Node), and the HSTS read; the socket is destroyed when it runs out. `servername: host` is passed for hostnames (IP literals send none). After the handshake, send a minimal HTTP/1.1 GET over the same socket on every port (the `Host:` header brackets an IPv6 host); the reply is read as HTTP only when it starts with `HTTP/`, then `Strict-Transport-Security` is read from the headers received (header read capped), so a non-HTTP port keeps its certificate grade. Per-domain results collected with `Promise.allSettled`; the service rethrows after it when the caller's signal aborted, so a cancellation is never reported as a timeout row.

---

### `devops_check_dns`

**Description:** Resolve DNS records for one or more domains across multiple public resolvers and compare what each resolver returned. Pure TypeScript — queries each resolver directly over the DNS wire protocol. Reports records found (A/AAAA/CNAME/MX/TXT/NS/CAA/SOA), resolution latency per resolver, a typed outcome per resolver and record type (`ok` / `nodata` / `nxdomain` / `servfail` / `refused` / `timeout` / `error`), and resolver disagreements labelled by kind rather than by an asserted cause. Works for any domain.

**Input:**
```ts
z.object({
  domains: z.array(z.string().min(1)).min(1).max(100)
    .describe('Domain names to query. The first 10 entries are queried; up to 100 are accepted, and entries past the 10th come back unqueried and verbatim in deferred_domains, to resend in another call. Each entry is read as one name: surrounding whitespace and letter case are ignored, a scheme, port, path, query, or fragment is dropped, and an internationalized name is converted to its ASCII form; a trailing dot and underscore labels are kept. An entry that is not a domain name — an IP address, a user name before "@", a bad port, or a malformed label — gets its own result with "error" set and is never queried; the other entries still run.'),
  record_types: z.array(z.enum(['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'CAA', 'SOA']))
    .default(['A', 'AAAA', 'MX', 'TXT'])
    .describe('DNS record types to resolve. Defaults to A, AAAA, MX, and TXT. An empty array uses the same defaults. A type listed more than once is queried once. Add NS to check nameserver delegation. Add CNAME when investigating redirect chains. Add CAA when a certificate will not issue or renew: it lists the certificate authorities allowed to issue for the name. CAA is reported for the exact name only; a CA that finds none there checks the parent domains, so no CAA at a subdomain does not mean any CA may issue. Add SOA to compare zone serials across resolvers. SOA answers only at a zone apex, so a name below it returns nodata (a name that is a CNAME returns the SOA of its target). A serial difference means a zone change has not reached every resolver only when those resolvers report the same primary nameserver; a different primary means more than one DNS provider serves the zone.'),
  resolvers: z.array(z.string().min(1)).max(20).default(['8.8.8.8', '1.1.1.1', '9.9.9.9'])
    .describe('Resolver IP addresses to query. Defaults to Google (8.8.8.8), Cloudflare (1.1.1.1), and Quad9 (9.9.9.9). An empty array uses the same defaults. Add custom resolvers to test resolver-specific behavior. A resolver listed more than once — the same address and port, however written ("8.8.8.8" and "8.8.8.8:53") — is queried once, under its first spelling. The first 5 distinct resolvers are queried; up to 20 entries are accepted, and the rest come back unqueried in deferred_resolvers, to resend with the same domains in another call. Each must be an IP literal, not a hostname; resolvers in private, loopback, or cloud-metadata ranges are rejected unless DEVOPS_STATUS_ALLOW_PRIVATE_TARGETS=true.'),
  timeout_ms: z.number().int().min(1000).default(3000)
    .describe('Time limit in milliseconds for each domain+resolver pair, covering every requested record type and any retry over TCP. A resolver that has not answered within it reports "timeout" for the unanswered types. At least 1000; a value over 10000 is served as 10000, and the notice says so. Defaults to 3000 unless the server is configured otherwise.'),
})
```

An empty `resolvers` or `record_types` array is read as "no preference" and replaced with the defaults in the handler. Queried literally it asks nothing and returns a ✅ result with no records, no flags, and no error — a healthy-looking answer to a question never put. The mapping lives in the handler rather than a schema transform so the advertised input schema is unchanged, and no call that worked before starts failing.

**Output:**
```ts
z.object({
  results: z.array(z.object({
    domain: z.string().describe('The domain name that was queried, as read from the submitted entry (lowercase, ASCII, no scheme, port, or path). For an entry that is not a domain name, the submitted string as given.'),
    records: z.record(
      z.enum(['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'CAA', 'SOA']),
      z.array(z.string())
    ).describe('Resolved records from one resolver — the primary (first in list), or the first resolver that returned records when the primary returned none. Keyed by record type. Names carry no trailing dot; MX renders as "<preference> <exchange>", CAA as \'<flags> <tag> "<value>"\', and SOA as "<primary nameserver> <hostmaster> <serial> <refresh> <retry> <expire> <minimum>". Also the reference set the per-resolver answers are reported against.'),
    records_source: z.string().nullable().describe('Resolver IP whose answers populated `records`, or null when no resolver was queried.'),
    resolver_results: z.array(z.object({
      resolver: z.string().describe('Resolver IP address.'),
      latency_ms: z.number().int(),
      records: z.record(z.string(), z.array(z.string())).describe('Only the types whose values differ from the domain-level `records` set. A type answered identically is named in `records_same_as_domain` instead; a requested type in neither returned nothing from this resolver, and `status_by_type` says why.'),
      records_same_as_domain: z.array(z.string()).describe('Record types this resolver answered with exactly the domain-level values, omitted from `records` rather than duplicated.'),
      status: z.enum(DNS_QUERY_STATUSES).describe('Headline outcome: ok when any requested type resolved, else the most actionable failure across types.'),
      status_by_type: z.record(z.string(), z.enum(DNS_QUERY_STATUSES)).describe('Outcome per requested record type. nodata = the domain exists but has no record of this type; nxdomain = the domain does not exist; servfail = the resolver could not answer, commonly DNSSEC; refused = the resolver declined the query or refused the connection.'),
      error: z.string().nullable().describe('Failure summary such as "SERVFAIL on A, MX", or null when every type resolved or returned nodata.'),
    })).describe('Per-resolver breakdown for propagation analysis.'),
    propagation_discrepancies: z.array(z.object({
      record_type: z.string(),
      resolvers_agree: z.boolean(),
      kind: z.enum(['value_variation', 'partial_resolution']).describe('partial_resolution = some resolvers answered and some did not (the signal worth investigating); value_variation = every resolver answered with different values (anycast/geo-steering, or an in-flight change).'),
      values_by_resolver: z.record(z.string(), z.array(z.string())),
      status_by_resolver: z.record(z.string(), z.enum(DNS_QUERY_STATUSES)).describe('Per-resolver outcome for this record type — explains why an entry in values_by_resolver is empty.'),
    })).describe('Record types where resolvers returned different answers, labelled by kind. Empty when all resolvers agree.'),
    flags: z.array(z.string()).describe('Observations needing attention: "NXDOMAIN from 8.8.8.8 on A — the domain does not exist …", "SERVFAIL from 1.1.1.1 on A — …", "Partial resolution on A records — 9.9.9.9 (nodata) returned nothing while 8.8.8.8 answered", "No MX records found", "CNAME detected — further records resolve via the CNAME target". A value_variation is deliberately not flagged. Empty for a domain rejected before any query.'),
    error: z.string().nullable().describe('Set only when the domain could not be queried at all: rejected before any query (resolver_results empty), or every resolver failed and none returned records — then each resolver is named with its own outcome so a split result stays visible.'),
  })),
  deferred_domains: z.array(z.string()).describe('Domain entries past the first 10, not queried on this call, verbatim and in input order. Resend them in another call. Empty when every entry was queried.'),
  deferred_resolvers: z.array(z.string()).describe('Distinct resolvers past the first 5, not queried on this call, verbatim and in input order. Resend them with the same domains in another call. Empty when every resolver was queried.'),
})
```

**Enrichment:** `notice`, present when the call was served at a bound: domains or resolvers past the per-call cap (named in `deferred_domains` and `deferred_resolvers`), or a `timeout_ms` over 10000 served as 10000. Several bounds on one call join into one notice.

A domain rejected before any query (the SSRF guard, typically, or an entry that is not a domain name — including an IP address — whose message names the entry and the accepted shapes) reports the reason in `error` alone, without the internal `SSRF_BLOCKED: ` sentinel, and returns empty `records`, `resolver_results`, `propagation_discrepancies`, and `flags`, with `records_source: null`; `format()` omits the resolver header when there are no resolver results. The all-resolvers-failed case is different: its `NXDOMAIN from …` / `SERVFAIL from …` flag carries the operator explanation the `error` string lacks, so it keeps both.

**Errors:**
```ts
errors: [
  {
    reason: 'target_blocked',
    code: JsonRpcErrorCode.ValidationError,
    when: 'A resolver is a private, loopback, or otherwise non-public address, or is not an IP literal at all.',
    recovery: 'Use a public resolver IP literal (e.g., 8.8.8.8, 1.1.1.1), optionally with a port; pass an address rather than a hostname. Set DEVOPS_STATUS_ALLOW_PRIVATE_TARGETS=true for trusted local/internal monitoring deployments.',
  },
]
```

`target_blocked` also covers a hostname resolver and a resolver port outside 1–65535, regardless of the private-targets setting. An entry in `domains` that is not a domain name is an inline `error` row, not a thrown error; caller cancellation rejects the call (`RequestCancelled`), never a row.

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`

Implementation: a DNS wire client (`src/services/dns/dns-wire-client.ts` + `dns-message.ts`) on `node:dgram` / `node:net`. Per domain+resolver pair, every requested record type is one query: a connected UDP socket (EDNS0, 1232-byte payload), one resend at half the deadline, and a TCP retry to the same address and port when the reply is truncated, all under one `timeout_ms` deadline (combined with the caller's `ctx.signal`: on abort every socket closes at once). A reply is accepted only when its ID, question, and source match. Status comes from the RCODE (NOERROR + answers → ok, NOERROR empty → nodata, NXDOMAIN, SERVFAIL, REFUSED; refused connection → refused; deadline → timeout; other RCODEs, malformed replies, and an unreachable address → error with a detail). Answers follow the CNAME chain from the question name. Domains fan out with `Promise.allSettled`, and latency is measured with `performance.now()`.

---

### `devops_suggest_action`

**Description:** Instruction tool — returns an incident-response playbook tailored to a vendor degradation, with pre-filled follow-up tool calls. Does not call any external APIs; synthesizes guidance from built-in incident knowledge and the provided context. Use after `devops_status_check` or `devops_get_incidents` surfaces a problem to determine what to investigate next. Output includes static mitigation steps specific to the vendor/component category and `nextToolSuggestions` with arguments pre-populated from `affected_components`.

**Input:**
```ts
z.object({
  vendor: z.string().min(1)
    .describe('Vendor slug, display name, or raw status page URL (e.g., "cloudflare", "Amazon Web Services"). Used to tailor category-specific guidance (CDN outage vs. CI/CD outage vs. auth provider outage). A name that matches no registry vendor gets a devops_list_vendors search as its first follow-up instead of an incidents call.'),
  incident_summary: z.string().optional()
    .describe('Latest incident description or update body from devops_get_incidents. Paste the most recent update to get more targeted advice.'),
  affected_components: z.array(z.string()).optional()
    .describe('Component names affected (from devops_status_check degraded_components or devops_get_incidents affected_components). Values pre-filled by devops_status_check read "Group / Leaf" for a component the status page files under a group. Used to tailor suggestions to the impacted subsystem.'),
  your_domain: z.string().optional()
    .describe('Your own domain or service URL. When provided, nextToolSuggestions will be pre-filled with your domain for cert and DNS checks.'),
  vendor_indicator: z.enum(['none', 'minor', 'major', 'critical', 'maintenance']).optional()
    .describe('Overall vendor status indicator from a prior devops_status_check call (its indicator field). When provided, the playbook leads with severity-tailored urgency guidance. Omit if status has not been checked yet.'),
})
```

**Output:**
```ts
z.object({
  vendor: z.string(),
  vendor_category: z.string().nullable().describe('Detected category from registry (e.g., "cdn-edge", "auth"). Null for unrecognized vendors.'),
  guidance: z.string().describe('Markdown playbook — immediate steps, diagnostic checks, mitigation options, and what to monitor for resolution. Tailored to the vendor category and affected components.'),
  diagnostics_summary: z.object({
    vendor_indicator: z.enum(['none', 'minor', 'major', 'critical', 'maintenance']).nullable()
      .describe('Vendor status indicator echoed from the vendor_indicator input, or null when not provided.'),
    affected_components: z.array(z.string()),
    incident_snippet: z.string().nullable(),
  }),
  nextToolSuggestions: z.array(z.object({
    toolName: z.string().describe('Tool to call next (e.g., "devops_get_incidents", "devops_list_vendors", "devops_check_dns").'),
    reason: z.string().describe('Why this step is recommended given the incident context.'),
    args: z.record(z.unknown()).describe('Arguments pre-filled from provided context (vendor name, your_domain if provided, affected component names).'),
  })).describe('Recommended follow-up calls with arguments already populated. Execute these in sequence to gather diagnostic data.'),
})
```

**Errors:** None expected — no external calls. Fallback to generic guidance when vendor is not in registry. An unregistered vendor that isn't a URL gets a `devops_list_vendors` `{ query }` suggestion first (reason: `"<vendor>" is not a registry slug or display name — search the registry for its slug, then call devops_get_incidents with it.`), never a `devops_get_incidents` call; a registry match gets `devops_get_incidents { vendor: <slug>, filter: "active", limit: 5 }`, a raw URL the same call with the URL.

**Annotations:** `readOnlyHint: true`, `openWorldHint: false`

---

### `devops_list_vendors`

**Description:** List vendors in the built-in registry, optionally filtered by category or name search. Returns slug, display name, category, and Statuspage base URL for each entry. Use to discover the correct slug to pass to other tools, or to see which vendors are available before configuring a stack.

**Input:**
```ts
z.object({
  query: z.string().optional()
    .describe('Substring search against vendor slug and display name. Case-insensitive; surrounding whitespace is ignored. E.g., "cloud", "auth", "slack".'),
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

**Enrichment:**
```ts
enrichment: {
  notice: z.string().optional(), // written only when vendors is empty
}
```

**Empty result:** every category has entries, so only a `query` can empty the result. The `notice` (in `structuredContent` and rendered once into `content[]` by the framework; `format()`'s empty branch says only `No vendors matched.`) is one of three templates, `<n>` being the registry size read at runtime:

- no match anywhere, no `category`: `No registry vendor's slug or display name contains "<query>".` + routing
- no match anywhere, `category` set: `No registry vendor's slug or display name contains "<query>", in category "<category>" or any other.` + routing
- no match in `category`, matches outside it: `No vendor in category "<category>" has a slug or display name containing "<query>"; outside it: <slug> (<category>), …. Drop category to see them.`

The first two end in this routing text: ` Call devops_list_vendors with no arguments to browse all <n> vendors. A vendor outside the registry still works if its status page runs on Atlassian Statuspage: pass the page's base URL (e.g., https://status.example.com) as the vendor to devops_status_check, devops_get_incidents, or devops_watch_stack.`

**Annotations:** `readOnlyHint: true`, `openWorldHint: false`

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `statuspage-service` | Atlassian Statuspage public API (`/api/v2/status.json`, `/components.json`, `/incidents.json`, `/scheduled-maintenances.json`, `/summary.json`) and the page's `/history.json?page=N` archive. Reads through `fetchCached` in `src/utils/cached-fetch.ts` (60s TTL keyed by normalized URL, size-bounded; manual redirect handling plus a per-request timeout, no retry). `incident-history.ts` beside it walks the archive back to a date and resolves its timestamps to UTC. Each v2 endpoint's update bodies and each history record's `message` are converted to plain text (`htmlToText`) in the fetch's parse step, so the cache holds converted text and a cached read never converts again. | `devops_status_check`, `devops_get_incidents`, `devops_watch_stack` |
| `vendor-registry-service` | In-memory registry loaded from `src/data/vendor-registry.ts` at startup. Resolves vendor slugs → Statuspage URLs. Provides category listing and slug→name lookup. | all status tools, `devops_list_vendors`, `devops_suggest_action` |
| `cert-service` | `node:tls` — direct TLS handshake, no external API. Parses X.509 fields from `tls.DetailedPeerCertificate`. One legacy-TLS retry, SNI, HSTS read only on HTTP replies. Takes normalized `DomainEntry[]` and the caller's abort signal. | `devops_check_certs` |
| `dns-service` | DNS wire client on `node:dgram` / `node:net` (UDP + EDNS0, TCP on truncation, one deadline per domain+resolver); multi-resolver fan-out and discrepancy detection. Takes normalized `DomainEntry[]` and the caller's abort signal. | `devops_check_dns` |

**No external SDK dependencies.** All status HTTP calls go through `fetchCached` (`src/utils/cached-fetch.ts`). TLS and DNS use Node.js stdlib only (`node:tls`; `node:dgram` / `node:net`).

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `MCP_TRANSPORT_TYPE` | No | `stdio` (default) or `http`. Framework standard. |
| `MCP_HTTP_PORT` | No | HTTP port when transport is HTTP. Framework standard. |
| `DEVOPS_STATUS_CACHE_TTL_MS` | No | In-memory cache TTL for Statuspage reads. Default: `60000` (60s). |
| `DEVOPS_STATUS_FETCH_TIMEOUT_MS` | No | Per-request timeout for Statuspage API calls. Default: `8000` (8s). |
| `DEVOPS_STATUS_CERT_TIMEOUT_MS` | No | Per-domain deadline covering the connection, handshake, any legacy-TLS retry, and the HSTS read. Integer 1000–15000. Default: `5000` (5s). |
| `DEVOPS_STATUS_DNS_TIMEOUT_MS` | No | Deadline per domain+resolver pair, covering every record type and the TCP retry. Integer 1000–10000. Default: `3000` (3s). |

An invalid value of any `DEVOPS_STATUS_*` variable (including a timeout outside its range) fails startup through the framework's configuration-error banner, naming the variable.

No API keys. No vendor credentials.

---

## Implementation Order

1. **Vendor registry data file** — `src/data/vendor-registry.ts` with the curated vendor list and the `VendorEntry` / `VendorCategory` types. Independently verifiable.
2. **vendor-registry-service** — init/accessor pattern, slug normalization, URL validation for raw inputs.
3. **`devops_list_vendors`** — first tool, validates the registry shape and slug resolution.
4. **statuspage-service** — `fetchSummary()`, `fetchIncidents()`, `fetchScheduledMaintenances()`. Cache layer. Verified against live GitHub and Netlify endpoints.
5. **`devops_status_check`** — fan-out with `Promise.allSettled`, aggregate health rollup.
6. **`devops_get_incidents`** — filter mode (active/resolved/scheduled), duration computation, `match` / `until` narrowing and paging, the response size budget.
7. **`devops_watch_stack`** — `ctx.state` read/write for persisted stack (gated by `stacksPersist()`: `mcpTransportType === 'stdio' || mcpAuthMode !== 'none'`), delegates to statuspage-service.
8. **cert-service** — `node:tls` wrapper, `DetailedPeerCertificate` parsing, expiry flagging.
9. **`devops_check_certs`** — per-domain `Promise.allSettled`, status classification.
10. **dns-service** — DNS wire client (UDP/TCP), multi-resolver fan-out, propagation discrepancy detection.
11. **`devops_check_dns`** — fan-out across domains × resolvers × record types; domains (10), distinct resolvers (5), and distinct record types bound the fan-out.
12. **`devops_suggest_action`** — static playbook dispatch by `vendor_category`, `nextToolSuggestions` assembly.
13. **Resource** — `devops-status://vendors/{name}`.
14. **`devcheck`** + field tests against live Statuspage endpoints.

Each step is independently testable. Steps 4–7 can proceed in parallel once vendor-registry-service is ready. Steps 8–9 and 10–11 can proceed in parallel after step 3.

---

## Design Decisions

### Why accept raw Statuspage URLs alongside vendor slugs?

The vendor registry is curated and finite. Any tool that requires a slug forces users to wait for the registry to grow before they can check a vendor they care about. Raw URL passthrough costs nothing to implement — `vendor_not_found` becomes `use_raw_url` instead of a dead end. Users who know a vendor is on Statuspage don't need to know their slug. This also makes the server useful for internal status pages that are on Statuspage infrastructure.

### Why not auto-detect whether a vendor uses Statuspage?

The alternative is: probe the URL, detect Statuspage by content type or page shape, fall back to bespoke parsing. This is unreliable (non-Statuspage pages can have similar paths), slower (extra round trip), and unpredictable for users. The registry is the known-good set; raw URL passthrough is the explicit escape hatch. Vendors on other backends (AWS, Google Cloud, Azure, Azure DevOps, Status.io, Slack, FireHydrant) are reached through registry entries whose `api_type` selects a native adapter, never by detection.

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

### Why stacks persist only where the tenant identifies the caller

On HTTP with auth `none` every caller runs as tenant `default`, so a stack saved there would be shared by all of them. The tool saves nothing in that case and requires `vendors` on every call; keying by a caller-held token, session id, or client IP was rejected (secret in transcripts; no session on a stateless server; NAT and CDN collisions). The gate is `stacksPersist()`, which mirrors the framework's own rule for assigning tenant `default`; `ctx.tenantId === 'default'` alone cannot tell that case from stdio.

### Why a `devops_watch_stack` save over 20 rejects while a read defers

Saving the first 20 of a longer list would store a stack the caller didn't ask for, so a save over the cap rejects before anything is written (`stack_too_large`). Where the deployment saves nothing the call is a read, so it follows the batch rule: check the first 20, return the rest in `deferred_vendors`. 20 matches `devops_status_check` because both fan out one upstream fetch per vendor in parallel; the 100 ceiling bounds the echoed `deferred_vendors` and sits above the registry size, so a list of every slug is served in part, never rejected.

### Why batch inputs serve up to the cap and return the rest

`devops_status_check` / `devops_watch_stack` (`vendors`, 20 per call), `devops_check_certs` / `devops_check_dns` (`domains`, 10 per call), and `devops_check_dns` (`resolvers`, 5 distinct per call) serve their first entries in input order and return the rest verbatim in `deferred_*` fields: a read with one obvious reading shouldn't cost a round trip. Hard ceilings (100 vendors and domains, 20 resolver entries) sit above the per-call caps because the deferred entries are echoed back. Resolver equality is the address+port the wire client sends to (`parseResolverTarget`; default port 53; IPv6 compared in canonical form). Output and wait bounds (`limit`, `component_limit`, `timeout_ms`, `since`) clamp to the bound instead, with a requested-vs-effective notice. The shared wording lives in `src/utils/input-bounds.ts`.

### Why one normalizer reads `domains` for both probe tools

`src/utils/domain-input.ts` reads each `domains` entry as one host for both `devops_check_certs` and `devops_check_dns`. Forms with exactly one host reading (a bare name, `host:port`, a URL, an IP on certs) are normalized; everything else is an inline `error` row, so one bad entry never fails the batch. `""` stays a schema rejection (`.min(1)`), so the advertised input schema is unchanged. There is no `input` echo field: rows are positional and `domain` carries the applied host. The SSRF guard runs on the normalized host, so a URL wrapping a private or metadata address is rejected under that address. Domains longer than 253 characters, labels outside `[a-z0-9_-]{1,63}` or with a leading or trailing hyphen, and ports outside 1–65535 are invalid rows.

### Why a wire client instead of `node:dns`

On Bun, `node:dns` splits multi-string TXT records into separate records (oven-sh/bun#44692) and reports NODATA as `ENOTFOUND` on every type, so a missing record read as "the domain does not exist". On both runtimes, `timeout_ms` was a per-attempt c-ares timeout over 4 tries. Reading the RCODE and the TXT string boundaries off the wire is the only approach that is correct on both runtimes. It needs no dependency, because the SSRF-checked resolver literal is the only address the client sends to.

### Why detailed-mode component lists are capped

Component lists are unbounded upstream — a single large page publishes several hundred, and a full-stack detailed sweep runs to six figures of response bytes, most of it operational rows nobody asked about. `component_limit` (default 50) bounds it, `component_filter` reaches a specific component past the cap, and `ctx.enrich.truncated()` discloses what was dropped rather than silently returning a partial list. The disclosure is aggregated across the fan-out because `buildVendorResult()` has no `ctx`; it returns component counts and the handler emits one signal for the batch. `component_limit` clamps to 500 instead of rejecting: a larger value has one obvious reading ("as many as allowed"), so the call is served at 500 with a requested-vs-effective notice.

### Why `group` is an additive field rather than `Group / Leaf` in `name`

Statuspage components carry a group (the product or region a page files them under), and several leaves share a name across groups. An added nullable `group` field leaves `name` an exact leaf for existing callers, and `" / "` already occurs inside real component names (`Cloud App Control / Kivera` on cloudflare), so a joined `name` could not be split back. The joined form is used only where a single string is all the surface carries: the `affected_components` pre-fill of `nextToolSuggestions`, its `reason`, and `content[]` lines. Status.io and AWS fill the hierarchy this way: a Status.io component published in more than one `containers[]` entry becomes a Statuspage group (the component, `group: true`) plus one leaf per container (`name` = container name, e.g. `AWS us-east-2`; `group_id` = the component; status = the container's own `status_code`; leaf ids `<componentId>/<containerId>`, because container ids repeat across components), while a single-container component stays one flat leaf. An AWS summary component is named `<service> (<region name>, <region code>)`, with the code read from the event ARN's region field (`arn:aws:health:me-central-1::…` → `Multiple services (UAE, me-central-1)`); an ARN with no region keeps `<service> (<region name>)`, and incident names are unchanged. GCP, Azure, Azure DevOps, Slack, and FireHydrant have no group/leaf hierarchy in their data, so their `group` is always null, and `devops_get_incidents.affected_components` carries leaf names only.

### Scoped entries on a shared status page

`status.sendgrid.com` 302s to `status.twilio.com`, so the entry served Twilio's whole page (SMS, voice, carrier incidents) under SendGrid's name. Removing the slug would break every saved stack and caller using it and leave SendGrid users on a Twilio-wide indicator; scoping is exact because the summary carries every component with `group_id` and every v2 incident/maintenance record lists its components by `id`. Rule: a component is in scope when its own name or its group's name starts with the entry's `component_scope_prefix` (`SendGrid`: groups `SendGrid Mail Sending` and `SendGrid Webhooks` with 5 leaves, plus 8 ungrouped `SendGrid …` components, on 2026-10-14). Mechanics (`src/services/status-adapters/component-scope.ts`, applied in `status-dispatch.ts`):

- Summary: components, open incidents, and scheduled maintenances are kept only when they touch an in-scope component id; `page.name` = the registry name (`SendGrid`); `status` is re-derived from the scoped records: the worse of the worst open-incident impact (resolved/postmortem and impact `none`/`maintenance` don't rate) and the worst component status (`degraded_performance` → `minor`, `partial_outage` → `major`, `major_outage` → `critical`); `maintenance` when nothing rates but an in-scope window is open (a maintenance record `in_progress`/`verifying`, or an in-scope component `under_maintenance`); `none` otherwise. `status.description` uses Statuspage's own wording per indicator: none "All Systems Operational", minor "Partially Degraded Service", major "Partial System Outage", critical "Major System Outage", maintenance "Service Under Maintenance".
- Incidents and scheduled maintenances (`devops_get_incidents`) are filtered by in-scope component id. Records carry component ids and group ids but no group names, so the scoped fetch also reads the page summary (cached, shared with the status check) for its component table; the two fetches run in parallel.
- `fetchVendorIncidents` returns `upstreamCount` (records the feed returned before scoping); `devops_get_incidents` uses it for the ceiling check, so `upstreamCeiling: 50` is still disclosed when Twilio's unfiltered feed returned 50.
- `vendorHistory(vendor)` = `backendHistory(api_type)` with `historyPages: false` for a scoped entry: history-archive records list no components, so `since` reads no archive for `sendgrid`.
- Cost: `devops_get_incidents` for `sendgrid` is usually maintenance windows only — Twilio's 50-record v2 window covers about 9 days of mostly carrier incidents.

### Why the SSRF guard matches IPv6 by prefix length rather than by string

The IPv4 side of `ssrf-guard.ts` was always a bitwise CIDR table; the IPv6 side matched `normalized.startsWith(prefix)`, which fails in both directions. It under-blocks, because a range is only partly spelled by its leading characters — link-local is `fe80::/10`, spanning `fe80::`–`febf::`, so the `'fe80'` prefix left `fe90::` through `febf::` open, and multicast `ff00::/8` was absent entirely. It over-blocks, because a string prefix swallows anything that merely starts with those characters — `'::ffff:'` rejected every IPv4-mapped address including public ones, and `'::1'` reported `::1234:5678` as loopback when it is IPv4-compatible IPv6 (deprecated, RFC 4291), a different category with a different reason to be blocked.

Both halves are now the same shape: parse to the 128-bit value, match `(value & mask) === base`. `::ffff:0:0/96` is checked ahead of the table because an IPv4-mapped address is classified by the IPv4 it embeds — `::ffff:8.8.8.8` is public, `::ffff:127.0.0.1` is not — and both encodings of the embedded address parse to the same value, so the hex spelling `::ffff:7f00:1` can no longer slip past a dotted-form regex. `node:net`'s `BlockList` handles mapped addresses natively, but adopting it would leave the file with two different matchers for the same job and would not carry the per-range labels the block message names; keeping one bitwise table for both families is worth more than the dependency saved. The parser fails closed: text it cannot parse returns a label rather than `null`, so an unparsable address is blocked rather than assumed public.

### Why `degraded_components` is not capped

The cap above covers `all_components`, which is mostly operational rows. `degraded_components` is the opposite: it is the signal the tool exists to surface, so a silent slice would hide an outage, and even a disclosed cap would make the caller pay a second round trip to see a component that is already down. It stays unbounded in both modes. The volume problem is real — a large edge network routinely publishes dozens of non-operational components — but it is a presentation problem, so `renderVendorBlock()` leads with a count and a per-status breakdown (`Degraded (46): 26 partial_outage, 20 under_maintenance`), then groups the entries by status one per line instead of joining them into a single paragraph.

`under_maintenance` stays inside the array: it is a non-operational state, and removing it would change the output contract and hide in-progress windows from anyone reading only that field. It is a planned window rather than a fault, though, so it renders in its own group, marked as such and ordered last behind the real outages.

### Why the upstream history cap is disclosed, and reached past only on request

Atlassian's `/api/v2/incidents.json` returns at most 50 records and ignores `?page=`, and Slack's `/api/v2.0.0/history` behaves identically. On a busy Statuspage page 50 records is about a week. The tool used to present a full 50-record window as complete history, so a caller doing postmortem work could not tell a vendor whose incidents genuinely stop there from one whose older incidents were out of reach. `upstreamCeiling` and a `notice` state the cap whenever it binds. The tool never claims history it did not fetch.

The only surface past the cap is the page's own `/history.json?page=N` archive, and reading it is opt-in through `since`. The decisions behind that path:

- **A date floor, not a boolean or a page count.** A page past the end returns 200 with empty months, so there is no end signal: a boolean needs a hidden page cap, and a page count exposes quarter paging (page 1 is a partial quarter) as a caller concept. A floor maps to the question asked ("since last October"), fixes the page count, and gives `offset` a stable merged list. The 24-month bound keeps a call to at most ten pages (nine quarters, plus one when the page's zone puts the floor's quarter start after UTC midnight) — about 5 MB upstream on the heaviest registry page — and the walk enforces a page count derived from the floor, which no archive can extend.
- **The 24-month bound limits the archive walk, never the records kept.** The v2 maintenance list keeps completed windows for years (GitHub's reaches 2018), so clamping `since` or answering an older `until` empty withheld records the call had already fetched, and made `until` 2023-01-01 return nothing while 2025-01-01 returned 2022 windows. `since` and `until` therefore filter as sent; only the walk stops at the floor, and the notice names the date it reached.
- **Only with `all` or `resolved`.** `active` needs lifecycle stages the archive lacks, and `scheduled` is a forward-looking list that a creation-date floor would cut.
- **Floored on start (`scheduled_for`, else `created_at`) at 00:00 UTC.** A maintenance created before the floor but scheduled after it stays in range.
- **The v2 record wins, keyed on `code` across both v2 lists.** The archive carries records inside v2's own time range that neither list returns (mostly past maintenance), so a time boundary cannot dedupe; the join key can. History is read whenever `since` is set, even when v2 already reaches the floor, so the result does not depend on whether the ceiling was hit.
- **`source` on every incident.** A history record carries less (no components, no timeline), and a consumer needs to know which shape it is holding. It costs about 30 bytes a record.
- **`unknown`, not an inferred status.** A record with no end may be open, in progress, or a cancelled maintenance; the archive does not say which.
- **Per-instant offsets, not the zone label.** The label names only the span's end, so a span straddling a DST change would be an hour off on one side. Each end is converted with the offset its own instant had in the v2 `page.time_zone`.
- **Failure never degrades the v2 path.** A 404, a transport or shape failure, an unreadable timestamp, a page that does not step back exactly one quarter, more pages than the floor needs, or (under `resolved`) a failed read of the maintenance list the records are matched against ends the walk and returns the v2 result plus a `notice` naming how far history reached. Records from pages read before the failure stay; the failing page contributes nothing. The quarter-step check is what keeps a redirect that drops `?page=` from presenting page 1 as an older quarter.
- **`historyPages` is a backend-family capability.** Availability is per host (seven registry Statuspage hosts 404), so a static per-backend flag would misstate those pages; each call discloses what it found.
- **Not taken:** hydrating each record through `/api/v2/incidents/{id}.json`. It returns full fidelity even for 2016 codes, but it is equally undocumented and costs one request per record.

### Why `devops_get_incidents` has a response size budget

`limit` counts incidents, but each carries every update and component, so one page reached 210 KB (circleci, limit 50; updates are 44–96% of a vendor's payload). Each surface is held to 64,000 bytes, measured as sent — the serialized incident and the `content[]` block `format()` renders, vendor text escaped — plus a fixed 1,024-byte reserve for the paging fields and paging/budget sentences, and the notices settled before the cut (ceiling, history gap) measured in full. Why a page budget and not a count cap: bodies run to 11 KB, so the newest 5 updates still left circleci at 105 KB for 20 incidents. Why cut between whole incidents: nothing becomes unreachable — the cut incident is the next page's first. Only an incident over the budget alone is trimmed, oldest updates first, disclosed per incident (`updates_omitted`) and in the notice; `full_updates: true` returns it whole (the caller asked for that record). `affected_components` are counted, never trimmed — they are small (≤ 3.4 KB measured), they are `match`'s key, and `devops_suggest_action` takes them as input. The newest update is never dropped, so an incident whose fields, components, and newest update alone exceed the budget is the one response that can still run past it.

### Why `match` is a strict word match

`match` normalizes to lowercase words (runs of letters and digits), and every query word must appear within a word of the title or a component name. A raw substring misses reordered or punctuated names (`git-operations` vs `Git Operations`). It is named `match`, not `component`, because it matches titles too. `devops_status_check`'s `component_filter` stays a raw case-insensitive substring over component name and group.

### Why empty-result guidance is enrichment, not output

`format()` receives only the domain object, which carries no `filter`, `offset`, or backend — so a single static sentence was the most it could say, and that sentence recommended the filter the caller had just used and history from backends that publish none. Widening `output` to carry the call's parameters back into `format()` would put request echo in the domain payload of every response, including the ones that need no explanation. `ctx.enrich.notice()` is the framework's success-path channel for exactly this: it reaches `structuredContent` and the `content[]` trailer without touching the domain contract, and it is written only when there is something to say. `format()`'s empty branch is correspondingly narrowed to stating the empty result, since anything it named would contradict the trailer beside it.

Which filters the message may name is bounded by containment, not just by what the backend serves. `all` is assembled from the incident list plus the maintenance list, so `active`, `resolved`, and `scheduled` all draw from data it already covers: an empty `all` guarantees each of them is empty too, and naming one buys the caller a round trip that cannot succeed. `alternativeFilters()` offers only the disjoint filters the backend serves other than the one just used, plus `all` beside them, and an empty `all` never reaches it — it gets its own branch, stating that the vendor's feed currently lists nothing at all and pointing at its status page. The relation is one-directional: `active`, `resolved`, and `scheduled` are disjoint and subsume nothing, so an empty `active` still recommends the genuinely wider `all` and `resolved`. The nothing-published branch sits behind the offset branch, so an `all` that matched incidents but overshot them still gets the offset guidance.

### Why `nextToolSuggestions` is output, not enrichment

`devops_status_check` and `devops_watch_stack` already report the three inputs `devops_suggest_action` takes, so the hand-off is pre-filled rather than left for the caller to discover and assemble. The field lives in `output`: the framework has no next-tool primitive, enrichment fields must be optional and absent when unset (an all-clear batch returns an empty list), and a pointer rendered only in `format()` would never reach a client reading `structuredContent`. Keeping the `{ toolName, reason, args }` shape identical to `devops_suggest_action`'s means one handler serves suggestions from every tool.

### Why the DNS outcome is a typed enum rather than a message

`queryResolver()` collapsed `ENODATA`, `ENOTFOUND`, and `ESERVFAIL` into one silent "no records of this type", so a domain that does not exist, a resolver that could not answer, and a record that is genuinely absent produced byte-identical output. Those three call for different operator actions — register or fix the name, fix the zone signing or delegation, add the record — and a DNSSEC validation failure is one of the outage causes the tool most needs to name. The outcome is an enum (`status_by_type`, rolled up into `status`) rather than prose in `error` because two consumers branch on it programmatically: the disagreement classifier below needs to tell "this resolver returned nothing" from "this resolver returned something different", and an agent triaging an incident needs a stable value to key on. `nodata` stays the only silent case, since it is a valid DNS answer rather than a failure.

### Why an agreeing per-resolver record set is elided rather than repeated

Every record set was serialized once per resolver plus once at the domain level, so a domain with a large TXT set — `github.com` publishes roughly two dozen entries including a long SPF chain — was carried four times in a three-resolver call, and the tool accepts a batch of ten domains. Per-resolver records exist so a caller can see *where* resolvers disagree, but when a resolver returned exactly the domain-level values for a type, its copy carries nothing that set does not already hold, and agreement is the common case.

`elideAgreeingRecords()` drops only those exact matches and names the dropped types in `records_same_as_domain`. A divergent type keeps its full per-resolver values, so no disagreement can be hidden, and the elision runs after `findDiscrepancies()` and the flag derivation so nothing upstream reads a thinned set. This changes the output shape, deliberately: an absent field with no marker would be indistinguishable from "this resolver returned nothing", which is the one thing agreement is not. Between `records`, `records_same_as_domain`, and `status_by_type`, every requested type has exactly one explanation — its own values, the domain-level values, or the outcome that left it empty. `format()` states the agreement in words for the same reason a bare status line would read as an empty answer.

### Why geo-steering is not reported as a propagation mismatch

`findDiscrepancies()` compared resolver answers for exact equality and labelled every difference `Propagation mismatch on <type> records`, asserting an in-flight DNS change the data never established. Anycast and geo-steered domains return different addresses per resolver at steady state — a CDN-fronted hostname trips this on every call while nothing is wrong. The two cases are now separated by `kind`: `partial_resolution` (at least one resolver answered and at least one returned nothing) is the shape that actually indicates propagation lag, a broken resolver, or a partial delegation, and it is flagged; `value_variation` (every resolver answered, values differ) is recorded in `propagation_discrepancies` with its per-resolver values but deliberately not flagged, so it does not read as a fault. Neither value names a cause on its own — the tool reports what it observed and leaves the diagnosis to the reader.

### Why the domain-level flags and error span every resolver

Both were derived from a single resolver: `records` and the "no A or AAAA records found" flag came from `resolverResults[0]`, and the domain `error` took the first erroring resolver's message. A failing primary therefore reported a healthy domain as record-less, and a split outcome — one resolver NXDOMAIN, another SERVFAIL — lost exactly the divergence worth seeing. Flags are now derived from every resolver, grouped per condition and naming the resolvers and record types affected. `records` falls back to the first resolver that answered, with `records_source` naming which one, so the summary is never emptier than the data. The domain-level `error` is reserved for "could not be queried at all" — every resolver failed and none returned records — and lists each resolver's own outcome; a partial failure leaves `error` null and surfaces in `flags` instead.

### Why `chain_depth` is nullable rather than defaulted to 1

`inspectCert()` initialized depth to 1 and walked `getPeerCertificate(true).issuerCertificate`, but that link is not populated on every supported runtime — under Bun it is absent even for CA-issued chains, so an ordinary three-certificate chain collapsed to `chain_depth: 1` while the output contract documented `1` as self-signed. A consumer reading that for a major site concludes "leaf only, no intermediates", which is false. Reading the served chain another way would mean shelling out to `openssl` — a process dependency well out of proportion to one diagnostic field. So the field reports what it can actually measure: a count when the chain is traversable, `null` plus `chain_depth_unavailable_reason` when it is not. A missing number is honest; a wrong one is not. Self-signed detection is detached from depth entirely and now comes from `authorization_error`, which is populated regardless.

### Why hostname and chain trust are read as two separate signals

`inspectCert()` connects with `rejectUnauthorized: false` and overrides `checkServerIdentity` so a broken certificate can still be inspected rather than failing the connection — but the override discarded Node's hostname-validation result, letting a wrong-host certificate report `ok`. `socket.authorized` does not cover the gap: with `checkServerIdentity` overridden it is `true` even for a hostname mismatch, so it reflects chain trust only. The two are therefore read independently — `tls.checkServerIdentity(host, cert)` called explicitly inside the callback (which still returns `undefined` to keep the connection open) for hostname coverage, and `socket.authorizationError` for chain verification, which catches an untrusted root that the issuer-versus-subject heuristic cannot see. Both land at `critical`: a hostname mismatch, a self-signed leaf, and an untrusted root are all hard client-side rejections, the same tier as expiry, which is why self-signed was raised from `warning`.

### Why HSTS is read from the reply, and legacy TLS is a retry

There is no port allowlist for HSTS: the `port` input invites custom HTTPS ports, so the GET is sent on every port and HTTP is detected from the reply (it starts with `HTTP/`). Once a handshake completes, the row is graded from the certificate and session whatever the HSTS probe does, so IMAPS, SMTPS, and DNS over TLS keep their grade and report `HSTS not checked`. The legacy retry runs only after a version refusal, so modern handshakes keep their options and certificate checks (lowering `@SECLEVEL` on every connection would also relax key-size and digest checks). The runtime branch exists because Bun rejects any `@SECLEVEL` string and Node refuses TLS 1.0/1.1 without one. SNI is explicit because Node sends none from `host` alone: without it `example.com` failed the handshake, `github.com` stalled, and multi-tenant hosts served their default certificate.

### Why Google Cloud severity maps onto the indicator scale the way it does

The feed's own schema documents `severity` as "(high, medium)" while the live feed emits `low`, so the vocabulary is open and an enum that rejected an unlisted value would fail on a payload Google actually publishes. Three known values map onto four indicator slots as `low` → `minor`, `medium` → `major`, `high` → `critical`, calibrated against what the records carry: the live `medium` record is a fifteen-hour multi-product regional outage and the live `low` record is a two-hour error-rate elevation. `none` is deliberately unreachable — every record in this feed is a published incident, so none of them mean "no impact." An unrecognized severity degrades to `minor` rather than throwing or dropping the record: a published incident is at least a degradation, and losing it entirely is worse than under-rating it. `critical` is named alongside `high` so a hypothetical escalation past the documented top value is not silently downgraded to `minor` by the default branch.

### Why `maintenance` is carried end to end instead of mapped away

A Statuspage page publishes `status.indicator: "maintenance"` while a window is open. Rejecting it at the parse boundary failed the whole payload, so a healthy, reachable vendor was reported as not serving a Statuspage summary at all and sat in the `unavailable` bucket for the duration of the window. Mapping it down to `none` at the boundary would have avoided the contract change, but a page under maintenance would then read as all clear — a silent fallback over a state the vendor deliberately published. So the value travels: through `StatuspageSummaryResponseSchema`, through `VendorResultSchema.indicator`, into its own `summary.maintenance` bucket, and onto its own `computeStackHealth()` rung.

It gets a bucket of its own rather than joining `degraded` because `degraded` counts faults, and a scheduled window is not one — `degraded_components` already separates `under_maintenance` entries from genuine outages, and folding the indicator back together would undo that distinction one level up. The rollup rung sits below every outage rung and below `unknown` (an unchecked vendor is a bigger gap than a planned window) and above `all_operational`, which stays reserved for a stack with nothing open at all. The rendered icon is the 🛠️ the degraded-component list already uses, so a window reads the same wherever it appears.

Only a Statuspage page reaches this state. The native adapters synthesize an indicator by ranking incident impacts and skip maintenance records while doing it, which `StatuspageSeverityIndicator` — the narrower type they return — states in the type system rather than in a comment.

### Why `SERVICE_INFORMATION` stays in the incident stream

`status_impact` has two observed values, `SERVICE_DISRUPTION` and `SERVICE_INFORMATION`, and the second reads at first like Google's maintenance analog. It is not. The live `SERVICE_INFORMATION` record is a root-caused report of elevated Vertex Gemini API error rates with a remediation section — a past disruption of low impact, not planned work. Routing it to `scheduled_maintenances` would coerce its impact to `maintenance` and its status to `scheduled`/`in_progress`, relabelling a real incident as a planned window and hiding it from `filter: "resolved"`. Google Cloud publishes no maintenance feed of any kind, so `scheduled_maintenances` is always empty for this backend and `backendHistory()` declares `scheduledMaintenance: false`; `devops_get_incidents` says so when `filter: "scheduled"` comes back empty. Severity, not `status_impact`, carries the impact signal.

### Why every Azure item is a fixed `minor`, with no summary components

The Azure feed carries no severity, lifecycle, or resolution field. Reading severity out of the description prose would be a guess dressed as data, so nothing is read from it: each listed item is impact `minor` and status `investigating`, and the indicator is `minor` while any item is listed and `none` otherwise. `minor` is a floor, not an estimate — Microsoft posts to this feed only for service issues with broad impact or ones its targeted notifications cannot reach, so a listed item is at least a degradation, the same floor every other adapter applies to an event of unknown severity. Because nothing ever reads `resolved`, `backendHistory('azure')` declares `resolved: 'none'`; `current` would offer `filter: "resolved"` as an alternative that can never return anything.

The categories stay on the item's single update as `affected_components`, verbatim and undifferentiated, and the summary carries no components. One item's categories mix services and regions and have run to 41 regions plus a service; as summary components they would fill `degraded_components` and the `devops_suggest_action` suggestion's `affected_components` with every region as if each were a separately degraded component. This matches the Slack adapter, which likewise has no component table and attaches services to the latest update.

### Why Azure DevOps reads two sources, and how its health maps

The health endpoint is the documented, versioned summary but has no incident list, so with it alone `devops_get_incidents` would always be empty and no incident title would reach `nextToolSuggestions`. The RSS feed is linked from Microsoft's own status documentation and carries titles, lifecycle state, geographies, and the full update timeline. The status page's embedded `liveSiteEvents` data provider and `_history` view carry more (severity, per-service impact) but are undocumented HTML. Components are cells named `<service> (<geography>)` (the AWS adapter's `service (region)` form) so the repeated geography names never appear bare; a per-service rollup would hide which geography is affected. `unhealthy` caps at `major`, not `critical`, because every cell is one service in one geography. `advisory` maps to `minor`, not `maintenance`: the live advisory reads "Service maintenance is in effect" while the one Active item behind it is a latency fault, and `maintenance` would file a live degradation as a planned window. `unknown` → `minor` follows this server's convention for unknown upstream values. Fixed `minor` impact mirrors the `azure` adapter (no severity in the feed). The RSS extractor is shared with the `azure` adapter (`rss-extract.ts`) rather than duplicated or replaced by an XML dependency.

### Why only HTML element tags are markup in update bodies

Status bodies carry `<` as ordinary text — "(<1%)", "<30min", unfilled template placeholders, autolinks. The Azure converter this replaces treated every `<` as markup and removed a leftover `<` (introduced to stop `<scr<b>ipt>` reassembling into a tag), which turned GitHub's "(<1%)" into "(1%)", inverting its meaning, and erased placeholders such as `<FUNCTIONALITY IMPACTED>`. Only tags named for an HTML element are markup now, and the conversion is a single pass, so `<scr<b>ipt>` leaves the text `<script>` — it is never parsed again, and `format()` escapes its `<` where it is rendered. Unfilled placeholders are kept deliberately: Atlassian's own page drops them and reads "an issue with  that is impacting", while the kept text tells the reader the vendor left the template unfilled.

### Why vendor text is escaped in `format()`, not in `structuredContent`

`structuredContent` keeps vendor strings as the vendor wrote them (after HTML-to-text normalization), so a client reading it gets the real text. `content[]` is rendered markdown, where vendor text could open a heading (a DigitalOcean postmortem's `## 2. Impact` used to appear as a top-level heading), a list item, or an HTML block, so escaping and containment happen at the render boundary only. Bodies are quoted rather than indented because an ATX heading may carry up to three spaces of indent and still interrupt a paragraph; every-line `>` contains it. Markdown punctuation beyond `<` and `&` is left alone so markdown bodies keep rendering usefully.

### Why a resolved AWS event is history, not current health

The AWS Health feed keeps an event listed for hours after it resolves, with event `status` `"0"` and a summary prefixed `[RESOLVED]`. In the archived captures every status-`0` event carries that prefix and no prefixed event carries another status, so `"0"` is read as resolution, not as an informational severity. Such an event maps to a resolved incident — `resolved_at` from its newest `event_log` entry, impact the highest its `event_log` reached — and stays out of the summary's components, incidents, indicator, and open-event count, so `devops_status_check` never reports a finished event as a degraded component or feeds it into a `devops_suggest_action` suggestion. Because resolved events are served only while listed, `backendHistory('aws')` declares `resolved: 'current'`.

### Instruction tool vs. LLM sampling

`devops_suggest_action` could use `ctx.sample` to ask the client's LLM for dynamic guidance. The risk: non-deterministic output, client dependency, potential latency. The value proposition of this tool is predictable, category-specific playbooks — "Cloudflare CDN is down, here are the known mitigation patterns." Static playbook dispatch by vendor category is deterministic, fast, and works in all clients. If `ctx.sample` is present and the vendor/incident is complex, the handler can optionally enrich the response — but the base path is always static.

### Caching strategy

Statuspage APIs are designed for polling (vendors use them for their own dashboards). 60s TTL is conservative — the official Statuspage dashboard polls more frequently. The TTL is configurable via `DEVOPS_STATUS_CACHE_TTL_MS` for users who want fresher data. Cache is in-memory (not `ctx.state`) because it's shared across all tenants — Statuspage data is public and identical for everyone. Cache key: the WHATWG-normalized endpoint URL, so spellings of one URL share an entry. A byte budget, not an entry count, bounds the cache (entries range from under 1 KB to about 1 MB). Eviction is oldest-first, not LRU, because every entry shares one TTL, so the oldest entry is also the next to expire.

---

## Known Limitations

- **Non-Statuspage vendors:** Many major vendors do NOT use Atlassian Statuspage. AWS (health.aws.amazon.com), Google Cloud (status.cloud.google.com), Azure (azure.status.microsoft, RSS), Azure DevOps (status.dev.azure.com, health API + RSS), GitLab and Neon (Status.io), Slack (own status API), and Redis Cloud (FireHydrant) are served by native adapters in `src/services/status-adapters/`. Hetzner (status.hetzner.com), Railway (custom), Fastly (access-restricted), PagerDuty (custom endpoint), Okta (auth-gated), Docker Hub (custom), and CockroachDB (unreachable) have no adapter and are excluded from the built-in registry. Users can attempt raw URL passthrough for any that may use Statuspage under a different subdomain, but the server makes no guarantees.
- **Upstream history ceilings:** Atlassian Statuspage and Slack both serve at most 50 incident records per fetch with no working pagination parameter, so `devops_get_incidents` cannot reach older incidents for those backends at any `offset`. It discloses the ceiling (`upstreamCeiling` + `notice`) when a call hits it rather than presenting the window as complete history. On Statuspage, `since` reads the page's history archive back up to 24 months; the archive is undocumented, is not served by every page, and its records are thinner than v2 (no components or update timeline, minute-precision times). Slack has no archive, so its older incidents remain on its own status page. AWS Health, Azure, Status.io, and FireHydrant have no such ceiling — see the backend history table under `devops_get_incidents`. Google Cloud and Azure DevOps have no record ceiling either, but their feeds are rolling recent windows: older incidents fall out of them by age, which no per-call count reveals, so nothing is disclosed and they remain reachable only on the vendor's own page. An entry scoped to part of a shared Statuspage page (`sendgrid`) reads no history archive, and its ceiling disclosure counts the page's unfiltered feed.
- **Azure DevOps degraded, unhealthy, and unknown cells are unobserved:** every archived health capture is all-`healthy`, so those mappings come from the documented `ScopeHealth` enum, not from a live degraded response.
- **Vendor text conversion:** named character references decode only for `lt`, `gt`, `amp`, `quot`, `apos`, and `nbsp` (plus every numeric reference); any other named reference in a vendor body stays as its literal text. Converted bodies flatten nested lists to one level, and the text inside `<script>`/`<style>` elements is kept as text (no vendor body has carried either).
- **Azure status carries no severity or lifecycle:** every listed Azure item reads as an open `minor` incident, whatever its prose says, and its resolved history is not retrievable — a resolved item leaves the feed. The feed is empty whenever nothing is posted, so the adapter's mapping could only be verified against archived captures, not a live populated feed.
- **Vendor self-reporting:** Statuspage data is vendor-published. Vendors may lag incident acknowledgment. `devops_check_certs` and `devops_check_dns` provide ground-truth checks that complement self-reported status.
- **TLS inspection from server host:** `devops_check_certs` connects from wherever the MCP server runs. If the server is hosted, cert checks reflect connectivity from that host — a cert served correctly to the host may still be broken in a specific region. For complete coverage, run the server locally.
- **DNS propagation scope:** `devops_check_dns` queries three public resolvers. Propagation completeness across all global resolvers requires a larger resolver set or a dedicated propagation service.
- **Certificate chain depth:** `chain_depth` depends on `getPeerCertificate(true).issuerCertificate`, which the Bun runtime does not populate for a real handshake. On Bun the field is `null` with a reason rather than a count; chain validity is still reported in full via `authorization_error`.
- **`ctx.state` scope:** Stack configuration persisted by `devops_watch_stack` is tenant-scoped (one tenant per stdio process; per token `tid` on HTTP with `jwt`/`oauth`). On HTTP with `MCP_AUTH_MODE=none` every caller runs as tenant `default`, so the tool reads and writes no state there. Stack configurations do not persist across server restarts in the default memory storage backend.
