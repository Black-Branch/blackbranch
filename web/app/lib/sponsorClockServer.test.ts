import { test } from "node:test";
import assert from "node:assert/strict";
process.env.STREAM_API_URL ??= "http://stream-api.test"; // streamApi.ts has no default; fetch is stubbed

// Same fetch-stub shape as streamApi.test.ts: the stub records every call and
// answers however the test says.
const calls: Array<{ url: string; init?: RequestInit }> = [];
function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = ((url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return impl(String(url), init);
  }) as typeof fetch;
}
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

const { clockActiveFor, _resetClockCache, CLOCK_CACHE_MS, CLOCK_TIMEOUT_MS } = await import("./sponsorClockServer.ts");

function fresh() { _resetClockCache(); calls.length = 0; }
function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const orig = console.warn; console.warn = () => {};
  return fn().finally(() => { console.warn = orig; });
}

test("asks stream-api for THIS viewer's clock, id URL-encoded, and answers its verdict", async () => {
  fresh();
  stubFetch(() => json({ ok: true, active: true, remainSec: 600 }));
  assert.equal(await clockActiveFor("@eddy:site.test", 0), true);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /\/sponsors\/clock\?matrixId=%40eddy%3Asite\.test$/);
});

test("a lit answer is cached for 30s per viewer — no second request inside the window, a fresh one after it", async () => {
  fresh();
  stubFetch(() => json({ ok: true, active: true, remainSec: 600 }));
  await clockActiveFor("@a:x", 0);
  await clockActiveFor("@a:x", CLOCK_CACHE_MS - 1);
  assert.equal(calls.length, 1, "the second ask must be served from the cache");
  await clockActiveFor("@b:x", CLOCK_CACHE_MS - 1);
  assert.equal(calls.length, 2, "the cache is per viewer");
  stubFetch(() => json({ ok: true, active: false, remainSec: 0 }));
  assert.equal(await clockActiveFor("@a:x", CLOCK_CACHE_MS), false, "past the TTL the new answer wins");
  assert.equal(calls.length, 3);
});

test("an unlit answer is cached too", async () => {
  fresh();
  stubFetch(() => json({ ok: true, active: false, remainSec: 0 }));
  assert.equal(await clockActiveFor("@a:x", 0), false);
  stubFetch(() => json({ ok: true, active: true, remainSec: 9 }));
  assert.equal(await clockActiveFor("@a:x", 1_000), false, "a lit clock starts paying within 30s, not instantly");
});

test("non-2xx → 1x, warned once, and cached like any answer", async () => {
  fresh();
  stubFetch(() => json({ error: "nope" }, 503));
  assert.equal(await quiet(() => clockActiveFor("@a:x", 0)), false);
  assert.equal(await clockActiveFor("@a:x", 1), false);
  assert.equal(calls.length, 1, "a failing stream-api is not hammered once per message");
});

test("a malformed body → 1x", async () => {
  fresh();
  stubFetch(() => json({ nope: 1 }));
  assert.equal(await quiet(() => clockActiveFor("@a:x", 0)), false);
  fresh();
  stubFetch(() => Promise.resolve(new Response("<html>", { status: 200 })));
  assert.equal(await quiet(() => clockActiveFor("@a:x", 0)), false);
});

test("a 200 with the right status but the wrong field names still pays 1x — and now warns loudly instead of silently", async () => {
  // The failure mode item 2 exists for: a route/field rename on the
  // stream-api side (`active` -> `lit`, say) 200s with valid JSON that has
  // neither `ok` nor `active` in the shape clockActiveFor reads. Before this
  // fix that fell through to `false` with NO warning at all — indistinguishable
  // from a perk that simply never lights. See sponsorClockParity.test.ts for
  // the cross-package half of this guard.
  fresh();
  const warnings: unknown[][] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    stubFetch(() => json({ ok: true, lit: true, remainSec: 600 })); // "active" renamed to "lit"
    assert.equal(await clockActiveFor("@a:x", 0), false, "an unrecognized shape must still pay 1x, not throw");
    assert.equal(warnings.length, 1, "a 200'd unexpected shape must warn — silence here is the whole bug");
    assert.match(String(warnings[0]![0]), /unexpected body shape/);
  } finally {
    console.warn = orig;
  }
});

test("a non-matrix-shaped id (a platform message's canonical id, say) answers false with NO round trip and NO warning", async () => {
  // The bug this pins: earnUpvoteReceived's `recipient` is sometimes a
  // PLATFORM message's stream.chat_log.user_id — a 12-char hex canonical id,
  // not a matrix id (web/app/api/chat/vote/route.ts). Before this fix every
  // such call still asked stream-api, which 400'd it — "[coins] clock lookup
  // answered 400 — paying 1x", 56 times on the first live stream. This shape
  // is expected, not a failure, so it must cost neither an HTTP call nor a
  // warning.
  fresh();
  const warnings: unknown[][] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  stubFetch(() => { throw new Error("must not be called for a non-matrix id"); });
  try {
    assert.equal(await clockActiveFor("a60500127435", 0), false, "a canonical id must pay 1x, not throw or hang");
    assert.equal(calls.length, 0, "no HTTP round trip for an id that cannot possibly be a matrix id");
    assert.equal(warnings.length, 0, "this shape is expected (a platform recipient with no site wallet), not a stream-api failure — no warning");
  } finally {
    console.warn = orig;
  }
  // A handful of other shapes a canonical id or a bad caller might pass —
  // none of these are `@user:server` and none may reach fetch either.
  for (const bad of ["", "eddy", "@eddy", "@eddy site.test", "not-an-id-at-all"]) {
    assert.equal(await clockActiveFor(bad, 1), false, `"${bad}" must pay 1x without a round trip`);
  }
  assert.equal(calls.length, 0, "none of the malformed shapes above may have reached fetch");
});

test("a well-formed matrix id still takes the normal path (round trip + cache)", async () => {
  fresh();
  stubFetch(() => json({ ok: true, active: true, remainSec: 600 }));
  assert.equal(await clockActiveFor("@eddy:site.test", 0), true);
  assert.equal(calls.length, 1, "a real matrix id must still make the round trip");
});

test("a well-shaped 200 body warns nothing", async () => {
  fresh();
  const warnings: unknown[][] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    stubFetch(() => json({ ok: true, active: true, remainSec: 600 }));
    assert.equal(await clockActiveFor("@a:x", 0), true);
    assert.equal(warnings.length, 0, "a correctly-shaped answer must not warn");
  } finally {
    console.warn = orig;
  }
});

test("fetch throwing → 1x; the caller never sees a throw", async () => {
  fresh();
  stubFetch(() => Promise.reject(new Error("ECONNREFUSED")));
  assert.equal(await quiet(() => clockActiveFor("@a:x", 0)), false);
});

test("the call carries the 2s deadline — a hung stream-api resolves false, not never", { timeout: 6_000 }, async () => {
  fresh();
  assert.equal(CLOCK_TIMEOUT_MS, 2_000, "the published deadline");
  stubFetch((_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
  }));
  const t0 = Date.now();
  assert.equal(await quiet(() => clockActiveFor("@a:x", 0)), false);
  const took = Date.now() - t0;
  assert.ok(took >= 1_900 && took < 4_000, `resolved after ${took}ms — the deadline must be the 2s one, not streamApi's 10s`);
});
