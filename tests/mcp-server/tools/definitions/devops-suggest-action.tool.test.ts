/**
 * @fileoverview Tests for the devops_suggest_action tool.
 * @module tests/mcp-server/tools/definitions/devops-suggest-action.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { devopsSuggestAction } from '@/mcp-server/tools/definitions/devops-suggest-action.tool.js';
import { initVendorRegistryService } from '@/services/vendor-registry/vendor-registry-service.js';

beforeAll(() => {
  initVendorRegistryService();
});

describe('devopsSuggestAction', () => {
  it('returns guidance for a known vendor', () => {
    const ctx = createMockContext();
    const input = devopsSuggestAction.input.parse({ vendor: 'github' });
    const result = devopsSuggestAction.handler(input, ctx);
    expect(result.vendor).toBe('github');
    expect(result.guidance).toBeTruthy();
    expect(result.guidance.length).toBeGreaterThan(100);
    expect(result.nextToolSuggestions.length).toBeGreaterThan(0);
    expect(result.nextToolSuggestions[0]!.toolName).toBeTruthy();
    expect(result.nextToolSuggestions[0]!.args).toBeDefined();
  });

  it('detects category for registered vendors', () => {
    const ctx = createMockContext();
    const input = devopsSuggestAction.input.parse({ vendor: 'cloudflare' });
    const result = devopsSuggestAction.handler(input, ctx);
    expect(result.vendor_category).toBe('cdn-edge');
    // CDN-specific guidance should mention CDN-relevant terminology
    expect(result.guidance).toContain('CDN');
  });

  it('uses DEFAULT_PLAYBOOK for unknown vendor', () => {
    const ctx = createMockContext();
    const input = devopsSuggestAction.input.parse({ vendor: 'unknown-vendor-xyz' });
    const result = devopsSuggestAction.handler(input, ctx);
    expect(result.vendor_category).toBeNull();
    expect(result.guidance).toBeTruthy();
    expect(result.nextToolSuggestions.length).toBeGreaterThan(0);
  });

  it('pre-fills domain in suggestions when your_domain is provided', () => {
    const ctx = createMockContext();
    const input = devopsSuggestAction.input.parse({
      vendor: 'github',
      your_domain: 'https://api.example.com/path',
    });
    const result = devopsSuggestAction.handler(input, ctx);
    // DNS and cert checks should be pre-filled with the domain
    const dnsSuggestion = result.nextToolSuggestions.find((s) => s.toolName === 'devops_check_dns');
    expect(dnsSuggestion).toBeDefined();
    expect(JSON.stringify(dnsSuggestion!.args)).toContain('api.example.com');
  });

  it('includes incident snippet in diagnostics_summary', () => {
    const ctx = createMockContext();
    const longSummary = 'A'.repeat(300);
    const input = devopsSuggestAction.input.parse({
      vendor: 'aws',
      incident_summary: longSummary,
    });
    const result = devopsSuggestAction.handler(input, ctx);
    expect(result.diagnostics_summary.incident_snippet).not.toBeNull();
    expect(result.diagnostics_summary.incident_snippet!.length).toBeLessThanOrEqual(203); // 200 + "…"
    expect(result.diagnostics_summary.incident_snippet).toContain('…');
  });

  it('formats output with guidance and next steps', () => {
    const ctx = createMockContext();
    const input = devopsSuggestAction.input.parse({ vendor: 'github' });
    const result = devopsSuggestAction.handler(input, ctx);
    const blocks = devopsSuggestAction.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('github');
    expect(text).toContain('devops_get_incidents');
  });

  it('raw Statuspage URL as vendor → null category, generic guidance', () => {
    const ctx = createMockContext();
    // A raw URL that looks like a Statuspage URL but is not a slug in the registry
    const input = devopsSuggestAction.input.parse({
      vendor: 'https://status.example-internal.com',
    });
    const result = devopsSuggestAction.handler(input, ctx);
    expect(result.vendor_category).toBeNull();
    // Generic playbook should mention "Service Outage"
    expect(result.guidance).toContain('Service Outage');
    // devops_get_incidents suggestion should still appear with the raw URL as vendor
    const incSuggestion = result.nextToolSuggestions.find(
      (s) => s.toolName === 'devops_get_incidents',
    );
    expect(incSuggestion).toBeDefined();
  });

  it('affected_components echoed into diagnostics_summary', () => {
    const ctx = createMockContext();
    const input = devopsSuggestAction.input.parse({
      vendor: 'github',
      affected_components: ['Git Operations', 'Actions'],
    });
    const result = devopsSuggestAction.handler(input, ctx);
    expect(result.diagnostics_summary.affected_components).toContain('Git Operations');
    expect(result.diagnostics_summary.affected_components).toContain('Actions');
  });

  it('format includes affected_components text when provided', () => {
    const ctx = createMockContext();
    const input = devopsSuggestAction.input.parse({
      vendor: 'openai',
      affected_components: ['Chat API'],
    });
    const result = devopsSuggestAction.handler(input, ctx);
    const blocks = devopsSuggestAction.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Chat API');
  });

  it('all registered vendor categories produce category-specific guidance', () => {
    const categories = [
      'cloud',
      'cdn-edge',
      'dev-platform',
      'data',
      'comms',
      'auth',
      'monitoring',
      'ai',
    ];
    // Map each category to a known vendor slug
    const categoryToSlug: Record<string, string> = {
      cloud: 'digitalocean',
      'cdn-edge': 'cloudflare',
      'dev-platform': 'github',
      data: 'supabase',
      comms: 'slack',
      auth: 'auth0',
      monitoring: 'datadog',
      ai: 'openai',
    };
    for (const category of categories) {
      const slug = categoryToSlug[category]!;
      const ctx = createMockContext();
      const input = devopsSuggestAction.input.parse({ vendor: slug });
      const result = devopsSuggestAction.handler(input, ctx);
      expect(result.vendor_category).toBe(category);
      // All categories should produce non-generic guidance (i.e., playbook entry exists)
      expect(result.guidance.length).toBeGreaterThan(100);
    }
  });
});
