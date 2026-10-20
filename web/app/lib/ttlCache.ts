// A small TTL cache with single-flight and failure-awareness.
//
// Shared because the same policy is needed in more than one place and getting
// any part of it wrong is subtle:
//
//   1. TTL — the obvious part. Collapses repeat reads.
//   2. SINGLE-FLIGHT — the part that actually matters under load. When a TTL
//      expires with N requests in flight, every one of them misses and issues
//      its own upstream work. The busier things are, the worse the herd, which
//      is exactly backwards. Concurrent misses share ONE load.
//   3. DON'T CACHE FAILURES — callers that degrade gracefully (empty rows, a
//      not-live fallback) must not have that degraded value remembered, or one
//      blip becomes ttlMs of site-wide wrongness. The loader says whether its
//      result is worth keeping.
//   4. STALE-WHILE-ERROR (opt-in) — not remembering a blip is not the same as
//      not SERVING it. With `serveStaleForMs`, a degraded load inside that
//      window of the last good value returns the good value instead; the
//      stale entry is not re-stamped, so a real outage surfaces once the window
//      closes. The status loader uses it: otherwise one stream-api hiccup reads
//      as "nobody is live" and unmounts every viewer's player.
//
// Plus one thing easy to miss: the in-flight slot must be released even when the
// load REJECTS, otherwise a single rejection wedges the cache permanently and
// every later caller awaits the same dead promise.
//
// Deliberately per-process and unbounded-in-time: these cache one value, not a
// keyspace, so there is nothing to evict.

interface TtlCache<T> {
  /** Cached value if fresh, otherwise load (sharing one in-flight load). */
  get(): Promise<T>;
  /** Drop the cached value so the next get() reloads. Call after a write. */
  invalidate(): void;
  /** The cached value without loading — null if absent or stale. Testing/introspection. */
  peek(): T | null;
}

export interface TtlCacheOptions<T> {
  ttlMs: number;
  /**
   * Produce the value. `cacheable: false` means "return this to the caller but
   * do not remember it" — use it for degraded/partial results.
   */
  load: () => Promise<{ data: T; cacheable: boolean }>;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
  /**
   * Stale-while-error. When a load answers `cacheable: false` and a cached
   * value exists that is younger than this, serve THAT instead of the degraded
   * result. The stale value is not re-stamped. Absent = serve the degraded
   * result at once.
   */
  serveStaleForMs?: number;
}

export function createTtlCache<T>({ ttlMs, load, now = Date.now, serveStaleForMs }: TtlCacheOptions<T>): TtlCache<T> {
  let cached: { at: number; data: T } | null = null;
  let inflight: Promise<T> | null = null;

  const fresh = () => cached !== null && now() - cached.at < ttlMs;

  return {
    invalidate() {
      cached = null;
    },

    peek() {
      return fresh() ? (cached as { at: number; data: T }).data : null;
    },

    async get(): Promise<T> {
      if (fresh()) return (cached as { at: number; data: T }).data;
      if (inflight) return inflight;

      inflight = load()
        .then(({ data, cacheable }) => {
          if (cacheable) { cached = { at: now(), data }; return data; }
          // Degraded. Inside the stale window the last good value is the better
          // answer; its `at` is deliberately left alone (see header, point 4).
          if (serveStaleForMs !== undefined && cached !== null && now() - cached.at < serveStaleForMs) {
            return cached.data;
          }
          return data;
        })
        .finally(() => {
          inflight = null;
        });

      return inflight;
    },
  };
}
