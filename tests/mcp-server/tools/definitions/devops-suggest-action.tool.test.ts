/**
 * @fileoverview Tests for the devops_suggest_action tool.
 * @module tests/mcp-server/tools/definitions/devops-suggest-action.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { devopsSuggestAction } from '@/mcp-server/tools/definitions/devops-suggest-action.tool.js';
import { initVendorRegistryService } from '@/services/vendor-registry/vendor-registry-service.js';

const mockConfigState = vi.hoisted(() => ({ disableActiveProbes: false }));

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    cacheTtlMs: 60_000,
    fetchTimeoutMs: 8_000,
    certTimeoutMs: 5_000,
    dnsTimeoutMs: 3_000,
    allowPrivateTargets: false,
    disableActiveProbes: mockConfigState.disableActiveProbes,
  }),
}));

beforeAll(() => {
  initVendorRegistryService();
});

afterEach(() => {
  mockConfigState.disableActiveProbes = false;
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

  it('carries the full incident_summary in diagnostics_summary without truncation (#21)', () => {
    const ctx = createMockContext();
    const longSummary = 'A'.repeat(300);
    const input = devopsSuggestAction.input.parse({
      vendor: 'aws',
      incident_summary: longSummary,
    });
    const result = devopsSuggestAction.handler(input, ctx);
    expect(result.diagnostics_summary.incident_snippet).toBe(longSummary);
    expect(result.diagnostics_summary.incident_snippet).not.toContain('…');
    // The full text also reaches the content[] surface via format()
    const blocks = devopsSuggestAction.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain(longSummary);
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

  it('playbook references probe tools by name when active probes are enabled', () => {
    const ctx = createMockContext();
    const input = devopsSuggestAction.input.parse({ vendor: 'cloudflare' });
    const result = devopsSuggestAction.handler(input, ctx);
    expect(result.guidance).toContain('devops_check_dns');
    expect(result.guidance).toContain('devops_check_certs');
    // Placeholder tokens must never leak into rendered guidance
    expect(result.guidance).not.toContain('{{');
  });

  describe('active probes disabled (#7)', () => {
    it('omits devops_check_dns / devops_check_certs suggestions even with your_domain', () => {
      mockConfigState.disableActiveProbes = true;
      const ctx = createMockContext();
      const input = devopsSuggestAction.input.parse({
        vendor: 'cloudflare',
        your_domain: 'example.com',
      });
      const result = devopsSuggestAction.handler(input, ctx);
      const toolNames = result.nextToolSuggestions.map((s) => s.toolName);
      expect(toolNames).not.toContain('devops_check_dns');
      expect(toolNames).not.toContain('devops_check_certs');
      // The registered incident tool is still suggested
      expect(toolNames).toContain('devops_get_incidents');
    });

    it('replaces probe tool names in the playbook with manual commands', () => {
      mockConfigState.disableActiveProbes = true;
      const ctx = createMockContext();
      const input = devopsSuggestAction.input.parse({ vendor: 'cloudflare' });
      const result = devopsSuggestAction.handler(input, ctx);
      expect(result.guidance).not.toContain('devops_check_dns');
      expect(result.guidance).not.toContain('devops_check_certs');
      expect(result.guidance).toContain('dig');
      expect(result.guidance).toContain('openssl s_client');
      expect(result.guidance).not.toContain('{{');
    });

    it('default playbook for unknown vendors also avoids probe tool names', () => {
      mockConfigState.disableActiveProbes = true;
      const ctx = createMockContext();
      const input = devopsSuggestAction.input.parse({ vendor: 'unknown-vendor-xyz' });
      const result = devopsSuggestAction.handler(input, ctx);
      expect(result.guidance).not.toContain('devops_check_dns');
      expect(result.guidance).not.toContain('devops_check_certs');
      const blocks = devopsSuggestAction.format!(result);
      const text = (blocks[0] as { text: string }).text;
      expect(text).not.toContain('devops_check_dns');
      expect(text).not.toContain('devops_check_certs');
    });
  });

  describe('vendor_indicator input (#10)', () => {
    it('echoes the indicator and leads guidance with severity framing when provided', () => {
      const ctx = createMockContext();
      const input = devopsSuggestAction.input.parse({
        vendor: 'github',
        vendor_indicator: 'critical',
      });
      const result = devopsSuggestAction.handler(input, ctx);
      expect(result.diagnostics_summary.vendor_indicator).toBe('critical');
      expect(result.guidance.startsWith('**Reported severity: critical')).toBe(true);
      const blocks = devopsSuggestAction.format!(result);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('**Vendor indicator:** critical');
    });

    it('tailors the severity framing per indicator value', () => {
      const ctx = createMockContext();
      for (const indicator of ['none', 'minor', 'major', 'critical'] as const) {
        const input = devopsSuggestAction.input.parse({
          vendor: 'github',
          vendor_indicator: indicator,
        });
        const result = devopsSuggestAction.handler(input, ctx);
        expect(result.guidance).toContain(`Reported severity: ${indicator}`);
      }
    });

    it('returns null indicator and unmodified guidance when omitted', () => {
      const ctx = createMockContext();
      const input = devopsSuggestAction.input.parse({ vendor: 'github' });
      const result = devopsSuggestAction.handler(input, ctx);
      expect(result.diagnostics_summary.vendor_indicator).toBeNull();
      expect(result.guidance).not.toContain('Reported severity');
      const blocks = devopsSuggestAction.format!(result);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('not specified');
    });

    it('rejects values outside the indicator enum', () => {
      expect(() =>
        devopsSuggestAction.input.parse({ vendor: 'github', vendor_indicator: 'severe' }),
      ).toThrow();
    });
  });

  describe('display-name vendor resolution (#20)', () => {
    it('resolves a display name to the canonical slug and category', () => {
      const ctx = createMockContext();
      const input = devopsSuggestAction.input.parse({ vendor: 'Amazon Web Services' });
      const result = devopsSuggestAction.handler(input, ctx);
      expect(result.vendor_category).toBe('cloud');
      const incidents = result.nextToolSuggestions.find(
        (s) => s.toolName === 'devops_get_incidents',
      );
      expect(incidents).toBeDefined();
      // The unresolved display name must not thread into follow-up args — canonical slug only
      expect(incidents!.args.vendor).toBe('aws');
    });

    it('does not resolve an ambiguous bare word to an arbitrary vendor', () => {
      const ctx = createMockContext();
      // "cloud" substring-matches several registry names (Redis Cloud, Grafana Cloud, …)
      // but is neither a slug nor an exact display name — it must stay unresolved.
      const input = devopsSuggestAction.input.parse({ vendor: 'cloud' });
      const result = devopsSuggestAction.handler(input, ctx);
      expect(result.vendor_category).toBeNull();
      const incidents = result.nextToolSuggestions.find(
        (s) => s.toolName === 'devops_get_incidents',
      );
      expect(incidents!.args.vendor).toBe('cloud');
    });
  });

  describe('incident-context tailoring (#21)', () => {
    it('an affected component tailors guidance and adds a component re-check (GitHub Actions)', () => {
      const ctx = createMockContext();
      const input = devopsSuggestAction.input.parse({
        vendor: 'github',
        vendor_indicator: 'minor',
        affected_components: ['Actions'],
      });
      const result = devopsSuggestAction.handler(input, ctx);
      // Targeted CI/CD section leads ahead of the generic dev-platform playbook
      expect(result.guidance).toContain('Affected subsystem: CI/CD pipelines');
      expect(result.guidance).toContain('Deploy-free mitigations');
      expect(result.guidance.indexOf('Affected subsystem: CI/CD pipelines')).toBeLessThan(
        result.guidance.indexOf('Dev Platform Outage'),
      );
      // A detailed re-check of the resolved vendor is added
      const recheck = result.nextToolSuggestions.find((s) => s.toolName === 'devops_status_check');
      expect(recheck).toBeDefined();
      expect(recheck!.args.vendors).toEqual(['github']);
      expect(recheck!.args.mode).toBe('detailed');
    });

    it('an incident-summary keyword tailors guidance ahead of the generic playbook (Cloudflare DNS)', () => {
      const ctx = createMockContext();
      const input = devopsSuggestAction.input.parse({
        vendor: 'cloudflare',
        vendor_indicator: 'major',
        incident_summary: 'Elevated DNS resolution failures across multiple PoPs.',
      });
      const result = devopsSuggestAction.handler(input, ctx);
      expect(result.guidance).toContain('Affected subsystem: DNS resolution');
      expect(result.guidance.indexOf('Affected subsystem: DNS resolution')).toBeLessThan(
        result.guidance.indexOf('CDN / Edge Network Outage'),
      );
      // Tailoring never leaks placeholder tokens
      expect(result.guidance).not.toContain('{{');
    });

    it('leaves guidance untailored and adds no re-check when nothing matches', () => {
      const ctx = createMockContext();
      const input = devopsSuggestAction.input.parse({
        vendor: 'github',
        affected_components: ['Pages'],
      });
      const result = devopsSuggestAction.handler(input, ctx);
      expect(result.guidance).not.toContain('Affected subsystem:');
      expect(result.nextToolSuggestions.some((s) => s.toolName === 'devops_status_check')).toBe(
        false,
      );
    });
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
