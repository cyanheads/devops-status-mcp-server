# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.5.3](changelog/0.5.x/0.5.3.md) — 2026-07-11

devops_check_certs returns the declared invalid_domain error (with recovery hint) for protocol-prefixed domains instead of a raw Zod message, and devops_check_dns returns a structured target_blocked error for private/loopback resolver IPs.

## [0.5.2](changelog/0.5.x/0.5.2.md) — 2026-07-10

devops_suggest_action tailors the playbook to the incident context (affected_components / incident_summary), resolves a vendor by display name as well as slug, and carries the full incident_summary instead of a 200-character snippet.

## [0.5.1](changelog/0.5.x/0.5.1.md) — 2026-07-10

devops_watch_stack aggregate-health honesty (errored vendors never roll up as all_operational) and stack-persistence fix (no poisoned state on failed calls), plus mcp-ts-core 0.10.14 adoption and a supply-chain install guard.

## [0.5.0](changelog/0.5.x/0.5.0.md) — 2026-07-02

Firehydrant status-page adapter — redis-cloud moves off the dead Statuspage API onto the page's own payload feed; registry stays at 50 vendors.

## [0.4.0](changelog/0.4.x/0.4.0.md) — 2026-07-02

Status-API adapter layer (Status.io, Slack, AWS Health) normalizes native feeds into the Statuspage shapes — aws and gitlab join the registry, slack and neon move onto their real backends (48 → 50 vendors), auth0 URL fixed, plus a verify:registry drift probe.

## [0.3.1](changelog/0.3.x/0.3.1.md) — 2026-07-02

devops_watch_stack annotations corrected (readOnlyHint: false); DEVOPS_STATUS_CERT_TIMEOUT_MS / DEVOPS_STATUS_DNS_TIMEOUT_MS now drive the probe timeout_ms defaults; ctx.recoveryFor spread at all 9 ctx.fail sites so data.recovery.hint reaches the wire.

## [0.3.0](changelog/0.3.x/0.3.0.md) — 2026-07-02 · 🛡️ Security

devops_suggest_action gains an optional vendor_indicator severity input and honors DEVOPS_STATUS_DISABLE_ACTIVE_PROBES; devops_get_incidents enrichment + duration guards; transitive re-resolve clears all 9 bun audit advisories (hono 4.12.27, vite 8.1.3, js-yaml 3.15.0); mcp-ts-core ^0.10.10.

## [0.2.5](changelog/0.2.x/0.2.5.md) — 2026-06-20

Adopt @cyanheads/mcp-ts-core ^0.10.9 — ctx.content media collector, Canvas SQL invalid_sql classification, DuckdbProvider.describe() filter fix, two new devcheck guards (dependency specifiers, plugin marketplace manifests); typescript ^6.0.3, @types/node ^26.

## [0.2.4](changelog/0.2.x/0.2.4.md) — 2026-06-15 · 🛡️ Security

DEVOPS_STATUS_DISABLE_ACTIVE_PROBES gates the arbitrary-target probe tools out of the surface for shared/public instances; SSRF guard now reads the parsed config instead of process.env, with allowPrivateTargets tightened to a strict boolean.

## [0.2.3](changelog/0.2.x/0.2.3.md) — 2026-06-12

Adopt mcp-ts-core ^0.10.6: semantic error codes across the tool surface, incident-count truncation enrichment on devops_get_incidents, explicit display identity, and an MCPB post-pack bundle cleaner.

## [0.2.2](changelog/0.2.x/0.2.2.md) — 2026-06-04

Vendor registry: 26 → 48 entries — circleci, travis-ci, snyk, atlassian, figma, launchdarkly, elastic, influxdb, upstash, cloudinary, segment, hubspot, brevo, courier, loops, workos, new-relic, grafana-cloud, honeycomb, elevenlabs, pinecone, cohere.

## [0.2.1](changelog/0.2.x/0.2.1.md) — 2026-06-02

Adopt @cyanheads/mcp-ts-core 0.9.21: per-request log context fix, secret-stripping in fetchWithTimeout, withRetry fail-fast on non-retryable errors.

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-05-30 · ⚠️ Breaking

Rename status_* tool prefix → devops_* and STATUS_* env prefix → DEVOPS_STATUS_*.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-05-30

Public hosted endpoint at https://devops-status.caseyjhand.com/mcp.

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-05-30

Initial release — vendor health via Atlassian Statuspage, TLS cert inspection, multi-resolver DNS checks, and incident-response tooling with an SSRF guard on all user-supplied targets.
