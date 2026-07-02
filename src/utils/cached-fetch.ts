/**
 * @fileoverview Shared cached fetch helper — one in-memory TTL cache with a
 * per-request timeout, used by the Statuspage service and the status adapters.
 * @module utils/cached-fetch
 */

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
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    const data = await parse(res);
    cacheSet(url, data, ttlMs);
    return { data, cached: false };
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
