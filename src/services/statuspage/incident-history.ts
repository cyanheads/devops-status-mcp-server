/**
 * @fileoverview Reads a Statuspage page's quarterly history archive back to a date
 * floor and resolves each record's rendered display timestamp to UTC instants.
 *
 * The archive is undocumented and served per host, so every way it can fail — no
 * archive, a transport or shape failure, a timestamp outside the known grammar, a
 * page that does not step back one quarter — comes back as a value naming the gap
 * rather than a throw. It supplements the documented v2 feed and must never
 * degrade it.
 * @module services/statuspage/incident-history
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { getStatuspageService } from './statuspage-service.js';
import type { StatuspageHistoryIncident, StatuspageHistoryResponse } from './types.js';

/** A history-archive record with its display timestamp resolved to UTC. */
export interface HistoryRecord {
  code: string;
  /** ISO 8601 UTC, minute precision; null when the record shows no end. */
  end: string | null;
  impact: StatuspageHistoryIncident['impact'];
  message: string;
  name: string;
  /** ISO 8601 UTC, minute precision. */
  start: string;
}

/** What one walk of the archive read, and why it stopped if it fell short. */
export interface HistoryWalk {
  /** Why the walk stopped before the floor, or null when it reached it. */
  gap: string | null;
  /** True when a quarter starting at or before the floor was read. */
  reachedFloor: boolean;
  /** Page-local start date (YYYY-MM-DD) of the oldest quarter read, or null when none was. */
  readBackTo: string | null;
  /** Records from every page read, in page order. */
  records: HistoryRecord[];
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
/** The archive's month abbreviations are each name's first three letters (`Sep`, not `Sept`). */
const MONTH_ABBREVIATIONS = MONTH_NAMES.map((name) => name.slice(0, 3));

const MONTH = `(${MONTH_ABBREVIATIONS.join('|')})`;
const DATE = "<var data-var='date'>(\\d{1,2})</var>";
const TIME = "<var data-var='time'>(\\d{1,2}):(\\d{2})</var>";

/**
 * `Mon D, HH:MM[ - [Mon D, ]HH:MM] ZONE`, with the day and times wrapped in
 * `<var>` markup. The trailing zone abbreviation labels only the end, so it is not
 * read: each end is converted with the offset its own instant had, which keeps a
 * span that straddles a DST change right on both sides.
 */
const SPAN = new RegExp(
  `^${MONTH} ${DATE}, ${TIME}(?: - (?:${MONTH} ${DATE}, )?${TIME})?(?: \\S+)?$`,
);

const formatters = new Map<string, Intl.DateTimeFormat>();

/** A cached wall-clock reader for `timeZone`. Throws RangeError for an unknown zone. */
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** How far the zone's clock is ahead of UTC at the minute-aligned instant `utcMs`. */
function zoneOffsetMs(formatter: Intl.DateTimeFormat, utcMs: number): number {
  const parts = formatter.formatToParts(utcMs);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  const wall = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'));
  return wall - utcMs;
}

/** The UTC instant at which the zone's clock read the given wall time. */
function wallTimeToUtc(
  formatter: Intl.DateTimeFormat,
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute: number,
): number {
  const wall = Date.UTC(year, monthIndex, day, hour, minute);
  // The offset read at the first guess is wrong when a DST change falls between the
  // guess and the true instant; reading it again at the guess settles it.
  const guess = wall - zoneOffsetMs(formatter, wall);
  return wall - zoneOffsetMs(formatter, guess);
}

/**
 * Resolve one archive timestamp to UTC. `bucket` is the `months[]` entry the record
 * is filed under, which supplies the year the timestamp omits; `timeZone` is the
 * page's IANA zone from its v2 `page.time_zone`. Returns null when the text is not
 * in the known grammar.
 */
export function parseHistorySpan(
  timestamp: string,
  bucket: { name: string; year: number },
  timeZone: string,
): { start: string; end: string | null } | null {
  const bucketMonth = MONTH_NAMES.indexOf(bucket.name);
  const match = SPAN.exec(timestamp);
  if (bucketMonth === -1 || !match) return null;
  const [, startMon = '', startDay, startHour, startMinute, endMon, endDay, endHour, endMinute] =
    match;

  const formatter = formatterFor(timeZone);
  // A span is filed under the month it ends in, so a month later than the bucket's
  // (a December start under January) belongs to the year before.
  const yearOf = (monthIndex: number) => bucket.year - (monthIndex > bucketMonth ? 1 : 0);

  const startMonth = MONTH_ABBREVIATIONS.indexOf(startMon);
  const start = wallTimeToUtc(
    formatter,
    yearOf(startMonth),
    startMonth,
    Number(startDay),
    Number(startHour),
    Number(startMinute),
  );
  if (endHour === undefined) return { start: new Date(start).toISOString(), end: null };

  // An end shown without a date falls on the start's date.
  const endMonth = endMon === undefined ? startMonth : MONTH_ABBREVIATIONS.indexOf(endMon);
  const end = wallTimeToUtc(
    formatter,
    yearOf(endMonth),
    endMonth,
    Number(endDay ?? startDay),
    Number(endHour),
    Number(endMinute),
  );
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

/** Calendar quarter of a page-local ISO timestamp, as a running count (year × 4 + quarter). */
function quarterOf(localIso: string): number | null {
  const match = /^(\d{4})-(\d{2})-\d{2}T/.exec(localIso);
  return match ? Number(match[1]) * 4 + Math.floor((Number(match[2]) - 1) / 3) : null;
}

/** Calendar quarter of a UTC instant, counted as {@link quarterOf} counts. */
function utcQuarter(ms: number): number {
  const date = new Date(ms);
  return date.getUTCFullYear() * 4 + Math.floor(date.getUTCMonth() / 3);
}

function describeFetchFailure(err: unknown, page: number): string {
  if (err instanceof McpError && (err.data as { status?: number } | undefined)?.status === 404) {
    return page === 1
      ? 'the status page publishes none (HTTP 404)'
      : `history page ${page} answered HTTP 404`;
  }
  return `history page ${page} failed: ${(err as Error).message}`;
}

/**
 * Read the archive from page 1 (the current quarter) one quarter back per page,
 * stopping at the first quarter that starts at or before `floorMs`. Each page must
 * step back exactly one quarter from the last; a page that does not (a redirect
 * that drops `?page=` returns page 1 again) ends the walk rather than being read
 * as an older quarter.
 *
 * The page count is bounded by the floor, not by the pages: reaching it takes one page
 * per quarter from today's back to the floor's, plus one at each end because the page
 * counts quarters in its own zone while today and the floor are UTC. An archive still
 * short of the floor after that is not counting back from today — a page 1 dated years
 * ahead would otherwise step back one request at a time for as long as it liked.
 */
export async function readIncidentHistory(
  baseUrl: string,
  timeZone: string | undefined,
  floorMs: number,
): Promise<HistoryWalk> {
  const records: HistoryRecord[] = [];
  let readBackTo: string | null = null;
  const stop = (gap: string): HistoryWalk => ({ records, reachedFloor: false, readBackTo, gap });

  if (!timeZone) {
    return stop('its status API names no page time zone, which the archive timestamps need');
  }
  try {
    formatterFor(timeZone);
  } catch {
    return stop(`its status API names time zone "${timeZone}", which is not a recognized zone`);
  }

  const today = utcQuarter(Date.now());
  const maxPages = today - Math.min(utcQuarter(floorMs), today) + 3;
  let previousQuarter: number | null = null;
  for (let page = 1; page <= maxPages; page++) {
    let data: StatuspageHistoryResponse;
    try {
      ({ data } = await getStatuspageService().fetchHistory(baseUrl, page));
    } catch (err) {
      return stop(describeFetchFailure(err, page));
    }

    const windowStart = Date.parse(data.start_time);
    const quarter = quarterOf(data.start_time);
    if (quarter === null || Number.isNaN(windowStart)) {
      return stop(`history page ${page} gives an unreadable window start "${data.start_time}"`);
    }
    if (previousQuarter !== null && quarter !== previousQuarter - 1) {
      return stop(
        `history page ${page} returned the quarter starting ${data.start_time.slice(0, 10)} ` +
          `instead of the one before ${readBackTo}, so its page number was not honored`,
      );
    }

    const pageRecords: HistoryRecord[] = [];
    for (const month of data.months) {
      for (const { code, name, impact, message, timestamp } of month.incidents) {
        const span = parseHistorySpan(timestamp, month, timeZone);
        if (!span) {
          return stop(
            `record ${code} on history page ${page} has a timestamp in an unrecognized format`,
          );
        }
        pageRecords.push({ code, name, impact, message, ...span });
      }
    }

    records.push(...pageRecords);
    readBackTo = data.start_time.slice(0, 10);
    previousQuarter = quarter;
    if (windowStart <= floorMs) return { records, reachedFloor: true, readBackTo, gap: null };
  }
  return stop(
    `${maxPages} pages were read without reaching it, more than the quarters between today ` +
      'and that date, so the pages are not counting back from today',
  );
}
