/**
 * @fileoverview Tool to fetch incident history and scheduled maintenance windows for a vendor.
 * @module mcp-server/tools/definitions/devops-get-incidents.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { BackendHistory } from '@/services/status-adapters/status-dispatch.js';
import {
  fetchVendorIncidents,
  fetchVendorScheduledMaintenances,
  vendorHistory,
} from '@/services/status-adapters/status-dispatch.js';
import type { HistoryRecord, HistoryWalk } from '@/services/statuspage/incident-history.js';
import { readIncidentHistory } from '@/services/statuspage/incident-history.js';
import type { StatuspageIncident } from '@/services/statuspage/types.js';
import type { ResolvedVendor } from '@/services/vendor-registry/vendor-registry-service.js';
import { getVendorRegistryService } from '@/services/vendor-registry/vendor-registry-service.js';
import { clampMax } from '@/utils/input-bounds.js';
import { assertSafeUrl, ssrfRejectionMessage } from '@/utils/ssrf-guard.js';
import { vendorInline, vendorQuote } from '@/utils/vendor-markdown.js';
import { hasEveryTerm, toTerms } from '@/utils/word-match.js';
import { productSlugsNotice, renderWindowEnd } from './devops-vendor-result.js';

/**
 * How far back the history archive is read, which bounds the history pages one call
 * reads. It bounds the archive walk only: records the live feeds return are kept or left
 * out by `since` and `until` as the caller sent them.
 */
const HISTORY_MAX_MONTHS = 24;

/** Most incidents one page returns; a larger `limit` is served at this. */
const LIMIT_MAX = 50;

const DAY_MS = 86_400_000;

/**
 * Bytes each response surface — the serialized structuredContent and the content[]
 * text — is held to. A page ends between whole incidents when the next one would cross
 * it; only an incident over it on its own loses updates, oldest first.
 */
const RESPONSE_BUDGET_BYTES = 64_000;

/**
 * Room kept on each surface for what is settled only once the page is cut: the paging
 * fields (truncated, shown, cap, totalCount, nextOffset, upstreamCeiling, as JSON keys or
 * trailer labels) and the paging and size-budget sentences of the notice, which carry
 * only numbers and fixed text. Notices settled before the cut are measured instead.
 */
const PAGE_DISCLOSURE_RESERVE_BYTES = 1_024;

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

const utf8Bytes = (text: string) => Buffer.byteLength(text, 'utf8');

function durationMinutes(
  startedAt: string | null | undefined,
  resolvedAt: string | null,
): number | null {
  if (!startedAt || !resolvedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = new Date(resolvedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  // Statuspage data is vendor-authored — inverted timestamps (resolved_at before
  // started_at) occur in the wild and would yield a nonsense negative duration.
  if (end < start) return null;
  return Math.round((end - start) / 60_000);
}

type IncidentSource = 'api' | 'history';

function normalizeIncident(i: StatuspageIncident, isScheduled: boolean) {
  const updates = [...i.incident_updates].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );

  const affectedComponents = [
    ...new Set(i.incident_updates.flatMap((u) => (u.affected_components ?? []).map((c) => c.name))),
  ];

  return {
    id: i.id,
    name: i.name,
    impact: (isScheduled ? 'maintenance' : i.impact) as
      | 'none'
      | 'minor'
      | 'major'
      | 'critical'
      | 'maintenance',
    status: i.status,
    created_at: i.created_at,
    started_at: i.started_at ?? null,
    resolved_at: i.resolved_at ?? null,
    scheduled_for: i.scheduled_for ?? null,
    scheduled_until: i.scheduled_until ?? null,
    duration_minutes: durationMinutes(i.started_at, i.resolved_at),
    shortlink: i.shortlink ?? null,
    affected_components: affectedComponents,
    ...(i.affected_locations ? { affected_locations: i.affected_locations } : {}),
    updates: updates.map((u) => ({
      status: u.status,
      body: u.body,
      created_at: u.created_at,
    })),
    source: 'api' as IncidentSource,
  };
}

/** `updates_omitted` is set only on an incident trimmed to the response size budget. */
type Incident = ReturnType<typeof normalizeIncident> & { updates_omitted?: number };

/**
 * A history-archive record in the incident shape. The archive carries only the
 * title, impact, displayed span, and latest update message, so the fields it has
 * no counterpart for are null or empty rather than inferred. A record with no end
 * has no published lifecycle stage — it may be open, in progress, or cancelled —
 * so its status is `unknown`.
 */
function normalizeHistoryRecord(r: HistoryRecord, baseUrl: string): Incident {
  const status = r.end ? 'resolved' : 'unknown';
  return {
    id: r.code,
    name: r.name,
    impact: r.impact,
    status,
    created_at: r.start,
    started_at: null,
    resolved_at: r.end,
    scheduled_for: null,
    scheduled_until: null,
    duration_minutes: null,
    shortlink: `${baseUrl}/incidents/${r.code}`,
    affected_components: [],
    updates: [{ status, body: r.message, created_at: r.end ?? r.start }],
    source: 'history',
  };
}

/**
 * Scheduled maintenances, or none when the page serves no maintenance endpoint. A
 * 404 is tolerable only because the incidents fetch beside this one proves the base
 * URL is a real Statuspage — filter: 'scheduled' has no such proof and still errors.
 */
function fetchPublishedMaintenances(vendor: ResolvedVendor): Promise<StatuspageIncident[]> {
  return fetchVendorScheduledMaintenances(vendor).then(
    ({ data }) => data.scheduled_maintenances,
    (err: unknown) => {
      if (err instanceof McpError && (err.data as { status?: number } | undefined)?.status === 404)
        return [];
      throw err;
    },
  );
}

/** Incident statuses each non-scheduled filter keeps; null keeps every incident. */
const INCIDENT_STATUSES: Record<'all' | 'active' | 'resolved', readonly string[] | null> = {
  all: null,
  active: ['investigating', 'identified', 'monitoring'],
  resolved: ['resolved', 'postmortem'],
};

/** The earliest date the history archive is read back to, on the UTC date of `now`. */
function historyFloor(now: Date): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - HISTORY_MAX_MONTHS, now.getUTCDate()),
  )
    .toISOString()
    .slice(0, 10);
}

/** The fields a start is read from, on a vendor feed's record or a normalized one. */
interface DatedRecord {
  created_at: string;
  scheduled_for?: string | null | undefined;
  started_at?: string | null | undefined;
}

/**
 * The instant `since` and `until` compare a record on: `scheduled_for` for a maintenance
 * window, else the earlier of `started_at` and `created_at`. Statuspage puts the entered
 * event time in `started_at` on a backdated post and in `created_at` on a retroactive one,
 * and Google Cloud's `begin` precedes `created`, so the earlier of the two is the start.
 * Only a value that parses counts — `new Date(null)` is the epoch and `Math.min` with NaN
 * is NaN — and a record with neither is NaN, outside every range.
 */
function recordStart(record: DatedRecord): number {
  const scheduled = record.scheduled_for ?? null;
  if (scheduled !== null) return Date.parse(scheduled);
  const created = Date.parse(record.created_at);
  const started = record.started_at ? Date.parse(record.started_at) : Number.NaN;
  if (Number.isNaN(started)) return created;
  return Number.isNaN(created) ? started : Math.min(started, created);
}

/** The UTC date of the earliest start among `records`, or null when none has one. */
function oldestStartDate(records: readonly DatedRecord[]): string | null {
  const starts = records.map(recordStart).filter((ms) => !Number.isNaN(ms));
  return starts.length === 0 ? null : new Date(Math.min(...starts)).toISOString().slice(0, 10);
}

type IncidentFilter = 'all' | 'active' | 'resolved' | 'scheduled';

/**
 * The filters that can return more than the one that just came back empty, rendered
 * for a guidance sentence, or null when none can. Recommending the filter the caller
 * passed, or one the backend can never satisfy, sends them back for a second empty result.
 *
 * `active`, `resolved`, and `scheduled` are disjoint, and `all` is their union, so only
 * the other disjoint filters this backend serves can hold anything new — and `all` adds
 * something only when one of them can. On a feed with no resolved history and no
 * maintenance windows, an empty `active` leaves nothing to offer. An empty `all` never
 * reaches here — it is answered on its own below, because every narrower filter is empty
 * by construction once `all` is.
 */
function alternativeFilters(history: BackendHistory, used: IncidentFilter): string | null {
  const disjoint: IncidentFilter[] = ['active'];
  if (history.resolved !== 'none') disjoint.push('resolved');
  if (history.scheduledMaintenance) disjoint.push('scheduled');
  const others = disjoint.filter((f) => f !== used);
  if (others.length === 0) return null;
  return ['all', ...others].map((f) => `"${f}"`).join(' or ');
}

/** What the date range and `match` removed from the filter's matches, step by step. */
interface Narrowing {
  /** Matches left out for starting after `until`. */
  afterUntil: number;
  /** Matches left out for starting before `since`. */
  beforeSince: number;
  /**
   * The start date of the oldest record a feed with no history archive behind it returned,
   * when the date range reaches back past it: on a recent-window feed, a `since` earlier
   * than it or an `until` with no `since`; on a whole-history feed, an `until` earlier than
   * it. Otherwise null, as it is when the feed returned no record.
   */
  feedStart: string | null;
  /** The earliest date the history archive is read back to on this call's clock. */
  historyFloor: string;
  /** True when `match` also reads location names and IDs, which Google Cloud and AWS list. */
  matchesLocations: boolean;
  since: string | undefined;
  /** The terms `match` was read as, each a word or hyphen-joined words; empty when it is unset. */
  terms: string[];
  /** Matches inside the date range that `match` left out. */
  unmatched: number;
  until: string | undefined;
  /**
   * The ceiling the vendor's own feed imposed on this call, or null. Its notice names the
   * way to the incidents past it, so the date-range notice leaves that to it.
   */
  upstreamCeiling: number | null;
}

/** The filter plus the date range the caller set, e.g. `filter "all" (since 2026-09-01)`. */
function describeFilter(filter: IncidentFilter, { since, until }: Narrowing): string {
  const range = [
    ...(since === undefined ? [] : [`since ${since}`]),
    ...(until === undefined ? [] : [`until ${until}`]),
  ];
  return `filter "${filter}"${range.length > 0 ? ` (${range.join(', ')})` : ''}`;
}

/** Why a date range that left nothing did so, and how to widen it. */
function dateRangeGuidance(
  name: string,
  filter: IncidentFilter,
  history: BackendHistory,
  url: string,
  { since, until, beforeSince, afterUntil, feedStart, historyFloor, upstreamCeiling }: Narrowing,
): string {
  if (until === undefined) {
    return (
      `No incidents matching filter "${filter}" for ${name} started on or after ${since}; ` +
      `${beforeSince} older match${plural(beforeSince, ' was', 'es were')} left out by since. ` +
      'Pass an earlier since, or omit it for the most recent incidents regardless of date.'
    );
  }
  /**
   * Where a feed that carries its page's whole history starts; feedStart is set on one only
   * when the range ends before that. On a recent-window feed, feedStartGuidance (composed
   * after this) says where it starts instead.
   */
  const historyStart =
    history.wholeHistory && feedStart !== null
      ? ` ${name}'s status feed carries its status page's whole history, which starts on ${feedStart}; the page publishes nothing older.`
      : '';
  if (since === undefined) {
    const matches = `No incidents matching filter "${filter}" for ${name} started on or before ${until}: all ${afterUntil} match${plural(afterUntil, '', 'es')} started after it.`;
    if (!history.historyPages) return `${matches}${historyStart}`;
    // A ceiling notice that follows names the way to older incidents: since, or the status page.
    if (until < historyFloor) {
      const page = upstreamCeiling === null ? ` See ${url} for earlier history.` : '';
      return `${matches} The status page's history archive is read back ${HISTORY_MAX_MONTHS} months at most, to ${historyFloor}, so since cannot reach incidents that started on or before ${until}.${page}`;
    }
    return upstreamCeiling === null
      ? `${matches} Add since (up to ${HISTORY_MAX_MONTHS} months back) to also read the status page's history archive, which reaches incidents older than the ones its status API returns.`
      : matches;
  }
  const leftOut = [
    ...(beforeSince > 0
      ? [`${beforeSince} earlier match${plural(beforeSince, ' was', 'es were')} left out by since`]
      : []),
    ...(afterUntil > 0
      ? [`${afterUntil} later match${plural(afterUntil, ' was', 'es were')} left out by until`]
      : []),
  ];
  const floor =
    history.historyPages && since < historyFloor
      ? ` The history archive is read back to ${historyFloor} at most, so before that date ` +
        'only records the status API still returns are reachable.'
      : '';
  // A range reaching back past where a feed with no archive starts holds nothing older a wider
  // range would add; feedStartGuidance, composed after this, or historyStart says where it starts.
  const widen =
    feedStart === null
      ? ' Widen the range, or omit since and until for the most recent incidents regardless of date.'
      : '';
  return (
    `No incidents matching filter "${filter}" for ${name} started between ${since} and ${until}; ` +
    `${leftOut.join(' and ')}.${widen}${floor}${historyStart}`
  );
}

/**
 * Why this call returned nothing, in terms of what the caller asked for and what
 * the vendor's backend can serve. `matched` counts the incidents left after the
 * filter, date range, and `match` — before offset/limit windowing — so a positive
 * value means the offset overshot them. The steps narrow in order (filter, then date
 * range, then `match`), so the last step that left out a match is the one that emptied
 * the result.
 */
function emptyResultGuidance(
  name: string,
  filter: IncidentFilter,
  offset: number,
  matched: number,
  history: BackendHistory,
  url: string,
  narrowing: Narrowing,
): string {
  if (matched > 0) {
    const terms = narrowing.terms.length > 0 ? ` with match "${narrowing.terms.join(' ')}"` : '';
    return `offset ${offset} is past the end of this result: ${describeFilter(filter, narrowing)}${terms} matched ${matched} incident${plural(matched, '', 's')} for ${name}, so the valid offsets are 0–${matched - 1}. Call again with a lower offset.`;
  }
  if (narrowing.unmatched > 0) {
    const { unmatched, terms, matchesLocations } = narrowing;
    const fields = matchesLocations
      ? 'title, affected components, or affected locations'
      : 'title or affected components';
    const text = matchesLocations
      ? 'the title, one component name, or one location name or ID'
      : 'the title or one component name';
    // A term reads back hyphen-joined, so a hyphen marks one whose words must sit together.
    const phrase = terms.some((term) => term.includes('-'))
      ? ` A hyphenated term matches only where its words appear together, in that order, within ${text}; spaces between its words let each match on its own.`
      : '';
    return `${unmatched} incident${plural(unmatched, '', 's')} for ${name} matched ${describeFilter(filter, narrowing)}, but none has every term of "${terms.join(' ')}" in its ${fields}.${phrase} Use fewer or broader terms, or omit match. History-archive records, and vendors that publish no components, match on title only.`;
  }
  if (narrowing.beforeSince + narrowing.afterUntil > 0) {
    return dateRangeGuidance(name, filter, history, url, narrowing);
  }
  if (filter === 'all') {
    /**
     * "all" spans every event the vendor's feed returned, so the narrower filters are
     * empty by construction — naming one here would send the caller back for another
     * empty result. At the feed's ceiling, an "all" the date range and match left whole is
     * empty only because the entry's component scope left out every record the shared
     * page's feed returned, and older in-scope incidents can sit past the ceiling: its
     * notice, which follows, names the way to them. Otherwise the vendor's own page is the
     * only place left to look.
     */
    if (narrowing.upstreamCeiling !== null) {
      return `None of the incidents or maintenance windows ${name}'s status feed returned touch ${name}'s components, so the narrower filters have nothing to return either.`;
    }
    return (
      `${name} currently lists no incidents and no maintenance windows at all. Filter "all" ` +
      'already spans everything its status feed publishes, so the narrower filters have ' +
      `nothing to return either. See ${url} to confirm on the vendor's own status page.`
    );
  }

  const alternatives = alternativeFilters(history, filter);
  if (alternatives === null) {
    // `active` is always servable, so only an empty `active` can leave nothing to offer.
    return (
      `${name} currently lists no open incidents. Its status feed publishes only currently-open ` +
      'events and keeps no resolved history or maintenance windows, so no other filter can ' +
      `return more. See ${url} to confirm on the vendor's own status page.`
    );
  }
  if (filter === 'resolved' && history.resolved === 'none') {
    return (
      `${name} publishes currently-open events with no resolution lifecycle, so ` +
      `filter: "resolved" can never return incidents for it. Try filter: ${alternatives}.`
    );
  }
  if (filter === 'resolved' && history.resolved === 'current') {
    return (
      `${name} publishes only the incidents its status page currently lists, and it lists no ` +
      `resolved one now; older resolved history is not retrievable from it. Try filter: ${alternatives}.`
    );
  }
  if (filter === 'scheduled' && !history.scheduledMaintenance) {
    return (
      `${name} publishes no scheduled-maintenance feed, so filter: "scheduled" is always ` +
      `empty for it. Try filter: ${alternatives}.`
    );
  }
  return `No incidents matched filter "${filter}" for ${name}. Try filter: ${alternatives}.`;
}

/**
 * State that the vendor's own feed, not this tool's window, bounded the history. The
 * omitted incidents are unreachable at any offset: `sinceReaches` is true when since would
 * reach them through the status page's history archive, and otherwise the vendor's status
 * page is the only path to them. Whether a page publishes an archive is known only once since
 * reads it, so the since path keeps the status page for a page that publishes none.
 */
function upstreamCeilingGuidance(ceiling: number, url: string, sinceReaches: boolean): string {
  return sinceReaches
    ? `The vendor's status API returns at most ${ceiling} incidents per fetch and offers no pagination, so incidents older than the oldest one it returned are not reachable at any offset. Set since to reach them through the status page's history archive, ${HISTORY_MAX_MONTHS} months back at most, where the page publishes one; where it publishes none, see ${url} for the older history.`
    : `The vendor's status API returns at most ${ceiling} incidents per fetch and offers no pagination, so incidents older than the oldest one it returned are not reachable through this tool at any offset. See ${url} for the older history.`;
}

/**
 * State how far the history archive was read when it stopped short of `since`, so
 * the result is not taken as complete back to that date.
 */
function historyGapGuidance(name: string, since: string, walk: HistoryWalk): string {
  const gap = walk.gap?.replace(/\.$/, '');
  return walk.readBackTo === null
    ? `The ${name} history archive could not be read: ${gap}. Incidents between ` +
        `${since} and the oldest one the status API returned may be missing.`
    : `The ${name} history archive was read back to ${walk.readBackTo}, not to ${since}: ` +
        `${gap}. Incidents between those two dates may be missing.`;
}

/**
 * State that a `since` older than the history floor read the archive only to the floor,
 * so the records older than it are those the status API still returns, not all of them.
 * A walk that stopped short of the floor is described on its own by historyGapGuidance.
 */
function historyFloorGuidance(since: string, floor: string, walk: HistoryWalk): string {
  const reach = walk.reachedFloor
    ? `the archive was read back to ${walk.readBackTo}`
    : `the archive is read back to ${floor} at most`;
  return (
    `since ${since} is past the ${HISTORY_MAX_MONTHS}-month history-archive floor; ${reach}, so ` +
    'incidents that started before that appear only where the status API still returns them.'
  );
}

/**
 * State that the date range reaches back past everything a recent-window feed with no
 * history archive returned — a `since` earlier than its oldest record, or an `until` with no
 * `since` — so the result is not read as "no incidents before its oldest record". `url` is
 * null when the incident-ceiling notice already points to the status page.
 */
function feedStartGuidance(
  name: string,
  since: string | undefined,
  feedStart: string,
  url: string | null,
): string {
  const reach =
    since === undefined
      ? `The oldest record ${name}'s status feed returned starts on ${feedStart}.`
      : `since ${since} is earlier than the oldest record ${name}'s status feed returned, which starts on ${feedStart}.`;
  return `${reach} This tool reads no history archive for ${name}, so it cannot return incidents that started before then.${url === null ? '' : ` See ${url} for earlier history.`}`;
}

/** The incident fields format() renders — the handler's records and the parsed output alike. */
interface RenderableIncident {
  affected_components: string[];
  affected_locations?: { current: boolean; id: string; name: string }[] | undefined;
  created_at: string;
  duration_minutes: number | null;
  id: string;
  impact: string;
  name: string;
  resolved_at: string | null;
  scheduled_for: string | null;
  scheduled_until: string | null;
  shortlink?: string | null | undefined;
  source: string;
  started_at?: string | null | undefined;
  status: string;
  updates: { status: string; body: string; created_at: string }[];
  updates_omitted?: number | undefined;
}

/** The lines format() opens content[] with. */
function renderHeader(result: {
  name: string;
  vendor: string;
  total_returned: number;
  statuspage_url: string;
}): string[] {
  return [
    `## ${result.name} (${result.vendor}) — ${result.total_returned} incidents`,
    `**URL:** ${result.statuspage_url}`,
    '',
  ];
}

/** An identifier in a code span, which renders `<` and `&` as written. */
const codeSpan = (id: string) => `\`${id.replace(/[\r\n]+/g, ' ')}\``;

/** One incident's block of format() lines, ending in a blank line. */
function renderIncident(inc: RenderableIncident): string[] {
  const icon =
    inc.status === 'resolved' || inc.status === 'completed'
      ? '✅'
      : inc.impact === 'critical'
        ? '🔴'
        : '⚠️';
  const lines = [`### ${icon} ${vendorInline(inc.name)} ${codeSpan(inc.id)}`];
  lines.push(
    `**Impact:** ${inc.impact} | **Status:** ${vendorInline(inc.status)} | **Source:** ${inc.source} | **Created:** ${vendorInline(inc.created_at)}${inc.started_at ? ` | **Started:** ${vendorInline(inc.started_at)}` : ''}`,
  );
  if (inc.resolved_at) {
    const duration = inc.duration_minutes !== null ? ` (${inc.duration_minutes} min)` : '';
    lines.push(`**Resolved:** ${vendorInline(inc.resolved_at)}${duration}`);
  }
  if (inc.scheduled_for)
    lines.push(
      `**Scheduled:** ${vendorInline(inc.scheduled_for)} → ${renderWindowEnd(inc.scheduled_until)}`,
    );
  if (inc.affected_components.length > 0) {
    lines.push(`**Components:** ${inc.affected_components.map(vendorInline).join(', ')}`);
  }
  // One line per state present, current first; the id follows the name, which often omits it.
  for (const current of [true, false]) {
    const located = (inc.affected_locations ?? []).filter((l) => l.current === current);
    if (located.length === 0) continue;
    const entries = located.map((l) => `${vendorInline(l.name)} ${codeSpan(l.id)}`);
    lines.push(`**Locations (${current ? 'current' : 'previous'}):** ${entries.join(', ')}`);
  }
  const omitted = inc.updates_omitted ?? 0;
  lines.push(
    omitted > 0
      ? `**Updates (${inc.updates.length} of ${inc.updates.length + omitted}, ${omitted} oldest omitted):**`
      : `**Updates (${inc.updates.length}):**`,
  );
  for (const u of inc.updates) {
    lines.push(
      `- [${vendorInline(u.created_at)}] ${vendorInline(u.status)}:`,
      ...vendorQuote(u.body),
    );
  }
  // The blank line ends the last quote, which would otherwise take in the link.
  if (inc.shortlink) lines.push('', `[Incident page](${inc.shortlink})`);
  lines.push('');
  return lines;
}

/** Bytes on each response surface. */
interface SurfaceBytes {
  content: number;
  structured: number;
}

/**
 * One incident's bytes on each surface, as structuredContent serializes it and format()
 * renders it, counting the comma or newline that joins it to what comes before.
 */
function incidentBytes(inc: Incident): SurfaceBytes {
  return {
    structured: utf8Bytes(JSON.stringify(inc)) + 1,
    content: utf8Bytes(renderIncident(inc).join('\n')) + 1,
  };
}

const fitsIn = (size: SurfaceBytes, room: SurfaceBytes) =>
  size.structured <= room.structured && size.content <= room.content;

/**
 * `inc` cut to its newest updates — as many as fit in `room` on both surfaces, and never
 * fewer than the newest one — with `updates_omitted` counting the rest. The components and
 * locations stay whole, so an incident can remain over `room` when they, its fields, and
 * its newest update alone exceed it.
 */
function keepNewestUpdates(inc: Incident, room: SurfaceBytes): Incident {
  const total = inc.updates.length;
  const keep = (count: number): Incident => ({
    ...inc,
    updates: inc.updates.slice(total - count),
    updates_omitted: total - count,
  });
  // More updates never take fewer bytes, so the largest count that fits is found by bisection.
  let best = 1;
  let low = 2;
  let high = total - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (fitsIn(incidentBytes(keep(mid)), room)) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return keep(best);
}

/**
 * The incidents of `windowed`, from its start, that fit the response size budget on both
 * surfaces after `overhead`. The page ends before the first incident that would cross it,
 * but always holds the first one: when that one alone crosses it, it returns alone, with
 * its oldest updates left out unless `fullUpdates` asks for every update regardless of size.
 */
function fitToBudget(
  windowed: Incident[],
  overhead: SurfaceBytes,
  fullUpdates: boolean,
): Incident[] {
  const page: Incident[] = [];
  const used = { ...overhead };
  for (const inc of windowed) {
    const room = {
      structured: RESPONSE_BUDGET_BYTES - used.structured,
      content: RESPONSE_BUDGET_BYTES - used.content,
    };
    const size = incidentBytes(inc);
    if (fitsIn(size, room)) {
      page.push(inc);
      used.structured += size.structured;
      used.content += size.content;
      continue;
    }
    if (page.length === 0) {
      page.push(fullUpdates || inc.updates.length < 2 ? inc : keepNewestUpdates(inc, room));
    }
    break;
  }
  return page;
}

export const devopsGetIncidents = tool('devops_get_incidents', {
  description:
    'Fetch incident history and scheduled maintenance windows for a vendor. Returns full incident timeline — each investigator update, affected components, and resolution. Filter by status to focus on active incidents (use before deploy), resolved history (for postmortem), or maintenance windows: upcoming and in-progress ones, plus completed ones on Atlassian Statuspage, Firehydrant, and Datadog vendors (Status.io vendors list upcoming and in-progress only). Narrow further with match (terms in the title or affected component names, plus location names and IDs on Google Cloud and AWS) and since/until (a start-date range) — all applied before paging, so totals count only what they keep. Page through long histories with limit + offset — a truncated result discloses the total and returns the value to page with in nextOffset. Each response is held to 64,000 bytes per surface: a page can stop short of limit at that budget (the paging fields and notice say so), and an incident too large on its own keeps only its newest updates, with updates_omitted counting the rest — full_updates: true returns them all. Some vendor feeds cap their own history: when upstreamCeiling is present the vendor API returned everything it will serve, and older incidents are not reachable at a higher offset; the notice says whether since reaches them. On Atlassian Statuspage vendors, since (a date) also reads the status page\'s quarterly history archive back to that date, or 24 months back at most, where the page publishes one — not on a vendor that covers only part of a shared page, such as "sendgrid"; those records are marked source: "history" and carry the title, impact, start and end times, and final update message only. An empty result, or a history read that stopped short of since, explains itself in notice.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    vendor: z
      .string()
      .min(1)
      .describe(
        'Vendor slug (e.g., "github", "aws") or raw Atlassian Statuspage base URL. Use devops_list_vendors to find slugs.',
      ),
    filter: z
      .enum(['all', 'active', 'resolved', 'scheduled'])
      .default('all')
      .describe(
        'all: incidents plus scheduled maintenances. active: only incidents with status investigating/identified/monitoring. resolved: only fully resolved incidents. scheduled: only maintenance windows — upcoming and in-progress ones, plus completed ones on Atlassian Statuspage, Firehydrant ("redis-cloud"), and Datadog ("datadog", "datadog-eu1") vendors; Status.io vendors ("gitlab", "neon") list upcoming and in-progress windows only. Not every vendor backend serves every filter — "aws" lists a resolved event only until it drops off its feed, "azure" lists open items only (never resolved), and "aws", "azure", "azure-devops", "gcp", and "slack" publish no maintenance windows. An empty result names which case applied.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .default(20)
      .describe(
        'Maximum incidents to return per call, at least 1. A value over 50 is served as 50, and the notice says so. Page through longer history with offset rather than raising this.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Number of matching incidents to skip before applying limit, for paging through history. 0 (default) returns the most recent page; a truncated result returns the value to use next in the nextOffset field. Raising offset past the number of matches returns an empty list and says so.',
      ),
    since: z
      .union([
        z.literal(''),
        z.iso
          .date()
          .describe('Earliest start date to include, as YYYY-MM-DD (UTC), e.g. "2025-10-01".'),
      ])
      .optional()
      .describe(
        'Earliest start date to include, as YYYY-MM-DD (UTC). Accepted with filter "all" or "resolved". A record\'s start is its scheduled_for, else the earlier of its started_at and created_at; records that started before since are left out, and limit/offset page the rest. On Atlassian Statuspage vendors it also reads the status page\'s quarterly history archive back to this date, reaching incidents older than the 50 the status API serves — except on a vendor that covers only part of a shared status page (such as "sendgrid" on Twilio\'s page), whose archive records carry no components to narrow by. The archive is read back 24 months at most: for an earlier date, older records come only from what the status API still returns (such as completed maintenance windows), and the notice gives the date the archive was read back to. On a vendor with no archive this tool reads, since filters only what its status feed returns. Where that feed is a recent window, a since earlier than the oldest record it returned gets that record\'s start date in the notice. A feed that carries its page\'s whole history (such as "redis-cloud" or "datadog") holds nothing older, so it gets that date only on an empty result whose until is earlier than it. Omit to read only the status API.',
      ),
    until: z
      .union([
        z.literal(''),
        z.iso
          .date()
          .describe('Latest start date to include, as YYYY-MM-DD (UTC), e.g. "2025-10-31".'),
      ])
      .optional()
      .describe(
        'Latest start date to include, as YYYY-MM-DD (UTC) — the whole day, so until equal to since returns that one day. Accepted with filter "all" or "resolved", and on or after since. A record\'s start is its scheduled_for, else the earlier of its started_at and created_at; records that started after until are left out before limit/offset page the rest. It reads no history archive on its own: set since as well to reach incidents older than the status API returns, through an archive read back 24 months at most. On a vendor with no archive this tool reads, until alone filters what its status feed returns. Where that feed is a recent window, the notice then gives the start date of the oldest record it returned. A feed that carries its page\'s whole history (such as "redis-cloud" or "datadog") gets that date only on an empty result whose until is earlier than it.',
      ),
    match: z
      .string()
      .max(200)
      .refine((text) => text.trim() === '' || toTerms(text).length > 0, {
        message: 'match needs at least one letter or digit; leave it blank to keep every incident.',
      })
      .optional()
      .describe(
        'Terms to look for, separated by spaces, in each incident\'s title, its affected component names, and, on Google Cloud and AWS, its affected location names and IDs ("us-central1", "me-south-1", "bahrain"), ignoring case. An incident is kept when every term appears in its title, one of its component names, or one of its location names or IDs, each term on its own. A one-word term matches all or part of a word. A term whose words are joined by punctuation ("eu-central-1", "git-operations", "git/operations") matches only where those words appear together, in that order, within one of those texts, anywhere in it: "eu-central-1" finds eu-central-1 but not me-central-1, and "eu-west" finds every eu-west region. History-archive records, and vendors that publish no components, match on title alone. Applied before limit/offset, so totals and paging count only the matches. Leave blank to keep every incident.',
      ),
    full_updates: z
      .boolean()
      .default(false)
      .describe(
        'Return every update of an incident that is too large for the response size budget on its own, instead of only its newest updates. Default false. Pair it with limit: 1 and the offset the notice names; the response can then run past the budget.',
      ),
  }),

  output: z.object({
    vendor: z.string().describe('Vendor slug or URL as provided.'),
    name: z.string().describe('Display name of the vendor.'),
    incidents: z
      .array(
        z
          .object({
            id: z.string().describe("Unique incident identifier from the vendor's status API."),
            name: z.string().describe('Incident title.'),
            impact: z
              .enum(['none', 'minor', 'major', 'critical', 'maintenance'])
              .describe(
                'Severity level: none = informational, minor = degraded performance, major = partial outage, critical = full outage, maintenance = scheduled window.',
              ),
            status: z
              .string()
              .describe(
                'Current status: investigating | identified | monitoring | resolved | postmortem | scheduled | in_progress | completed | unknown. unknown marks a history-archive record with no end time, whose lifecycle stage the archive does not publish.',
              ),
            created_at: z
              .string()
              .describe(
                'ISO 8601 timestamp when the incident was created, carrying the UTC offset the vendor published (Z, +00:00, or a local offset such as -07:00). For a history-archive record, the start time its status page displays, to the minute, in UTC.',
              ),
            started_at: z
              .string()
              .nullish()
              .describe(
                "ISO 8601 timestamp, with the vendor's UTC offset, when the incident started, or null/absent if not set by the vendor.",
              ),
            resolved_at: z
              .string()
              .nullable()
              .describe(
                "ISO 8601 timestamp, with the vendor's UTC offset, when resolved, or null if still active. For a history-archive record, to the minute, in UTC.",
              ),
            scheduled_for: z
              .string()
              .nullable()
              .describe(
                "Present for scheduled maintenances — ISO 8601 start time with the vendor's UTC offset.",
              ),
            scheduled_until: z
              .string()
              .nullable()
              .describe(
                "Present for scheduled maintenances — ISO 8601 end time with the vendor's UTC offset, or null when the vendor's feed publishes no planned end.",
              ),
            duration_minutes: z
              .number()
              .nullable()
              .describe(
                'Minutes from started_at to resolved_at. Null for active or scheduled incidents, or when the vendor-authored timestamps are missing, invalid, or inverted.',
              ),
            shortlink: z
              .string()
              .nullish()
              .describe(
                'Direct URL to the incident page, or null/absent if not provided by the vendor.',
              ),
            affected_components: z
              .array(z.string())
              .describe('Component names affected by this incident.'),
            affected_locations: z
              .array(
                z
                  .object({
                    id: z.string().describe('Provider location ID, e.g. "us-central1".'),
                    name: z.string().describe('Provider location name, e.g. "Iowa (us-central1)".'),
                    current: z
                      .boolean()
                      .describe(
                        'True while the incident still affects this location; false once it has stopped affecting it.',
                      ),
                  })
                  .describe('A location the incident lists.'),
              )
              .optional()
              .describe(
                'Regions the incident lists, currently affected first: on Google Cloud its regions and multi-regions, on AWS the one region its event names ("global" for a global service); absent when it lists none.',
              ),
            updates: z
              .array(
                z
                  .object({
                    status: z.string().describe('Incident status at the time of this update.'),
                    body: z
                      .string()
                      .describe(
                        'Update text from the vendor, as plain text: HTML markup the vendor published is converted (a link reads as its text, then its URL), and any other < is text the vendor wrote.',
                      ),
                    created_at: z
                      .string()
                      .describe("ISO 8601 timestamp of this update, with the vendor's UTC offset."),
                  })
                  .describe('A single status update from the vendor.'),
              )
              .describe(
                'Chronological list of incident updates (oldest first). A history-archive record carries only its final update, dated at its end time (or its start when it has none). An incident too large for the response size budget on its own carries only its newest updates, and updates_omitted counts the rest.',
              ),
            updates_omitted: z
              .number()
              .int()
              .optional()
              .describe(
                "How many of this incident's oldest updates were left out because it alone exceeds the response size budget; the updates returned are its newest. Absent when every update is returned. Call again with full_updates: true and limit: 1 at this incident's offset to read them all.",
              ),
            source: z
              .enum(['api', 'history'])
              .describe(
                "Where this record came from. api: the vendor's status API, with the full update timeline and affected components. history: the status page's quarterly history archive, read only when since is set — title, impact, start and end times, and the final update message, with no components and no started_at, scheduled window, or duration.",
              ),
          })
          .describe('An incident or scheduled maintenance entry.'),
      )
      .describe('Matching incidents.'),
    total_returned: z.number().describe('Number of incidents in the response.'),
    statuspage_url: z.string().describe('Status page base URL used.'),
  }),

  enrichment: {
    // Each field is written only on the path that produces it — a truncated page, an
    // empty result, or a vendor feed that hit its own ceiling — so all are optional
    // and a plain result passes the effective-output parse with none of them set.
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when more incidents matched than this page returned — because of limit, or because the page stopped at the response size budget. Absent when this page reached the end of the matches.',
      ),
    shown: z
      .number()
      .optional()
      .describe(
        'Number of incidents on this page: the limit, or fewer when the page stopped at the response size budget. Present only when truncated.',
      ),
    cap: z
      .number()
      .optional()
      .describe(
        'The limit that was applied: the requested limit, or 50 when a larger one was requested. Present only when truncated.',
      ),
    totalCount: z
      .number()
      .optional()
      .describe(
        'Total incidents matching the filter, date range, and match, across all pages, before offset/limit windowing. Present only when the result was truncated.',
      ),
    nextOffset: z
      .number()
      .optional()
      .describe(
        'The offset to pass on the next call to continue from where this page stopped, already computed as offset + the number returned. Present only when truncated — its absence means this page reached the end of what the filter matched.',
      ),
    upstreamCeiling: z
      .number()
      .optional()
      .describe(
        'Maximum incidents the vendor\'s own status API serves in one fetch, present only when that ceiling was reached on this call. It bounds the history independently of limit and offset: incidents older than the oldest one returned cannot be fetched at any offset. On Atlassian Statuspage vendors, since reads past it from the page\'s history archive, except on a vendor that covers only part of a shared page, such as "sendgrid"; the notice says whether since reaches past it on this call. Absent when the vendor feed is unbounded, returned less than its ceiling, or since was set and the history archive was read back to it (or to its 24-month floor, when since is older).',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        "Plain-language explanation of this result — a limit over 50 that was served as 50 (with the requested and effective values), a since older than the 24-month history-archive floor (with the date the archive was read back to), a since earlier than the oldest record a vendor feed that is a recent window with no history archive behind it returned, or an until without since on such a feed (with that record's start date), how to page onward, that the page stopped at the response size budget or left out an oversized incident's oldest updates (and the call that returns them all), why it came back empty (the vendor currently publishes nothing at all, a capped feed of a shared status page that returned nothing touching the vendor's components, a filter the backend cannot satisfy, an offset past the end, a since/until range or match terms that left everything out — naming the archive floor when the range reaches back past it, and where a feed that carries its page's whole history starts when the range ends before that), that the vendor feed capped the history (and whether since reaches past that cap), or how far the history archive was read when it stopped short of since or its floor. On a vendor that reads an umbrella status page with no components, such as \"atlassian\", its last sentence names the product slugs to check instead. Absent when the result needs no explanation.",
      ),
  },

  errors: [
    {
      reason: 'vendor_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Vendor slug not in registry and input is not a valid URL.',
      recovery: 'Call devops_list_vendors to browse slugs or pass the full Statuspage base URL.',
    },
    {
      reason: 'target_blocked',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A raw URL resolves to a private, loopback, or cloud-metadata address.',
      recovery:
        'Pass a publicly routable Statuspage URL. If internal monitoring is intentional, set DEVOPS_STATUS_ALLOW_PRIVATE_TARGETS=true.',
    },
    {
      reason: 'invalid_since',
      code: JsonRpcErrorCode.ValidationError,
      when: 'since was passed with filter "active" or "scheduled"',
      recovery:
        'Pass since with filter "all" or "resolved", or omit it. It reads the history archive back 24 months at most.',
    },
    {
      reason: 'invalid_until',
      code: JsonRpcErrorCode.ValidationError,
      when: 'until was passed with filter "active" or "scheduled", or names a date earlier than the since date',
      recovery:
        'Pass until as a YYYY-MM-DD date on or after since, with filter "all" or "resolved".',
    },
    {
      reason: 'statuspage_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: "The vendor's status API returned an error or timed out.",
      recovery: 'Retry after 30s. If it persists, check the status page URL in a browser.',
      retryable: true,
      // Raised below the handler: every transport failure in the shared cached-fetch
      // helper leaves as a ServiceUnavailable carrying this reason.
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const registry = getVendorRegistryService();

    const resolved = registry.resolve(input.vendor);
    if (!resolved) {
      throw ctx.fail(
        'vendor_not_found',
        `"${input.vendor}" is not a known vendor slug and is not a valid URL.`,
      );
    }

    // SSRF guard: only raw URL inputs need checking — registry entries are pre-verified public URLs.
    if (resolved.slug === null) {
      try {
        await assertSafeUrl(resolved.url);
      } catch (err) {
        const blocked = ssrfRejectionMessage(err);
        if (blocked === null) throw err;
        throw ctx.fail('target_blocked', blocked);
      }
    }

    const history = vendorHistory(resolved);
    // Form clients send an optional field they left blank as "", which means unset.
    const since = input.since || undefined;
    const until = input.until || undefined;
    const readsIncidentHistory = input.filter === 'all' || input.filter === 'resolved';
    if (since !== undefined && !readsIncidentHistory) {
      throw ctx.fail(
        'invalid_since',
        `since reads incident history, so it accepts filter "all" or "resolved", not "${input.filter}".`,
      );
    }
    if (until !== undefined && !readsIncidentHistory) {
      throw ctx.fail(
        'invalid_until',
        `until bounds incident history, so it accepts filter "all" or "resolved", not "${input.filter}".`,
      );
    }
    if (since !== undefined && until !== undefined && until < since) {
      throw ctx.fail(
        'invalid_until',
        `until ${until} is before since ${since}; pass an until on or after since (the same date returns that one day).`,
      );
    }
    const floor = historyFloor(new Date());
    const floorMs = since === undefined ? null : Date.parse(`${since}T00:00:00Z`);
    const ceilingMs = until === undefined ? null : Date.parse(`${until}T00:00:00Z`) + DAY_MS;
    const terms = toTerms(input.match ?? '');
    /**
     * How far back the archive is read: since, or the history floor when since is older.
     * `until` alone reads no archive: the walk is bounded by the date it reads back to.
     */
    const archiveSince = since !== undefined && since < floor ? floor : since;
    const readsHistory = archiveSince !== undefined && history.historyPages;
    /**
     * The feed is a recent window with no archive behind it, so nothing older than its
     * oldest record is reachable. A whole-history feed (Firehydrant, Datadog) is the page's
     * complete record, so on it nothing older exists.
     */
    const windowedFeed = !history.historyPages && !history.wholeHistory;

    let incidents: Incident[] = [];
    /**
     * Records the vendor's incident feed returned before this tool filtered them —
     * the only number that reveals whether the feed hit its own ceiling. Null when
     * the incident feed was not fetched at all (filter: 'scheduled').
     */
    let upstreamIncidentCount: number | null = null;
    let walk: HistoryWalk | null = null;
    /** True when two lists were merged, so the result needs ordering newest first. */
    let merged = false;
    /** See Narrowing.feedStart. */
    let feedStart: string | null = null;

    if (input.filter === 'scheduled') {
      const { data } = await fetchVendorScheduledMaintenances(resolved);
      incidents = data.scheduled_maintenances.map((i) => normalizeIncident(i, true));
    } else {
      /**
       * The maintenance list is part of an `all` result, where a failed read fails the
       * call as it does without since. With history it is also half of what a history
       * record must be absent from to be added; under `resolved` that is its only use,
       * so there a failed read costs the archive, never the v2 result.
       */
      const [{ data, upstreamIncidents }, maintenances] = await Promise.all([
        fetchVendorIncidents(resolved),
        input.filter === 'all' || readsHistory
          ? fetchPublishedMaintenances(resolved).catch((err: unknown) => {
              if (input.filter === 'all') throw err;
              return err as Error;
            })
          : [],
      ]);
      const published = maintenances instanceof Error ? [] : maintenances;
      upstreamIncidentCount = upstreamIncidents.length;
      if (!history.historyPages && (since !== undefined || until !== undefined)) {
        // Everything the call read, before a component scope, filter, range, or match narrowed it.
        const oldest = oldestStartDate([...upstreamIncidents, ...published]);
        /**
         * On a recent window, an until with no since leaves the range open below, so it
         * reaches past any start. A whole-history feed holds nothing older, so only a range
         * that ends before its start, and so finds nothing, has a start to name.
         */
        if (
          oldest !== null &&
          (windowedFeed
            ? since === undefined || since < oldest
            : until !== undefined && until < oldest)
        ) {
          feedStart = oldest;
        }
      }
      const statuses = INCIDENT_STATUSES[input.filter];
      incidents = data.incidents
        .filter((i) => statuses === null || statuses.includes(i.status))
        .map((i) => normalizeIncident(i, false));
      if (input.filter === 'all') {
        incidents.push(...published.map((i) => normalizeIncident(i, true)));
      }

      if (readsHistory) {
        walk =
          maintenances instanceof Error
            ? {
                records: [],
                reachedFloor: false,
                readBackTo: null,
                gap: `its records are matched against the scheduled-maintenances list, which failed: ${maintenances.message}`,
              }
            : await readIncidentHistory(
                resolved.url,
                data.page.time_zone,
                Date.parse(`${archiveSince}T00:00:00Z`),
              );
        // v2 wins: a history record joins on `code` = v2 `id` and is added only when
        // neither v2 list carries it.
        const known = new Set([...data.incidents, ...published].map((i) => i.id));
        for (const record of walk.records) {
          if (known.has(record.code)) continue;
          known.add(record.code);
          const incident = normalizeHistoryRecord(record, resolved.url);
          if (input.filter === 'all' || incident.status === 'resolved') incidents.push(incident);
        }
      }
      merged = input.filter === 'all' || walk !== null;
    }

    /**
     * The ceiling the vendor's own feed imposed on this call, or null when it has
     * none or returned less than it. A reached ceiling is a different bound from
     * truncation: paging cannot get past it, so it is disclosed on its own. History
     * read back to `since` lifts it for this call.
     */
    const upstreamCeiling =
      history.incidentCeiling !== null &&
      upstreamIncidentCount !== null &&
      upstreamIncidentCount >= history.incidentCeiling &&
      !walk?.reachedFloor
        ? history.incidentCeiling
        : null;

    /**
     * The date range applies to each record's start (recordStart): a maintenance window
     * created before `since` but scheduled after it is still inside the range asked for,
     * and an incident posted the day after it began is filed under the day it began.
     */
    const narrowing: Narrowing = {
      since,
      until,
      historyFloor: floor,
      beforeSince: 0,
      afterUntil: 0,
      feedStart,
      upstreamCeiling,
      terms,
      matchesLocations: resolved.api_type === 'gcp' || resolved.api_type === 'aws',
      unmatched: 0,
    };
    if (floorMs !== null || ceilingMs !== null) {
      incidents = incidents.filter((i) => {
        const start = recordStart(i);
        if (floorMs !== null && !(start >= floorMs)) {
          narrowing.beforeSince++;
          return false;
        }
        if (ceilingMs !== null && !(start < ceilingMs)) {
          narrowing.afterUntil++;
          return false;
        }
        return true;
      });
    }
    if (terms.length > 0) {
      const inRange = incidents.length;
      incidents = incidents.filter((i) =>
        hasEveryTerm(terms, [
          i.name,
          ...i.affected_components,
          ...(i.affected_locations ?? []).flatMap((l) => [l.name, l.id]),
        ]),
      );
      narrowing.unmatched = inRange - incidents.length;
    }
    if (merged) {
      incidents.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    }

    const limit = clampMax('limit', input.limit, LIMIT_MAX);
    const windowed = incidents.slice(input.offset, input.offset + limit.value);

    // `notice` is last-wins across every enrich call, so the reasons compose into
    // one string rather than overwriting each other. These are settled before the page
    // is cut, so the size budget measures them; the paging sentences are written after.
    const settledNotices: string[] = [];
    if (limit.notice) settledNotices.push(limit.notice);
    if (walk !== null && since !== undefined && since !== archiveSince) {
      settledNotices.push(historyFloorGuidance(since, floor, walk));
    }
    if (upstreamCeiling !== null) {
      ctx.enrich({ upstreamCeiling });
      /**
       * The history archive reaches past the ceiling on a call that read none and could set
       * since, unless the range ends before the archive floor, which since cannot pass.
       */
      const sinceReaches =
        since === undefined &&
        readsIncidentHistory &&
        history.historyPages &&
        (until === undefined || until >= floor);
      settledNotices.push(upstreamCeilingGuidance(upstreamCeiling, resolved.url, sinceReaches));
    }
    if (archiveSince !== undefined && walk?.gap) {
      settledNotices.push(historyGapGuidance(resolved.name, archiveSince, walk));
    }
    if (feedStart !== null && windowedFeed) {
      settledNotices.push(
        feedStartGuidance(
          resolved.name,
          since,
          feedStart,
          upstreamCeiling === null ? resolved.url : null,
        ),
      );
    }

    /**
     * The umbrella-page pointer is settled before the cut too, so the budget measures it,
     * but it closes the composed notice, after every other sentence.
     */
    const pointer = productSlugsNotice(resolved);
    // Filter, then page, then bound: the budget only ever ends this page sooner.
    const settled = [...settledNotices, ...(pointer === undefined ? [] : [pointer])].join(' ');
    const envelope = {
      vendor: input.vendor,
      name: resolved.name,
      total_returned: windowed.length,
      statuspage_url: resolved.url,
    };
    const page = fitToBudget(
      windowed,
      {
        structured:
          utf8Bytes(JSON.stringify({ ...envelope, incidents: [] })) +
          utf8Bytes(JSON.stringify(settled)) +
          PAGE_DISCLOSURE_RESERVE_BYTES,
        content:
          utf8Bytes(renderHeader(envelope).join('\n')) +
          utf8Bytes(settled) +
          PAGE_DISCLOSURE_RESERVE_BYTES,
      },
      input.full_updates,
    );
    const nextOffset = input.offset + page.length;
    const truncated = nextOffset < incidents.length;
    const updatesOmitted = page[0]?.updates_omitted ?? 0;

    const notices: string[] = [];
    if (truncated) {
      const stopped =
        page.length < windowed.length
          ? `; this page stopped at the ${RESPONSE_BUDGET_BYTES.toLocaleString('en-US')}-byte ` +
            `response size budget short of limit ${limit.value}`
          : '';
      notices.push(
        `Showing incidents ${input.offset + 1}–${nextOffset} of ${incidents.length}${stopped}. ` +
          `Call again with offset: ${nextOffset} for the next page, or narrow with filter, since, until, or match.`,
      );
    } else if (page.length === 0) {
      notices.push(
        emptyResultGuidance(
          resolved.name,
          input.filter,
          input.offset,
          incidents.length,
          history,
          resolved.url,
          narrowing,
        ),
      );
    }
    if (updatesOmitted > 0) {
      notices.push(
        'The first incident on this page alone exceeds the response size budget, so its ' +
          `${updatesOmitted} oldest update${plural(updatesOmitted, ' was', 's were')} left out ` +
          '(updates_omitted). Call again with the same arguments plus ' +
          `offset: ${input.offset}, limit: 1, full_updates: true to read every update.`,
      );
    }
    notices.push(...settledNotices);
    if (pointer !== undefined) notices.push(pointer);

    if (truncated) {
      // More history exists beyond this page. Disclose the true total and the next
      // offset as a value — raising limit alone can't reach older incidents.
      ctx.enrich.total(incidents.length);
      ctx.enrich({ nextOffset });
      ctx.enrich.truncated({
        shown: page.length,
        cap: limit.value,
        guidance: notices.join(' '),
      });
    } else if (notices.length > 0) {
      ctx.enrich.notice(notices.join(' '));
    }

    ctx.log.info('Incidents fetched', {
      vendor: input.vendor,
      filter: input.filter,
      offset: input.offset,
      count: page.length,
      ...(page.length < windowed.length ? { budgetCut: true } : {}),
      ...(updatesOmitted > 0 ? { updatesOmitted } : {}),
      ...(since === undefined ? {} : { since, historyGap: walk?.gap ?? null }),
      ...(since !== archiveSince ? { historyReadBackTo: archiveSince } : {}),
      ...(limit.notice ? { requestedLimit: input.limit } : {}),
      ...(until === undefined ? {} : { until }),
      ...(terms.length === 0 ? {} : { match: terms.join(' ') }),
    });

    return {
      vendor: input.vendor,
      name: resolved.name,
      incidents: page,
      total_returned: page.length,
      statuspage_url: resolved.url,
    };
  },

  format: (result) => {
    const lines = renderHeader(result);
    if (result.total_returned === 0) {
      // What to do next depends on the filter, the offset, and what the vendor's
      // backend can serve — none of which reach format(). The handler writes that
      // guidance to the `notice` enrichment field, which the framework renders into
      // this same content[] block as a trailer, so naming a filter here would be a
      // guess that contradicts it.
      lines.push('No incidents matched this filter.');
      return [{ type: 'text', text: lines.join('\n') }];
    }
    for (const inc of result.incidents) lines.push(...renderIncident(inc));
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
