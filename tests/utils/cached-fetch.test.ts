/**
 * @fileoverview Tests for the shared cached fetch helper — per-hop redirect
 * re-validation against the SSRF guard, and transport failures mapped onto the
 * statuspage_unavailable contract.
 * @module tests/utils/cached-fetch.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchJsonCached } from '@/utils/cached-fetch.js';
import { assertSafeUrl } from '@/utils/ssrf-guard.js';

/**
 * The guard itself is covered in ssrf-guard.test.ts. Mocking it here keeps these
 * tests offline and — more to the point — lets each case assert *which* URL the
 * hop check was handed, which is the whole behavior under test.
 */
vi.mock('@/utils/ssrf-guard.js', () => ({
  assertSafeUrl: vi.fn(),
  assertSafeDomain: vi.fn(),
  assertSafeResolverIp: vi.fn(),
}));

const mockAssertSafeUrl = vi.mocked(assertSafeUrl);

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
    expect((err as McpError).message).toContain('127.0.0.1');
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
});
