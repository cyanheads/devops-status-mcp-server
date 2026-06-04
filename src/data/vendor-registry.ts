/**
 * @fileoverview Curated vendor registry mapping slugs to Statuspage base URLs.
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

export interface VendorEntry {
  /** API type — future: 'custom' for bespoke adapters. */
  api_type: 'statuspage';
  category: VendorCategory;
  /** Display name (e.g., "GitHub", "Cloudflare"). */
  name: string;
  /** Canonical identifier used in tool inputs (e.g., "github", "cloudflare"). */
  slug: string;
  /** Statuspage base URL — typically https:// but may be http:// for some vendors (e.g., auth0). */
  statuspage_url: string;
}

/** 48-entry verified starter list. Only includes vendors with confirmed working Statuspage /api/v2/status.json endpoints. */
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
    statuspage_url: 'https://status.akamai.com',
    api_type: 'statuspage',
  },
  // dev-platform
  {
    slug: 'github',
    name: 'GitHub',
    category: 'dev-platform',
    statuspage_url: 'https://www.githubstatus.com',
    api_type: 'statuspage',
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
    name: 'Atlassian',
    category: 'dev-platform',
    statuspage_url: 'https://status.atlassian.com',
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
    // Note: status.neon.tech returned a 522 (Cloudflare timeout) during verification — may be unstable.
    statuspage_url: 'https://status.neon.tech',
    api_type: 'statuspage',
  },
  {
    slug: 'redis-cloud',
    name: 'Redis Cloud',
    category: 'data',
    statuspage_url: 'https://status.redis.io',
    api_type: 'statuspage',
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
    statuspage_url: 'https://status.slack.com',
    api_type: 'statuspage',
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
    statuspage_url: 'https://status.sendgrid.com',
    api_type: 'statuspage',
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
    // HTTP (not HTTPS) — verified endpoint.
    statuspage_url: 'http://status.auth0.com',
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
  // monitoring
  {
    slug: 'datadog',
    name: 'Datadog',
    category: 'monitoring',
    statuspage_url: 'https://status.datadoghq.com',
    api_type: 'statuspage',
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
