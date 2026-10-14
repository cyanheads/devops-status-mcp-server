/**
 * @fileoverview DNS wire client over node:dgram and node:net — the same answers on Bun and
 * Node. Each record type is one query: UDP with EDNS0, one resend at half the deadline, and a
 * TCP retry on the same address and port when the UDP reply is truncated. One deadline covers
 * every record type queried for a domain+resolver pair, TCP retries included. Outcomes are
 * read from the response code, never inferred from runtime error codes.
 * @module services/dns/dns-wire-client
 */

import { randomInt } from 'node:crypto';
import dgram from 'node:dgram';
import net from 'node:net';
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import { parseResolverTarget } from '@/utils/ssrf-guard.js';
import {
  type DnsReply,
  decodeResponse,
  encodeName,
  encodeQuery,
  MalformedResponseError,
  type QueryKey,
  RR_TYPE_CODES,
  rcodeName,
} from './dns-message.js';
import type { DnsQueryStatus, RecordType } from './dns-service.js';

const DEFAULT_DNS_PORT = 53;

/** One record type's outcome from one resolver. */
export interface TypeAnswer {
  /** Failure detail for an `error` outcome. */
  detail?: string;
  status: DnsQueryStatus;
  /** Rendered record values; non-empty only when `status` is `ok`. */
  values: string[];
}

interface ResolverAddress {
  address: string;
  port: number;
}

class DeadlineExceeded extends Error {}

/** The socket could not be connected to the resolver's address. */
class ResolverUnreachable extends Error {}

/**
 * Parse a resolver target (`ip`, `ip:port`, `[ipv6]:port`) into the address and port the
 * client sends to. A hostname is rejected without being resolved, whatever the private-target
 * setting — that setting widens which addresses are allowed, never whether names are looked up.
 */
export function parseResolverAddress(resolver: string): ResolverAddress {
  const { address, port = DEFAULT_DNS_PORT } = parseResolverTarget(resolver);
  if (net.isIP(address) === 0) {
    throw validationError(
      `Resolver "${resolver}" is not a valid IP address. Pass the resolver as an IPv4 or IPv6 literal, optionally with a port (e.g. "8.8.8.8", "1.1.1.1:53", "[2001:4860:4860::8888]:53").`,
      { reason: 'target_blocked', resolver },
    );
  }
  if (port < 1 || port > 65535) {
    throw validationError(
      `Resolver "${resolver}" has port ${port}, outside the valid range 1–65535.`,
      { reason: 'target_blocked', resolver },
    );
  }
  return { address, port };
}

/**
 * Query one resolver for every requested record type of `domain`, all under one deadline of
 * `timeoutMs`. Never rejects for a DNS or network outcome — each type's failure is its status.
 * Returns one `[type, answer]` entry per requested type, in request order. When `signal`
 * aborts, every open socket closes at once and the call rejects with the signal's reason.
 */
export async function queryRecordTypes(
  resolver: string,
  domain: string,
  types: RecordType[],
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Array<[RecordType, TypeAnswer]>> {
  const target = parseResolverAddress(resolver);
  const qname = encodeName(domain);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  const stop = AbortSignal.any([deadline.signal, signal]);
  try {
    const answers = await Promise.all(
      types.map(
        async (type): Promise<[RecordType, TypeAnswer]> => [
          type,
          await queryType(target, qname, type, stop, timeoutMs / 2),
        ],
      ),
    );
    // The exchanges settle a cancellation as a timeout; it is the caller's, so it is rethrown.
    signal.throwIfAborted();
    return answers;
  } finally {
    clearTimeout(timer);
  }
}

async function queryType(
  target: ResolverAddress,
  qname: Buffer,
  type: RecordType,
  signal: AbortSignal,
  resendAfterMs: number,
): Promise<TypeAnswer> {
  const key: QueryKey = { id: randomInt(0, 0x10000), qname, qtype: RR_TYPE_CODES[type] };
  const query = encodeQuery(key.id, qname, key.qtype);
  try {
    let reply = await exchangeUdp(target, query, key, signal, resendAfterMs);
    if (reply.truncated) reply = await exchangeTcp(target, query, key, signal);
    return answerFromReply(reply);
  } catch (err) {
    return answerFromError(err);
  }
}

function answerFromReply(reply: DnsReply): TypeAnswer {
  switch (reply.rcode) {
    case 0:
      return { status: reply.values.length > 0 ? 'ok' : 'nodata', values: reply.values };
    case 2:
      return { status: 'servfail', values: [] };
    case 3:
      return { status: 'nxdomain', values: [] };
    case 5:
      return { status: 'refused', values: [] };
    default:
      return { status: 'error', values: [], detail: `${rcodeName(reply.rcode)} response` };
  }
}

function answerFromError(err: unknown): TypeAnswer {
  if (err instanceof DeadlineExceeded) return { status: 'timeout', values: [] };
  if (err instanceof ResolverUnreachable) {
    return { status: 'error', values: [], detail: 'the resolver address could not be reached' };
  }
  if (err instanceof MalformedResponseError) {
    return { status: 'error', values: [], detail: `malformed response: ${err.message}` };
  }
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  // A refused TCP connection, or an ICMP port-unreachable surfacing on the connected UDP socket.
  if (code === 'ECONNREFUSED') return { status: 'refused', values: [] };
  return {
    status: 'error',
    values: [],
    detail: code ?? (err instanceof Error ? err.message : String(err)),
  };
}

/**
 * Run one exchange: `start` wires up the socket and returns its cleanup, then calls `settle`
 * with the outcome; the deadline settles it with `DeadlineExceeded`. Only the first settle
 * counts, and the cleanup `start` returned runs exactly once, even when `start` settles
 * synchronously.
 */
function exchange(
  signal: AbortSignal,
  start: (settle: (err: unknown, reply?: DnsReply) => void) => () => void,
): Promise<DnsReply> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DeadlineExceeded());
      return;
    }
    let done = false;
    let cleanup = () => {};
    const onAbort = () => settle(new DeadlineExceeded());
    function settle(err: unknown, reply?: DnsReply): void {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', onAbort);
      cleanup();
      if (reply) resolve(reply);
      else reject(err);
    }
    signal.addEventListener('abort', onAbort);
    try {
      cleanup = start(settle);
    } catch (err) {
      settle(err);
    }
    if (done) cleanup();
  });
}

/**
 * UDP exchange on a connected socket, so the kernel delivers only datagrams from the resolver's
 * own address and port. Datagrams that are not a reply to this query (another ID or question)
 * are ignored and the wait continues; the query is sent once more at `resendAfterMs`.
 */
function exchangeUdp(
  target: ResolverAddress,
  query: Buffer,
  key: QueryKey,
  signal: AbortSignal,
  resendAfterMs: number,
): Promise<DnsReply> {
  return exchange(signal, (settle) => {
    const socket = dgram.createSocket(net.isIPv6(target.address) ? 'udp6' : 'udp4');
    let resend: ReturnType<typeof setTimeout> | undefined;
    socket.on('error', (err) => settle(err));
    socket.on('message', (msg) => {
      try {
        const reply = decodeResponse(msg, key);
        if (reply) settle(null, reply);
      } catch (err) {
        settle(err);
      }
    });
    /** A send racing the deadline's close throws; the exchange has already settled by then. */
    const send = () => {
      try {
        socket.send(query);
      } catch (err) {
        settle(err);
      }
    };
    socket.connect(target.port, target.address, (err?: Error) => {
      /**
       * Node reports a failed connect (no route to the address) to this callback; Bun calls it
       * without an error and leaves the socket unconnected, which `remoteAddress()` exposes.
       */
      try {
        if (err) throw err;
        socket.remoteAddress();
      } catch {
        settle(new ResolverUnreachable());
        return;
      }
      send();
      resend = setTimeout(send, resendAfterMs);
    });
    return () => {
      clearTimeout(resend);
      socket.close();
    };
  });
}

/**
 * TCP exchange: a length-prefixed query, then exactly one length-prefixed response. The
 * 16-bit prefix bounds what is buffered; the bytes are joined once, when the message is whole.
 */
function exchangeTcp(
  target: ResolverAddress,
  query: Buffer,
  key: QueryKey,
  signal: AbortSignal,
): Promise<DnsReply> {
  return exchange(signal, (settle) => {
    const socket = net.connect({ host: target.address, port: target.port });
    const chunks: Buffer[] = [];
    let received = 0;
    let needed: number | undefined;
    socket.on('error', (err) => settle(err));
    socket.on('close', () =>
      settle(new MalformedResponseError('the TCP connection closed before a full response')),
    );
    socket.on('connect', () => {
      const prefix = Buffer.alloc(2);
      prefix.writeUInt16BE(query.length);
      socket.write(Buffer.concat([prefix, query]));
    });
    // No encoding is set on the socket, so every chunk arrives as a Buffer.
    socket.on('data', (data: Buffer) => {
      chunks.push(data);
      received += data.length;
      if (received < 2) return;
      needed ??= 2 + Buffer.concat(chunks).readUInt16BE(0);
      if (received < needed) return;
      try {
        const reply = decodeResponse(Buffer.concat(chunks).subarray(2, needed), key);
        settle(
          reply ? null : new MalformedResponseError('the TCP response does not answer the query'),
          reply ?? undefined,
        );
      } catch (err) {
        settle(err);
      }
    });
    return () => socket.destroy();
  });
}
