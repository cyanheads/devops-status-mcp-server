<div align="center">
  <h1>@cyanheads/devops-status-mcp-server</h1>
  <p><b>Check vendor status pages, inspect SSL/TLS certificates, verify DNS propagation, and get incident-response playbooks via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.11.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/devops-status-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/devops-status-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/devops-status-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

Status pages for 71 vendors — AWS, Google Cloud, Azure, Slack, and more — in one normalized format. Check who's down, pull incident timelines, watch your stack, and get an incident-response playbook. Plus TLS certificate and DNS checks for any domain. No API keys required.

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

- Optional free-text `query` (name and slug, case-insensitive) and optional `category`: `cloud`, `cdn-edge`, `dev-platform`, `data`, `comms`, `auth`, `monitoring`, `ai`
- Returns slug (what to pass to other tools), display name, category, and status page URL; an empty result carries a `notice` naming what missed
- 71 built-in entries, most on Atlassian Statuspage; `aws`, `gcp`, `azure`, `azure-devops`, `gitlab`, `neon`, `slack`, `redis-cloud`, and the nine Datadog site entries (`datadog` for US1, `datadog-us3`, `datadog-us5`, `datadog-eu1`, `datadog-uk1`, `datadog-ap1`, `datadog-ap2`, `datadog-us1-fed`, `datadog-us2-fed`) use native-API adapters. Statuspage-compatible pages not in the registry work by passing a raw base URL to other tools
- These Atlassian products have their own entry (`jira`, `confluence`, `bitbucket`, `jira-service-management`, `atlassian-compass`, `atlassian-developer`, `trello`, `opsgenie`, `atlassian-statuspage`, `atlassian-guard`). `atlassian` reads the umbrella page, which publishes no components and only cross-product incidents; any tool serving it says so in `notice` and names those slugs

Built-in vendor registry:

| Category | Vendors |
|:---------|:--------|
| `cloud` | digitalocean, linode, aws, gcp, azure |
| `cdn-edge` | cloudflare, akamai |
| `dev-platform` | gitlab, github, azure-devops, npm, vercel, netlify, render, fly-io, circleci, travis-ci, snyk, atlassian, jira, confluence, bitbucket, jira-service-management, atlassian-compass, atlassian-developer, trello, figma, launchdarkly |
| `data` | mongodb-atlas, planetscale, supabase, neon, redis-cloud, elastic, influxdb, upstash, cloudinary, segment |
| `comms` | slack, discord, twilio, sendgrid, mailgun, hubspot, brevo, courier, loops |
| `auth` | auth0, clerk, workos, atlassian-guard |
| `monitoring` | datadog, datadog-us3, datadog-us5, datadog-eu1, datadog-uk1, datadog-ap1, datadog-ap2, datadog-us1-fed, datadog-us2-fed, sentry, new-relic, grafana-cloud, honeycomb, opsgenie, atlassian-statuspage |
| `ai` | openai, anthropic, elevenlabs, pinecone, cohere |

---

### `devops_status_check` <sub>tool</sub>

- Accepts vendor slugs (e.g., `github`, `aws`) or raw Atlassian Statuspage base URLs, mixed freely. Up to 20 are checked per call; the rest come back in `deferred_vendors` with a `notice` to resend them. More than 100 entries is rejected (`invalid_arguments`)
- `mode: "summary"` (default) returns the indicator, degraded components, and active incidents; `mode: "detailed"` adds the full component list (`component_limit`, default 50, clamped to 500) and scheduled maintenance windows. `component_filter` matches component or group names
- A list longer than `component_limit` pages: each capped vendor returns `next_component_offset`, which you pass back as `component_offset` (applied after `component_filter`). `degraded_components` and `active_incidents` are complete on every page
- One failing vendor never blocks the rest (per-vendor `error` field). Results are cached for 60 seconds (`cached: true`), and `summary` counts `operational` / `degraded` / `down` / `maintenance` / `unavailable`
- `indicator` is the vendor's own rating, and a Statuspage page can keep it at `none` while an incident it rated `minor` or worse is open. `summary` counts each vendor at the worse of the two; incidents rated `none` or `maintenance` and scheduled windows never count as an outage
- `nextToolSuggestions` pre-fills a `devops_suggest_action` call for each vendor with an active problem — the vendors counted `degraded` or `down`

---

### `devops_get_incidents` <sub>tool</sub>

- `filter`: `all` (default), `active`, `resolved`, or `scheduled` (maintenance windows only). `limit` (default 20, max 50) with `offset` for paging
- Returns per-update bodies as plain text in chronological order, affected component names, duration in minutes for resolved incidents, and a shortlink. Google Cloud and AWS incidents also carry `affected_locations` (region ID, name, and whether it is still affected; on AWS, the one region the event names, or `global`). Each incident carries `source`: `api`, or `history` for an archive record (title, impact, times, and final message only)
- `since` and `until` (`YYYY-MM-DD`, UTC) bound the start date and work with `filter: "all"` or `"resolved"`; `since` also reads the Statuspage history archive back up to 24 months, past the API's newest-50 limit; a call that hits that limit without `since` is told to set it. `match` keeps incidents whose title, component names, or (on Google Cloud and AWS) location names and IDs contain every space-separated term given (up to 200 characters); a term joined by punctuation, such as `eu-central-1`, must find its words together and in order within one of them
- Responses are capped at 64,000 bytes per surface; a cut page sets `truncated: true` and `nextOffset`. `full_updates: true` keeps every update on a single oversized incident
- Errors: `invalid_since` and `invalid_until` (`filter: "active"` or `"scheduled"`, or `until` before `since`)
- Feeds with no data for a filter return empty: `resolved` for Azure, `scheduled` for AWS, Azure, Azure DevOps, Google Cloud, and Slack. History is short where a vendor reads no archive: AWS keeps resolved events for a few hours, and Status.io (`gitlab`, `neon`) lists current incidents only. On those feeds a `since` earlier than the oldest record returned, or an `until` without `since`, gets a `notice` naming the date the feed starts

---

### `devops_watch_stack` <sub>tool</sub>

- Pass `vendors` (up to 20) once to save the stack under `stack_name` (1-64 characters; several stacks can coexist, e.g. `"production"`); later calls can omit `vendors`. Over 20 is rejected with `stack_too_large`. Saving works on stdio and on HTTP with `MCP_AUTH_MODE=jwt|oauth`; with the default `in-memory` storage, saved stacks do not survive a restart
- On HTTP with `MCP_AUTH_MODE=none` nothing is saved: a call with `vendors` runs the sweep and returns `stack_persisted: false`, and a call without `vendors` fails with `vendors_required`
- Aggregate `health`: `all_operational` / `maintenance` / `degraded` / `partial_outage` / `major_outage` / `unknown` (a vendor could not be reached), rolled up from the same per-vendor rating as `summary`. `component_limit` and `nextToolSuggestions` work as in `devops_status_check`; there is no `component_offset`, so a capped vendor's `next_component_offset` continues in `devops_status_check`

---

### `devops_check_certs` <sub>tool</sub>

- Accepts hostnames, IP addresses, `host:port`, or URLs; a port on the entry overrides `port` (default 443). The first 10 entries are inspected (up to 100 accepted); the rest come back in `deferred_domains` to resend
- Reports days to expiry (`warning` under 30 days, `critical` under 7), subject and SANs, issuer, chain depth, TLS version (1.0 and 1.1 flagged insecure), cipher suite, and HSTS on HTTP ports
- `status: "critical"` separates a hostname mismatch (`hostname_verification_error`) from an untrusted chain (`authorization_error`). Per-domain failures come back inline as `status: "error"` with the reason in `error`
- `timeout_ms` is one deadline per domain (max 15000)

---

### `devops_check_dns` <sub>tool</sub>

- Accepts domain names, URLs, or `host:port`; the first 10 domains are queried (up to 100 accepted) and the rest come back in `deferred_domains`. IP addresses get their own `error` row
- Queries Google (8.8.8.8), Cloudflare (1.1.1.1), and Quad9 (9.9.9.9) in parallel for A, AAAA, CNAME, MX, TXT, NS, CAA, and SOA (default A, AAAA, MX, TXT)
- Reports per-resolver latency and typed discrepancies: `partial_resolution` (some resolvers did not answer) is a real problem; `value_variation` (different values) is normal for anycast or geo-steered domains
- Custom `resolvers` take public IP literals, first 5 queried and the rest in `deferred_resolvers`; private and loopback addresses need `DEVOPS_STATUS_ALLOW_PRIVATE_TARGETS=true`. `timeout_ms` applies per domain and resolver (max 10000)

---

### `devops_suggest_action` <sub>tool</sub>

- Takes a vendor slug or display name and returns a category-tailored markdown playbook, with generic guidance for unrecognized vendors
- Optional `incident_summary`, `affected_components`, and `vendor_indicator` add a subsystem section and severity-based urgency
- `nextToolSuggestions` pre-fills follow-up calls, including cert and DNS checks when `your_domain` is given. With `DEVOPS_STATUS_DISABLE_ACTIVE_PROBES=true`, guidance uses manual commands (`dig`, `openssl s_client`) instead

---

### `devops-status://vendors/{name}` <sub>resource</sub>

- Returns the full registry entry for a vendor slug: status page URL, category, API type (`statuspage`, `statusio`, `slack`, `aws`, `gcp`, `azure`, `azure-devops`, `firehydrant`, `datadog`), `component_scope_prefix` where a vendor covers part of a shared page (`sendgrid`), and `product_slugs` on an umbrella page that publishes no components (`atlassian`)
- Cached publicly for 1 hour; the same data is reachable via `devops_list_vendors`

---

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

DevOps-status-specific:

- **No API keys required** — every status backend is a public API; TLS and DNS use the Node.js standard library
- 71-vendor built-in registry across eight categories; native adapters normalize Status.io, Slack, AWS Health, Google Cloud, Azure, Azure DevOps, Firehydrant, and Datadog into the Statuspage shape
- Vendor-authored text is escaped so it reads as data, not markup; DNS record values and certificate names render as code spans that read back exactly as resolved
- 60-second in-memory cache on status reads, shared across tenants
- `devops_watch_stack` saves named vendor lists for repeat checks and pre-deploy sweeps
- `devops_suggest_action` is deterministic, with no LLM sampling dependency

Agent skill:

- `devops-status-guide` carries the gates for using these tools together: what a status reading can and cannot establish, how far incident history reaches on each backend, where regions live, and how to diagnose a DNS change or a certificate failure. MCP clients read it from the server as `skill://devops-status-guide/SKILL.md`; it also ships in the npm package, the Docker image, and the `.mcpb` bundle, and plugin installs scan it from `skills/`.

Agent-friendly output:

- Batch tools never let one failing target block the rest; errors come back as inline `error` fields
- `checked_at` on every status result is the time of the check; `cached: true` marks a status read served from the cache, which can be up to the cache TTL (60 seconds by default) older
- Fixed indicator and status enums (`none` / `minor` / `major` / `critical` / `maintenance`) let callers branch on data
- `nextToolSuggestions` pre-fills follow-up tool arguments from incident context

---

## Getting started

Connect to the hosted instance, no install:

```sh
claude mcp add --transport http devops-status-mcp-server https://devops-status.caseyjhand.com/mcp
```

Or run it locally:

```sh
claude mcp add devops-status-mcp-server -- npx -y @cyanheads/devops-status-mcp-server
```

For other clients, add this to the MCP config file:

```json
{
  "mcpServers": {
    "devops-status-mcp-server": {
      "command": "npx",
      "args": ["-y", "@cyanheads/devops-status-mcp-server"]
    }
  }
}
```

No API key required. For Docker or a source build, see [Running the server](#running-the-server).

---

## Configuration

No API keys required. All environment variables are optional.

| Variable | Description | Default |
|:---------|:------------|:--------|
| `DEVOPS_STATUS_CACHE_TTL_MS` | In-memory cache TTL for vendor status reads (all backends) in milliseconds. | `60000` |
| `DEVOPS_STATUS_FETCH_TIMEOUT_MS` | Per-request timeout for vendor status API calls (all backends) in milliseconds. | `8000` |
| `DEVOPS_STATUS_CERT_TIMEOUT_MS` | Default `timeout_ms` for `devops_check_certs` (1000–15000). | `5000` |
| `DEVOPS_STATUS_DNS_TIMEOUT_MS` | Default `timeout_ms` for `devops_check_dns` (1000–10000). | `3000` |
| `DEVOPS_STATUS_ALLOW_PRIVATE_TARGETS` | When `true`, disables the SSRF guards on user-supplied status-page URLs, `devops_check_certs` hosts, and `devops_check_dns` resolver IPs. Trusted local deployments only. | `false` |
| `DEVOPS_STATUS_DISABLE_ACTIVE_PROBES` | When `true`, removes `devops_check_dns` and `devops_check_certs`. For shared public instances. | `false` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_SESSION_MODE` | HTTP session handling: `stateless`, `stateful`, or `auto`. | `stateless` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

An invalid `DEVOPS_STATUS_*` value stops startup with an error naming the variable.

See [`.env.example`](./.env.example) for the full list of optional overrides.

---

## Running the server

### Local development

Requires [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).

- **Clone and install:**

  ```sh
  git clone https://github.com/cyanheads/devops-status-mcp-server.git
  cd devops-status-mcp-server && bun install
  cp .env.example .env   # optional overrides
  ```

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
docker run --rm -p 3010:3010 ghcr.io/cyanheads/devops-status-mcp-server:latest
```

The image defaults to HTTP transport, stateless session mode, and logs to `/var/log/devops-status-mcp-server`. To run it over stdio from an MCP client, use `"command": "docker"` with `"args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/devops-status-mcp-server:latest"]`. To build locally, `docker build -t devops-status-mcp-server .`; OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

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
| `src/services/status-adapters/` | Native-API adapters (Status.io, Slack, AWS Health, Google Cloud Service Health, Azure status, Azure DevOps status, Firehydrant, Datadog), the shared RSS extractor, + `api_type` dispatch, normalizing into the Statuspage shapes. |
| `src/services/vendor-registry/` | In-memory vendor registry loaded from `src/data/vendor-registry.ts`. |
| `src/data/` | Static vendor registry data file (`vendor-registry.ts`). |
| `src/utils/` | Shared helpers — response cache and fetch, SSRF guard, domain-entry normalizer, HTML-to-text, vendor-text markdown escaping, code-span rendering of DNS and certificate values, input-bound notices, word matching. |
| `skills/` | Published agent skill (`devops-status-guide`), served over MCP and shipped in the npm package, Docker image, and `.mcpb` bundle. |
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
