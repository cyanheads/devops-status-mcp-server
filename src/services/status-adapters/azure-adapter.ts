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
 * - Parsing is a narrow extractor rather than an XML library. Every archived
 *   capture escapes item text as entities (no CDATA) and carries no attribute but
 *   `guid isPermaLink`; a general parser returns a lone item as a scalar, coerces a
 *   numeric-looking `guid`, and still leaves the escaped HTML to decode by hand. The
 *   extractor still reads the other forms RSS 2.0 allows — CDATA sections, comments,
 *   attributes, self-closing elements, whitespace inside end tags — rather than
 *   misreading them as text or markup.
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

/** A Map, not an object literal, so `&constructor;` cannot resolve through Object.prototype. */
const XML_ENTITIES = new Map([
  ['lt', '<'],
  ['gt', '>'],
  ['amp', '&'],
  ['quot', '"'],
  ['apos', "'"],
]);

/** HTML adds `nbsp`, the only named entity beyond XML's five seen in item text. */
const HTML_ENTITIES = new Map([...XML_ENTITIES, ['nbsp', ' ']]);

/** The text one character reference (`ref` is what sits between `&` and `;`) stands for. */
function decodeReference(match: string, ref: string, named: Map<string, string>): string {
  if (ref[0] === '#') {
    const code =
      ref[1] === 'x' || ref[1] === 'X' ? Number.parseInt(ref.slice(2), 16) : Number(ref.slice(1));
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : match;
  }
  return named.get(ref.toLowerCase()) ?? match;
}

/**
 * Decode named and numeric character references in one pass, so an escaped
 * reference (`&amp;lt;`) decodes once, to `&lt;`, never on to `<`.
 */
function decodeEntities(text: string, named: Map<string, string>): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, ref: string) =>
    decodeReference(match, ref, named),
  );
}

const escapeText = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/**
 * Drop comments and rewrite each CDATA section as the same text escaped, so the element
 * scan below sees only elements and character references. Whichever opens first wins, as
 * in XML itself: a comment inside a CDATA section is text, and a CDATA section inside a
 * comment is gone. Each terminator is found with indexOf, so the work stays linear; an
 * unterminated one runs to the end of the body, which leaves the document malformed.
 */
function flattenMarkup(xml: string): string {
  const opener = /<!--|<!\[CDATA\[/g;
  let out = '';
  let from = 0;
  for (let m = opener.exec(xml); m; m = opener.exec(xml)) {
    const comment = m[0] === '<!--';
    const start = m.index + m[0].length;
    const end = xml.indexOf(comment ? '-->' : ']]>', start);
    out += xml.slice(from, m.index);
    if (end === -1) return out;
    if (!comment) out += escapeText(xml.slice(start, end));
    from = end + 3;
    opener.lastIndex = from;
  }
  return out + xml.slice(from);
}

/**
 * Raw inner markup of every `<tag …>…</tag>` in `xml`, in order. Open tags may carry
 * attributes; a self-closing `<tag/>` has no body and is skipped. Each close is found
 * by a forward search and the scan resumes past it, so the work stays linear in the
 * body — an element with no close ends the scan, since no later one could close either.
 */
function elementBodies(xml: string, tag: string): string[] {
  const open = new RegExp(`<${tag}(?:\\s[^<>]*)?(?<!/)>`, 'g');
  const close = new RegExp(`</${tag}\\s*>`, 'g');
  const bodies: string[] = [];
  while (open.exec(xml)) {
    close.lastIndex = open.lastIndex;
    const end = close.exec(xml);
    if (end === null) break;
    bodies.push(xml.slice(open.lastIndex, end.index));
    open.lastIndex = close.lastIndex;
  }
  return bodies;
}

/** Character data of every `<tag>` element, its character references decoded. */
function elementTexts(xml: string, tag: string): string[] {
  return elementBodies(xml, tag).map((body) => decodeEntities(body, XML_ENTITIES));
}

function elementText(xml: string, tag: string): string {
  return elementTexts(xml, tag)[0] ?? '';
}

/** Collapse whitespace within each line and drop the blank lines left by removed markup. */
function tidyLines(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * Drop every tag. Text `<` arrives escaped as `&lt;`, so a `<` still left once the
 * tags are gone belongs to malformed markup and goes too — a nested fragment such as
 * `<scr<b>ipt>` cannot reassemble into a tag.
 */
function stripTags(html: string): string {
  return html.replace(/<[^<>]*>/g, '').replace(/</g, '');
}

/**
 * Render the description's HTML as plain text: paragraphs and list items on their
 * own lines, a link as its text with the URL after it when the two differ, every
 * other tag dropped, and HTML entities decoded.
 */
function htmlToText(html: string): string {
  const markup = html
    /**
     * The attributes and the label are each matched by one unambiguous run — the label
     * stops at the next anchor tag — so malformed markup cannot make the match backtrack.
     */
    .replace(
      /<a\s([^<>]*)>([^<]*(?:<(?!\/?a[\s>])[^<]*)*)<\/a>/gi,
      (_match, attributes: string, label: string) => {
        const href = /\bhref="([^"]*)"/i.exec(attributes)?.[1];
        if (href === undefined) return label;
        const shown = stripTags(label).trim();
        return shown.replace(/\/$/, '') === href.replace(/\/$/, '') || shown === ''
          ? href
          : `${shown} (${href})`;
      },
    )
    // Tag runs stop at the next `<`, so an unterminated tag fails at once, not at the end.
    .replace(/<li(?:\s[^<>]*)?>/gi, '\n- ')
    .replace(/<br\s*\/?>|<\/(?:p|div|li|ul|ol|h[1-6])>/gi, '\n');
  return tidyLines(decodeEntities(stripTags(markup), HTML_ENTITIES));
}

/**
 * Extract the items from a feed body. A body with no RSS `<channel>` is some other
 * document, not this feed, and is rejected rather than read as an empty feed.
 */
export function parseAzureFeed(xml: string): AzureFeedItem[] {
  const channel = elementBodies(flattenMarkup(xml), 'channel')[0];
  if (channel === undefined) {
    throw serviceUnavailable(
      `${AZURE_FEED_URL} returned a body with no RSS <channel> element, so it is not the Azure status feed.`,
      { reason: 'statuspage_unavailable', url: AZURE_FEED_URL },
    );
  }
  return elementBodies(channel, 'item').map((item) => ({
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
