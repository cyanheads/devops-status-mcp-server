# devops-status-mcp-server — Idea & Requirements

Infrastructure health and incident intelligence — vendor status pages, SSL/TLS and DNS checks, and incident-response guidance in one operational picture.

| | |
|---|---|
| **Status** | Pre-build design · scaffolded on `@cyanheads/mcp-ts-core@0.9.16` |
| **Category** | developer-tooling |
| **Auth** | none |
| **API cost** | free — all public, no keys |
| **Pattern** | multi-source aggregation + pure TS |
| **Complexity** | medium |
| **Composes with** | standalone utility |

## Overview

Infrastructure health and incident intelligence. Two questions drive it: "are my dependencies healthy?" and "what broke, when, and is it fixed?" It aggregates vendor status pages, incident data, certificate health, and DNS status into a single operational picture.

A mix of external API sources (Atlassian Statuspage, vendor APIs) and pure-TS analysis (TLS inspection, DNS resolution). The pure-TS tools have zero external dependencies and work for any domain.

## Audience

DevOps engineers, SREs, platform teams, and developers who manage infrastructure dependencies. Anyone running production services needs to know when their upstreams are degraded.

## User Goals

- Quick check: "Is AWS / GitHub / Cloudflare healthy right now?"
- Batch check: "Are all my infrastructure dependencies up?" (pass a vendor list)
- Incident deep-dive: "What happened to Cloudflare yesterday — when did it start, what was affected, is it resolved?"
- Proactive monitoring: "Which of my SSL certs are expiring soon?"
- DNS health: "Is DNS resolving correctly for my domains? Any propagation issues?"
- Incident response: "Cloudflare is down — what should I do?"

## Sources (service layer)

"Vendor status" isn't one API — it's a convention. Most major vendors use Atlassian Statuspage (public API); some don't. The server needs a registry of known vendor status-page URLs and the API pattern each uses.

| Source | Type | Provides | Cost |
|:---|:---|:---|:---|
| Atlassian Statuspage API | Public, no key | Status, components, incidents, scheduled maintenance for any Statuspage vendor (AWS, GitHub, Cloudflare, Vercel, Netlify, npm, Docker Hub, …) | Free |
| GitHub Status API | Public, no key | GitHub-specific status and incidents | Free |
| Vendor-specific status APIs | Various | Bespoke status APIs (Google Cloud, Azure) | Free |
| TLS inspection | Pure TS (`node:tls`/`crypto`) | Cert expiry, chain validation, cipher suites, protocol versions for any domain | Free |
| DNS resolution | Pure TS (`node:dns`) | Resolution checks, record enumeration, propagation verification | Free |

**Vendor registry:** a curated mapping of vendor names → status-page URLs/endpoints, maintained as an in-repo TypeScript data file (not fetched at runtime). Users can also pass a raw Statuspage URL for unlisted vendors. Default registry candidates: cloud (AWS, GCP, Azure, DigitalOcean, Hetzner), CDN/edge (Cloudflare, Fastly, Akamai), dev platforms (GitHub, GitLab, npm, Docker Hub, Vercel, Netlify), data (MongoDB Atlas, PlanetScale, Supabase, Neon), comms (Slack, Discord, Twilio, SendGrid), auth (Auth0, Clerk, Okta), monitoring (Datadog, PagerDuty, Sentry), AI (OpenAI, Anthropic).

## Tool Surface (planned)

Organized around operational workflows, not endpoints.

| Tool | Behavior |
|:---|:---|
| `devops_status_check` | "Is X healthy?" One or more vendor names (or raw Statuspage URLs). Returns per-vendor status (`operational` \| `degraded` \| `partial_outage` \| `major_outage`) with affected components and active-incident summaries. Batch-friendly. Mode: `summary` \| `detailed`. |
| `devops_get_incidents` | Incident history for a vendor. Filter by date range, status (`active` \| `resolved` \| `scheduled`), component. Returns timeline (created → updates → resolved), affected components, duration, postmortem link. |
| `devops_watch_stack` | Accepts a vendor list representing your stack; returns a unified health overview — all green, or what's degraded with severity and duration. For "morning check" / "before deploy". May persist the stack via tenant-scoped `ctx.state`. |
| `devops_check_certs` | SSL/TLS health for domains. Pure TS — direct handshake: days-to-expiry (flag < 30), chain completeness, protocol versions (flag TLS 1.0/1.1), cipher strength, HSTS/CT/OCSP. No external API. |
| `devops_check_dns` | DNS health for domains. Pure TS — A/AAAA/CNAME/MX/TXT records, resolution time, propagation across multiple resolvers (Google, Cloudflare, Quad9), DNSSEC status, resolver discrepancies. |
| `devops_suggest_action` | Instruction tool: given a detected incident/degradation, returns mitigation guidance with pre-filled follow-up calls (check origin DNS, verify certs, enable failover, monitor for resolution). Operational playbooks tailored to the incident, not "wait for the vendor." |
| `devops_list_vendors` | List the built-in registry with Statuspage URLs and categories; accepts a search query. Helps users discover what's available and configure their stack. |

## Design Notes & Requirements

- **The vendor registry is the key design challenge** — comprehensive enough to be useful out of the box, extensible via raw Statuspage URLs. Maintain as an in-repo TS data file, not fetched at runtime.
- **Statuspage has a consistent API** across all vendors that use it (`/api/v2/status.json`, `/api/v2/incidents.json`, …) — covers most tech vendors. Detect the Statuspage convention and fall back to vendor-specific parsing otherwise.
- **`devops_check_certs` and `devops_check_dns` are pure TS, zero deps** — they work for any domain, not just registered vendors, and have standalone value even without the status features.
- **The instruction tool (`devops_suggest_action`) is where LLM reasoning shines** — connecting a vendor degradation to actionable, infra-specific steps. Generic monitors show status; this one advises.
- **`devops_watch_stack`** could persist a stack config via tenant-scoped state so users don't re-specify their vendor list each call.
- Rate limits aren't a concern — Statuspage APIs are public and built for polling. Be respectful (cache ~60s).
- Consider a simple uptime/latency check (HTTP HEAD, measure RTT) alongside status-page data — ground truth vs. vendor self-reporting.

## Build Constraints

- Framework: `@cyanheads/mcp-ts-core@0.9.16`
- No keys → fully hostable
- In-repo vendor registry (TS data file), user-extensible via raw URLs
- Short-TTL caching (~60s) on status-page reads
