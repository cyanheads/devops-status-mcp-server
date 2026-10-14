/**
 * @fileoverview Tests for the markdown rendering of vendor-authored text in format().
 * @module tests/utils/vendor-markdown.test
 */

import { describe, expect, it } from 'vitest';
import { vendorInline, vendorQuote } from '@/utils/vendor-markdown.js';

describe('vendorInline', () => {
  it('escapes `<` and an `&` that begins a character reference', () => {
    expect(vendorInline('(<1%) <script> &amp; &#60; &#x3C; &nbsp;')).toBe(
      '(&lt;1%) &lt;script> &amp;amp; &amp;#60; &amp;#x3C; &amp;nbsp;',
    );
  });

  it('leaves a bare `&` and every other character as written', () => {
    expect(vendorInline('Debugger & Alarms, AT&T, a&b, & ;, **bold** > [x](y)')).toBe(
      'Debugger & Alarms, AT&T, a&b, & ;, **bold** > [x](y)',
    );
  });

  it('flattens CR, LF, and CRLF runs to one space', () => {
    expect(vendorInline('a\nb\r\nc\rd\n\n\ne')).toBe('a b c d e');
  });
});

describe('vendorQuote', () => {
  it('prefixes every line, blank ones as a bare `  >`', () => {
    expect(vendorQuote('one\n\n## two\r\n- three\rfour')).toEqual([
      '  > one',
      '  >',
      '  > ## two',
      '  > - three',
      '  > four',
    ]);
  });

  it('escapes each line', () => {
    expect(vendorQuote('<b>x</b> &lt;')).toEqual(['  > &lt;b>x&lt;/b> &amp;lt;']);
  });

  it('renders empty text as no lines', () => {
    expect(vendorQuote('')).toEqual([]);
  });

  /** Vendor text is upstream-sized; 16k → 1,024k characters is a 64× span. */
  it.each([
    ['& runs', '&'],
    ['& with a long name and no ;', '&abcdefghijklmnopqrstuvwxyzabcdefghij'],
    ['&# with digits and no ;', '&#1234567890'],
    ['< runs', '<'],
    ['newline runs', '\n'],
  ])('stays linear on %s', (_label, unit) => {
    const cpu = (text: string) => {
      vendorQuote(text);
      vendorInline(text);
      let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 3; i++) {
        const start = process.threadCpuUsage();
        vendorQuote(text);
        vendorInline(text);
        const used = process.threadCpuUsage(start);
        best = Math.min(best, used.user + used.system);
      }
      return best;
    };
    const build = (n: number) => unit.repeat(Math.ceil(n / unit.length));
    const small = cpu(build(16_000));
    const large = cpu(build(1_024_000));
    expect(large / Math.max(small, 200)).toBeLessThan(256);
    expect(large).toBeLessThan(1_000_000);
  });
});
