/**
 * @fileoverview Certificate inspection service — pure node:tls, no external APIs.
 * Performs a real TLS handshake to extract certificate metadata and HSTS header.
 * @module services/cert/cert-service
 */

import * as tls from 'node:tls';

export interface CertResult {
  cert: {
    subject: string;
    san: string[];
    issuer: string;
    valid_from: string;
    valid_until: string;
    days_until_expiry: number;
    chain_depth: number;
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

    const socket = tls.connect(
      { host: domain, port, rejectUnauthorized: false, checkServerIdentity: () => undefined },
      () => {
        const cert = socket.getPeerCertificate(true);
        const tlsProtocol = socket.getProtocol() ?? 'unknown';
        const cipherInfo = socket.getCipher();

        const flags: string[] = [];

        // Parse cert details
        let certData: CertResult['cert'] = null;
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

          // Chain depth — walk issuerCertificate chain
          let depth = 1;
          let current: tls.DetailedPeerCertificate | null = cert;
          while (current?.issuerCertificate && current.issuerCertificate !== current) {
            depth++;
            current = current.issuerCertificate as tls.DetailedPeerCertificate;
            if (depth > 20) break; // guard against circular refs
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

          // Self-signed: issuer === subject
          if (
            issuer === subject ||
            (cert.issuer?.CN && cert.subject?.CN && cert.issuer.CN === cert.subject.CN)
          ) {
            flags.push('Self-signed certificate');
          }

          certData = {
            subject,
            san,
            issuer,
            valid_from: validFrom.toISOString(),
            valid_until: validUntil.toISOString(),
            days_until_expiry: daysUntilExpiry,
            chain_depth: depth,
            serial,
          };
        }

        // TLS protocol check
        if (tlsProtocol === 'TLSv1' || tlsProtocol === 'TLSv1.1') {
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

            const daysExpiry = certData?.days_until_expiry ?? 999;
            const status: CertResult['status'] =
              certData === null
                ? 'error'
                : flags.some(
                      (f) =>
                        f.includes('CRITICAL') ||
                        f.includes('expired') ||
                        f.includes('Insecure TLS'),
                    )
                  ? 'critical'
                  : daysExpiry < 30 || flags.some((f) => f.includes('Self-signed'))
                    ? 'warning'
                    : 'ok';

            settle({
              domain,
              port,
              status,
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
          const daysExpiry = certData?.days_until_expiry ?? 999;
          const status: CertResult['status'] =
            certData === null
              ? 'error'
              : flags.some(
                    (f) =>
                      f.includes('CRITICAL') || f.includes('expired') || f.includes('Insecure TLS'),
                  )
                ? 'critical'
                : daysExpiry < 30 || flags.some((f) => f.includes('Self-signed'))
                  ? 'warning'
                  : 'ok';

          settle({
            domain,
            port,
            status,
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
    const results = await Promise.allSettled(domains.map((d) => inspectCert(d, port, timeoutMs)));
    return results.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : {
            domain: domains[i] ?? 'unknown',
            port,
            status: 'error' as const,
            flags: [`Unexpected error: ${(r.reason as Error).message}`],
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
