/**
 * @fileoverview Tests for the shared update-body converter. Bodies marked "recorded" are
 * verbatim from the named vendor's status API.
 * @module tests/utils/html-to-text.test
 */

import { describe, expect, it } from 'vitest';
import { decodeCharacterReferences, htmlToText, XML_REFERENCES } from '@/utils/html-to-text.js';

describe('htmlToText', () => {
  describe('a `<` that opens no HTML element stays text', () => {
    it.each([
      ['a percentage bound', 'a small number of customers (<1%) were affected'],
      ['a duration bound', 'queues back to normal in <30min.'],
      [
        'template placeholders',
        'an issue with <FUNCTIONALITY IMPACTED> impacting <SOME/ALL> users',
      ],
      ['a name placeholder', "the 'Your Project <Name> is running out' email"],
      ['an autolink', 'use test emails (<https://x.test/a>) instead'],
      ['comparisons', 'latency < 200ms and x<y and a <= b, if 3 < 5 and 7 > 2'],
      ['an unterminated element tag', 'before <b unclosed text after'],
      ['an unterminated comment', 'a <!-- never closed'],
      ['a CDATA opener', 'a <![CDATA[ raw ]]> b'],
    ])('%s passes through unchanged', (_label, body) => {
      expect(htmlToText(body)).toBe(body);
    });

    it('keeps text `<` beside real markup, removing only the element tags', () => {
      expect(htmlToText('customers (<1%). <br /><br />This was <FUNCTIONALITY IMPACTED>')).toBe(
        'customers (<1%).\nThis was <FUNCTIONALITY IMPACTED>',
      );
      expect(htmlToText('<p>See (<https://x.test/a>) and <SOME/ALL>.</p>')).toBe(
        'See (<https://x.test/a>) and <SOME/ALL>.',
      );
    });

    it('reads nested malformed tags once: what is left is text, never parsed again', () => {
      expect(htmlToText('a <scr<b>ipt>x')).toBe('a <script>x');
      expect(htmlToText('x <a<a<a>>> y')).toBe('x <a<a>> y');
    });
  });

  describe('element tags in any case, with attributes or whitespace before `>`', () => {
    it.each([
      ['an end tag with whitespace', 'one</p ><p>two', 'one\ntwo'],
      ['a <br> with an attribute', 'one<br class="x">two', 'one\ntwo'],
      ['a self-closing <br />', 'one<br />two', 'one\ntwo'],
      ['uppercase tags', '<P>one</P><DIV>two</DIV>', 'one\ntwo'],
      [
        'list items',
        '<ul><li>alpha</li><li class="k">beta</li></ul>after',
        '- alpha\n- beta\nafter',
      ],
      ['inline elements', '<strong>Bold</strong> and <span style="x">span</span>', 'Bold and span'],
      ['a heading end', '<h2>Impact</h2>text', 'Impact\ntext'],
      [
        'obsolete inline elements',
        '<tt>cmd</tt> <font color="red">red</font> <strike>old</strike> <big>B</big> <acronym title="x">TLS</acronym>',
        'cmd red old B TLS',
      ],
      ['an obsolete block element', '<center>one</center>two', 'one\ntwo'],
    ])('%s', (_label, body, expected) => {
      expect(htmlToText(body)).toBe(expected);
    });

    it('drops a comment whole, a `>` inside it included', () => {
      expect(htmlToText('a <!-- hidden > still --> b')).toBe('a b');
    });
  });

  describe('links', () => {
    it.each([
      ['double-quoted', '<a href="https://x.test">t</a>', 't (https://x.test)'],
      ['single-quoted', "<a href='https://x.test'>t</a>", 't (https://x.test)'],
      ['bare', '<a href=https://x.test/b>t</a>', 't (https://x.test/b)'],
      ['uppercase', '<A HREF="https://x.test">t</A>', 't (https://x.test)'],
      ['text equal to the URL', '<a href="https://x.test/">https://x.test</a>', 'https://x.test/'],
      ['empty text', 'see <a href="https://x.test"></a>', 'see https://x.test'],
      [
        'an entity in the href',
        '<a href="https://x.test/?a=1&amp;b=2">q</a>',
        'q (https://x.test/?a=1&b=2)',
      ],
      ['a data-href beside the href', '<a data-href="no" href="yes">y</a>', 'y (yes)'],
      ['no href', 'a <a name="x">label</a> b', 'a label b'],
      [
        'markup inside the label',
        '<a href="https://x.test"><span>in</span> span</a>',
        'in span (https://x.test)',
      ],
    ])('%s', (_label, body, expected) => {
      expect(htmlToText(body)).toBe(expected);
    });

    it('keeps the whitespace around a label outside the rendered link', () => {
      expect(htmlToText('x<a href="https://a.test"> one </a>y')).toBe('x one (https://a.test) y');
    });

    it('ends an open anchor at the next one, and at the end of the body', () => {
      expect(
        htmlToText('<a href="https://a.test">one <a href="https://b.test">two</a> three'),
      ).toBe('one (https://a.test) two (https://b.test) three');
      expect(htmlToText('via our <a href="https://s.test/new">support portal.')).toBe(
        'via our support portal. (https://s.test/new)',
      );
    });
  });

  describe('character references', () => {
    it('decodes named and numeric references once', () => {
      expect(htmlToText('<p>R&amp;D &#8211; West&#x20;US&nbsp;now</p>')).toBe('R&D – West US now');
      // `&amp;lt;` decodes to `&lt;`, never on to `<`.
      expect(htmlToText('Literal &amp;lt;b&amp;gt; stays')).toBe('Literal &lt;b&gt; stays');
    });

    it('leaves a decoded `<` as text — a decoded tag is never stripped', () => {
      expect(htmlToText('&lt;b&gt;bold&lt;/b&gt; text')).toBe('<b>bold</b> text');
    });

    it('converts a body whose only markup is a reference, and leaves an unknown name as text', () => {
      expect(htmlToText('A &amp; B\n\nC')).toBe('A & B\nC');
      expect(htmlToText('x &constructor; y &bogus; z')).toBe('x &constructor; y &bogus; z');
    });

    it('decodes against the set of names it is given', () => {
      expect(decodeCharacterReferences('&nbsp;&lt;', XML_REFERENCES)).toBe('&nbsp;<');
    });
  });

  describe('bodies with no markup', () => {
    it('returns a markdown body byte-identical — blank lines, indentation, list markers', () => {
      const body =
        '**Summary**\n\nWe saw errors.\n\n- item one\n- item two\n\n    code line\n  - nested\n\n[RCA](https://x.test)  ';
      expect(htmlToText(body)).toBe(body);
    });

    it('returns an empty body as empty', () => {
      expect(htmlToText('')).toBe('');
    });
  });

  describe('recorded bodies', () => {
    it('slack: paragraphs, non-breaking spaces, a link wrapping a span', () => {
      const body =
        '<p>Additional Slack engineers have been engaged.</p><p>Use the form here: <a href="https://slack.com/intl/en-gb/help/requests/new"><span style="text-decoration: underline;">https://slack.com/intl/en-gb/help/requests/new</span></a> . A member of the team will be in touch.&nbsp;</p><p><br><br></p>';
      expect(htmlToText(body)).toBe(
        'Additional Slack engineers have been engaged.\nUse the form here: https://slack.com/intl/en-gb/help/requests/new . A member of the team will be in touch.',
      );
    });

    it('linode: a labelled link reads as its text and URL', () => {
      const body =
        'If you continue to experience problems, please <a href="https://cloud.linode.com/support/tickets">open a Support ticket</a> for assistance.';
      expect(htmlToText(body)).toBe(
        'If you continue to experience problems, please open a Support ticket (https://cloud.linode.com/support/tickets) for assistance.',
      );
    });

    it('github: `<br />` pairs as line breaks beside a text "(<1%)"', () => {
      const body =
        'We confirmed this impact for a small number of customers (<1%). <br /><br />This was caused by a concentrated workload.  <br /><br />We are improving workload isolation.';
      expect(htmlToText(body)).toBe(
        [
          'We confirmed this impact for a small number of customers (<1%).',
          'This was caused by a concentrated workload.',
          'We are improving workload isolation.',
        ].join('\n'),
      );
    });

    it('datadog: a `<tt>` command reads as its text', () => {
      const body =
        'On Linux:\n\n<tt>sudo rm /opt/datadog-agent/agent/datadog-cert.pem && sudo service datadog-agent restart</tt>\n\nOn Windows:';
      expect(htmlToText(body)).toBe(
        'On Linux:\nsudo rm /opt/datadog-agent/agent/datadog-cert.pem && sudo service datadog-agent restart\nOn Windows:',
      );
    });

    it('snyk: a `<b>` run across raw newlines keeps the lines and drops the blank one', () => {
      const body =
        'between the following times:\n<b>Saturday 14th from 3:00PM UTC\n07:00 PST</b>\n\nDuring this time';
      expect(htmlToText(body)).toBe(
        'between the following times:\nSaturday 14th from 3:00PM UTC\n07:00 PST\nDuring this time',
      );
    });
  });

  /**
   * Bodies are upstream-sized, so every adversarial shape must cost linear time. Each
   * shape is timed at 16k and 1,024k characters (64×) in this thread's CPU time: linear
   * work grows about 64×, quadratic work about 4,096×.
   */
  describe('linear time', () => {
    const SMALL = 16_000;
    const LARGE = 1_024_000;
    const repeat = (unit: string, n: number) => unit.repeat(Math.ceil(n / unit.length));
    const shapes: [string, (n: number) => string][] = [
      ['unclosed tags', (n) => repeat('<b x ', n)],
      ['unclosed anchors', (n) => repeat('<a href="x" ', n)],
      ['nested anchor openers', (n) => `${repeat('<a', n)}>>>`],
      ['anchors never closed', (n) => repeat('<a href="x">t', n)],
      ['one anchor over the whole body', (n) => `<a href="x">${repeat('label ', n)}`],
      ['comment openers', (n) => repeat('<!--', n)],
      ['lone <', (n) => repeat('<', n)],
      ['lone &', (n) => repeat('&', n)],
      ['& with a name and no ;', (n) => `<p>${repeat('&abc', n)}`],
      ['spaced end tags', (n) => repeat('</p >', n)],
      ['href-only attributes', (n) => `<a ${repeat('href ', n)}>x</a>`],
      ['whitespace inside markup', (n) => `<p>${repeat(' \t', n)}x</p>`],
    ];

    function cpuMicros(input: string): number {
      htmlToText(input);
      let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 3; i++) {
        const start = process.threadCpuUsage();
        htmlToText(input);
        const used = process.threadCpuUsage(start);
        best = Math.min(best, used.user + used.system);
      }
      return best;
    }

    it.each(shapes)('%s', (_label, build) => {
      const small = cpuMicros(build(SMALL));
      const large = cpuMicros(build(LARGE));
      // A floor on the small run keeps timer granularity from inflating the ratio.
      expect(large / Math.max(small, 200)).toBeLessThan(256);
      expect(large).toBeLessThan(1_000_000);
    });
  });
});
