/**
 * @fileoverview Tests for the Azure status adapter — the RSS extractor, the item
 * mapping, and the fetchers. Fixtures are raw captures of the feed:
 * - azure-feed-20260723.xml —
 *   https://web.archive.org/web/20260723164925id_/https://rssfeed.azure.status.microsoft/en-us/status/feed/
 *   (one item, nine services plus one region, HTML description, internal `<link>` host)
 * - azure-feed-20240721.xml —
 *   https://web.archive.org/web/20240721181144id_/https://azure.status.microsoft/en-us/status/feed/
 *   (one item with no `<category>`, plain-text description)
 * - azure-feed-20220907.xml —
 *   https://web.archive.org/web/20220907194758id_/https://azurestatuscdn.azureedge.net/en-us/status/feed/
 * - azure-feed-20251029.xml —
 *   https://web.archive.org/web/20251029175916id_/https://rssfeed.azure.status.microsoft/en-us/status/feed/
 *   (the two captures reuse the guid `azure-front-door-connectivity-issues` for separate incidents)
 * - azure-feed-empty.xml — the live feed with nothing posted, captured 2026-09-25.
 * @module tests/services/status-adapters/azure-adapter.test
 */

import { readFileSync } from 'node:fs';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AzureFeedItem,
  type AzureTarget,
  fetchAzureIncidents,
  fetchAzureScheduledMaintenances,
  fetchAzureSummary,
  mapAzureIncidents,
  mapAzureItem,
  mapAzureSummary,
  parseAzureFeed,
} from '@/services/status-adapters/azure-adapter.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    cacheTtlMs: -1, // entries expire immediately — each fetch case reaches the fetch fake
    fetchTimeoutMs: 5000,
    certTimeoutMs: 5000,
    dnsTimeoutMs: 3000,
  }),
}));

const FEED_URL = 'https://rssfeed.azure.status.microsoft/en-us/status/feed/';

const AZURE: AzureTarget = {
  name: 'Microsoft Azure',
  slug: 'azure',
  url: 'https://azure.status.microsoft/en-us/status/',
};

function fixture(name: string): string {
  return readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf-8');
}

const WEST_US = () => parseAzureFeed(fixture('azure-feed-20260723.xml'));

/** A feed built around one or more `<item>` bodies, in the envelope the live feed serves. */
function feed(...items: string[]): string {
  return fixture('azure-feed-empty.xml').replace(
    '</channel>',
    `${items.map((i) => `<item>${i}</item>`).join('')}</channel>`,
  );
}

describe('parseAzureFeed', () => {
  it('extracts the populated capture: guid, trimmed title, categories, plain-text body', () => {
    const items = WEST_US();
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item!.guid).toBe('issues-connecting-to-resources-in-west-us');
    expect(item!.title).toBe('Issues connecting to resources in West US');
    expect(item!.pubDate).toBe('Thu, 23 Jul 2026 16:29:09 Z');
    expect(item!.categories).toEqual([
      'API Management',
      'Application Gateway',
      'Azure Database for PostgreSQL',
      'Azure Kubernetes Service (AKS)',
      'ExpressRoute Circuits',
      'ExpressRoute Gateways',
      'Network Infrastructure',
      'VPN Gateway',
      'Virtual WAN',
      'West US',
    ]);
    // Three <p> paragraphs, one per line, with no markup or entity left over.
    const lines = item!.description.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^We are investigating a networking issue affecting connectivity/);
    expect(lines[2]).toBe('We will provide additional information as it becomes available.');
    expect(item!.description).not.toMatch(/<p>|&lt;|&gt;|&amp;|&nbsp;/);
  });

  it('reads an item with no <category> as an empty category list', () => {
    const items = parseAzureFeed(fixture('azure-feed-20240721.xml'));
    expect(items).toHaveLength(1);
    expect(items[0]!.categories).toEqual([]);
    expect(items[0]!.title).toBe('CrowdStrike Falcon agent guidance');
    expect(items[0]!.description).toMatch(
      /^We are aware of an issue that started on 19 July 2024 at 04:09 UTC.*https:\/\/aka\.ms\/CSfalcon-VMRecoveryOptions$/,
    );
  });

  it('reads the live empty envelope as no items', () => {
    expect(parseAzureFeed(fixture('azure-feed-empty.xml'))).toEqual([]);
  });

  it('decodes escaped HTML with nested markup and non-breaking spaces to plain text', () => {
    const [item] = parseAzureFeed(fixture('azure-feed-20220907.xml'));
    expect(item!.categories).toHaveLength(35);
    expect(item!.description.split('\n')[0]).toMatch(
      /^Impact statement: Starting at 16:10 UTC on 07 Sep 2022, customers using Azure Front Door/,
    );
    expect(item!.description).toContain('customers’ ability');
    expect(item!.description).toContain('connectivity issues. These issues were caused');
    expect(item!.description).not.toMatch(/<strong>|<p>|&lt;|&nbsp;|&amp;| /);
    // Trailing &nbsp; pairs leave no trailing space.
    expect(item!.description.split('\n').every((l) => l === l.trim())).toBe(true);
  });

  it('keeps a link whose text is its URL as the URL alone', () => {
    const [item] = parseAzureFeed(fixture('azure-feed-20251029.xml'));
    expect(item!.description).toContain(
      'https://learn.microsoft.com/azure/architecture/guide/networking/global-web-applications/overview',
    );
    expect(item!.description).not.toContain('target=');
    expect(item!.description).not.toMatch(/\(https:\/\/learn\.microsoft\.com\/azure\/architecture/);
  });

  it('renders lists, labelled links, numeric references, and double escapes once', () => {
    const [item] = parseAzureFeed(
      feed(
        '<guid isPermaLink="false">0012</guid><title>R&amp;D &#8211; West&#x20;Europe </title>' +
          '<description>&lt;p&gt;Options:&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Restart the VM&lt;/li&gt;' +
          '&lt;li&gt;Use &lt;a href="https://shell.azure.com/" target="_blank"&gt;https://shell.azure.com&lt;/a&gt;&lt;/li&gt;&lt;/ul&gt;' +
          '&lt;p&gt;See &lt;a href="https://learn.microsoft.com/x?a=1&amp;amp;b=2"&gt;How to restore&lt;/a&gt;.&lt;br/&gt;Literal &amp;amp;lt;tag&amp;amp;gt; stays text.&lt;/p&gt;</description>' +
          '<pubDate>Mon, 03 Aug 2026 09:00:00 Z</pubDate>',
      ),
    );
    // A numeric-looking guid stays the string it was published as.
    expect(item!.guid).toBe('0012');
    expect(item!.title).toBe('R&D – West Europe');
    expect(item!.description).toBe(
      [
        'Options:',
        '- Restart the VM',
        '- Use https://shell.azure.com/',
        'See How to restore (https://learn.microsoft.com/x?a=1&b=2).',
        'Literal &lt;tag&gt; stays text.',
      ].join('\n'),
    );
  });

  it('leaves no tag reassembled from nested malformed markup, in the body or a link label', () => {
    const [item] = parseAzureFeed(
      feed(
        '<guid>g</guid><description>&lt;p&gt;a &lt;scr&lt;b&gt;ipt&gt;x&lt;/p&gt;' +
          '&lt;p&gt;&lt;a href="https://example.com/"&gt;see &lt;i&lt;b&gt;mg&gt;&lt;/a&gt;&lt;/p&gt;' +
          '&lt;p&gt;1 &amp;lt; 2&lt;/p&gt;</description>',
      ),
    );
    // Escaped text `<` survives; a `<` left by stripping nested tags does not.
    expect(item!.description).toBe(
      ['a script>x', 'see img> (https://example.com/)', '1 < 2'].join('\n'),
    );
  });

  it('extracts every item of a multi-item channel, attributes on any open tag', () => {
    const items = parseAzureFeed(
      feed(
        '<guid isPermaLink="false">a</guid><category domain="x">Storage</category><title>A</title><pubDate>Mon, 03 Aug 2026 09:00:00 Z</pubDate>',
        '<guid>b</guid><category>Compute</category><category> </category><category>East US</category><title>B</title>',
      ),
    );
    expect(items.map((i) => [i.guid, i.categories])).toEqual([
      ['a', ['Storage']],
      ['b', ['Compute', 'East US']],
    ]);
    expect(items[1]!.pubDate).toBe('');
    expect(items[1]!.description).toBe('');
  });

  /**
   * No archived capture uses these forms, but RSS 2.0 permits all of them, and a change of
   * feed generator would bring them in. Each must read as its text, never as markup.
   */
  describe('XML forms outside the archived captures', () => {
    it('reads CDATA sections verbatim, with no entity decoding inside them', () => {
      const [item] = parseAzureFeed(
        feed(
          '<guid><![CDATA[cdata-guid]]></guid><title><![CDATA[West & East <US> ]]></title>' +
            '<description><![CDATA[<p>Hello &amp; bye</p><p>Two</p>]]></description>' +
            '<category><![CDATA[Storage]]></category><pubDate>Mon, 03 Aug 2026 09:00:00 Z</pubDate>',
        ),
      );
      expect(item).toEqual({
        guid: 'cdata-guid',
        title: 'West & East <US>',
        // CDATA carries the HTML as written; the HTML's own entities decode as HTML.
        description: 'Hello & bye\nTwo',
        pubDate: 'Mon, 03 Aug 2026 09:00:00 Z',
        categories: ['Storage'],
      });
    });

    it('ignores comments — an item inside one, and one inside a title', () => {
      const items = parseAzureFeed(
        feed('<guid>real</guid><title>Real<!-- draft title --> item</title>').replace(
          '<item>',
          '<!-- <item><guid>fake</guid><title>Fake</title></item> --><item>',
        ),
      );
      expect(items.map((i) => [i.guid, i.title])).toEqual([['real', 'Real item']]);
    });

    it('rejects a body whose only <channel> is inside a comment', () => {
      expect(() => parseAzureFeed('<rss><!-- <channel></channel> --></rss>')).toThrow(McpError);
    });

    it('reads a self-closing element as empty without swallowing the next one', () => {
      const [item] = parseAzureFeed(
        feed('<guid>g</guid><category /><category/><category>West US</category><title>T</title>'),
      );
      expect(item!.categories).toEqual(['West US']);
    });

    it('reads a CDATA section as text, so tag names inside it never shadow the real elements', () => {
      const [item] = parseAzureFeed(
        feed(
          '<description><![CDATA[<p>Before</p><title>inner</title><category>fake</category><!-- kept -->]]></description>' +
            '<guid>g</guid><title>Real</title><category>Storage</category>',
        ),
      );
      expect(item!.title).toBe('Real');
      expect(item!.categories).toEqual(['Storage']);
      // Inside the description they are HTML, rendered as text like any other unknown tag.
      expect(item!.description).toBe('Before\ninnerfake');
    });

    it('reads a CDATA title containing comment markup verbatim', () => {
      const [item] = parseAzureFeed(
        feed('<guid>g</guid><title><![CDATA[a <!-- b --> c]]></title>'),
      );
      expect(item!.title).toBe('a <!-- b --> c');
    });

    it('accepts whitespace before the > of an end tag', () => {
      const items = parseAzureFeed(
        feed('<guid>g</guid><title>T</title >').replace('</item>', '</item\n>'),
      );
      expect(items.map((i) => [i.guid, i.title])).toEqual([['g', 'T']]);
    });

    it('leaves a reference to an inherited object property as the text it is', () => {
      const [item] = parseAzureFeed(
        feed(
          '<guid>g</guid><title>A &constructor; B</title>' +
            '<description>&lt;p&gt;x &amp;constructor; y&lt;/p&gt;</description>',
        ),
      );
      expect(item!.title).toBe('A &constructor; B');
      expect(item!.description).toBe('x &constructor; y');
    });

    it('stays linear on an unclosed comment, unterminated list tags, and a run of bare <', () => {
      const bodies = [
        `<rss><channel>${'<!--'.repeat(40_000)}</channel></rss>`,
        feed(`<guid>g</guid><description>${'&lt;li '.repeat(40_000)}</description>`),
        feed(`<guid>g</guid><description>${'&lt;'.repeat(80_000)}</description>`),
      ];
      for (const body of bodies) {
        const started = performance.now();
        try {
          parseAzureFeed(body);
        } catch {
          // A body left with no channel is rejected; only the time matters here.
        }
        expect(performance.now() - started).toBeLessThan(1_000);
      }
    });

    it('stays linear on malformed markup: unclosed items and unterminated link tags', () => {
      const unclosed = feed().replace('</channel>', `${'<item>'.repeat(40_000)}</channel>`);
      const links = feed(
        `<guid>g</guid><description>${'&lt;a href="x" '.repeat(3_000)}</description>`,
      );
      for (const body of [unclosed, links]) {
        const started = performance.now();
        parseAzureFeed(body);
        expect(performance.now() - started).toBeLessThan(1_000);
      }
    });
  });

  it.each([
    ['an HTML error page', '<!DOCTYPE html><html><body><h1>Service Unavailable</h1></body></html>'],
    ['a JSON body', '{"error":"not found"}'],
    ['a truncated feed', '<?xml version="1.0"?><rss version="2.0"><channel><title>Azure Status'],
    ['an empty body', ''],
  ])('rejects %s with no RSS <channel> as ServiceUnavailable', (_label, body) => {
    expect(() => parseAzureFeed(body)).toThrow(
      expect.objectContaining({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: expect.objectContaining({ reason: 'statuspage_unavailable', url: FEED_URL }),
      }),
    );
    expect(() => parseAzureFeed(body)).toThrow(McpError);
  });
});

describe('mapAzureItem', () => {
  it('maps a listed item to an open minor incident, categories as its affected components', () => {
    const inc = mapAzureItem(WEST_US()[0]!, AZURE);
    expect(inc).toMatchObject({
      id: 'issues-connecting-to-resources-in-west-us@2026-07-23T16:29:09.000Z',
      name: 'Issues connecting to resources in West US',
      impact: 'minor',
      status: 'investigating',
      created_at: '2026-07-23T16:29:09.000Z',
      started_at: '2026-07-23T16:29:09.000Z',
      resolved_at: null,
      page_id: 'azure',
      components: [],
    });
    expect(inc.incident_updates).toHaveLength(1);
    expect(inc.incident_updates[0]!.status).toBe('investigating');
    expect(inc.incident_updates[0]!.affected_components?.map((c) => c.name)).toHaveLength(10);
    expect(inc.incident_updates[0]!.affected_components?.at(-1)).toEqual({
      code: 'West US',
      name: 'West US',
      new_status: '',
      old_status: '',
    });
  });

  it('never relays <link> — the capture points it at an internal origin host', () => {
    const inc = mapAzureItem(WEST_US()[0]!, AZURE);
    expect(inc.shortlink).toBeUndefined();
    expect(JSON.stringify(inc)).not.toContain('azurewebsites.net');
  });

  it('carries no affected components for an item with no <category>', () => {
    const [item] = parseAzureFeed(fixture('azure-feed-20240721.xml'));
    const inc = mapAzureItem(item!, AZURE);
    expect(inc.incident_updates[0]!.affected_components).toBeNull();
    expect(inc.started_at).toBe('2024-07-20T12:59:45.000Z');
  });

  it('keeps a reused guid apart by pairing it with pubDate', () => {
    const [first] = parseAzureFeed(fixture('azure-feed-20220907.xml'));
    const [second] = parseAzureFeed(fixture('azure-feed-20251029.xml'));
    expect(first!.guid).toBe(second!.guid);
    const ids = [mapAzureItem(first!, AZURE).id, mapAzureItem(second!, AZURE).id];
    expect(ids).toEqual([
      'azure-front-door-connectivity-issues@2022-09-07T16:10:40.000Z',
      'azure-front-door-connectivity-issues@2025-10-29T16:00:00.000Z',
    ]);
  });

  it('does not crash on a sparse item with omitted fields', () => {
    const sparse: AzureFeedItem = {
      guid: '',
      title: '',
      description: '',
      pubDate: 'not a date',
      categories: [],
    };
    const inc = mapAzureItem(sparse, AZURE);
    expect(inc.id).toBe('unknown');
    expect(inc.name).toBe('Unnamed incident');
    expect(inc.created_at).toBe('');
    expect(inc.started_at).toBeNull();
    expect(inc.incident_updates[0]!.body).toBe('');
  });
});

describe('mapAzureSummary / mapAzureIncidents', () => {
  it('reads a populated feed as indicator minor, one incident, no components', () => {
    const summary = mapAzureSummary(WEST_US(), AZURE);
    expect(summary.status).toEqual({
      indicator: 'minor',
      description: '1 active incident on the Azure status page',
    });
    expect(summary.components).toEqual([]);
    expect(summary.incidents).toHaveLength(1);
    expect(summary.scheduled_maintenances).toEqual([]);
    expect(summary.page).toMatchObject({ name: 'Microsoft Azure', url: AZURE.url });
  });

  it('reads the empty feed as indicator none with no incidents', () => {
    const summary = mapAzureSummary(parseAzureFeed(fixture('azure-feed-empty.xml')), AZURE);
    expect(summary.status).toEqual({ indicator: 'none', description: 'All Systems Operational' });
    expect(summary.incidents).toEqual([]);
  });

  it('stays minor for several items and lists them newest first', () => {
    const items = [
      ...parseAzureFeed(fixture('azure-feed-20220907.xml')),
      ...WEST_US(),
      ...parseAzureFeed(fixture('azure-feed-20240721.xml')),
    ];
    const summary = mapAzureSummary(items, AZURE);
    expect(summary.status).toEqual({
      indicator: 'minor',
      description: '3 active incidents on the Azure status page',
    });
    expect(mapAzureIncidents(items, AZURE).incidents.map((i) => i.created_at)).toEqual([
      '2026-07-23T16:29:09.000Z',
      '2024-07-20T12:59:45.000Z',
      '2022-09-07T16:10:40.000Z',
    ]);
  });
});

describe('fetchers', () => {
  const http = createFetchMock();

  beforeEach(() => {
    http.reset();
    http.install();
  });

  afterEach(() => {
    http.restore();
  });

  it('fetchAzureSummary reads the RSS feed the status page links', async () => {
    http.route({
      match: FEED_URL,
      respond: () =>
        new Response(fixture('azure-feed-20260723.xml'), {
          headers: { 'content-type': 'text/xml; charset=utf-8' },
        }),
    });
    const { data } = await fetchAzureSummary(AZURE);
    expect(data.status.indicator).toBe('minor');
    expect(http.calls.map((c) => c.request.url)).toEqual([FEED_URL]);
  });

  it('fetchAzureIncidents maps every listed item', async () => {
    http.route({
      match: FEED_URL,
      respond: () => new Response(fixture('azure-feed-20240721.xml')),
    });
    const { data } = await fetchAzureIncidents(AZURE);
    expect(data.incidents.map((i) => i.name)).toEqual(['CrowdStrike Falcon agent guidance']);
  });

  it('a 200 that is not the feed throws ServiceUnavailable, never an empty result', async () => {
    http.route({
      match: FEED_URL,
      respond: () => new Response('<html><body>maintenance</body></html>'),
    });
    const err = await fetchAzureSummary(AZURE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect((err as McpError).data).toMatchObject({ reason: 'statuspage_unavailable' });
    expect((err as McpError).message).toContain('<channel>');
  });

  it('a non-2xx from the feed throws ServiceUnavailable', async () => {
    http.route({ match: FEED_URL, respond: () => new Response(null, { status: 503 }) });
    const err = await fetchAzureIncidents(AZURE).catch((e: unknown) => e);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect((err as McpError).message).toContain('HTTP 503');
  });

  it('fetchAzureScheduledMaintenances returns empty without a network call', async () => {
    const { data } = await fetchAzureScheduledMaintenances(AZURE);
    expect(data.scheduled_maintenances).toEqual([]);
    expect(http.calls).toHaveLength(0);
  });
});
