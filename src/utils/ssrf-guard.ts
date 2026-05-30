/**
 * @fileoverview SSRF guard — blocks requests to private, loopback, link-local, and cloud-metadata
 * addresses for user-supplied targets. Registry vendor URLs are pre-verified public endpoints and
 * bypass this guard at the call site; only user-supplied raw URLs and domain inputs go through it.
 *
 * Opt-in: set STATUS_ALLOW_PRIVATE_TARGETS=true to disable all checks (for local/trusted deployments
 * where internal endpoint monitoring is the intended use case).
 * @module utils/ssrf-guard
 */

import { lookup } from 'node:dns/promises';

/** CIDR blocks that are non-routable or typically internal. */
const PRIVATE_RANGES: Array<{ base: bigint; mask: bigint; label: string }> = (() => {
  function ipv4ToBigInt(ip: string): bigint {
    return ip.split('.').reduce((acc, octet) => (acc << 8n) | BigInt(parseInt(octet, 10)), 0n);
  }

  function cidr4(cidr: string, label: string) {
    const [ip, bits] = cidr.split('/') as [string, string];
    const base = ipv4ToBigInt(ip);
    const mask = ~((1n << BigInt(32 - parseInt(bits, 10))) - 1n) & 0xffff_ffffn;
    return { base: base & mask, mask, label };
  }

  return [
    cidr4('127.0.0.0/8', 'loopback'),
    cidr4('10.0.0.0/8', 'private (RFC 1918)'),
    cidr4('172.16.0.0/12', 'private (RFC 1918)'),
    cidr4('192.168.0.0/16', 'private (RFC 1918)'),
    cidr4('169.254.0.0/16', 'link-local / cloud-metadata'),
    cidr4('100.64.0.0/10', 'shared address space (RFC 6598)'),
    cidr4('192.0.0.0/24', 'IETF protocol assignments'),
    cidr4('192.0.2.0/24', 'TEST-NET-1 (RFC 5737)'),
    cidr4('198.51.100.0/24', 'TEST-NET-2 (RFC 5737)'),
    cidr4('203.0.113.0/24', 'TEST-NET-3 (RFC 5737)'),
    cidr4('240.0.0.0/4', 'reserved (RFC 1112)'),
  ];
})();

/** IPv6 prefixes that are non-public. */
const PRIVATE_IPV6_PREFIXES: Array<{ prefix: string; label: string }> = [
  { prefix: '::1', label: 'loopback' },
  { prefix: 'fc', label: 'unique local (RFC 4193)' },
  { prefix: 'fd', label: 'unique local (RFC 4193)' },
  { prefix: 'fe80', label: 'link-local' },
  { prefix: '::ffff:', label: 'IPv4-mapped' }, // checked separately via parsed v4
];

/** Returns true if the IPv4 address string falls in a private/reserved range. */
function isPrivateIPv4(ip: string): string | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  if (parts.some((p) => Number.isNaN(parseInt(p, 10)))) return null;
  const val = parts.reduce((acc, p) => (acc << 8n) | BigInt(parseInt(p, 10)), 0n);
  for (const { base, mask, label } of PRIVATE_RANGES) {
    if ((val & mask) === base) return label;
  }
  return null;
}

/** Returns true if the IPv6 address string falls in a private/reserved range. */
function isPrivateIPv6(ip: string): string | null {
  const normalized = ip.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  for (const { prefix, label } of PRIVATE_IPV6_PREFIXES) {
    if (normalized === prefix || normalized.startsWith(prefix)) return label;
  }
  // IPv4-mapped: ::ffff:10.0.0.1
  const v4MappedMatch = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(normalized);
  if (v4MappedMatch?.[1]) {
    const label = isPrivateIPv4(v4MappedMatch[1]);
    if (label) return `IPv4-mapped ${label}`;
  }
  return null;
}

/** Check a single IP string (v4 or v6). Returns the range label if blocked, null if public. */
function checkIp(ip: string): string | null {
  if (ip.includes(':')) return isPrivateIPv6(ip);
  return isPrivateIPv4(ip);
}

/** Resolve the hostname in a URL or bare domain and throw if any resolved IP is private. */
async function resolveAndCheck(hostname: string, context: string): Promise<void> {
  let addresses: import('node:dns').LookupAddress[];
  try {
    // all: true returns all addresses for the hostname
    addresses = await lookup(hostname, { all: true });
  } catch {
    // DNS failure is not a security issue — let the downstream fetch/connect fail naturally
    return;
  }

  for (const { address } of addresses) {
    const label = checkIp(address);
    if (label) {
      throw new Error(
        `SSRF_BLOCKED: ${context} resolves to ${address} (${label}). ` +
          `Requests to private, loopback, or cloud-metadata addresses are not permitted. ` +
          `Set STATUS_ALLOW_PRIVATE_TARGETS=true to allow internal-network monitoring.`,
      );
    }
  }
}

/** True when the operator has explicitly enabled private-target access. */
function privateTargetsAllowed(): boolean {
  return process.env.STATUS_ALLOW_PRIVATE_TARGETS?.toLowerCase() === 'true';
}

/**
 * Assert that a raw Statuspage URL is safe to fetch.
 * Throws with `SSRF_BLOCKED` prefix if the hostname resolves to a non-public address.
 * No-ops when STATUS_ALLOW_PRIVATE_TARGETS=true.
 */
export async function assertSafeUrl(rawUrl: string): Promise<void> {
  if (privateTargetsAllowed()) return;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    // Malformed URL — reject it; validation already happened upstream but be defensive
    throw new Error(`SSRF_BLOCKED: Invalid URL "${rawUrl}".`);
  }

  const scheme = parsed.protocol.toLowerCase();
  if (scheme !== 'http:' && scheme !== 'https:') {
    throw new Error(
      `SSRF_BLOCKED: Scheme "${scheme}" is not permitted. Only http:// and https:// are allowed.`,
    );
  }

  const hostname = parsed.hostname;
  await resolveAndCheck(hostname, `URL "${rawUrl}"`);
}

/**
 * Assert that a bare domain (no protocol) is safe to connect to.
 * Throws with `SSRF_BLOCKED` prefix if it resolves to a non-public address.
 * No-ops when STATUS_ALLOW_PRIVATE_TARGETS=true.
 */
export async function assertSafeDomain(domain: string): Promise<void> {
  if (privateTargetsAllowed()) return;
  await resolveAndCheck(domain, `Domain "${domain}"`);
}

/**
 * Assert that a resolver IP address is not in a private range (direct IP, no DNS involved).
 * Throws with `SSRF_BLOCKED` prefix if the IP is private.
 * No-ops when STATUS_ALLOW_PRIVATE_TARGETS=true.
 */
export function assertSafeResolverIp(ip: string): void {
  if (privateTargetsAllowed()) return;
  const label = checkIp(ip);
  if (label) {
    throw new Error(
      `SSRF_BLOCKED: Resolver IP "${ip}" is in a private range (${label}). ` +
        `Only public DNS resolvers are permitted. ` +
        `Set STATUS_ALLOW_PRIVATE_TARGETS=true to allow private resolvers.`,
    );
  }
}
