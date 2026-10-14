/**
 * @fileoverview Certificate inspection service — pure node:tls, no external APIs.
 * Performs a real TLS handshake to extract certificate metadata, then reads the HSTS header
 * when the port answers HTTP.
 * @module services/cert/cert-service
 */

import { isIP } from 'node:net';
import * as tls from 'node:tls';
import type { DomainEntry } from '@/utils/domain-input.js';
import { assertSafeDomain, ssrfRejectionMessage } from '@/utils/ssrf-guard.js';

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

/** `error` for a handshake that completed without the server presenting a certificate. */
const NO_PEER_CERTIFICATE = 'The TLS handshake completed but the server presented no certificate.';

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

/**
 * Handshake failures meaning the server offers only a version below the runtime's default
 * minimum: it answered with that older version, or it alerted that it shares none with the
 * client's range.
 */
const LEGACY_PROTOCOL_CODES = new Set([
  'ERR_SSL_UNSUPPORTED_PROTOCOL',
  'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION',
]);

/**
 * Options for the one retry against a server that only speaks TLS 1.0 or 1.1. Both runtimes
 * default the minimum to TLS 1.2. Node's OpenSSL also refuses those versions above security
 * level 0, so Node keeps its own cipher list with only the level lowered; Bun rejects any
 * `@SECLEVEL` string. The first attempt never uses these, so a modern server's handshake and
 * certificate checks stay exactly as they were.
 */
function legacyTlsOptions(): tls.ConnectionOptions {
  return process.versions.bun
    ? { minVersion: 'TLSv1' }
    : { minVersion: 'TLSv1', ciphers: `${tls.DEFAULT_CIPHERS}:@SECLEVEL=0` };
}

/** Header bytes read at most while looking for the end of an HTTP reply's header block. */
const MAX_HEADER_BYTES = 64 * 1024;

/** A completed handshake. */
interface Session {
  hostnameVerificationError: string | null;
  socket: tls.TLSSocket;
}

/**
 * Connect and complete one TLS handshake. Rejects with the socket error, or with `stop`'s reason
 * when it fires first; the socket is destroyed either way.
 */
function handshake(
  host: string,
  port: number,
  extra: tls.ConnectionOptions,
  stop: AbortSignal,
): Promise<Session> {
  return new Promise((resolve, reject) => {
    /**
     * Captured from inside `checkServerIdentity`: the callback runs Node's own hostname check
     * explicitly and records the result, then returns undefined so the handshake completes and a
     * bad certificate can still be inspected. `socket.authorized` alone does not cover this —
     * overriding the callback makes the connection authorized even on a hostname mismatch.
     */
    let hostnameVerificationError: string | null = null;

    const socket = tls.connect(
      {
        host,
        port,
        /**
         * Node sends no SNI unless asked, and a multi-tenant host then serves its default
         * certificate or refuses the handshake. An IP literal carries no SNI.
         */
        ...(isIP(host) === 0 ? { servername: host } : {}),
        rejectUnauthorized: false,
        checkServerIdentity: (name, peerCert) => {
          hostnameVerificationError = tls.checkServerIdentity(name, peerCert)?.message ?? null;
        },
        ...extra,
      },
      () => {
        detach();
        // Later socket errors belong to the HSTS read, which listens for them itself.
        socket.on('error', () => {});
        resolve({ socket, hostnameVerificationError });
      },
    );
    const fail = (err: unknown) => {
      detach();
      socket.on('error', () => {});
      socket.destroy();
      reject(err);
    };
    const onError = (err: Error) => fail(err);
    const onStop = () => fail(stop.reason);
    function detach() {
      socket.off('error', onError);
      stop.removeEventListener('abort', onStop);
    }
    socket.on('error', onError);
    if (stop.aborted) onStop();
    else stop.addEventListener('abort', onStop, { once: true });
  });
}

/** What the HSTS probe learned: the header's presence, or that the port gave no HTTP reply. */
type HstsReading = 'present' | 'absent' | 'not_http';

/**
 * Send `GET /` on a completed session and read the reply's header block. HSTS is judged only from
 * a reply that begins `HTTP/`, and from the headers received so far if the connection ends inside
 * the block. Any other bytes settle at once as `not_http`, and a close, a reset, or `stop` firing
 * before the reply starts does the same. Never rejects.
 */
function probeHsts(socket: tls.TLSSocket, host: string, stop: AbortSignal): Promise<HstsReading> {
  return new Promise((resolve) => {
    let received = '';
    const isHttp = () => received.startsWith('HTTP/');
    const judge = (): HstsReading => {
      const ends = [received.indexOf('\r\n\r\n'), received.indexOf('\n\n')].filter((i) => i >= 0);
      const headers = ends.length > 0 ? received.slice(0, Math.min(...ends)) : received;
      return /strict-transport-security:/i.test(headers) ? 'present' : 'absent';
    };
    const finish = (reading: HstsReading) => {
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('close', onEnd);
      socket.off('error', onEnd);
      stop.removeEventListener('abort', onEnd);
      resolve(reading);
    };
    const onEnd = () => finish(isHttp() ? judge() : 'not_http');
    const onData = (chunk: Buffer) => {
      received += chunk.toString('latin1');
      if (!'HTTP/'.startsWith(received.slice(0, 5))) return finish('not_http');
      const complete = received.includes('\r\n\r\n') || received.includes('\n\n');
      if (complete || received.length >= MAX_HEADER_BYTES) finish(judge());
    };
    socket.on('data', onData);
    socket.on('end', onEnd);
    socket.on('close', onEnd);
    socket.on('error', onEnd);
    if (stop.aborted) return onEnd();
    stop.addEventListener('abort', onEnd, { once: true });
    const hostHeader = isIP(host) === 6 ? `[${host}]` : host;
    socket.write(`GET / HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n\r\n`);
  });
}

const HSTS_FLAGS: Record<Exclude<HstsReading, 'not_http'>, string> = {
  present: 'HSTS present',
  absent: 'HSTS not configured',
};

/**
 * Grade a completed session from its certificate and TLS parameters. The HSTS finding is added by
 * the caller once the probe settles; it never changes the status.
 */
function gradeSession(
  { socket, hostnameVerificationError }: Session,
  host: string,
  port: number,
  checked_at: string,
): CertResult {
  const cert = socket.getPeerCertificate(true);
  const authorizationError = authorizationErrorCode(socket.authorizationError);
  const tlsProtocol = socket.getProtocol() ?? 'unknown';
  const cipherInfo = socket.getCipher();

  const flags: string[] = [];

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
    const subject = Array.isArray(subjectCN) ? (subjectCN[0] ?? host) : (subjectCN ?? host);

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

    const issuerCN = cert.issuer?.CN ?? cert.issuer?.O;
    const issuer = Array.isArray(issuerCN) ? (issuerCN[0] ?? 'unknown') : (issuerCN ?? 'unknown');

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
        `Hostname mismatch — the certificate does not cover ${host}; clients will reject it`,
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
      flags.push(`Certificate chain not trusted (${authorizationError}); clients will reject it`);
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

  const insecureTls = tlsProtocol === 'TLSv1' || tlsProtocol === 'TLSv1.1';
  if (insecureTls) {
    flags.push(`Insecure TLS version in use: ${tlsProtocol}`);
  }

  /**
   * Derived from the certificate data rather than from flag text. A hostname mismatch or any
   * chain-trust failure (self-signed included) is a hard client-side rejection and lands at
   * `critical`, alongside expiry and insecure TLS.
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

  /**
   * The handshake completed, so the session's findings stay in `flags` and `tls` either way.
   * With no certificate presented the status is `error`, and `error` says why — the one `error`
   * row whose session was still read.
   */
  return {
    domain: host,
    port,
    status: resolveStatus(),
    flags,
    cert: certData,
    tls: { protocol: tlsProtocol, cipher: cipherInfo?.name ?? 'unknown' },
    checked_at,
    error: certData === null ? NO_PEER_CERTIFICATE : null,
  };
}

/**
 * Inspect one host's TLS certificate and, when the port answers HTTP, its HSTS header.
 *
 * One `timeoutMs` deadline covers the whole check. A server that only offers TLS 1.0/1.1 is
 * retried once with legacy versions enabled, inside that same deadline. Once a handshake
 * completes, the row is graded from the certificate and session whatever the HSTS probe does:
 * a port that gives no HTTP reply is flagged as not checked, never as missing HSTS.
 *
 * `flags` holds findings about a certificate and TLS session that were actually read. When the
 * connection times out or errors before that, the failure is reported in `error` only. A
 * handshake that completes without a certificate reports its session findings and the reason
 * both. When `signal` aborts, the socket closes at once and the call rejects with its reason.
 */
export async function inspectCert(
  host: string,
  port: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<CertResult> {
  const checked_at = new Date().toISOString();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  const stop = AbortSignal.any([signal, deadline.signal]);
  let session: Session | undefined;
  try {
    try {
      session = await handshake(host, port, {}, stop);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (stop.aborted || !code || !LEGACY_PROTOCOL_CODES.has(code)) throw err;
      session = await handshake(host, port, legacyTlsOptions(), stop);
    }
    const result = gradeSession(session, host, port, checked_at);
    const hsts = await probeHsts(session.socket, host, stop);
    signal.throwIfAborted();
    result.flags.push(
      hsts === 'not_http'
        ? `HSTS not checked — no HTTP response on port ${port}`
        : HSTS_FLAGS[hsts],
    );
    return result;
  } catch (err) {
    signal.throwIfAborted();
    return {
      domain: host,
      port,
      status: 'error',
      flags: [],
      cert: null,
      tls: null,
      checked_at,
      error: deadline.signal.aborted ? `Timed out after ${timeoutMs}ms` : (err as Error).message,
    };
  } finally {
    clearTimeout(timer);
    session?.socket.destroy();
  }
}

export class CertService {
  /**
   * One row per entry, in entry order. An entry's own port wins over `defaultPort`. An invalid
   * entry and a guard rejection are never connected to. Caller cancellation (`signal`) rejects
   * the whole call rather than surfacing as per-row failures.
   */
  async checkDomains(
    entries: DomainEntry[],
    defaultPort: number,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<CertResult[]> {
    const portOf = (entry: DomainEntry) =>
      (entry.kind === 'host' ? entry.port : null) ?? defaultPort;
    const results = await Promise.allSettled(
      entries.map(async (entry) => {
        if (entry.kind === 'invalid') throw new Error(entry.error);
        // SSRF guard: reject domains that resolve to private/loopback/cloud-metadata addresses.
        await assertSafeDomain(entry.host);
        signal.throwIfAborted();
        return inspectCert(entry.host, portOf(entry), timeoutMs, signal);
      }),
    );
    signal.throwIfAborted();
    /**
     * A rejected entry was never connected to: the failure goes in `error` alone, a guard
     * rejection as its caller-facing text like on every other rejection path. `domain` is the
     * host that was checked, or the submitted string for an entry that never became one.
     */
    return results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      const entry = entries[i] as DomainEntry;
      return {
        domain: entry.kind === 'host' ? entry.host : entry.input,
        port: portOf(entry),
        status: 'error' as const,
        flags: [],
        cert: null,
        tls: null,
        checked_at: new Date().toISOString(),
        error: ssrfRejectionMessage(r.reason) ?? (r.reason as Error).message,
      };
    });
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
