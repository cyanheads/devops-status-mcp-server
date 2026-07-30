/**
 * @fileoverview Tests for the CertService expiry thresholds, hostname and chain-trust
 * verification, status classification, and flag emission.
 * Mocks node:tls to simulate TLS handshake responses without real network I/O.
 * @module tests/services/cert/cert-service.test
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ──────────────────────────────────────────────
// node:tls mock — must run before any import that uses it
// ──────────────────────────────────────────────

/** State shared between test and the mock socket factory. */
let mockSocketConfig: {
  /** If set, the 'connect' callback is never called; instead 'error' is emitted. */
  error?: Error;
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

  write(data: string) {
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

vi.mock('node:tls', () => ({
  /**
   * Invokes the caller's `checkServerIdentity` before the connect callback, mirroring the real
   * handshake — that is where the service captures Node's hostname-verification result.
   */
  connect: (
    opts: {
      host?: string;
      checkServerIdentity?: (host: string, cert: unknown) => Error | undefined;
    },
    callback?: () => void,
  ) => {
    const socket = new MockTlsSocket();
    setImmediate(() => {
      if (mockSocketConfig.error) {
        socket.emit('error', mockSocketConfig.error);
        return;
      }
      opts.checkServerIdentity?.(opts.host ?? '', mockSocketConfig.cert ?? {});
      if (callback) callback();
    });
    return socket;
  },
  checkServerIdentity: () => mockSocketConfig.hostnameError,
}));

// ──────────────────────────────────────────────
// SSRF guard mock — unit tests for TLS logic; guard behavior is tested in ssrf-guard.test.ts
// ──────────────────────────────────────────────

vi.mock('@/utils/ssrf-guard.js', () => ({
  assertSafeDomain: vi.fn().mockResolvedValue(undefined),
  assertSafeUrl: vi.fn().mockResolvedValue(undefined),
  assertSafeResolverIp: vi.fn(),
}));

// ──────────────────────────────────────────────
// Import AFTER the mock is registered
// ──────────────────────────────────────────────

import { CertService, getCertService, initCertService } from '@/services/cert/cert-service.js';

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
    const results = await service.checkDomains(['example.com'], 443, 5000);
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
    const results = await service.checkDomains(['soon.com'], 443, 5000);
    expect(results[0]!.status).toBe('warning');
    expect(results[0]!.flags.some((f) => f.includes('warning'))).toBe(true);
    expect(results[0]!.cert!.days_until_expiry).toBeGreaterThanOrEqual(19);
    expect(results[0]!.cert!.days_until_expiry).toBeLessThan(30);
  });

  it('cert expiring in 5 days → status critical, flag contains CRITICAL', async () => {
    mockSocketConfig = { cert: fakeCert(5), protocol: 'TLSv1.3', hsts: true };
    const service = getCertService();
    const results = await service.checkDomains(['expiring.com'], 443, 5000);
    expect(results[0]!.status).toBe('critical');
    expect(results[0]!.flags.some((f) => f.includes('CRITICAL'))).toBe(true);
    expect(results[0]!.cert!.days_until_expiry).toBeLessThan(7);
  });

  it('HSTS not configured → flag "HSTS not configured", status still ok for healthy cert', async () => {
    mockSocketConfig = { cert: fakeCert(200), protocol: 'TLSv1.3', hsts: false };
    const service = getCertService();
    const results = await service.checkDomains(['nohsts.com'], 443, 5000);
    expect(results[0]!.flags).toContain('HSTS not configured');
    // A healthy cert with no HSTS is 'ok' (HSTS flag is informational, not a status upgrade)
    expect(results[0]!.status).toBe('ok');
  });

  it('TLSv1.1 protocol → status critical, flag mentions Insecure TLS', async () => {
    mockSocketConfig = { cert: fakeCert(200), protocol: 'TLSv1.1', hsts: true };
    const service = getCertService();
    const results = await service.checkDomains(['oldtls.com'], 443, 5000);
    expect(results[0]!.status).toBe('critical');
    expect(results[0]!.tls!.protocol).toBe('TLSv1.1');
    expect(results[0]!.flags.some((f) => f.includes('Insecure TLS'))).toBe(true);
  });

  it('TLSv1.0 protocol → status critical, flag mentions Insecure TLS', async () => {
    mockSocketConfig = { cert: fakeCert(200), protocol: 'TLSv1', hsts: true };
    const service = getCertService();
    const results = await service.checkDomains(['tls10.com'], 443, 5000);
    expect(results[0]!.status).toBe('critical');
    expect(results[0]!.flags.some((f) => f.includes('Insecure TLS'))).toBe(true);
  });

  it('connection error → status error, cert and tls null', async () => {
    mockSocketConfig = { error: new Error('ECONNREFUSED') };
    const service = getCertService();
    const results = await service.checkDomains(['unreachable.com'], 443, 5000);
    expect(results[0]!.status).toBe('error');
    expect(results[0]!.cert).toBeNull();
    expect(results[0]!.tls).toBeNull();
    expect(results[0]!.error).toContain('ECONNREFUSED');
  });

  it('batch: one success, one error — both results present', async () => {
    // First call succeeds (healthy cert), second call errors
    let callCount = 0;
    const connectSpy = vi.fn((opts: Record<string, unknown>, cb?: () => void) => {
      callCount++;
      const socket = new MockTlsSocket();
      setImmediate(() => {
        if (callCount === 1) {
          // Success path
          mockSocketConfig = { cert: fakeCert(200), protocol: 'TLSv1.3', hsts: true };
          if (cb) cb();
        } else {
          socket.emit('error', new Error('ECONNREFUSED'));
        }
      });
      return socket;
    });
    // Temporarily replace connect
    const tlsMod = await import('node:tls');
    const savedConnect = tlsMod.connect;
    Object.defineProperty(tlsMod, 'connect', { value: connectSpy, configurable: true });

    try {
      const service = new CertService();
      const results = await service.checkDomains(['ok.com', 'fail.com'], 443, 3000);
      expect(results).toHaveLength(2);
      // At least one result should be an error
      const errorResults = results.filter((r) => r.status === 'error');
      expect(errorResults.length).toBeGreaterThanOrEqual(1);
    } finally {
      Object.defineProperty(tlsMod, 'connect', { value: savedConnect, configurable: true });
    }
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
    const results = await getCertService().checkDomains(['wrong.host.example.com'], 443, 5000);

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
    const results = await getCertService().checkDomains(['untrusted-root.example.com'], 443, 5000);

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
    const results = await getCertService().checkDomains(['self.example.com'], 443, 5000);

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
    const results = await getCertService().checkDomains(['no-intermediate.example.com'], 443, 5000);

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
    const results = await getCertService().checkDomains(['expired.example.com'], 443, 5000);

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
    const results = await getCertService().checkDomains(['ca-issued.example.com'], 443, 5000);

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
    const results = await getCertService().checkDomains(['chained.com'], 443, 5000);

    expect(results[0]!.cert!.chain_depth).toBe(2);
    expect(results[0]!.cert!.chain_depth_unavailable_reason).toBeNull();
  });
});
