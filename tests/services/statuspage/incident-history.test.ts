/**
 * @fileoverview Tests for reading Statuspage history-archive timestamps. Every
 * timestamp below is recorded verbatim from a live page; the expected instants
 * come from the same incident's v2 record where one exists, so a conversion is
 * checked against the vendor's own UTC value rather than against a hand calculation.
 * @module tests/services/statuspage/incident-history.test
 */

import { describe, expect, it } from 'vitest';
import { parseHistorySpan } from '@/services/statuspage/incident-history.js';

const var_ = (kind: 'date' | 'time', value: string) => `<var data-var='${kind}'>${value}</var>`;

describe('parseHistorySpan', () => {
  it('reads a same-day UTC range, taking the end date from the start', () => {
    // GitHub 1dk955gg3bvz — v2 created_at 16:51:32Z, resolved_at 20:41:12Z.
    const span = parseHistorySpan(
      `Sep ${var_('date', '24')}, ${var_('time', '16:51')} - ${var_('time', '20:41')} UTC`,
      { name: 'September', year: 2026 },
      'Etc/UTC',
    );
    expect(span).toEqual({ start: '2026-09-24T16:51:00.000Z', end: '2026-09-24T20:41:00.000Z' });
  });

  /**
   * Discord (America/Los_Angeles) switched from PST to PDT on 2026-03-08. Each
   * record's expected instant is its v2 created_at / resolved_at at minute precision.
   */
  describe('a Pacific-time page across the March DST change', () => {
    it('converts a PST record before the change', () => {
      // jvqsklfdcvt8 — v2 2026-03-05T19:26:36-08:00 → 2026-03-05T19:49:19-08:00
      const span = parseHistorySpan(
        `Mar ${var_('date', '5')}, ${var_('time', '19:26')} - ${var_('time', '19:49')} PST`,
        { name: 'March', year: 2026 },
        'America/Los_Angeles',
      );
      expect(span).toEqual({ start: '2026-03-06T03:26:00.000Z', end: '2026-03-06T03:49:00.000Z' });
    });

    it('converts a PDT record the day after the change', () => {
      // clqzb7y8t0r8 — v2 2026-03-09T10:08:03-07:00 → 2026-03-09T10:58:48-07:00
      const span = parseHistorySpan(
        `Mar ${var_('date', '9')}, ${var_('time', '10:08')} - ${var_('time', '10:58')} PDT`,
        { name: 'March', year: 2026 },
        'America/Los_Angeles',
      );
      expect(span).toEqual({ start: '2026-03-09T17:08:00.000Z', end: '2026-03-09T17:58:00.000Z' });
    });

    it('gives each end of a span that straddles the change its own offset', () => {
      // k22tny62jcw3 — labelled PDT, but v2 has created_at 2026-03-02T12:02:15-08:00
      // and resolved_at 2026-03-11T10:25:06-07:00: the label names only the end's zone.
      const span = parseHistorySpan(
        `Mar ${var_('date', '2')}, ${var_('time', '12:02')} - Mar ${var_('date', '11')}, ${var_('time', '10:25')} PDT`,
        { name: 'March', year: 2026 },
        'America/Los_Angeles',
      );
      expect(span).toEqual({ start: '2026-03-02T20:02:00.000Z', end: '2026-03-11T17:25:00.000Z' });
    });
  });

  describe('the year a span belongs to', () => {
    it('files a December start under a January bucket in the prior year', () => {
      // Twilio bchpvm9st7h2, filed under January 2026.
      const span = parseHistorySpan(
        `Dec ${var_('date', '31')}, ${var_('time', '22:28')} - Jan ${var_('date', '1')}, ${var_('time', '08:17')} PST`,
        { name: 'January', year: 2026 },
        'America/Los_Angeles',
      );
      expect(span).toEqual({ start: '2026-01-01T06:28:00.000Z', end: '2026-01-01T16:17:00.000Z' });
    });

    it('keeps a multi-day span that crosses the year in two different years', () => {
      // Twilio lc1txpxrvm2r, filed under January 2026.
      const span = parseHistorySpan(
        `Dec ${var_('date', '29')}, ${var_('time', '00:32')} - Jan ${var_('date', '6')}, ${var_('time', '13:43')} PST`,
        { name: 'January', year: 2026 },
        'America/Los_Angeles',
      );
      expect(span).toEqual({ start: '2025-12-29T08:32:00.000Z', end: '2026-01-06T21:43:00.000Z' });
    });

    it('leaves a December span filed under December in the bucket year', () => {
      // Twilio xcdk5zq41ztc, filed under December 2025.
      const span = parseHistorySpan(
        `Dec ${var_('date', '30')}, ${var_('time', '17:55')} - ${var_('time', '19:46')} PST`,
        { name: 'December', year: 2025 },
        'America/Los_Angeles',
      );
      expect(span).toEqual({ start: '2025-12-31T01:55:00.000Z', end: '2025-12-31T03:46:00.000Z' });
    });
  });

  it('reads a point record (no end) as an open span', () => {
    // Twilio 408d7njdzzlw — an in-progress maintenance.
    const span = parseHistorySpan(
      `Sep ${var_('date', '24')}, ${var_('time', '20:00')} PDT`,
      { name: 'September', year: 2026 },
      'America/Los_Angeles',
    );
    expect(span).toEqual({ start: '2026-09-25T03:00:00.000Z', end: null });
  });

  it.each([
    ['an ISO timestamp', '2026-03-05T19:26:00Z'],
    ['bare text with no markup', 'Mar 5, 19:26 - 19:49 PST'],
    ['a twelve-hour clock', `Mar ${var_('date', '5')}, ${var_('time', '7:26 PM')} PST`],
    ['an unknown month', `Sept ${var_('date', '5')}, ${var_('time', '19:26')} PST`],
    ['an empty string', ''],
  ])('returns null for %s', (_label, timestamp) => {
    expect(parseHistorySpan(timestamp, { name: 'March', year: 2026 }, 'Etc/UTC')).toBeNull();
  });

  it('returns null when the bucket month is not a month name', () => {
    expect(
      parseHistorySpan(
        `Mar ${var_('date', '5')}, ${var_('time', '19:26')} UTC`,
        { name: 'Q1', year: 2026 },
        'Etc/UTC',
      ),
    ).toBeNull();
  });
});
