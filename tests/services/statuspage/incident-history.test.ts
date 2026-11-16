/**
 * @fileoverview Tests for the Statuspage history-archive reader: its timestamp parser
 * and its page walk. Every parseHistorySpan timestamp is recorded verbatim from a live
 * page; the expected instants come from the same incident's v2 record where one
 * exists, so a conversion is checked against the vendor's own UTC value rather than
 * against a hand calculation.
 * @module tests/services/statuspage/incident-history.test
 */

import { createFetchMock } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseHistorySpan, readIncidentHistory } from '@/services/statuspage/incident-history.js';
import { initStatuspageService } from '@/services/statuspage/statuspage-service.js';
import { clearFetchCache } from '@/utils/cached-fetch.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({ cacheTtlMs: 60_000, fetchTimeoutMs: 8000 }),
}));

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

/**
 * The walk runs the real service and fetch path down to a fetch fake serving a
 * synthetic archive: page N is the quarter N−1 before the one holding NOW, with one
 * record coded `pN`. The fetch timeout is the 8 s default.
 */
describe('readIncidentHistory', () => {
  const http = createFetchMock();
  const NOW = Date.parse('2026-11-16T08:00:00Z');
  /** 24 months before NOW, the floor the tool reads back to at most. */
  const FLOOR = Date.parse('2024-11-16T00:00:00Z');
  /**
   * A fresh host per case: concurrent reads of one URL share one request, so a walk a
   * failed case left in flight would otherwise hold the next case's request.
   */
  let hosts = 0;
  let base = '';
  const QUARTER_MONTHS = [
    ['January', 'Jan', '01'],
    ['April', 'Apr', '04'],
    ['July', 'Jul', '07'],
    ['October', 'Oct', '10'],
  ] as const;

  const pageUrl = (page: number) => `${base}/history.json?page=${page}`;
  const pages = (count: number) => Array.from({ length: count }, (_, i) => i + 1);
  const records = (count: number) =>
    pages(count).map((page) => expect.objectContaining({ code: `p${page}` }));
  const requested = () => http.calls.map((c) => c.request.url);

  function historyPage(page: number) {
    const quarter = 2026 * 4 + 3 - (page - 1);
    const year = Math.floor(quarter / 4);
    const [name, abbreviation, month] = QUARTER_MONTHS[quarter % 4]!;
    return {
      start_time: `${year}-${month}-01T00:00:00Z`,
      months: [
        {
          name,
          year,
          incidents: [
            {
              code: `p${page}`,
              name: `Record on page ${page}`,
              message: 'Resolved.',
              impact: 'minor',
              timestamp: `${abbreviation} ${var_('date', '2')}, ${var_('time', '10:00')} - ${var_('time', '11:00')} UTC`,
            },
          ],
        },
      ],
    };
  }

  /**
   * Serve every page, each answered `delayMs` after its request, or at once. A request's
   * abort rejects it early and is recorded in `aborted`; `onAnswer` runs as a page answers.
   */
  function serveArchive(delayMs: number, onAnswer?: (page: number) => void) {
    const aborted: number[] = [];
    http.route({
      match: (request) => request.url.startsWith(`${base}/history.json?page=`),
      respond: (request) => {
        const page = Number(new URL(request.url).searchParams.get('page'));
        const answer = () => {
          onAnswer?.(page);
          return Response.json(historyPage(page));
        };
        if (delayMs === 0) return answer();
        return new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => resolve(answer()), delayMs);
          request.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              aborted.push(page);
              reject(request.signal.reason);
            },
            { once: true },
          );
        });
      },
    });
    return aborted;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(NOW);
    base = `https://status-${++hosts}.walk.example`;
    clearFetchCache();
    initStatuspageService();
    http.reset();
    http.install();
  });

  afterEach(() => {
    http.restore();
    vi.useRealTimers();
  });

  it('reads one page per quarter, back to the first whose window starts at or before the floor', async () => {
    serveArchive(0);
    const walk = await readIncidentHistory(base, 'Etc/UTC', FLOOR);

    expect(requested()).toEqual(pages(9).map(pageUrl));
    expect(walk).toEqual({
      records: records(9),
      reachedFloor: true,
      readBackTo: '2024-10-01',
      gap: null,
    });
    expect(Date.now()).toBe(NOW);
  });

  it('gives a page the full fetch timeout while the limit leaves more, and names its own failure', async () => {
    const aborted = serveArchive(9000);
    const pending = readIncidentHistory(base, 'Etc/UTC', FLOOR);
    await vi.advanceTimersByTimeAsync(8000);

    expect(await pending).toEqual({
      records: [],
      reachedFloor: false,
      readBackTo: null,
      gap: `history page 1 failed: Timed out after 8000ms fetching ${pageUrl(1)}`,
    });
    expect(aborted).toEqual([1]);
    expect(Date.now() - NOW).toBe(8000);
  });

  it('settles at the 30-second limit when every page answers just under the fetch timeout', async () => {
    // Three pages fit in 23,997 ms; the fourth runs under the 6,003 ms left and is cut at
    // 30 s, before the 31,996 ms at which it would have answered.
    const aborted = serveArchive(7999);
    let walk: Awaited<ReturnType<typeof readIncidentHistory>> | undefined;
    const pending = readIncidentHistory(base, 'Etc/UTC', FLOOR).then((w) => {
      walk = w;
    });

    await vi.advanceTimersByTimeAsync(29_999);
    expect(walk).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    expect(walk).toEqual({
      records: records(3),
      reachedFloor: false,
      readBackTo: '2026-04-01',
      gap: 'the 30-second limit on the read passed before history page 4',
    });
    await pending;
    expect(Date.now() - NOW).toBe(30_000);
    expect(requested()).toEqual(pages(4).map(pageUrl));
    expect(aborted).toEqual([4]);
  });

  it('sends no request once no time is left, keeping the pages read before', async () => {
    // Page 3 answers as the clock reaches the limit, so page 4 would start with none left.
    serveArchive(0, (page) => {
      if (page === 3) vi.setSystemTime(NOW + 30_000);
    });
    const walk = await readIncidentHistory(base, 'Etc/UTC', FLOOR);

    expect(requested()).toEqual(pages(3).map(pageUrl));
    expect(walk).toEqual({
      records: records(3),
      reachedFloor: false,
      readBackTo: '2026-04-01',
      gap: 'the 30-second limit on the read passed before history page 4',
    });
  });
});
