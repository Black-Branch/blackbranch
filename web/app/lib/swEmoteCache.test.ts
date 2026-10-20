// Runs the REAL public/sw.js in a vm with fake `caches`/`fetch`, and drives its
// fetch handler — behaviour, not a source scan. LRU by last use, a 30-day max
// age, emotes only (no Twitch profile pictures), BTTV left to the HTTP cache,
// the <img>/warm priority split forwarded, and an error never cached.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SRC = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
assert.match(SRC.slice(-400), /\}\s*$/, "vacuity anchor: sw.js read truncated");

type FetchCall = { url: string; init: RequestInit | undefined; ownRequest: boolean };

function makeEnv(opts: { fail?: (url: string) => boolean } = {}) {
  const stores = new Map<string, Map<string, Response>>();
  const open = async (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name)!;
    const key = (r: string | { url: string }) => (typeof r === "string" ? r : r.url);
    return {
      match: async (r: string) => m.get(key(r))?.clone(),
      put: async (r: string, res: Response) => { m.set(key(r), res); },
      keys: async () => [...m.keys()].map((url) => ({ url })),
      delete: async (r: { url: string } | string) => m.delete(key(r)),
      addAll: async () => {},
    };
  };
  const calls: FetchCall[] = [];
  const listeners: Record<string, (e: unknown) => void> = {};
  let now = 1_700_000_000_000;
  const timers: Array<() => void> = [];
  const ctx = {
    self: { addEventListener: (t: string, f: (e: unknown) => void) => { listeners[t] = f; }, skipWaiting() {}, clients: { claim: async () => {} } },
    caches: { open, keys: async () => [...stores.keys()], delete: async (n: string) => stores.delete(n), match: async () => undefined },
    fetch: async (url: string, init?: RequestInit) => {
      calls.push({ url: typeof url === "string" ? url : (url as { url: string }).url, init, ownRequest: typeof url !== "string" });
      if (opts.fail?.(url)) return new Response("nope", { status: 404 });
      return new Response("img:" + url, { status: 200 });
    },
    Response, URL, Promise, Map, Set, JSON, Object, Array, Math,
    Date: { now: () => now },
    setTimeout: (f: () => void) => { timers.push(f); return 0; },
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  async function request(url: string, destination = "image", mode = "no-cors") {
    let p: Promise<Response> | undefined;
    listeners.fetch!({ request: { url, method: "GET", mode, destination }, respondWith: (r: Promise<Response>) => { p = r; } });
    return p ? await p : null; // null = not intercepted
  }
  const emoteKeys = async () => [...(stores.get("emote-cache-v3")?.keys() ?? [])];
  return { request, calls, emoteKeys, advance: (ms: number) => { now += ms; }, flushTimers: async () => { while (timers.length) timers.shift()!(); await new Promise((r) => setTimeout(r, 0)); } };
}

const stv = (i: number) => `https://cdn.7tv.app/emote/${i}/1x.webp`;

test("cache-first: a second request is served from the cache, not the network", async () => {
  const env = makeEnv();
  await env.request(stv(1));
  await env.request(stv(1));
  assert.equal(env.calls.filter((c) => c.url === stv(1)).length, 1);
});

test("an <img> fetches at high priority, the warmer's fetch() at low", async () => {
  const env = makeEnv();
  await env.request(stv(1), "image");
  await env.request(stv(2), "");
  assert.equal(env.calls.find((c) => c.url === stv(1))!.init!.priority, "high");
  assert.equal(env.calls.find((c) => c.url === stv(2))!.init!.priority, "low");
});

// The page asks for these emotes in CORS mode (emoteCrossOrigin). On a miss the worker must make
// THAT request — same mode, same credentials — or the browser's HTTP cache copy the page made does
// not match and the emote downloads again (measured on a return visit: 7TV p50 765 ms instead of
// single digits).
test("a CORS-mode request is fetched as the page's own request; a no-cors one keeps the CORS upgrade", async () => {
  const env = makeEnv();
  await env.request(stv(1), "image", "cors");
  const own = env.calls.find((c) => c.url === stv(1))!;
  assert.equal(own.ownRequest, true, "the worker built a request of its own instead of forwarding the page's");
  assert.equal(own.init!.priority, "high");
  assert.deepEqual(await env.emoteKeys(), [stv(1)], "a CORS response from the page's own request is cached");
  await env.request(stv(2), "image", "no-cors");
  const up = env.calls.find((c) => c.url === stv(2))!;
  assert.equal(up.ownRequest, false);
  assert.equal(up.init!.mode, "cors");
});

test("BTTV and Twitch profile pictures are NOT intercepted; Twitch emotes are", async () => {
  const env = makeEnv();
  assert.equal(await env.request("https://cdn.betterttv.net/emote/abc/2x.png"), null);
  assert.equal(await env.request("https://static-cdn.jtvnw.net/jtv_user_pictures/x-profile_image-70x70.png"), null);
  assert.notEqual(await env.request("https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0"), null);
});

test("an error response is returned but never cached", async () => {
  const env = makeEnv({ fail: (u) => u.includes("/9/") });
  const r = await env.request(stv(9));
  assert.equal(r!.status, 404);
  assert.deepEqual(await env.emoteKeys(), []);
});

test("over the cap, the LEAST-RECENTLY-USED go — not the first inserted", async () => {
  const MAX = Number(/EMOTE_CACHE_MAX = (\d+)/.exec(SRC)![1]);
  const env = makeEnv();
  // Fill to the cap, each a millisecond apart; #0 is the oldest INSERTED.
  for (let i = 0; i < MAX; i++) { await env.request(stv(i)); env.advance(1); }
  // …but #0 is then USED again, so it is the most recent.
  env.advance(1000);
  await env.request(stv(0));
  // 20 more puts trigger a sweep (every 20th put).
  for (let i = MAX; i < MAX + 20; i++) { await env.request(stv(i)); env.advance(1); }
  await new Promise((r) => setTimeout(r, 10));
  const keys = new Set(await env.emoteKeys());
  assert.equal(keys.size, MAX);
  assert.ok(keys.has(stv(0)), "the just-used entry was evicted — that is FIFO, not LRU");
  assert.ok(!keys.has(stv(1)), "the least-recently-used entry survived the sweep");
});

test("an entry unused for 30 days is swept even under the cap", async () => {
  const env = makeEnv();
  await env.request(stv(1));
  env.advance(31 * 86_400_000);
  for (let i = 100; i < 120; i++) await env.request(stv(i));
  await new Promise((r) => setTimeout(r, 10));
  const keys = new Set(await env.emoteKeys());
  assert.ok(!keys.has(stv(1)), "a month-old untouched emote is still cached");
  assert.ok(keys.has(stv(119)));
});
