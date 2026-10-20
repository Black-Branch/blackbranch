// In-process micro-cache for the avatar route.
//
// The cost this bounds: /api/avatar/user/[id] is a full Next invocation plus
// TWO no-store Synapse round-trips per request, and its Cache-Control is
// private (per-viewer browser cache only) — so a chat room where forty people
// open the same profile card, or one member list render, hits Synapse 2×N
// times for the same 96px thumbnail. A short in-process TTL keeps the route's
// "live profile" intent (the comment in the route rejects the 1h reconcile
// mirror BECAUSE it can lag an hour — 60s does not) while collapsing bursts.
//
// Run: node --test app/lib/avatarMicroCache.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMicroCache } from "./avatarMicroCache.ts";

test("a fresh entry is served; an expired one is not", () => {
  const cache = makeMicroCache<string>({ ttlMs: 1000, max: 10 });
  cache.set("a", "bytes", 0);
  assert.equal(cache.get("a", 999), "bytes");
  assert.equal(cache.get("a", 1001), null, "an entry outlived its TTL — avatars would lag past the live-profile contract");
});

test("the cache is capped — the oldest entry is evicted, never unbounded growth", () => {
  // Bounded-map discipline: this sits in a long-lived server process keyed on
  // arbitrary matrix ids from public traffic.
  const cache = makeMicroCache<number>({ ttlMs: 60_000, max: 3 });
  cache.set("a", 1, 0); cache.set("b", 2, 0); cache.set("c", 3, 0); cache.set("d", 4, 0);
  assert.equal(cache.size(), 3, "the cache grew past its cap");
  assert.equal(cache.get("a", 1), null, "the oldest entry survived the cap");
  assert.equal(cache.get("d", 1), 4);
});

test("re-setting a key refreshes its position and value", () => {
  const cache = makeMicroCache<number>({ ttlMs: 60_000, max: 2 });
  cache.set("a", 1, 0); cache.set("b", 2, 0);
  cache.set("a", 10, 5); // refreshed — "b" is now the oldest
  cache.set("c", 3, 5);
  assert.equal(cache.get("a", 6), 10);
  assert.equal(cache.get("b", 6), null, "re-set did not refresh recency — the wrong entry was evicted");
});

// The route wiring (cache after the token gate, filled only from our own
// homeserver) is pinned in avatarThumb.test.ts.
