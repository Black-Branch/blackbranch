// A tiny in-process TTL cache with a hard size cap.
//
// Built for /api/avatar/user/[id]: that route is a full Next invocation plus
// two no-store Synapse round-trips per request, and its Cache-Control is
// private — a burst of viewers opening the same profile card multiplies
// straight into Synapse. 60s of in-process caching collapses the burst while
// keeping the route's live-profile intent (its own comment rejects the 1h
// reconcile mirror precisely because an hour of lag is too much; a minute is
// not).
//
// Bounded on purpose: this lives in a long-running server process and is
// keyed by matrix ids arriving from public traffic — `max` evicts the oldest
// entry (insertion order; a re-set refreshes position). A count alone does not
// bound memory when values vary in size, so `weigh` + `maxWeight` (optional)
// also cap the total: the oldest entries go until the sum fits, and a single
// value heavier than the whole budget is not stored at all.

export type MicroCache<T> = ReturnType<typeof makeMicroCache<T>>;

export function makeMicroCache<T>({ ttlMs, max, weigh, maxWeight = Infinity }: {
  ttlMs: number; max: number; weigh?: (value: T) => number; maxWeight?: number;
}) {
  const entries = new Map<string, { value: T; expires: number; weight: number }>();
  let total = 0;
  const drop = (key: string) => {
    const e = entries.get(key);
    if (!e) return;
    total -= e.weight;
    entries.delete(key);
  };
  return {
    get(key: string, now = Date.now()): T | null {
      const e = entries.get(key);
      if (!e) return null;
      if (now > e.expires) {
        drop(key);
        return null;
      }
      return e.value;
    },
    set(key: string, value: T, now = Date.now()) {
      drop(key); // re-insert so a refreshed key is newest, not oldest
      const weight = weigh ? weigh(value) : 0;
      if (weight > maxWeight) return;
      entries.set(key, { value, expires: now + ttlMs, weight });
      total += weight;
      while (entries.size > max || total > maxWeight) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        drop(oldest);
      }
    },
    size() {
      return entries.size;
    },
    weight() {
      return total;
    },
  };
}
