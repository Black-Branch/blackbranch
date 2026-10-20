import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";

// ── streamApiFetch carries a deadline ────────────────────────────────────────
//
// Every OTHER cross-service call in the stack has a timeout (tts, notify,
// lights, twitch-app, account-age…). This one did not — and it is the one on
// the money path: a sticker spend debits the wallet, then awaits
// `/chat/event` through this wrapper. "stream-api down" fails fast
// (ECONNREFUSED), but "stream-api accepting and not answering" — exactly what
// a blocked event loop produces — held the user's request open for undici's
// default socket lifetime with the debit already taken; the refund only fires
// after the eventual failure. A deadline here bounds every caller at once.

const captured: RequestInit[] = [];
function stubFetch(impl?: (init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
    captured.push(init ?? {});
    return impl ? impl(init) : Promise.resolve(new Response("{}"));
  }) as typeof fetch;
}

process.env.STREAM_API_URL = "http://stream-api.test";
const { streamApiFetch, streamApiBase } = await import("./streamApi.ts");

test("every stream-api call carries an abort signal that fires at the deadline", async () => {
  stubFetch();
  await streamApiFetch("/stream/current", undefined, 10);
  const signal = captured.at(-1)?.signal;
  assert.ok(signal instanceof AbortSignal, "fetch must be given a deadline signal");
  assert.equal(signal.aborted, false, "…not one that is already dead");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(signal.aborted, true, "the deadline must actually fire");
});

// { timeout } is load-bearing: if the call NEVER settles (the bug this
// guards), an unbounded await here wedges the whole test runner instead of
// going red.
test("a timed-out call rejects instead of hanging", { timeout: 2000 }, async () => {
  // Emulates what real fetch does on abort — rejects when the signal fires.
  stubFetch(
    (init) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(new Error("aborted")));
      }),
  );
  await assert.rejects(
    () => streamApiFetch("/chat/event", { method: "POST" }, 10),
    /aborted/,
    "the caller must get control back at the deadline",
  );
});

test("a caller-supplied signal still aborts the request before the deadline", async () => {
  stubFetch();
  const controller = new AbortController();
  await streamApiFetch("/stream/current", { signal: controller.signal }, 60_000);
  const signal = captured.at(-1)?.signal;
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, false);
  controller.abort();
  assert.equal(signal.aborted, true, "composing the deadline must not eat the caller's signal");
});

// ── STREAM_API_URL has no default ─────────────────────────────────────────────
//
// A default host means an unset env silently calls a machine that may no
// longer run the service.

test("an unset STREAM_API_URL rejects with a named error and never calls fetch", async () => {
  const before = process.env.STREAM_API_URL;
  delete process.env.STREAM_API_URL;
  let called = 0;
  globalThis.fetch = (() => { called++; return Promise.resolve(new Response("{}")); }) as typeof fetch;
  try {
    assert.throws(() => streamApiBase(), /STREAM_API_URL is not set/);
    // A rejection, not a synchronous throw — callers chain .catch() on this.
    const p = streamApiFetch("/stream/current");
    assert.ok(p instanceof Promise);
    await assert.rejects(p, /STREAM_API_URL is not set/);
  } finally {
    process.env.STREAM_API_URL = before;
  }
  assert.equal(called, 0, "an unset URL must not reach the network");
});

test("the base is the env value, trailing slash trimmed, read at call time", async () => {
  const before = process.env.STREAM_API_URL;
  process.env.STREAM_API_URL = "http://127.0.0.1:3001/";
  let url = "";
  globalThis.fetch = ((u: unknown) => { url = String(u); return Promise.resolve(new Response("{}")); }) as typeof fetch;
  try {
    await streamApiFetch("/stream/current");
  } finally {
    process.env.STREAM_API_URL = before;
  }
  assert.equal(url, "http://127.0.0.1:3001/stream/current");
});

test("instrumentation refuses to boot without it", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "..", "instrumentation.ts"), "utf8");
  const body = stripComments(src);
  // Positive assertions on the register() body; the call must come before the
  // first background job is started.
  const check = body.indexOf("streamApiBase()");
  assert.ok(check > 0, "instrumentation.ts must call streamApiBase() at boot");
  assert.ok(check < body.indexOf("startGiftExpirySweep()"), "…before any background job starts");
  // An EXIT: a throw in register() leaves Next alive and serving nothing
  // ("Failed to prepare server", measured against the standalone build).
  // (The first exit of register() is the install values', so look after the check.)
  const exit = body.indexOf("process.exit(1)", check);
  assert.ok(exit > check && exit < body.indexOf("startGiftExpirySweep()"), "a missing URL must exit the process");
});
