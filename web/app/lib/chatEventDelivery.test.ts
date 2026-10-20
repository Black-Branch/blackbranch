// The refund decision for a coin spend, made honestly.
//
// The lived bug: streamApiFetch's 10s deadline aborts the WAIT, not
// stream-api's WORK. A slow DB meant /chat/event went on to credit the
// ledger, bar and timer while this side saw its abort and refunded the coins
// — the viewer kept the Qorm AND the bar moved, for every concurrent spend,
// for the stall's duration. "Never credit both ends" broken by a timeout.
//
// Four outcomes, and only two of them may refund:
//   delivered    → 2xx (including a deduped replay).
//   refused      → stream-api ANSWERED with a refusal that provably credited
//                  nothing: 4xx validation, or effects_failed (whose handler
//                  documents "an escaping throw can only mean nothing was
//                  credited"). Refund safe.
//   undelivered  → the request never left (connection refused / DNS).
//                  Refund safe: there is nothing on the other side.
//   unconfirmed  → timeout, 409 in_flight, or an unclassifiable 5xx. NO
//                  refund — refunding here IS the double-credit.
// A timeout gets ONE immediate retry before landing in unconfirmed — legal
// only because /chat/event dedups on spendId and replays the original
// outcome verbatim.
//
// Run: node --test app/lib/chatEventDelivery.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { deliverChatEvent, broadcastChatEvent } from "./chatEventDelivery.ts";
process.env.STREAM_API_URL ??= "http://stream-api.test"; // no default (streamApi.ts); fetch is stubbed

type FetchLike = typeof globalThis.fetch;
function stubFetch(impl: (...args: Parameters<FetchLike>) => ReturnType<FetchLike>) {
  (globalThis as unknown as { fetch: unknown }).fetch = impl;
}
const json = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  }));

const SPEND = { kind: "sticker", spendId: "spend-1", coins: 500 };

test("2xx → delivered, body surfaced", async () => {
  stubFetch(() => json(200, { ok: true, id: 42 }));
  const out = await deliverChatEvent(SPEND);
  assert.equal(out.outcome, "delivered");
  if (out.outcome === "delivered") assert.equal(out.body.id, 42);
});

test("4xx refusal → refused (refund is safe: nothing was credited)", async () => {
  stubFetch(() => json(404, { error: "not_a_sticker" }));
  const out = await deliverChatEvent(SPEND);
  assert.equal(out.outcome, "refused");
  if (out.outcome === "refused") assert.equal(out.status, 404);
});

test("effects_failed 500 → refused — its handler guarantees nothing was credited", async () => {
  stubFetch(() => json(500, { ok: false, error: "effects_failed", kind: "sticker" }));
  const out = await deliverChatEvent(SPEND);
  assert.equal(out.outcome, "refused");
});

test("an unclassifiable 5xx → unconfirmed — the crash may sit AFTER the credit", async () => {
  stubFetch(() => json(500, { error: "internal" }));
  assert.equal((await deliverChatEvent(SPEND)).outcome, "unconfirmed");
});

test("409 in_flight → unconfirmed — the first delivery is mid-work", async () => {
  stubFetch(() => json(409, { error: "in_flight" }));
  assert.equal((await deliverChatEvent(SPEND)).outcome, "unconfirmed");
});

test("connection refused → undelivered (refund is safe: the request never left)", async () => {
  stubFetch(() => Promise.reject(new TypeError("fetch failed")));
  assert.equal((await deliverChatEvent(SPEND)).outcome, "undelivered");
});

test("a post-send connection reset is treated as a timeout, NEVER as undelivered", async () => {
  // Undici throws the same TypeError for a reset AFTER the
  // body went out (stream-api restart with a spend in flight) as for refused —
  // but the handler may have credited the bar before the socket died. Only
  // `err.cause.code` tells them apart; "undelivered" here is the double-credit.
  let calls = 0;
  stubFetch(() => {
    calls += 1;
    if (calls === 1) {
      return Promise.reject(new TypeError("fetch failed", {
        cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
      }));
    }
    return json(200, { ok: true, deduped: true });
  });
  const out = await deliverChatEvent(SPEND);
  assert.equal(out.outcome, "delivered", "the deduped retry must recover the true outcome");
  assert.equal(calls, 2, "a reset earns the same single deduped retry as a timeout");
});

test("a post-send reset without a spendId → unconfirmed (no refund, no blind retry)", async () => {
  let calls = 0;
  stubFetch(() => {
    calls += 1;
    return Promise.reject(new TypeError("fetch failed", {
      cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    }));
  });
  const out = await deliverChatEvent({ kind: "cheer", coins: 100 } as never);
  assert.equal(out.outcome, "unconfirmed");
  assert.equal(calls, 1);
});

test("a timeout retries ONCE and takes the replayed outcome", async () => {
  let calls = 0;
  stubFetch(() => {
    calls += 1;
    if (calls === 1) return Promise.reject(new DOMException("timed out", "TimeoutError"));
    return json(200, { ok: true, id: 42, deduped: true });
  });
  const out = await deliverChatEvent(SPEND);
  assert.equal(out.outcome, "delivered", "the work HAD completed — refunding it was the bug");
  assert.equal(calls, 2);
});

test("a timeout whose retry also dies → unconfirmed, never a refund signal", async () => {
  let calls = 0;
  stubFetch(() => {
    calls += 1;
    return Promise.reject(calls === 1
      ? new DOMException("timed out", "TimeoutError")
      : new TypeError("fetch failed"));
  });
  assert.equal((await deliverChatEvent(SPEND)).outcome, "unconfirmed");
});

test("a payload without a spendId never retries — the retry would not be deduped", async () => {
  let calls = 0;
  stubFetch(() => { calls += 1; return Promise.reject(new DOMException("t", "TimeoutError")); });
  const out = await deliverChatEvent({ kind: "cheer", coins: 100 } as never);
  assert.equal(out.outcome, "unconfirmed");
  assert.equal(calls, 1, "an id-less retry re-RUNS the effect instead of replaying it");
});

// ── broadcastChatEvent: the billing webhook's celebration path ──────────────
//
// The lived exposure: streamApiPost was single-shot `.catch(() => undefined)`,
// and the donation/sub/gift celebration is what writes support_events and moves
// the bar for NATIVE money. One lost during a stream-api restart = the bar
// permanently short on real money, silently — site.donations stays durable, so
// nothing ever flags the gap.

const noSleep = { sleep: async () => {} };

test("celebration: a restart window (connection refused) is retried until it lands", async () => {
  let calls = 0;
  stubFetch(() => {
    calls += 1;
    if (calls < 3) return Promise.reject(new TypeError("fetch failed")); // refused: nothing left
    return json(200, { ok: true });
  });
  await broadcastChatEvent({ kind: "donation", spendId: "donation:cs_1", amount: 500 }, noSleep);
  assert.equal(calls, 3, "an undelivered celebration must retry — undelivered is the SAFE retry case");
});

test("celebration: a refusal is never retried — 4xx retries are illegal on money paths", async () => {
  let calls = 0;
  stubFetch(() => { calls += 1; return json(400, { error: "bad kind" }); });
  await broadcastChatEvent({ kind: "donation", spendId: "donation:cs_2", amount: 500 }, noSleep);
  assert.equal(calls, 1);
});

test("celebration: never throws — a stream-api hiccup must not 500 the Stripe webhook", async () => {
  stubFetch(() => Promise.reject(new RangeError("unrelated bug")));
  await broadcastChatEvent({ kind: "sub", spendId: "sub:sub_1", amount: 500 }, noSleep);
});

test("celebration: a final failure is LOUD — a silent remedy for a silent failure is none", async () => {
  const errors: unknown[][] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => { errors.push(a); };
  try {
    stubFetch(() => Promise.reject(new TypeError("fetch failed")));
    await broadcastChatEvent({ kind: "donation", spendId: "donation:cs_3", amount: 500 }, noSleep);
  } finally {
    console.error = realError;
  }
  const text = errors.map((a) => a.join(" ")).join("\n");
  assert.match(text, /donation:cs_3/, "the journal line must carry the spendId — it is the recovery handle");
  assert.match(text, /celebration/i, "the failure must say WHAT was lost, not just that a fetch failed");
});

test("celebration: a payload without a spendId gets ONE attempt, never a blind retry", async () => {
  let calls = 0;
  stubFetch(() => { calls += 1; return Promise.reject(new TypeError("fetch failed")); });
  await broadcastChatEvent({ kind: "donation", amount: 500 }, noSleep);
  assert.equal(calls, 1, "an id-less celebration retried — the replay store cannot dedup it");
});

// stream-api's ledger could not record a money event: 503 ledger_unavailable. Nothing fired and
// nothing was credited, but the event may be kept for reconciliation — so it must never read as
// refund-legal (`refused`), and the celebration retries it.
test("503 ledger_unavailable → unconfirmed with ledgerPending — never refused, never refund-legal", async () => {
  stubFetch(() => json(503, { ok: false, error: "ledger_unavailable", kind: "donation" }));
  const out = await deliverChatEvent(SPEND);
  assert.equal(out.outcome, "unconfirmed");
  if (out.outcome === "unconfirmed") assert.equal(out.ledgerPending, true);
});

test("celebration: ledger_unavailable is RETRIED (not dropped, not refunded)", async () => {
  let calls = 0;
  stubFetch(() => { calls += 1; return json(503, { ok: false, error: "ledger_unavailable" }); });
  const realError = console.error;
  console.error = () => {};
  try {
    await broadcastChatEvent({ kind: "donation", spendId: "donation:cs_ledger", amount: 500 }, noSleep);
  } finally { console.error = realError; }
  assert.equal(calls, 3, "a ledger_unavailable celebration must be retried like an undelivered one");
});

test("celebration: an ordinary unclassifiable 5xx is still not retried", async () => {
  let calls = 0;
  stubFetch(() => { calls += 1; return json(503, { error: "boost_unconfirmed" }); });
  const realError = console.error;
  console.error = () => {};
  try {
    await broadcastChatEvent({ kind: "donation", spendId: "donation:cs_other", amount: 500 }, noSleep);
  } finally { console.error = realError; }
  assert.equal(calls, 1);
});

// ── F2 (review round 5): web's patience covers stream-api's ledger retry window ─────────────
//
// stream-api holds a money celebration until its ledger answers, retrying a failed write for
// ~108 s (alert.js LEDGER_RETRY_MS × LEDGER_MAX_ATTEMPTS). Web gave up after its 10 s deadline and
// one deduped retry (409 in_flight), and logged "LOST money celebration … NOT credited" for a
// payment that then landed. A celebration still IN FLIGHT is now followed up in the background
// (deduped re-asks on its spendId) for longer than that window, and every log line says what is
// actually known.

const errorsAndWarnings = async (fn: () => Promise<void>) => {
  const lines: string[] = [];
  const saved = { error: console.error, warn: console.warn };
  console.error = (...a: unknown[]) => { lines.push(`E ${a.join(" ")}`); };
  console.warn = (...a: unknown[]) => { lines.push(`W ${a.join(" ")}`); };
  try { await fn(); } finally { Object.assign(console, saved); }
  return lines.join("\n");
};

test("F2: a celebration still in flight (409) is followed up until it lands — never logged LOST", async () => {
  let calls = 0;
  stubFetch(() => { calls += 1; return calls < 6 ? json(409, { error: "in_flight" }) : json(200, { ok: true, deduped: true }); });
  let follow: Promise<void> | null = null;
  const log = await errorsAndWarnings(async () => {
    await broadcastChatEvent({ kind: "donation", spendId: "donation:cs_slow", amount: 500 },
      { sleep: async () => {}, background: (p) => { follow = p; } });
    assert.ok(follow, "an in-flight celebration was abandoned — no follow-up was started");
    await follow;
  });
  assert.equal(calls, 6);
  assert.doesNotMatch(log, /LOST/, "a celebration that landed was reported LOST");
  assert.match(log, /donation:cs_slow/);
  assert.match(log, /late/i, "the late landing must be said, once");
});

test("F2: a follow-up that never hears an answer says UNCONFIRMED (may have credited), not LOST", async () => {
  stubFetch(() => json(409, { error: "in_flight" }));
  let follow: Promise<void> | null = null;
  const log = await errorsAndWarnings(async () => {
    await broadcastChatEvent({ kind: "donation", spendId: "donation:cs_hung", amount: 500 },
      { sleep: async () => {}, background: (p) => { follow = p; } });
    await follow;
  });
  assert.doesNotMatch(log, /LOST/);
  assert.match(log, /UNCONFIRMED/);
  assert.match(log, /donation:cs_hung/);
});

test("F2: the follow-up's patience outlasts stream-api's ledger retry window, with room for slow attempts", async () => {
  const { CELEBRATION_FOLLOW_UP_MS } = await import("./chatEventDelivery.ts");
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../../../stream-api/alert.js", import.meta.url), "utf8");
  const retry = JSON.parse((/const LEDGER_RETRY_MS = (\[[\d, ]+\]);/.exec(src) ?? [])[1] ?? "null") as number[] | null;
  const attempts = Number((/const LEDGER_MAX_ATTEMPTS = (\d+);/.exec(src) ?? [])[1]);
  assert.ok(retry && retry.length && attempts > 1, "could not read alert.js's ledger retry schedule — this check would be vacuous");
  let window = 0;
  for (let i = 0; i < attempts - 1; i++) window += retry![Math.min(i, retry!.length - 1)]!;
  const patience = CELEBRATION_FOLLOW_UP_MS.reduce((a, b) => a + b, 0);
  // Each attempt is itself bounded by stream-api's pool timeouts (index.js); 15 s each is generous.
  assert.ok(patience >= window + attempts * 15_000, `follow-up patience ${patience} ms < ledger window ${window} ms + ${attempts} attempts`);
});

test("F2: an unclassifiable 5xx is reported UNCONFIRMED, a refusal LOST", async () => {
  stubFetch(() => json(503, { error: "boost_unconfirmed" }));
  const a = await errorsAndWarnings(() => broadcastChatEvent({ kind: "donation", spendId: "donation:cs_5xx", amount: 500 }, noSleep));
  assert.match(a, /UNCONFIRMED/);
  assert.doesNotMatch(a, /LOST/);
  stubFetch(() => json(400, { error: "bad kind" }));
  const b = await errorsAndWarnings(() => broadcastChatEvent({ kind: "donation", spendId: "donation:cs_4xx", amount: 500 }, noSleep));
  assert.match(b, /LOST/);
});
