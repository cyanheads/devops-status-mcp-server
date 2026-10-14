<div align="center">
  <h1>@cyanheads/devops-status-mcp-server</h1>
  <p><b>Check vendor status pages, inspect SSL/TLS certificates, verify DNS propagation, and get incident-response playbooks via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.10.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/devops-status-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.3.1-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/devops-status-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/devops-status-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.3-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/devops-status-mcp-server/releases/latest/download/devops-status-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=devops-status-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZGV2b3BzLXN0YXR1cy1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22devops-status-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fdevops-status-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://devops-status.caseyjhand.com/mcp](https://devops-status.caseyjhand.com/mcp)

</div>

---

## Overview

Vendor status pages, SSL/TLS certificates, and DNS propagation — normalized across Atlassian Statuspage, Status.io, Slack, AWS Health, Google Cloud Service Health, Azure status, Azure DevOps status, and Firehydrant backends, plus direct TLS/DNS checks for any domain. List and check 53 built-in vendors, fetch incident timelines, watch a saved stack (saved per authenticated caller or local process), and get a tailored incident-response playbook, all without API keys. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:-----|:------------|
| `devops_list_vendors` | List vendors in the built-in registry, optionally filtered by name or category. Returns slug, display name, category, and status page URL. |
| `devops_status_check` | Check the current health status for one or more vendors. Returns per-vendor indicator (`none` / `minor` / `major` / `critical` / `maintenance`), degraded components, and active incident summaries. |
| `devops_get_incidents` | Fetch incident history for a vendor — active, resolved, or scheduled maintenance. Returns the full incident timeline with per-update bodies and affected components. |
| `devops_watch_stack` | Check the health of a named vendor stack. Where the server identifies the caller (stdio, or HTTP with `jwt`/`oauth` auth), pass `vendors` once to save the list and later calls reuse it; on HTTP with `MCP_AUTH_MODE=none` nothing is saved and `vendors` is required on every call. Returns an aggregate health rollup plus per-vendor detail. |
| `devops_check_certs` | Inspect SSL/TLS certificate health for one or more domains via a real TLS handshake. Reports expiry, chain depth, protocol version, cipher suite, and HSTS presence on HTTP ports. Pure TypeScript — no external API. |
| `devops_check_dns` | Resolve DNS records and verify propagation for one or more domains across Google (8.8.8.8), Cloudflare (1.1.1.1), and Quad9 (9.9.9.9). Reports per-resolver latency and resolver discrepancies. Pure TypeScript — no external API. |
| `devops_suggest_action` | Instruction tool — returns a tailored incident-response playbook and pre-filled follow-up tool calls given a vendor name and optional incident context. No external calls; fully deterministic. |

### Resources

| Resource | Description |
|:-----|:------------|
| `devops-status://vendors/{name}` | Full registry entry for a vendor by slug — status page URL, category, and API type. |

All resource data is also reachable via tools. Tool-only agents are fully supported.

---

## Capability reference

### `devops_list_vendors` <sub>tool</sub>

- Accepts an optional free-text `query` (matches name and slug, case-insensitive, surrounding whitespace ignored) and an optional `category` filter — eight categories: `cloud`, `cdn-edge`, `dev-platform`, `data`, `comms`, `auth`, `monitoring`, `ai`
- Returns slug (what to pass to other tools), display name, category, and status page URL
- An empty result carries a `notice` naming the query (and category) that missed: matches outside the requested category are listed by slug, otherwise it points to browsing the full registry or passing a Statuspage base URL to the status tools
- 53 built-in entries, most on Atlassian Statuspage; `aws`, `gcp`, `azure`, `azure-devops`, `gitlab`, `neon`, `slack`, and `redis-cloud` route through native-API adapters normalized to the same shape
- `azure` reads Microsoft's Azure status RSS feed, which carries no severity or lifecycle: each posted item is an open `minor` incident with its services and regions as affected components, and the feed is empty while nothing is posted
- `azure-devops` reads the Azure DevOps health API and status RSS feed: one component per service and geography (`<service> (<geography>)`, e.g. `Core services (Australia)`), the overall health as the indicator (never `critical`), and one incident per feed event, resolved ones included
- `sendgrid` reads Twilio's status page (`status.sendgrid.com` redirects there) and reports only SendGrid's components, incidents, and maintenance windows on it
- Statuspage-compatible pages not in the registry are still reachable by passing a raw base URL to other tools

Built-in vendor registry:

| Category | Vendors |
|:---------|:--------|
| `cloud` | digitalocean, linode, aws, gcp, azure |
| `cdn-edge` | cloudflare, akamai |
| `dev-platform` | gitlab, github, azure-devops, npm, vercel, netlify, render, fly-io, circleci, travis-ci, snyk, atlassian, figma, launchdarkly |
| `data` | mongodb-atlas, planetscale, supabase, neon, redis-cloud, elastic, influxdb, upstash, cloudinary, segment |
| `comms` | slack, discord, twilio, sendgrid, mailgun, hubspot, brevo, courier, loops |
| `auth` | auth0, clerk, workos |
| `monitoring` | datadog, sentry, new-relic, grafana-cloud, honeycomb |
| `ai` | openai, anthropic, elevenlabs, pinecone, cohere |

---

### `devops_status_check` <sub>tool</sub>

- Accepts registered vendor slugs (e.g., `github`, `aws`) or raw Atlassian Statuspage base URLs, mixed freely — up to 20 are checked per call, in input order; entries past the 20th come back unchecked, verbatim, in `deferred_vendors` (`[]` when nothing was deferred) with a `notice` saying to resend them. More than 100 entries is rejected (`invalid_arguments`). `summary` counts only the checked vendors
- `mode: "summary"` (default): indicator + degraded components + active incidents; `mode: "detailed"` adds the full component list (capped at `component_limit`, default 50, minimum 1; a value above 500 is clamped to 500 and `notice` gives the requested and effective values) and scheduled maintenance windows
- Each degraded or listed component carries `group` (the product or region the status page files it under, or null), and `component_filter` matches component or group names; a filter that matches nothing for a vendor is called out in `notice`. Status.io multi-region components are listed per region, and AWS components carry the region code (`Multiple services (UAE, me-central-1)`)
- `Promise.allSettled` fan-out — one failing vendor never blocks the rest; failures surface as a per-vendor `error` field
- Results served from a 60-second in-memory cache, bounded in size, with spellings of one URL sharing an entry; `cached: true` on each result
- `summary` partitions the batch into `operational` / `degraded` / `down` / `maintenance` / `unavailable` counts
- `nextToolSuggestions` carries one pre-filled `devops_suggest_action` call per vendor with an active problem — indicator `minor`/`major`/`critical`, or an open incident of that impact — with the vendor slug (or normalized URL), indicator, affected components (written `Group / Leaf` for grouped components), and latest incident title filled in; a vendor that could not be checked never gets one, so the list is empty when no checked vendor has a problem

---

### `devops_get_incidents` <sub>tool</sub>

- `filter`: `all` (default, incidents + scheduled maintenances), `active` (investigating/identified/monitoring), `resolved` (fully resolved), or `scheduled` (maintenance windows only)
- Returns per-update bodies as plain text in chronological order, affected component names, duration in minutes for resolved incidents, and a direct shortlink to the incident page
- `limit` (default 20; a value over 50 is served as 50 and the notice says so) with `offset` for paging; a truncated result discloses the total and the next `offset` to fetch
- Some vendor feeds cap their own history (`upstreamCeiling`). Atlassian Statuspage's API stops at the newest 50 incidents, which on a busy page is about a week
- `since` (`YYYY-MM-DD`, with `filter: "all"` or `"resolved"`) leaves out incidents that started before that date. On Statuspage vendors it also reads the status page's quarterly history archive back to that date, reaching past the 50-record ceiling — except on a vendor that covers only part of a shared status page (`sendgrid`, scoped to SendGrid's components on Twilio's page), since archive records carry no components to scope by. The archive is read back 24 months at most: an earlier `since` still filters by the date sent, so older records the status API returns (such as completed maintenance windows) are kept, and the `notice` gives the date the archive was read back to
- `until` (`YYYY-MM-DD`, UTC, the whole day) is the latest start date to include. It mirrors `since`: blank is unset, `filter: "all"` or `"resolved"` only, and it must be on or after `since` (equal returns that one day), compared as sent. Any `until` filters what was read, however far back. `until` alone reads no history archive — set `since` as well to reach past the status API
- `match` takes words matched against each incident's title and its `affected_components` names, ignoring case and punctuation (`git-operations` reads as `git operations`). An incident is kept when every word appears, as all or part of a word, in its title or in one of its component names — each word can come from a different one. History-archive records, and vendors that publish no components (e.g. `openai`, `supabase`), match on title alone. Up to 200 characters; a value with no letter or digit fails schema validation; blank is unset
- `match`, `since`, and `until` apply before `limit`/`offset`, so `totalCount`, `nextOffset`, and the offset-past-end guidance count only the narrowed set
- Each response is held to 64,000 bytes per surface (serialized `structuredContent`, and the `content[]` text). A page ends between whole incidents when the next would cross it — disclosed on the paging fields (`truncated: true`, `shown` below `cap`, `nextOffset` = `offset` + `shown`) plus a `notice`. The first incident always returns. An incident over the budget on its own returns alone with its oldest updates left out (the newest kept) and carries `updates_omitted`; `full_updates: true` (default `false`) turns that trim off — pair it with `limit: 1` at the offset the notice names. `affected_components` count toward the budget but are never trimmed
- Every incident carries `source`: `api` for the status API, or `history` for an archive record, which has the title, impact, start and end times, and final update message but no components or update timeline. When a record is in both, the API version is kept
- If the archive can't be read (the page doesn't publish one, it times out, or it comes back in an unexpected shape), the call still returns the status API result, with a `notice` saying how far history reached
- AWS keeps a resolved event listed for hours after it ends, so `filter: "resolved"` returns only those still listed; Azure's feed lists open items only, so `filter: "resolved"` is always empty for it; AWS, Azure, Azure DevOps, Google Cloud, and Slack publish no maintenance windows, so `filter: "scheduled"` is always empty for them
- Errors: `invalid_since` (`since` with `filter: "active"` or `"scheduled"`) and `invalid_until` (`until` with `filter: "active"` or `"scheduled"`, or earlier than `since`) are raised before any request

---

### `devops_watch_stack` <sub>tool</sub>

- On the first call, provide `vendors` to define the stack — it is saved under `stack_name` in tenant-scoped state (`ctx.state`) on stdio, and on HTTP with `MCP_AUTH_MODE=jwt|oauth` (tenant from the token's `tid` claim)
- Where the stack was saved, subsequent calls can omit `vendors`; the saved list is reused automatically
- On HTTP with `MCP_AUTH_MODE=none` (callers not authenticated, all on one tenant), stacks are never saved or read: a call with `vendors` runs the sweep and returns `stack_persisted: false` plus a `persistence_notice`; a call without `vendors` fails with `vendors_required`
- Up to 20 vendors per stack. Where the stack is saved, passing more than 20 `vendors` is rejected with `stack_too_large` and nothing is saved (an existing saved stack is untouched). Where stacks are not saved, the call is a read: the first 20 are checked and the rest return in `deferred_vendors` with a `notice`. More than 100 entries is rejected everywhere
- A saved stack holding more than 20 vendors (possible on a persistent storage backend from before this cap) sweeps its first 20 and returns the rest in `deferred_vendors`; the notice says to save them under several stack names of at most 20 each
- `component_limit` clamps above 500, same as `devops_status_check`
- Multiple stacks coexist via distinct `stack_name` values (e.g., `"production"`, `"data-layer"`) — letters, digits, hyphens, and underscores, optionally separated by single dots or slashes, 1-64 characters
- Aggregate `health` rollup: `all_operational` / `maintenance` (a vendor in a scheduled window, nothing worse open) / `degraded` / `partial_outage` / `major_outage` / `unknown` (a vendor could not be reached) — never `all_operational` when any vendor errored or is in a window
- `nextToolSuggestions` pre-fills a `devops_suggest_action` call for each vendor with an active problem, same as `devops_status_check`
- Note: with the default `in-memory` storage provider, saved stacks do not survive a server restart

---

### `devops_check_certs` <sub>tool</sub>

- Accepts hostnames, IP addresses, `host:port`, or URLs — each entry is reduced to one host (IDNA ASCII for Unicode names), and a port written on the entry overrides `port` for that entry. The first 10 entries are inspected; up to 100 are accepted, and the rest come back verbatim in `deferred_domains` to resend. An entry with no single host gets its own `error` row without failing the call
- Reports: days to expiry (flagged `warning` at < 30 days, `critical` at < 7), certificate subject and SANs, issuer common name, chain depth, negotiated TLS version (flags 1.0 and 1.1 as insecure), cipher suite
- Servers that only offer TLS 1.0/1.1 are retried once with legacy versions enabled (inside the same timeout) and graded `critical`; SNI is sent for every hostname
- HSTS detection: sends a minimal HTTP/1.1 GET over the same TLS socket and reads `Strict-Transport-Security` when the reply is HTTP. Non-HTTP TLS ports (IMAPS, SMTPS, DNS over TLS) keep their certificate grade and report `HSTS not checked — no HTTP response on port <port>`
- A failed issuance or renewal points to `devops_check_dns` with `record_types: ["CAA"]` to see which certificate authorities the domain allows
- `status: "critical"` distinguishes a hostname mismatch (`hostname_verification_error`) from an untrusted chain (`authorization_error`) — both would be rejected by ordinary clients
- Per-domain failures are reported inline (`status: "error"`, reason in `error`) rather than throwing — useful partial results when checking multiple domains. `flags` is empty unless a handshake completed; a server that completes one without presenting a certificate still reports its TLS session
- Configurable default port (443; a port on the entry wins) and one timeout per domain covering the handshake, the legacy retry, and the HSTS read; `timeout_ms` over 15000 is served as 15000

---

### `devops_check_dns` <sub>tool</sub>

- Queries Google (8.8.8.8), Cloudflare (1.1.1.1), and Quad9 (9.9.9.9) in parallel per domain
- Queries each resolver over the DNS wire protocol (UDP with EDNS0, TCP retry on truncation); `nxdomain` / `nodata` / `servfail` / `refused` come from the resolver's response code, and multi-string TXT records stay whole
- Accepts domain names, URLs, or `host:port` — each entry is reduced to one name (IDNA ASCII for Unicode names; trailing dots and `_` labels kept). IP addresses and other non-names get their own `error` row without failing the call
- Supported record types: A, AAAA, CNAME, MX, TXT, NS, CAA, SOA (defaults to A, AAAA, MX, TXT); a type listed more than once is queried once
- CAA shows which certificate authorities may issue for the exact name, and SOA compares zone serials across resolvers. A serial difference only means "not yet everywhere" when the resolvers report the same primary nameserver
- Reports per-resolver latency, propagation discrepancies, and human-readable flags
- Discrepancies are typed: `partial_resolution` (some resolvers answered, others didn't) signals a real problem; `value_variation` (all answered, different values) is normal for anycast/geo-steered domains
- Custom resolver list supported — pass public resolver IP literals to test resolver-specific behavior (private and loopback resolvers need `DEVOPS_STATUS_ALLOW_PRIVATE_TARGETS=true`; a hostname is rejected even with it); an empty `resolvers` or `record_types` array uses the defaults
- A resolver listed more than once (same address and port, however written) is queried once. The first 5 distinct resolvers are queried and the rest come back in `deferred_resolvers`; up to 20 entries are accepted
- The first 10 domains are queried; up to 100 are accepted, and the rest come back in `deferred_domains` to resend
- `timeout_ms` bounds each domain+resolver pair, TCP retry included; a value over 10000 is served as 10000

---

### `devops_suggest_action` <sub>tool</sub>

- Category-tailored markdown playbook (cloud, CDN, dev-platform, data, comms, auth, monitoring, AI); falls back to generic guidance for unrecognized vendors
- Accepts a vendor slug or display name, resolved to the canonical slug so pre-filled follow-up arguments stay valid
- A vendor that matches no registry entry and isn't an `http(s)://` URL gets `devops_list_vendors` with `{ query: "<vendor, trimmed>" }` as its first follow-up instead of a `devops_get_incidents` call that would fail; a raw URL keeps the URL-filled `devops_get_incidents` call
- Optional `incident_summary` / `affected_components` prepend a targeted subsystem section (e.g. GitHub `Actions` → CI/CD steps, Cloudflare `DNS` → DNS/TTL guidance); optional `vendor_indicator` leads with severity-tailored urgency framing
- `nextToolSuggestions` pre-fills follow-up tool calls, including cert/DNS checks when `your_domain` is given — execute in sequence
- When `DEVOPS_STATUS_DISABLE_ACTIVE_PROBES=true`, guidance swaps the unregistered probe tools for equivalent manual commands (`dig`, `openssl s_client`)

---

### `devops-status://vendors/{name}` <sub>resource</sub>

- Returns the full registry entry for a vendor slug — status page URL, category, and API type (`statuspage`, `statusio`, `slack`, `aws`, `gcp`, `azure`, `azure-devops`, `firehydrant`), plus `component_scope_prefix` when the vendor covers only part of a shared status page (today only `sendgrid`, prefix `SendGrid`)
- Cached publicly for 1 hour — the registry is compiled in and identical for every caller
- Same data is reachable via `devops_list_vendors` — tool-only agents are fully supported

---

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

DevOps-status-specific:

- **No API keys required** — every status backend is a public API; TLS and DNS use the Node.js standard library (`node:tls`; DNS over `node:dgram` / `node:net`)
- 53-vendor built-in registry covering cloud, CDN, dev-platform, data, comms, auth, monitoring, and AI categories; adapter layer normalizes Status.io, Slack, AWS Health, Google Cloud Service Health, Azure status, Azure DevOps status, and Firehydrant backends into the Statuspage shapes; extendable via raw Statuspage URL passthrough
- Vendor update bodies arrive as plain text: HTML the vendor published is converted, and `content[]` quotes and escapes vendor-authored text — and DNS record values and certificate names — so it reads as data, never as markup
- 60-second in-memory cache on status reads shared across all tenants — prevents thundering-herd on batch calls; keyed by the normalized URL and held under a fixed total size, oldest entries evicted first; every upstream response body is read under a size limit
- `devops_watch_stack` persists named vendor lists in tenant-scoped state for repeat morning checks or pre-deploy sweeps, where callers are identified (stdio, or HTTP with jwt/oauth auth)
- `devops_suggest_action` dispatches category-specific playbooks deterministically — no LLM sampling dependency, works in all clients

Agent-friendly output:

- Batch tools (`devops_status_check`, `devops_watch_stack`, `devops_check_certs`, `devops_check_dns`) use `Promise.allSettled` — one failing target never blocks the rest; errors surface as inline `error` fields
- `cached: true` / `checked_at` on every status result — agents know when data was fetched
- Discriminated indicator and status enums (`none` / `minor` / `major` / `critical` / `maintenance`; `operational` / `degraded_performance` / `partial_outage` / `major_outage` / `under_maintenance`) — callers branch on data, not string parsing
- `nextToolSuggestions` in `devops_suggest_action` pre-fills tool arguments from incident context — agents can execute the playbook mechanically

---

## Getting started

### Public Hosted Instance

A public instance is available at `https://devops-status.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "devops-status-mcp-server": {
      "type": "streamable-http",
      "url": "https://devops-status.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

No API key required. Add the following to your MCP client configuration file:

```json
{
  "mcpServers": {
    "devops-status-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/devops-status-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "devops-status-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/devops-status-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "devops-status-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "ghcr.io/cyanheads/devops-status-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- No API keys or external accounts required.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/devops-status-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd devops-status-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env if you want to override defaults
```

---

## Configuration

No API keys required. All environment variables are optional.

| Variable | Description | Default |
|:---------|:------------|:--------|
| `DEVOPS_STATUS_CACHE_TTL_MS` | In-memory cache TTL for vendor status reads (all backends) in milliseconds. | `60000` |
| `DEVOPS_STATUS_FETCH_TIMEOUT_MS` | Per-request timeout for vendor status API calls (all backends) in milliseconds. | `8000` |
| `DEVOPS_STATUS_CERT_TIMEOUT_MS` | Default `timeout_ms` for `devops_check_certs`: one deadline per domain covering the connection, the handshake, any legacy-TLS retry, and the HSTS read (milliseconds, integer 1000–15000). A caller-passed `timeout_ms` overrides it. | `5000` |
| `DEVOPS_STATUS_DNS_TIMEOUT_MS` | Default `timeout_ms` for `devops_check_dns`: one deadline per domain+resolver pair covering every record type and the TCP retry (milliseconds, integer 1000–10000). A caller-passed `timeout_ms` overrides it. | `3000` |
| `DEVOPS_STATUS_ALLOW_PRIVATE_TARGETS` | When `true`, disables SSRF guards for user-supplied URLs and domains. For trusted local/intranet deployments only. | `false` |
| `DEVOPS_STATUS_DISABLE_ACTIVE_PROBES` | When `true`, omits the arbitrary-target probe tools (`devops_check_dns`, `devops_check_certs`) from the registered tool surface; the five vendor-registry/incident tools remain. For shared/public multi-tenant instances. | `false` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_SESSION_MODE` | HTTP session handling: `stateless`, `stateful`, or `auto`. The server declares `stateless` in source — it holds no per-session state — so setting this is only needed to override that. | `stateless` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

An invalid value of any `DEVOPS_STATUS_*` variable (including a timeout outside its range) stops startup with the framework's `Configuration error — server failed to start` banner naming the variable, exit 1. The stack trace is printed only with `DEBUG=true`.

See [`.env.example`](./.env.example) for the full list of optional overrides.

---

## Running the server

### Local development

- **Build and run:**

  ```sh
  bun run rebuild
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t devops-status-mcp-server .
docker run --rm -p 3010:3010 devops-status-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/devops-status-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

---

## Project structure

| Path | Purpose |
|:-----|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools, resources, and inits services. |
| `src/config/` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools/` | Tool definitions (`*.tool.ts`). |
| `src/mcp-server/resources/` | Resource definitions (`*.resource.ts`). |
| `src/services/cert/` | `node:tls` — TLS handshake, X.509 parsing, expiry and protocol flagging, legacy-TLS retry, HSTS read. |
| `src/services/dns/` | DNS wire client (`node:dgram` / `node:net`): message encoding and bounds-checked decoding, UDP with TCP retry; multi-resolver fan-out and propagation discrepancy detection. |
| `src/services/statuspage/` | Statuspage public API client (reads through the shared cache in `src/utils/cached-fetch.ts`). |
| `src/services/status-adapters/` | Native-API adapters (Status.io, Slack, AWS Health, Google Cloud Service Health, Azure status, Azure DevOps status, Firehydrant), the shared RSS extractor, + `api_type` dispatch, normalizing into the Statuspage shapes. |
| `src/services/vendor-registry/` | In-memory vendor registry loaded from `src/data/vendor-registry.ts`. |
| `src/data/` | Static vendor registry data file (`vendor-registry.ts`). |
| `src/utils/` | Shared helpers — response cache and fetch, SSRF guard, domain-entry normalizer, HTML-to-text, vendor-text markdown escaping, input-bound notices, word matching. |
| `tests/` | Vitest tests mirroring `src/`. |

---

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources via the barrels in `src/mcp-server/*/definitions/index.ts`
- `devops_check_certs` and `devops_check_dns` use only Node.js stdlib — add no external deps for these paths

---

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

---

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
