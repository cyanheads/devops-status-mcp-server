/**
 * @fileoverview Certificate inspection service — pure node:tls, no external APIs.
 * Performs a real TLS handshake to extract certificate metadata and HSTS header.
 * @module services/cert/cert-service
 */

import * as tls from 'node:tls';
import { assertSafeDomain } from '@/utils/ssrf-guard.js';

export interface CertResult {
  cert: {
    subject: string;
    san: string[];
    issuer: string;
    valid_from: string;
    valid_until: string;
    days_until_expiry: number;
    chain_depth: number | null;
    chain_depth_unavailable_reason: string | null;
    hostname_verification_error: string | null;
    authorization_error: string | null;
    serial: string;
  } | null;
  checked_at: string;
  domain: string;
  error: string | null;
  flags: string[];
  port: number;
  status: 'ok' | 'warning' | 'critical' | 'error';
  tls: {
    protocol: string;
    cipher: string;
  } | null;
}

/**
 * Why `chain_depth` is null. `getPeerCertificate(true).issuerCertificate` is the only link to the
 * served chain, and it is not populated on every supported runtime (absent under Bun even for
 * CA-issued chains), so the count is reported as unavailable rather than as a confident `1`.
 */
const CHAIN_DEPTH_UNAVAILABLE =
  'This runtime did not expose issuerCertificate on the peer certificate, so the number of certificates the server actually sent cannot be counted. Read authorization_error for chain-trust validity instead.';

/**
 * `socket.authorizationError` is typed as `Error` but arrives as a bare OpenSSL code string on
 * some runtimes. Normalize both shapes to the code.
 */
function authorizationErrorCode(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  const err = value as NodeJS.ErrnoException;
  return err.code ?? err.message ?? String(value);
}

/** Inspect a single domain's TLS certificate and HSTS header. */
export function inspectCert(domain: string, port: number, timeoutMs: number): Promise<CertResult> {
  const checked_at = new Date().toISOString();

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({
        domain,
        port,
        status: 'error',
        flags: ['Connection timed out'],
        cert: null,
        tls: null,
        checked_at,
        error: `Timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    let settled = false;
    function settle(result: CertResult) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    }

    /**
     * Captured from inside `checkServerIdentity`: the callback runs Node's own hostname check
     * explicitly and records the result, then returns undefined so the handshake completes and a
     * bad certificate can still be inspected. `socket.authorized` alone does not cover this —
     * overriding the callback makes the connection authorized even on a hostname mismatch.
     */
    let hostnameVerificationError: string | null = null;

    const socket = tls.connect(
      {
        host: domain,
        port,
        rejectUnauthorized: false,
        checkServerIdentity: (host, peerCert) => {
          hostnameVerificationError = tls.checkServerIdentity(host, peerCert)?.message ?? null;
        },
      },
      () => {
        const cert = socket.getPeerCertificate(true);
        const authorizationError = authorizationErrorCode(socket.authorizationError);
        const tlsProtocol = socket.getProtocol() ?? 'unknown';
        const cipherInfo = socket.getCipher();

        const flags: string[] = [];

        // Parse cert details
        let certData: CertResult['cert'] = null;
        /** Self-issued leaf, detected independently of chain verification. */
        let selfIssued = false;
        if (cert?.subject) {
          const now = Date.now();
          const validFrom = new Date(cert.valid_from);
          const validUntil = new Date(cert.valid_to);
          const daysUntilExpiry = Math.floor((validUntil.getTime() - now) / (1000 * 60 * 60 * 24));

          // Subject CN — tls.DetailedPeerCertificate fields can be string | string[]
          const subjectCN = cert.subject?.CN;
          const subject = Array.isArray(subjectCN)
            ? (subjectCN[0] ?? domain)
            : (subjectCN ?? domain);

          // SANs
          const san: string[] = [];
          if (cert.subjectaltname) {
            const sanStr = Array.isArray(cert.subjectaltname)
              ? (cert.subjectaltname as string[]).join(', ')
              : (cert.subjectaltname as string);
            for (const part of sanStr.split(', ')) {
              const stripped = part.replace(/^(DNS:|IP Address:)/i, '').trim();
              if (stripped) san.push(stripped);
            }
          }

          // Issuer CN
          const issuerCN = cert.issuer?.CN ?? cert.issuer?.O;
          const issuer = Array.isArray(issuerCN)
            ? (issuerCN[0] ?? 'unknown')
            : (issuerCN ?? 'unknown');

          /**
           * Chain depth — walk the issuerCertificate chain when the runtime exposes it. With no
           * link there is nothing to count: report null rather than the leaf-only `1`, which reads
           * as "no intermediates were served" and is wrong for every CA-issued certificate.
           */
          let chainDepth: number | null = null;
          if (cert.issuerCertificate) {
            let depth = 1;
            let current: tls.DetailedPeerCertificate | null = cert;
            while (current?.issuerCertificate && current.issuerCertificate !== current) {
              depth++;
              current = current.issuerCertificate as tls.DetailedPeerCertificate;
              if (depth > 20) break; // guard against circular refs
            }
            chainDepth = depth;
          }

          // Serial number
          const serial = cert.serialNumber ?? '';

          if (daysUntilExpiry < 0) {
            flags.push(`Certificate expired ${Math.abs(daysUntilExpiry)} days ago`);
          } else if (daysUntilExpiry < 7) {
            flags.push(`Expires in ${daysUntilExpiry} days (CRITICAL)`);
          } else if (daysUntilExpiry < 30) {
            flags.push(`Expires in ${daysUntilExpiry} days (warning)`);
          }

          if (hostnameVerificationError) {
            flags.push(
              `Hostname mismatch — the certificate does not cover ${domain}; clients will reject it`,
            );
          }

          /**
           * Chain trust. `authorization_error` is the authoritative signal — the issuer/subject
           * comparison only catches a self-issued leaf and misses an untrusted root entirely.
           * Expiry is already flagged above with a day count, so it is not repeated here.
           */
          selfIssued =
            issuer === subject ||
            Boolean(cert.issuer?.CN && cert.subject?.CN && cert.issuer.CN === cert.subject.CN);
          if (authorizationError === 'DEPTH_ZERO_SELF_SIGNED_CERT' || selfIssued) {
            flags.push('Self-signed certificate');
          } else if (authorizationError && authorizationError !== 'CERT_HAS_EXPIRED') {
            flags.push(
              `Certificate chain not trusted (${authorizationError}); clients will reject it`,
            );
          }

          certData = {
            subject,
            san,
            issuer,
            valid_from: validFrom.toISOString(),
            valid_until: validUntil.toISOString(),
            days_until_expiry: daysUntilExpiry,
            chain_depth: chainDepth,
            chain_depth_unavailable_reason: chainDepth === null ? CHAIN_DEPTH_UNAVAILABLE : null,
            hostname_verification_error: hostnameVerificationError,
            authorization_error: authorizationError,
            serial,
          };
        }

        // TLS protocol check
        const insecureTls = tlsProtocol === 'TLSv1' || tlsProtocol === 'TLSv1.1';
        if (insecureTls) {
          flags.push(`Insecure TLS version in use: ${tlsProtocol}`);
        }

        const tlsData = {
          protocol: tlsProtocol,
          cipher: cipherInfo?.name ?? 'unknown',
        };

        // Send HTTP/1.1 GET to check HSTS header
        socket.write(`GET / HTTP/1.1\r\nHost: ${domain}\r\nConnection: close\r\n\r\n`);

        let responseBuffer = '';
        let hstsChecked = false;

        /**
         * Derived from the certificate data rather than from flag text. A hostname mismatch or
         * any chain-trust failure (self-signed included) is a hard client-side rejection and lands
         * at `critical`, alongside expiry and insecure TLS.
         */
        function resolveStatus(): CertResult['status'] {
          if (certData === null) return 'error';
          if (
            certData.days_until_expiry < 7 ||
            certData.hostname_verification_error !== null ||
            certData.authorization_error !== null ||
            selfIssued ||
            insecureTls
          )
            return 'critical';
          if (certData.days_until_expiry < 30) return 'warning';
          return 'ok';
        }

        socket.on('data', (chunk) => {
          if (hstsChecked) return;
          responseBuffer += chunk.toString('utf8');
          // Look for end of headers
          if (responseBuffer.includes('\r\n\r\n') || responseBuffer.includes('\n\n')) {
            hstsChecked = true;
            const headers = responseBuffer.split(/\r?\n\r?\n/)[0] ?? '';
            if (/strict-transport-security:/i.test(headers)) {
              flags.push('HSTS present');
            } else {
              flags.push('HSTS not configured');
            }
            socket.destroy();
            settle({
              domain,
              port,
              status: resolveStatus(),
              flags,
              cert: certData,
              tls: tlsData,
              checked_at,
              error: null,
            });
          }
        });

        socket.on('end', () => {
          if (!hstsChecked) {
            flags.push('HSTS not configured');
          }
          settle({
            domain,
            port,
            status: resolveStatus(),
            flags,
            cert: certData,
            tls: tlsData,
            checked_at,
            error: null,
          });
        });
      },
    );

    socket.on('error', (err) => {
      settle({
        domain,
        port,
        status: 'error',
        flags: [`Connection error: ${err.message}`],
        cert: null,
        tls: null,
        checked_at,
        error: err.message,
      });
    });
  });
}

export class CertService {
  async checkDomains(domains: string[], port: number, timeoutMs: number): Promise<CertResult[]> {
    const results = await Promise.allSettled(
      domains.map(async (domain) => {
        // SSRF guard: reject domains that resolve to private/loopback/cloud-metadata addresses.
        await assertSafeDomain(domain);
        return inspectCert(domain, port, timeoutMs);
      }),
    );
    return results.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : {
            domain: domains[i] ?? 'unknown',
            port,
            status: 'error' as const,
            flags: [`${(r.reason as Error).message}`],
            cert: null,
            tls: null,
            checked_at: new Date().toISOString(),
            error: (r.reason as Error).message,
          },
    );
  }
}

// --- Init/accessor pattern ---

let _service: CertService | undefined;

export function initCertService(): void {
  _service = new CertService();
}

export function getCertService(): CertService {
  if (!_service) throw new Error('CertService not initialized — call initCertService() in setup()');
  return _service;
}
