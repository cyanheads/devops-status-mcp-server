/**
 * @fileoverview Tests for the shared cached fetch helper — per-hop redirect
 * re-validation against the SSRF guard, transport failures mapped onto the
 * statuspage_unavailable contract, the cache's key normalization and byte bounds,
 * and the upstream body read limit.
 * @module tests/utils/cached-fetch.test
 */

import { lookup } from 'node:dns/promises';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearFetchCache,
  FETCH_CACHE_BUDGET_BYTES,
  FETCH_CACHE_MAX_ENTRY_BYTES,
  fetchCached,
  fetchCacheStats,
  MAX_RESPONSE_BODY_BYTES,
} from '@/utils/cached-fetch.js';
import { assertSafeUrl } from '@/utils/ssrf-guard.js';

/** A JSON read through the cache, the way the status adapters perform one. */
const fetchJsonCached = <T>(url: string, ttlMs: number, timeoutMs: number) =>
  fetchCached<T>(url, ttlMs, timeoutMs, (res) => res.json() as Promise<T>);

/**
 * The guard itself is covered in ssrf-guard.test.ts. Mocking it here keeps these
 * tests offline and — more to the point — lets each case assert *which* URL the
 * hop check was handed, which is the whole behavior under test. The sentinel
 * stripping stays real, since the redirect error text depends on it.
 */
vi.mock('@/utils/ssrf-guard.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/ssrf-guard.js')>()),
  assertSafeUrl: vi.fn(),
  assertSafeDomain: vi.fn(),
  assertSafeResolverIp: vi.fn(),
}));

/** The resolver answer the real guard reads, for the cases that run it on a hop. */
vi.mock('node:dns/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:dns/promises')>()),
  lookup: vi.fn(),
}));

const mockAssertSafeUrl = vi.mocked(assertSafeUrl);
const mockLookup = vi.mocked(lookup);

/** Each test uses a unique URL so the shared module-level cache never collides. */
let urlCounter = 0;
function freshUrl(): string {
  return `https://vendor-${++urlCounter}.example.com/api/v2/summary.json`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
  } as unknown as Response;
}

function redirectResponse(location: string | null, status = 302): Response {
  return {
    ok: false,
    status,
    headers: new Headers(location === null ? {} : { location }),
    json: async () => ({}),
  } as unknown as Response;
}

beforeEach(() => {
  mockAssertSafeUrl.mockReset();
  mockAssertSafeUrl.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchCached redirect handling', () => {
  it('re-checks each hop against the SSRF guard before following it', async () => {
    const url = freshUrl();
    const target = 'https://cdn.example.net/summary.json';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse(target))
      .mockResolvedValueOnce(jsonResponse({ page: { name: 'Vendor' } }));
    vi.stubGlobal('fetch', fetchMock);

    const { data } = await fetchJsonCached<{ page: { name: string } }>(url, 60_000, 5_000);

    expect(data).toEqual({ page: { name: 'Vendor' } });
    // Manual mode is what makes the hop visible instead of being followed by the platform.
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
    expect(mockAssertSafeUrl).toHaveBeenCalledTimes(1);
    expect(mockAssertSafeUrl).toHaveBeenCalledWith(target);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(target);
  });

  it('blocks a redirect into a private target and never requests it', async () => {
    const url = freshUrl();
    const target = 'http://127.0.0.1:3013/healthz';
    const fetchMock = vi.fn().mockResolvedValueOnce(redirectResponse(target));
    vi.stubGlobal('fetch', fetchMock);
    mockAssertSafeUrl.mockRejectedValueOnce(
      new Error(
        `SSRF_BLOCKED: URL "${target}" resolves to 127.0.0.1 (loopback). ` +
          `Requests to private, loopback, or cloud-metadata addresses are not permitted.`,
      ),
    );

    const err = await fetchJsonCached(url, 60_000, 5_000).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.ValidationError);
    expect((err as McpError).data).toMatchObject({ reason: 'target_blocked', url: target });
    // The whole caller-visible message: the guard's sentence, internal sentinel stripped.
    expect((err as McpError).message).toBe(
      `Redirect from ${url} blocked: URL "${target}" resolves to 127.0.0.1 (loopback). ` +
        'Requests to private, loopback, or cloud-metadata addresses are not permitted.',
    );
    // The decisive assertion: the loopback hop was validated *before* being
    // requested, so exactly one upstream request left the process.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockAssertSafeUrl).toHaveBeenCalledWith(target);
  });

  it('resolves a relative Location against the current URL before checking it', async () => {
    const url = 'https://vendor-relative.example.com/api/v2/summary.json';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse('/elsewhere.json'))
      .mockResolvedValueOnce(jsonResponse({ page: { name: 'Vendor' } }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchJsonCached(url, 60_000, 5_000);

    expect(mockAssertSafeUrl).toHaveBeenCalledWith(
      'https://vendor-relative.example.com/elsewhere.json',
    );
  });

  it('abandons a redirect chain past the hop cap', async () => {
    const url = freshUrl();
    const fetchMock = vi.fn().mockResolvedValue(redirectResponse('https://loop.example.net/next'));
    vi.stubGlobal('fetch', fetchMock);

    const err = await fetchJsonCached(url, 60_000, 5_000).catch((e: unknown) => e);

    expect((err as McpError).data).toMatchObject({ reason: 'statuspage_unavailable' });
    expect((err as McpError).message).toMatch(/redirects/i);
    // 5 hops followed, then the sixth 3xx ends it.
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('maps a 3xx with no Location header to statuspage_unavailable', async () => {
    const url = freshUrl();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(redirectResponse(null)));

    const err = await fetchJsonCached(url, 60_000, 5_000).catch((e: unknown) => e);

    expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect((err as McpError).data).toMatchObject({ reason: 'statuspage_unavailable', status: 302 });
    expect((err as McpError).message).toContain('Location');
  });
});

/**
 * The hop check through the real guard, with only the resolver answer mocked. A hop to a
 * hostname is refused without the address the server's resolver returned for it; a hop to
 * an IP literal keeps the address the Location header carried.
 */
describe('fetchCached redirect hops through the real guard', () => {
  const POLICY =
    'Requests to private, loopback, or cloud-metadata addresses are not permitted. Set DEVOPS_STATUS_ALLOW_PRIVATE_TARGETS=true to allow internal-network monitoring.';

  beforeEach(async () => {
    const actual =
      await vi.importActual<typeof import('@/utils/ssrf-guard.js')>('@/utils/ssrf-guard.js');
    mockAssertSafeUrl.mockImplementation(actual.assertSafeUrl);
    mockLookup.mockReset();
  });

  it('refuses a hop to a hostname without naming the address it resolved to', async () => {
    const url = freshUrl();
    const target = 'https://intranet.example/summary.json';
    mockLookup.mockResolvedValueOnce([{ address: '10.0.0.7', family: 4 }] as never);
    const fetchMock = vi.fn().mockResolvedValueOnce(redirectResponse(target));
    vi.stubGlobal('fetch', fetchMock);

    const err = await fetchJsonCached(url, 60_000, 5_000).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.ValidationError);
    expect((err as McpError).data).toEqual({ reason: 'target_blocked', url: target });
    expect((err as McpError).message).toBe(
      `Redirect from ${url} blocked: URL "${target}" resolves to a non-public address. ${POLICY}`,
    );
    expect((err as McpError).message).not.toContain('10.0.0.7');
    expect((err as McpError).message).not.toContain('(private (RFC 1918))');
    expect(mockLookup).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the address of a hop to an IP literal', async () => {
    const url = freshUrl();
    const target = 'http://169.254.169.254/latest/meta-data/';
    const fetchMock = vi.fn().mockResolvedValueOnce(redirectResponse(target));
    vi.stubGlobal('fetch', fetchMock);

    const err = await fetchJsonCached(url, 60_000, 5_000).catch((e: unknown) => e);

    expect((err as McpError).data).toEqual({ reason: 'target_blocked', url: target });
    expect((err as McpError).message).toBe(
      `Redirect from ${url} blocked: URL "${target}" resolves to 169.254.169.254 (link-local / cloud-metadata). ${POLICY}`,
    );
    expect(mockLookup).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('fetchCached transport failures', () => {
  it('maps a non-2xx response to statuspage_unavailable carrying the status', async () => {
    const url = freshUrl();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 503)));

    const err = await fetchJsonCached(url, 60_000, 5_000).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect((err as McpError).data).toMatchObject({
      reason: 'statuspage_unavailable',
      status: 503,
      url,
    });
    expect((err as McpError).message).toContain('HTTP 503');
  });

  it('maps a network error to statuspage_unavailable', async () => {
    const url = freshUrl();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValue(
          new TypeError('Unable to connect. Is the computer able to access the url?'),
        ),
    );

    const err = await fetchJsonCached(url, 60_000, 5_000).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect((err as McpError).data).toMatchObject({ reason: 'statuspage_unavailable', url });
    expect((err as McpError).message).toContain('Could not reach');
  });

  it('maps an unparseable body to statuspage_unavailable without echoing the parser error', async () => {
    const url = freshUrl();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => {
          throw new SyntaxError('JSON Parse error: Unexpected identifier "html"');
        },
      } as unknown as Response),
    );

    const err = await fetchJsonCached(url, 60_000, 5_000).catch((e: unknown) => e);

    expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect((err as McpError).data).toMatchObject({ reason: 'statuspage_unavailable' });
    expect((err as McpError).message).toContain('could not be parsed as JSON');
    expect((err as McpError).message).not.toContain('Unexpected identifier');
  });

  it('maps a timeout to statuspage_unavailable naming the elapsed budget', async () => {
    const url = freshUrl();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(new DOMException('The operation was aborted.', 'AbortError')),
            );
          }),
      ),
    );

    const err = await fetchJsonCached(url, 60_000, 10).catch((e: unknown) => e);

    expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect((err as McpError).data).toMatchObject({ reason: 'statuspage_unavailable' });
    expect((err as McpError).message).toContain('Timed out after 10ms');
  });

  it('serves a repeat call from cache without a second request', async () => {
    const url = freshUrl();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ page: { name: 'Vendor' } }));
    vi.stubGlobal('fetch', fetchMock);

    const first = await fetchJsonCached(url, 60_000, 5_000);
    const second = await fetchJsonCached(url, 60_000, 5_000);

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('requests again after the cache is cleared, however long the entry had left', async () => {
    const url = freshUrl();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ page: { name: 'Vendor' } }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchJsonCached(url, 60_000, 5_000);
    clearFetchCache();
    const again = await fetchJsonCached(url, 60_000, 5_000);

    expect(again.cached).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

const MiB = 1024 * 1024;

/** A JSON body whose serialized parsed value is `bytes` long: `{"pad":"xxx…"}`. */
function paddedJson(bytes: number): string {
  return JSON.stringify({ pad: 'x'.repeat(bytes - '{"pad":""}'.length) });
}

/**
 * Stubs `fetch` with real `Response` objects, routed by hostname. Each host maps to a
 * body factory; anything else is rejected.
 */
function stubHosts(routes: Record<string, () => Response>) {
  const fetchMock = vi.fn(async (input: string) => {
    const route = routes[new URL(input).hostname];
    if (!route) throw new Error(`Unmocked fetch: ${input}`);
    return route();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/**
 * A body of `total` bytes served in `chunk`-sized pulls, recording how many bytes the
 * consumer pulled — the observable that shows reading stopped at the limit.
 */
function countedBody(total: number, chunk = 256 * 1024) {
  const counter = { pulled: 0 };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (counter.pulled >= total) {
          controller.close();
          return;
        }
        const size = Math.min(chunk, total - counter.pulled);
        counter.pulled += size;
        controller.enqueue(new Uint8Array(size).fill(0x20));
      },
    },
    // Pull only when the consumer reads, so `pulled` counts what was actually read.
    { highWaterMark: 0 },
  );
  return { stream, counter };
}

describe('fetchCached cache key', () => {
  beforeEach(() => clearFetchCache());

  it.each([
    'https://WWW.githubstatus.com/api/v2/summary.json',
    'https://www.GitHubStatus.com/api/v2/summary.json',
    'https://www.githubstatus.com:443/api/v2/summary.json',
    'HTTPS://www.githubstatus.com/api/v2/summary.json',
    'https://www.githubstatus.com/api/./v2/x/../summary.json',
  ])('serves %s from the entry the canonical spelling stored', async (variant) => {
    const fetchMock = stubHosts({
      'www.githubstatus.com': () => new Response(JSON.stringify({ page: { name: 'GitHub' } })),
    });

    const first = await fetchJsonCached(
      'https://www.githubstatus.com/api/v2/summary.json',
      60_000,
      5_000,
    );
    const second = await fetchJsonCached(variant, 60_000, 5_000);

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.data).toEqual({ page: { name: 'GitHub' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchCacheStats().entries).toBe(1);
  });

  it('keeps distinct pages in distinct entries', async () => {
    stubHosts({
      'a.example.com': () => new Response('{"page":"a"}'),
      'b.example.com': () => new Response('{"page":"b"}'),
    });

    await fetchJsonCached('https://a.example.com/api/v2/summary.json', 60_000, 5_000);
    const b = await fetchJsonCached('https://b.example.com/api/v2/summary.json', 60_000, 5_000);

    expect(b).toEqual({ data: { page: 'b' }, cached: false });
    expect(fetchCacheStats().entries).toBe(2);
  });
});

describe('fetchCached byte budget', () => {
  beforeEach(() => clearFetchCache());
  afterEach(() => vi.useRealTimers());

  it('counts each entry at its serialized size', async () => {
    stubHosts({ 'sized.example.com': () => new Response(paddedJson(1000)) });

    await fetchJsonCached('https://sized.example.com/x.json', 60_000, 5_000);

    expect(fetchCacheStats()).toEqual({ entries: 1, bytes: 1000 });
  });

  it('evicts oldest-first and never holds more than the budget', async () => {
    const entryBytes = 3 * MiB;
    const count = Math.ceil(FETCH_CACHE_BUDGET_BYTES / entryBytes) + 2;
    const body = paddedJson(entryBytes);
    const routes: Record<string, () => Response> = {};
    for (let i = 0; i < count; i++) routes[`v${i}.example.com`] = () => new Response(body);
    const fetchMock = stubHosts(routes);

    for (let i = 0; i < count; i++) {
      await fetchJsonCached(`https://v${i}.example.com/x.json`, 60_000, 5_000);
      expect(fetchCacheStats().bytes).toBeLessThanOrEqual(FETCH_CACHE_BUDGET_BYTES);
    }
    const held = Math.floor(FETCH_CACHE_BUDGET_BYTES / entryBytes);
    expect(fetchCacheStats()).toEqual({ entries: held, bytes: held * entryBytes });

    // The newest entries are the ones still held; the oldest were evicted.
    const newest = await fetchJsonCached(`https://v${count - 1}.example.com/x.json`, 60_000, 5_000);
    expect(newest.cached).toBe(true);
    const oldest = await fetchJsonCached('https://v0.example.com/x.json', 60_000, 5_000);
    expect(oldest.cached).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(count + 1);
  });

  it('returns a value over the per-entry limit without caching it', async () => {
    const fetchMock = stubHosts({
      'big.example.com': () => new Response(paddedJson(FETCH_CACHE_MAX_ENTRY_BYTES + 1)),
      'small.example.com': () => new Response(paddedJson(1000)),
    });
    await fetchJsonCached('https://small.example.com/x.json', 60_000, 5_000);

    const first = await fetchJsonCached<{ pad: string }>(
      'https://big.example.com/x.json',
      60_000,
      5_000,
    );
    const second = await fetchJsonCached('https://big.example.com/x.json', 60_000, 5_000);

    expect(first.cached).toBe(false);
    expect(first.data.pad).toHaveLength(FETCH_CACHE_MAX_ENTRY_BYTES + 1 - '{"pad":""}'.length);
    expect(second.cached).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // The small entry is untouched; nothing else was stored.
    expect(fetchCacheStats()).toEqual({ entries: 1, bytes: 1000 });
  });

  it('caches a value exactly at the per-entry limit', async () => {
    stubHosts({ 'edge.example.com': () => new Response(paddedJson(FETCH_CACHE_MAX_ENTRY_BYTES)) });

    await fetchJsonCached('https://edge.example.com/x.json', 60_000, 5_000);
    const again = await fetchJsonCached('https://edge.example.com/x.json', 60_000, 5_000);

    expect(again.cached).toBe(true);
    expect(fetchCacheStats().bytes).toBe(FETCH_CACHE_MAX_ENTRY_BYTES);
  });

  it('sweeps expired entries on any insert, even when their keys are never read again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T00:00:00Z'));
    stubHosts({
      'stale-1.example.com': () => new Response(paddedJson(500)),
      'stale-2.example.com': () => new Response(paddedJson(600)),
      'fresh.example.com': () => new Response(paddedJson(700)),
    });

    await fetchJsonCached('https://stale-1.example.com/x.json', 60_000, 5_000);
    await fetchJsonCached('https://stale-2.example.com/x.json', 60_000, 5_000);
    expect(fetchCacheStats()).toEqual({ entries: 2, bytes: 1100 });

    vi.setSystemTime(new Date('2026-10-14T00:01:01Z'));
    await fetchJsonCached('https://fresh.example.com/x.json', 60_000, 5_000);

    expect(fetchCacheStats()).toEqual({ entries: 1, bytes: 700 });
  });

  it('replaces a refetched key in place rather than counting it twice', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T00:00:00Z'));
    stubHosts({ 'again.example.com': () => new Response(paddedJson(800)) });

    await fetchJsonCached('https://again.example.com/x.json', 60_000, 5_000);
    vi.setSystemTime(new Date('2026-10-14T00:01:01Z'));
    const refetched = await fetchJsonCached('https://again.example.com/x.json', 60_000, 5_000);

    expect(refetched.cached).toBe(false);
    expect(fetchCacheStats()).toEqual({ entries: 1, bytes: 800 });
  });
});

describe('fetchCached body read limit', () => {
  beforeEach(() => clearFetchCache());

  function expectTooLarge(err: unknown, url: string) {
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect((err as McpError).data).toMatchObject({ reason: 'statuspage_unavailable', url });
    expect((err as McpError).message).toContain('size limit');
  }

  it.each([
    ['res.json()', (res: Response) => res.json()],
    ['res.text()', (res: Response) => res.text()],
    ['res.arrayBuffer()', (res: Response) => res.arrayBuffer()],
  ])(
    'stops reading a body past the limit and fails typed when the parser uses %s',
    async (_label, parse) => {
      const url = 'https://huge.example.com/api/v2/incidents.json';
      const { stream, counter } = countedBody(MAX_RESPONSE_BODY_BYTES + 4 * MiB);
      stubHosts({ 'huge.example.com': () => new Response(stream) });

      const err = await fetchCached(url, 60_000, 5_000, parse).catch((e: unknown) => e);

      expectTooLarge(err, url);
      // Reading stopped within one chunk of the limit, before the rest arrived.
      expect(counter.pulled).toBeLessThanOrEqual(MAX_RESPONSE_BODY_BYTES + 512 * 1024);
      expect(fetchCacheStats().entries).toBe(0);
    },
  );

  it('fails before reading when the declared length is past the limit', async () => {
    const url = 'https://declared.example.com/api/v2/summary.json';
    const { stream, counter } = countedBody(1024);
    stubHosts({
      'declared.example.com': () =>
        new Response(stream, {
          headers: { 'content-length': String(MAX_RESPONSE_BODY_BYTES + 1) },
        }),
    });

    const err = await fetchJsonCached(url, 60_000, 5_000).catch((e: unknown) => e);

    expectTooLarge(err, url);
    expect(counter.pulled).toBe(0);
  });

  it('reads a body exactly at the limit', async () => {
    const url = 'https://at-limit.example.com/raw';
    const { stream } = countedBody(MAX_RESPONSE_BODY_BYTES);
    stubHosts({ 'at-limit.example.com': () => new Response(stream) });

    const { data } = await fetchCached(
      url,
      60_000,
      5_000,
      async (res) => (await res.arrayBuffer()).byteLength,
    );

    expect(data).toBe(MAX_RESPONSE_BODY_BYTES);
  });

  it('reads a body the size of the largest real status payload unchanged', async () => {
    const url = 'https://large-real.example.com/api/v2/incidents.json';
    const body = paddedJson(1_000_000);
    stubHosts({ 'large-real.example.com': () => new Response(body) });

    const { data } = await fetchJsonCached<{ pad: string }>(url, 60_000, 5_000);

    expect(data.pad).toHaveLength(1_000_000 - '{"pad":""}'.length);
  });

  it('still re-checks each redirect hop before reading the final body', async () => {
    const url = 'https://hop.example.com/api/v2/summary.json';
    const target = 'https://cdn.example.net/summary.json';
    const fetchMock = stubHosts({
      'hop.example.com': () => new Response(null, { status: 302, headers: { location: target } }),
      'cdn.example.net': () => new Response('{"page":{"name":"Vendor"}}'),
    });

    const { data } = await fetchJsonCached(url, 60_000, 5_000);

    expect(data).toEqual({ page: { name: 'Vendor' } });
    expect(mockAssertSafeUrl).toHaveBeenCalledWith(target);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
