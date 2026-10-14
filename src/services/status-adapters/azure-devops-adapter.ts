/**
 * @fileoverview Azure DevOps status adapter — reads the two keyless sources behind
 * status.dev.azure.com and normalizes them into the Atlassian Statuspage shapes the
 * tools consume:
 * - Health - Get (`/_apis/status/health?api-version=7.1-preview.1`): the overall
 *   `status.health` and `message`, plus `health` for every service in every geography.
 * - The `/_rss` feed: recent events, one `<item>` each, resolved ones included.
 *
 * Feed notes:
 * - Health values come from the documented `ScopeHealth` enum: `healthy`, `advisory`,
 *   `degraded`, `unhealthy`, `unknown`. Every service × geography cell becomes one
 *   component named `<service> (<geography name>)`, ungrouped — the eight geography
 *   names repeat under every service, so the service name always rides along.
 * - Component status: healthy → operational, advisory → degraded_performance,
 *   degraded → partial_outage, unhealthy → major_outage; unknown or anything
 *   unrecognized → degraded_performance.
 * - Indicator from the overall health: healthy → none, advisory → minor, degraded and
 *   unhealthy → major; unknown or anything unrecognized → minor. Never critical: each
 *   cell is one service in one geography, so even the worst cell is a partial outage
 *   of Azure DevOps as a whole. The description is the overall `message`.
 * - An RSS item carries `title`, `link`/`guid` (`…/_event/<n>`), `pubDate` (its latest
 *   update), `status:state` (`Active`/`Resolved`), one or more `status:geography`, and
 *   every update in `content:encoded`: entity-escaped HTML sections separated by
 *   `<hr>`, newest first, each headed by a label and an "Author, M/D/YYYY h:mm:ss AM"
 *   line in UTC. There is no severity and no service field.
 * - Incident mapping: id is the event number; `Resolved` → resolved (at `pubDate`),
 *   anything else → investigating; impact is a fixed `minor`, since the feed carries no
 *   severity. Updates are the plain text of each section, oldest first, timed by their
 *   header stamp; `started_at` is the oldest stamp. The geographies ride the latest
 *   update as affected components. Active items are the summary's incidents.
 * - Neither source publishes maintenance windows, so scheduled maintenances are empty.
 * @module services/status-adapters/azure-devops-adapter
 */

import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import type {
  AffectedComponent,
  StatuspageComponent,
  StatuspageIncident,
  StatuspageIncidentsResponse,
  StatuspagePage,
  StatuspageScheduledMaintenancesResponse,
  StatuspageSeverityIndicator,
  StatuspageSummaryResponse,
} from '@/services/statuspage/types.js';
import { fetchCached } from '@/utils/cached-fetch.js';
import { htmlToText } from '@/utils/html-to-text.js';
import { elementText, elementTexts, rssItems } from './rss-extract.js';

const HEALTH_URL = 'https://status.dev.azure.com/_apis/status/health?api-version=7.1-preview.1';
const FEED_URL = 'https://status.dev.azure.com/_rss';
const EVENT_URL = 'https://status.dev.azure.com/_event/';

// --- Raw source types ---

interface AzureDevOpsGeography {
  /** `ScopeHealth` value for this service in this geography. */
  health?: string;
  /** Short code, e.g. "AU". */
  id?: string;
  /** Display name, e.g. "Australia". */
  name?: string;
}

interface AzureDevOpsService {
  geographies?: AzureDevOpsGeography[];
  /** Service display name, e.g. "Core services". */
  id?: string;
}

/** The Health - Get response, its envelope checked. */
export interface AzureDevOpsHealth {
  lastUpdated?: string;
  services: AzureDevOpsService[];
  status: { health?: string; message?: string };
}

/** One RSS `<item>`, its text decoded. */
export interface AzureDevOpsFeedItem {
  /** Event number from the item's `_event/<n>` link; '' when it carries none. */
  eventId: string;
  /** `status:geography` values, in feed order. */
  geographies: string[];
  /** RFC 822 date of the latest update, e.g. "Thu, 08 Oct 2026 16:36:20 GMT". */
  pubDate: string;
  /** `status:state` as published — `Active` or `Resolved`. */
  state: string;
  title: string;
  /** Plain text of each update section, newest first as the feed lists them. */
  updates: string[];
}

/** Identifies the vendor the response is being normalized for. */
export interface AzureDevOpsTarget {
  name: string;
  slug: string | null;
  /** Public status page URL (display only — both source endpoints are fixed). */
  url: string;
}

// --- Parsing ---

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Check the Health - Get envelope. A body without the `status` object and `services`
 * array is some other document, not this endpoint, and is rejected rather than read as
 * an all-clear.
 */
export function parseAzureDevOpsHealth(body: unknown): AzureDevOpsHealth {
  if (!isObject(body) || !isObject(body.status) || !Array.isArray(body.services)) {
    throw serviceUnavailable(
      `${HEALTH_URL} returned a body without the status object and services list the Azure DevOps health endpoint publishes.`,
      { reason: 'statuspage_unavailable', url: HEALTH_URL },
    );
  }
  return body as unknown as AzureDevOpsHealth;
}

/** An HTML `<hr>` tag in any of its spellings — the separator between update sections. */
const HR_TAG = /<hr(?:[\s/][^<>]*)?>/i;

const EVENT_NUMBER = /\/_event\/(\d+)/;

/**
 * Extract the items from a feed body. A body with no RSS `<channel>` is some other
 * document, not this feed, and is rejected rather than read as an empty feed.
 */
export function parseAzureDevOpsFeed(xml: string): AzureDevOpsFeedItem[] {
  const items = rssItems(xml);
  if (items === undefined) {
    throw serviceUnavailable(
      `${FEED_URL} returned a body with no RSS <channel> element, so it is not the Azure DevOps status feed.`,
      { reason: 'statuspage_unavailable', url: FEED_URL },
    );
  }
  return items.map((item) => {
    const link = elementText(item, 'guid') || elementText(item, 'link');
    const html = elementText(item, 'content:encoded') || elementText(item, 'description');
    return {
      eventId: EVENT_NUMBER.exec(link)?.[1] ?? '',
      title: elementText(item, 'title').trim(),
      pubDate: elementText(item, 'pubDate').trim(),
      state: elementText(item, 'status:state').trim(),
      geographies: elementTexts(item, 'status:geography')
        .map((g) => g.trim())
        .filter((g) => g !== ''),
      updates: html
        .split(HR_TAG)
        .map((section) => htmlToText(section).trim())
        .filter((text) => text !== ''),
    };
  });
}

// --- Mappings ---

function healthToComponentStatus(health: string | undefined): StatuspageComponent['status'] {
  switch (health) {
    case 'healthy':
      return 'operational';
    case 'degraded':
      return 'partial_outage';
    case 'unhealthy':
      return 'major_outage';
    default:
      return 'degraded_performance';
  }
}

function healthToIndicator(health: string | undefined): StatuspageSeverityIndicator {
  switch (health) {
    case 'healthy':
      return 'none';
    case 'degraded':
    case 'unhealthy':
      return 'major';
    default:
      return 'minor';
  }
}

function toIso(rfc822: string): string {
  const ms = Date.parse(rfc822);
  return Number.isNaN(ms) ? '' : new Date(ms).toISOString();
}

/** "M/D/YYYY h:mm:ss AM" — the UTC stamp on an update's header line. */
const UPDATE_STAMP = /(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2}) ?([AP]M)/i;

/**
 * ISO time of an update section, read from the stamp on its header — the label line and
 * the author line that follow it — or '' when the header carries no valid stamp.
 */
export function updateTime(section: string): string {
  const firstBreak = section.indexOf('\n');
  const headerEnd = firstBreak === -1 ? -1 : section.indexOf('\n', firstBreak + 1);
  const match = UPDATE_STAMP.exec(headerEnd === -1 ? section : section.slice(0, headerEnd));
  if (!match) return '';
  const [month, day, year, hour, minute, second] = match.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (hour < 1 || hour > 12 || minute > 59 || second > 59) return '';
  const pm = match[7]?.toUpperCase() === 'PM';
  const date = new Date(
    Date.UTC(year, month - 1, day, (hour % 12) + (pm ? 12 : 0), minute, second),
  );
  // Date.UTC rolls an impossible day or month into the next one; reject it instead.
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
  return date.toISOString();
}

function buildPage(target: AzureDevOpsTarget, updatedAt: string | undefined): StatuspagePage {
  return {
    id: target.slug ?? 'azure-devops',
    name: target.name,
    time_zone: 'Etc/UTC',
    updated_at: updatedAt ?? '',
    url: target.url,
  };
}

/** Normalize one feed item into a Statuspage incident — see module fileoverview. */
export function mapAzureDevOpsItem(
  item: AzureDevOpsFeedItem,
  target: AzureDevOpsTarget,
): StatuspageIncident {
  const resolved = item.state.toLowerCase() === 'resolved';
  const status = resolved ? 'resolved' : 'investigating';
  const published = toIso(item.pubDate);
  const updates = [...item.updates].reverse();
  const times = updates.map(updateTime);
  const stamped = times.filter((t) => t !== '').sort();
  const started = stamped[0] ?? null;
  const id = item.eventId || 'unknown';
  const affected: AffectedComponent[] = item.geographies.map((name) => ({
    code: name,
    name,
    new_status: '',
    old_status: '',
  }));
  const last = updates.length - 1;

  return {
    id,
    name: item.title || 'Unnamed incident',
    impact: 'minor',
    status,
    created_at: started ?? published,
    started_at: started,
    resolved_at: resolved ? published || null : null,
    monitoring_at: null,
    page_id: target.slug ?? 'azure-devops',
    shortlink: item.eventId ? `${EVENT_URL}${item.eventId}` : null,
    components: [],
    incident_updates: updates.map((body, i) => ({
      id: `${id}-${i}`,
      body,
      // The latest update is the one that settled the item; earlier ones were posted open.
      status: i === last ? status : 'investigating',
      created_at: times[i] ?? '',
      display_at: times[i] ?? '',
      affected_components: i === last && affected.length > 0 ? affected : null,
    })),
  };
}

/** Normalize into the incidents-endpoint shape, newest first. */
export function mapAzureDevOpsIncidents(
  items: AzureDevOpsFeedItem[],
  target: AzureDevOpsTarget,
): StatuspageIncidentsResponse {
  return {
    page: buildPage(target, undefined),
    incidents: items
      .map((item) => mapAzureDevOpsItem(item, target))
      .sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0)),
  };
}

/** Normalize the health response and the feed into a Statuspage summary. */
export function mapAzureDevOpsSummary(
  health: AzureDevOpsHealth,
  items: AzureDevOpsFeedItem[],
  target: AzureDevOpsTarget,
): StatuspageSummaryResponse {
  const updatedAt = health.lastUpdated ?? '';
  // A cell with no service name or no geography has nothing to name its component by.
  const cells = health.services.flatMap((service) =>
    (Array.isArray(service.geographies) ? service.geographies : [])
      .filter((geo) => service.id && (geo.name || geo.id))
      .map((geo) => ({ service: service.id, geo })),
  );
  const components: StatuspageComponent[] = cells.map(({ service, geo }, i) => ({
    id: `${service}/${geo.id || geo.name}`,
    name: `${service} (${geo.name || geo.id})`,
    status: healthToComponentStatus(geo.health),
    created_at: '',
    updated_at: updatedAt,
    description: null,
    group: false,
    group_id: null,
    only_show_if_degraded: false,
    position: i,
    showcase: true,
  }));
  const overall = health.status.health;

  return {
    page: buildPage(target, updatedAt),
    status: {
      indicator: healthToIndicator(overall),
      description: health.status.message?.trim() || `Overall health: ${overall ?? 'not reported'}`,
    },
    components,
    incidents: mapAzureDevOpsIncidents(items, target).incidents.filter(
      (i) => i.status !== 'resolved',
    ),
    scheduled_maintenances: [],
  };
}

// --- Fetchers ---

function fetchHealth(): Promise<{ data: AzureDevOpsHealth; cached: boolean }> {
  const { cacheTtlMs, fetchTimeoutMs } = getServerConfig();
  return fetchCached(HEALTH_URL, cacheTtlMs, fetchTimeoutMs, async (res) =>
    parseAzureDevOpsHealth(await res.json()),
  );
}

function fetchFeed(): Promise<{ data: AzureDevOpsFeedItem[]; cached: boolean }> {
  const { cacheTtlMs, fetchTimeoutMs } = getServerConfig();
  return fetchCached(FEED_URL, cacheTtlMs, fetchTimeoutMs, async (res) =>
    parseAzureDevOpsFeed(await res.text()),
  );
}

/** Health and feed are fetched together; the summary needs both. */
export async function fetchAzureDevOpsSummary(
  target: AzureDevOpsTarget,
): Promise<{ data: StatuspageSummaryResponse; cached: boolean }> {
  const [health, feed] = await Promise.all([fetchHealth(), fetchFeed()]);
  return {
    data: mapAzureDevOpsSummary(health.data, feed.data, target),
    cached: health.cached && feed.cached,
  };
}

export async function fetchAzureDevOpsIncidents(
  target: AzureDevOpsTarget,
): Promise<{ data: StatuspageIncidentsResponse; cached: boolean }> {
  const { data, cached } = await fetchFeed();
  return { data: mapAzureDevOpsIncidents(data, target), cached };
}

/** Neither source publishes maintenance windows — always empty, no network call. */
export function fetchAzureDevOpsScheduledMaintenances(
  target: AzureDevOpsTarget,
): Promise<{ data: StatuspageScheduledMaintenancesResponse; cached: boolean }> {
  return Promise.resolve({
    data: { page: buildPage(target, undefined), scheduled_maintenances: [] },
    cached: false,
  });
}
