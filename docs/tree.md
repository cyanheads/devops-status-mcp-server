# devops-status-mcp-server - Directory Structure

Generated on: 2026-07-30 22:01:33

```text
devops-status-mcp-server/
├── .agents/
├── .claude/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   ├── 0.2.x/
│   ├── 0.3.x/
│   ├── 0.4.x/
│   ├── 0.5.x/
│   ├── 0.6.x/
│   ├── 0.7.x/
│   └── template.md
├── docs/
│   ├── design.md
│   └── idea.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── release-github.ts
│   ├── tree.ts
│   └── verify-registry.ts
├── skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── data/
│   │   └── vendor-registry.ts
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       ├── index.ts
│   │   │       └── vendor-entry.resource.ts
│   │   └── tools/
│   │       └── definitions/
│   │           ├── devops-check-certs.tool.ts
│   │           ├── devops-check-dns.tool.ts
│   │           ├── devops-get-incidents.tool.ts
│   │           ├── devops-list-vendors.tool.ts
│   │           ├── devops-status-check.tool.ts
│   │           ├── devops-suggest-action.tool.ts
│   │           ├── devops-vendor-result.ts
│   │           ├── devops-watch-stack.tool.ts
│   │           └── index.ts
│   ├── services/
│   │   ├── cert/
│   │   │   └── cert-service.ts
│   │   ├── dns/
│   │   │   └── dns-service.ts
│   │   ├── status-adapters/
│   │   │   ├── aws-adapter.ts
│   │   │   ├── firehydrant-adapter.ts
│   │   │   ├── gcp-adapter.ts
│   │   │   ├── slack-adapter.ts
│   │   │   ├── status-dispatch.ts
│   │   │   └── statusio-adapter.ts
│   │   ├── statuspage/
│   │   │   ├── statuspage-service.ts
│   │   │   └── types.ts
│   │   └── vendor-registry/
│   │       └── vendor-registry-service.ts
│   ├── utils/
│   │   ├── cached-fetch.ts
│   │   └── ssrf-guard.ts
│   └── index.ts
├── tests/
│   ├── config/
│   │   └── server-config.test.ts
│   ├── mcp-server/
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       └── vendor-entry.resource.test.ts
│   │   └── tools/
│   │       └── definitions/
│   │           ├── devops-check-certs.tool.test.ts
│   │           ├── devops-check-dns.tool.test.ts
│   │           ├── devops-get-incidents.tool.test.ts
│   │           ├── devops-list-vendors.tool.test.ts
│   │           ├── devops-status-check.tool.test.ts
│   │           ├── devops-suggest-action.tool.test.ts
│   │           ├── devops-watch-stack.tool.test.ts
│   │           ├── probe-timeout-defaults.test.ts
│   │           └── tool-surface.test.ts
│   ├── prompts/
│   ├── resources/
│   ├── services/
│   │   ├── cert/
│   │   │   └── cert-service.test.ts
│   │   ├── dns/
│   │   │   └── dns-service.test.ts
│   │   ├── status-adapters/
│   │   │   ├── fixtures/
│   │   │   │   ├── aws-currentevents.utf16be.bin
│   │   │   │   ├── firehydrant-redis.json
│   │   │   │   ├── gcp-incidents.json
│   │   │   │   ├── slack-current.json
│   │   │   │   ├── slack-history.json
│   │   │   │   ├── statusio-gitlab.json
│   │   │   │   └── statusio-incident-doc-derived.json
│   │   │   ├── aws-adapter.test.ts
│   │   │   ├── firehydrant-adapter.test.ts
│   │   │   ├── gcp-adapter.test.ts
│   │   │   ├── slack-adapter.test.ts
│   │   │   ├── status-dispatch.test.ts
│   │   │   └── statusio-adapter.test.ts
│   │   ├── statuspage/
│   │   │   └── statuspage-service.test.ts
│   │   └── vendor-registry/
│   │       └── vendor-registry-service.test.ts
│   ├── tools/
│   └── utils/
│       ├── cached-fetch.test.ts
│       └── ssrf-guard.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
