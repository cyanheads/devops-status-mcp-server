/**
 * @fileoverview Tests for the word matching behind caller-side list filters.
 * @module tests/utils/word-match.test
 */

import { describe, expect, it } from 'vitest';
import { hasEveryTerm, toTerms, toWords } from '@/utils/word-match.js';

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

describe('toTerms', () => {
  it('splits on whitespace and reads each term as its lowercase words joined by hyphens', () => {
    expect(toTerms('eu-central-1  GIT/operations\tPull')).toEqual([
      'eu-central-1',
      'git-operations',
      'pull',
    ]);
    expect(toTerms(' Long_Code, SMS ')).toEqual(['long-code', 'sms']);
    expect(toTerms('EU/Central-1 Pull')).toEqual(['eu-central-1', 'pull']);
  });

  it('drops a term with no letter or digit', () => {
    expect(toTerms('actions / pull')).toEqual(['actions', 'pull']);
    expect(toTerms('--/--')).toEqual([]);
    expect(toTerms('  - / , ')).toEqual([]);
    expect(toTerms('')).toEqual([]);
  });

  it('keeps letters and digits outside ASCII, and splits on any whitespace', () => {
    expect(toTerms('Île-de-France 5xx')).toEqual(['île-de-france', '5xx']);
    expect(toTerms('eu central　one')).toEqual(['eu', 'central', 'one']);
  });

  it('keeps repeated words and repeated terms', () => {
    expect(toTerms('us-us us us')).toEqual(['us-us', 'us', 'us']);
  });
});

/**
 * The `match` rule (#95), tabled once. The excerpts of the `me-central-1` and `me-south-1`
 * events are verbatim fields of the recorded AWS capture (title, a few of the 140–149
 * service names, location name and ID).
 */
describe('hasEveryTerm', () => {
  const component = 'CARRIER NETWORK - SMS Long Code, North America';
  const carrier = [component];
  const sms = ['Delays', component];
  const ssh = ['Degraded Git Operations over SSH'];
  const git = ['Git Operations'];
  const actions = ['Incident with Actions', 'Pull Requests'];
  const idf = ['Région Île-de-France: 5xx'];
  const meCentral = [
    'Increased Error Rates — Multiple services (UAE)',
    'Amazon Managed Service for Prometheus',
    'Amazon Simple Queue Service',
    'AWS Global Accelerator',
    'Amazon Managed Workflows for Apache Airflow',
    'UAE',
    'me-central-1',
  ];
  const meSouth = [
    'Increased Error Rates — Multiple services (Bahrain)',
    'Amazon API Gateway',
    'Amazon Managed Streaming for Apache Kafka',
    'AWS Global Accelerator',
    'Bahrain',
    'me-south-1',
  ];

  type Case = readonly [label: string, match: string, texts: readonly string[], hit: boolean];
  const CASES: readonly Case[] = [
    ['words in any order', 'sms long code', sms, true],
    ['a phrase and a word', 'Long-Code SMS', sms, true],
    ['a phrase inside a title', 'git-operations', ssh, true],
    ['Group / Leaf, all present', 'Carrier Network / SMS Long Code', carrier, true],
    ['Group / Leaf, a word missing', 'Carrier Network / Voice', carrier, false],
    ['words from two texts', 'actions pull', actions, true],
    ['a word inside a longer word', 'action', ['Incident with Actions'], true],
    ['never across two words', 'gitoperations', git, false],
    ['two one-letter terms', 't o', git, true],
    ['two letters across a word break', 'to', git, false],
    ['a word missing', 'sms voice', carrier, false],
    ['no texts', 'actions', [], false],
    ['a phrase as the whole text', 'git-operations', git, true],
    ['a slashed, uppercase phrase', 'GIT/operations', git, true],
    ['a phrase split across two texts', 'git-operations', ['Git', 'Operations'], false],
    ['a phrase out of order', 'operations-git', git, false],
    ['a phrase whose words are not adjacent', 'git-ssh', ssh, false],
    ['a phrase out of order beside a word', 'Code-Long SMS', sms, false],
    ['first word ending a word, last beginning one', 'it-oper', git, true],
    ['first word not at the end of its word', 'gi-operations', git, false],
    ['last word not at the start of its word', 'git-perations', git, false],
    ['a region code against its own event', 'me-central-1', meCentral, true],
    ['a region code against another region’s event', 'eu-central-1', meCentral, false],
    ['a code prefix against another region’s event', 'eu-central', meCentral, false],
    ['a code suffix', 'central-1', meCentral, true],
    ['a region name', 'uae', meCentral, true],
    ['a region code', 'me-south-1', meSouth, true],
    ['a code suffix', 'south-1', meSouth, true],
    ['a code sharing a service word', 'ap-south-1', meSouth, false],
    ['“global” in a service name', 'global', meSouth, true],
    ['part of a longer ID', 'eu-west', ['eu-west-3'], true],
    ['a GovCloud region name against a commercial code', 'US-East', ['us-east-1'], true],
    ['empty text', '', git, true],
    ['empty text, no texts', '', [], true],
    ['a term of only punctuation', '- / ,', git, true],
    ['a punctuation term between two words', 'actions / pull', actions, true],
    ['a phrase of letters outside ASCII', 'Île-de-France', idf, true],
    ['a phrase skipping a word outside ASCII', 'île-france', idf, false],
    ['a phrase across a colon', 'france-5xx', idf, true],
    ['a repeated word as one phrase', 'us-us', ['US East'], false],
    ['a repeated word as two terms', 'us us', ['US East'], true],
    ['a repeated digit as one phrase', '1-1', ['me-central-1', 'Release 1.1'], true],
    ['a repeated digit as one phrase, absent', '1-1', ['me-central-1'], false],
  ];

  it.each(CASES)('%s: %j', (_label, match, texts, hit) => {
    expect(hasEveryTerm(toTerms(match), texts)).toBe(hit);
  });
});

/**
 * Field texts are upstream-sized, so each scan is timed over texts doubling from 5k to
 * 320k characters (64×), bounded at every size before the next runs. The query stays
 * fixed: it is caller text, which devops_get_incidents caps at 200 characters. toTerms
 * reads the caller's text, so it is timed over the same inputs.
 */
describe('linear time', () => {
  const SIZES = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000];
  const BOUND_US = 1_000_000;

  /** Best of three thread-CPU readings, in microseconds, after one warm-up run. */
  const cpu = (run: () => unknown) => {
    run();
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 3; i++) {
      const start = process.threadCpuUsage();
      run();
      const used = process.threadCpuUsage(start);
      best = Math.min(best, used.user + used.system);
    }
    return best;
  };

  it.each([
    ['one long word', 'a', '', `${'a'.repeat(199)}b`],
    ['separator runs', '-', '', 'x'],
    ['alternating letters and separators', 'a-', '', `${'a'.repeat(100)}b`],
    ['a phrase whose words repeat with no closer', 'a-', '', `${'a-'.repeat(99)}b`],
    ['one long line ending in a break', '§1 x', '\ny', `${'1-x-'.repeat(49)}z`],
    ['breaks throughout', '  \r\n', '', 'x-y'],
  ])('stays linear on %s', (_label, unit, tail, query) => {
    const terms = toTerms(query);
    const scans = {
      hasEveryTerm: (text: string) => hasEveryTerm(terms, [text]),
      toTerms: (text: string) => toTerms(text),
    };
    const build = (n: number) => unit.repeat(Math.ceil(n / unit.length)) + tail;
    const first = new Map<string, number>();
    const last = new Map<string, number>();
    for (const size of SIZES) {
      const text = build(size);
      for (const [name, scan] of Object.entries(scans)) {
        const used = cpu(() => scan(text));
        expect(used, `${name} at ${size}`).toBeLessThan(BOUND_US);
        if (!first.has(name)) first.set(name, used);
        last.set(name, used);
      }
    }
    for (const name of Object.keys(scans)) {
      expect(last.get(name)! / Math.max(first.get(name)!, 200), name).toBeLessThan(256);
    }
  });
});
