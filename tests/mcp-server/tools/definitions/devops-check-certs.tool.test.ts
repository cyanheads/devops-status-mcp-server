/**
 * @fileoverview Tests for the devops_check_certs tool.
 * @module tests/mcp-server/tools/definitions/devops-check-certs.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { devopsCheckCerts } from '@/mcp-server/tools/definitions/devops-check-certs.tool.js';
import type { CertResult } from '@/services/cert/cert-service.js';

vi.mock('@/services/cert/cert-service.js', () => {
  const mockCheckDomains = vi.fn();
  return {
    getCertService: () => ({ checkDomains: mockCheckDomains }),
    initCertService: vi.fn(),
    _mockCheckDomains: mockCheckDomains,
  };
});

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    certTimeoutMs: 5000,
    dnsTimeoutMs: 3000,
    cacheTtlMs: 60000,
    fetchTimeoutMs: 10000,
  }),
}));

const VALID_CERT: CertResult = {
  domain: 'example.com',
  port: 443,
  status: 'ok',
  flags: ['HSTS present'],
  cert: {
    subject: 'example.com',
    san: ['example.com', 'www.example.com'],
    issuer: "Let's Encrypt Authority X3",
    valid_from: '2025-01-01T00:00:00Z',
    valid_until: '2026-01-01T00:00:00Z',
    days_until_expiry: 180,
    chain_depth: 2,
    serial: 'ABC123',
  },
  tls: { protocol: 'TLSv1.3', cipher: 'TLS_AES_256_GCM_SHA384' },
  checked_at: '2025-06-01T00:00:00Z',
  error: null,
};

const CRITICAL_CERT: CertResult = {
  domain: 'expiring.example.com',
  port: 443,
  status: 'critical',
  flags: ['Expires in 3 days (CRITICAL)'],
  cert: {
    subject: 'expiring.example.com',
    san: ['expiring.example.com'],
    issuer: 'Self-signed',
    valid_from: '2024-01-01T00:00:00Z',
    valid_until: '2025-06-04T00:00:00Z',
    days_until_expiry: 3,
    chain_depth: 1,
    serial: 'DEF456',
  },
  tls: { protocol: 'TLSv1.2', cipher: 'ECDHE-RSA-AES256-GCM-SHA384' },
  checked_at: '2025-06-01T00:00:00Z',
  error: null,
};

const ERROR_CERT: CertResult = {
  domain: 'unreachable.example.com',
  port: 443,
  status: 'error',
  flags: ['Connection error: ECONNREFUSED'],
  cert: null,
  tls: null,
  checked_at: '2025-06-01T00:00:00Z',
  error: 'ECONNREFUSED',
};

describe('devopsCheckCerts', () => {
  it('returns ok status for a healthy certificate', async () => {
    const { _mockCheckDomains } = (await import('@/services/cert/cert-service.js')) as {
      _mockCheckDomains: ReturnType<typeof vi.fn>;
    };
    _mockCheckDomains.mockResolvedValue([VALID_CERT]);

    const ctx = createMockContext({ errors: devopsCheckCerts.errors });
    const input = devopsCheckCerts.input.parse({ domains: ['example.com'] });
    const result = await devopsCheckCerts.handler(input, ctx);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.status).toBe('ok');
    expect(result.results[0]!.cert).not.toBeNull();
    expect(result.results[0]!.cert!.subject).toBe('example.com');
    expect(result.results[0]!.cert!.days_until_expiry).toBe(180);
    expect(result.results[0]!.tls!.protocol).toBe('TLSv1.3');
  });

  it('returns critical status for expiring certificate', async () => {
    const { _mockCheckDomains } = (await import('@/services/cert/cert-service.js')) as {
      _mockCheckDomains: ReturnType<typeof vi.fn>;
    };
    _mockCheckDomains.mockResolvedValue([CRITICAL_CERT]);

    const ctx = createMockContext({ errors: devopsCheckCerts.errors });
    const input = devopsCheckCerts.input.parse({ domains: ['expiring.example.com'] });
    const result = await devopsCheckCerts.handler(input, ctx);

    expect(result.results[0]!.status).toBe('critical');
    expect(result.results[0]!.flags).toContain('Expires in 3 days (CRITICAL)');
  });

  it('returns error status for unreachable domain', async () => {
    const { _mockCheckDomains } = (await import('@/services/cert/cert-service.js')) as {
      _mockCheckDomains: ReturnType<typeof vi.fn>;
    };
    _mockCheckDomains.mockResolvedValue([ERROR_CERT]);

    const ctx = createMockContext({ errors: devopsCheckCerts.errors });
    const input = devopsCheckCerts.input.parse({ domains: ['unreachable.example.com'] });
    const result = await devopsCheckCerts.handler(input, ctx);

    expect(result.results[0]!.status).toBe('error');
    expect(result.results[0]!.error).toBe('ECONNREFUSED');
    expect(result.results[0]!.cert).toBeNull();
  });

  it('throws invalid_domain for protocol-prefixed input (bypassing Zod schema)', async () => {
    const ctx = createMockContext({ errors: devopsCheckCerts.errors });
    // Bypass Zod validation to test the handler's belt-and-suspenders PROTOCOL_RE check
    const input = { domains: ['https://example.com'], port: 443, timeout_ms: 5000 } as Parameters<
      typeof devopsCheckCerts.handler
    >[0];
    await expect(devopsCheckCerts.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_domain' },
    });
  });

  it('returns warning status for cert expiring in 20 days', async () => {
    const { _mockCheckDomains } = (await import('@/services/cert/cert-service.js')) as {
      _mockCheckDomains: ReturnType<typeof vi.fn>;
    };
    const WARNING_CERT: CertResult = {
      domain: 'almost-expired.example.com',
      port: 443,
      status: 'warning',
      flags: ['Expires in 20 days (warning)', 'HSTS present'],
      cert: {
        subject: 'almost-expired.example.com',
        san: ['almost-expired.example.com'],
        issuer: "Let's Encrypt",
        valid_from: '2025-01-01T00:00:00Z',
        valid_until: '2025-06-21T00:00:00Z',
        days_until_expiry: 20,
        chain_depth: 2,
        serial: 'WARN123',
      },
      tls: { protocol: 'TLSv1.3', cipher: 'TLS_AES_256_GCM_SHA384' },
      checked_at: '2025-06-01T00:00:00Z',
      error: null,
    };
    _mockCheckDomains.mockResolvedValue([WARNING_CERT]);

    const ctx = createMockContext({ errors: devopsCheckCerts.errors });
    const input = devopsCheckCerts.input.parse({ domains: ['almost-expired.example.com'] });
    const result = await devopsCheckCerts.handler(input, ctx);

    expect(result.results[0]!.status).toBe('warning');
    expect(result.results[0]!.flags.some((f) => f.includes('warning'))).toBe(true);
    expect(result.results[0]!.cert!.days_until_expiry).toBe(20);
  });

  it('batches multiple domains in one call', async () => {
    const { _mockCheckDomains } = (await import('@/services/cert/cert-service.js')) as {
      _mockCheckDomains: ReturnType<typeof vi.fn>;
    };
    _mockCheckDomains.mockResolvedValue([VALID_CERT, ERROR_CERT]);

    const ctx = createMockContext({ errors: devopsCheckCerts.errors });
    const input = devopsCheckCerts.input.parse({
      domains: ['example.com', 'unreachable.example.com'],
    });
    const result = await devopsCheckCerts.handler(input, ctx);

    expect(result.results).toHaveLength(2);
    expect(_mockCheckDomains).toHaveBeenCalledWith(
      ['example.com', 'unreachable.example.com'],
      443,
      5000,
    );
  });

  it('formats output with cert subject and expiry', async () => {
    const result = { results: [VALID_CERT] };
    const blocks = devopsCheckCerts.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('example.com');
    expect(text).toContain('ok');
    expect(text).toContain('180');
    expect(text).toContain('TLSv1.3');
  });

  it('formats error result gracefully (null cert)', () => {
    const result = { results: [ERROR_CERT] };
    const blocks = devopsCheckCerts.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('error');
    expect(text).toContain('ECONNREFUSED');
  });
});
