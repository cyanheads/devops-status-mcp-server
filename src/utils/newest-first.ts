/**
 * @fileoverview NaN-safe comparator for ordering records by an ISO 8601 timestamp.
 * @module utils/newest-first
 */

/**
 * Newest first, with a missing or unreadable timestamp last. `Date.parse` gives NaN for
 * one, and a comparator returning NaN leaves the order of every other entry undefined.
 * Swap the arguments for oldest first, which puts such a timestamp first.
 */
export function newestFirst(a: string, b: string): number {
  const time = (at: string) => {
    const ms = Date.parse(at);
    return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
  };
  const [x, y] = [time(a), time(b)];
  return x === y ? 0 : y - x;
}
