/**
 * @fileoverview Loopback TLS servers for cert-service tests. Each mode reproduces one way a TLS
 * port behaves after (or instead of) a handshake, plus legacy-only servers that refuse a modern
 * client the two ways real servers do.
 * @module tests/services/cert/loopback-tls-server
 */

import { randomBytes } from 'node:crypto';
import * as net from 'node:net';
import * as tls from 'node:tls';

/**
 * A throwaway self-signed certificate for `localhost` and `127.0.0.1`, generated for these tests
 * only and valid until 2126. Nothing trusts it; it exists so a loopback server can complete a
 * real handshake.
 */
const KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC3X1mwT/+7qU3X
KAGPFjRBVqGcw9JYodiZXDKajWN0D7Ixj6QUxvrXhQjgx2CrwUyInjSVgtrdLfYf
A957Ifggbx9ZKVRU3k/uaETCEyZRKe002arL1qftk+MCDLstv04A6SuvuKBRlT8c
3IkStrV3rT8zwF/GT5lQ5FSMx/Jiti/MPtsdlX88EpyH9D68kXGACuMKEjqI/ziy
NMAEJb0/agaAoWPd2dkYhnFDOeGfWMqKsoGWg89cSiS+cTFd5b/T/tMws7pUJFVI
ar/eJVtlXRZQ3xdSIHjNzF02LHwS7ztRukprBcm33BHTs1dQHRSn+8431PP+PN/t
4nmLOm3fAgMBAAECggEAMV7luffABdmukIg/6zNyPElD1/5NKvngZGITadM5fK0h
MADZj5KHRPGXk1V67KNtpLbbt4l0veo7Aty60PIzaSAiE5JyFyuH38uI/6vCPEYK
jJkySBFyQx/3Fb0xxD5mlQ4yaexOlciWJoImEbjJoQAvLRLVdoJF6CahsQnAc9zd
vvM7Wp2GhaGR4zi2joAyj7OBXNcryMacniH8g/RLP4kTjtm8x98cPSrXxVUihLX0
rvYVajvEbYgJwMGJlgZ/3vnxILfUkHPmnA4/iUnrcxN7KYhPtupvYNGiQpLhio+o
nrhSPlOj3cy6TriWZYpjQwAXqfSiMOKVyN0MjNoFsQKBgQD4QxP/e9o4I/IsvySo
LTNyaDRtnGGCPkVrzGUDGg9rDv7VrNHLD32Ozbx6PXkAefKUmDNlwRjPl1GJEDtK
DSikVW8styv9HiLwJnCef8o+jUEfss0kH5VRzLaevtPG0uCk7M6o/PE8r2Ii7S6q
xuOIFXpB+r3UxVcs0CWbUuMCaQKBgQC9FoIXoESY60tnI/VMbwgXcIp2hq4zbNRF
vdUJ4dH4H6veHcUvbEzSm9EiCYbn/wv6Px5Y1jLiu94cmtK75fEBW6CyM9FztR72
UYmcA7N47cVumfUW2w5VKoj/TREuHOoyqIQG5F5d3Cx0/qWtxHN4J0UGF/k/Q4GR
WUSaLWTVBwKBgQDtOTN/ujov0PFVHqSJav+w/6+xWW+3Q4eUVS/kgd9fvml1hfjF
3xxr+11xNRJNiTlqEfFy9sudeYs4vGDbBq3iMZzVDoajDEv4S9LrMVLw6IrlHjZ1
oRROoJ2UHOZCIzjzfzCOO3zMLw5IL3mbSAcc/uDe8Ri5moQNVyvIOrCemQKBgHaS
DrHSBjH+GiJrIf70ARbxs2Hvwnzs2Y+CIn035fq5oYR/Fo9OUj4fB11YrAf+nvwl
aFo8t1wGgpldXJgG8MHxOyuD4uuzv96l8qyqhXhnYU6hrFbQtoQhUBcHtKY9634o
veG0gphI4Hfc1vfIIMBPn7Dah6lsI2uJlsM3g+sxAoGBAJwzC7kmCVRAF7ZsphCc
AUlM+fzZ5eHMV62ORcufBr1G7OgMrYD0CB91N11uymUv+VFpMHwGu0I4kvA6nhax
MtqevQ52yqDDcHFO+lvq91MzAPh6cxCZ23uFYaM22XHVEiyuNtemtLxV0KpRUPeT
BWJo4PTjyjW2/lciBQ2w+R6t
-----END PRIVATE KEY-----
`;

const CERT = `-----BEGIN CERTIFICATE-----
MIIDBjCCAe6gAwIBAgIUNeh9iw46juRxIvpIxncwHLq7484wDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTAxNDE5MTkxN1oYDzIxMjYw
OTIwMTkxOTE3WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQC3X1mwT/+7qU3XKAGPFjRBVqGcw9JYodiZXDKajWN0
D7Ixj6QUxvrXhQjgx2CrwUyInjSVgtrdLfYfA957Ifggbx9ZKVRU3k/uaETCEyZR
Ke002arL1qftk+MCDLstv04A6SuvuKBRlT8c3IkStrV3rT8zwF/GT5lQ5FSMx/Ji
ti/MPtsdlX88EpyH9D68kXGACuMKEjqI/ziyNMAEJb0/agaAoWPd2dkYhnFDOeGf
WMqKsoGWg89cSiS+cTFd5b/T/tMws7pUJFVIar/eJVtlXRZQ3xdSIHjNzF02LHwS
7ztRukprBcm33BHTs1dQHRSn+8431PP+PN/t4nmLOm3fAgMBAAGjTjBMMB0GA1Ud
DgQWBBSOeJNUYff3436j8wauxUgGEMi57zAPBgNVHRMBAf8EBTADAQH/MBoGA1Ud
EQQTMBGCCWxvY2FsaG9zdIcEfwAAATANBgkqhkiG9w0BAQsFAAOCAQEAjxhAglWu
ERw+nGz+Ad6hE+yRaBvv5jNVb2HqwkWdFFwTG4d0d/60/x0xIzgtxSESU9At9xLR
pXQKu7jjtRToF3li5jr1QL75zmsSWJlBiDnURYws7AWfu2iOvMoSheTEJuSqYX4R
0RwbYfWTYI4bR/7pSgFZpddbFqNr1vrsZ9nWE0w4QrLQ7Lc4wpjuZ53QUSKROrTh
bCHZoLdDkhoRgQJbRa4s8N3WoAAObxeu46Otx5wcdE970hizq9wGOapMHz69d1FY
puHlgx434bMUlBtUZNcfcC3IBNEIf37FI20XyzKdf5nAUynS3YxFuoDbTv3JwrhI
r4i/DD87ejU9Tg==
-----END CERTIFICATE-----
`;

/** What a loopback server does with each connection. */
export type TlsServerMode =
  /** Answers the GET with an HTTP response, with or without a Strict-Transport-Security header. */
  | { kind: 'http'; hsts: boolean }
  /** Sends a non-HTTP greeting once the handshake completes and keeps the connection open. */
  | { kind: 'banner' }
  /** Completes the handshake and then sends nothing. */
  | { kind: 'silent' }
  /** Resets the connection on the first bytes after the handshake. */
  | { kind: 'reset' }
  /** Closes the connection on the first bytes after the handshake, without a reply. */
  | { kind: 'close' }
  /** Accepts the TCP connection and never starts a handshake. */
  | { kind: 'stall' }
  /**
   * Answers a modern ClientHello with a ServerHello for an old version, as servers that predate
   * TLS 1.3 negotiation do. `retry` is what every later connection gets: a real handshake at that
   * version (answering the GET with HTTP), an SSLv3 ServerHello that no client accepts, or a
   * stall.
   */
  | { kind: 'legacy-hello'; version: LegacyVersion; retry: 'serve' | 'refuse' | 'stall' }
  /**
   * A current TLS stack limited to an old version: it alerts a modern client and completes a
   * handshake with a client that offers that version (answering the GET with HTTP).
   */
  | { kind: 'legacy-alert'; version: LegacyVersion };

type LegacyVersion = 'TLSv1' | 'TLSv1.1';

export interface LoopbackTlsServer {
  close(): Promise<void>;
  /** TCP connections accepted, in total. */
  connections(): number;
  port: number;
  /** Completed handshakes on which the client has sent application data (the HSTS request). */
  requests(): number;
  /** The SNI name each completed handshake carried, or null when it carried none. */
  servernames: Array<string | null>;
}

/** A ServerHello record for an old version, enough for a client to read the server's version. */
function oldServerHello(version: LegacyVersion | 'SSLv3'): Buffer {
  const minor = { SSLv3: 0, TLSv1: 1, 'TLSv1.1': 2 }[version];
  const body = Buffer.concat([
    Buffer.from([3, minor]),
    randomBytes(32),
    Buffer.from([0, 0xc0, 0x14, 0]), // no session ID, ECDHE-RSA-AES256-SHA, no compression
  ]);
  const handshake = Buffer.concat([Buffer.from([2, 0, 0, body.length]), body]);
  return Buffer.concat([Buffer.from([0x16, 3, 1, 0, handshake.length]), handshake]);
}

const HTTP_REPLY = (hsts: boolean) =>
  `HTTP/1.1 200 OK\r\n${hsts ? 'Strict-Transport-Security: max-age=31536000\r\n' : ''}Content-Length: 0\r\n\r\n`;

/** Start a loopback TLS server on a free 127.0.0.1 port. */
export async function startTlsServer(mode: TlsServerMode): Promise<LoopbackTlsServer> {
  const legacyVersion =
    mode.kind === 'legacy-hello' || mode.kind === 'legacy-alert' ? mode.version : undefined;
  /** Node's server also refuses TLS 1.0/1.1 above security level 0; Bun rejects the syntax. */
  const legacyOptions: tls.TlsOptions = legacyVersion
    ? {
        minVersion: legacyVersion,
        maxVersion: legacyVersion,
        ...(process.versions.bun ? {} : { ciphers: 'DEFAULT@SECLEVEL=0' }),
      }
    : {};
  const tlsServer = tls.createServer({ key: KEY, cert: CERT, ...legacyOptions });
  tlsServer.on('tlsClientError', () => {});

  const sockets = new Set<net.Socket>();
  /** Raw sockets handed to the TLS server, consumed in accept order as handshakes complete. */
  const handedOff: net.Socket[] = [];
  const servernames: Array<string | null> = [];
  let accepted = 0;
  let requested = 0;

  tlsServer.on('secureConnection', (secure: tls.TLSSocket) => {
    const raw = handedOff.shift();
    servernames.push(secure.servername || null);
    secure.on('error', () => {});
    secure.once('data', () => requested++);
    switch (mode.kind) {
      case 'http':
        secure.once('data', () => secure.end(HTTP_REPLY(mode.hsts)));
        break;
      case 'banner':
        secure.write('* OK IMAP4rev1 service ready\r\n');
        break;
      case 'reset':
        secure.once('data', () => raw?.resetAndDestroy());
        break;
      case 'close':
        secure.once('data', () => secure.end());
        break;
      case 'legacy-hello':
      case 'legacy-alert':
        secure.once('data', () => secure.end(HTTP_REPLY(false)));
        break;
      default:
        break;
    }
  });

  const front = net.createServer((raw) => {
    sockets.add(raw);
    raw.on('close', () => sockets.delete(raw));
    raw.on('error', () => {});
    accepted++;
    if (mode.kind === 'stall') return;
    if (mode.kind === 'legacy-hello' && (accepted === 1 || mode.retry === 'refuse')) {
      const version = accepted === 1 ? mode.version : 'SSLv3';
      raw.once('data', () => raw.write(oldServerHello(version)));
      return;
    }
    if (mode.kind === 'legacy-hello' && mode.retry === 'stall') return;
    handedOff.push(raw);
    tlsServer.emit('connection', raw);
  });
  await new Promise<void>((resolve) => front.listen(0, '127.0.0.1', () => resolve()));

  return {
    port: (front.address() as net.AddressInfo).port,
    servernames,
    connections: () => accepted,
    requests: () => requested,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => front.close(() => resolve()));
    },
  };
}
