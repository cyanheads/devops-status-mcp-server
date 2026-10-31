/**
 * @fileoverview Shared cached fetch helper — one in-memory TTL cache with a
 * per-request timeout, used by the Statuspage service and the status adapters.
 *
 * Redirects are followed manually so every hop is re-checked against the same
 * SSRF guard the caller ran on the initial URL: past the first hop the target is
 * chosen by the upstream host, not by the caller, so a public URL that 3xx-es to
 * loopback would otherwise be fetched and its body handed back.
 *
 * Memory is bounded on both sides of the cache: every upstream body is read under
 * a size limit before any parser sees it, and the cache holds at most a fixed total
 * of serialized bytes, evicting oldest-first.
 *
 * Every transport failure — network error, timeout, non-2xx, oversized or
 * unparseable body — leaves here as a `ServiceUnavailable` carrying
 * `reason: 'statuspage_unavailable'`, so the tools' declared error contract is
 * populated without the pure handlers catching anything.
 * @module utils/cached-fetch
 */

import { Buffer } from 'node:buffer';
import { McpError, serviceUnavailable, validationError } from '@cyanheads/mcp-ts-core/errors';
import { assertSafeUrl, ssrfRejectionMessage } from './ssrf-guard.js';

/** Redirect hops followed before the chain is treated as an upstream fault. */
const MAX_REDIRECTS = 5;

/** Total serialized size the cache holds across all entries. */
export const FETCH_CACHE_BUDGET_BYTES = 32 * 1024 * 1024;

/** A value whose serialized size is over this is returned to its caller but never cached. */
export const FETCH_CACHE_MAX_ENTRY_BYTES = 4 * 1024 * 1024;

/**
 * Largest upstream body read — set well above the largest real status body, while
 * keeping a single response from occupying unbounded memory.
 */
export const MAX_RESPONSE_BODY_BYTES = 8 * 1024 * 1024;

interface CacheEntry {
  /** Serialized size of `value`, the unit the budget is counted in. */
  bytes: number;
  expiresAt: number;
  value: unknown;
}

/**
 * Shared in-memory cache across all tenants — vendor status data is public. Keyed by
 * the WHATWG-normalized URL so spellings of one page share an entry. The byte budget,
 * not the key set, bounds memory. Every caller passes the same TTL, so Map insertion order is also expiry
 * order: the oldest entry expires first, which makes oldest-first eviction and a
 * sweep that stops at the first live entry complete.
 */
const CACHE = new Map<string, CacheEntry>();
let cacheBytes = 0;

function cacheKey(url: string): string {
  return URL.parse(url)?.href ?? url;
}

function cacheDelete(key: string): void {
  const entry = CACHE.get(key);
  if (!entry) return;
  CACHE.delete(key);
  cacheBytes -= entry.bytes;
}

function cacheGet<T>(key: string): T | null {
  const entry = CACHE.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cacheDelete(key);
    return null;
  }
  return entry.value as T;
}

function cacheSet(key: string, value: unknown, ttlMs: number): void {
  // Re-inserting a key moves it to the tail, keeping insertion order = expiry order.
  cacheDelete(key);
  const now = Date.now();
  for (const [oldestKey, entry] of CACHE) {
    if (now <= entry.expiresAt) break;
    cacheDelete(oldestKey);
  }

  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (bytes > FETCH_CACHE_MAX_ENTRY_BYTES) return;
  for (const [oldestKey] of CACHE) {
    if (cacheBytes + bytes <= FETCH_CACHE_BUDGET_BYTES) break;
    cacheDelete(oldestKey);
  }
  CACHE.set(key, { bytes, expiresAt: now + ttlMs, value });
  cacheBytes += bytes;
}

/**
 * Drop every cached response. Entries expire by wall clock, so a test suite that
 * moves the clock (fake timers) clears the cache between cases rather than relying
 * on TTLs to keep one case's responses out of the next.
 */
export function clearFetchCache(): void {
  CACHE.clear();
  cacheBytes = 0;
}

/** Entry count and total serialized bytes currently held — for tests and diagnostics. */
export function fetchCacheStats(): { entries: number; bytes: number } {
  return { entries: CACHE.size, bytes: cacheBytes };
}

function bodyTooLarge(url: string): McpError {
  return serviceUnavailable(`${url} returned a response body over the size limit.`, {
    reason: 'statuspage_unavailable',
    url,
  });
}

/**
 * Returns a copy of `res` whose body was read under {@link MAX_RESPONSE_BODY_BYTES},
 * counting bytes as they arrive so an oversized body is abandoned at the limit rather
 * than buffered whole. A declared length past the limit fails before any read. The
 * caller's parser reads the copy, so the limit holds whichever body method it uses.
 */
async function readBoundedBody(res: Response, url: string): Promise<Response> {
  if (!res.body) return res;
  if (Number(res.headers.get('content-length')) > MAX_RESPONSE_BODY_BYTES) {
    await res.body.cancel();
    throw bodyTooLarge(url);
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_RESPONSE_BODY_BYTES) {
      await reader.cancel();
      throw bodyTooLarge(url);
    }
    chunks.push(value);
  }
  return new Response(Buffer.concat(chunks, received), {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
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
      const blocked = ssrfRejectionMessage(err);
      if (blocked === null) throw err;
      throw validationError(`Redirect from ${current} blocked: ${blocked}`, {
        reason: 'target_blocked',
        url: next.href,
      });
    }

    current = next.href;
  }
}

/**
 * Fetch a URL with timeout and TTL cache, parsing the response with `parse`.
 * The parsed value (not the raw response) is cached under the normalized URL.
 */
export async function fetchCached<T>(
  url: string,
  ttlMs: number,
  timeoutMs: number,
  parse: (res: Response) => Promise<T>,
): Promise<{ data: T; cached: boolean }> {
  const key = cacheKey(url);
  const cached = cacheGet<T>(key);
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

    const bounded = await readBoundedBody(res, url);
    let data: T;
    try {
      data = await parse(bounded);
    } catch (err) {
      // A shape rejection from the caller's parser is already contract-shaped.
      if (err instanceof McpError) throw err;
      throw serviceUnavailable(
        `${url} returned a body that could not be parsed as JSON.`,
        { reason: 'statuspage_unavailable', url },
        { cause: err },
      );
    }

    cacheSet(key, data, ttlMs);
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
