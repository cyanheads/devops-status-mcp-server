/**
 * @fileoverview Tests for the devops_check_certs tool.
 * @module tests/mcp-server/tools/definitions/devops-check-certs.tool.test
 */

import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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
    chain_depth_unavailable_reason: null,
    hostname_verification_error: null,
    authorization_error: null,
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
    chain_depth: null,
    chain_depth_unavailable_reason:
      'This runtime did not expose issuerCertificate on the peer certificate.',
    hostname_verification_error: null,
    authorization_error: null,
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
  flags: [],
  cert: null,
  tls: null,
  checked_at: '2025-06-01T00:00:00Z',
  error: 'connect ECONNREFUSED 93.184.216.34:443',
};

/** Chain trust is fine; the certificate simply does not cover the requested hostname. */
const MISMATCH_CERT: CertResult = {
  domain: 'wrong.host.example.com',
  port: 443,
  status: 'critical',
  flags: [
    'Hostname mismatch — the certificate does not cover wrong.host.example.com; clients will reject it',
  ],
  cert: {
    subject: '*.example.com',
    san: ['*.example.com', 'example.com'],
    issuer: "Let's Encrypt",
    valid_from: '2025-01-01T00:00:00Z',
    valid_until: '2026-01-01T00:00:00Z',
    days_until_expiry: 90,
    chain_depth: null,
    chain_depth_unavailable_reason:
      'This runtime did not expose issuerCertificate on the peer certificate.',
    hostname_verification_error:
      "Hostname/IP does not match certificate's altnames: Host: wrong.host.example.com. is not in the cert's altnames: DNS:*.example.com",
    authorization_error: null,
    serial: 'MISMATCH1',
  },
  tls: { protocol: 'TLSv1.2', cipher: 'ECDHE-RSA-AES128-GCM-SHA256' },
  checked_at: '2025-06-01T00:00:00Z',
  error: null,
};

/** Hostname matches; the issuing root is not in the trust store. */
const UNTRUSTED_CERT: CertResult = {
  domain: 'untrusted-root.example.com',
  port: 443,
  status: 'critical',
  flags: ['Certificate chain not trusted (SELF_SIGNED_CERT_IN_CHAIN); clients will reject it'],
  cert: {
    subject: 'untrusted-root.example.com',
    san: ['untrusted-root.example.com'],
    issuer: 'Untrusted Root Certificate Authority',
    valid_from: '2025-01-01T00:00:00Z',
    valid_until: '2027-01-01T00:00:00Z',
    days_until_expiry: 500,
    chain_depth: null,
    chain_depth_unavailable_reason:
      'This runtime did not expose issuerCertificate on the peer certificate.',
    hostname_verification_error: null,
    authorization_error: 'SELF_SIGNED_CERT_IN_CHAIN',
    serial: 'UNTRUSTED1',
  },
  tls: { protocol: 'TLSv1.2', cipher: 'ECDHE-RSA-AES128-GCM-SHA256' },
  checked_at: '2025-06-01T00:00:00Z',
  error: null,
};

describe('devopsCheckCerts', () => {
  it('returns ok status for a healthy certificate', async () => {
    const { _mockCheckDomains } = (await import('@/services/cert/cert-service.js')) as unknown as {
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
    const { _mockCheckDomains } = (await import('@/services/cert/cert-service.js')) as unknown as {
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
    const { _mockCheckDomains } = (await import('@/services/cert/cert-service.js')) as unknown as {
      _mockCheckDomains: ReturnType<typeof vi.fn>;
    };
    _mockCheckDomains.mockResolvedValue([ERROR_CERT]);

    const ctx = createMockContext({ errors: devopsCheckCerts.errors });
    const input = devopsCheckCerts.input.parse({ domains: ['unreachable.example.com'] });
    const result = await devopsCheckCerts.handler(input, ctx);

    expect(result.results[0]!.status).toBe('error');
    expect(result.results[0]!.error).toBe('connect ECONNREFUSED 93.184.216.34:443');
    expect(result.results[0]!.cert).toBeNull();
  });

  it('hands the service a URL or a path-bearing entry as its host (#68)', async () => {
    const { _mockCheckDomains } = (await import('@/services/cert/cert-service.js')) as unknown as {
      _mockCheckDomains: ReturnType<typeof vi.fn>;
    };
    _mockCheckDomains.mockResolvedValue([VALID_CERT, VALID_CERT]);

    const result = await runToolContract(devopsCheckCerts, {
      domains: ['https://example.com', 'example.com/path'],
    });
    expect(result.isError).toBeFalsy();
    expect(_mockCheckDomains).toHaveBeenLastCalledWith(
      [
        { kind: 'host', input: 'https://example.com', host: 'example.com', port: null },
        { kind: 'host', input: 'example.com/path', host: 'example.com', port: null },
      ],
      443,
      5000,
      expect.any(AbortSignal),
    );
  });

  it('hands the service an entry with no host reading as an invalid entry (#68)', async () => {
    const { _mockCheckDomains } = (await import('@/services/cert/cert-service.js')) as unknown as {
      _mockCheckDomains: ReturnType<typeof vi.fn>;
    };
    _mockCheckDomains.mockResolvedValue([VALID_CERT, ERROR_CERT]);

    const ctx = createMockContext({ errors: devopsCheckCerts.errors });
    const input = devopsCheckCerts.input.parse({
      domains: ['example.com:8443', 'user@example.com'],
    });
    await devopsCheckCerts.handler(input, ctx);

    const [entries, port, , signal] = _mockCheckDomains.mock.lastCall as [
      Array<Record<string, unknown>>,
      number,
      number,
      AbortSignal,
    ];
    expect(entries[0]).toEqual({
      kind: 'host',
      input: 'example.com:8443',
      host: 'example.com',
      port: 8443,
    });
    expect(entries[1]).toMatchObject({ kind: 'invalid', input: 'user@example.com' });
    expect(port).toBe(443);
    // The caller's cancellation reaches the service.
    expect(signal).toBe(ctx.signal);
  });

  it('declares no invalid_domain error, since no entry fails the call (#68)', () => {
    expect(devopsCheckCerts.errors).toBeUndefined();
  });

  it('describes the accepted entry shapes and the per-entry port (#68)', () => {
    const domains = devopsCheckCerts.input.shape.domains.description ?? '';
    expect(domains).toContain('a port written on the entry is used for that entry');
    expect(domains).toContain('gets its own result with status "error"');
    expect(domains).not.toContain('Do not include "https://"');
    expect(devopsCheckCerts.input.shape.port.description).toContain(
      'A port written on an entry ("example.com:8443") wins for that entry.',
    );
  });

  it('describes HSTS as judged only on ports that answer HTTP (#65)', () => {
    const { flags, status, error } = devopsCheckCerts.output.shape.results.element.shape;
    expect(flags.description).toContain('"HSTS not checked — no HTTP response on port 993"');
    expect(status.description).toContain('HSTS never changes it');
    expect(error.description).toContain('including a completed handshake whose port never');
    expect(devopsCheckCerts.description).toContain('HSTS presence when the port answers HTTP');
    expect(devopsCheckCerts.description).toContain('a server offering only those is still');
    expect(devopsCheckCerts.input.shape.timeout_ms.description).toContain(
      'a second handshake with TLS 1.0/1.1 enabled',
    );
  });

  it('points at a CAA check when a certificate fails to issue or renew', () => {
    expect(devopsCheckCerts.description).toContain(
      'When a certificate fails to issue or renew, run devops_check_dns with record_types ["CAA"]',
    );
  });

  it('brackets an IPv6 host in the rendered heading (#68)', () => {
    const blocks = devopsCheckCerts.format!({
      deferred_domains: [],
      results: [{ ...VALID_CERT, domain: '2606:4700:4700::1111', port: 853 }],
    });
    expect((blocks[0] as { text: string }).text).toContain('[2606:4700:4700::1111]:853 — ok');
  });

  it('returns warning status for cert expiring in 20 days', async () => {
    const { _mockCheckDomains } = (await import('@/services/cert/cert-service.js')) as unknown as {
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
        chain_depth_unavailable_reason: null,
        hostname_verification_error: null,
        authorization_error: null,
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
    const { _mockCheckDomains } = (await import('@/services/cert/cert-service.js')) as unknown as {
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
      [
        { kind: 'host', input: 'example.com', host: 'example.com', port: null },
        {
          kind: 'host',
          input: 'unreachable.example.com',
          host: 'unreachable.example.com',
          port: null,
        },
      ],
      443,
      5000,
      ctx.signal,
    );
  });

  it('formats output with cert subject and expiry', async () => {
    const result = { deferred_domains: [], results: [VALID_CERT] };
    const blocks = devopsCheckCerts.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('example.com');
    expect(text).toContain('ok');
    expect(text).toContain('180');
    expect(text).toContain('TLSv1.3');
    expect(text).toContain('**Chain depth:** 2');
  });

  it('formats an unavailable chain depth without asserting a count', () => {
    const result = { deferred_domains: [], results: [CRITICAL_CERT] };
    const blocks = devopsCheckCerts.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**Chain depth:** unavailable');
    expect(text).toContain('Chain depth unavailable:');
    expect(text).toContain('issuerCertificate');
    expect(text).not.toContain('**Chain depth:** 1');
  });

  it('formats hostname and chain-trust findings', () => {
    const result = { deferred_domains: [], results: [MISMATCH_CERT, UNTRUSTED_CERT] };
    const blocks = devopsCheckCerts.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Hostname mismatch:');
    expect(text).toContain("is not in the cert's altnames");
    expect(text).toContain('Chain not trusted:');
    expect(text).toContain('SELF_SIGNED_CERT_IN_CHAIN');
  });

  /**
   * The subject, issuer, and SANs are whatever the inspected host's certificate carries, and
   * a hostname mismatch quotes its SANs, so content[] renders them as relayed text: one line
   * each, `<` and entity-starting `&` escaped. structuredContent keeps them as presented.
   */
  it('escapes certificate-supplied names in content[], keeping structuredContent as presented', async () => {
    const MARKUP_CERT: CertResult = {
      ...VALID_CERT,
      domain: 'markup.example.com',
      cert: {
        ...VALID_CERT.cert!,
        subject: 'evil.example\n# heading <b>',
        san: ['<img src=x>.example', 'ok.example'],
        issuer: 'Acme &amp; Co <i>CA</i>',
        hostname_verification_error:
          "Hostname/IP does not match certificate's altnames: Host: markup.example.com. is not in the cert's altnames: DNS:<img src=x>.example",
      },
    };
    const { _mockCheckDomains } = (await import('@/services/cert/cert-service.js')) as unknown as {
      _mockCheckDomains: ReturnType<typeof vi.fn>;
    };
    _mockCheckDomains.mockResolvedValue([MARKUP_CERT]);

    const result = await runToolContract(devopsCheckCerts, { domains: ['markup.example.com'] });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { results: CertResult[] };
    expect(structured.results[0]!.cert).toEqual(MARKUP_CERT.cert);

    const lines = result.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('\n')
      .split('\n');
    expect(lines).toContain('**Subject:** evil.example # heading &lt;b>');
    expect(lines).toContain('**SANs:** &lt;img src=x>.example, ok.example');
    expect(lines).toContain('**Issuer:** Acme &amp;amp; Co &lt;i>CA&lt;/i>');
    expect(lines).toContain(
      "**Hostname mismatch:** Hostname/IP does not match certificate's altnames: Host: markup.example.com. is not in the cert's altnames: DNS:&lt;img src=x>.example",
    );
    expect(lines).not.toContain('# heading <b>');
    expect(lines.some((l) => /<(b|i|img)\b/.test(l))).toBe(false);
  });

  it('formats error result gracefully (null cert), stating the failure once', () => {
    const result = { deferred_domains: [], results: [ERROR_CERT] };
    const blocks = devopsCheckCerts.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('### ❌ unreachable.example.com:443 — error');
    expect(text.split('ECONNREFUSED')).toHaveLength(2);
    expect(text).not.toContain('**Flags:**');
  });

  it('describes flags as empty when no handshake completed, kept when one did (#45, #49)', () => {
    const flags = devopsCheckCerts.output.shape.results.element.shape.flags.description;
    expect(flags).toContain('Empty when the connection never completed a handshake');
    expect(flags).toContain('A handshake that completed without a certificate keeps');
  });

  describe('input bounds (#69)', () => {
    type Entry = { kind: 'host'; host: string } | { kind: 'invalid'; input: string };
    type Structured = { results: CertResult[]; deferred_domains: string[]; notice?: string };

    async function call(args: Record<string, unknown>) {
      const { _mockCheckDomains } = (await import(
        '@/services/cert/cert-service.js'
      )) as unknown as { _mockCheckDomains: ReturnType<typeof vi.fn> };
      // One row per entry, named as the service names it, so the rows mirror what was inspected.
      _mockCheckDomains.mockReset();
      _mockCheckDomains.mockImplementation(async (entries: Entry[]) =>
        entries.map((e) => ({ ...VALID_CERT, domain: e.kind === 'host' ? e.host : e.input })),
      );
      const result = await runToolContract(devopsCheckCerts, args as never);
      const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      const [entries, port, timeout] = (_mockCheckDomains.mock.lastCall ?? []) as [
        Entry[],
        number,
        number,
      ];
      return {
        result,
        text,
        structured: result.structuredContent as Structured,
        entries,
        port,
        timeout,
      };
    }

    const names = (count: number, from = 1) =>
      Array.from({ length: count }, (_, i) => `h${from + i}.example.com`);

    it('inspects the first 10 hosts and returns the rest verbatim in deferred_domains', async () => {
      const domains = [...names(10), 'https://H11.example.com/login', 'h12.example.com:8443'];
      const { result, structured, entries, text } = await call({ domains });

      expect(result.isError).toBeFalsy();
      expect(entries.map((e) => (e.kind === 'host' ? e.host : e.input))).toEqual(names(10));
      expect(structured.results.map((r) => r.domain)).toEqual(names(10));
      expect(structured.deferred_domains).toEqual([
        'https://H11.example.com/login',
        'h12.example.com:8443',
      ]);
      const notice =
        'Only the first 10 of 12 domains were inspected (10 per call); resend the 2 in deferred_domains in another call.';
      expect(structured.notice).toBe(notice);
      expect(text.split(notice)).toHaveLength(2);
      expect(text).toContain(
        '**Deferred domains (not inspected):** https://H11.example.com/login, h12.example.com:8443',
      );
    });

    it('lets an entry with no single host within the first 10 take a slot as its own row', async () => {
      const { structured, entries } = await call({
        domains: [...names(9), 'user@example.com', 'h10.example.com'],
      });

      expect(entries).toHaveLength(10);
      expect(entries[9]).toMatchObject({ kind: 'invalid', input: 'user@example.com' });
      expect(structured.deferred_domains).toEqual(['h10.example.com']);
    });

    it('accepts 100 hosts and rejects 101, naming 100', async () => {
      const hundred = await call({ domains: names(100) });
      expect(hundred.result.isError).toBeFalsy();
      expect(hundred.entries).toHaveLength(10);
      expect(hundred.structured.deferred_domains).toEqual(names(90, 11));

      const over = await call({ domains: names(101) });
      expect(over.result.isError).toBe(true);
      expect(over.entries).toBeUndefined();
      expect(
        (over.result.structuredContent as { error: { message: string } }).error.message,
      ).toContain('<=100 items');
    });

    it('serves a timeout_ms over 15000 at 15000 and says so, keeping the 1000 floor', async () => {
      const { timeout, structured, text } = await call({
        domains: ['example.com'],
        timeout_ms: 15001,
      });
      expect(timeout).toBe(15000);
      const notice = 'timeout_ms 15001 is past the maximum of 15000; 15000 was used.';
      expect(structured.notice).toBe(notice);
      expect(text.split(notice)).toHaveLength(2);

      const floor = await call({ domains: ['example.com'], timeout_ms: 999 });
      expect(floor.result.isError).toBe(true);
      expect(floor.entries).toBeUndefined();
    });

    it('keeps rejecting a port outside 1–65535', async () => {
      for (const port of [0, 65536]) {
        const { result, entries } = await call({ domains: ['example.com'], port });
        expect(result.isError).toBe(true);
        expect(entries).toBeUndefined();
      }
    });

    it('joins the deferral and the timeout clamp into one notice', async () => {
      const { structured } = await call({ domains: names(11), timeout_ms: 20000 });
      expect(structured.notice).toBe(
        'Only the first 10 of 11 domains were inspected (10 per call); resend the 1 in deferred_domains in another call. ' +
          'timeout_ms 20000 is past the maximum of 15000; 15000 was used.',
      );
    });

    it('serves a call at every cap unchanged, with an empty deferred list and no notice', async () => {
      const { result, structured, entries, port, timeout, text } = await call({
        domains: names(10),
        port: 8443,
        timeout_ms: 15000,
      });

      expect(result.isError).toBeFalsy();
      expect(entries).toHaveLength(10);
      expect(port).toBe(8443);
      expect(timeout).toBe(15000);
      expect(structured.results.map((r) => r.domain)).toEqual(names(10));
      expect(structured).not.toHaveProperty('notice');
      expect(text).not.toContain('per call');
      expect(text).not.toContain('Deferred');
      expect(structured.deferred_domains).toEqual([]);
    });

    it('states the caps in the input descriptions', () => {
      const { domains, timeout_ms } = devopsCheckCerts.input.shape;
      expect(domains.description).toContain('deferred_domains');
      expect(domains.description).toContain('up to 100 are accepted');
      expect(timeout_ms.description).toContain('a value over 15000 is served as 15000');
    });
  });
});
