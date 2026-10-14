/**
 * @fileoverview Loopback fake DNS server for tests — UDP and TCP on one 127.0.0.1 port, each
 * query answered by a test-supplied handler with a response built by `reply()` or raw bytes.
 * @module tests/services/dns/fake-dns-server
 */

import dgram from 'node:dgram';
import net from 'node:net';

/** A query as the fake server received it. */
export interface ReceivedQuery {
  id: number;
  /** Question name, lowercased, without a trailing dot. */
  name: string;
  qtype: number;
  /** The raw question section (name + type + class), echoed into replies. */
  question: Buffer;
  transport: 'udp' | 'tcp';
}

/** What the handler returns: bytes to send, or null to stay silent. */
export type Handler = (query: ReceivedQuery) => Buffer | null;

export const TYPE = {
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  MX: 15,
  TXT: 16,
  AAAA: 28,
  CAA: 257,
} as const;

export const RCODE = { NOERROR: 0, FORMERR: 1, SERVFAIL: 2, NXDOMAIN: 3, NOTIMP: 4, REFUSED: 5 };

/** Encode a presentation name (no compression). */
export function wireName(name: string): Buffer {
  if (name === '' || name === '.') return Buffer.from([0]);
  const parts = name.split('.').flatMap((l) => {
    const bytes = Buffer.from(l, 'utf8');
    return [Buffer.from([bytes.length]), bytes];
  });
  return Buffer.concat([...parts, Buffer.from([0])]);
}

/** One answer record: an owner (a name, or raw wire bytes) plus type and RDATA. */
export interface FakeRecord {
  owner?: string | Buffer;
  rdata: Buffer;
  type: number;
}

export interface ReplyOptions {
  answers?: FakeRecord[];
  /** Override the ID, e.g. to send a reply that does not match. */
  id?: number;
  /** Override the question section. */
  question?: Buffer;
  rcode?: number;
  truncated?: boolean;
}

/** Build a response to `query`. Owners default to a pointer at the question name. */
export function reply(query: ReceivedQuery, options: ReplyOptions = {}): Buffer {
  const answers = options.answers ?? [];
  const header = Buffer.alloc(12);
  header.writeUInt16BE(options.id ?? query.id, 0);
  header.writeUInt16BE(
    0x8000 | 0x0100 | 0x0080 | (options.truncated ? 0x0200 : 0) | (options.rcode ?? 0),
    2,
  );
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(answers.length, 6);
  const records = answers.map((r) => {
    const owner =
      r.owner === undefined
        ? Buffer.from([0xc0, 0x0c])
        : typeof r.owner === 'string'
          ? wireName(r.owner)
          : r.owner;
    const fixed = Buffer.alloc(10);
    fixed.writeUInt16BE(r.type, 0);
    fixed.writeUInt16BE(1, 2);
    fixed.writeUInt32BE(300, 4);
    fixed.writeUInt16BE(r.rdata.length, 8);
    return Buffer.concat([owner, fixed, r.rdata]);
  });
  return Buffer.concat([header, options.question ?? query.question, ...records]);
}

export const rdata = {
  a: (ip: string) => Buffer.from(ip.split('.').map(Number)),
  aaaa: (groups: number[]) => {
    const b = Buffer.alloc(16);
    groups.forEach((g, i) => {
      b.writeUInt16BE(g, i * 2);
    });
    return b;
  },
  name: (name: string) => wireName(name),
  mx: (preference: number, exchange: string) => {
    const p = Buffer.alloc(2);
    p.writeUInt16BE(preference);
    return Buffer.concat([p, wireName(exchange)]);
  },
  /** A TXT record of one or more character-strings (given as strings or raw bytes). */
  txt: (...strings: Array<string | Buffer>) =>
    Buffer.concat(
      strings.flatMap((s) => {
        const bytes = typeof s === 'string' ? Buffer.from(s, 'utf8') : s;
        return [Buffer.from([bytes.length]), bytes];
      }),
    ),
  caa: (flags: number, tag: string, value: string | Buffer) =>
    Buffer.concat([
      Buffer.from([flags, Buffer.byteLength(tag)]),
      Buffer.from(tag, 'latin1'),
      typeof value === 'string' ? Buffer.from(value, 'utf8') : value,
    ]),
  soa: (
    mname: string,
    rname: string,
    serial: number,
    refresh: number,
    retry: number,
    expire: number,
    minimum: number,
  ) => {
    const nums = Buffer.alloc(20);
    [serial, refresh, retry, expire, minimum].forEach((n, i) => {
      nums.writeUInt32BE(n, i * 4);
    });
    return Buffer.concat([wireName(mname), wireName(rname), nums]);
  },
};

function parseQuery(msg: Buffer, transport: 'udp' | 'tcp'): ReceivedQuery {
  const labels: string[] = [];
  let offset = 12;
  for (let len = msg[offset] ?? 0; len !== 0; len = msg[offset] ?? 0) {
    labels.push(msg.toString('latin1', offset + 1, offset + 1 + len));
    offset += len + 1;
  }
  const questionEnd = offset + 5;
  return {
    id: msg.readUInt16BE(0),
    name: labels.join('.').toLowerCase(),
    qtype: msg.readUInt16BE(offset + 1),
    question: msg.subarray(12, questionEnd),
    transport,
  };
}

export interface FakeDnsServer {
  /** `127.0.0.1:<port>` — pass as a resolver. */
  address: string;
  close(): Promise<void>;
  port: number;
  /** Every query received, in arrival order. */
  received: ReceivedQuery[];
  /** Send `bytes` to the most recent UDP client from the server's own port. */
  sendToLastClient(bytes: Buffer): Promise<void>;
  /** Send `bytes` to the most recent UDP client from a different source port. */
  spoofToLastClient(bytes: Buffer): Promise<void>;
}

export interface FakeDnsOptions {
  /**
   * The TCP side: a handler answering framed queries (defaults to the UDP handler), `false` for
   * no TCP listener, or `{ raw }` to write arbitrary bytes for the first chunk a client sends.
   */
  tcp?: Handler | false | { raw: (query: Buffer, socket: net.Socket) => void };
  udp: Handler;
}

/** Start a fake DNS server on a free 127.0.0.1 port, listening on UDP and (unless disabled) TCP. */
export async function startFakeDns(options: FakeDnsOptions): Promise<FakeDnsServer> {
  const received: ReceivedQuery[] = [];
  const sockets = new Set<net.Socket>();
  let lastClient: dgram.RemoteInfo | undefined;

  const tcpOption = options.tcp === undefined ? options.udp : options.tcp;
  const onConnection = (socket: net.Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    if (typeof tcpOption === 'object') {
      const { raw } = tcpOption;
      socket.once('data', (data: Buffer) => raw(data.subarray(2), socket));
      return;
    }
    if (!tcpOption) return;
    const handler = tcpOption;
    let buffered = Buffer.alloc(0);
    socket.on('data', (data: Buffer) => {
      buffered = Buffer.concat([buffered, data]);
      if (buffered.length < 2 || buffered.length < 2 + buffered.readUInt16BE(0)) return;
      const query = parseQuery(buffered.subarray(2, 2 + buffered.readUInt16BE(0)), 'tcp');
      received.push(query);
      const out = handler(query);
      if (!out) return;
      const prefix = Buffer.alloc(2);
      prefix.writeUInt16BE(out.length);
      socket.write(Buffer.concat([prefix, out]));
    });
  };

  /**
   * UDP takes a free port first; TCP then has to listen on the same number, which another
   * process can hold. Retry on a fresh port rather than fail the test on that race.
   */
  let udp: dgram.Socket;
  let tcp: net.Server | undefined;
  for (let attempt = 1; ; attempt++) {
    const socket = dgram.createSocket('udp4');
    await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', () => resolve()));
    if (!tcpOption) {
      udp = socket;
      break;
    }
    const server = net.createServer(onConnection);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socket.address().port, '127.0.0.1', () => resolve());
      });
      udp = socket;
      tcp = server;
      break;
    } catch (err) {
      await new Promise<void>((resolve) => socket.close(() => resolve()));
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || attempt >= 10) throw err;
    }
  }

  udp.on('message', (msg, rinfo) => {
    lastClient = rinfo;
    const query = parseQuery(msg, 'udp');
    received.push(query);
    const out = options.udp(query);
    if (out) udp.send(out, rinfo.port, rinfo.address);
  });
  const port = udp.address().port;

  return {
    address: `127.0.0.1:${port}`,
    port,
    received,
    async sendToLastClient(bytes) {
      const client = lastClient;
      if (!client) throw new Error('no UDP client has queried yet');
      await new Promise<void>((resolve) =>
        udp.send(bytes, client.port, client.address, () => resolve()),
      );
    },
    async spoofToLastClient(bytes) {
      const client = lastClient;
      if (!client) throw new Error('no UDP client has queried yet');
      const other = dgram.createSocket('udp4');
      await new Promise<void>((resolve) => other.bind(0, '127.0.0.1', () => resolve()));
      await new Promise<void>((resolve) =>
        other.send(bytes, client.port, client.address, () => resolve()),
      );
      other.close();
    },
    async close() {
      for (const s of sockets) s.destroy();
      await Promise.all([
        new Promise<void>((resolve) => udp.close(() => resolve())),
        tcp ? new Promise<void>((resolve) => tcp?.close(() => resolve())) : undefined,
      ]);
    },
  };
}

/** A free loopback UDP/TCP port with nothing listening on it. */
export async function closedPort(): Promise<number> {
  const probe = dgram.createSocket('udp4');
  await new Promise<void>((resolve) => probe.bind(0, '127.0.0.1', () => resolve()));
  const { port } = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}
