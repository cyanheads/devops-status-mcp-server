<div align="center">
  <h1>@cyanheads/devops-status-mcp-server</h1>
  <p><b>Check vendor status pages, inspect SSL/TLS certificates, verify DNS propagation, and get incident-response playbooks via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.2.3-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/devops-status-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/devops-status-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/devops-status-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^5.9.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/devops-status-mcp-server/releases/latest/download/devops-status-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=devops-status-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZGV2b3BzLXN0YXR1cy1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22devops-status-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fdevops-status-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://devops-status.caseyjhand.com/mcp](https://devops-status.caseyjhand.com/mcp)

</div>

---

## Tools

Seven tools in three capability groups — vendor status (Atlassian Statuspage, 48 built-in vendors + raw-URL passthrough), pure-TypeScript cert/DNS checks (any domain), and incident-response guidance:

| Tool | Description |
|:-----|:------------|
| `devops_list_vendors` | List vendors in the built-in registry, optionally filtered by name or category. Returns slug, display name, category, and Statuspage base URL. |
| `devops_status_check` | Check the current health status for one or more vendors. Returns per-vendor indicator (`none` / `minor` / `major` / `critical`), degraded components, and active incident summaries. |
| `devops_get_incidents` | Fetch incident history for a vendor — active, resolved, or scheduled maintenance. Returns the full incident timeline with per-update bodies and affected components. |
| `devops_watch_stack` | Check the health of a named vendor stack persisted in session state. Pass `vendors` once to save the list; subsequent calls reuse it. Returns an aggregate health rollup plus per-vendor detail. |
| `devops_check_certs` | Inspect SSL/TLS certificate health for one or more domains via a real TLS handshake. Reports expiry, chain depth, protocol version, cipher suite, and HSTS presence. Pure TypeScript — no external API. |
| `devops_check_dns` | Resolve DNS records and verify propagation for one or more domains across Google (8.8.8.8), Cloudflare (1.1.1.1), and Quad9 (9.9.9.9). Reports per-resolver latency and resolver discrepancies. Pure TypeScript — no external API. |
| `devops_suggest_action` | Instruction tool — returns a tailored incident-response playbook and pre-filled follow-up tool calls given a vendor name and optional incident context. No external calls; fully deterministic. |

### `devops_list_vendors`

Discover available vendors before running status checks or configuring a stack.

- Accepts an optional free-text `query` (matches name and slug, case-insensitive) and an optional `category` filter
- Eight categories: `cloud`, `cdn-edge`, `dev-platform`, `data`, `comms`, `auth`, `monitoring`, `ai`
- Returns slug (what to pass to other tools), display name, category, and Statuspage base URL
- 48 built-in entries — well-known public vendors with verified Statuspage `/api/v2/status.json` endpoints

Built-in vendor registry:

| Category | Vendors |
|:---------|:--------|
| `cloud` | digitalocean, linode |
| `cdn-edge` | cloudflare, akamai |
| `dev-platform` | github, npm, vercel, netlify, render, fly-io, circleci, travis-ci, snyk, atlassian, figma, launchdarkly |
| `data` | mongodb-atlas, planetscale, supabase, neon, redis-cloud, elastic, influxdb, upstash, cloudinary, segment |
| `comms` | slack, discord, twilio, sendgrid, mailgun, hubspot, brevo, courier, loops |
| `auth` | auth0, clerk, workos |
| `monitoring` | datadog, sentry, new-relic, grafana-cloud, honeycomb |
| `ai` | openai, anthropic, elevenlabs, pinecone, cohere |

The registry covers verified public vendors on Atlassian Statuspage. Major cloud providers (AWS, GCP, Azure) use custom status pages and are not in the registry — they can still be reached by passing their raw Statuspage-compatible URL if one exists.

---

### `devops_status_check`

Batch health snapshot across one or more vendors in a single call.

- Accepts registered vendor slugs (e.g., `"github"`) or raw Statuspage base URLs (e.g., `"https://www.githubstatus.com"`) — mix freely
- `mode: "summary"` (default): indicator + degraded components + active incidents
- `mode: "detailed"`: adds full component list and scheduled maintenance windows
- `Promise.allSettled` fan-out — one failing vendor does not block the rest; errors surface inline
- Results served from a 60-second in-memory cache; `cached: true` flag on each result

---

### `devops_get_incidents`

Full incident timeline for a vendor with filter support.

- `filter: "all"` (default): incidents plus scheduled maintenances
- `filter: "active"`: only incidents with status `investigating` / `identified` / `monitoring`
- `filter: "resolved"`: only fully resolved incidents
- `filter: "scheduled"`: only scheduled maintenance windows
- Returns per-update bodies in chronological order, affected component names, duration in minutes (resolved incidents), and a direct shortlink to the incident page
- Configurable `limit` (1–50); Statuspage returns at most 50 per call

---

### `devops_watch_stack`

Named, persisted vendor stack for recurring health sweeps.

- On the first call, provide `vendors` to define the stack — it is saved to tenant-scoped session state under `stack_name`
- Subsequent calls can omit `vendors`; the saved list is reused automatically
- Multiple stacks coexist via distinct `stack_name` values (e.g., `"production"`, `"data-layer"`)
- Aggregate health output: `all_operational` / `degraded` / `partial_outage` / `major_outage`
- Note: stack state is in-memory; it does not persist across server restarts

---

### `devops_check_certs`

Direct TLS handshake inspection — no external API required.

- Accepts bare hostnames (no `https://` prefix) — up to 10 per call
- Reports: days to expiry (flagged `warning` at < 30 days, `critical` at < 7), certificate subject and SANs, issuer common name, chain depth, negotiated TLS version (flags 1.0 and 1.1 as insecure), cipher suite
- HSTS detection: sends a minimal HTTP/1.1 GET over the same TLS socket, reads the `Strict-Transport-Security` response header
- Per-domain failures are reported inline (status: `"error"`) rather than throwing — useful partial results when checking multiple domains
- Configurable port (default 443) and timeout per domain

---

### `devops_check_dns`

Multi-resolver DNS propagation check — no external API required.

- Queries Google (8.8.8.8), Cloudflare (1.1.1.1), and Quad9 (9.9.9.9) in parallel per domain
- Supported record types: A, AAAA, CNAME, MX, TXT, NS (defaults to A, AAAA, MX, TXT)
- Reports per-resolver latency, propagation discrepancies (where resolvers disagree), and human-readable flags
- Custom resolver list supported — pass any IP addresses to test internal DNS or resolver-specific behavior
- Up to 10 domains per call; per-domain timeouts configurable

---

### `devops_suggest_action`

Deterministic incident-response guidance, no external calls.

- Returns a markdown playbook tailored to the vendor's category (CDN outage vs. CI/CD outage vs. auth provider outage vs. AI service outage)
- `nextToolSuggestions` pre-populated with arguments from the provided context — execute in sequence to gather diagnostic data
- Optional `your_domain` populates cert and DNS check arguments automatically
- Falls back to generic guidance for unrecognized vendors

---

## Resources and prompts

| Type | Name | Description |
|:-----|:-----|:------------|
| Resource | `devops-status://vendors/{name}` | Full registry entry for a vendor by slug — Statuspage base URL, category, API type. |

All resource data is also reachable via tools. Tool-only agents are fully supported.

---

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool and resource definitions — single file per primitive, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Pluggable auth: `none`, `jwt`, `oauth`
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

DevOps-status-specific:

- **No API keys required** — Atlassian Statuspage is a public API; TLS and DNS use Node.js stdlib (`node:tls`, `node:dns`)
- 48-vendor built-in registry covering cloud, CDN, dev-platform, data, comms, auth, monitoring, and AI categories; extendable via raw Statuspage URL passthrough
- 60-second in-memory cache on Statuspage reads shared across all tenants — prevents thundering-herd on batch calls
- `devops_watch_stack` persists named vendor lists in tenant-scoped state for repeat morning checks or pre-deploy sweeps
- `devops_suggest_action` dispatches category-specific playbooks deterministically — no LLM sampling dependency, works in all clients

Agent-friendly output:

- Batch tools (`devops_status_check`, `devops_watch_stack`, `devops_check_certs`, `devops_check_dns`) use `Promise.allSettled` — one failing target never blocks the rest; errors surface as inline `error` fields
- `cached: true` / `checked_at` on every Statuspage result — agents know when data was fetched
- Discriminated indicator and status enums (`none` / `minor` / `major` / `critical`; `operational` / `degraded_performance` / `partial_outage` / `major_outage` / `under_maintenance`) — callers branch on data, not string parsing
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

- [Bun v1.3.0](https://bun.sh/) or higher (or Node.js v24+).
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
| `DEVOPS_STATUS_CACHE_TTL_MS` | In-memory cache TTL for Statuspage reads in milliseconds. | `60000` |
| `DEVOPS_STATUS_FETCH_TIMEOUT_MS` | Per-request timeout for Statuspage API calls in milliseconds. | `8000` |
| `DEVOPS_STATUS_CERT_TIMEOUT_MS` | Per-domain TLS handshake timeout for `devops_check_certs` in milliseconds. | `5000` |
| `DEVOPS_STATUS_DNS_TIMEOUT_MS` | Per-query DNS timeout for `devops_check_dns` in milliseconds. | `3000` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

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
| `src/services/cert/` | `node:tls` — TLS handshake, X.509 parsing, expiry and protocol flagging. |
| `src/services/dns/` | `node:dns` — multi-resolver DNS fan-out, propagation discrepancy detection. |
| `src/services/statuspage/` | Statuspage public API client with 60-second in-memory cache. |
| `src/services/vendor-registry/` | In-memory vendor registry loaded from `src/data/vendor-registry.ts`. |
| `src/data/` | Static vendor registry data file (`vendor-registry.ts`). |
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

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

---

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
