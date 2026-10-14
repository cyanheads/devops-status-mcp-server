/**
 * @fileoverview Tests for the shared `domains` entry normalizer behind devops_check_dns and
 * devops_check_certs: one host reading per accepted form, an invalid entry for everything else,
 * and a bounded cost for caller-sized text.
 * @module tests/utils/domain-input.test
 */

import { describe, expect, it } from 'vitest';
import { type DomainEntry, normalizeDomainInput } from '@/utils/domain-input.js';

/** The host and port an entry reads as, or the invalid marker. */
function reading(entry: DomainEntry): { host: string; port: number | null } | 'invalid' {
  return entry.kind === 'host' ? { host: entry.host, port: entry.port } : 'invalid';
}

describe('normalizeDomainInput', () => {
  describe('forms with one host reading', () => {
    it.each([
      ['github.com', 'github.com', null],
      ['  github.com  ', 'github.com', null],
      ['\tgithub.com\n', 'github.com', null],
      ['GitHub.COM', 'github.com', null],
      ['github.com.', 'github.com.', null],
      ['_dmarc.github.com', '_dmarc.github.com', null],
      ['github.com/login', 'github.com', null],
      ['https://github.com/login', 'github.com', null],
      ['https://github.com/?q=1#top', 'github.com', null],
      ['github.com:443', 'github.com', 443],
      ['github.com:8443', 'github.com', 8443],
      ['HTTP://GitHub.com:443/', 'github.com', 443],
      ['https://github.com:80/', 'github.com', 80],
      ['http://github.com:80/', 'github.com', 80],
      ['https://github.com:443', 'github.com', 443],
      ['ldaps://ldap.github.com:636', 'ldap.github.com', 636],
      ['github.com.:443', 'github.com.', 443],
      ['münchen.de', 'xn--mnchen-3ya.de', null],
      ['MÜNCHEN.de', 'xn--mnchen-3ya.de', null],
      ['xn--mnchen-3ya.de', 'xn--mnchen-3ya.de', null],
    ])('reads %j as host %j, port %j on certs', (raw, host, port) => {
      expect(normalizeDomainInput(raw, 'tls')).toEqual({ kind: 'host', input: raw, host, port });
    });

    it('drops the port on dns, since a DNS query has no port', () => {
      expect(normalizeDomainInput('HTTP://GitHub.com:8443/login', 'dns')).toEqual({
        kind: 'host',
        input: 'HTTP://GitHub.com:8443/login',
        host: 'github.com',
        port: null,
      });
    });

    it.each([
      ['1.1.1.1', '1.1.1.1', null],
      ['1.1.1.1:853', '1.1.1.1', 853],
      ['https://10.0.0.1/', '10.0.0.1', null],
      ['https://169.254.169.254/latest/meta-data', '169.254.169.254', null],
      ['http://0x7f.1:8080/', '127.0.0.1', 8080],
      ['2606:4700:4700::1111', '2606:4700:4700::1111', null],
      ['2606:4700:4700:0:0:0:0:ABCD', '2606:4700:4700::abcd', null],
      ['[2606:4700:4700::1111]', '2606:4700:4700::1111', null],
      ['[2606:4700:4700::1111]:443', '2606:4700:4700::1111', 443],
      ['[::1]:443', '::1', 443],
    ])('reads IP literal %j as %j, port %j on certs', (raw, host, port) => {
      expect(reading(normalizeDomainInput(raw, 'tls'))).toEqual({ host, port });
    });

    it.each(['1.1.1.1', '2606:4700:4700::1111', '[::1]:443', 'https://10.0.0.1/'])(
      'rejects IP literal %j on dns, naming why',
      (raw) => {
        const entry = normalizeDomainInput(raw, 'dns');
        expect(entry).toMatchObject({ kind: 'invalid', input: raw });
        expect(entry.kind === 'invalid' && entry.error).toContain('is an IP address');
      },
    );
  });

  describe('entries with no single host reading', () => {
    it.each([
      ['user@github.com', 'user name'],
      ['https://user:pw@github.com/', 'user name'],
      ['@github.com', 'user name'],
      [' ', 'blank'],
      ['exa mple.com', 'whitespace'],
      ['git\nhub.com', 'whitespace'],
      ['*.github.com', 'label'],
      ['github..com', 'label'],
      ['-bad.com', 'label'],
      ['bad-.com', 'label'],
      ['ex!ample.com', 'label'],
      [`${'a'.repeat(64)}.com`, 'label'],
      [`${'a.'.repeat(127)}com`, 'longer than'],
      ['.', 'label'],
      ['github.com:0', 'port'],
      ['github.com:99999', 'port'],
      ['github.com:443:1', 'could not be read'],
      ['/login', 'names no host'],
      ['https://', 'names no host'],
      ['[::1', 'could not be read'],
    ])('makes %j an invalid entry (%s)', (raw, reason) => {
      for (const target of ['dns', 'tls'] as const) {
        const entry = normalizeDomainInput(raw, target);
        expect(entry.kind).toBe('invalid');
        if (entry.kind !== 'invalid') continue;
        expect(entry.input).toBe(raw);
        expect(entry.error).toContain(JSON.stringify(raw));
        expect(entry.error).toContain(reason);
      }
    });

    it('names the accepted shapes for each tool', () => {
      const tls = normalizeDomainInput('user@github.com', 'tls');
      const dns = normalizeDomainInput('user@github.com', 'dns');
      expect(tls.kind === 'invalid' && tls.error).toContain(
        'Pass a hostname ("example.com"), a host with a port ("example.com:8443"), a URL ("https://example.com/path"), or an IP address.',
      );
      expect(dns.kind === 'invalid' && dns.error).toContain(
        'Pass a domain name ("example.com"); a URL or a host:port is reduced to its host.',
      );
    });
  });

  /** Entries are caller-sized text: reading one costs time linear in its length. */
  it('costs time linear in the entry length on every input shape', () => {
    const shapes: Array<(n: number) => string> = [
      (n) => 'ü.'.repeat(n / 2),
      (n) => `https://${'ü'.repeat(n)}/`,
      (n) => 'a'.repeat(n),
      (n) => `github.com/${'ü.'.repeat(n / 2)}`,
      (n) => ':'.repeat(n),
      (n) => '['.repeat(n),
      (n) => 'a@'.repeat(n / 2),
      (n) => '%'.repeat(n),
      (n) => 'a://'.repeat(n / 4),
      (n) => `${' '.repeat(n)}a`,
    ];
    function cpuMicros(input: string): number {
      const start = process.threadCpuUsage();
      for (let i = 0; i < 3; i++) {
        normalizeDomainInput(input, 'tls');
        normalizeDomainInput(input, 'dns');
      }
      const used = process.threadCpuUsage(start);
      return used.user + used.system;
    }
    for (const shape of shapes) {
      const small = shape(5_000);
      const large = shape(320_000);
      cpuMicros(small); // warm up
      const smallCost = Math.max(cpuMicros(small), 50);
      const largeCost = cpuMicros(large);
      expect(largeCost / smallCost).toBeLessThan(256);
      expect(largeCost).toBeLessThan(250_000);
    }
  });
});
