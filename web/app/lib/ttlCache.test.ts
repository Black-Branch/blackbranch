// Tests for the shared TTL + single-flight cache.
//
// This is the real module, not a model of it: a local re-implementation of the
// policy would let the tests pass while the shipped cache drifts.
// createTtlCache takes an injectable clock precisely so the real thing is
// testable directly.
//
// Run: node --test app/lib/ttlCache.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTtlCache } from "./ttlCache.ts";

type Snap = { n: number };
function counter() {
  let calls = 0;
  let release: (() => void) | null = null;
  return {
    get calls() { return calls; },
    hold() { return new Promise<void>((r) => { release = r; }); },
    let_go() { release?.(); release = null; },
    make(cacheable = true, gate?: Promise<void>) {
      return async () => {
        calls++;
        if (gate) await gate;
        return { data: { n: calls }, cacheable };
      };
    },
  };
}

test("repeat reads inside the TTL hit the cache — one load, not N", async () => {
  const c = counter();
  const t = 1000;
  const cache = createTtlCache<Snap>({ ttlMs: 15_000, load: c.make(), now: () => t });
  for (let i = 0; i < 10; i++) await cache.get();
  assert.equal(c.calls, 1, "ten polls should cost one set of queries");
});

test("a read past the TTL reloads", async () => {
  const c = counter();
  let t = 1000;
  const cache = createTtlCache<Snap>({ ttlMs: 15_000, load: c.make(), now: () => t });
  await cache.get();
  t += 15_001;
  await cache.get();
  assert.equal(c.calls, 2);
});

test("THE STAMPEDE: concurrent misses share ONE load", async () => {
  // The failure this exists for — N viewers all missing at once each firing six
  // full-table scans. Busier stream, worse herd.
  const c = counter();
  const t = 1000;
  const gate = c.hold();
  const cache = createTtlCache<Snap>({ ttlMs: 15_000, load: c.make(true, gate), now: () => t });

  const all = Promise.all(Array.from({ length: 25 }, () => cache.get()));
  await Promise.resolve();
  c.let_go();
  const results = await all;

  assert.equal(c.calls, 1, "25 concurrent callers must not issue 25 loads");
  assert.ok(results.every((r) => r.n === results[0]!.n), "all callers get the same snapshot");
});

test("a PARTIAL read is returned but never cached", async () => {
  // A DB blip degrades to empty rows so badges vanish for that request rather
  // than 500ing. Caching that would make one blip into TTL_MS of site-wide
  // missing badges.
  const c = counter();
  const t = 1000;
  const cache = createTtlCache<Snap>({ ttlMs: 15_000, load: c.make(false), now: () => t });
  await cache.get();
  await cache.get();
  assert.equal(c.calls, 2, "a failed read must not be remembered");
});

test("recovery after a partial read caches normally again", async () => {
  let calls = 0, complete = false;
  const t = 1000;
  const cache = createTtlCache<Snap>({ ttlMs: 15_000, now: () => t, load: async () => { calls++; return { data: { n: calls }, cacheable: complete }; } });
  await cache.get();
  assert.equal(calls, 1);
  complete = true;
  await cache.get();          // reloads (previous was partial), now caches
  assert.equal(calls, 2);
  await cache.get();          // served from cache
  assert.equal(calls, 2);
});

test("invalidate forces the next read to reload — equipping shows up at once", async () => {
  const c = counter();
  const t = 1000;
  const cache = createTtlCache<Snap>({ ttlMs: 15_000, load: c.make(), now: () => t });
  await cache.get();
  assert.equal(c.calls, 1);
  cache.invalidate();
  await cache.get();
  assert.equal(c.calls, 2, "a write must not wait out the TTL");
});

test("the in-flight slot is released even when the load rejects", async () => {
  // Otherwise one rejection wedges the cache permanently: every later caller
  // returns the same dead promise.
  let calls = 0;
  const t = 1000;
  let boom = true;
  const cache = createTtlCache<Snap>({
    ttlMs: 15_000,
    now: () => t,
    load: async () => {
      calls++;
      if (boom) throw new Error("db down");
      return { data: { n: calls }, cacheable: true };
    },
  });

  await assert.rejects(() => cache.get());
  boom = false;
  const r = await cache.get();
  assert.equal(r.n, 2, "the cache recovered rather than wedging on the dead promise");
});

// ─── stale-while-error ────────────────────────────────────────────────────────
// "Don't cache failures" is half a policy: refusing to REMEMBER a blip is not
// refusing to SERVE it. The status loader's degraded answer is "nobody is live",
// and serving that for one stream-api hiccup would unmount every viewer's
// player and flip them to Radio.

function flaky() {
  let calls = 0;
  let good = true;
  return {
    get calls() { return calls; },
    set good(v: boolean) { good = v; },
    load: async () => {
      calls++;
      return good ? { data: { n: calls }, cacheable: true } : { data: { n: -1 }, cacheable: false };
    },
  };
}

test("STALE-WHILE-ERROR: a degraded load inside the window serves the last good value", async () => {
  const f = flaky();
  let t = 1000;
  const cache = createTtlCache<Snap>({ ttlMs: 5_000, serveStaleForMs: 60_000, now: () => t, load: f.load });
  assert.equal((await cache.get()).n, 1);
  f.good = false;
  t += 5_001;                                  // TTL expired → the load runs → degraded
  const served = await cache.get();
  assert.equal(f.calls, 2, "the TTL expired, so the load ran");
  assert.equal(served.n, 1, "the blip is served as the last good value, not as the degraded one");
});

test("STALE-WHILE-ERROR: past the window the degraded value surfaces", async () => {
  const f = flaky();
  let t = 1000;
  const cache = createTtlCache<Snap>({ ttlMs: 5_000, serveStaleForMs: 60_000, now: () => t, load: f.load });
  await cache.get();
  f.good = false;
  t += 60_001;
  assert.equal((await cache.get()).n, -1, "a real outage must not hide behind a stale value forever");
});

test("STALE-WHILE-ERROR: serving the stale value does not re-stamp it", async () => {
  // The window counts from the last GOOD load, not from the last serve —
  // otherwise repeated polls could keep a dead upstream 'live' indefinitely.
  const f = flaky();
  let t = 1000;
  const cache = createTtlCache<Snap>({ ttlMs: 5_000, serveStaleForMs: 60_000, now: () => t, load: f.load });
  await cache.get();
  f.good = false;
  t += 30_000;
  assert.equal((await cache.get()).n, 1, "inside the window: stale value");
  t += 30_000;                                 // 60_000 after the good load
  assert.equal((await cache.get()).n, -1, "the window closed at 60s from the good load, not 60s from the last serve");
});

test("without serveStaleForMs a degraded load is served at once (unchanged behaviour)", async () => {
  const f = flaky();
  let t = 1000;
  const cache = createTtlCache<Snap>({ ttlMs: 5_000, now: () => t, load: f.load });
  await cache.get();
  f.good = false;
  t += 5_001;
  assert.equal((await cache.get()).n, -1);
});
