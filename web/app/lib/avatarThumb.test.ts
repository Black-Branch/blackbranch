// /api/avatar/user/[id]'s fetch: who may fill the shared cache, and how much
// memory one request can make the server hold. Every fake upstream below is
// in-process; "12 MiB" bodies are produced as a stream of small chunks so the
// test itself never buffers them.
//
// Run: node --test app/lib/avatarThumb.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createAvatarThumbLoader, AVATAR_MAX_BYTES, AVATAR_CACHE_MAX_BYTES, AVATAR_GATE_LIMITS, AVATAR_REMOTE_GATE_LIMITS, type AvatarBytes,
} from "./avatarThumb.ts";
import { makeMicroCache } from "./avatarMicroCache.ts";
import { createConcurrencyGate } from "./concurrencyGate.ts";

const OURS = "https://matrix.site.test";
const REMOTE = "https://hostile.example";
const TARGET = "@casey:site.test";
const MXC = "mxc://site.test/abcDEF123";
const enc = new TextEncoder();
const text = (b: ArrayBuffer) => new TextDecoder().decode(b);

function bodyOf(chunks: number, chunkSize: number, fill = "x") {
  const state = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (state.pulled >= chunks) { c.close(); return; }
      state.pulled++;
      c.enqueue(enc.encode(fill.repeat(chunkSize)));
    },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 });
  return { state, stream };
}

type Gate = ReturnType<typeof createConcurrencyGate>;
function harness(opts: { serve?: (homeserver: string) => Response | Promise<Response>; gate?: Gate; remoteGate?: Gate } = {}) {
  const cache = makeMicroCache<AvatarBytes>({ ttlMs: 60_000, max: 500, weigh: (v) => v.bytes.byteLength, maxWeight: AVATAR_CACHE_MAX_BYTES });
  const calls: string[] = [];
  const serve = opts.serve ?? ((hs: string) => new Response(hs === OURS ? "REAL" : "FORGED", { headers: { "content-type": "image/png" } }));
  const load = createAvatarThumbLoader({
    resolveMxc: async () => MXC,
    fetch: async (url) => {
      calls.push(url);
      return serve(new URL(url).origin);
    },
    isLocal: (hs) => hs === OURS,
    gate: opts.gate ?? createConcurrencyGate({ maxConcurrent: 4, maxQueued: 4, maxWaitMs: 1000 }),
    remoteGate: opts.remoteGate ?? createConcurrencyGate({ maxConcurrent: 2, maxQueued: 2, maxWaitMs: 1000 }),
    cache,
    contentType: (t) => t ?? "application/octet-stream",
    timeoutMs: 8000,
  });
  return { load, cache, calls };
}

test("a federated viewer's fetch never changes what a local viewer receives", async () => {
  const h = harness();
  const remote = await h.load(TARGET, { homeserver: REMOTE, accessToken: "t-remote" });
  assert.equal(text(remote!.bytes), "FORGED", "the federated viewer is served their own homeserver's bytes");
  assert.equal(h.cache.size(), 0, "bytes a remote homeserver supplied went into the shared cache");

  const local = await h.load(TARGET, { homeserver: OURS, accessToken: "t-local" });
  assert.equal(text(local!.bytes), "REAL", "a local viewer was served the federated viewer's image");
  assert.equal(h.calls.at(-1)?.startsWith(OURS), true, "the local viewer's fetch did not go to our homeserver");
});

test("our homeserver's fetch fills the shared cache, and every viewer reads it", async () => {
  const h = harness();
  await h.load(TARGET, { homeserver: OURS, accessToken: "t-local" });
  assert.equal(h.cache.size(), 1);
  const remote = await h.load(TARGET, { homeserver: REMOTE, accessToken: "t-remote" });
  assert.equal(text(remote!.bytes), "REAL", "the cache is read for every signed-in viewer");
  assert.equal(h.calls.length, 1, "a cache hit still went upstream");
});

test("a 12 MiB 'thumbnail' is refused, read no further than the ceiling, and not cached", async () => {
  const big = bodyOf(12 * 16, 64 * 1024); // 12 MiB in 64 KiB chunks, streamed — no length header
  const h = harness({ serve: () => new Response(big.stream, { headers: { "content-type": "image/png" } }) });
  const got = await h.load(TARGET, { homeserver: OURS, accessToken: "t" });
  assert.equal(got, null, "an oversized body was served instead of the letter avatar");
  assert.equal(h.cache.size(), 0, "an oversized body was cached");
  assert.ok(big.state.pulled * 64 * 1024 <= AVATAR_MAX_BYTES + 64 * 1024, `read ${big.state.pulled} chunks — past the ceiling`);
  assert.equal(big.state.cancelled, true, "the upstream read was not cancelled at the ceiling");
});

test("a declared Content-Length over the ceiling is refused before a byte is read", async () => {
  const big = bodyOf(1, 10);
  const h = harness({ serve: () => new Response(big.stream, { headers: { "content-length": String(12 * 1024 * 1024) } }) });
  assert.equal(await h.load(TARGET, { homeserver: OURS, accessToken: "t" }), null);
  assert.equal(big.state.pulled, 0, "the body was read although its declared length was over the ceiling");
  assert.equal(h.cache.size(), 0);
});

test("a thumbnail at the ceiling is served and cached", async () => {
  const h = harness({ serve: () => new Response(bodyOf(4, AVATAR_MAX_BYTES / 4).stream) });
  const got = await h.load(TARGET, { homeserver: OURS, accessToken: "t" });
  assert.equal(got?.bytes.byteLength, AVATAR_MAX_BYTES, "an exactly-at-ceiling body was refused — the bound is off by one");
  assert.equal(h.cache.size(), 1);
});

test("the gate refuses fetches beyond its bound and frees its slot when a fetch ends", async () => {
  const gate = createConcurrencyGate({ maxConcurrent: 1, maxQueued: 0, maxWaitMs: 1000 });
  let unblock!: () => void;
  const blocked = new Promise<void>((r) => { unblock = r; });
  let n = 0;
  const h = harness({
    gate,
    serve: async () => {
      if (n++ === 0) await blocked;
      return new Response("REAL");
    },
  });
  const first = h.load("@one:site.test", { homeserver: OURS, accessToken: "t" });
  await new Promise((r) => setImmediate(r));
  const second = await h.load("@two:site.test", { homeserver: OURS, accessToken: "t" });
  assert.equal(second, null, "a fetch beyond the gate's bound went upstream");
  assert.equal(h.calls.length, 1);
  unblock();
  assert.equal(text((await first)!.bytes), "REAL");
  const third = await h.load("@three:site.test", { homeserver: OURS, accessToken: "t" });
  assert.equal(text(third!.bytes), "REAL", "the slot was not released after the first fetch ended");
});

test("an upstream failure releases the gate slot and is not cached", async () => {
  const gate = createConcurrencyGate({ maxConcurrent: 1, maxQueued: 0, maxWaitMs: 1000 });
  let fail = true;
  const h = harness({ gate, serve: () => (fail ? new Response("no", { status: 502 }) : new Response("REAL")) });
  assert.equal(await h.load(TARGET, { homeserver: OURS, accessToken: "t" }), null);
  assert.equal(h.cache.size(), 0, "a failure was cached — a blip would stick for the TTL");
  fail = false;
  assert.equal(text((await h.load(TARGET, { homeserver: OURS, accessToken: "t" }))!.bytes), "REAL", "the failed fetch kept its slot");
});

/** `p`, or "timeout" if it has not settled within `ms` — so a fetch stuck
 *  behind a stalled one fails the test instead of hanging the file. */
function within<T>(p: Promise<T>, ms = 1500): Promise<T | "timeout"> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<"timeout">((r) => { t = setTimeout(() => r("timeout"), ms); })]).finally(() => clearTimeout(t));
}

// One gate served every viewer, so a federated viewer whose homeserver
// trickles (or never answers) could hold all of its slots: while it did, every
// avatar not already cached fell back to letters for everyone. Fetches through
// a homeserver that is not ours now also pass a smaller sub-gate, so they can
// never take more than its share of the main one. Production limits, not toy ones.
test("stalled foreign homeservers cannot starve our own: a local fetch still runs", async () => {
  assert.ok(AVATAR_REMOTE_GATE_LIMITS.maxConcurrent < AVATAR_GATE_LIMITS.maxConcurrent, "the foreign share is the whole gate");
  let unstall!: () => void;
  const stalled = new Promise<void>((r) => { unstall = r; });
  const h = harness({
    gate: createConcurrencyGate(AVATAR_GATE_LIMITS),
    remoteGate: createConcurrencyGate(AVATAR_REMOTE_GATE_LIMITS),
    serve: async (hs) => {
      if (hs !== OURS) await stalled;
      return new Response(hs === OURS ? "REAL" : "FORGED");
    },
  });
  // More stuck foreign fetches than the whole main gate has slots.
  const foreign = Array.from({ length: AVATAR_GATE_LIMITS.maxConcurrent + 4 }, (_, i) =>
    h.load(`@f${i}:site.test`, { homeserver: REMOTE, accessToken: "t-remote" }));
  try {
    await new Promise((r) => setImmediate(r));
    const upstreamForeign = h.calls.filter((u) => u.startsWith(REMOTE)).length;
    assert.equal(upstreamForeign, AVATAR_REMOTE_GATE_LIMITS.maxConcurrent, "foreign fetches went upstream past their share");

    const t0 = Date.now();
    const local = await within(h.load("@local:site.test", { homeserver: OURS, accessToken: "t-local" }));
    assert.notEqual(local, "timeout", "the local fetch never finished");
    assert.equal(local && local !== "timeout" && text(local.bytes), "REAL", "a local viewer got the letter avatar while foreign fetches held the gate");
    assert.ok(Date.now() - t0 < 1000, "the local fetch waited behind the stalled foreign ones");
  } finally {
    unstall(); // a failed assertion must not leave the file hanging on stalled fetches
  }
  const done = await Promise.all(foreign);
  assert.ok(done.some((d) => d !== null), "foreign fetches never resumed once their homeserver answered");
});

test("a foreign fetch refused by its sub-gate holds no main-gate slot", async () => {
  const gate = createConcurrencyGate({ maxConcurrent: 2, maxQueued: 0, maxWaitMs: 1000 });
  const remoteGate = createConcurrencyGate({ maxConcurrent: 1, maxQueued: 0, maxWaitMs: 1000 });
  let unstall!: () => void;
  const stalled = new Promise<void>((r) => { unstall = r; });
  const h = harness({ gate, remoteGate, serve: async (hs) => { if (hs !== OURS) await stalled; return new Response("REAL"); } });
  const first = h.load("@a:site.test", { homeserver: REMOTE, accessToken: "t" });
  try {
    await new Promise((r) => setImmediate(r));
    assert.equal(await within(h.load("@b:site.test", { homeserver: REMOTE, accessToken: "t" })), null, "a second foreign fetch passed a full sub-gate");
    const local = await within(h.load("@c:site.test", { homeserver: OURS, accessToken: "t" }));
    assert.notEqual(local, "timeout", "the local fetch waited behind a stalled foreign one");
    assert.equal(local && local !== "timeout" && text(local.bytes), "REAL", "the refused foreign fetch kept a main slot");
  } finally {
    unstall();
  }
  await first;
  assert.notEqual(await h.load("@d:site.test", { homeserver: REMOTE, accessToken: "t" }), null, "the sub-gate slot was not released");
});

test("the cache's byte budget bounds memory, not just its entry count", () => {
  const cache = makeMicroCache<AvatarBytes>({ ttlMs: 60_000, max: 500, weigh: (v) => v.bytes.byteLength, maxWeight: 1000 });
  const v = (n: number): AvatarBytes => ({ bytes: new ArrayBuffer(n), contentType: "image/png" });
  cache.set("a", v(400), 0); cache.set("b", v(400), 0); cache.set("c", v(400), 0);
  assert.equal(cache.get("a", 1), null, "the oldest entry survived a byte budget overrun");
  assert.ok(cache.weight() <= 1000, `cache holds ${cache.weight()} bytes over a 1000 budget`);
  cache.set("huge", v(2000), 0);
  assert.equal(cache.get("huge", 1), null, "an entry larger than the whole budget was stored");
  assert.equal(cache.get("c", 1)?.bytes.byteLength, 400, "storing an over-budget entry evicted the rest");
  cache.set("c", v(100), 0);
  assert.equal(cache.weight(), 500, "re-setting a key did not give back the old value's weight");
});

test("the route serves the loader after the token gate, with the trust predicate and the byte budget wired", () => {
  const src = readFileSync(new URL("../api/avatar/user/[id]/route.ts", import.meta.url), "utf8");
  assert.match(src, /return letterAvatar\(matrixId\);\s*\}\s*$/, "END of the avatar route not read");
  const tokenGateAt = src.indexOf("if (!mx?.accessToken) return letterAvatar(matrixId)");
  const loadAt = src.indexOf("await loadAvatarThumb(");
  assert.notEqual(tokenGateAt, -1, "the signed-out letter fallback is gone");
  assert.notEqual(loadAt, -1, "the route no longer uses the bounded loader");
  assert.ok(loadAt > tokenGateAt, "the cache is consulted before the token gate — signed-out viewers would get real avatars");
  assert.match(src, /isLocal:\s*\(hs\)\s*=>\s*isLocalHomeserverUrl\(hs\)/, "the shared cache is not gated on our own homeserver");
  assert.match(src, /maxWeight:\s*AVATAR_CACHE_MAX_BYTES/, "the cache has no byte budget");
  assert.match(src, /createConcurrencyGate\(AVATAR_GATE_LIMITS\)/, "the main gate is not built from the tested limits");
  assert.match(src, /remoteGate:\s*createConcurrencyGate\(AVATAR_REMOTE_GATE_LIMITS\)/, "foreign homeservers have no sub-limit");
  assert.match(src, /fetch:\s*homeserverFetch/, "the thumbnail is not fetched through the homeserver transport (SSRF pinning for federated bases)");
  assert.doesNotMatch(src, /\.arrayBuffer\(\)/, "the route buffers a body itself, outside the loader's ceiling");
});
