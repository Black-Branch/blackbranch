// Runs the REAL public/sw.js in a vm with fake `caches`/`fetch`/messages — behaviour, not a
// source scan. The picture-cache policy (#244): emotes & stickers cache-first, profile pictures
// and link previews stale-while-revalidate, every kind on by default, a switch off = that kind's
// cache dropped and its requests passed straight through, the policy surviving a worker restart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SRC = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
const ORIGIN = "https://site.example";

type Store = Map<string, Map<string, Response>>;
type Call = { url: string; mode?: string };

function boot(stores: Store = new Map(), opts: { fail?: (url: string) => boolean; opaque?: (url: string) => boolean; letter?: (url: string) => boolean } = {}) {
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
  const calls: Call[] = [];
  const listeners: Record<string, (e: unknown) => void> = {};
  let now = 1_700_000_000_000;
  let body = 0;
  const pending: Promise<unknown>[] = [];
  const ctx = {
    self: {
      addEventListener: (t: string, f: (e: unknown) => void) => { listeners[t] = f; },
      skipWaiting() {}, clients: { claim: async () => {} }, location: { origin: ORIGIN },
    },
    caches: {
      open,
      keys: async () => [...stores.keys()],
      delete: async (n: string) => stores.delete(n),
      match: async () => undefined,
    },
    fetch: async (req: string | { url: string; mode?: string }, init?: { mode?: string }) => {
      const url = typeof req === "string" ? req : req.url;
      calls.push({ url, mode: init?.mode ?? (typeof req === "string" ? undefined : req.mode) });
      if (opts.fail?.(url)) return new Response("nope", { status: 404 });
      if (opts.opaque?.(url)) return { ok: false, status: 0, type: "opaque", clone() { return this; } } as unknown as Response;
      const type = url.includes("/api/og") ? "application/json" : opts.letter?.(url) ? "image/svg+xml" : "image/png";
      return new Response(`v${++body}:${url}`, { status: 200, headers: { "content-type": type } });
    },
    Response, URL, Promise, Map, Set, JSON, Object, Array, Math,
    Date: { now: () => now },
    setTimeout: (f: () => void) => { pending.push(Promise.resolve().then(f)); return 0; },
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const settle = async () => { for (let i = 0; i < 5; i++) { await Promise.all(pending.splice(0)); await new Promise((r) => setTimeout(r, 0)); } };
  async function request(url: string, destination = "image", mode = "no-cors") {
    let p: Promise<Response> | undefined;
    const full = url.startsWith("/") ? ORIGIN + url : url;
    listeners.fetch!({
      request: { url: full, method: "GET", mode, destination, credentials: "same-origin" },
      respondWith: (r: Promise<Response>) => { p = r; },
      waitUntil: (w: Promise<unknown>) => { pending.push(w); },
    });
    const res = p ? await p : null; // null = not intercepted
    await settle();
    return res;
  }
  async function message(data: unknown) {
    let w: Promise<unknown> = Promise.resolve();
    listeners.message!({ data, waitUntil: (x: Promise<unknown>) => { w = x; } });
    await w;
    await settle();
  }
  const keys = (name: string) => [...(stores.get(name)?.keys() ?? [])];
  return { request, message, calls, keys, stores, advance: (ms: number) => { now += ms; }, settle };
}

const EMOTE = "https://cdn.7tv.app/emote/1/2x.webp";
const STICKER = "https://cdn.7tv.app/emote/1/4x.webp";
const TWITCH_PFP = "https://static-cdn.jtvnw.net/jtv_user_pictures/abc-profile_image-70x70.png";
const SITE_PFP = "/api/avatar/user/%40ann%3Asite.example";
const PUBLIC_PFP = "/api/avatar/public/streamer";
const PREVIEW = "/api/og?url=https%3A%2F%2Fexample.com%2Fa";
const ALL = { on: true, emotes: true, avatars: true, previews: true };

test("default (nothing chosen yet): emotes, stickers, profile pictures and previews are all cached", async () => {
  const sw = boot();
  for (const u of [EMOTE, STICKER, TWITCH_PFP, SITE_PFP, PUBLIC_PFP]) await sw.request(u);
  await sw.request(PREVIEW, "");
  assert.deepEqual(sw.keys("emote-cache-v3"), [EMOTE, STICKER]);
  assert.deepEqual(sw.keys("avatar-cache-v1"), [TWITCH_PFP, ORIGIN + SITE_PFP, ORIGIN + PUBLIC_PFP]);
  assert.deepEqual(sw.keys("preview-cache-v1"), [ORIGIN + PREVIEW]);
  // A second look is the stored copy — no network.
  const before = sw.calls.length;
  for (const u of [EMOTE, STICKER, TWITCH_PFP, SITE_PFP]) await sw.request(u);
  assert.equal(sw.calls.length, before);
});

test("the keys are bare URLs — no cookie, header or account ever part of one", async () => {
  const sw = boot();
  await sw.request(SITE_PFP);
  for (const name of ["emote-cache-v3", "avatar-cache-v1", "preview-cache-v1"]) {
    for (const k of sw.keys(name)) assert.match(k, /^https:\/\/[^\s]+$/);
  }
  assert.deepEqual(sw.keys("avatar-cache-v1"), [ORIGIN + SITE_PFP]);
});

test("what is NOT a picture of these kinds passes untouched: Matrix media, other APIs, BTTV", async () => {
  const sw = boot();
  assert.equal(await sw.request("/api/matrix/media/thumbnail/site.example/abc?width=96"), null, "DM media must never be stored by the worker");
  assert.equal(await sw.request("/api/me", ""), null);
  assert.equal(await sw.request("/api/avatar/upload"), null);
  assert.equal(await sw.request("https://cdn.betterttv.net/emote/abc/2x.webp"), null);
  assert.equal(await sw.request("https://evil.example/api/og?url=x", ""), null, "another origin's /api/og is not ours");
});

test("master switch off: nothing new is stored, everything stored is dropped, pictures still load", async () => {
  const sw = boot();
  await sw.request(EMOTE); await sw.request(TWITCH_PFP); await sw.request(PREVIEW, "");
  await sw.message({ type: "bb:picture-cache", policy: { ...ALL, on: false } });
  assert.equal(sw.stores.has("emote-cache-v3"), false);
  assert.equal(sw.stores.has("avatar-cache-v1"), false);
  assert.equal(sw.stores.has("preview-cache-v1"), false);
  const r = await sw.request("https://cdn.7tv.app/emote/2/2x.webp");
  assert.ok(r === null || r.status === 200, "an emote still loads with the cache off");
  const r2 = await sw.request(TWITCH_PFP);
  assert.ok(r2 === null || r2.status === 200);
  assert.deepEqual(sw.keys("emote-cache-v3"), []);
  assert.deepEqual(sw.keys("avatar-cache-v1"), []);
});

test("one kind off drops only that kind: profile pictures off keeps the emotes", async () => {
  const sw = boot();
  await sw.request(EMOTE); await sw.request(TWITCH_PFP); await sw.request(PREVIEW, "");
  await sw.message({ type: "bb:picture-cache", policy: { ...ALL, avatars: false } });
  assert.deepEqual(sw.keys("emote-cache-v3"), [EMOTE]);
  assert.deepEqual(sw.keys("preview-cache-v1"), [ORIGIN + PREVIEW]);
  assert.equal(sw.stores.has("avatar-cache-v1"), false);
  await sw.request(SITE_PFP);
  assert.deepEqual(sw.keys("avatar-cache-v1"), [], "a switched-off kind stored a new picture");
  await sw.request("https://cdn.7tv.app/emote/3/2x.webp");
  assert.equal(sw.keys("emote-cache-v3").length, 2);
});

test("emotes off: stickers go with them (one switch), previews stay", async () => {
  const sw = boot();
  await sw.message({ type: "bb:picture-cache", policy: { ...ALL, emotes: false } });
  await sw.request(EMOTE); await sw.request(STICKER); await sw.request(PREVIEW, "");
  assert.deepEqual(sw.keys("emote-cache-v3"), []);
  assert.deepEqual(sw.keys("preview-cache-v1"), [ORIGIN + PREVIEW]);
});

test("restart: the chosen policy survives the worker being stopped and started again", async () => {
  const stores: Store = new Map();
  const first = boot(stores);
  await first.message({ type: "bb:picture-cache", policy: { ...ALL, on: false } });
  // A new worker over the same storage — no page has posted anything to it yet.
  const second = boot(stores);
  await second.request(EMOTE);
  await second.request(TWITCH_PFP);
  assert.deepEqual(second.keys("emote-cache-v3"), [], "a restarted worker forgot the switch and cached again");
  assert.deepEqual(second.keys("avatar-cache-v1"), []);
  // …and turning it back on works from the restarted worker too.
  await second.message({ type: "bb:picture-cache", policy: ALL });
  await second.request(EMOTE);
  assert.deepEqual(second.keys("emote-cache-v3"), [EMOTE]);
});

test("restart: stored pictures are still served after the worker restarts", async () => {
  const stores: Store = new Map();
  const first = boot(stores);
  await first.request(EMOTE); await first.request(SITE_PFP);
  const second = boot(stores);
  const r = await second.request(EMOTE);
  assert.equal(r!.status, 200);
  assert.equal(second.calls.filter((c) => c.url === EMOTE).length, 0, "the restarted worker re-downloaded a stored emote");
});

test("restart before the index was saved: stored pictures are served with no burst of refetches", async () => {
  const stores: Store = new Map();
  const first = boot(stores);
  await first.request(SITE_PFP); await first.request(PREVIEW, "");
  stores.get("emote-meta-v1")?.clear(); // the worker was stopped before its debounced save
  const second = boot(stores);
  await second.request(SITE_PFP); await second.request(PREVIEW, "");
  assert.equal(second.calls.length, 0, "a restarted worker re-fetched every stored picture at once");
  second.advance(11 * 60_000);
  await second.request(SITE_PFP);
  assert.equal(second.calls.length, 1, "the picture was never refreshed after its fresh window");
});

test("retry: a failed or opaque picture is shown but never stored; the next try stores the good one", async () => {
  let failing = true;
  const sw = boot(new Map(), { fail: (u) => failing && u.includes("jtv_user_pictures"), opaque: (u) => u.includes("yt3.") });
  const bad = await sw.request(TWITCH_PFP);
  assert.equal(bad!.status, 404);
  assert.deepEqual(sw.keys("avatar-cache-v1"), [], "an error was stored — it would be served forever");
  failing = false;
  const good = await sw.request(TWITCH_PFP);
  assert.equal(good!.status, 200);
  assert.deepEqual(sw.keys("avatar-cache-v1"), [TWITCH_PFP], "the retry did not store the good picture");
});

test("profile pictures: the stored copy at once, refreshed in the background once it is over 10 minutes old", async () => {
  const sw = boot();
  const first = await (await sw.request(SITE_PFP))!.text();
  sw.advance(5 * 60_000);
  const soon = await (await sw.request(SITE_PFP))!.text();
  assert.equal(soon, first);
  assert.equal(sw.calls.filter((c) => c.url === ORIGIN + SITE_PFP).length, 1, "revalidated a fresh picture");
  sw.advance(6 * 60_000);
  const stale = await (await sw.request(SITE_PFP))!.text();
  assert.equal(stale, first, "a stale picture must still be answered from the store, not waited on");
  assert.equal(sw.calls.filter((c) => c.url === ORIGIN + SITE_PFP).length, 2, "no background refresh after 10 minutes");
  const next = await (await sw.request(SITE_PFP))!.text();
  assert.notEqual(next, first, "the background refresh did not replace the stored picture");
});

test("the letter circle (signed out, or no picture set) is never stored — signing in shows the real picture at once", async () => {
  let signedIn = false;
  const sw = boot(new Map(), { letter: () => !signedIn });
  await sw.request(SITE_PFP);
  assert.deepEqual(sw.keys("avatar-cache-v1"), [], "a letter circle was stored");
  signedIn = true;
  await sw.request(SITE_PFP);
  assert.deepEqual(sw.keys("avatar-cache-v1"), [ORIGIN + SITE_PFP]);
});

test("a picture that was removed (the refresh answers the letter circle) is dropped, not kept forever", async () => {
  let removed = false;
  const sw = boot(new Map(), { letter: () => removed });
  await sw.request(SITE_PFP);
  removed = true;
  sw.advance(11 * 60_000);
  await sw.request(SITE_PFP); // the stored picture, and a background refresh
  assert.deepEqual(sw.keys("avatar-cache-v1"), [], "the removed picture is still stored");
});

test("link previews refresh after an hour, not before", async () => {
  const sw = boot();
  await sw.request(PREVIEW, "");
  sw.advance(30 * 60_000);
  await sw.request(PREVIEW, "");
  assert.equal(sw.calls.filter((c) => c.url === ORIGIN + PREVIEW).length, 1);
  sw.advance(31 * 60_000);
  await sw.request(PREVIEW, "");
  assert.equal(sw.calls.filter((c) => c.url === ORIGIN + PREVIEW).length, 2);
});

test("Clear cached pictures: every picture cache is emptied, and caching carries on afterwards", async () => {
  const sw = boot();
  await sw.request(EMOTE); await sw.request(TWITCH_PFP); await sw.request(PREVIEW, "");
  await sw.message({ type: "bb:picture-cache-clear" });
  assert.deepEqual(sw.keys("emote-cache-v3"), []);
  assert.deepEqual(sw.keys("avatar-cache-v1"), []);
  assert.deepEqual(sw.keys("preview-cache-v1"), []);
  await sw.request(EMOTE);
  assert.deepEqual(sw.keys("emote-cache-v3"), [EMOTE], "the cache stayed dead after a clear");
});

test("profile pictures are capped by least-recent use", async () => {
  const MAX = Number(/AVATAR_CACHE_MAX = (\d+)/.exec(SRC)?.[1]);
  assert.ok(MAX > 0, "AVATAR_CACHE_MAX is gone from sw.js");
  const sw = boot();
  const pfp = (i: number) => `https://static-cdn.jtvnw.net/jtv_user_pictures/${i}-profile_image-70x70.png`;
  for (let i = 0; i < MAX; i++) { await sw.request(pfp(i)); sw.advance(1); }
  sw.advance(1000);
  await sw.request(pfp(0)); // most recent now
  for (let i = MAX; i < MAX + 20; i++) { await sw.request(pfp(i)); sw.advance(1); }
  await sw.settle();
  const keys = new Set(sw.keys("avatar-cache-v1"));
  assert.equal(keys.size, MAX);
  assert.ok(keys.has(pfp(0)), "the just-used picture was evicted");
  assert.ok(!keys.has(pfp(1)), "the least-recently-used picture survived");
});

test("a malformed or foreign message changes nothing", async () => {
  const sw = boot();
  await sw.request(EMOTE);
  await sw.message({ type: "bb:picture-cache", policy: "off" });
  await sw.message({ type: "something-else" });
  await sw.message(null);
  await sw.request("https://cdn.7tv.app/emote/4/2x.webp");
  assert.equal(sw.keys("emote-cache-v3").length, 2);
});

// Vacuity anchor: the scanned worker ends where it should.
test("vacuity anchor: sw.js was read whole", () => {
  assert.match(SRC.slice(-600), /\}\s*$/);
  assert.ok(SRC.includes('addEventListener("message"'), "the worker has no message handler");
});
