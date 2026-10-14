/**
 * @fileoverview Azure status adapter — fetches Microsoft's keyless Azure status RSS
 * feed (https://rssfeed.azure.status.microsoft/en-us/status/feed/, the feed the
 * Azure status page links) and normalizes it into the Atlassian Statuspage shapes
 * the tools consume.
 *
 * Feed notes:
 * - The channel is empty while nothing is posted. Microsoft posts here only for
 *   service issues with broad impact or ones its targeted notifications cannot
 *   reach, so a listed item is at least a degradation.
 * - An `<item>` carries `guid`, `link`, zero or more flat `<category>` elements
 *   mixing services and regions, `title`, an entity-escaped HTML `description`,
 *   and `pubDate`. There is no severity, lifecycle, or resolution field, and a
 *   resolved item simply leaves the feed.
 * - Mapping: every item is impact `minor` and status `investigating` with no
 *   resolution time; the indicator is `minor` while any item is listed and `none`
 *   otherwise. Nothing is read from the prose. The categories ride the item's
 *   single update as affected components, verbatim — the summary carries no
 *   components, since one item can name forty regions.
 * - A `guid` is a slug of the title and has been reused for separate incidents
 *   years apart, so the incident id pairs it with `pubDate`.
 * - `<link>` is not relayed: it is the generic status page, and archived captures
 *   show it pointing at an internal origin host.
 * - Parsing goes through the shared RSS extractor (`rss-extract.ts`). Every archived
 *   capture escapes item text as entities (no CDATA) and carries no attribute but
 *   `guid isPermaLink`.
 * @module services/status-adapters/azure-adapter
 */

import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import type {
  AffectedComponent,
  StatuspageIncident,
  StatuspageIncidentsResponse,
  StatuspagePage,
  StatuspageScheduledMaintenancesResponse,
  StatuspageSummaryResponse,
} from '@/services/statuspage/types.js';
import { fetchCached } from '@/utils/cached-fetch.js';
import { htmlToText } from '@/utils/html-to-text.js';
import { elementText, elementTexts, rssItems } from './rss-extract.js';

const AZURE_FEED_URL = 'https://rssfeed.azure.status.microsoft/en-us/status/feed/';

/** One feed `<item>`, its text decoded. */
export interface AzureFeedItem {
  /** Service and region names, in feed order; empty when the item has none. */
  categories: string[];
  /** Plain text of the HTML description. */
  description: string;
  guid: string;
  /** RFC 822 date as published, e.g. "Thu, 23 Jul 2026 16:29:09 Z". */
  pubDate: string;
  title: string;
}

/** Identifies the vendor the response is being normalized for. */
export interface AzureTarget {
  name: string;
  slug: string | null;
  /** Public status page URL (display only — the feed endpoint is fixed). */
  url: string;
}

// --- Extraction ---

/**
 * Extract the items from a feed body. A body with no RSS `<channel>` is some other
 * document, not this feed, and is rejected rather than read as an empty feed.
 */
export function parseAzureFeed(xml: string): AzureFeedItem[] {
  const items = rssItems(xml);
  if (items === undefined) {
    throw serviceUnavailable(
      `${AZURE_FEED_URL} returned a body with no RSS <channel> element, so it is not the Azure status feed.`,
      { reason: 'statuspage_unavailable', url: AZURE_FEED_URL },
    );
  }
  return items.map((item) => ({
    guid: elementText(item, 'guid').trim(),
    title: elementText(item, 'title').trim(),
    description: htmlToText(elementText(item, 'description')),
    pubDate: elementText(item, 'pubDate').trim(),
    categories: elementTexts(item, 'category')
      .map((c) => c.trim())
      .filter((c) => c !== ''),
  }));
}

// --- Mappings ---

function toIso(rfc822: string): string {
  const ms = Date.parse(rfc822);
  return Number.isNaN(ms) ? '' : new Date(ms).toISOString();
}

function buildPage(target: AzureTarget): StatuspagePage {
  return {
    id: target.slug ?? 'azure',
    name: target.name,
    time_zone: 'Etc/UTC',
    updated_at: '',
    url: target.url,
  };
}

/** Normalize one feed item into a Statuspage incident — see module fileoverview. */
export function mapAzureItem(item: AzureFeedItem, target: AzureTarget): StatuspageIncident {
  const published = toIso(item.pubDate);
  const id = [item.guid, published].filter((part) => part !== '').join('@') || 'unknown';
  const affected: AffectedComponent[] = item.categories.map((name) => ({
    code: name,
    name,
    new_status: '',
    old_status: '',
  }));

  return {
    id,
    name: item.title || 'Unnamed incident',
    impact: 'minor',
    status: 'investigating',
    created_at: published,
    started_at: published || null,
    resolved_at: null,
    monitoring_at: null,
    page_id: target.slug ?? 'azure',
    components: [],
    incident_updates: [
      {
        id: `${id}-0`,
        body: item.description,
        status: 'investigating',
        created_at: published,
        display_at: published,
        affected_components: affected.length > 0 ? affected : null,
      },
    ],
  };
}

/** Normalize the feed into a Statuspage summary. */
export function mapAzureSummary(
  items: AzureFeedItem[],
  target: AzureTarget,
): StatuspageSummaryResponse {
  const incidents = mapAzureIncidents(items, target).incidents;
  return {
    page: buildPage(target),
    status: {
      indicator: incidents.length === 0 ? 'none' : 'minor',
      description:
        incidents.length === 0
          ? 'All Systems Operational'
          : `${incidents.length} active incident${incidents.length === 1 ? '' : 's'} on the Azure status page`,
    },
    components: [],
    incidents,
    scheduled_maintenances: [],
  };
}

/** Normalize into the incidents-endpoint shape, newest first. */
export function mapAzureIncidents(
  items: AzureFeedItem[],
  target: AzureTarget,
): StatuspageIncidentsResponse {
  return {
    page: buildPage(target),
    incidents: items
      .map((item) => mapAzureItem(item, target))
      .sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0)),
  };
}

// --- Fetchers ---

function fetchRaw(): Promise<{ data: AzureFeedItem[]; cached: boolean }> {
  const { cacheTtlMs, fetchTimeoutMs } = getServerConfig();
  return fetchCached(AZURE_FEED_URL, cacheTtlMs, fetchTimeoutMs, async (res) =>
    parseAzureFeed(await res.text()),
  );
}

export async function fetchAzureSummary(
  target: AzureTarget,
): Promise<{ data: StatuspageSummaryResponse; cached: boolean }> {
  const { data, cached } = await fetchRaw();
  return { data: mapAzureSummary(data, target), cached };
}

export async function fetchAzureIncidents(
  target: AzureTarget,
): Promise<{ data: StatuspageIncidentsResponse; cached: boolean }> {
  const { data, cached } = await fetchRaw();
  return { data: mapAzureIncidents(data, target), cached };
}

/** The feed carries no maintenance data — always empty, no network call. */
export function fetchAzureScheduledMaintenances(
  target: AzureTarget,
): Promise<{ data: StatuspageScheduledMaintenancesResponse; cached: boolean }> {
  return Promise.resolve({
    data: { page: buildPage(target), scheduled_maintenances: [] },
    cached: false,
  });
}
