// The per-viewer tier cache behind getActiveTier (entitlements.ts): keeps the chat
// hot path to one query per viewer per TTL.
//
// NEVER CACHE A FAILURE (the house rule badgeCache.ts states). A query error used
// to read as "no rows" — not a Supporter — and that answer was cached for the
// whole TTL, so one database blip removed every Supporter's perks and encrypted-
// message reading for a minute (P05, 2026-10-22). Now an error:
//   - is never written to the cache, so the next call asks the database again;
//   - serves the viewer's previous answer while it is inside ONE stale window
//     (`serveStaleForMs`, counted from when it was read and never re-stamped — the
//     ttlCache.ts rule), else null for that one call: a lookup that keeps failing
//     must not keep a lapsed Supporter's perks until a restart;
//   - is logged at most once per TIER_FAILURE_LOG_MS, with how many it held back,
//     and never with the viewer's id.
//
// Imports nothing, so `node --test` runs it (tierCache.test.ts); the query lives
// in entitlements.ts.

/**
 * How long an outage stays quiet in the log after one line was written.
 * @test-only exported so the test steps past THIS number, not a copy of it.
 */
export const TIER_FAILURE_LOG_MS = 60_000;

/** Past this many viewers the cache starts over: a bound, not an eviction policy. */
const MAX_ENTRIES = 5000;

type TierCacheOptions<T> = {
  ttlMs: number;
  /** Stale-while-error, as ttlCache.ts: on an error, the last good answer is served only while
   *  it is younger than this (counted from when it was read, never re-stamped); then null. */
  serveStaleForMs: number;
  /** The viewer's tier from the database. Throws on a query error — never answers one. */
  lookup: (matrixId: string) => Promise<T | null>;
  now?: () => number;
  warn?: (line: string) => void;
};

export function createTierCache<T>({ ttlMs, serveStaleForMs, lookup, now = Date.now, warn = (l) => console.warn(l) }: TierCacheOptions<T>) {
  const entries = new Map<string, { tier: T | null; at: number; exp: number }>();
  let loggedAt = -Infinity;
  let heldBack = 0;

  return {
    async get(matrixId: string): Promise<T | null> {
      const at = now();
      const hit = entries.get(matrixId);
      if (hit && hit.exp > at) return hit.tier;
      let tier: T | null;
      try {
        tier = await lookup(matrixId);
      } catch (err) {
        if (at - loggedAt >= TIER_FAILURE_LOG_MS) {
          const more = heldBack ? ` (${heldBack} more since the last line)` : "";
          warn(`[entitlements] tier lookup failed, not cached: ${err instanceof Error ? err.message : String(err)}${more}`);
          loggedAt = at;
          heldBack = 0;
        } else heldBack++;
        return hit && at - hit.at < serveStaleForMs ? hit.tier : null;
      }
      if (entries.size > MAX_ENTRIES) entries.clear();
      entries.set(matrixId, { tier, at, exp: at + ttlMs });
      return tier;
    },
    invalidate(matrixId: string): void {
      entries.delete(matrixId);
    },
  };
}
