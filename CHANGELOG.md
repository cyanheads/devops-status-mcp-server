# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

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
