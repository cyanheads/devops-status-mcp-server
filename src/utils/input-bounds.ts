/**
 * @fileoverview Shared over-cap handling for tool inputs. Batch inputs (`vendors`,
 * `domains`, `resolvers`) serve their first N entries in input order and return the
 * rest verbatim for the caller to resend; output and wait bounds (`limit`,
 * `component_limit`, `timeout_ms`) clamp to the bound. Both report what
 * happened in one notice wording shared across tools.
 * @module utils/input-bounds
 */

/** A batch split at its per-call cap: the entries served now and the ones to resend. */
export interface BatchSplit<T> {
  /** Entries past the cap, verbatim and in input order; empty when nothing was deferred. */
  deferred: T[];
  /** The first `cap` entries, in input order. */
  served: T[];
}

/** Split `items` at `cap`, keeping input order on both sides. */
export function splitBatch<T>(items: readonly T[], cap: number): BatchSplit<T> {
  return { served: items.slice(0, cap), deferred: items.slice(cap) };
}

/**
 * `items` with repeats dropped, first occurrence kept, input order preserved.
 * `key` decides when two entries are the same (default: the entry itself).
 */
export function uniqueInOrder<T>(
  items: readonly T[],
  key: (item: T) => unknown = (item) => item,
): T[] {
  const seen = new Set<unknown>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** What a deferral notice describes. */
export interface DeferralNoticeParams {
  /** The per-call cap that was applied. */
  cap: number;
  /** How many entries were deferred; the caller builds no notice when this is 0. */
  deferredCount: number;
  /** The output field holding the deferred entries (e.g. `deferred_vendors`). */
  field: string;
  /** Plural noun for the entries (e.g. `vendors`, `domains`, `resolvers`). */
  noun: string;
  /** Past-tense verb for what was done to the served entries (e.g. `checked`, `queried`). */
  verb: string;
}

/**
 * Notice for a batch served up to its cap, e.g. "Only the first 20 of 21 vendors were
 * checked (20 per call); resend the 1 in deferred_vendors in another call."
 */
export function deferralNotice({
  cap,
  deferredCount,
  field,
  noun,
  verb,
}: DeferralNoticeParams): string {
  return `Only the first ${cap} of ${cap + deferredCount} ${noun} were ${verb} (${cap} per call); resend the ${deferredCount} in ${field} in another call.`;
}

/**
 * Notice for a value clamped to a bound, giving the requested and effective values, e.g.
 * "limit 51 is past the maximum of 50; 50 was used." `bound` names the bound
 * ("maximum of 50").
 */
export function clampNotice(
  field: string,
  requested: string | number,
  effective: string | number,
  bound: string,
): string {
  return `${field} ${requested} is past the ${bound}; ${effective} was used.`;
}

/** A value after clamping, with the notice to surface when the clamp changed it. */
export interface Clamped {
  /** Present only when `value` differs from the requested value. */
  notice?: string;
  value: number;
}

/** Clamp `requested` to at most `max`; a notice is attached only when it was over. */
export function clampMax(field: string, requested: number, max: number): Clamped {
  if (requested <= max) return { value: requested };
  return { value: max, notice: clampNotice(field, requested, max, `maximum of ${max}`) };
}
