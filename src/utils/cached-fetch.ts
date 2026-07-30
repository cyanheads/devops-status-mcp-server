/**
 * @fileoverview Shared cached fetch helper — one in-memory TTL cache with a
 * per-request timeout, used by the Statuspage service and the status adapters.
 *
 * Redirects are followed manually so every hop is re-checked against the same
 * SSRF guard the caller ran on the initial URL: past the first hop the target is
 * chosen by the upstream host, not by the caller, so a public URL that 3xx-es to
 * loopback would otherwise be fetched and its body handed back.
 *
 * Every transport failure — network error, timeout, non-2xx, unparseable body —
 * leaves here as a `ServiceUnavailable` carrying `reason: 'statuspage_unavailable'`,
 * so the tools' declared error contract is populated without the pure handlers
 * catching anything.
 * @module utils/cached-fetch
 */

import { McpError, serviceUnavailable, validationError } from '@cyanheads/mcp-ts-core/errors';
import { assertSafeUrl } from './ssrf-guard.js';

/** Redirect hops followed before the chain is treated as an upstream fault. */
const MAX_REDIRECTS = 5;

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

/** Shared in-memory cache across all tenants — vendor status data is public. */
const CACHE = new Map<string, CacheEntry<unknown>>();

function cacheGet<T>(key: string): T | null {
  const entry = CACHE.get(key) as CacheEntry<T> | undefined;
  if (!entry || Date.now() > entry.expiresAt) {
    CACHE.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet<T>(key: string, value: T, ttlMs: number): void {
  CACHE.set(key, { value, expiresAt: Date.now() + ttlMs });
}

/**
 * Fetch `url`, following redirects one hop at a time and re-running `assertSafeUrl`
 * on each `Location` before it is requested. Returns the first non-3xx response.
 */
async function fetchFollowingSafeRedirects(url: string, init: RequestInit): Promise<Response> {
  let current = url;

  for (let hop = 0; ; hop++) {
    const res = await fetch(current, { ...init, redirect: 'manual' });
    if (!(res.status >= 300 && res.status < 400)) return res;

    const location = res.headers.get('location');
    if (!location) {
      throw serviceUnavailable(`HTTP ${res.status} from ${current} with no Location header.`, {
        reason: 'statuspage_unavailable',
        url: current,
        status: res.status,
      });
    }
    if (hop >= MAX_REDIRECTS) {
      throw serviceUnavailable(
        `More than ${MAX_REDIRECTS} redirects starting at ${url} — the chain was abandoned.`,
        { reason: 'statuspage_unavailable', url },
      );
    }

    const next = URL.parse(location, current);
    if (!next) {
      throw serviceUnavailable(
        `HTTP ${res.status} from ${current} with an unparseable Location header.`,
        { reason: 'statuspage_unavailable', url: current, status: res.status },
      );
    }

    try {
      await assertSafeUrl(next.href);
    } catch (err) {
      const message = (err as Error).message;
      if (!message.startsWith('SSRF_BLOCKED')) throw err;
      throw validationError(
        `Redirect from ${current} blocked: ${message.replace('SSRF_BLOCKED: ', '')}`,
        { reason: 'target_blocked', url: next.href },
      );
    }

    current = next.href;
  }
}

/**
 * Fetch a URL with timeout and TTL cache, parsing the response with `parse`.
 * The parsed value (not the raw response) is cached under the URL.
 */
export async function fetchCached<T>(
  url: string,
  ttlMs: number,
  timeoutMs: number,
  parse: (res: Response) => Promise<T>,
): Promise<{ data: T; cached: boolean }> {
  const cached = cacheGet<T>(url);
  if (cached !== null) return { data: cached, cached: true };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFollowingSafeRedirects(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      throw serviceUnavailable(`HTTP ${res.status} from ${url}`, {
        reason: 'statuspage_unavailable',
        url,
        status: res.status,
      });
    }

    let data: T;
    try {
      data = await parse(res);
    } catch (err) {
      // A shape rejection from the caller's parser is already contract-shaped.
      if (err instanceof McpError) throw err;
      throw serviceUnavailable(
        `${url} returned a body that could not be parsed as JSON.`,
        { reason: 'statuspage_unavailable', url },
        { cause: err },
      );
    }

    cacheSet(url, data, ttlMs);
    return { data, cached: false };
  } catch (err) {
    if (err instanceof McpError) throw err;
    throw serviceUnavailable(
      controller.signal.aborted
        ? `Timed out after ${timeoutMs}ms fetching ${url}`
        : `Could not reach ${url}: ${(err as Error).message}`,
      { reason: 'statuspage_unavailable', url },
      { cause: err },
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch a URL with timeout and TTL cache, parsing the body as JSON. */
export function fetchJsonCached<T>(
  url: string,
  ttlMs: number,
  timeoutMs: number,
): Promise<{ data: T; cached: boolean }> {
  return fetchCached(url, ttlMs, timeoutMs, (res) => res.json() as Promise<T>);
}
