/**
 * @fileoverview Normalizer for `domains` entries on devops_check_dns and devops_check_certs. Reads
 * each submitted string as exactly one host (plus the port written on it), or marks it invalid
 * with a reason that names the string and the accepted shapes.
 * @module utils/domain-input
 */

import { isIP } from 'node:net';

/** Which check the entry feeds: DNS resolves names only; TLS connects to a host and port. */
export type DomainTarget = 'dns' | 'tls';

/** An entry read as one host. `port` is the port written on the entry (always null on dns). */
export interface DomainHost {
  host: string;
  input: string;
  kind: 'host';
  port: number | null;
}

/** An entry with no single host reading. It is reported in its own row and never checked. */
export interface InvalidDomain {
  error: string;
  input: string;
  kind: 'invalid';
}

export type DomainEntry = DomainHost | InvalidDomain;

const ACCEPTED_SHAPES: Record<DomainTarget, string> = {
  dns: 'Pass a domain name ("example.com"); a URL or a host:port is reduced to its host.',
  tls: 'Pass a hostname ("example.com"), a host with a port ("example.com:8443"), a URL ("https://example.com/path"), or an IP address.',
};

/**
 * Upper bound on the host part handed to the URL parser, checked before it runs. It is well
 * past any valid host in any spelling (percent-encoded, Unicode, bracketed IPv6 with a port).
 */
const MAX_AUTHORITY_LENGTH = 1024;

const MAX_NAME_LENGTH = 253;
const LABEL_CHARS = /^[a-z0-9_-]{1,63}$/;
const SCHEME = /^[a-z][a-z0-9+.-]*$/i;

/** True when the text holds whitespace or an ASCII control character anywhere. */
function hasWhitespaceOrControl(text: string): boolean {
  if (/\s/.test(text)) return true;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * The authority of `rest` (an entry with its scheme removed): everything before the path,
 * query, or fragment, ended where the URL parser ends it for http and https.
 */
function authorityOf(rest: string): string {
  for (let i = 0; i < rest.length; i++) {
    const c = rest.charAt(i);
    if (c === '/' || c === '\\' || c === '?' || c === '#') return rest.slice(0, i);
  }
  return rest;
}

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** The reason a parsed hostname is not a usable DNS name, or null when it is one. */
function nameProblem(hostname: string): string | null {
  const name = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
  if (name.length > MAX_NAME_LENGTH) return `is longer than ${MAX_NAME_LENGTH} characters`;
  const labelsOk = name
    .split('.')
    .every((label) => LABEL_CHARS.test(label) && !label.startsWith('-') && !label.endsWith('-'));
  return labelsOk
    ? null
    : 'is not a valid host name: each dot-separated label must be 1–63 letters, digits, hyphens, or underscores, and cannot start or end with a hyphen';
}

/**
 * Read one submitted `domains` entry as a single host.
 *
 * Surrounding whitespace and letter case are ignored; any `scheme://` prefix, path, query, and
 * fragment are dropped; a Unicode name becomes its IDNA ASCII form; a trailing dot and `_`
 * labels are kept. A written port (`host:port`, `[v6]:port`, a URL port — including the
 * scheme's default) is returned for TLS and ignored for DNS. An IP literal is a host for TLS
 * and invalid for DNS, which has no name to resolve. Userinfo, whitespace inside the entry, a
 * port outside 1–65535, and a malformed label make the entry invalid.
 */
export function normalizeDomainInput(raw: string, target: DomainTarget): DomainEntry {
  const invalid = (reason: string): InvalidDomain => ({
    kind: 'invalid',
    input: raw,
    error: `${JSON.stringify(raw)} ${reason}. ${ACCEPTED_SHAPES[target]}`,
  });
  const ipOnDns = () =>
    invalid('is an IP address — DNS records are looked up by domain name, not by address');

  const text = raw.trim();
  if (text === '') return invalid('is blank');
  if (hasWhitespaceOrControl(text)) return invalid('contains whitespace or a control character');

  const schemeEnd = text.indexOf('://');
  const rest =
    schemeEnd > 0 && SCHEME.test(text.slice(0, schemeEnd)) ? text.slice(schemeEnd + 3) : text;
  const authority = authorityOf(rest);
  if (authority === '') return invalid('names no host');
  if (authority.length > MAX_AUTHORITY_LENGTH) {
    return invalid('has a host part longer than any valid host name');
  }
  if (authority.includes('@')) {
    return invalid(
      'has a user name before "@", so it reads as an email address or a credential rather than a host',
    );
  }

  // A bare IPv6 literal cannot carry a port, and the URL parser only takes it bracketed.
  if (isIP(authority) === 6) {
    if (target === 'dns') return ipOnDns();
    const canonical = parse(`https://[${authority}]/`);
    if (!canonical) return invalid('could not be read as a host name or IP address');
    return { kind: 'host', input: raw, host: canonical.hostname.slice(1, -1), port: null };
  }

  /**
   * Each special scheme drops its own default port from `URL.port`, so a written `:443` survives
   * only the http parse and a written `:80` only the https one — together they recover it.
   */
  const https = parse(`https://${authority}/`);
  const http = parse(`http://${authority}/`);
  if (!https || !http) {
    const portText = authority.slice(authority.lastIndexOf(':') + 1);
    if (authority.includes(':') && /^\d+$/.test(portText) && Number(portText) > 65535) {
      return invalid(`has port ${portText}, outside the valid range 1–65535`);
    }
    return invalid('could not be read as a host name, IP address, or URL');
  }
  const writtenPort = http.port || https.port;
  const port = writtenPort === '' ? null : Number(writtenPort);
  if (port === 0) return invalid('has port 0, outside the valid range 1–65535');

  const hostname = https.hostname;
  const bare = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  if (isIP(bare) !== 0) {
    if (target === 'dns') return ipOnDns();
    return { kind: 'host', input: raw, host: bare, port };
  }

  const problem = nameProblem(hostname);
  if (problem) return invalid(problem);
  return { kind: 'host', input: raw, host: hostname, port: target === 'dns' ? null : port };
}
