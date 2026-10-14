/**
 * @fileoverview Tests for the DNS wire client against a loopback fake DNS server: response-code
 * mapping, the TCP retry on truncation, the per-pair deadline, reply matching, and hostile bytes.
 * @module tests/services/dns/dns-wire-client.test
 */

import type net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RecordType } from '@/services/dns/dns-service.js';
import {
  parseResolverAddress,
  queryRecordTypes,
  type TypeAnswer,
} from '@/services/dns/dns-wire-client.js';
import {
  closedPort,
  type FakeDnsOptions,
  type FakeDnsServer,
  RCODE,
  rdata,
  reply,
  startFakeDns,
  TYPE,
  wireName,
} from './fake-dns-server.js';

let server: FakeDnsServer | undefined;

afterEach(async () => {
  vi.useRealTimers();
  await server?.close();
  server = undefined;
});

/**
 * The timing cases fake only `setTimeout`/`clearTimeout`, which carry the deadline and the UDP
 * resend; the sockets stay real. The clock moves only when a case advances it, so a query that
 * settles did so on its own I/O or at the exact deadline step, never on how fast the machine is.
 */
const fakeDeadline = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

/** Waits on real I/O (node:timers/promises is never faked) until `condition` holds. */
async function until(condition: () => boolean): Promise<void> {
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
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await sleep(0);
}

async function serve(options: FakeDnsOptions): Promise<FakeDnsServer> {
  server = await startFakeDns(options);
  return server;
}

/** Query and return the answers keyed by type. */
async function query(
  resolver: string,
  domain: string,
  types: RecordType[],
  timeoutMs = 2000,
  signal = new AbortController().signal,
): Promise<Partial<Record<RecordType, TypeAnswer>>> {
  return Object.fromEntries(await queryRecordTypes(resolver, domain, types, timeoutMs, signal));
}

describe('queryRecordTypes', () => {
  describe('outcome from the response code', () => {
    it.each([
      ['NOERROR with an answer', { rcode: RCODE.NOERROR, a: true }, 'ok'],
      ['NOERROR without an answer', { rcode: RCODE.NOERROR, a: false }, 'nodata'],
      ['NXDOMAIN', { rcode: RCODE.NXDOMAIN, a: false }, 'nxdomain'],
      ['SERVFAIL', { rcode: RCODE.SERVFAIL, a: false }, 'servfail'],
      ['REFUSED', { rcode: RCODE.REFUSED, a: false }, 'refused'],
    ] as const)('maps %s to %s', async (_label, { rcode, a }, status) => {
      const s = await serve({
        udp: (q) =>
          reply(q, { rcode, answers: a ? [{ type: TYPE.A, rdata: rdata.a('192.0.2.7') }] : [] }),
      });
      const answers = await query(s.address, 'example.com', ['A']);
      expect(answers.A?.status).toBe(status);
      expect(answers.A?.values).toEqual(a ? ['192.0.2.7'] : []);
    });

    it('maps any other response code to error, naming it', async () => {
      const s = await serve({ udp: (q) => reply(q, { rcode: RCODE.NOTIMP }) });
      const answers = await query(s.address, 'example.com', ['A', 'MX']);
      expect(answers.A).toEqual({ status: 'error', values: [], detail: 'NOTIMP response' });
      expect(answers.MX).toEqual({ status: 'error', values: [], detail: 'NOTIMP response' });
    });

    it('gives each record type its own outcome from the same resolver', async () => {
      const s = await serve({
        udp: (q) =>
          q.qtype === TYPE.A
            ? reply(q, { answers: [{ type: TYPE.A, rdata: rdata.a('192.0.2.1') }] })
            : q.qtype === TYPE.MX
              ? reply(q, { rcode: RCODE.SERVFAIL })
              : reply(q),
      });
      const answers = await query(s.address, 'example.com', ['A', 'AAAA', 'MX']);
      expect(answers.A?.status).toBe('ok');
      expect(answers.AAAA?.status).toBe('nodata');
      expect(answers.MX?.status).toBe('servfail');
    });

    it('reports an address the socket cannot connect to as an error, on every runtime', async () => {
      // A link-local address without a zone has no route on any host.
      const answers = await query('fe80::1', 'example.com', ['A', 'MX'], 1000);
      expect(answers.A).toEqual({
        status: 'error',
        values: [],
        detail: 'the resolver address could not be reached',
      });
      expect(answers.MX?.status).toBe('error');
    });

    it('reports a resolver port with nothing listening as refused', async () => {
      const port = await closedPort();
      const answers = await query(`127.0.0.1:${port}`, 'example.com', ['A'], 1500);
      expect(answers.A?.status).toBe('refused');
    });
  });

  describe('record rendering', () => {
    it('keeps a multi-string TXT record whole and other records separate', async () => {
      const s = await serve({
        udp: (q) =>
          reply(q, {
            answers: [
              {
                type: TYPE.TXT,
                rdata: rdata.txt('v=spf1 ip4:192.0.2.0/24 ip4:62.253.2', '27.114 ~all'),
              },
              { type: TYPE.TXT, rdata: rdata.txt('google-site-verification=abc') },
            ],
          }),
      });
      const answers = await query(s.address, 'example.com', ['TXT']);
      expect(answers.TXT?.values).toEqual([
        'v=spf1 ip4:192.0.2.0/24 ip4:62.253.227.114 ~all',
        'google-site-verification=abc',
      ]);
    });

    it('decodes a TXT value as UTF-8 even when a character spans two strings', async () => {
      const bytes = Buffer.from('café', 'utf8');
      const s = await serve({
        udp: (q) =>
          reply(q, {
            answers: [
              { type: TYPE.TXT, rdata: rdata.txt(bytes.subarray(0, 4), bytes.subarray(4)) },
            ],
          }),
      });
      expect((await query(s.address, 'example.com', ['TXT'])).TXT?.values).toEqual(['café']);
    });

    it('renders MX, NS, and CNAME names without the trailing dot', async () => {
      const s = await serve({
        udp: (q) =>
          reply(q, {
            answers:
              q.qtype === TYPE.MX
                ? [{ type: TYPE.MX, rdata: rdata.mx(10, 'mail.example.com') }]
                : q.qtype === TYPE.NS
                  ? [{ type: TYPE.NS, rdata: rdata.name('ns1.example.net') }]
                  : [{ type: TYPE.CNAME, rdata: rdata.name('target.example.org') }],
          }),
      });
      const answers = await query(s.address, 'example.com', ['MX', 'NS', 'CNAME']);
      expect(answers.MX?.values).toEqual(['10 mail.example.com']);
      expect(answers.NS?.values).toEqual(['ns1.example.net']);
      expect(answers.CNAME?.values).toEqual(['target.example.org']);
    });

    it('renders a null MX exchange as the root', async () => {
      const s = await serve({
        udp: (q) => reply(q, { answers: [{ type: TYPE.MX, rdata: rdata.mx(0, '.') }] }),
      });
      expect((await query(s.address, 'example.com', ['MX'])).MX?.values).toEqual(['0 .']);
    });

    it('escapes label bytes that would break a rendered line', async () => {
      const label = Buffer.from('a b\nc.d', 'latin1');
      const name = Buffer.concat([Buffer.from([label.length]), label, wireName('example.net')]);
      const s = await serve({
        udp: (q) => reply(q, { answers: [{ type: TYPE.NS, rdata: name }] }),
      });
      expect((await query(s.address, 'example.com', ['NS'])).NS?.values).toEqual([
        'a\\032b\\010c\\.d.example.net',
      ]);
    });

    it.each([
      [[0x2001, 0xdb8, 0, 0, 0, 0, 0, 1], '2001:db8::1'],
      [[0, 0, 0, 0, 0, 0, 0, 1], '::1'],
      [[0x2001, 0xdb8, 0, 1, 1, 1, 1, 1], '2001:db8:0:1:1:1:1:1'],
      [[0x2001, 0, 0, 1, 0, 0, 0, 1], '2001:0:0:1::1'],
      [[0x2001, 0xdb8, 0, 0, 1, 0, 0, 1], '2001:db8::1:0:0:1'],
      [[0x2607, 0xf8b0, 0x4005, 0x80e, 0, 0, 0, 0x200e], '2607:f8b0:4005:80e::200e'],
      [[0, 0, 0, 0, 0, 0xffff, 0xc000, 0x0207], '::ffff:192.0.2.7'],
    ])('renders AAAA %j in the RFC 5952 form %s', async (groups, text) => {
      const s = await serve({
        udp: (q) => reply(q, { answers: [{ type: TYPE.AAAA, rdata: rdata.aaaa(groups) }] }),
      });
      expect((await query(s.address, 'example.com', ['AAAA'])).AAAA?.values).toEqual([text]);
    });

    it('renders CAA as <flags> <tag> "<value>" (#70)', async () => {
      const s = await serve({
        udp: (q) =>
          reply(q, {
            answers: [
              { type: TYPE.CAA, rdata: rdata.caa(0, 'issue', 'letsencrypt.org') },
              { type: TYPE.CAA, rdata: rdata.caa(0, 'issuewild', 'digicert.com') },
              { type: TYPE.CAA, rdata: rdata.caa(128, 'iodef', 'mailto:security@example.com') },
              {
                type: TYPE.CAA,
                rdata: rdata.caa(0, 'issue', 'ca.example; validationmethods=dns-01'),
              },
            ],
          }),
      });
      expect((await query(s.address, 'example.com', ['CAA'])).CAA).toEqual({
        status: 'ok',
        values: [
          '0 issue "letsencrypt.org"',
          '0 issuewild "digicert.com"',
          '128 iodef "mailto:security@example.com"',
          '0 issue "ca.example; validationmethods=dns-01"',
        ],
      });
    });

    it('escapes quotes, backslashes, and control bytes inside a CAA value', async () => {
      const value = Buffer.concat([Buffer.from('a"b\\c'), Buffer.from([0x0a])]);
      const s = await serve({
        udp: (q) =>
          reply(q, { answers: [{ type: TYPE.CAA, rdata: rdata.caa(0, 'issue', value) }] }),
      });
      expect((await query(s.address, 'example.com', ['CAA'])).CAA?.values).toEqual([
        '0 issue "a\\"b\\\\c\\010"',
      ]);
    });

    it('renders SOA as primary, hostmaster, serial, and the four timers (#70)', async () => {
      const s = await serve({
        udp: (q) =>
          reply(q, {
            answers: [
              {
                type: TYPE.SOA,
                rdata: rdata.soa(
                  'dns1.p08.nsone.net',
                  'hostmaster.nsone.net',
                  1656468023,
                  43200,
                  7200,
                  1209600,
                  3600,
                ),
              },
            ],
          }),
      });
      expect((await query(s.address, 'example.com', ['SOA'])).SOA?.values).toEqual([
        'dns1.p08.nsone.net hostmaster.nsone.net 1656468023 43200 7200 1209600 3600',
      ]);
    });

    it('renders the full unsigned 32-bit range of SOA counters', async () => {
      const s = await serve({
        udp: (q) =>
          reply(q, {
            answers: [
              {
                type: TYPE.SOA,
                rdata: rdata.soa('a.example', 'b.example', 0xffffffff, 0, 1, 2, 3),
              },
            ],
          }),
      });
      expect((await query(s.address, 'example.com', ['SOA'])).SOA?.values).toEqual([
        'a.example b.example 4294967295 0 1 2 3',
      ]);
    });

    const soaNames = Buffer.concat([wireName('a.example'), wireName('b.example')]);
    it.each([
      ['a CAA record under 2 bytes', 'CAA', Buffer.from([0])],
      ['a CAA tag of length 0', 'CAA', Buffer.from([0, 0, 0x61])],
      ['a CAA tag past the record', 'CAA', Buffer.from([0, 9, 0x61])],
      ['an SOA missing its counters', 'SOA', Buffer.concat([soaNames, Buffer.alloc(19)])],
      ['an SOA with trailing bytes', 'SOA', Buffer.concat([soaNames, Buffer.alloc(21)])],
    ] as const)('reports %s as malformed', async (_label, recordType, bytes) => {
      const s = await serve({
        udp: (q) => reply(q, { answers: [{ type: TYPE[recordType], rdata: bytes }] }),
      });
      const answer = (await query(s.address, 'example.com', [recordType]))[recordType];
      expect(answer?.status).toBe('error');
      expect(answer?.detail).toMatch(/^malformed response: /);
    });

    it('reports CAA and SOA absent at a name as nodata, and at a missing name as nxdomain', async () => {
      const s = await serve({
        udp: (q) => (q.name === 'api.example.com' ? reply(q) : reply(q, { rcode: RCODE.NXDOMAIN })),
      });
      const present = await query(s.address, 'api.example.com', ['CAA', 'SOA']);
      expect(present.CAA).toEqual({ status: 'nodata', values: [] });
      expect(present.SOA).toEqual({ status: 'nodata', values: [] });
      expect((await query(s.address, 'missing.example.com', ['CAA'])).CAA?.status).toBe('nxdomain');
    });

    it('follows the CNAME chain from the question name and ignores unrelated records', async () => {
      const s = await serve({
        udp: (q) =>
          reply(q, {
            answers: [
              { type: TYPE.CNAME, rdata: rdata.name('edge.example.net') },
              {
                owner: 'edge.example.net',
                type: TYPE.CNAME,
                rdata: rdata.name('origin.example.org'),
              },
              { owner: 'origin.example.org', type: TYPE.A, rdata: rdata.a('192.0.2.10') },
              { owner: 'unrelated.example', type: TYPE.A, rdata: rdata.a('192.0.2.66') },
            ],
          }),
      });
      expect((await query(s.address, 'www.example.com', ['A'])).A?.values).toEqual(['192.0.2.10']);
    });

    it('takes only the CNAME owned by the question name for a CNAME query', async () => {
      const s = await serve({
        udp: (q) =>
          reply(q, {
            answers: [
              { type: TYPE.CNAME, rdata: rdata.name('edge.example.net') },
              {
                owner: 'edge.example.net',
                type: TYPE.CNAME,
                rdata: rdata.name('origin.example.org'),
              },
            ],
          }),
      });
      expect((await query(s.address, 'www.example.com', ['CNAME'])).CNAME?.values).toEqual([
        'edge.example.net',
      ]);
    });
  });

  describe('TCP retry on truncation', () => {
    it('retries a truncated UDP reply over TCP to the same port', async () => {
      const s = await serve({
        udp: (q) => reply(q, { truncated: true }),
        tcp: (q) =>
          reply(q, {
            answers: [{ type: TYPE.TXT, rdata: rdata.txt('x'.repeat(255), 'y'.repeat(65)) }],
          }),
      });
      const answers = await query(s.address, 'example.com', ['TXT']);
      expect(answers.TXT).toEqual({
        status: 'ok',
        values: [`${'x'.repeat(255)}${'y'.repeat(65)}`],
      });
      expect(s.received.map((r) => r.transport)).toEqual(['udp', 'tcp']);
    });

    it('reports a refused TCP retry as refused', async () => {
      const s = await serve({ udp: (q) => reply(q, { truncated: true }), tcp: false });
      expect((await query(s.address, 'example.com', ['TXT'])).TXT?.status).toBe('refused');
    });

    it('reports a TCP response that does not answer the query as error', async () => {
      const s = await serve({
        udp: (q) => reply(q, { truncated: true }),
        tcp: (q) => reply(q, { id: (q.id + 1) & 0xffff }),
      });
      const answer = (await query(s.address, 'example.com', ['A'])).A;
      expect(answer?.status).toBe('error');
      expect(answer?.detail).toContain('does not answer the query');
    });
  });

  describe('one deadline per domain+resolver', () => {
    it('times out a silent resolver within the deadline, resending UDP once', async () => {
      const s = await serve({ udp: () => null });
      fakeDeadline();
      const pending = query(s.address, 'example.com', ['A', 'MX'], 400);
      const state = track(pending);
      await until(() => s.received.length === 2);

      // No resend before half the deadline: give a stray datagram real time to land.
      await advance(199);
      await sleep(20);
      expect(s.received).toHaveLength(2);
      await advance(1);
      await until(() => s.received.length === 4);

      await advance(199);
      expect(state.settled).toBe(false);
      await advance(1);
      expect(state.settled).toBe(true);
      const answers = await pending;
      expect(answers.A?.status).toBe('timeout');
      expect(answers.MX?.status).toBe('timeout');
      // One send plus one resend per record type, never more.
      expect(s.received.filter((r) => r.qtype === TYPE.A)).toHaveLength(2);
      expect(s.received.filter((r) => r.qtype === TYPE.MX)).toHaveLength(2);
    });

    it('bounds the TCP retry by the same deadline', async () => {
      const s = await serve({ udp: (q) => reply(q, { truncated: true }), tcp: () => null });
      fakeDeadline();
      const pending = query(s.address, 'example.com', ['TXT'], 400);
      const state = track(pending);
      await until(() => s.received.some((r) => r.transport === 'tcp'));

      await advance(399);
      expect(state.settled).toBe(false);
      await advance(1);
      expect(state.settled).toBe(true);
      expect((await pending).TXT?.status).toBe('timeout');
    });

    it('answers a quick type without waiting for a slow one to time out', async () => {
      const s = await serve({
        udp: (q) =>
          q.qtype === TYPE.A
            ? reply(q, { answers: [{ type: TYPE.A, rdata: rdata.a('192.0.2.1') }] })
            : null,
      });
      const answers = await query(s.address, 'example.com', ['A', 'AAAA'], 400);
      expect(answers.A?.status).toBe('ok');
      expect(answers.AAAA?.status).toBe('timeout');
    });
  });

  describe('caller cancellation', () => {
    it('stops a pending UDP query at once and rejects with the caller reason', async () => {
      const s = await serve({ udp: () => null });
      fakeDeadline();
      const caller = new AbortController();
      const reason = new Error('caller went away');
      const pending = query(s.address, 'example.com', ['A', 'MX'], 2000, caller.signal);
      await until(() => s.received.length === 2);
      caller.abort(reason);

      // The deadline never fires here, so only the abort can settle the query.
      await expect(pending).rejects.toBe(reason);
      // The sockets closed with the abort, so the resend at half the deadline never goes out.
      await advance(2000);
      await sleep(50);
      expect(s.received).toHaveLength(2);
    });

    it('stops a pending TCP retry at once', async () => {
      const s = await serve({ udp: (q) => reply(q, { truncated: true }), tcp: () => null });
      fakeDeadline();
      const caller = new AbortController();
      const pending = query(s.address, 'example.com', ['TXT'], 2000, caller.signal);
      await until(() => s.received.some((r) => r.transport === 'tcp'));
      caller.abort();

      // The deadline never fires here, so only the abort can settle the query.
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('sends nothing when the caller has already gone', async () => {
      const s = await serve({ udp: () => null });
      const caller = new AbortController();
      caller.abort();

      await expect(query(s.address, 'example.com', ['A'], 2000, caller.signal)).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(s.received).toEqual([]);
    });
  });

  describe('reply matching', () => {
    it('ignores replies with another ID or question and takes the matching one', async () => {
      const s = await serve({ udp: () => null });
      const pending = query(s.address, 'example.com', ['A']);
      await until(() => s.received.length > 0);
      const q = s.received[0]!;
      const answer = (ip: string) => [{ type: TYPE.A, rdata: rdata.a(ip) }];
      await s.sendToLastClient(
        reply(q, { id: (q.id + 1) & 0xffff, answers: answer('192.0.2.66') }),
      );
      const otherQuestion = Buffer.concat([wireName('other.example'), q.question.subarray(-4)]);
      await s.sendToLastClient(
        reply(q, { question: otherQuestion, answers: answer('192.0.2.67') }),
      );
      await s.sendToLastClient(reply(q, { answers: answer('192.0.2.1') }));
      expect((await pending).A?.values).toEqual(['192.0.2.1']);
    });

    it('ignores a matching reply sent from another source port', async () => {
      const s = await serve({ udp: () => null });
      const pending = query(s.address, 'example.com', ['A']);
      await until(() => s.received.length > 0);
      const q = s.received[0]!;
      await s.spoofToLastClient(
        reply(q, { answers: [{ type: TYPE.A, rdata: rdata.a('192.0.2.66') }] }),
      );
      await s.sendToLastClient(
        reply(q, { answers: [{ type: TYPE.A, rdata: rdata.a('192.0.2.1') }] }),
      );
      expect((await pending).A?.values).toEqual(['192.0.2.1']);
    });

    it('matches the question name case-insensitively', async () => {
      const s = await serve({
        udp: (q) =>
          reply(q, {
            question: Buffer.concat([wireName('ExAmPlE.CoM'), q.question.subarray(-4)]),
            answers: [{ type: TYPE.A, rdata: rdata.a('192.0.2.1') }],
          }),
      });
      expect((await query(s.address, 'example.com', ['A'])).A?.status).toBe('ok');
    });
  });

  describe('hostile replies', () => {
    /** Answer section bytes appended after a matching header + question. */
    function withAnswerBytes(q: { id: number; question: Buffer }, count: number, bytes: Buffer) {
      const header = Buffer.alloc(12);
      header.writeUInt16BE(q.id, 0);
      header.writeUInt16BE(0x8180, 2);
      header.writeUInt16BE(1, 4);
      header.writeUInt16BE(count, 6);
      return Buffer.concat([header, q.question, bytes]);
    }

    /** An A record from raw owner bytes, a declared RDLENGTH, and the RDATA actually sent. */
    const rawA = (owner: number[], rdlength: number, data: number[]) => {
      const fixed = Buffer.alloc(10);
      fixed.writeUInt16BE(TYPE.A, 0);
      fixed.writeUInt16BE(1, 2);
      fixed.writeUInt16BE(rdlength, 8);
      return Buffer.concat([Buffer.from(owner), fixed, Buffer.from(data)]);
    };

    it.each([
      ['an answer count past the end', (q) => withAnswerBytes(q, 5, Buffer.alloc(0))],
      [
        'record data past the end',
        (q) => withAnswerBytes(q, 1, rawA([0xc0, 0x0c], 400, [1, 2, 3, 4])),
      ],
      [
        'a pointer to itself',
        (q) => withAnswerBytes(q, 1, rawA([0xc0, 12 + q.question.length], 4, [1, 2, 3, 4])),
      ],
      ['a forward pointer', (q) => withAnswerBytes(q, 1, rawA([0xc0, 0xff], 4, [1, 2, 3, 4]))],
      ['a reserved label type', (q) => withAnswerBytes(q, 1, rawA([0x40, 0x00], 4, [1, 2, 3, 4]))],
      [
        'an A record of the wrong length',
        (q) => withAnswerBytes(q, 1, rawA([0xc0, 0x0c], 3, [1, 2, 3])),
      ],
      ['a label past the end', (q) => withAnswerBytes(q, 1, Buffer.from([0x3f, 0x61]))],
    ] as Array<[string, (q: { id: number; question: Buffer }) => Buffer]>)(
      'reports %s as an error for that type',
      async (_label, build) => {
        const s = await serve({ udp: (q) => (q.qtype === TYPE.A ? build(q) : reply(q)) });
        const answers = await query(s.address, 'example.com', ['A', 'MX'], 1000);
        expect(answers.A?.status).toBe('error');
        expect(answers.A?.detail).toMatch(/^malformed response: /);
        // The other type from the same resolver is unaffected.
        expect(answers.MX?.status).toBe('nodata');
      },
    );

    it('reports a TXT string that overruns its record as an error', async () => {
      const s = await serve({
        udp: (q) =>
          reply(q, { answers: [{ type: TYPE.TXT, rdata: Buffer.from([10, 0x61, 0x62]) }] }),
      });
      expect((await query(s.address, 'example.com', ['TXT'])).TXT?.status).toBe('error');
    });

    it('times out, without throwing, when every datagram is garbage', async () => {
      const s = await serve({ udp: () => Buffer.from([1, 2, 3]) });
      const answers = await query(s.address, 'example.com', ['A'], 300);
      expect(answers.A?.status).toBe('timeout');
    });

    describe('raw TCP peers', () => {
      /** A UDP fake that always truncates, with a TCP peer on the same port writing `raw`. */
      function truncatingWithRawTcp(raw: (query: Buffer, socket: net.Socket) => void) {
        return serve({ udp: (q) => reply(q, { truncated: true }), tcp: { raw } });
      }

      it('reads exactly the length-prefixed message and ignores bytes after it', async () => {
        const s = await truncatingWithRawTcp((query, socket) => {
          const q = { id: query.readUInt16BE(0), question: query.subarray(12, query.length - 11) };
          const msg = reply(
            { ...q, name: 'example.com', qtype: TYPE.A, transport: 'tcp' },
            { answers: [{ type: TYPE.A, rdata: rdata.a('192.0.2.1') }] },
          );
          const prefix = Buffer.alloc(2);
          prefix.writeUInt16BE(msg.length);
          socket.write(Buffer.concat([prefix, msg, Buffer.alloc(4096, 0xff)]));
        });
        expect((await query(s.address, 'example.com', ['A'])).A).toEqual({
          status: 'ok',
          values: ['192.0.2.1'],
        });
      });

      it('bounds a peer that announces a full-size message and stalls by the deadline', async () => {
        let stalled = false;
        const s = await truncatingWithRawTcp((_query, socket) => {
          socket.write(Buffer.from([0xff, 0xff, 0x00]));
          stalled = true;
        });
        fakeDeadline();
        const pending = query(s.address, 'example.com', ['A'], 300);
        const state = track(pending);
        await until(() => stalled);

        await advance(299);
        expect(state.settled).toBe(false);
        await advance(1);
        expect(state.settled).toBe(true);
        expect((await pending).A?.status).toBe('timeout');
      });

      it('reports a peer that closes mid-message as an error', async () => {
        const s = await truncatingWithRawTcp((_query, socket) => {
          socket.end(Buffer.from([0x00, 0x40, 0x01]));
        });
        const answer = (await query(s.address, 'example.com', ['A'])).A;
        expect(answer?.status).toBe('error');
        expect(answer?.detail).toContain('closed before a full response');
      });
    });
  });
});

describe('parseResolverAddress', () => {
  it.each([
    ['8.8.8.8', { address: '8.8.8.8', port: 53 }],
    ['1.1.1.1:5353', { address: '1.1.1.1', port: 5353 }],
    ['2001:4860:4860::8888', { address: '2001:4860:4860::8888', port: 53 }],
    ['[2001:4860:4860::8888]:53', { address: '2001:4860:4860::8888', port: 53 }],
  ])('parses %s', (input, expected) => {
    expect(parseResolverAddress(input)).toEqual(expected);
  });

  it.each(['dns.google', 'localhost', '8.8.8.8.8', ''])(
    'rejects %j as target_blocked without resolving it',
    (input) => {
      expect(() => parseResolverAddress(input)).toThrow(
        expect.objectContaining({
          message: expect.stringContaining('is not a valid IP address'),
          data: expect.objectContaining({ reason: 'target_blocked' }),
        }),
      );
    },
  );

  it.each(['1.1.1.1:0', '1.1.1.1:65536', '[::1]:99999'])('rejects the port in %s', (input) => {
    expect(() => parseResolverAddress(input)).toThrow(/outside the valid range 1–65535/);
  });
});
