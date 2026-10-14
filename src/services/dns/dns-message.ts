/**
 * @fileoverview DNS message wire format (RFC 1035) — query encoding and bounds-checked
 * response decoding, with each record type's RDATA rendered in dig presentation form
 * without trailing dots. Response bytes come from a caller-chosen resolver, so every read
 * is range-checked and a malformed message raises `MalformedResponseError` rather than
 * reading out of bounds or looping.
 * @module services/dns/dns-message
 */

import type { RecordType } from './dns-service.js';

/** RR type codes for the record types the service queries. */
export const RR_TYPE_CODES = {
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  MX: 15,
  TXT: 16,
  AAAA: 28,
  CAA: 257,
} as const satisfies Record<RecordType, number>;

/** EDNS0 UDP payload size advertised in every query — the size that avoids IP fragmentation. */
export const EDNS_UDP_PAYLOAD = 1232;

const HEADER_BYTES = 12;
const CLASS_IN = 1;
const TYPE_OPT = 41;
const FLAG_QR = 0x8000;
const FLAG_TC = 0x0200;
const FLAG_RD = 0x0100;
const OPCODE_MASK = 0x7800;
const MAX_LABEL_BYTES = 63;
const MAX_NAME_WIRE_BYTES = 255;
const MAX_POINTER_JUMPS = 127;

const RCODE_NAMES = ['NOERROR', 'FORMERR', 'SERVFAIL', 'NXDOMAIN', 'NOTIMP', 'REFUSED'];

/** A response that answers the query but cannot be decoded. */
export class MalformedResponseError extends Error {
  override name = 'MalformedResponseError';
}

/** What one query sent, for matching a response to it. */
export interface QueryKey {
  id: number;
  /** The question name in wire form, as `encodeName` produced it. */
  qname: Buffer;
  qtype: number;
}

/** A decoded response that matched its query. */
export interface DnsReply {
  rcode: number;
  truncated: boolean;
  /** Rendered RDATA of the answers of the queried type, empty unless the RCODE is NOERROR. */
  values: string[];
}

/**
 * Encode a domain name to wire form. Throws when the name cannot be put on the wire: an
 * empty label, a label over 63 bytes, or a name over 253 characters. One trailing dot is
 * accepted; `.` alone is the root.
 */
export function encodeName(name: string): Buffer {
  if (name === '.') return Buffer.from([0]);
  const trimmed = name.endsWith('.') ? name.slice(0, -1) : name;
  const parts: Buffer[] = [];
  for (const label of trimmed.split('.')) {
    const bytes = Buffer.from(label, 'utf8');
    if (bytes.length === 0) {
      throw new Error(`Domain "${name}" is not a valid DNS name: it has an empty label.`);
    }
    if (bytes.length > MAX_LABEL_BYTES) {
      throw new Error(
        `Domain "${name}" is not a valid DNS name: a label is longer than ${MAX_LABEL_BYTES} bytes.`,
      );
    }
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  parts.push(Buffer.from([0]));
  const wire = Buffer.concat(parts);
  if (wire.length > MAX_NAME_WIRE_BYTES) {
    throw new Error(`Domain "${name}" is not a valid DNS name: it is longer than 253 characters.`);
  }
  return wire;
}

/** Build a recursive query for one name and type, carrying an EDNS0 OPT record. */
export function encodeQuery(id: number, qname: Buffer, qtype: number): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(FLAG_RD, 2);
  header.writeUInt16BE(1, 4); // QDCOUNT
  header.writeUInt16BE(1, 10); // ARCOUNT — the OPT record
  const question = Buffer.alloc(4);
  question.writeUInt16BE(qtype, 0);
  question.writeUInt16BE(CLASS_IN, 2);
  // OPT: root owner, TYPE 41, CLASS = advertised UDP payload, TTL 0, no options.
  const opt = Buffer.alloc(11);
  opt.writeUInt16BE(TYPE_OPT, 1);
  opt.writeUInt16BE(EDNS_UDP_PAYLOAD, 3);
  return Buffer.concat([header, qname, question, opt]);
}

/** Name of an RCODE for a failure message. */
export function rcodeName(rcode: number): string {
  return RCODE_NAMES[rcode] ?? `RCODE ${rcode}`;
}

function malformed(what: string): MalformedResponseError {
  return new MalformedResponseError(what);
}

function byteAt(msg: Buffer, offset: number): number {
  const byte = msg[offset];
  if (byte === undefined) throw malformed('a name runs past the end of the message');
  return byte;
}

/**
 * Read a possibly compressed name starting at `start`. A compression pointer must target
 * an offset before the label run it continues, so every jump moves strictly backwards and
 * a pointer loop cannot form. The jumps per name are capped as well, so the cost of reading
 * one name stays constant however many records point into the same chain; the decoded name
 * is capped at 255 wire bytes.
 */
function readName(msg: Buffer, start: number): { labels: Buffer[]; next: number } {
  const labels: Buffer[] = [];
  let offset = start;
  let runStart = start;
  let next = -1;
  let wireLength = 1;
  let jumps = 0;
  for (;;) {
    const length = byteAt(msg, offset);
    if (length === 0) return { labels, next: next < 0 ? offset + 1 : next };
    if ((length & 0xc0) === 0xc0) {
      const target = ((length & 0x3f) << 8) | byteAt(msg, offset + 1);
      if (next < 0) next = offset + 2;
      if (target >= runStart) throw malformed('a compression pointer does not point backwards');
      // A name has at most 127 labels, so a well-formed one never needs more jumps.
      if (++jumps > MAX_POINTER_JUMPS) throw malformed('a name follows too many pointers');
      offset = target;
      runStart = target;
      continue;
    }
    if ((length & 0xc0) !== 0) throw malformed('a name uses an unsupported label type');
    wireLength += length + 1;
    if (wireLength > MAX_NAME_WIRE_BYTES) throw malformed('a name is longer than 255 bytes');
    const end = offset + 1 + length;
    if (end > msg.length) throw malformed('a name runs past the end of the message');
    labels.push(msg.subarray(offset + 1, end));
    offset = end;
  }
}

/** Read a name that must end exactly at `end` (the RDATA boundary). */
function readNameEndingAt(msg: Buffer, start: number, end: number): Buffer[] {
  const { labels, next } = readName(msg, start);
  if (next !== end) throw malformed('a name does not fill its record data');
  return labels;
}

/**
 * Presentation form of raw bytes: bytes outside printable ASCII as `\DDD` and the bytes in
 * `special` backslash-escaped — so hostile data can never inject line breaks into output, or a
 * space outside a quoted string, where a space is the field boundary.
 */
function presentBytes(bytes: Buffer, special: string, quoted = false): string {
  const lowest = quoted ? 0x20 : 0x21;
  let out = '';
  for (const byte of bytes) {
    const char = String.fromCharCode(byte);
    if (byte < lowest || byte > 0x7e) out += `\\${byte.toString().padStart(3, '0')}`;
    else out += special.includes(char) ? `\\${char}` : char;
  }
  return out;
}

/** Presentation form of a name without the trailing dot; the root renders as `.`. */
function presentName(labels: Buffer[]): string {
  return labels.length === 0 ? '.' : labels.map((l) => presentBytes(l, '.\\')).join('.');
}

/** Case-insensitive comparison key for a name (RFC 4343). */
function nameKey(labels: Buffer[]): string {
  return presentName(labels).toLowerCase();
}

/** RFC 5952 text form: lowercase hex, no leading zeros, the longest zero run (≥2) as `::`. */
function formatIpv6(msg: Buffer, offset: number): string {
  const groups = Array.from({ length: 8 }, (_, i) => msg.readUInt16BE(offset + 2 * i));
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return `::ffff:${[...msg.subarray(offset + 12, offset + 16)].join('.')}`;
  }
  let bestStart = -1;
  let bestLength = 1;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLength) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }
  const hex = (part: number[]) => part.map((g) => g.toString(16)).join(':');
  if (bestStart < 0) return hex(groups);
  return `${hex(groups.slice(0, bestStart))}::${hex(groups.slice(bestStart + bestLength))}`;
}

/** Render one answer's RDATA, which spans `[start, end)`. */
function renderRdata(msg: Buffer, qtype: number, start: number, end: number): string {
  const length = end - start;
  switch (qtype) {
    case RR_TYPE_CODES.A:
      if (length !== 4) throw malformed('an A record is not 4 bytes');
      return [...msg.subarray(start, end)].join('.');
    case RR_TYPE_CODES.AAAA:
      if (length !== 16) throw malformed('an AAAA record is not 16 bytes');
      return formatIpv6(msg, start);
    case RR_TYPE_CODES.NS:
    case RR_TYPE_CODES.CNAME:
      return presentName(readNameEndingAt(msg, start, end));
    case RR_TYPE_CODES.MX:
      if (length < 3) throw malformed('an MX record is too short');
      return `${msg.readUInt16BE(start)} ${presentName(readNameEndingAt(msg, start + 2, end))}`;
    case RR_TYPE_CODES.TXT: {
      // A record is one or more character-strings; they are joined into one value.
      const strings: Buffer[] = [];
      for (let p = start; p < end; ) {
        const stringEnd = p + 1 + byteAt(msg, p);
        if (stringEnd > end) throw malformed('a TXT string runs past its record data');
        strings.push(msg.subarray(p + 1, stringEnd));
        p = stringEnd;
      }
      return Buffer.concat(strings).toString('utf8');
    }
    case RR_TYPE_CODES.SOA: {
      const primary = readName(msg, start);
      const mailbox = readName(msg, primary.next);
      if (primary.next > end || mailbox.next + 20 !== end) {
        throw malformed('an SOA record does not fill its record data');
      }
      const counters = [0, 4, 8, 12, 16].map((d) => msg.readUInt32BE(mailbox.next + d));
      return [presentName(primary.labels), presentName(mailbox.labels), ...counters].join(' ');
    }
    case RR_TYPE_CODES.CAA: {
      // flags (1 byte), tag length (1 byte), tag, then the value to the end of the record.
      if (length < 2) throw malformed('a CAA record is too short');
      const tagEnd = start + 2 + byteAt(msg, start + 1);
      if (tagEnd === start + 2 || tagEnd > end) throw malformed('a CAA tag does not fit');
      const tag = presentBytes(msg.subarray(start + 2, tagEnd), '"\\');
      const value = presentBytes(msg.subarray(tagEnd, end), '"\\', true);
      return `${byteAt(msg, start)} ${tag} "${value}"`;
    }
    default:
      throw malformed(`record type ${qtype} has no renderer`);
  }
}

/**
 * Decode a response to the query `key`. Returns null when the message is not a reply to
 * it — a different ID, not a response, another opcode, or a different question — so a UDP
 * caller can keep waiting. Throws `MalformedResponseError` when the message does answer the
 * query but its answer section cannot be decoded. Answers are read only for a complete
 * NOERROR response: a truncated one is retried over TCP, and any other RCODE is the outcome.
 *
 * The answer set follows the CNAME chain from the question name, as a stub resolver does:
 * an A query at an alias returns the target's addresses. A CNAME query takes only the
 * CNAME owned by the question name itself.
 */
export function decodeResponse(msg: Buffer, key: QueryKey): DnsReply | null {
  if (msg.length < HEADER_BYTES || msg.readUInt16BE(0) !== key.id) return null;
  const flags = msg.readUInt16BE(2);
  if ((flags & FLAG_QR) === 0 || (flags & OPCODE_MASK) !== 0) return null;
  if (msg.readUInt16BE(4) !== 1) return null;

  const qkey = nameKey(readName(key.qname, 0).labels);
  let question: { labels: Buffer[]; next: number };
  try {
    question = readName(msg, HEADER_BYTES);
  } catch {
    return null;
  }
  const afterQuestion = question.next + 4;
  if (
    afterQuestion > msg.length ||
    nameKey(question.labels) !== qkey ||
    msg.readUInt16BE(question.next) !== key.qtype ||
    msg.readUInt16BE(question.next + 2) !== CLASS_IN
  ) {
    return null;
  }

  const rcode = flags & 0x000f;
  const truncated = (flags & FLAG_TC) !== 0;
  if (truncated || rcode !== 0) return { rcode, truncated, values: [] };

  const records: Array<{ owner: string; type: number; start: number; end: number }> = [];
  let offset = afterQuestion;
  for (let i = msg.readUInt16BE(6); i > 0; i--) {
    const owner = readName(msg, offset);
    const fixed = owner.next;
    if (fixed + 10 > msg.length) throw malformed('a record header runs past the end');
    const start = fixed + 10;
    const end = start + msg.readUInt16BE(fixed + 8);
    if (end > msg.length) throw malformed('record data runs past the end');
    if (msg.readUInt16BE(fixed + 2) === CLASS_IN) {
      records.push({ owner: nameKey(owner.labels), type: msg.readUInt16BE(fixed), start, end });
    }
    offset = end;
  }

  const owners = new Set([qkey]);
  if (key.qtype !== RR_TYPE_CODES.CNAME) {
    const aliases = new Map<string, string[]>();
    for (const r of records) {
      if (r.type !== RR_TYPE_CODES.CNAME) continue;
      const target = nameKey(readNameEndingAt(msg, r.start, r.end));
      const known = aliases.get(r.owner);
      if (known) known.push(target);
      else aliases.set(r.owner, [target]);
    }
    const pending = [qkey];
    for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
      for (const target of aliases.get(name) ?? []) {
        if (owners.has(target)) continue;
        owners.add(target);
        pending.push(target);
      }
    }
  }

  const values = records
    .filter((r) => r.type === key.qtype && owners.has(r.owner))
    .map((r) => renderRdata(msg, key.qtype, r.start, r.end));
  return { rcode, truncated, values };
}
