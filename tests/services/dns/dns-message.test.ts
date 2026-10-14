/**
 * @fileoverview Tests for DNS message encoding and bounds-checked response decoding.
 * @module tests/services/dns/dns-message.test
 */

import { describe, expect, it } from 'vitest';
import {
  decodeResponse,
  EDNS_UDP_PAYLOAD,
  encodeName,
  encodeQuery,
  MalformedResponseError,
  type QueryKey,
} from '@/services/dns/dns-message.js';
import { TYPE, wireName } from './fake-dns-server.js';

const QNAME = encodeName('example.com');
const KEY: QueryKey = { id: 0x1234, qname: QNAME, qtype: TYPE.A };

/** A response header + the KEY question, followed by `body` as the answer section. */
function message(
  answerCount: number,
  body: Buffer,
  { flags = 0x8180, id = KEY.id, qtype = KEY.qtype } = {},
): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(flags, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(answerCount, 6);
  const question = Buffer.alloc(4);
  question.writeUInt16BE(qtype, 0);
  question.writeUInt16BE(1, 2);
  return Buffer.concat([header, QNAME, question, body]);
}

/** One resource record: owner bytes, type, class IN, TTL, RDATA. */
function rr(owner: Buffer, type: number, rdata: Buffer): Buffer {
  const fixed = Buffer.alloc(10);
  fixed.writeUInt16BE(type, 0);
  fixed.writeUInt16BE(1, 2);
  fixed.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([owner, fixed, rdata]);
}

const pointer = (offset: number) => Buffer.from([0xc0 | (offset >> 8), offset & 0xff]);
const QUESTION_PTR = pointer(12);
const ANSWERS_START = 12 + QNAME.length + 4;

describe('encodeName', () => {
  it('encodes labels with their lengths and accepts one trailing dot', () => {
    expect(encodeName('a.bc')).toEqual(Buffer.from([1, 0x61, 2, 0x62, 0x63, 0]));
    expect(encodeName('a.bc.')).toEqual(encodeName('a.bc'));
    expect(encodeName('.')).toEqual(Buffer.from([0]));
  });

  it.each([
    ['a..b', /empty label/],
    ['.a', /empty label/],
    ['a.b..', /empty label/],
    [`${'x'.repeat(64)}.com`, /longer than 63 bytes/],
    [Array.from({ length: 64 }, () => 'abc').join('.'), /longer than 253 characters/],
  ])('rejects %s', (name, message) => {
    expect(() => encodeName(name)).toThrow(message);
  });

  it('accepts the longest encodable name', () => {
    // 4 × (63 + 1) - 1 = 255 wire bytes including the root.
    const name = [63, 63, 63, 61].map((n) => 'x'.repeat(n)).join('.');
    expect(encodeName(name)).toHaveLength(255);
  });
});

describe('encodeQuery', () => {
  it('asks for recursion and carries an EDNS0 OPT record advertising the UDP payload', () => {
    const query = encodeQuery(0xbeef, QNAME, TYPE.TXT);
    expect(query.readUInt16BE(0)).toBe(0xbeef);
    expect(query.readUInt16BE(2)).toBe(0x0100);
    expect(query.readUInt16BE(4)).toBe(1);
    expect(query.readUInt16BE(10)).toBe(1);
    const opt = query.subarray(12 + QNAME.length + 4);
    expect(opt.readUInt16BE(1)).toBe(41);
    expect(opt.readUInt16BE(3)).toBe(EDNS_UDP_PAYLOAD);
    expect(EDNS_UDP_PAYLOAD).toBe(1232);
  });
});

describe('decodeResponse', () => {
  const answerA = rr(QUESTION_PTR, TYPE.A, Buffer.from([192, 0, 2, 1]));

  it('decodes a matching NOERROR answer', () => {
    expect(decodeResponse(message(1, answerA), KEY)).toEqual({
      rcode: 0,
      truncated: false,
      values: ['192.0.2.1'],
    });
  });

  it.each([
    ['shorter than a header', Buffer.alloc(11)],
    ['another ID', message(1, answerA, { id: 0x9999 })],
    ['a query rather than a response', message(1, answerA, { flags: 0x0100 })],
    ['another opcode', message(1, answerA, { flags: 0x8980 })],
    ['another question type', message(1, answerA, { qtype: TYPE.MX })],
  ])('returns null for a message with %s', (_label, msg) => {
    expect(decodeResponse(msg, KEY)).toBeNull();
  });

  it('returns null for a question section that does not decode', () => {
    const msg = message(0, Buffer.alloc(0));
    msg[12] = 0xc0; // a pointer at the question that points forward
    msg[13] = 0x20;
    expect(decodeResponse(msg, KEY)).toBeNull();
  });

  it('skips the answer section of a truncated reply or a failure RCODE', () => {
    const garbage = Buffer.from([0xc0, 0xff, 0xff]);
    expect(decodeResponse(message(9, garbage, { flags: 0x8380 }), KEY)).toEqual({
      rcode: 0,
      truncated: true,
      values: [],
    });
    expect(decodeResponse(message(9, garbage, { flags: 0x8183 }), KEY)).toEqual({
      rcode: 3,
      truncated: false,
      values: [],
    });
  });

  it('throws MalformedResponseError, never a RangeError, on a cut record header', () => {
    const cut = message(1, Buffer.concat([QUESTION_PTR, Buffer.from([0, 1, 0])]));
    expect(() => decodeResponse(cut, KEY)).toThrow(MalformedResponseError);
  });

  describe('compression pointer chains', () => {
    /**
     * A filler record whose RDATA is `jumps - 1` pointers, each pointing at the one before,
     * the first at the question; then an A record owned by a pointer to the last of them —
     * reading that owner takes exactly `jumps` pointer jumps.
     */
    function chained(jumps: number): Buffer {
      const fillerStart = ANSWERS_START + QUESTION_PTR.length + 10;
      const links = [QUESTION_PTR];
      for (let i = 1; i < jumps - 1; i++) links.push(pointer(fillerStart + 2 * (i - 1)));
      const filler = rr(QUESTION_PTR, 99, Buffer.concat(links));
      const last = fillerStart + 2 * (links.length - 1);
      return message(
        2,
        Buffer.concat([filler, rr(pointer(last), TYPE.A, Buffer.from([192, 0, 2, 1]))]),
      );
    }

    it('follows a long backwards chain within the jump budget', () => {
      expect(decodeResponse(chained(127), KEY)?.values).toEqual(['192.0.2.1']);
    });

    it('rejects a chain past the jump budget', () => {
      expect(() => decodeResponse(chained(128), KEY)).toThrow(/too many pointers/);
    });
  });

  it('rejects a CNAME whose target does not fill its record data', () => {
    const cname = rr(
      QUESTION_PTR,
      TYPE.CNAME,
      Buffer.concat([wireName('a.example'), Buffer.from([7])]),
    );
    expect(() => decodeResponse(message(1, cname), KEY)).toThrow(/does not fill/);
  });

  it('ignores records of another class', () => {
    const chaos = Buffer.from(answerA);
    chaos.writeUInt16BE(3, 2 + 2); // class CH
    expect(decodeResponse(message(1, chaos), KEY)?.values).toEqual([]);
  });

  /**
   * Upstream-sized input: decoding cost must grow linearly with the message. Each shape is a
   * worst case for one part of the decoder — owners read through long pointer chains, a long
   * CNAME chain walked to the queried records, and many character-strings in one TXT record.
   */
  describe('decoding cost', () => {
    const SIZES = [5_000, 20_000, 80_000, 320_000];

    function chainOwners(size: number): Buffer {
      const fillerStart = ANSWERS_START + QUESTION_PTR.length + 10;
      const links = [QUESTION_PTR];
      for (let i = 1; i < 120; i++) links.push(pointer(fillerStart + 2 * (i - 1)));
      const filler = rr(QUESTION_PTR, 99, Buffer.concat(links));
      const deep = pointer(fillerStart + 2 * (links.length - 1));
      const record = rr(deep, TYPE.A, Buffer.from([192, 0, 2, 1]));
      const count = Math.min(65_534, Math.floor((size - filler.length) / record.length));
      return message(count + 1, Buffer.concat([filler, ...Array(count).fill(record)]));
    }

    /** Owners read through a pointer chain as long as the message allows. */
    function overlongChain(size: number): Buffer {
      const fillerStart = ANSWERS_START + QUESTION_PTR.length + 10;
      const chainLength = Math.min(Math.floor(size / 8), 8_000);
      const links = [QUESTION_PTR];
      for (let i = 1; i < chainLength; i++) links.push(pointer(fillerStart + 2 * (i - 1)));
      const filler = rr(QUESTION_PTR, 99, Buffer.concat(links));
      const deep = pointer(fillerStart + 2 * (links.length - 1));
      const record = rr(deep, TYPE.A, Buffer.from([192, 0, 2, 1]));
      const count = Math.min(65_534, Math.floor((size - filler.length) / record.length));
      return message(count + 1, Buffer.concat([filler, ...Array(count).fill(record)]));
    }

    /** Many CNAMEs owned by the question name. */
    function sharedOwnerCnames(size: number): Buffer {
      const record = rr(QUESTION_PTR, TYPE.CNAME, QUESTION_PTR);
      const count = Math.min(65_535, Math.floor(size / record.length));
      return message(count, Buffer.concat(Array(count).fill(record)));
    }

    function cnameChain(size: number): Buffer {
      const records: Buffer[] = [];
      let owner: Buffer = QUESTION_PTR;
      let length = 0;
      for (let i = 0; length < size && records.length < 65_534; i++) {
        const target = wireName(`h${i}.example`);
        const record = rr(owner, TYPE.CNAME, target);
        records.push(record);
        length += record.length;
        owner = target;
      }
      records.push(rr(owner, TYPE.A, Buffer.from([192, 0, 2, 1])));
      return message(records.length, Buffer.concat(records));
    }

    function txtStrings(size: number): Buffer {
      const records: Buffer[] = [];
      for (let length = 0; length < size; ) {
        // Pairs of [length 1, 'a'], so every byte pair is one character-string.
        const pairs = Math.min(32_000, Math.ceil((size - length) / 2));
        const rdata = Buffer.alloc(pairs * 2, 0x61);
        for (let p = 0; p < rdata.length; p += 2) rdata[p] = 1;
        const record = rr(QUESTION_PTR, TYPE.TXT, rdata);
        records.push(record);
        length += record.length;
      }
      return message(records.length, Buffer.concat(records), { qtype: TYPE.TXT });
    }

    function cpuMicros(run: () => void): number {
      const before = process.threadCpuUsage();
      for (let i = 0; i < 3; i++) run();
      const used = process.threadCpuUsage(before);
      return (used.user + used.system) / 3;
    }

    /** Decode, treating a rejection as a finished decode — rejecting early is the point. */
    function decodeOrReject(msg: Buffer, key: QueryKey): void {
      try {
        decodeResponse(msg, key);
      } catch (err) {
        if (!(err instanceof MalformedResponseError)) throw err;
      }
    }

    it.each([
      ['pointer-chain owners', chainOwners, TYPE.A, true],
      ['an over-long pointer chain', overlongChain, TYPE.A, false],
      ['CNAMEs sharing one owner', sharedOwnerCnames, TYPE.A, true],
      ['a long CNAME chain', cnameChain, TYPE.A, true],
      ['one-byte TXT strings', txtStrings, TYPE.TXT, true],
    ] as const)('stays linear for %s', (_label, build, qtype, decodes) => {
      const key = { ...KEY, qtype };
      const timings = SIZES.map((size) => {
        const msg = build(size);
        // A well-formed shape must decode in full, so its timing measures the whole decode.
        if (decodes) expect(decodeResponse(msg, key)).not.toBeNull();
        return cpuMicros(() => decodeOrReject(msg, key));
      });
      const smallest = Math.max(timings[0] ?? 1, 50);
      expect((timings.at(-1) ?? 0) / smallest).toBeLessThan(256);
      // Absolute bound on the largest input, in this thread's CPU time (200 ms).
      expect(timings.at(-1) ?? 0).toBeLessThan(200_000);
    });
  });
});
