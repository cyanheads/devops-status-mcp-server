/**
 * @fileoverview Tests for the devops_check_certs tool.
 * @module tests/mcp-server/tools/definitions/devops-check-certs.tool.test
 */

import { checkServerIdentity, type PeerCertificate } from 'node:tls';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import MarkdownIt from 'markdown-it';
import { describe, expect, it, vi } from 'vitest';
import { devopsCheckCerts } from '@/mcp-server/tools/definitions/devops-check-certs.tool.js';
import type { CertResult } from '@/services/cert/cert-service.js';

/** A CommonMark parser with raw HTML on, as a GFM client parses content[]. */
const commonMark = new MarkdownIt('default', { html: true });

/**
 * The whole content[] text parsed once and read back one source line at a time: text as a
 * reader gets it, every other node named in place (`⟨code_inline:…⟩`, `⟨strong⟩…⟨/strong⟩`,
 * `⟨em⟩`, `⟨html_inline:…⟩`), so an expectation written as text and spans fails on any live
 * syntax.
 */
function readLines(text: string): string[] {
  const lines: string[] = [];
  for (const token of commonMark.parse(text, {})) {
    if (token.type !== 'inline') continue;
    let line = '';
    for (const child of token.children ?? []) {
      if (child.type === 'softbreak' || child.type === 'hardbreak') {
        lines.push(line);
        line = '';
      } else if (child.type === 'text' || child.type === 'text_special') line += child.content;
      else if (child.nesting === 1) line += `⟨${child.tag}⟩`;
      else if (child.nesting === -1) line += `⟨/${child.tag}⟩`;
      else line += `⟨${child.type}:${child.content}⟩`;
    }
    lines.push(line);
  }
  return lines;
}

/** content[] of a tool result as one string. */
const contentText = (content: Array<{ type: string; text?: string }>) =>
  content.map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('\n');

/** A value that reads back byte-identical as its own code span. */
const exact = (value: string): [sent: string, readBack: string] => [
  value,
  `⟨code_inline:${value}⟩`,
];

/** `chain_depth_unavailable_reason` when no issuer for the leaf was found (#86). */
const NO_ISSUER_FOUND =
  'No issuer for the leaf certificate was found among the certificates the server sent or in the trust store, so no chain could be assembled from it, as when a server sends its leaf without the certificate that issued it. Read authorization_error for the chain-trust verdict.';

vi.mock('@/services/cert/cert-service.js', async (importOriginal) => {
  const mockCheckDomains = vi.fn();
  return {
    ...(await importOriginal<typeof import('@/services/cert/cert-service.js')>()),
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
    chain_depth_unavailable_reason: NO_ISSUER_FOUND,
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
    chain_depth_unavailable_reason: NO_ISSUER_FOUND,
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
    chain_depth_unavailable_reason: NO_ISSUER_FOUND,
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

  it('brackets an IPv6 host in the rendered heading, the host reading back as its own span (#68, #75)', () => {
    const blocks = devopsCheckCerts.format!({
      deferred_domains: [],
      results: [{ ...VALID_CERT, domain: '2606:4700:4700::1111', port: 853 }],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('### ✅ [`2606:4700:4700::1111`]:853 — ok');
    expect(readLines(text)).toContain('✅ [⟨code_inline:2606:4700:4700::1111⟩]:853 — ok');
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
    expect(text).toContain(`**Chain depth unavailable:** ${NO_ISSUER_FOUND}`);
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
   * The subject, SANs, and issuer are whatever the inspected host's certificate carries, and a
   * hostname mismatch quotes its SANs, so content[] renders each as its own code span that a
   * CommonMark parse reads back as presented. structuredContent keeps them as presented (#75).
   */
  describe('certificate names in content[] (#75)', () => {
    const SUBJECT = exact(' *CA* [x](https://evil.example) `t` <b> ');
    const SANS: Array<[sent: string, readBack: string]> = [
      exact('*.a.example.com'),
      exact('_x_.example.com'),
      exact('a\\.b\\\\c.example'),
      exact('&amp; &#60; &copy;'),
      exact('``'),
      exact(' both '),
      exact('leading '),
      exact('one, two'),
      ['line\nbreak', '⟨code_inline:line break⟩'],
      ['nul\u0000', '⟨code_inline:nul�⟩'],
      ['', '(empty)'],
    ];
    const ISSUER = exact('Acme *CA* <i>R3</i> &copy;');
    /** The runtime's own message for a host that one-label wildcard SANs do not cover. */
    const MISMATCH = checkServerIdentity('x.y.appspot.com', {
      subject: { CN: '*.appspot.com' },
      subjectaltname:
        'DNS:*.appspot.com, DNS:*.thinkwithgoogle.com, DNS:*.appspot-preview.com, DNS:appspot.com',
    } as unknown as PeerCertificate)?.message;

    it('reads every name back from its own code span, structuredContent as presented', async () => {
      expect(MISMATCH?.split('*').length).toBeGreaterThan(3);
      const NAMES_CERT: CertResult = {
        ...VALID_CERT,
        domain: 'x.y.appspot.com',
        status: 'critical',
        cert: {
          ...VALID_CERT.cert!,
          subject: SUBJECT[0],
          san: SANS.map(([sent]) => sent),
          issuer: ISSUER[0],
          hostname_verification_error: MISMATCH!,
        },
      };
      const { _mockCheckDomains } = (await import(
        '@/services/cert/cert-service.js'
      )) as unknown as { _mockCheckDomains: ReturnType<typeof vi.fn> };
      _mockCheckDomains.mockReset();
      _mockCheckDomains.mockResolvedValue([NAMES_CERT]);

      const result = await runToolContract(devopsCheckCerts, { domains: ['x.y.appspot.com'] });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as { results: CertResult[] };
      expect(structured.results[0]!.cert).toEqual(NAMES_CERT.cert);

      const lines = readLines(contentText(result.content));
      expect(lines).toContain(`⟨strong⟩Subject:⟨/strong⟩ ${SUBJECT[1]}`);
      expect(lines).toContain(`⟨strong⟩SANs:⟨/strong⟩ ${SANS.map(([, r]) => r).join(', ')}`);
      expect(lines).toContain(`⟨strong⟩Issuer:⟨/strong⟩ ${ISSUER[1]}`);
      expect(lines).toContain(`⟨strong⟩Hostname mismatch:⟨/strong⟩ ⟨code_inline:${MISMATCH}⟩`);
      expect(lines).toContain('🔴 ⟨code_inline:x.y.appspot.com⟩:443 — critical');
    });

    /**
     * The hostname-mismatch flag names the inspected host, so content[] renders that host as its
     * own span; every flag keeps its text in structuredContent, and a flag that names no host
     * renders as built (#93).
     */
    it('reads the host in the hostname-mismatch flag back as written, flags kept as built (#93)', async () => {
      const host = '_x_.1.1.1.1.nip.io';
      const flags = [
        'Hostname mismatch — the certificate does not cover _x_.1.1.1.1.nip.io; clients will reject it',
        'HSTS not configured',
      ];
      const { _mockCheckDomains } = (await import(
        '@/services/cert/cert-service.js'
      )) as unknown as { _mockCheckDomains: ReturnType<typeof vi.fn> };
      _mockCheckDomains.mockReset();
      _mockCheckDomains.mockResolvedValue([{ ...MISMATCH_CERT, domain: host, flags }]);

      const result = await runToolContract(devopsCheckCerts, { domains: [host] });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as { results: CertResult[] };
      expect(structured.results[0]!.flags).toEqual(flags);

      const lines = readLines(contentText(result.content));
      expect(lines).toContain(
        '⟨strong⟩Flags:⟨/strong⟩ Hostname mismatch — the certificate does not cover ⟨code_inline:_x_.1.1.1.1.nip.io⟩; clients will reject it | HSTS not configured',
      );
    });

    it('renders flags that name no host as built (#93)', () => {
      const flags = [
        'Certificate expired 40 days ago',
        'Certificate chain not trusted (SELF_SIGNED_CERT_IN_CHAIN); clients will reject it',
        'Self-signed certificate',
        'Insecure TLS version in use: TLSv1.1',
        'HSTS not checked — no HTTP response on port 993',
      ];
      const text = (
        devopsCheckCerts.format!({
          deferred_domains: [],
          results: [{ ...UNTRUSTED_CERT, flags }],
        })[0] as { text: string }
      ).text;
      expect(text).toContain(`**Flags:** ${flags.join(' | ')}`);
    });

    it('renders an empty subject as (empty) and no SANs as none', () => {
      const text = (
        devopsCheckCerts.format!({
          deferred_domains: [],
          results: [{ ...VALID_CERT, cert: { ...VALID_CERT.cert!, subject: '', san: [] } }],
        })[0] as { text: string }
      ).text;
      const lines = readLines(text);
      expect(lines).toContain('⟨strong⟩Subject:⟨/strong⟩ (empty)');
      expect(lines).toContain('⟨strong⟩SANs:⟨/strong⟩ none');
    });

    it("reads the caller's own entries back as sent: heading, error, and deferred list", async () => {
      type Entry =
        | { kind: 'host'; host: string; port: number | null }
        | { kind: 'invalid'; input: string; error: string };
      const { _mockCheckDomains } = (await import(
        '@/services/cert/cert-service.js'
      )) as unknown as { _mockCheckDomains: ReturnType<typeof vi.fn> };
      _mockCheckDomains.mockReset();
      _mockCheckDomains.mockImplementation(async (entries: Entry[]) =>
        entries.map((e) =>
          e.kind === 'invalid'
            ? { ...ERROR_CERT, domain: e.input, error: e.error }
            : e.host === '_x_.example.com'
              ? { ...ERROR_CERT, domain: e.host, error: 'getaddrinfo ENOTFOUND _x_.example.com' }
              : { ...VALID_CERT, domain: e.host },
        ),
      );
      const rejected = '*a* [l](https://e.x) b';
      const deferred = ['*deferred* `x`', ' both ', '[x](y) <b>'];
      const result = await runToolContract(devopsCheckCerts, {
        domains: [
          rejected,
          '_x_.example.com',
          ...Array.from({ length: 8 }, (_, i) => `h${i}.example.com`),
          ...deferred,
        ],
      });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as {
        results: CertResult[];
        deferred_domains: string[];
      };
      expect(structured.results[0]!.domain).toBe(rejected);
      expect(structured.deferred_domains).toEqual(deferred);
      const [rejectedError, lookupError] = structured.results.map((r) => r.error);
      expect(rejectedError).toContain(rejected);

      const lines = readLines(contentText(result.content));
      expect(lines).toContain(`❌ ⟨code_inline:${rejected}⟩:443 — error`);
      expect(lines).toContain(`⟨strong⟩Error:⟨/strong⟩ ${rejectedError}`);
      expect(lines).toContain('❌ ⟨code_inline:_x_.example.com⟩:443 — error');
      expect(lines).toContain(`⟨strong⟩Error:⟨/strong⟩ ${lookupError}`);
      expect(lines).toContain(
        `⟨strong⟩Deferred domains (not inspected):⟨/strong⟩ ${deferred.map((d) => `⟨code_inline:${d}⟩`).join(', ')}`,
      );
    });

    /**
     * Line breaks are flattened before the span is built, so the pass is timed over the two
     * line-break shapes and a backtick run (the span's fence outgrows it), each in its own
     * thread's CPU time across a 64× span of name lengths.
     */
    it.each([
      ['one long line ending in a break', (n: number) => `${'§1 x'.repeat(n / 4)}\ny`],
      ['line breaks throughout', (n: number) => '  \r\n'.repeat(n / 4)],
      ['one backtick run', (n: number) => '`'.repeat(n)],
    ])('renders a certificate name in time linear in its length: %s', (_label, build) => {
      const timings = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000].map((size) => {
        const result = {
          deferred_domains: [],
          results: [{ ...VALID_CERT, cert: { ...VALID_CERT.cert!, subject: build(size) } }],
        };
        devopsCheckCerts.format!(result);
        let best = Number.POSITIVE_INFINITY;
        for (let i = 0; i < 3; i++) {
          const start = process.threadCpuUsage();
          devopsCheckCerts.format!(result);
          const used = process.threadCpuUsage(start);
          best = Math.min(best, used.user + used.system);
        }
        // Absolute bound at this size, before the next (200 ms of this thread's CPU time).
        expect(best).toBeLessThan(200_000);
        return best;
      });
      // A floor on the smallest run keeps timer granularity from inflating the ratio.
      expect(timings.at(-1)! / Math.max(timings[0]!, 50)).toBeLessThan(256);
    });
  });

  it('describes chain_depth as the chain this runtime assembled, and a null depth as a finding (#86)', () => {
    const { chain_depth, chain_depth_unavailable_reason } =
      devopsCheckCerts.output.shape.results.element.shape.cert.unwrap().shape;
    expect(chain_depth.description).toContain(
      'Length of the certificate chain this runtime assembled from the leaf, counting the leaf',
    );
    expect(chain_depth.description).toContain(
      'can differ from the number of certificates the server sent',
    );
    expect(chain_depth.description).not.toContain('Number of certificates the server sent');
    expect(chain_depth_unavailable_reason.description).toContain(
      'no issuer for the leaf was found',
    );
    expect(chain_depth_unavailable_reason.description).not.toContain('runtime limitation');
  });

  it('formats error result gracefully (null cert), stating the failure once', () => {
    const result = { deferred_domains: [], results: [ERROR_CERT] };
    const blocks = devopsCheckCerts.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('### ❌ `unreachable.example.com`:443 — error');
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
        '**Deferred domains (not inspected):** `https://H11.example.com/login`, `h12.example.com:8443`',
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
