/**
 * @fileoverview Tests for the word matching behind caller-side list filters.
 * @module tests/utils/word-match.test
 */

import { describe, expect, it } from 'vitest';
import { hasEveryWord, toWords } from '@/utils/word-match.js';

describe('toWords', () => {
  it('lowercases and splits on every run of non-letters and non-digits', () => {
    expect(toWords('CARRIER NETWORK - SMS Long Code, North America')).toEqual([
      'carrier',
      'network',
      'sms',
      'long',
      'code',
      'north',
      'america',
    ]);
  });

  it('reads hyphenated, slashed, and spaced spellings as the same words', () => {
    for (const text of [
      'git-operations',
      'Git Operations',
      'GIT/operations',
      ' git__operations. ',
    ]) {
      expect(toWords(text)).toEqual(['git', 'operations']);
    }
  });

  it('splits a Group / Leaf string into its words', () => {
    expect(toWords('Actions / Hosted Runners (EU)')).toEqual([
      'actions',
      'hosted',
      'runners',
      'eu',
    ]);
  });

  it('keeps letters and digits outside ASCII', () => {
    expect(toWords('Région Île-de-France: 5xx')).toEqual(['région', 'île', 'de', 'france', '5xx']);
  });

  it('returns no words for text with no letter or digit', () => {
    expect(toWords('')).toEqual([]);
    expect(toWords('  - / , ')).toEqual([]);
  });
});

describe('hasEveryWord', () => {
  const component = 'CARRIER NETWORK - SMS Long Code, North America';

  it('matches when every word appears, in any order and spelling', () => {
    expect(hasEveryWord(toWords('sms long code'), ['Delays', component])).toBe(true);
    expect(hasEveryWord(toWords('Long-Code SMS'), ['Delays', component])).toBe(true);
    expect(hasEveryWord(toWords('git-operations'), ['Degraded Git Operations over SSH'])).toBe(
      true,
    );
  });

  it('matches a Group / Leaf query only when each of its words appears', () => {
    expect(hasEveryWord(toWords('Carrier Network / SMS Long Code'), [component])).toBe(true);
    expect(hasEveryWord(toWords('Carrier Network / Voice'), [component])).toBe(false);
  });

  it('takes each word from whichever text carries it', () => {
    expect(hasEveryWord(toWords('actions pull'), ['Incident with Actions', 'Pull Requests'])).toBe(
      true,
    );
  });

  it('matches a word inside a longer word, never across two', () => {
    expect(hasEveryWord(toWords('action'), ['Incident with Actions'])).toBe(true);
    expect(hasEveryWord(toWords('gitoperations'), ['Git Operations'])).toBe(false);
    expect(hasEveryWord(toWords('t o'), ['Git Operations'])).toBe(true);
    expect(hasEveryWord(toWords('to'), ['Git Operations'])).toBe(false);
  });

  it('fails when any one word is missing', () => {
    expect(hasEveryWord(toWords('sms voice'), [component])).toBe(false);
    expect(hasEveryWord(toWords('actions'), [])).toBe(false);
  });

  /** Names and component names are upstream-sized; 5k → 320k characters is a 64× span. */
  it.each([
    ['one long word', 'a', `${'a'.repeat(199)}b`],
    ['separator runs', '-', 'x'],
    ['alternating letters and separators', 'a-', `${'a'.repeat(100)}b`],
  ])('stays linear on %s', (_label, unit, query) => {
    const words = toWords(query);
    const cpu = (text: string) => {
      hasEveryWord(words, [text]);
      let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 3; i++) {
        const start = process.threadCpuUsage();
        hasEveryWord(words, [text]);
        const used = process.threadCpuUsage(start);
        best = Math.min(best, used.user + used.system);
      }
      return best;
    };
    const build = (n: number) => unit.repeat(Math.ceil(n / unit.length));
    const small = cpu(build(5_000));
    const large = cpu(build(320_000));
    expect(large / Math.max(small, 200)).toBeLessThan(256);
    expect(large).toBeLessThan(1_000_000);
  });
});
