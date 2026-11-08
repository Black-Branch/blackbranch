// The WHEP relay's policy, executed against a fake fetch.
//
// The route it serves is one Node process shared with the whole site, so
// forwarding with no deadline and without passing the client's abort along
// lets a stalling playback node × (retries per viewer + manual retries) pile
// up open handlers. Discovery caching must not cache a FAILURE for the full
// minute, and one viewer's 4xx must not evict the cache for everyone
// mid-burst.
//
// Run: node --test app/lib/whepProxy.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { format } from "node:util";
import { readFileSync } from "node:fs";
import { createWhepProxy } from "./whepProxy.ts";
import { BUSY_RETRY_S } from "./whepEscalation.ts";
import { stripComments } from "./testSource.ts";

const DID = "did:plc:example";
const OFFER = "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n";

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function fakeFetch(handler: Handler) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const discovered = (servers: unknown) => Response.json({ servers });
const answer = (body = "v=0 answer", status = 201) =>
  new Response(body, { status, headers: { "content-type": "application/sdp" } });
/** A response that never arrives — rejects only when the request's signal aborts. */
const never = (init?: RequestInit) =>
  new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
const isDiscovery = (url: string) => url.includes("getPlaybackServer");

test("the offer is forwarded to the discovered server with the DID and the rendition", async () => {
  const { fetch, calls } = fakeFetch((url) => (isDiscovery(url) ? discovered(["https://node-1.stream.place"]) : answer()));
  const proxy = createWhepProxy({ fetch, did: DID });
  const r = await proxy.exchange(OFFER, "audio", new AbortController().signal);
  assert.deepEqual(r, { kind: "answer", status: 201, body: "v=0 answer", server: "https://node-1.stream.place" });
  const post = calls.find((c) => !isDiscovery(c.url))!;
  assert.equal(post.url, `https://node-1.stream.place/xrpc/place.stream.playback.whep?streamer=${encodeURIComponent(DID)}&rendition=audio`);
  assert.equal(post.init?.method, "POST");
  assert.equal(post.init?.body, OFFER);
  assert.ok(post.init?.signal, "the forward must carry a signal");
});

test("discovery is single-flight and cached for a minute on success", async () => {
  let t = 0;
  const { fetch, calls } = fakeFetch((url) => (isDiscovery(url) ? discovered(["https://node-1.stream.place"]) : answer()));
  const proxy = createWhepProxy({ fetch, did: DID, now: () => t });
  const sig = new AbortController().signal;
  await Promise.all([proxy.exchange(OFFER, "source", sig), proxy.exchange(OFFER, "source", sig)]);
  assert.equal(calls.filter((c) => isDiscovery(c.url)).length, 1, "two concurrent exchanges share one discovery");
  await proxy.exchange(OFFER, "source", sig);
  assert.equal(calls.filter((c) => isDiscovery(c.url)).length, 1, "cached");
  t = 60_001;
  await proxy.exchange(OFFER, "source", sig);
  assert.equal(calls.filter((c) => isDiscovery(c.url)).length, 2, "re-discovered after the TTL");
});

test("a discovery failure is NOT cached — the node serves this exchange and the next call re-discovers", async () => {
  let fail = true;
  const { fetch, calls } = fakeFetch((url) => {
    if (isDiscovery(url)) { if (fail) throw new Error("discovery down"); return discovered(["https://node-2.stream.place"]); }
    return answer();
  });
  const proxy = createWhepProxy({ fetch, did: DID });
  const sig = new AbortController().signal;
  await proxy.exchange(OFFER, "source", sig);
  assert.match(calls.at(-1)!.url, /^https:\/\/stream\.place\/xrpc\/place\.stream\.playback\.whep/, "the bare node carried this exchange");
  fail = false;
  await proxy.exchange(OFFER, "source", sig);
  assert.equal(calls.filter((c) => isDiscovery(c.url)).length, 2, "the failure was not remembered");
  assert.match(calls.at(-1)!.url, /^https:\/\/node-2\.stream\.place\//);
});

test("a discovered server outside the allowlist is ignored", async () => {
  for (const bad of ["http://localhost:8008", "https://evil.example", "https://stream.place.evil.example", "https://evilstream.place"]) {
    const { fetch, calls } = fakeFetch((url) => (isDiscovery(url) ? discovered([bad]) : answer()));
    const proxy = createWhepProxy({ fetch, did: DID });
    await proxy.exchange(OFFER, "source", new AbortController().signal);
    assert.match(calls.at(-1)!.url, /^https:\/\/stream\.place\//, `${bad} must not be forwarded to`);
  }
});

test("a 4xx answer keeps the discovered server; a 5xx drops it", async () => {
  let status = 400;
  const { fetch, calls } = fakeFetch((url) => (isDiscovery(url) ? discovered(["https://node-1.stream.place"]) : answer("bad", status)));
  const proxy = createWhepProxy({ fetch, did: DID });
  const sig = new AbortController().signal;
  const warnings: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    const bad = await proxy.exchange(OFFER, "source", sig);
    assert.deepEqual(bad, { kind: "answer", status: 400, body: "bad", server: "https://node-1.stream.place" });
    await proxy.exchange(OFFER, "source", sig);
    assert.equal(calls.filter((c) => isDiscovery(c.url)).length, 1, "one viewer's bad offer must not reset discovery for everyone");
    status = 502;
    await proxy.exchange(OFFER, "source", sig);
    await proxy.exchange(OFFER, "source", sig);
    assert.equal(calls.filter((c) => isDiscovery(c.url)).length, 2, "a server-side failure re-discovers");
  } finally {
    console.warn = original;
  }
  // Every non-2xx answer (two 400s, two 502s) warns — this is the same
  // upstream-trouble warn under test elsewhere, exercised here for its OTHER
  // job (never suppressing the 4xx-keeps/5xx-drops cache behavior above).
  assert.equal(warnings.length, 4);
});

test("a network failure drops the cached server and reports unreachable", async () => {
  let boom = false;
  const { fetch, calls } = fakeFetch((url) => {
    if (isDiscovery(url)) return discovered(["https://node-1.stream.place"]);
    if (boom) throw new TypeError("fetch failed");
    return answer();
  });
  const proxy = createWhepProxy({ fetch, did: DID });
  const sig = new AbortController().signal;
  const warnings: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    await proxy.exchange(OFFER, "source", sig);
    boom = true;
    assert.deepEqual(await proxy.exchange(OFFER, "source", sig), { kind: "unreachable", server: "https://node-1.stream.place" });
    boom = false;
    await proxy.exchange(OFFER, "source", sig);
    assert.equal(calls.filter((c) => isDiscovery(c.url)).length, 2);
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1);
});

test("an upstream that never answers is cut off by the deadline", { timeout: 2_000 }, async () => {
  const { fetch } = fakeFetch((url, init) => (isDiscovery(url) ? discovered(["https://node-1.stream.place"]) : never(init)));
  const proxy = createWhepProxy({ fetch, did: DID, timeoutMs: 20 });
  const warnings: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    assert.deepEqual(await proxy.exchange(OFFER, "source", new AbortController().signal), { kind: "unreachable", server: "https://node-1.stream.place" });
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1);
});

test("a client that goes away is reported as aborted, and the server stays cached", { timeout: 2_000 }, async () => {
  let hang = true;
  const { fetch, calls } = fakeFetch((url, init) => {
    if (isDiscovery(url)) return discovered(["https://node-1.stream.place"]);
    return hang ? never(init) : answer();
  });
  const proxy = createWhepProxy({ fetch, did: DID, timeoutMs: 5_000 });
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 5);
  assert.deepEqual(await proxy.exchange(OFFER, "source", ctrl.signal), { kind: "aborted" });
  // The client's abort must reach the upstream request itself, not just be
  // read back after the deadline separately fires. Under the defect this
  // fixes, the forwarded signal was the bare deadline (still live at 5ms).
  const forward = calls.find((c) => !isDiscovery(c.url))!;
  assert.equal(forward.init?.signal?.aborted, true, "the client's abort must reach the upstream request itself, not just the result");
  // The next viewer must not pay for re-discovery because someone closed a tab.
  hang = false;
  await proxy.exchange(OFFER, "source", new AbortController().signal);
  assert.equal(calls.filter((c) => isDiscovery(c.url)).length, 1);
});

test("the journal tells the node from the viewer: a slow answer and a viewer who gave up each leave a line", { timeout: 2_000 }, async () => {
  let t = 0;
  let hang = false;
  const { fetch } = fakeFetch((url, init) => {
    if (isDiscovery(url)) return discovered(["https://node-1.stream.place"]);
    if (hang) return never(init);
    t += 3000; // the node takes three seconds
    return answer();
  });
  const proxy = createWhepProxy({ fetch, did: DID, now: () => t, timeoutMs: 5_000 });
  const warnings: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    await proxy.exchange(OFFER, "source", new AbortController().signal);
    hang = true;
    const ctrl = new AbortController();
    setTimeout(() => { t += 4000; ctrl.abort(); }, 5);
    assert.deepEqual(await proxy.exchange(OFFER, "source", ctrl.signal), { kind: "aborted" });
  } finally {
    console.warn = original;
  }
  assert.deepEqual(warnings, [
    ["[whep] slow answer %d ms from %s", 3000, "https://node-1.stream.place"],
    ["[whep] viewer gave up after %d ms; %s had not answered", 4000, "https://node-1.stream.place"],
  ]);
});

test("the relay's deadline is the one the player waits out (whepEscalation's SIGNAL_DEADLINE_MS is derived from it)", async () => {
  const { WHEP_RELAY_TIMEOUT_MS, SIGNAL_DEADLINE_MS, ICE_GATHER_CAP_MS } = await import("./whepEscalation.ts");
  const src = (await import("node:fs")).readFileSync(new URL("./whepProxy.ts", import.meta.url), "utf8");
  assert.match(src, /timeoutMs = WHEP_RELAY_TIMEOUT_MS,/);
  assert.ok(SIGNAL_DEADLINE_MS > ICE_GATHER_CAP_MS + WHEP_RELAY_TIMEOUT_MS);
});

test("an upstream 500 is warned and the answer still names the server", async () => {
  const { fetch } = fakeFetch((url) => (isDiscovery(url) ? discovered(["https://node-1.stream.place"]) : answer("boom", 500)));
  const proxy = createWhepProxy({ fetch, did: DID });
  const warnings: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    const r = await proxy.exchange(OFFER, "source", new AbortController().signal);
    assert.deepEqual(r, { kind: "answer", status: 500, body: "boom", server: "https://node-1.stream.place" });
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1);
  assert.match(format(...(warnings[0] ?? [])), /upstream 500 from/);
});

test("a fetch that throws is warned as unreachable", async () => {
  const { fetch } = fakeFetch((url) => {
    if (isDiscovery(url)) return discovered(["https://node-1.stream.place"]);
    throw new TypeError("fetch failed");
  });
  const proxy = createWhepProxy({ fetch, did: DID });
  const warnings: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    const r = await proxy.exchange(OFFER, "source", new AbortController().signal);
    assert.deepEqual(r, { kind: "unreachable", server: "https://node-1.stream.place" });
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1);
  assert.match(format(...(warnings[0] ?? [])), /unreachable: https:\/\/node-1\.stream\.place/);
});

// A 429 is "busy", not a broken transport: the player waits and tries again by
// itself, and Retry-After says how long. The node's own header is passed on; a
// 429 without one gets BUSY_RETRY_S, the same value the relay's own limit sends.
test("a 429 carries Retry-After — the node's own, else the default", async () => {
  const quiet = console.warn;
  console.warn = () => {};
  try {
    const withHeader = fakeFetch((url) => (isDiscovery(url) ? discovered(["https://node-1.stream.place"])
      : new Response("slow down", { status: 429, headers: { "retry-after": "7" } })));
    const a = await createWhepProxy({ fetch: withHeader.fetch, did: DID }).exchange(OFFER, "source", new AbortController().signal);
    assert.deepEqual(a, { kind: "answer", status: 429, body: "slow down", server: "https://node-1.stream.place", retryAfter: "7" });

    const bare = fakeFetch((url) => (isDiscovery(url) ? discovered(["https://node-1.stream.place"]) : new Response("", { status: 429 })));
    const b = await createWhepProxy({ fetch: bare.fetch, did: DID }).exchange(OFFER, "source", new AbortController().signal);
    assert.equal(b.kind === "answer" ? b.retryAfter : null, String(BUSY_RETRY_S));

    const ok = fakeFetch((url) => (isDiscovery(url) ? discovered(["https://node-1.stream.place"]) : answer()));
    const c = await createWhepProxy({ fetch: ok.fetch, did: DID }).exchange(OFFER, "source", new AbortController().signal);
    assert.ok(!("retryAfter" in c), "only a 429 says when to come back");
  } finally {
    console.warn = quiet;
  }
});

test("the relay's own per-address limit answers 429 with the same Retry-After", () => {
  const route = stripComments(readFileSync(new URL("../api/streamplace/whep/route.ts", import.meta.url), "utf8"));
  assert.match(route, /status: 429, headers: \{ "retry-after": String\(BUSY_RETRY_S\) \}/, "the limiter's 429 must say when to come back");
  assert.match(route, /\.\.\.\(r\.retryAfter \? \{ "retry-after": r\.retryAfter \} : \{\}\)/, "a node's 429 must reach the player with its Retry-After");
  assert.match(route.trimEnd(), /  \}\);\n\}$/, "END anchor: the whole route was read");
});
