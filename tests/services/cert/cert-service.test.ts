/**
 * @fileoverview Tests for the CertService expiry thresholds, hostname and chain-trust
 * verification, status classification, and flag emission.
 * Mocks node:tls to simulate TLS handshake responses without real network I/O.
 * @module tests/services/cert/cert-service.test
 */

import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { DEFAULT_CIPHERS } from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ──────────────────────────────────────────────
// node:tls mock — must run before any import that uses it
// ──────────────────────────────────────────────

/** State shared between test and the mock socket factory. */
let mockSocketConfig: {
  /** If set, the 'connect' callback is never called; instead 'error' is emitted. */
  error?: Error;
  /** If true, the socket never connects and never errors — the handshake hangs. */
  hang?: boolean;
  /** Cert fields returned by getPeerCertificate(). */
  cert?: Record<string, unknown>;
  /** TLS protocol string. */
  protocol?: string;
  /** Cipher name. */
  cipherName?: string;
  /** If true, emit 'end' instead of writing HSTS data response. */
  noHstsResponse?: boolean;
  /** HSTS header present in response. */
  hsts?: boolean;
  /** What tls.checkServerIdentity() returns — an Error means the hostname is not covered. */
  hostnameError?: Error;
  /** socket.authorized — chain verification outcome. */
  authorized?: boolean;
  /** socket.authorizationError — a bare OpenSSL code string, or an Error carrying one. */
  authorizationError?: string | NodeJS.ErrnoException;
} = {};

class MockTlsSocket extends EventEmitter {
  private _destroyed = false;

  get authorized(): boolean {
    return mockSocketConfig.authorized ?? true;
  }

  get authorizationError(): unknown {
    return mockSocketConfig.authorizationError ?? null;
  }

  write(_data: string) {
    if (this._destroyed) return false;
    // Simulate server HTTP response on the TLS socket
    const { hsts = true, noHstsResponse = false } = mockSocketConfig;

    if (noHstsResponse) {
      // No response — let end fire
      setImmediate(() => this.emit('end'));
      return true;
    }

    const hstsHeader = hsts ? 'Strict-Transport-Security: max-age=31536000\r\n' : '';
    const response = `HTTP/1.1 200 OK\r\n${hstsHeader}Content-Length: 0\r\n\r\n`;
    setImmediate(() => {
      if (!this._destroyed) this.emit('data', Buffer.from(response));
    });
    return true;
  }

  getPeerCertificate(): Record<string, unknown> {
    return mockSocketConfig.cert ?? {};
  }

  getProtocol(): string {
    return mockSocketConfig.protocol ?? 'TLSv1.3';
  }

  getCipher(): { name: string } {
    return { name: mockSocketConfig.cipherName ?? 'TLS_AES_256_GCM_SHA384' };
  }

  destroy() {
    this._destroyed = true;
  }
}

/** The options of every `tls.connect` call the mock received, in call order. */
let connectCalls: Array<Record<string, unknown>> = [];

/** When true, `connect` and `checkServerIdentity` are the real ones (loopback-server tests). */
let realTls = false;

vi.mock('node:tls', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:tls')>();
  return {
    ...actual,
    /**
     * Invokes the caller's `checkServerIdentity` before the connect callback, mirroring the real
     * handshake — that is where the service captures Node's hostname-verification result.
     */
    connect: (
      opts: import('node:tls').ConnectionOptions & {
        checkServerIdentity?: (host: string, cert: unknown) => Error | undefined;
      },
      callback?: () => void,
    ) => {
      connectCalls.push(opts as Record<string, unknown>);
      if (realTls) return actual.connect(opts, callback);
      const socket = new MockTlsSocket();
      setImmediate(() => {
        if (mockSocketConfig.hang) return;
        if (mockSocketConfig.error) {
          socket.emit('error', mockSocketConfig.error);
          return;
        }
        opts.checkServerIdentity?.(opts.host ?? '', mockSocketConfig.cert ?? {});
        if (callback) callback();
      });
      return socket;
    },
    checkServerIdentity: (host: string, cert: import('node:tls').PeerCertificate) =>
      realTls ? actual.checkServerIdentity(host, cert) : mockSocketConfig.hostnameError,
  };
});

// ──────────────────────────────────────────────
// SSRF guard mock — unit tests for TLS logic; guard behavior is tested in ssrf-guard.test.ts.
// Sentinel stripping stays real, since the rejected-domain error text depends on it.
// ──────────────────────────────────────────────

vi.mock('@/utils/ssrf-guard.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/ssrf-guard.js')>()),
  assertSafeDomain: vi.fn().mockResolvedValue(undefined),
  assertSafeUrl: vi.fn().mockResolvedValue(undefined),
  assertSafeResolverIp: vi.fn(),
}));

// ──────────────────────────────────────────────
// Import AFTER the mock is registered
// ──────────────────────────────────────────────

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { devopsCheckCerts } from '@/mcp-server/tools/definitions/devops-check-certs.tool.js';
import type { CertResult } from '@/services/cert/cert-service.js';
import {
  CertService,
  getCertService,
  initCertService,
  inspectCert,
} from '@/services/cert/cert-service.js';
import { normalizeDomainInput } from '@/utils/domain-input.js';
import { type LoopbackTlsServer, startTlsServer } from './loopback-tls-server.js';

/** Run `checkDomains` the way the tool does: each host normalized, with a live signal. */
function checkHosts(
  service: CertService,
  hosts: string[],
  port: number,
  timeoutMs: number,
  signal = new AbortController().signal,
): Promise<CertResult[]> {
  const entries = hosts.map((host) => normalizeDomainInput(host, 'tls'));
  return service.checkDomains(entries, port, timeoutMs, signal);
}

/** Milliseconds from now for a cert that expires in `days` days. */
function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

/** Build a fake tls.DetailedPeerCertificate-like object. */
function fakeCert(daysUntilExpiry: number, isSelfSigned = false): Record<string, unknown> {
  const validUntil = daysFromNow(daysUntilExpiry);
  const validFrom = daysFromNow(-100);
  const cn = isSelfSigned ? 'self.example.com' : 'example.com';
  return {
    subject: { CN: cn },
    issuer: { CN: isSelfSigned ? cn : "Let's Encrypt" },
    valid_from: validFrom.toString(),
    valid_to: validUntil.toString(),
    subjectaltname: `DNS:${cn}`,
    serialNumber: 'AABBCC1122',
    // no issuerCertificate — matches what the runtime actually exposes for a real handshake
  };
}

describe('CertService — expiry and flag logic via node:tls mock', () => {
  beforeEach(() => {
    initCertService();
    // Reset to safe defaults
    mockSocketConfig = { cert: fakeCert(200), protocol: 'TLSv1.3', hsts: true };
  });

  afterEach(() => {
    mockSocketConfig = {};
  });

  it('init/accessor pattern works', () => {
    expect(getCertService()).toBeDefined();
  });

  it('healthy cert (>30 days) + HSTS + TLSv1.3 → status ok, flag HSTS present', async () => {
    mockSocketConfig = { cert: fakeCert(200), protocol: 'TLSv1.3', hsts: true };
    const service = getCertService();
    const results = await checkHosts(service, ['example.com'], 443, 5000);
    expect(results[0]!.status).toBe('ok');
    expect(results[0]!.flags).toContain('HSTS present');
    expect(results[0]!.tls!.protocol).toBe('TLSv1.3');
    // A trusted, hostname-matching certificate carries no verification finding.
    expect(results[0]!.cert!.hostname_verification_error).toBeNull();
    expect(results[0]!.cert!.authorization_error).toBeNull();
  });

  it('cert expiring in 20 days → status warning, flag contains "warning"', async () => {
    mockSocketConfig = { cert: fakeCert(20), protocol: 'TLSv1.3', hsts: true };
    const service = getCertService();
    const results = await checkHosts(service, ['soon.com'], 443, 5000);
    expect(results[0]!.status).toBe('warning');
    expect(results[0]!.flags.some((f) => f.includes('warning'))).toBe(true);
    expect(results[0]!.cert!.days_until_expiry).toBeGreaterThanOrEqual(19);
    expect(results[0]!.cert!.days_until_expiry).toBeLessThan(30);
  });

  it('cert expiring in 5 days → status critical, flag contains CRITICAL', async () => {
    mockSocketConfig = { cert: fakeCert(5), protocol: 'TLSv1.3', hsts: true };
    const service = getCertService();
    const results = await checkHosts(service, ['expiring.com'], 443, 5000);
    expect(results[0]!.status).toBe('critical');
    expect(results[0]!.flags.some((f) => f.includes('CRITICAL'))).toBe(true);
    expect(results[0]!.cert!.days_until_expiry).toBeLessThan(7);
  });

  it('HSTS not configured → flag "HSTS not configured", status still ok for healthy cert', async () => {
    mockSocketConfig = { cert: fakeCert(200), protocol: 'TLSv1.3', hsts: false };
    const service = getCertService();
    const results = await checkHosts(service, ['nohsts.com'], 443, 5000);
    expect(results[0]!.flags).toContain('HSTS not configured');
    // A healthy cert with no HSTS is 'ok' (HSTS flag is informational, not a status upgrade)
    expect(results[0]!.status).toBe('ok');
  });

  it('TLSv1.1 protocol → status critical, flag mentions Insecure TLS', async () => {
    mockSocketConfig = { cert: fakeCert(200), protocol: 'TLSv1.1', hsts: true };
    const service = getCertService();
    const results = await checkHosts(service, ['oldtls.com'], 443, 5000);
    expect(results[0]!.status).toBe('critical');
    expect(results[0]!.tls!.protocol).toBe('TLSv1.1');
    expect(results[0]!.flags.some((f) => f.includes('Insecure TLS'))).toBe(true);
  });

  it('TLSv1.0 protocol → status critical, flag mentions Insecure TLS', async () => {
    mockSocketConfig = { cert: fakeCert(200), protocol: 'TLSv1', hsts: true };
    const service = getCertService();
    const results = await checkHosts(service, ['tls10.com'], 443, 5000);
    expect(results[0]!.status).toBe('critical');
    expect(results[0]!.flags.some((f) => f.includes('Insecure TLS'))).toBe(true);
  });

  it('connection error → status error, cert and tls null, failure in error only', async () => {
    mockSocketConfig = { error: new Error('getaddrinfo ENOTFOUND unreachable.com') };
    const service = getCertService();
    const results = await checkHosts(service, ['unreachable.com'], 443, 5000);
    expect(results[0]!.status).toBe('error');
    expect(results[0]!.cert).toBeNull();
    expect(results[0]!.tls).toBeNull();
    expect(results[0]!.error).toBe('getaddrinfo ENOTFOUND unreachable.com');
    // `flags` holds findings about an inspected certificate; nothing was inspected (#45).
    expect(results[0]!.flags).toEqual([]);
  });

  it('timeout → status error, cert and tls null, failure in error only', async () => {
    mockSocketConfig = { hang: true };
    const results = await checkHosts(getCertService(), ['slow.example.com'], 81, 30);
    expect(results[0]).toMatchObject({
      domain: 'slow.example.com',
      port: 81,
      status: 'error',
      cert: null,
      tls: null,
      flags: [],
      error: 'Timed out after 30ms',
    });
  });

  it('batch: one success, one error — each row keeps its own outcome, in entry order', async () => {
    // Keyed by host, not call order: both connects start before either socket settles.
    const connectSpy = vi.fn((opts: { host?: string }, cb?: () => void) => {
      const socket = new MockTlsSocket();
      setImmediate(() => {
        if (opts.host === 'fail.com') socket.emit('error', new Error('ECONNREFUSED'));
        else cb?.();
      });
      return socket;
    });
    // Temporarily replace connect
    const tlsMod = await import('node:tls');
    const savedConnect = tlsMod.connect;
    Object.defineProperty(tlsMod, 'connect', { value: connectSpy, configurable: true });

    try {
      const service = new CertService();
      const results = await checkHosts(service, ['ok.com', 'fail.com'], 443, 3000);
      expect(results.map((r) => [r.domain, r.status, r.error])).toEqual([
        ['ok.com', 'ok', null],
        ['fail.com', 'error', 'ECONNREFUSED'],
      ]);
      expect(connectSpy).toHaveBeenCalledTimes(2);
    } finally {
      Object.defineProperty(tlsMod, 'connect', { value: savedConnect, configurable: true });
    }
  });
});

describe('CertService — a domain rejected before any connection (#45)', () => {
  const GUARD_SENTENCE =
    'Domain "localhost" names a known internal host ("localhost"). Requests to private, loopback, or cloud-metadata addresses are not permitted. Set DEVOPS_STATUS_ALLOW_PRIVATE_TARGETS=true to allow internal-network monitoring.';

  beforeEach(async () => {
    initCertService();
    mockSocketConfig = { cert: fakeCert(200), protocol: 'TLSv1.3', hsts: true };
    const { assertSafeDomain } = await import('@/utils/ssrf-guard.js');
    vi.mocked(assertSafeDomain).mockRejectedValueOnce(new Error(`SSRF_BLOCKED: ${GUARD_SENTENCE}`));
  });

  afterEach(() => {
    mockSocketConfig = {};
  });

  it('reports the failure in error only, without the internal sentinel', async () => {
    const results = await checkHosts(getCertService(), ['localhost'], 443, 5000);
    expect(results[0]).toMatchObject({
      domain: 'localhost',
      port: 443,
      status: 'error',
      cert: null,
      tls: null,
      flags: [],
      error: GUARD_SENTENCE,
    });
  });

  it('keeps a non-guard rejection message as-is', async () => {
    const { assertSafeDomain } = await import('@/utils/ssrf-guard.js');
    vi.mocked(assertSafeDomain).mockRejectedValueOnce(
      new Error('getaddrinfo ENOTFOUND other.example'),
    );
    const results = await checkHosts(getCertService(), ['localhost', 'other.example'], 443, 5000);
    expect(results[0]!.error).toBe(GUARD_SENTENCE);
    expect(results[1]).toMatchObject({
      domain: 'other.example',
      status: 'error',
      flags: [],
      error: 'getaddrinfo ENOTFOUND other.example',
    });
  });

  it('renders the failure once through devops_check_certs', async () => {
    const result = await runToolContract(devopsCheckCerts, {
      domains: ['localhost', 'example.com'],
      timeout_ms: 5000,
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { results: CertResult[] };
    expect(structured.results[0]).toMatchObject({
      status: 'error',
      flags: [],
      error: GUARD_SENTENCE,
    });
    // The healthy domain beside it keeps its findings.
    expect(structured.results[1]).toMatchObject({ status: 'ok', flags: ['HSTS present'] });

    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text.split(GUARD_SENTENCE)).toHaveLength(2);
    expect(text).not.toContain('SSRF_BLOCKED');
    const localhostBlock = text.split('### ')[1] ?? '';
    expect(localhostBlock).toContain('❌ localhost:443 — error');
    expect(localhostBlock).not.toContain('**Flags:**');
  });
});

describe('CertService — a handshake that presents no certificate (#49)', () => {
  beforeEach(() => {
    initCertService();
    // getPeerCertificate() returns an object with no subject: the handshake completed, no cert.
    mockSocketConfig = { cert: {}, protocol: 'TLSv1.3', hsts: false };
  });

  afterEach(() => {
    mockSocketConfig = {};
  });

  it('reports status error with a reason, keeping the TLS session and its findings', async () => {
    const results = await checkHosts(getCertService(), ['no-cert.example.com'], 443, 5000);
    expect(results[0]).toMatchObject({
      domain: 'no-cert.example.com',
      status: 'error',
      cert: null,
      tls: { protocol: 'TLSv1.3', cipher: 'TLS_AES_256_GCM_SHA384' },
      flags: ['HSTS not configured'],
      error: 'The TLS handshake completed but the server presented no certificate.',
    });
  });

  it('keeps an insecure-TLS finding and names the cause when the connection ends early', async () => {
    mockSocketConfig = { cert: {}, protocol: 'TLSv1.1', noHstsResponse: true };
    const results = await checkHosts(getCertService(), ['no-cert.example.com'], 443, 5000);
    expect(results[0]!.status).toBe('error');
    // A close with no HTTP reply says nothing about HSTS (#65).
    expect(results[0]!.flags).toEqual([
      'Insecure TLS version in use: TLSv1.1',
      'HSTS not checked — no HTTP response on port 443',
    ]);
    expect(results[0]!.error).toBe(
      'The TLS handshake completed but the server presented no certificate.',
    );
  });

  it('renders the reason once through devops_check_certs', async () => {
    const result = await runToolContract(devopsCheckCerts, {
      domains: ['no-cert.example.com'],
      timeout_ms: 5000,
    });

    expect(result.isError).toBeFalsy();
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text.split('presented no certificate')).toHaveLength(2);
    expect(text).toContain('❌ no-cert.example.com:443 — error');
    expect(text).toContain('**TLS:** TLSv1.3 / TLS_AES_256_GCM_SHA384');
  });
});

describe('CertService — hostname and chain-trust verification', () => {
  beforeEach(() => {
    initCertService();
    mockSocketConfig = { cert: fakeCert(200), protocol: 'TLSv1.3', hsts: false };
  });

  afterEach(() => {
    mockSocketConfig = {};
  });

  it('hostname mismatch → status critical with the verification message on the cert', async () => {
    /**
     * The chain is trusted and `authorized` is true — overriding checkServerIdentity makes it so
     * even for a wrong-host certificate, which is why the explicit check is the only signal here.
     */
    mockSocketConfig = {
      cert: fakeCert(200),
      protocol: 'TLSv1.3',
      hsts: false,
      authorized: true,
      hostnameError: new Error(
        "Hostname/IP does not match certificate's altnames: Host: wrong.host.example.com. is not in the cert's altnames: DNS:example.com",
      ),
    };
    const results = await checkHosts(getCertService(), ['wrong.host.example.com'], 443, 5000);

    expect(results[0]!.status).toBe('critical');
    expect(results[0]!.cert!.hostname_verification_error).toContain('does not match');
    expect(
      results[0]!.flags.some((f) =>
        f.startsWith('Hostname mismatch — the certificate does not cover wrong.host.example.com'),
      ),
    ).toBe(true);
  });

  it('untrusted root → status critical with the chain-verification code', async () => {
    // Issuer differs from subject, so the self-signed heuristic alone would find nothing.
    mockSocketConfig = {
      cert: fakeCert(200),
      protocol: 'TLSv1.3',
      hsts: false,
      authorized: false,
      authorizationError: 'SELF_SIGNED_CERT_IN_CHAIN',
    };
    const results = await checkHosts(getCertService(), ['untrusted-root.example.com'], 443, 5000);

    expect(results[0]!.status).toBe('critical');
    expect(results[0]!.cert!.authorization_error).toBe('SELF_SIGNED_CERT_IN_CHAIN');
    expect(
      results[0]!.flags.some((f) =>
        f.includes('Certificate chain not trusted (SELF_SIGNED_CERT_IN_CHAIN)'),
      ),
    ).toBe(true);
  });

  it('self-signed cert → status critical, flag "Self-signed certificate"', async () => {
    mockSocketConfig = {
      cert: fakeCert(200, true),
      protocol: 'TLSv1.3',
      hsts: false,
      authorized: false,
      authorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT',
    };
    const results = await checkHosts(getCertService(), ['self.example.com'], 443, 5000);

    expect(results[0]!.flags).toContain('Self-signed certificate');
    expect(results[0]!.cert!.authorization_error).toBe('DEPTH_ZERO_SELF_SIGNED_CERT');
    // A self-signed certificate is as hard a client-side rejection as an expired one.
    expect(results[0]!.status).toBe('critical');
  });

  it('normalizes an Error-shaped authorizationError to its OpenSSL code', async () => {
    const err = new Error('unable to verify the first certificate') as NodeJS.ErrnoException;
    err.code = 'UNABLE_TO_VERIFY_LEAF_SIGNATURE';
    mockSocketConfig = {
      cert: fakeCert(200),
      protocol: 'TLSv1.3',
      hsts: false,
      authorized: false,
      authorizationError: err,
    };
    const results = await checkHosts(getCertService(), ['no-intermediate.example.com'], 443, 5000);

    expect(results[0]!.cert!.authorization_error).toBe('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    expect(results[0]!.status).toBe('critical');
  });

  it('does not repeat an expiry rejection as a separate chain-trust flag', async () => {
    mockSocketConfig = {
      cert: fakeCert(-40),
      protocol: 'TLSv1.3',
      hsts: false,
      authorized: false,
      authorizationError: 'CERT_HAS_EXPIRED',
    };
    const results = await checkHosts(getCertService(), ['expired.example.com'], 443, 5000);

    expect(results[0]!.status).toBe('critical');
    expect(results[0]!.cert!.authorization_error).toBe('CERT_HAS_EXPIRED');
    expect(results[0]!.flags.some((f) => f.startsWith('Certificate expired'))).toBe(true);
    expect(results[0]!.flags.some((f) => f.includes('Certificate chain not trusted'))).toBe(false);
  });
});

describe('CertService — chain depth', () => {
  beforeEach(() => {
    initCertService();
  });

  afterEach(() => {
    mockSocketConfig = {};
  });

  it('reports chain_depth null with a reason when issuerCertificate is not exposed', async () => {
    // The runtime leaves issuerCertificate unset even for CA-issued chains; a leaf-only "1"
    // would read as "no intermediates were served", which is false.
    mockSocketConfig = { cert: fakeCert(200), protocol: 'TLSv1.3', hsts: true };
    const results = await checkHosts(getCertService(), ['ca-issued.example.com'], 443, 5000);

    expect(results[0]!.cert!.chain_depth).toBeNull();
    expect(results[0]!.cert!.chain_depth_unavailable_reason).toContain('issuerCertificate');
    // Chain trust is answered by authorization_error, never inferred from a depth of 1.
    expect(results[0]!.cert!.authorization_error).toBeNull();
    expect(results[0]!.status).toBe('ok');
  });

  it('counts the chain when issuerCertificate is present', async () => {
    const leaf = fakeCert(200);
    leaf.issuerCertificate = {
      subject: { CN: "Let's Encrypt R3" },
      issuer: { CN: 'ISRG Root X1' },
    };
    mockSocketConfig = { cert: leaf, protocol: 'TLSv1.3', hsts: true };
    const results = await checkHosts(getCertService(), ['chained.com'], 443, 5000);

    expect(results[0]!.cert!.chain_depth).toBe(2);
    expect(results[0]!.cert!.chain_depth_unavailable_reason).toBeNull();
  });
});

describe('devops_check_certs domains entries (#68)', () => {
  beforeEach(() => {
    initCertService();
    connectCalls = [];
    mockSocketConfig = { cert: fakeCert(200), protocol: 'TLSv1.3', hsts: true };
  });

  afterEach(() => {
    mockSocketConfig = {};
  });

  async function check(args: { domains: string[]; port?: number }) {
    const result = await runToolContract(devopsCheckCerts, { timeout_ms: 5000, ...args });
    expect(result.isError).toBeFalsy();
    return (result.structuredContent as { results: CertResult[] }).results;
  }

  it('connects to a plain or trailing-dot hostname as given', async () => {
    const results = await check({ domains: ['example.com', 'example.com.'] });
    expect(results.map((r) => [r.domain, r.port, r.status])).toEqual([
      ['example.com', 443, 'ok'],
      ['example.com.', 443, 'ok'],
    ]);
    expect(connectCalls.map((c) => [c.host, c.port])).toEqual([
      ['example.com', 443],
      ['example.com.', 443],
    ]);
  });

  it('still rejects an empty string at the schema', async () => {
    const result = await runToolContract(devopsCheckCerts, { domains: [''] });
    expect(result.isError).toBe(true);
    expect(connectCalls).toEqual([]);
  });

  it('uses a port written on the entry for that row', async () => {
    const results = await check({ domains: ['example.com:8443', 'example.com'] });
    expect(results.map((r) => [r.domain, r.port])).toEqual([
      ['example.com', 8443],
      ['example.com', 443],
    ]);
    expect(connectCalls.map((c) => [c.host, c.port])).toEqual([
      ['example.com', 8443],
      ['example.com', 443],
    ]);
  });

  it('lets a written port win over the port input, and reduces a URL to its host', async () => {
    const results = await check({ domains: ['HTTP://Example.com:443/'], port: 8443 });
    expect(results[0]).toMatchObject({ domain: 'example.com', port: 443, status: 'ok' });
    expect(connectCalls[0]).toMatchObject({ host: 'example.com', port: 443 });
  });

  it('connects to the ASCII form of a Unicode name', async () => {
    const results = await check({ domains: ['münchen.de'] });
    expect(results[0]!.domain).toBe('xn--mnchen-3ya.de');
    expect(connectCalls[0]).toMatchObject({ host: 'xn--mnchen-3ya.de' });
  });

  it('connects to a bracketed IPv6 literal by its address and port', async () => {
    const results = await check({ domains: ['[2606:4700:4700::1111]:443'], port: 8443 });
    expect(results[0]).toMatchObject({ domain: '2606:4700:4700::1111', port: 443 });
    expect(connectCalls[0]).toMatchObject({ host: '2606:4700:4700::1111', port: 443 });

    const result = await runToolContract(devopsCheckCerts, {
      domains: ['[2606:4700:4700::1111]:443'],
      timeout_ms: 5000,
    });
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('[2606:4700:4700::1111]:443 — ok');
  });

  it('reports each entry with no host reading in its own row and checks the rest', async () => {
    const domains = ['example.com', 'user@example.com', ' ', '-bad.com', 'example.com:99999'];
    const results = await check({ domains });

    expect(results).toHaveLength(5);
    expect(results[0]).toMatchObject({ domain: 'example.com', status: 'ok' });
    for (const [i, raw] of domains.entries()) {
      if (i === 0) continue;
      expect(results[i]).toMatchObject({
        domain: raw,
        port: 443,
        status: 'error',
        cert: null,
        tls: null,
        flags: [],
      });
      expect(results[i]!.error).toContain(JSON.stringify(raw));
      expect(results[i]!.error).toContain('Pass a hostname ("example.com")');
    }
    expect(connectCalls.map((c) => c.host)).toEqual(['example.com']);
  });

  it('runs the SSRF guard on the normalized address and never connects to it', async () => {
    const { assertSafeDomain } = await import('@/utils/ssrf-guard.js');
    const actual =
      await vi.importActual<typeof import('@/utils/ssrf-guard.js')>('@/utils/ssrf-guard.js');
    vi.mocked(assertSafeDomain).mockImplementation(actual.assertSafeDomain);
    try {
      const results = await check({
        domains: [
          'https://10.0.0.1/',
          'https://169.254.169.254/latest/meta-data',
          'http://0x7f.1:8080/',
          '[::1]:443',
        ],
      });
      expect(results.map((r) => [r.domain, r.port, r.status])).toEqual([
        ['10.0.0.1', 443, 'error'],
        ['169.254.169.254', 443, 'error'],
        ['127.0.0.1', 8080, 'error'],
        ['::1', 443, 'error'],
      ]);
      expect(results[0]!.error).toContain('resolves to 10.0.0.1 (private (RFC 1918))');
      expect(results[1]!.error).toContain('resolves to 169.254.169.254 (link-local');
      expect(results[2]!.error).toContain('resolves to 127.0.0.1 (loopback)');
      expect(results[3]!.error).toContain('resolves to ::1 (loopback)');
      expect(connectCalls).toEqual([]);
    } finally {
      vi.mocked(assertSafeDomain).mockReset();
      vi.mocked(assertSafeDomain).mockResolvedValue(undefined);
    }
  });
});

/**
 * The real handshake against loopback servers: what the service keeps when the port does not
 * answer HTTP, the legacy-TLS retry, SNI, one deadline across attempts, and caller cancellation.
 * The certificate is self-signed for localhost, so a completed check grades `critical`.
 *
 * The timing cases fake only `setTimeout`/`clearTimeout`, which carry the `timeout_ms` deadline;
 * the sockets stay real. The clock moves only when a case advances it, so a check that settles
 * did so on its own I/O or at the exact deadline step, never on how fast the machine is.
 */
describe('inspectCert against loopback TLS servers (#65)', () => {
  let server: LoopbackTlsServer | undefined;
  const live = () => new AbortController().signal;
  const notChecked = (port: number) => `HSTS not checked — no HTTP response on port ${port}`;
  const fakeDeadline = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  /** Waits on real I/O (node:timers/promises is never faked) until `condition` holds. */
  async function until(condition: () => boolean) {
    while (!condition()) await sleep(5);
  }

  /** Whether `promise` has settled, read without awaiting it. */
  function track(promise: Promise<unknown>) {
    const state = { settled: false };
    promise.then(
      () => {
        state.settled = true;
      },
      () => {
        state.settled = true;
      },
    );
    return state;
  }

  /** Move the fake clock, then let every continuation it released run. */
  async function advance(ms: number) {
    await vi.advanceTimersByTimeAsync(ms);
    await sleep(0);
  }

  beforeEach(() => {
    realTls = true;
    connectCalls = [];
  });

  afterEach(async () => {
    vi.useRealTimers();
    realTls = false;
    await server?.close();
    server = undefined;
  });

  async function serve(mode: Parameters<typeof startTlsServer>[0]) {
    server = await startTlsServer(mode);
    return server;
  }

  /** The row of a completed handshake whose port gave no HTTP reply. */
  function expectCertKeptWithoutHsts(result: CertResult, port: number) {
    expect(result.error).toBeNull();
    expect(result.status).toBe('critical');
    expect(result.cert?.subject).toBe('localhost');
    expect(result.cert?.san).toEqual(['localhost', '127.0.0.1']);
    expect(result.tls?.protocol).toMatch(/^TLSv1\.[23]$/);
    expect(result.flags).toEqual(['Self-signed certificate', notChecked(port)]);
  }

  it('judges HSTS from an HTTP reply, with and without the header', async () => {
    const withHsts = await serve({ kind: 'http', hsts: true });
    const present = await inspectCert('localhost', withHsts.port, 5000, live());
    expect(present.flags).toEqual(['Self-signed certificate', 'HSTS present']);
    await withHsts.close();

    const without = await serve({ kind: 'http', hsts: false });
    const absent = await inspectCert('localhost', without.port, 5000, live());
    expect(absent.flags).toEqual(['Self-signed certificate', 'HSTS not configured']);
    expect(absent.error).toBeNull();
  });

  it('reports a failure before the handshake in error only, as before', async () => {
    const s = await serve({ kind: 'stall' });
    const result = await inspectCert('localhost', s.port, 400, live());
    expect(result).toMatchObject({
      status: 'error',
      cert: null,
      tls: null,
      flags: [],
      error: 'Timed out after 400ms',
    });
  });

  it('keeps the certificate when the port sends a non-HTTP banner and stays open', async () => {
    const s = await serve({ kind: 'banner' });
    // The deadline never fires here, so only the banner can end the HSTS read.
    fakeDeadline();
    const result = await inspectCert('localhost', s.port, 5000, live());

    expectCertKeptWithoutHsts(result, s.port);
  });

  it('keeps the certificate when the port says nothing after the handshake, reporting at timeout_ms', async () => {
    const s = await serve({ kind: 'silent' });
    fakeDeadline();
    const pending = inspectCert('localhost', s.port, 600, live());
    const state = track(pending);
    // The GET reached the server, so the check is parked on the HTTP reply.
    await until(() => s.requests() === 1);

    await advance(599);
    expect(state.settled).toBe(false);
    await advance(1);
    expect(state.settled).toBe(true);
    expectCertKeptWithoutHsts(await pending, s.port);
  });

  it('carries the kept certificate and the not-checked flag through devops_check_certs', async () => {
    const s = await serve({ kind: 'banner' });
    const result = await runToolContract(devopsCheckCerts, {
      domains: [`localhost:${s.port}`],
      timeout_ms: 5000,
    });

    expect(result.isError).toBeFalsy();
    const [row] = (result.structuredContent as { results: CertResult[] }).results;
    expectCertKeptWithoutHsts(row!, s.port);
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain(`### 🔴 localhost:${s.port} — critical`);
    expect(text).toContain(`**Flags:** Self-signed certificate | ${notChecked(s.port)}`);
    expect(text).toContain('**Subject:** localhost');
    expect(text).not.toContain('**Error:**');
  });

  it('keeps the certificate when the port resets after the GET', async () => {
    const s = await serve({ kind: 'reset' });
    expectCertKeptWithoutHsts(await inspectCert('localhost', s.port, 5000, live()), s.port);
  });

  it('keeps the certificate, and never claims HSTS is missing, when the port closes after the GET', async () => {
    const s = await serve({ kind: 'close' });
    const result = await inspectCert('localhost', s.port, 5000, live());
    expectCertKeptWithoutHsts(result, s.port);
    expect(result.flags).not.toContain('HSTS not configured');
  });

  it('sends the hostname as SNI, and no SNI for an IP literal', async () => {
    const s = await serve({ kind: 'http', hsts: true });
    await inspectCert('localhost', s.port, 5000, live());
    await inspectCert('127.0.0.1', s.port, 5000, live());

    expect(connectCalls.map((c) => c.servername)).toEqual(['localhost', undefined]);
    expect(s.servernames).toEqual(['localhost', null]);
  });

  it('makes one connection with the default options to a modern server', async () => {
    const s = await serve({ kind: 'http', hsts: true });
    const result = await inspectCert('localhost', s.port, 5000, live());

    expect(result.tls?.protocol).toMatch(/^TLSv1\.[23]$/);
    expect(s.connections()).toBe(1);
    expect(connectCalls).toHaveLength(1);
    expect(connectCalls[0]).not.toHaveProperty('minVersion');
    expect(connectCalls[0]).not.toHaveProperty('ciphers');
  });

  /** The retry's options on the runtime running the suite: Bun rejects any `@SECLEVEL` string. */
  function expectLegacyRetryOptions() {
    expect(connectCalls).toHaveLength(2);
    expect(connectCalls[0]).not.toHaveProperty('minVersion');
    expect(connectCalls[1]).toMatchObject({ minVersion: 'TLSv1' });
    if (process.versions.bun) {
      expect(connectCalls[1]).not.toHaveProperty('ciphers');
    } else {
      expect(connectCalls[1]).toMatchObject({ ciphers: `${DEFAULT_CIPHERS}:@SECLEVEL=0` });
    }
  }

  it.each([
    ['TLSv1', { kind: 'legacy-hello', version: 'TLSv1', retry: 'serve' }],
    ['TLSv1.1', { kind: 'legacy-hello', version: 'TLSv1.1', retry: 'serve' }],
    ['TLSv1', { kind: 'legacy-alert', version: 'TLSv1' }],
    ['TLSv1.1', { kind: 'legacy-alert', version: 'TLSv1.1' }],
  ] as const)('grades a server that only speaks %s critical (%o)', async (version, mode) => {
    const s = await serve(mode);
    const result = await inspectCert('localhost', s.port, 5000, live());

    expect(result.error).toBeNull();
    expect(result.status).toBe('critical');
    expect(result.tls?.protocol).toBe(version);
    expect(result.cert?.subject).toBe('localhost');
    expect(result.flags).toEqual([
      'Self-signed certificate',
      `Insecure TLS version in use: ${version}`,
      'HSTS not configured',
    ]);
    expect(s.connections()).toBe(2);
    expectLegacyRetryOptions();
  });

  it("reports the retry's own error when the retry fails too", async () => {
    const s = await serve({ kind: 'legacy-hello', version: 'TLSv1', retry: 'refuse' });
    const result = await inspectCert('localhost', s.port, 5000, live());

    expect(result).toMatchObject({ status: 'error', cert: null, tls: null, flags: [] });
    expect(result.error).toMatch(/unsupported.protocol/i);
    expect(s.connections()).toBe(2);
    expectLegacyRetryOptions();
  });

  it('holds the first attempt and the retry to one timeout_ms', async () => {
    const s = await serve({ kind: 'legacy-hello', version: 'TLSv1', retry: 'stall' });
    fakeDeadline();
    const pending = inspectCert('localhost', s.port, 600, live());
    const state = track(pending);
    // 400 ms of the deadline pass before the first attempt fails; the retry gets the 200 left.
    vi.advanceTimersByTime(400);
    await until(() => s.connections() === 2);

    await advance(199);
    expect(state.settled).toBe(false);
    await advance(1);
    expect(state.settled).toBe(true);
    expect((await pending).error).toBe('Timed out after 600ms');
    expect(s.connections()).toBe(2);
  });

  describe('caller cancellation', () => {
    it.each([
      ['during the handshake', 'stall'],
      ['while waiting for an HTTP reply', 'silent'],
    ] as const)('rejects at once %s, instead of reporting a row', async (_label, kind) => {
      const s = await serve({ kind });
      fakeDeadline();
      const caller = new AbortController();
      const reason = new Error('caller went away');
      const pending = inspectCert('localhost', s.port, 5000, caller.signal);
      // Parked where the label says: the TCP connection accepted, or the GET received.
      await until(() => (kind === 'stall' ? s.connections() === 1 : s.requests() === 1));
      caller.abort(reason);

      // The deadline never fires here, so only the abort can settle the check.
      await expect(pending).rejects.toBe(reason);
    });

    it('rejects the whole batch rather than absorbing the cancellation into a row', async () => {
      const s = await serve({ kind: 'stall' });
      const caller = new AbortController();
      setTimeout(() => caller.abort(), 150);

      const hosts = [`localhost:${s.port}`, 'not a host'];
      await expect(
        checkHosts(new CertService(), hosts, 443, 5000, caller.signal),
      ).rejects.toMatchObject({ name: 'AbortError' });
    });
  });
});
