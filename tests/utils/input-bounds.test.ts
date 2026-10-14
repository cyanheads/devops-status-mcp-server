/**
 * @fileoverview Tests for the shared over-cap handling of tool inputs.
 * @module tests/utils/input-bounds.test
 */

import { describe, expect, it } from 'vitest';
import {
  clampMax,
  clampNotice,
  deferralNotice,
  splitBatch,
  uniqueInOrder,
} from '@/utils/input-bounds.js';

describe('splitBatch', () => {
  it('serves everything and defers nothing at or under the cap', () => {
    expect(splitBatch(['a', 'b'], 2)).toEqual({ served: ['a', 'b'], deferred: [] });
    expect(splitBatch([], 2)).toEqual({ served: [], deferred: [] });
  });

  it('serves the first cap entries and defers the rest verbatim, in input order', () => {
    expect(splitBatch(['c', 'a', 'b', 'a '], 2)).toEqual({
      served: ['c', 'a'],
      deferred: ['b', 'a '],
    });
  });
});

describe('uniqueInOrder', () => {
  it('keeps the first occurrence of each entry in input order', () => {
    expect(uniqueInOrder(['A', 'MX', 'A', 'TXT', 'MX'])).toEqual(['A', 'MX', 'TXT']);
  });

  it('compares by the key when one is given', () => {
    expect(
      uniqueInOrder(['1.1.1.1', '8.8.8.8', '1.1.1.1:53'], (r) => r.replace(/:53$/, '')),
    ).toEqual(['1.1.1.1', '8.8.8.8']);
  });
});

describe('deferralNotice', () => {
  it('names the cap, the total, the deferred count, and the field to resend from', () => {
    expect(
      deferralNotice({
        cap: 20,
        deferredCount: 1,
        field: 'deferred_vendors',
        noun: 'vendors',
        verb: 'checked',
      }),
    ).toBe(
      'Only the first 20 of 21 vendors were checked (20 per call); resend the 1 in deferred_vendors in another call.',
    );
  });
});

describe('clampNotice', () => {
  it('gives the requested and effective values and the bound', () => {
    expect(clampNotice('since', '2024-01-01', '2024-10-14', '24-month history floor')).toBe(
      'since 2024-01-01 is past the 24-month history floor; 2024-10-14 was used.',
    );
  });
});

describe('clampMax', () => {
  it('passes a value at or under the max through with no notice', () => {
    expect(clampMax('limit', 50, 50)).toEqual({ value: 50 });
    expect(clampMax('limit', 1, 50)).toEqual({ value: 1 });
  });

  it('clamps a value over the max and says so', () => {
    expect(clampMax('limit', 51, 50)).toEqual({
      value: 50,
      notice: 'limit 51 is past the maximum of 50; 50 was used.',
    });
  });
});
