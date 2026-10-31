/**
 * @fileoverview Curated vendor registry mapping slugs to status-API endpoints.
 * @module data/vendor-registry
 */

export type VendorCategory =
  | 'cloud'
  | 'cdn-edge'
  | 'dev-platform'
  | 'data'
  | 'comms'
  | 'auth'
  | 'monitoring'
  | 'ai';

/** Status backend the vendor's page runs on — selects the adapter in src/services/status-adapters/. */
export type VendorApiType =
  | 'statuspage'
  | 'statusio'
  | 'slack'
  | 'aws'
  | 'gcp'
  | 'azure'
  | 'azure-devops'
  | 'firehydrant'
  | 'datadog';

interface VendorEntryBase {
  category: VendorCategory;
  /**
   * Set when the vendor publishes on a status page it shares with other products: only
   * components whose name, or whose group's name, starts with this prefix belong to it,
   * and the entry reports those components and the records that touch them.
   */
  component_scope_prefix?: string;
  /** Display name (e.g., "GitHub", "Cloudflare"). */
  name: string;
  /**
   * Set on an entry that reads an umbrella page publishing no components and only
   * cross-product incidents: the slugs of the entries that read its products' own pages.
   * The status tools name them in `notice` wherever the entry is served.
   */
  product_slugs?: readonly string[];
  /** Canonical identifier used in tool inputs (e.g., "github", "cloudflare"). */
  slug: string;
  /**
   * Status page base URL. For api_type 'statuspage' this is the Atlassian Statuspage
   * API base (/api/v2/*.json is appended); for other backends it is the vendor's
   * public status page URL — the adapter owns the actual API endpoint.
   */
  statuspage_url: string;
}

export type VendorEntry =
  | (VendorEntryBase & { api_type: Exclude<VendorApiType, 'statusio'> })
  | (VendorEntryBase & {
      api_type: 'statusio';
      /** Status.io page ID — keys https://status-api.hostedstatus.com/1.0/status/{id}. */
      statusio_page_id: string;
    });

/**
 * 71-entry curated list. Most entries are verified Atlassian Statuspage endpoints;
 * every other api_type is served through a native-API adapter
 * (src/services/status-adapters/) that normalizes into the Statuspage shapes.
 * Probe every entry for drift with `bun run verify:registry`.
 */
export const VENDOR_REGISTRY: readonly VendorEntry[] = [
  // cloud
  {
    slug: 'digitalocean',
    name: 'DigitalOcean',
    category: 'cloud',
    statuspage_url: 'https://status.digitalocean.com',
    api_type: 'statuspage',
  },
  {
    slug: 'linode',
    name: 'Linode / Akamai Cloud',
    category: 'cloud',
    statuspage_url: 'https://status.linode.com',
    api_type: 'statuspage',
  },
  {
    slug: 'aws',
    name: 'Amazon Web Services',
    category: 'cloud',
    // Public AWS Health Dashboard — adapter fetches /public/currentevents (UTF-16 feed).
    statuspage_url: 'https://health.aws.amazon.com',
    api_type: 'aws',
  },
  {
    slug: 'gcp',
    name: 'Google Cloud',
    category: 'cloud',
    // Google Cloud Service Health — adapter fetches /incidents.json (bare incident array).
    statuspage_url: 'https://status.cloud.google.com',
    api_type: 'gcp',
  },
  {
    slug: 'azure',
    name: 'Microsoft Azure',
    category: 'cloud',
    // Azure status page — adapter fetches its RSS feed at rssfeed.azure.status.microsoft.
    statuspage_url: 'https://azure.status.microsoft/en-us/status/',
    api_type: 'azure',
  },
  // cdn-edge
  {
    slug: 'cloudflare',
    name: 'Cloudflare',
    category: 'cdn-edge',
    statuspage_url: 'https://www.cloudflarestatus.com',
    api_type: 'statuspage',
  },
  {
    slug: 'akamai',
    name: 'Akamai',
    category: 'cdn-edge',
    // status.akamai.com 302s here and the redirect drops the query string.
    statuspage_url: 'https://www.akamaistatus.com',
    api_type: 'statuspage',
  },
  // dev-platform
  {
    slug: 'gitlab',
    name: 'GitLab',
    category: 'dev-platform',
    statuspage_url: 'https://status.gitlab.com',
    api_type: 'statusio',
    statusio_page_id: '5b36dc6502d06804c08349f7',
  },
  {
    slug: 'github',
    name: 'GitHub',
    category: 'dev-platform',
    statuspage_url: 'https://www.githubstatus.com',
    api_type: 'statuspage',
  },
  {
    slug: 'azure-devops',
    name: 'Azure DevOps',
    category: 'dev-platform',
    // Separate portal from the azure entry — adapter reads its Health REST API and _rss feed.
    statuspage_url: 'https://status.dev.azure.com',
    api_type: 'azure-devops',
  },
  {
    slug: 'npm',
    name: 'npm',
    category: 'dev-platform',
    statuspage_url: 'https://status.npmjs.org',
    api_type: 'statuspage',
  },
  {
    slug: 'vercel',
    name: 'Vercel',
    category: 'dev-platform',
    statuspage_url: 'https://www.vercel-status.com',
    api_type: 'statuspage',
  },
  {
    slug: 'netlify',
    name: 'Netlify',
    category: 'dev-platform',
    statuspage_url: 'https://www.netlifystatus.com',
    api_type: 'statuspage',
  },
  {
    slug: 'render',
    name: 'Render',
    category: 'dev-platform',
    statuspage_url: 'https://status.render.com',
    api_type: 'statuspage',
  },
  {
    slug: 'fly-io',
    name: 'Fly.io',
    category: 'dev-platform',
    statuspage_url: 'https://status.flyio.net',
    api_type: 'statuspage',
  },
  {
    slug: 'circleci',
    name: 'CircleCI',
    category: 'dev-platform',
    statuspage_url: 'https://status.circleci.com',
    api_type: 'statuspage',
  },
  {
    slug: 'travis-ci',
    name: 'Travis CI',
    category: 'dev-platform',
    statuspage_url: 'https://www.traviscistatus.com',
    api_type: 'statuspage',
  },
  {
    slug: 'snyk',
    name: 'Snyk',
    category: 'dev-platform',
    statuspage_url: 'https://status.snyk.io',
    api_type: 'statuspage',
  },
  {
    slug: 'atlassian',
    name: 'Atlassian (cross-product incidents)',
    category: 'dev-platform',
    // Umbrella page: no components, and only incidents posted across products. Product
    // outages are posted on each product's own page, read by the entries listed here.
    statuspage_url: 'https://status.atlassian.com',
    api_type: 'statuspage',
    product_slugs: [
      'jira',
      'confluence',
      'bitbucket',
      'jira-service-management',
      'atlassian-compass',
      'atlassian-developer',
      'trello',
      'opsgenie',
      'atlassian-statuspage',
      'atlassian-guard',
    ],
  },
  {
    slug: 'jira',
    name: 'Atlassian Jira',
    category: 'dev-platform',
    statuspage_url: 'https://jira-software.status.atlassian.com',
    api_type: 'statuspage',
  },
  {
    slug: 'confluence',
    name: 'Atlassian Confluence',
    category: 'dev-platform',
    statuspage_url: 'https://confluence.status.atlassian.com',
    api_type: 'statuspage',
  },
  {
    slug: 'bitbucket',
    name: 'Atlassian Bitbucket',
    category: 'dev-platform',
    // status.bitbucket.org 302s here.
    statuspage_url: 'https://bitbucket.status.atlassian.com',
    api_type: 'statuspage',
  },
  {
    slug: 'jira-service-management',
    name: 'Atlassian Jira Service Management',
    category: 'dev-platform',
    statuspage_url: 'https://jira-service-management.status.atlassian.com',
    api_type: 'statuspage',
  },
  {
    slug: 'atlassian-compass',
    name: 'Atlassian Compass',
    category: 'dev-platform',
    statuspage_url: 'https://compass.status.atlassian.com',
    api_type: 'statuspage',
  },
  {
    slug: 'atlassian-developer',
    name: 'Atlassian Developer',
    category: 'dev-platform',
    // The Forge and Connect app platform; status.developer.atlassian.com 302s here.
    statuspage_url: 'https://developer.status.atlassian.com',
    api_type: 'statuspage',
  },
  {
    slug: 'trello',
    name: 'Atlassian Trello',
    category: 'dev-platform',
    // www.trellostatus.com 302s here.
    statuspage_url: 'https://trello.status.atlassian.com',
    api_type: 'statuspage',
  },
  {
    slug: 'figma',
    name: 'Figma',
    category: 'dev-platform',
    statuspage_url: 'https://status.figma.com',
    api_type: 'statuspage',
  },
  {
    slug: 'launchdarkly',
    name: 'LaunchDarkly',
    category: 'dev-platform',
    statuspage_url: 'https://status.launchdarkly.com',
    api_type: 'statuspage',
  },
  // data
  {
    slug: 'mongodb-atlas',
    name: 'MongoDB Atlas',
    category: 'data',
    statuspage_url: 'https://status.mongodb.com',
    api_type: 'statuspage',
  },
  {
    slug: 'planetscale',
    name: 'PlanetScale',
    category: 'data',
    statuspage_url: 'https://www.planetscalestatus.com',
    api_type: 'statuspage',
  },
  {
    slug: 'supabase',
    name: 'Supabase',
    category: 'data',
    statuspage_url: 'https://status.supabase.com',
    api_type: 'statuspage',
  },
  {
    slug: 'neon',
    name: 'Neon',
    category: 'data',
    // neonstatus.com is a Status.io page (the former status.neon.tech Statuspage is gone).
    statuspage_url: 'https://neonstatus.com',
    api_type: 'statusio',
    statusio_page_id: '6878fc85709daa75be6c7e3c',
  },
  {
    slug: 'redis-cloud',
    name: 'Redis Cloud',
    category: 'data',
    // The page moved from Atlassian Statuspage to Firehydrant; the adapter fetches /data/payload.json.
    statuspage_url: 'https://status.redis.io',
    api_type: 'firehydrant',
  },
  {
    slug: 'elastic',
    name: 'Elastic Cloud',
    category: 'data',
    statuspage_url: 'https://status.elastic.co',
    api_type: 'statuspage',
  },
  {
    slug: 'influxdb',
    name: 'InfluxDB Cloud',
    category: 'data',
    statuspage_url: 'https://status.influxdata.com',
    api_type: 'statuspage',
  },
  {
    slug: 'upstash',
    name: 'Upstash',
    category: 'data',
    statuspage_url: 'https://status.upstash.com',
    api_type: 'statuspage',
  },
  {
    slug: 'cloudinary',
    name: 'Cloudinary',
    category: 'data',
    statuspage_url: 'https://status.cloudinary.com',
    api_type: 'statuspage',
  },
  {
    slug: 'segment',
    name: 'Segment',
    category: 'data',
    statuspage_url: 'https://status.segment.com',
    api_type: 'statuspage',
  },
  // comms
  {
    slug: 'slack',
    name: 'Slack',
    category: 'comms',
    // Slack's own status API (/api/v2.0.0/*) — requests 301 to slack-status.com; the adapter follows redirects.
    statuspage_url: 'https://status.slack.com',
    api_type: 'slack',
  },
  {
    slug: 'discord',
    name: 'Discord',
    category: 'comms',
    statuspage_url: 'https://discordstatus.com',
    api_type: 'statuspage',
  },
  {
    slug: 'twilio',
    name: 'Twilio',
    category: 'comms',
    statuspage_url: 'https://status.twilio.com',
    api_type: 'statuspage',
  },
  {
    slug: 'sendgrid',
    name: 'SendGrid',
    category: 'comms',
    // status.sendgrid.com redirects here; SendGrid is the SendGrid-named components and
    // groups on Twilio's page.
    statuspage_url: 'https://status.twilio.com',
    api_type: 'statuspage',
    component_scope_prefix: 'SendGrid',
  },
  {
    slug: 'mailgun',
    name: 'Mailgun',
    category: 'comms',
    statuspage_url: 'https://status.mailgun.com',
    api_type: 'statuspage',
  },
  {
    slug: 'hubspot',
    name: 'HubSpot',
    category: 'comms',
    statuspage_url: 'https://status.hubspot.com',
    api_type: 'statuspage',
  },
  {
    slug: 'brevo',
    name: 'Brevo (Sendinblue)',
    category: 'comms',
    statuspage_url: 'https://status.brevo.com',
    api_type: 'statuspage',
  },
  {
    slug: 'courier',
    name: 'Courier',
    category: 'comms',
    statuspage_url: 'https://status.courier.com',
    api_type: 'statuspage',
  },
  {
    slug: 'loops',
    name: 'Loops',
    category: 'comms',
    statuspage_url: 'https://status.loops.so',
    api_type: 'statuspage',
  },
  // auth
  {
    slug: 'auth0',
    name: 'Auth0',
    category: 'auth',
    // status.auth0.com is now a custom page; the live Statuspage moved to auth0.statuspage.io.
    statuspage_url: 'https://auth0.statuspage.io',
    api_type: 'statuspage',
  },
  {
    slug: 'clerk',
    name: 'Clerk',
    category: 'auth',
    statuspage_url: 'https://status.clerk.com',
    api_type: 'statuspage',
  },
  {
    slug: 'workos',
    name: 'WorkOS',
    category: 'auth',
    statuspage_url: 'https://status.workos.com',
    api_type: 'statuspage',
  },
  {
    slug: 'atlassian-guard',
    name: 'Atlassian Guard',
    category: 'auth',
    // SSO and identity in front of the Atlassian cloud products.
    statuspage_url: 'https://guard.status.atlassian.com',
    api_type: 'statuspage',
  },
  // monitoring
  {
    slug: 'datadog',
    name: 'Datadog US1',
    category: 'monitoring',
    // Datadog runs one status page per site, off Atlassian Statuspage; the adapter fetches
    // {page}/config.json. The datadog-* entries below read the other sites' pages.
    statuspage_url: 'https://status.datadoghq.com',
    api_type: 'datadog',
  },
  {
    slug: 'datadog-us3',
    name: 'Datadog US3',
    category: 'monitoring',
    statuspage_url: 'https://status.us3.datadoghq.com',
    api_type: 'datadog',
  },
  {
    slug: 'datadog-us5',
    name: 'Datadog US5',
    category: 'monitoring',
    statuspage_url: 'https://status.us5.datadoghq.com',
    api_type: 'datadog',
  },
  {
    slug: 'datadog-eu1',
    name: 'Datadog EU1',
    category: 'monitoring',
    statuspage_url: 'https://status.datadoghq.eu',
    api_type: 'datadog',
  },
  {
    slug: 'datadog-uk1',
    name: 'Datadog UK1',
    category: 'monitoring',
    statuspage_url: 'https://status.uk1.datadoghq.com',
    api_type: 'datadog',
  },
  {
    slug: 'datadog-ap1',
    name: 'Datadog AP1',
    category: 'monitoring',
    statuspage_url: 'https://status.ap1.datadoghq.com',
    api_type: 'datadog',
  },
  {
    slug: 'datadog-ap2',
    name: 'Datadog AP2',
    category: 'monitoring',
    statuspage_url: 'https://status.ap2.datadoghq.com',
    api_type: 'datadog',
  },
  {
    slug: 'datadog-us1-fed',
    name: 'Datadog US1-FED',
    category: 'monitoring',
    statuspage_url: 'https://status.ddog-gov.com',
    api_type: 'datadog',
  },
  {
    slug: 'datadog-us2-fed',
    name: 'Datadog US2-FED',
    category: 'monitoring',
    statuspage_url: 'https://status.us2.ddog-gov.com',
    api_type: 'datadog',
  },
  {
    slug: 'sentry',
    name: 'Sentry',
    category: 'monitoring',
    statuspage_url: 'https://status.sentry.io',
    api_type: 'statuspage',
  },
  {
    slug: 'new-relic',
    name: 'New Relic',
    category: 'monitoring',
    statuspage_url: 'https://status.newrelic.com',
    api_type: 'statuspage',
  },
  {
    slug: 'grafana-cloud',
    name: 'Grafana Cloud',
    category: 'monitoring',
    statuspage_url: 'https://status.grafana.com',
    api_type: 'statuspage',
  },
  {
    slug: 'honeycomb',
    name: 'Honeycomb',
    category: 'monitoring',
    statuspage_url: 'https://status.honeycomb.io',
    api_type: 'statuspage',
  },
  {
    slug: 'opsgenie',
    name: 'Atlassian Opsgenie',
    category: 'monitoring',
    // status.opsgenie.com 302s here.
    statuspage_url: 'https://opsgenie.status.atlassian.com',
    api_type: 'statuspage',
  },
  {
    slug: 'atlassian-statuspage',
    name: 'Atlassian Statuspage',
    category: 'monitoring',
    // Statuspage's own status page — the backend most entries in this registry run on.
    statuspage_url: 'https://metastatuspage.com',
    api_type: 'statuspage',
  },
  // ai
  {
    slug: 'openai',
    name: 'OpenAI',
    category: 'ai',
    statuspage_url: 'https://status.openai.com',
    api_type: 'statuspage',
  },
  {
    slug: 'anthropic',
    name: 'Anthropic / Claude',
    category: 'ai',
    // Branded as "Claude"; status.anthropic.com redirects here.
    statuspage_url: 'https://status.claude.com',
    api_type: 'statuspage',
  },
  {
    slug: 'elevenlabs',
    name: 'ElevenLabs',
    category: 'ai',
    statuspage_url: 'https://status.elevenlabs.io',
    api_type: 'statuspage',
  },
  {
    slug: 'pinecone',
    name: 'Pinecone',
    category: 'ai',
    statuspage_url: 'https://status.pinecone.io',
    api_type: 'statuspage',
  },
  {
    slug: 'cohere',
    name: 'Cohere',
    category: 'ai',
    statuspage_url: 'https://status.cohere.com',
    api_type: 'statuspage',
  },
] as const;
