// How many of OUR visitors are watching on WHICH source.
//
// THIS IS NOT stream.viewer_snapshots. That table counts each PLATFORM's own
// audience (stream-ingest polls Twitch/YouTube/Kick/stream.place APIs) and can
// never answer "which player did someone who came to the site choose". This
// one exists so that cutting a source is an evidence decision. The two numbers
// measure different things and must never be added together.
//
// NO NEW TIMER AND NO NEW REQUEST. Every open tab already GETs
// /api/stream/status every 30s (useStreamStatusPoll). That poll carries the
// source once the tab knows one — its first poll of a page load has nothing
// honest to report yet and omits it — and the same route flushes a row at
// most once a minute. If nobody is watching, nothing is written — which is
// the correct amount of data about nobody.
//
// PRIVACY: the identity is a random id in sessionStorage, minted per TAB and
// gone when the tab closes. It is never persisted across sessions and never
// joined to an account. It travels as a plain query parameter on a public
// URL (`?src=…&tab=…`), so this module cannot promise it is never stored
// beside an IP — any access log that records the request URI would do
// exactly that (a CDN's HTTP request logs, or one an install adds). What this
// module DOES guarantee: the tab id itself is never written to our database.
// The aggregate row is the only thing that reaches the database, and it
// carries no id at all.
//
// SINGLE PROCESS. The map lives in this Node process, which is correct because
// web runs as one process — the same assumption app/lib/rateLimit.ts documents.
// If web is ever scaled past one instance, these counts fragment per instance
// and the flushed rows undercount. That is a deployment change this module
// cannot detect, so it is written here rather than left to be discovered.
import type { PlayerSource } from "./playerSource.ts";
import { normalizePlatform } from "./nativePlatform.ts";

export type CensusSource = PlayerSource | "none";
export type CensusMap = Map<string, { source: CensusSource; at: number }>;

const SOURCES: readonly CensusSource[] = [
  "native", "streamplace", "youtube", "twitch", "community", "radio", "none",
];

/**
 * How long one poll keeps a viewer counted. Three times the client's 30s
 * interval, so a single dropped poll never drops a viewer — undercounting
 * exactly when the network is worst is the failure mode worth spending a
 * minute of staleness to avoid.
 * @test-only sourceCensus.test.ts pins both the exact-ms expiry edge and the
 * 60s-floor invariant against this constant; production reads it in-module,
 * inside recordSample and countSources, so no other file imports it yet.
 */
export const SAMPLE_TTL_MS = 90_000;

/**
 * How often the rolling count is written down.
 * @test-only sourceCensus.test.ts pins the flush-due boundary against this
 * constant; production reads it in-module, as dueForFlush's own default
 * argument, so no other file imports it yet.
 */
export const FLUSH_EVERY_MS = 60_000;

/**
 * Past this many entries — live and stale alike, the count is not filtered
 * before the comparison — the map is swept for stale ones, the same
 * threshold app/lib/rateLimit.ts uses for its own maps. But the key spaces
 * are not the same shape: rateLimit's key is `ipKey()`, the socket address or a
 * trusted proxy's `CF-Connecting-IP` (rateLimit.ts), neither of which a caller can
 * spoof — so its map is bounded by real distinct clients and a sweep is
 * enough. `tab` here is a value the caller simply sends; nothing backs it,
 * so a sweep alone does not bound this map (see MAP_CAP below, which does).
 * @test-only sourceCensus.test.ts pins that the sweep actually shrinks the
 * map once this threshold is passed; production reads it in-module, inside
 * recordSample, so no other file imports it yet.
 */
export const EVICT_ABOVE = 5000;

/**
 * How often the eviction sweep may run, regardless of how many calls pass
 * the EVICT_ABOVE threshold in that window. Without this, a client rotating
 * its tab id holds the map pinned at MAP_CAP and every single call to
 * recordSample — which means every request to the status route, the signal
 * the whole site's live/offline state rides on — walks the full map. Once a
 * second over a capped map is free; once per request is not.
 */
const SWEEP_EVERY_MS = 1000;
let lastSweepAt = 0; // reassigned in recordSample below, once the map has grown past EVICT_ABOVE

/**
 * Hard ceiling on distinct tabs tracked at once. `tab` arrives on a public,
 * unauthenticated route and becomes a Map key for the life of this process.
 * A caller sending a fresh id on every request adds a permanent entry per
 * call and never triggers its OWN eviction (recordSample only sweeps entries
 * already stale) — nothing above bounds memory growth by itself, and once
 * past EVICT_ABOVE the map is walked at most once a second (SWEEP_EVERY_MS)
 * rather than on every call, so a client pinning the map at the cap by
 * rotating its tab id costs this process one sweep a second, not one per
 * request. The count itself (countSources) is a second, separate full walk —
 * sourceCensusStore.ts defers it behind hasFreshEntry's short-circuiting
 * presence check and the flush gate, so under this same attack it too costs
 * at most once a minute, not once per request. Past this cap a NEW id is
 * refused outright; an id
 * already tracked still refreshes normally, so viewers already being counted
 * keep being counted. 20,000 is far above any plausible concurrent
 * viewership this site will see. The trade: under attack the census
 * degrades — it undercounts, or stops accepting new voters — rather than the
 * process's memory or CPU, which is the correct priority for a telemetry
 * side-channel riding the same route the whole site depends on for its
 * live/offline signal.
 * @test-only sourceCensus.test.ts pins the cap-refusal behavior against this
 * constant; production reads it in-module, inside recordSample, so no other
 * file imports it yet.
 */
export const MAP_CAP = 20_000;

/**
 * Validate the `src` parameter against the closed vocabulary.
 *
 * This is untrusted query input on its way to becoming a Map key and a column
 * name, so nothing outside the list is tolerated — including prototype names,
 * which is why the membership test is an array scan and not `in`.
 */
export function parseCensusSource(raw: string | null): CensusSource | null {
  // A page from before the platform-key rename names the site's player by the old id.
  const v = String(normalizePlatform(raw ?? ""));
  return (SOURCES as readonly string[]).includes(v) ? (v as CensusSource) : null;
}

/** Validate the `tab` parameter: bounded, alphanumeric, nothing else. */
export function parseTabId(raw: string | null): string | null {
  return raw && /^[a-z0-9]{6,64}$/.test(raw) ? raw : null;
}

/**
 * Record (or refresh) one tab's current source. A NEW id is refused once the
 * map is at MAP_CAP — an id already tracked still refreshes, so it never
 * loses its place to the refusal.
 */
export function recordSample(map: CensusMap, tabId: string, source: CensusSource, now: number): void {
  if (map.size > EVICT_ABOVE && now - lastSweepAt >= SWEEP_EVERY_MS) {
    lastSweepAt = now;
    for (const [k, v] of map) if (now - v.at >= SAMPLE_TTL_MS) map.delete(k);
  }
  if (map.size >= MAP_CAP && !map.has(tabId)) return;
  map.set(tabId, { source, at: now });
}

/**
 * Whether anyone in the map is still fresh at `now` — returns the instant it
 * finds one, rather than walking the rest. sourceCensusStore.ts uses this for
 * its early "is there anything to count" return, so the common case — someone
 * is actually watching, which is true on most polls of every open tab — costs
 * O(1) rather than the full walk countSources below does. countSources itself
 * still walks the whole map, but recordAndMaybeFlush only calls it once this
 * function has already confirmed there is something to count, and then only
 * inside the flush gate — so the full walk runs at most once a minute again,
 * not once per request.
 */
export function hasFreshEntry(map: CensusMap, now: number): boolean {
  for (const v of map.values()) {
    if (now - v.at < SAMPLE_TTL_MS) return true;
  }
  return false;
}

/**
 * The live count per source. Every key is present, always — a source with no
 * viewers reports 0 so a reader never has to tell "nobody" from "unmeasured".
 */
export function countSources(map: CensusMap, now: number): Record<CensusSource, number> {
  const out = Object.fromEntries(SOURCES.map((s) => [s, 0])) as Record<CensusSource, number>;
  for (const v of map.values()) {
    if (now - v.at >= SAMPLE_TTL_MS) continue;
    out[v.source] += 1;
  }
  return out;
}

/**
 * Whether a row is owed. `lastFlushAt` of 0 means "never", which is due.
 * @test-only sourceCensus.test.ts pins the flush-due boundary against this
 * function directly; production reads it only inside createFlushGate below,
 * in the same module, so no other file imports it.
 */
export function dueForFlush(lastFlushAt: number, now: number, everyMs: number = FLUSH_EVERY_MS): boolean {
  return lastFlushAt === 0 || now - lastFlushAt >= everyMs;
}

/**
 * Owns the two pieces of state that decide whether a flush may start: the
 * last-flush stamp and whether one is currently running. Pulled out of
 * sourceCensusStore.ts — which imports through the `@/` alias and so cannot
 * be loaded under `node --test` — so this decision can be driven by a real
 * execution instead of a source-scan regex, the same reason
 * app/lib/whepEscalation.ts and app/lib/hlsPath.ts exist as their own pure
 * modules.
 *
 * `beginIfDue` decides AND stamps in one synchronous step: two calls that
 * both arrive before either flush settles cannot both see "due", because the
 * in-flight flag set by the first is checked by the second before either
 * runs anything async.
 *
 * THE IN-FLIGHT FLAG IS NOT A TIMEOUT. `finish()` recovers it fully for a
 * flush that REJECTS — the pool query threw, and `finish()` still ran in the
 * caller's `finally`, so the next `beginIfDue` behaves normally. A flush that
 * never SETTLES at all (a true hang, not a rejection) is different: nothing
 * ever calls `finish()`, so the flag stays true and this process stops
 * flushing for the rest of its life. That is the deliberate choice, not a gap
 * to close with an age-based release: releasing a stuck gate would let the
 * next poll start a second INSERT against a database that is already not
 * answering, piling connections into the pool ~two dozen other routes share —
 * the exact amplification the in-flight guard exists to prevent. Of the two
 * failure shapes, "the census goes quiet" is the one this module chooses over
 * "the outage gets worse": currentCensus() still reads the live in-memory map
 * regardless of whether flushing has stopped, and the flag clears on the next
 * deploy.
 */
export function createFlushGate(everyMs: number = FLUSH_EVERY_MS) {
  let lastFlushAt = 0;
  let inFlight = false;
  return {
    /**
     * True — and stamped — iff a flush is owed and none is currently
     * running. A caller that gets `true` back must call `finish()` once its
     * flush settles, success or failure (a `finally` around the query, as
     * sourceCensusStore.ts does it).
     */
    beginIfDue(now: number): boolean {
      if (inFlight) return false;
      if (!dueForFlush(lastFlushAt, now, everyMs)) return false;
      lastFlushAt = now;
      inFlight = true;
      return true;
    },
    /** Marks the in-flight flush finished, whatever its outcome. */
    finish(): void {
      inFlight = false;
    },
  };
}
