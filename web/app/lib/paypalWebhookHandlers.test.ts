// paypalWebhookHandlers.ts tests. Injectable pool (paymentEventHandlers.ts's
// shape), driven with a fake pool so this runs for real under `node --test`,
// no database required.
//
// The celebration path (broadcastChatEvent) DOES run for real — chatEventDelivery.ts
// only imports relative modules, so `globalThis.fetch` is stubbed the same way
// chatEventDelivery.test.ts and streamApi.test.ts already do, rather than
// re-mocking chatEventDelivery itself.
//
// The REAL getChatIdentity (chatIdentity.ts) never runs here: it imports the
// `@/lib/db` alias at module scope, which plain `node --test` cannot resolve.
// It is an injected dependency (`deps.getChatIdentity`), and every signed-in,
// non-anonymous tip calls it, so any test with such a row must inject one: a
// fake that asserts the lookup, or `plainIdentity` below.
//
// Run: systemd-run --user --scope -p MemoryMax=8G --quiet node --test app/lib/paypalWebhookHandlers.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPaypalWebhookHandlers } from "./paypalWebhookHandlers.ts";
process.env.STREAM_API_URL ??= "http://stream-api.test"; // streamApi.ts has no default; fetch is stubbed

const FIXTURE_DIR = join(import.meta.dirname, "__fixtures__", "paypal");
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), "utf8"));

// ─── fake pool (paymentEventHandlers.test.ts's shape) ──────────────────────

type Row = Record<string, unknown>;
function fakePool(handlers: Array<[RegExp, (p: unknown[]) => { rows: Row[]; rowCount: number }]>) {
  const seen: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      seen.push({ sql, params });
      for (const [re, fn] of handlers) if (re.test(sql)) return fn(params);
      return { rows: [], rowCount: 0 };
    },
  };
  return { pool: pool as never, seen };
}

const CAPTURE_UPDATE = /UPDATE site\.donations\s*\n?\s*SET status = 'completed'/;
const EXTERNAL_ID_SELECT = /SELECT matrix_id FROM site\.donations WHERE external_id = \$1 AND provider = 'paypal'/;
const PROVIDER_REF_SELECT = /SELECT matrix_id FROM site\.donations WHERE provider = 'paypal' AND provider_ref = \$1/;
const REFUNDED_AT_UPDATE = /UPDATE site\.donations SET refunded_at = NOW\(\)/;
const EVENTS_INSERT = /INSERT INTO site\.payment_events/;
const POINTS_SELECT = /SELECT matrix_id, amount_cents FROM site\.paypal_coin_orders WHERE external_id = \$1/;
const POINTS_UPDATE = /UPDATE site\.paypal_coin_orders\s+SET status = 'completed'/;
const POINTS_OWNER_SELECT = /SELECT matrix_id FROM site\.paypal_coin_orders WHERE capture_id = \$1/;

// A fake MoneyCredits, the same shape as paymentEventHandlers.test.ts's
// fakeCredits() — `credits` is a REQUIRED dep, so every construction below
// carries one, even the tests that never expect a credit or a clawback.
// `order`, when passed, lets a test interleave credit calls with pool calls
// (fakePool's own handler closures push into the same array) to assert
// ordering, not just that both happened.
function fakeCredits(order?: string[]) {
  const recordTipCreditCalls: unknown[] = [];
  const recordPurchaseCreditCalls: unknown[] = [];
  const clawbackForPaymentCalls: unknown[] = [];
  return {
    recordTipCredit: async (a: unknown) => { order?.push("credit"); recordTipCreditCalls.push(a); },
    recordPurchaseCredit: async (a: unknown) => { order?.push("purchase-credit"); recordPurchaseCreditCalls.push(a); },
    clawbackForPayment: async (a: unknown) => { order?.push("clawback"); clawbackForPaymentCalls.push(a); },
    restoreClawback: async () => {},
    recordTipCreditCalls,
    recordPurchaseCreditCalls,
    clawbackForPaymentCalls,
  };
}

// ─── fetch stub (chatEventDelivery.test.ts's shape) — broadcastChatEvent runs for real ───

type FetchLike = typeof globalThis.fetch;
type FetchCall = { url: string; body: unknown };
function stubFetch(impl: (call: FetchCall) => Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = [];
  (globalThis as unknown as { fetch: FetchLike }).fetch = (((url: unknown, init?: RequestInit) => {
    const call = { url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return impl(call);
  }) as unknown) as FetchLike;
  return calls;
}
const ok200 = () => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));
// broadcastChatEvent never sleeps between retries in these tests because every
// success path below delivers on the first attempt — no test here exercises
// the retry loop (that belongs to chatEventDelivery.test.ts).

async function withCapturedConsole<T>(fn: () => Promise<T>): Promise<{ result: T; warnings: unknown[][]; errors: unknown[][] }> {
  const warnings: unknown[][] = [];
  const errors: unknown[][] = [];
  const realWarn = console.warn;
  const realError = console.error;
  console.warn = (...a: unknown[]) => { warnings.push(a); };
  console.error = (...a: unknown[]) => { errors.push(a); };
  try {
    const result = await fn();
    return { result, warnings, errors };
  } finally {
    console.warn = realWarn;
    console.error = realError;
  }
}

const completedFixture = fixture("payment.capture.completed");
const refundedFixture = fixture("payment.capture.refunded");
const disputeFixture = fixture("customer.dispute.resolved");
const reversedFixture = fixture("payment.capture.reversed");

// PayPal's sandbox simulate-event only ever returns the canned
// CANCELED_BY_BUYER example for CUSTOMER.DISPUTE.RESOLVED, no matter what
// resource_version is requested — there is no way to script a real
// RESOLVED_BUYER_FAVOUR payload. The shape itself (disputeFixture, above) IS
// the real sandbox shape; only this one field value is unscriptable, and its
// existence + meaning is confirmed against PayPal's own customer_disputes_v1
// OpenAPI spec (outcome_code enum, RESOLVED_BUYER_FAVOUR: "The dispute was
// resolved in the customer's favor."). So this fixture is the real shape with
// only that field changed.
const buyerWonDisputeFixture = JSON.parse(JSON.stringify(disputeFixture));
buyerWonDisputeFixture.resource.dispute_outcome.outcome_code = "RESOLVED_BUYER_FAVOUR";

// Piece 2: a quiet Qorm purchase's custom_id is `points:<external_id>`, never a
// bare uuid — pointsCaptureFixture reuses completedFixture's amount/capture id
// shape so FIX_CENTS (below) applies to it unchanged.
const FIX_CENTS = Math.round(Number(completedFixture.resource.amount.value) * 100);
function pointsCaptureFixture(externalId = "11111111-2222-3333-4444-555555555555", prefix = "points:") {
  const ev = JSON.parse(JSON.stringify(completedFixture));
  ev.resource.custom_id = `${prefix}${externalId}`;
  return ev;
}

// ══════════════════════════════ onCaptureCompleted ══════════════════════════

test("extraction failure throws, naming the reason — never a silent 200", async () => {
  const { pool } = fakePool([]);
  const { onCaptureCompleted } = createPaypalWebhookHandlers({ pool, credits: fakeCredits() as never });
  await assert.rejects(() => onCaptureCompleted({ id: "WH-X", event_type: "PAYMENT.CAPTURE.COMPLETED", create_time: "2026-01-01T00:00:00Z", resource: {} }), /paypal capture extraction failed/);
});

test("a capture with no custom_id throws, naming the capture id — never a silent 200", async () => {
  const { pool } = fakePool([]);
  const { onCaptureCompleted } = createPaypalWebhookHandlers({ pool, credits: fakeCredits() as never });
  const ev = JSON.parse(JSON.stringify(completedFixture));
  delete ev.resource.custom_id;
  await assert.rejects(() => onCaptureCompleted(ev), /carries no custom_id/);
});

test("idempotency: zero rows from the UPDATE means no celebration and no throw", async () => {
  const { pool, seen } = fakePool([[CAPTURE_UPDATE, () => ({ rows: [], rowCount: 0 })]]);
  const calls = stubFetch(ok200);
  const { onCaptureCompleted } = createPaypalWebhookHandlers({ pool, credits: fakeCredits() as never });
  await onCaptureCompleted(completedFixture);
  assert.equal(calls.length, 0, "a retry or duplicate must never celebrate twice");
  assert.equal(seen.filter((s) => CAPTURE_UPDATE.test(s.sql)).length, 1);
});

// A stand-in getChatIdentity for tests about something else. Every signed-in,
// non-anonymous donor gets an identity lookup, and the production default
// imports chatIdentity.ts, which does not load under node --test.
const plainIdentity = async () => ({ username: "unused", usernameColor: null, usernameStyle: null });

test("a fresh completion: the UPDATE carries customId/captureId/cents, and exactly one celebration fires", async () => {
  const { pool, seen } = fakePool([[CAPTURE_UPDATE, () => ({
    rows: [{ id: 1, matrix_id: "@donor:site.test", display_name: "Donor Name", message: "hi", anonymous: false, ordered_cents: 5700 }],
    rowCount: 1,
  })]]);
  const calls = stubFetch(ok200);
  const { onCaptureCompleted } = createPaypalWebhookHandlers({ pool, getChatIdentity: plainIdentity, credits: fakeCredits() as never });
  await onCaptureCompleted(completedFixture);

  const q = seen.find((s) => CAPTURE_UPDATE.test(s.sql))!;
  assert.deepEqual(q.params, ["d93e4fcb-d3af-137c-82fe-1a8101f1ad11", "42311647XV020574X", 5700]);

  assert.equal(calls.length, 1, "exactly one celebration");
  const body = calls[0]!.body as Record<string, unknown>;
  assert.equal(body.kind, "donation");
  assert.equal(body.spendId, "donation:paypal:42311647XV020574X");
  assert.equal(body.donor, "Donor Name");
  assert.equal(body.donorMatrixId, "@donor:site.test");
  assert.equal(body.anonymous, false);
  assert.equal(body.amount, 5700);
  assert.equal(body.currency, "usd", "currency must be lowercased");
  assert.equal(body.message, "hi");
  assert.equal(body.netUsd, 49.39, "netUsd passes through untouched");
});

test("netUsd is never recomputed as gross-minus-paypal_fee-only — it is net_amount as extracted, ignoring platform_fees", async () => {
  const { pool } = fakePool([[CAPTURE_UPDATE, () => ({
    rows: [{ id: 1, matrix_id: null, display_name: "X", message: null, anonymous: false, ordered_cents: 5700 }],
    rowCount: 1,
  })]]);
  const calls = stubFetch(ok200);
  const { onCaptureCompleted } = createPaypalWebhookHandlers({ pool, credits: fakeCredits() as never });
  await onCaptureCompleted(completedFixture);
  const body = calls[0]!.body as Record<string, unknown>;
  assert.equal(body.netUsd, 49.39);
  assert.notEqual(body.netUsd, 57.00 - 2.48, "must not be gross minus paypal_fee only — that ignores platform_fees");
});

test("an anonymous row celebrates as Anonymous with donorMatrixId null, even with a name and a matrix_id on the row", async () => {
  const { pool } = fakePool([[CAPTURE_UPDATE, () => ({
    rows: [{ id: 1, matrix_id: "@donor:site.test", display_name: "Donor Name", message: null, anonymous: true, ordered_cents: 5700 }],
    rowCount: 1,
  })]]);
  const calls = stubFetch(ok200);
  const { onCaptureCompleted } = createPaypalWebhookHandlers({ pool, credits: fakeCredits() as never });
  await onCaptureCompleted(completedFixture);
  const body = calls[0]!.body as Record<string, unknown>;
  assert.equal(body.donor, "Anonymous");
  assert.equal(body.donorMatrixId, null);
  assert.equal(body.anonymous, true);
});

test("a guest (no matrix_id) with a blank display_name celebrates as Anonymous, WITHOUT needing a chat-identity lookup", async () => {
  const { pool } = fakePool([[CAPTURE_UPDATE, () => ({
    rows: [{ id: 1, matrix_id: null, display_name: null, message: null, anonymous: false, ordered_cents: 5700 }],
    rowCount: 1,
  })]]);
  const calls = stubFetch(ok200);
  const { onCaptureCompleted } = createPaypalWebhookHandlers({ pool, credits: fakeCredits() as never });
  await onCaptureCompleted(completedFixture);
  const body = calls[0]!.body as Record<string, unknown>;
  assert.equal(body.donor, "Anonymous");
  assert.equal(body.donorMatrixId, null);
});

// ── donor identity resolution: getChatIdentity is now an injected dependency ──
//
// Fix round 1 (coordinator, post-review): the branch that calls getChatIdentity
// IS reachable — tipDisplayNameServer.ts:46 returns "" (not null) for a
// signed-in user with no site.users.display_name, and the order route inserts
// that "" verbatim, so `row.display_name` really does arrive blank. The
// dynamic-import version of this code had no test AND no scan covering it
// (the earlier report's claim that it mirrored chatIdentity.test.ts's CALLERS
// list was checked and was false — this file's name isn't in that list).
// getChatIdentity is now `deps.getChatIdentity`, so these run for real.

test("a blank stored display_name ('') triggers getChatIdentity for a signed-in, non-anonymous donor, and its identity reaches the broadcast", async () => {
  const { pool } = fakePool([[CAPTURE_UPDATE, () => ({
    rows: [{ id: 1, matrix_id: "@donor:site.test", display_name: "", message: null, anonymous: false, ordered_cents: 5700 }],
    rowCount: 1,
  })]]);
  const fetchCalls = stubFetch(ok200);
  const identityCalls: string[] = [];
  const getChatIdentity = async (matrixId: string) => {
    identityCalls.push(matrixId);
    return { username: "Casey", usernameColor: "#ff0000", usernameStyle: { gradient: true } };
  };
  const { onCaptureCompleted } = createPaypalWebhookHandlers({ pool, getChatIdentity, credits: fakeCredits() as never });
  await onCaptureCompleted(completedFixture);

  assert.deepEqual(identityCalls, ["@donor:site.test"], "getChatIdentity must be called with the row's matrix_id");
  const body = fetchCalls[0]!.body as Record<string, unknown>;
  assert.equal(body.donor, "Casey");
  assert.equal(body.donorMatrixId, "@donor:site.test");
  assert.equal(body.usernameColor, "#ff0000");
  assert.deepEqual(body.usernameStyle, { gradient: true });
});

test("an anonymous donor never calls getChatIdentity, even with a blank display_name and a matrix_id on the row", async () => {
  const { pool } = fakePool([[CAPTURE_UPDATE, () => ({
    rows: [{ id: 1, matrix_id: "@donor:site.test", display_name: "", message: null, anonymous: true, ordered_cents: 5700 }],
    rowCount: 1,
  })]]);
  const fetchCalls = stubFetch(ok200);
  const identityCalls: string[] = [];
  const getChatIdentity = async (matrixId: string) => {
    identityCalls.push(matrixId);
    return { username: "should not be used", usernameColor: null, usernameStyle: null };
  };
  const { onCaptureCompleted } = createPaypalWebhookHandlers({ pool, getChatIdentity, credits: fakeCredits() as never });
  await onCaptureCompleted(completedFixture);

  assert.equal(identityCalls.length, 0, "an anonymous donor must never trigger an identity lookup");
  const body = fetchCalls[0]!.body as Record<string, unknown>;
  assert.equal(body.donor, "Anonymous");
  assert.equal(body.donorMatrixId, null);
});

// A stored name must not skip the lookup: every signed-in PayPal tipper's row
// carries their site name, so skipping it would celebrate them with a PLAIN
// name — no colour, no equipped style. Stripe's route looks the identity up for
// every signed-in, non-anonymous donor and lets the stored name win only the
// LABEL (route.ts `donor = donor || identity.username`).
test("a stored non-blank display_name wins the label, but the donor's colour and style still come from getChatIdentity", async () => {
  const { pool } = fakePool([[CAPTURE_UPDATE, () => ({
    rows: [{ id: 1, matrix_id: "@donor:site.test", display_name: "Already Named", message: null, anonymous: false, ordered_cents: 5700 }],
    rowCount: 1,
  })]]);
  const fetchCalls = stubFetch(ok200);
  const identityCalls: string[] = [];
  const getChatIdentity = async (matrixId: string) => {
    identityCalls.push(matrixId);
    return { username: "Chat Name", usernameColor: "#00ff00", usernameStyle: { font: "arcade" } };
  };
  const { onCaptureCompleted } = createPaypalWebhookHandlers({ pool, getChatIdentity, credits: fakeCredits() as never });
  await onCaptureCompleted(completedFixture);

  assert.deepEqual(identityCalls, ["@donor:site.test"], "a signed-in donor's style must be looked up even when the row has a name");
  const body = fetchCalls[0]!.body as Record<string, unknown>;
  assert.equal(body.donor, "Already Named", "the stored label still wins over the chat username");
  assert.equal(body.usernameColor, "#00ff00");
  assert.deepEqual(body.usernameStyle, { font: "arcade" });
});

test("captured amount differing from the ordered amount logs a loud warning naming both numbers and the capture id", async () => {
  const { pool } = fakePool([[CAPTURE_UPDATE, () => ({
    rows: [{ id: 1, matrix_id: null, display_name: "X", message: null, anonymous: false, ordered_cents: 4000 }],
    rowCount: 1,
  })]]);
  stubFetch(ok200);
  const { onCaptureCompleted } = createPaypalWebhookHandlers({ pool, credits: fakeCredits() as never });
  const { warnings } = await withCapturedConsole(() => onCaptureCompleted(completedFixture));
  assert.equal(warnings.length, 1);
  const text = warnings[0]!.join(" ");
  assert.match(text, /4000/, "must name the ordered amount");
  assert.match(text, /5700/, "must name the captured amount");
  assert.match(text, /42311647XV020574X/, "must name the capture id");
});

test("captured amount matching the ordered amount logs nothing", async () => {
  const { pool } = fakePool([[CAPTURE_UPDATE, () => ({
    rows: [{ id: 1, matrix_id: null, display_name: "X", message: null, anonymous: false, ordered_cents: 5700 }],
    rowCount: 1,
  })]]);
  stubFetch(ok200);
  const { onCaptureCompleted } = createPaypalWebhookHandlers({ pool, credits: fakeCredits() as never });
  const { warnings } = await withCapturedConsole(() => onCaptureCompleted(completedFixture));
  assert.equal(warnings.length, 0);
});

// ── Qorm for PayPal tips ─────────────────────────────────────────────────────
//
// Read + credited BEFORE the completing UPDATE — see paypalWebhookHandlers.ts's
// onCaptureCompleted for why: a retry after a credit failure must still reach
// the completing UPDATE and the celebration, which only works if the credit
// runs first.

test("a completed capture for a signed-in tip credits its cents, keyed on the capture id, BEFORE the completing UPDATE", async () => {
  const order: string[] = [];
  const { pool } = fakePool([
    [EXTERNAL_ID_SELECT, () => { order.push("select"); return { rows: [{ matrix_id: "@donor:site.test" }], rowCount: 1 }; }],
    [CAPTURE_UPDATE, () => { order.push("update"); return {
      rows: [{ id: 1, matrix_id: "@donor:site.test", display_name: "Donor Name", message: "hi", anonymous: false, ordered_cents: 5700 }],
      rowCount: 1,
    }; }],
  ]);
  stubFetch(ok200);
  const credits = fakeCredits(order);
  const { onCaptureCompleted } = createPaypalWebhookHandlers({ pool, getChatIdentity: plainIdentity, credits: credits as never });
  await onCaptureCompleted(completedFixture);

  assert.equal(credits.recordTipCreditCalls.length, 1);
  assert.deepEqual(credits.recordTipCreditCalls[0], {
    matrixId: "@donor:site.test", cents: 5700, ref: "paypal:42311647XV020574X",
    payment: { provider: "paypal", captureId: "42311647XV020574X" },
  });
  assert.deepEqual(order, ["select", "credit", "update"], "the credit must land before the completing UPDATE");
});

test("a retry after a credit failure: the first delivery rejects and broadcasts nothing; the retry credits, completes, and broadcasts once", async () => {
  const { pool } = fakePool([
    [EXTERNAL_ID_SELECT, () => ({ rows: [{ matrix_id: "@donor:site.test" }], rowCount: 1 })],
    [CAPTURE_UPDATE, () => ({
      rows: [{ id: 1, matrix_id: "@donor:site.test", display_name: "Donor Name", message: "hi", anonymous: false, ordered_cents: 5700 }],
      rowCount: 1,
    })],
  ]);
  const calls = stubFetch(ok200);
  const credits = fakeCredits();
  let creditAttempts = 0;
  credits.recordTipCredit = async (a: unknown) => {
    creditAttempts += 1;
    if (creditAttempts === 1) throw new Error("credits db down");
    credits.recordTipCreditCalls.push(a);
  };
  const { onCaptureCompleted } = createPaypalWebhookHandlers({ pool, getChatIdentity: plainIdentity, credits: credits as never });

  await assert.rejects(() => onCaptureCompleted(completedFixture), /credits db down/);
  assert.equal(calls.length, 0, "nothing broadcasts when the credit throws");

  await onCaptureCompleted(completedFixture);
  assert.equal(credits.recordTipCreditCalls.length, 1, "the retry's successful credit is recorded");
  assert.equal(calls.length, 1, "the retry reaches the completing UPDATE and celebrates exactly once");
});

test("a guest PayPal tip credits nothing", async () => {
  const { pool } = fakePool([
    [EXTERNAL_ID_SELECT, () => ({ rows: [{ matrix_id: null }], rowCount: 1 })],
    [CAPTURE_UPDATE, () => ({
      rows: [{ id: 1, matrix_id: null, display_name: null, message: null, anonymous: false, ordered_cents: 5700 }],
      rowCount: 1,
    })],
  ]);
  stubFetch(ok200);
  const credits = fakeCredits();
  const { onCaptureCompleted } = createPaypalWebhookHandlers({ pool, credits: credits as never });
  await onCaptureCompleted(completedFixture);
  assert.equal(credits.recordTipCreditCalls.length, 0);
});

test("an anonymous PayPal tip still credits the payer — anonymous only hides the name on stream", async () => {
  const { pool } = fakePool([
    [EXTERNAL_ID_SELECT, () => ({ rows: [{ matrix_id: "@donor:site.test" }], rowCount: 1 })],
    [CAPTURE_UPDATE, () => ({
      rows: [{ id: 1, matrix_id: "@donor:site.test", display_name: "Donor Name", message: null, anonymous: true, ordered_cents: 5700 }],
      rowCount: 1,
    })],
  ]);
  stubFetch(ok200);
  const credits = fakeCredits();
  const { onCaptureCompleted } = createPaypalWebhookHandlers({ pool, credits: credits as never });
  await onCaptureCompleted(completedFixture);
  assert.equal(credits.recordTipCreditCalls.length, 1);
  assert.deepEqual(credits.recordTipCreditCalls[0], {
    matrixId: "@donor:site.test", cents: 5700, ref: "paypal:42311647XV020574X",
    payment: { provider: "paypal", captureId: "42311647XV020574X" },
  });
});

// ══════════════════════════════ onCaptureRefunded ═══════════════════════════

test("resolves the capture id from resource.links (rel=up) — the ONLY route back — real fixture", async () => {
  const { pool, seen } = fakePool([
    [PROVIDER_REF_SELECT, () => ({ rows: [{ matrix_id: "@refunder:site.test" }], rowCount: 1 })],
    [EVENTS_INSERT, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
    [REFUNDED_AT_UPDATE, () => ({ rows: [], rowCount: 1 })],
  ]);
  const { onCaptureRefunded } = createPaypalWebhookHandlers({ pool, credits: fakeCredits() as never });
  await onCaptureRefunded(refundedFixture);

  const select = seen.find((s) => PROVIDER_REF_SELECT.test(s.sql))!;
  assert.deepEqual(select.params, ["0JF852973C016714D"]);

  const insert = seen.find((s) => EVENTS_INSERT.test(s.sql))!;
  // [provider, event_id, event_type, occurred_at, session_id, payment_intent_id,
  //  charge_id, subscription_id, matrix_id, kind, amount_cents, currency,
  //  outcome, reason_code, decline_code, reason_text]
  assert.equal(insert.params[0], "paypal");
  assert.equal(insert.params[1], "WH-1GE84257G0350133W-6RW800890C634293G");
  assert.equal(insert.params[2], "PAYMENT.CAPTURE.REFUNDED");
  assert.deepEqual(insert.params[3], new Date("2018-08-15T19:14:04.543Z"));
  assert.equal(insert.params[5], null, "payment_intent_id is Stripe-shaped and must stay null");
  assert.equal(insert.params[6], "0JF852973C016714D", "charge_id carries the capture id");
  assert.equal(insert.params[7], null, "subscription_id is Stripe-shaped and must stay null");
  assert.equal(insert.params[8], "@refunder:site.test");
  assert.equal(insert.params[10], 99, "amount_cents from resource.amount.value (0.99)");
  assert.equal(insert.params[11], "usd", "currency lowercased");
  assert.equal(insert.params[12], "refunded");

  const upd = seen.find((s) => REFUNDED_AT_UPDATE.test(s.sql))!;
  assert.deepEqual(upd.params, ["0JF852973C016714D"]);
});

// ── Qorm clawback ────────────────────────────────────────────────────────────

test("PAYMENT.CAPTURE.REFUNDED claws back the refunded amount, keyed on the refund id", async () => {
  const { pool } = fakePool([
    [PROVIDER_REF_SELECT, () => ({ rows: [{ matrix_id: "@refunder:site.test" }], rowCount: 1 })],
    [EVENTS_INSERT, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
    [REFUNDED_AT_UPDATE, () => ({ rows: [], rowCount: 1 })],
  ]);
  const credits = fakeCredits();
  const { onCaptureRefunded } = createPaypalWebhookHandlers({ pool, credits: credits as never });
  await onCaptureRefunded(refundedFixture);
  assert.equal(credits.clawbackForPaymentCalls.length, 1);
  assert.deepEqual(credits.clawbackForPaymentCalls[0], {
    payment: { provider: "paypal", captureId: "0JF852973C016714D" },
    cents: 99, ref: "paypal:refund:1Y107995YT783435V", reason: "refund",
  });
});

test("a non-USD refund settlement never trusts resource.amount.value as cents — claws back everything held for the capture, and warns naming only the capture id", async () => {
  const { pool } = fakePool([
    [PROVIDER_REF_SELECT, () => ({ rows: [{ matrix_id: "@refunder:site.test" }], rowCount: 1 })],
    [EVENTS_INSERT, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
    [REFUNDED_AT_UPDATE, () => ({ rows: [], rowCount: 1 })],
  ]);
  const bad = JSON.parse(JSON.stringify(refundedFixture));
  bad.resource.amount.currency_code = "EUR";
  const credits = fakeCredits();
  const { onCaptureRefunded } = createPaypalWebhookHandlers({ pool, credits: credits as never });
  const { warnings } = await withCapturedConsole(() => onCaptureRefunded(bad));
  assert.equal(credits.clawbackForPaymentCalls.length, 1);
  assert.deepEqual(credits.clawbackForPaymentCalls[0], {
    payment: { provider: "paypal", captureId: "0JF852973C016714D" },
    cents: Number.MAX_SAFE_INTEGER, ref: "paypal:refund:1Y107995YT783435V", reason: "refund",
  });
  assert.equal(warnings.length, 1, "a non-USD settlement must warn once");
  assert.equal(warnings[0]!.includes("0JF852973C016714D"), true, "the warning must name the capture id");
  assert.equal(
    warnings[0]!.some((a) => typeof a === "string" && /refunder|matrix|@/i.test(a)),
    false,
    "the warning must never carry a payer field"
  );
});

test("no capture id resolvable in links -> records with matrix_id null and charge_id null, logs loudly, does not throw, does not stamp refunded_at, claws back nothing", async () => {
  const { pool, seen } = fakePool([[EVENTS_INSERT, () => ({ rows: [{ id: 1 }], rowCount: 1 })]]);
  const bad = JSON.parse(JSON.stringify(refundedFixture));
  bad.resource.links = [{ rel: "self", href: "https://api.sandbox.paypal.com/v2/payments/refunds/1Y107995YT783435V" }];
  const credits = fakeCredits();
  const { onCaptureRefunded } = createPaypalWebhookHandlers({ pool, credits: credits as never });
  const { errors } = await withCapturedConsole(() => onCaptureRefunded(bad));
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.join(" "), /no capture id/i);

  assert.equal(seen.some((s) => PROVIDER_REF_SELECT.test(s.sql)), false, "no capture id to look up matrix_id by");
  assert.equal(seen.some((s) => REFUNDED_AT_UPDATE.test(s.sql)), false, "no capture id to stamp refunded_at against");
  const insert = seen.find((s) => EVENTS_INSERT.test(s.sql))!;
  assert.equal(insert.params[8], null, "matrix_id null");
  assert.equal(insert.params[6], null, "charge_id null");
  assert.equal(credits.clawbackForPaymentCalls.length, 0, "no capture id to key a clawback on");
});

test("a refund touches exactly 3 pool queries — the identity SELECT, the payment_events INSERT, and the refunded_at UPDATE — plus one Qorm clawback via the credits dep, never a 4th pool query", async () => {
  const { pool, seen } = fakePool([
    [PROVIDER_REF_SELECT, () => ({ rows: [{ matrix_id: null }], rowCount: 0 })],
    [EVENTS_INSERT, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
    [REFUNDED_AT_UPDATE, () => ({ rows: [], rowCount: 0 })],
  ]);
  const credits = fakeCredits();
  const { onCaptureRefunded } = createPaypalWebhookHandlers({ pool, credits: credits as never });
  await onCaptureRefunded(refundedFixture);
  assert.equal(seen.length, 3, `expected exactly 3 queries, saw ${seen.length}`);
  assert.equal(credits.clawbackForPaymentCalls.length, 1, "the Qorm clawback runs through the credits dep, not the pool");
});

// ══════════════════════════════ onDisputeResolved ═══════════════════════════

test("resolves the capture id from disputed_transactions[0].seller_transaction_id — real fixture", async () => {
  const { pool, seen } = fakePool([
    [PROVIDER_REF_SELECT, () => ({ rows: [{ matrix_id: "@disputer:site.test" }], rowCount: 1 })],
    [EVENTS_INSERT, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
  ]);
  const { onDisputeResolved } = createPaypalWebhookHandlers({ pool, credits: fakeCredits() as never });
  await onDisputeResolved(disputeFixture);

  const select = seen.find((s) => PROVIDER_REF_SELECT.test(s.sql))!;
  assert.deepEqual(select.params, ["00D10444LD479031K"]);

  const insert = seen.find((s) => EVENTS_INSERT.test(s.sql))!;
  assert.equal(insert.params[0], "paypal");
  assert.equal(insert.params[1], "WH-6SA34813406280445-6M160383LS6155516");
  assert.equal(insert.params[2], "CUSTOMER.DISPUTE.RESOLVED");
  assert.deepEqual(insert.params[3], new Date("2018-06-21T13:57:08.000Z"));
  assert.equal(insert.params[6], "00D10444LD479031K", "charge_id carries the capture id");
  assert.equal(insert.params[8], "@disputer:site.test");
  assert.equal(insert.params[10], 300, "amount_cents from dispute_amount.value (3.00)");
  assert.equal(insert.params[11], "usd");
  assert.equal(insert.params[12], "dispute_closed");
  assert.equal(insert.params[13], "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", "reason_code");
  assert.equal(insert.params[15], "CANCELED_BY_BUYER", "reason_text is the outcome CODE, never the buyer's prose");
});

test("reasonText is never the buyer's prose from messages[] — only the outcome code", async () => {
  const { pool, seen } = fakePool([
    [PROVIDER_REF_SELECT, () => ({ rows: [{ matrix_id: null }], rowCount: 0 })],
    [EVENTS_INSERT, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
  ]);
  const { onDisputeResolved } = createPaypalWebhookHandlers({ pool, credits: fakeCredits() as never });
  await onDisputeResolved(disputeFixture);
  const insert = seen.find((s) => EVENTS_INSERT.test(s.sql))!;
  assert.notEqual(insert.params[15], "qwqwqwq", "must not carry the buyer's message content");
  assert.notEqual(insert.params[15], "Escalating to paypal", "must not carry the seller's message content");
});

test("no capture id resolvable -> records with matrix_id null and charge_id null, logs loudly, does not throw", async () => {
  const { pool, seen } = fakePool([[EVENTS_INSERT, () => ({ rows: [{ id: 1 }], rowCount: 1 })]]);
  const bad = JSON.parse(JSON.stringify(disputeFixture));
  bad.resource.disputed_transactions = [];
  const { onDisputeResolved } = createPaypalWebhookHandlers({ pool, credits: fakeCredits() as never });
  const { errors } = await withCapturedConsole(() => onDisputeResolved(bad));
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.join(" "), /no capture id/i);
  const insert = seen.find((s) => EVENTS_INSERT.test(s.sql))!;
  assert.equal(insert.params[8], null);
  assert.equal(insert.params[6], null);
});

test("a resolved dispute never stamps refunded_at — a resolved dispute is not a refund", async () => {
  const { pool, seen } = fakePool([
    [PROVIDER_REF_SELECT, () => ({ rows: [{ matrix_id: "@disputer:site.test" }], rowCount: 1 })],
    [EVENTS_INSERT, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
  ]);
  const { onDisputeResolved } = createPaypalWebhookHandlers({ pool, credits: fakeCredits() as never });
  await onDisputeResolved(disputeFixture);
  assert.equal(seen.some((s) => REFUNDED_AT_UPDATE.test(s.sql)), false);
});

test("no clawback — a dispute touches exactly the identity SELECT and the payment_events INSERT, nothing else", async () => {
  const { pool, seen } = fakePool([
    [PROVIDER_REF_SELECT, () => ({ rows: [{ matrix_id: null }], rowCount: 0 })],
    [EVENTS_INSERT, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
  ]);
  const credits = fakeCredits();
  const { onDisputeResolved } = createPaypalWebhookHandlers({ pool, credits: credits as never });
  await onDisputeResolved(disputeFixture);
  assert.equal(seen.length, 2, `expected exactly 2 queries, saw ${seen.length}`);
  assert.equal(credits.clawbackForPaymentCalls.length, 0, "the CANCELED_BY_BUYER outcome must never claw back");
});

// ── Qorm clawback on a buyer-won dispute ─────────────────────────────────────

test("outcome_code RESOLVED_BUYER_FAVOUR claws back the dispute amount, keyed on the CAPTURE id (shared with a reversal of the same capture)", async () => {
  const { pool } = fakePool([
    [PROVIDER_REF_SELECT, () => ({ rows: [{ matrix_id: "@disputer:site.test" }], rowCount: 1 })],
    [EVENTS_INSERT, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
  ]);
  const credits = fakeCredits();
  const { onDisputeResolved } = createPaypalWebhookHandlers({ pool, credits: credits as never });
  await onDisputeResolved(buyerWonDisputeFixture);
  assert.equal(credits.clawbackForPaymentCalls.length, 1);
  assert.deepEqual(credits.clawbackForPaymentCalls[0], {
    payment: { provider: "paypal", captureId: "00D10444LD479031K" },
    cents: 300, ref: "paypal:dispute-capture:00D10444LD479031K", reason: "dispute",
  });
});

test("a non-USD buyer-won dispute settlement never trusts dispute_amount.value as cents — claws back everything held for the capture, and warns naming only the capture id", async () => {
  const { pool } = fakePool([
    [PROVIDER_REF_SELECT, () => ({ rows: [{ matrix_id: "@disputer:site.test" }], rowCount: 1 })],
    [EVENTS_INSERT, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
  ]);
  const bad = JSON.parse(JSON.stringify(buyerWonDisputeFixture));
  bad.resource.dispute_amount.currency_code = "EUR";
  const credits = fakeCredits();
  const { onDisputeResolved } = createPaypalWebhookHandlers({ pool, credits: credits as never });
  const { warnings } = await withCapturedConsole(() => onDisputeResolved(bad));
  assert.equal(credits.clawbackForPaymentCalls.length, 1);
  assert.deepEqual(credits.clawbackForPaymentCalls[0], {
    payment: { provider: "paypal", captureId: "00D10444LD479031K" },
    cents: Number.MAX_SAFE_INTEGER, ref: "paypal:dispute-capture:00D10444LD479031K", reason: "dispute",
  });
  assert.equal(warnings.length, 1, "a non-USD settlement must warn once");
  assert.equal(warnings[0]!.includes("00D10444LD479031K"), true, "the warning must name the capture id");
  assert.equal(
    warnings[0]!.some((a) => typeof a === "string" && /disputer|matrix|@/i.test(a)),
    false,
    "the warning must never carry a payer field"
  );
});

test("a buyer-won dispute with no capture id resolvable claws back nothing", async () => {
  const { pool } = fakePool([[EVENTS_INSERT, () => ({ rows: [{ id: 1 }], rowCount: 1 })]]);
  const bad = JSON.parse(JSON.stringify(buyerWonDisputeFixture));
  bad.resource.disputed_transactions = [];
  const credits = fakeCredits();
  const { onDisputeResolved } = createPaypalWebhookHandlers({ pool, credits: credits as never });
  await withCapturedConsole(() => onDisputeResolved(bad));
  assert.equal(credits.clawbackForPaymentCalls.length, 0);
});

// ══════════════════════════════ onCaptureReversed ═══════════════════════════
//
// PAYMENT.CAPTURE.REVERSED's resource is "refund"-typed (confirmed against
// the real sandbox with resource_version="2.0" — see the fixture header note
// and paypalWebhookHandlers.ts's docstring), so it shares captureIdFromRefund
// and parsePositiveCents with onCaptureRefunded. reversedFixture is the real
// sandbox payload, unmodified except for whitespace formatting.

test("resolves the capture id from resource.links (rel=up), same as a refund — real fixture", async () => {
  const { pool, seen } = fakePool([
    [PROVIDER_REF_SELECT, () => ({ rows: [{ matrix_id: "@reversed:site.test" }], rowCount: 1 })],
    [EVENTS_INSERT, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
  ]);
  const { onCaptureReversed } = createPaypalWebhookHandlers({ pool, credits: fakeCredits() as never });
  await onCaptureReversed(reversedFixture);

  const select = seen.find((s) => PROVIDER_REF_SELECT.test(s.sql))!;
  assert.deepEqual(select.params, ["4L335234718889942"]);

  const insert = seen.find((s) => EVENTS_INSERT.test(s.sql))!;
  assert.equal(insert.params[0], "paypal");
  assert.equal(insert.params[1], "WH-6F207351SC284371F-0KX52201050121307");
  assert.equal(insert.params[2], "PAYMENT.CAPTURE.REVERSED");
  assert.deepEqual(insert.params[3], new Date("2018-08-15T21:30:35.780Z"));
  assert.equal(insert.params[6], "4L335234718889942", "charge_id carries the capture id");
  assert.equal(insert.params[8], "@reversed:site.test");
  assert.equal(insert.params[10], 251, "amount_cents from resource.amount.value (2.51)");
  assert.equal(insert.params[11], "usd", "currency lowercased");
  assert.equal(insert.params[12], "refunded", "no CHECK constraint on outcome — refunded is the closest existing category");
});

test("a reversal claws back the reversed amount, keyed on the CAPTURE id (shared with a buyer-won dispute of the same capture), reason 'dispute'", async () => {
  const { pool } = fakePool([
    [PROVIDER_REF_SELECT, () => ({ rows: [{ matrix_id: "@reversed:site.test" }], rowCount: 1 })],
    [EVENTS_INSERT, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
  ]);
  const credits = fakeCredits();
  const { onCaptureReversed } = createPaypalWebhookHandlers({ pool, credits: credits as never });
  await onCaptureReversed(reversedFixture);
  assert.equal(credits.clawbackForPaymentCalls.length, 1);
  assert.deepEqual(credits.clawbackForPaymentCalls[0], {
    payment: { provider: "paypal", captureId: "4L335234718889942" },
    cents: 251, ref: "paypal:dispute-capture:4L335234718889942", reason: "dispute",
  });
});

test("a non-USD reversal settlement never trusts resource.amount.value as cents — claws back everything held for the capture, and warns naming only the capture id", async () => {
  const { pool } = fakePool([
    [PROVIDER_REF_SELECT, () => ({ rows: [{ matrix_id: "@reversed:site.test" }], rowCount: 1 })],
    [EVENTS_INSERT, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
  ]);
  const bad = JSON.parse(JSON.stringify(reversedFixture));
  bad.resource.amount.currency_code = "EUR";
  const credits = fakeCredits();
  const { onCaptureReversed } = createPaypalWebhookHandlers({ pool, credits: credits as never });
  const { warnings } = await withCapturedConsole(() => onCaptureReversed(bad));
  assert.equal(credits.clawbackForPaymentCalls.length, 1);
  assert.deepEqual(credits.clawbackForPaymentCalls[0], {
    payment: { provider: "paypal", captureId: "4L335234718889942" },
    cents: Number.MAX_SAFE_INTEGER, ref: "paypal:dispute-capture:4L335234718889942", reason: "dispute",
  });
  assert.equal(warnings.length, 1, "a non-USD settlement must warn once");
  assert.equal(warnings[0]!.includes("4L335234718889942"), true, "the warning must name the capture id");
});

test("no capture id resolvable in links -> records with matrix_id null and charge_id null, logs loudly, does not throw, claws back nothing", async () => {
  const { pool, seen } = fakePool([[EVENTS_INSERT, () => ({ rows: [{ id: 1 }], rowCount: 1 })]]);
  const bad = JSON.parse(JSON.stringify(reversedFixture));
  bad.resource.links = [{ rel: "self", href: "https://api.sandbox.paypal.com/v2/payments/refunds/09E71677NS257044M" }];
  const credits = fakeCredits();
  const { onCaptureReversed } = createPaypalWebhookHandlers({ pool, credits: credits as never });
  const { errors } = await withCapturedConsole(() => onCaptureReversed(bad));
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.join(" "), /no capture id/i);

  assert.equal(seen.some((s) => PROVIDER_REF_SELECT.test(s.sql)), false, "no capture id to look up matrix_id by");
  const insert = seen.find((s) => EVENTS_INSERT.test(s.sql))!;
  assert.equal(insert.params[8], null, "matrix_id null");
  assert.equal(insert.params[6], null, "charge_id null");
  assert.equal(credits.clawbackForPaymentCalls.length, 0, "no capture id to key a clawback on");
});

// ── a REFUNDED then a buyer-won DISPUTE on the same capture both clawback ────
//
// Both handlers call clawbackForPayment independently — neither knows about
// the other. clawbackForPayment's own "left" cap (coinsServer.ts's
// clawbackForPayment: `take = Math.min(want, left)`) is what makes a second
// clawback on an already-fully-clawed-back capture safe (it takes at most
// what is still held, never double-counts). That cap itself is
// paymentEventHandlers' test, not this file's — this test only proves both handlers reach the
// credits dep, once each, with the ref that keeps them idempotent.

test("a REFUNDED capture that is later disputed and lost calls clawback from BOTH handlers, once each", async () => {
  const { pool: p1 } = fakePool([
    [PROVIDER_REF_SELECT, () => ({ rows: [{ matrix_id: "@disputer:site.test" }], rowCount: 1 })],
    [EVENTS_INSERT, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
    [REFUNDED_AT_UPDATE, () => ({ rows: [], rowCount: 1 })],
  ]);
  const credits = fakeCredits();
  const handlers1 = createPaypalWebhookHandlers({ pool: p1, credits: credits as never });
  await handlers1.onCaptureRefunded(refundedFixture);

  const { pool: p2 } = fakePool([
    [PROVIDER_REF_SELECT, () => ({ rows: [{ matrix_id: "@disputer:site.test" }], rowCount: 1 })],
    [EVENTS_INSERT, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
  ]);
  const handlers2 = createPaypalWebhookHandlers({ pool: p2, credits: credits as never });
  await handlers2.onDisputeResolved(buyerWonDisputeFixture);

  assert.equal(credits.clawbackForPaymentCalls.length, 2, "both the refund and the buyer-won dispute must call clawback");
  assert.equal((credits.clawbackForPaymentCalls[0] as { ref: string }).ref, "paypal:refund:1Y107995YT783435V");
  assert.equal((credits.clawbackForPaymentCalls[1] as { ref: string }).ref, "paypal:dispute-capture:00D10444LD479031K");
});

// A dispute and a reversal for the SAME capture must land on the exact same
// ref, so whichever notification PayPal delivers first takes the money back
// and the other is an idempotent no-op under the ledger's (kind, ref) unique
// index — otherwise one loss is taken twice. captureIdFromRefund on the
// reversal fixture already resolves to the SAME capture id disputeFixture's
// captureIdFromDispute resolves to (00D10444LD479031K), so no fixture surgery
// is needed here — reversedFixture is swapped for a copy whose links point at
// that capture instead of its own.
test("a buyer-won dispute and a capture reversal of the SAME capture produce the SAME clawback ref", async () => {
  const sameCaptureReversal = JSON.parse(JSON.stringify(reversedFixture));
  for (const link of sameCaptureReversal.resource.links) {
    if (link.rel === "up") {
      link.href = "https://api.sandbox.paypal.com/v2/payments/captures/00D10444LD479031K";
    }
  }

  const { pool: p1 } = fakePool([
    [PROVIDER_REF_SELECT, () => ({ rows: [{ matrix_id: "@disputer:site.test" }], rowCount: 1 })],
    [EVENTS_INSERT, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
  ]);
  const credits = fakeCredits();
  await createPaypalWebhookHandlers({ pool: p1, credits: credits as never }).onDisputeResolved(buyerWonDisputeFixture);

  const { pool: p2 } = fakePool([
    [PROVIDER_REF_SELECT, () => ({ rows: [{ matrix_id: "@disputer:site.test" }], rowCount: 1 })],
    [EVENTS_INSERT, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
  ]);
  await createPaypalWebhookHandlers({ pool: p2, credits: credits as never }).onCaptureReversed(sameCaptureReversal);

  assert.equal(credits.clawbackForPaymentCalls.length, 2, "both handlers still call the credits dep once each");
  const refs = credits.clawbackForPaymentCalls.map((c) => (c as { ref: string }).ref);
  assert.deepEqual(refs, ["paypal:dispute-capture:00D10444LD479031K", "paypal:dispute-capture:00D10444LD479031K"],
    "same ref from both handlers — the ledger's (kind, ref) unique key makes the second call a no-op");
});

// ── all four PayPal handlers are provider-tagged, never defaulting to Stripe ──

test("all four handlers pass provider: 'paypal' explicitly to recordPaymentEvent", async () => {
  const { pool: p1, seen: s1 } = fakePool([[EVENTS_INSERT, () => ({ rows: [{ id: 1 }], rowCount: 1 })]]);
  await createPaypalWebhookHandlers({ pool: p1, credits: fakeCredits() as never }).onCaptureRefunded(refundedFixture);
  assert.equal(s1.find((s) => EVENTS_INSERT.test(s.sql))!.params[0], "paypal");

  const { pool: p2, seen: s2 } = fakePool([[EVENTS_INSERT, () => ({ rows: [{ id: 1 }], rowCount: 1 })]]);
  await createPaypalWebhookHandlers({ pool: p2, credits: fakeCredits() as never }).onDisputeResolved(disputeFixture);
  assert.equal(s2.find((s) => EVENTS_INSERT.test(s.sql))!.params[0], "paypal");

  const { pool: p3, seen: s3 } = fakePool([[EVENTS_INSERT, () => ({ rows: [{ id: 1 }], rowCount: 1 })]]);
  await createPaypalWebhookHandlers({ pool: p3, credits: fakeCredits() as never }).onCaptureReversed(reversedFixture);
  assert.equal(s3.find((s) => EVENTS_INSERT.test(s.sql))!.params[0], "paypal");
});

// ══════════════════════ Piece 2: a quiet Qorm purchase ══════════════════════

test("points capture: credits a PURCHASE before completing the order — never a donations row, never on stream", async () => {
  const order: string[] = [];
  const credits = fakeCredits(order);
  const { pool, seen } = fakePool([
    [POINTS_SELECT, () => ({ rows: [{ matrix_id: "@buyer:x", amount_cents: FIX_CENTS }], rowCount: 1 })],
    [POINTS_UPDATE, () => { order.push("complete"); return { rows: [{ external_id: "e" }], rowCount: 1 }; }],
  ]);
  const calls = stubFetch(ok200);
  const { onCaptureCompleted } = createPaypalWebhookHandlers({ pool, credits: credits as never });
  const ev = pointsCaptureFixture();
  await onCaptureCompleted(ev);

  assert.deepEqual(order, ["purchase-credit", "complete"], "credit BEFORE the completing UPDATE (a retry after a failed credit must still credit)");
  assert.equal(credits.recordTipCreditCalls.length, 0, "a purchase is not a tip");
  assert.deepEqual(credits.recordPurchaseCreditCalls[0], {
    matrixId: "@buyer:x", cents: FIX_CENTS, ref: `paypal:${ev.resource.id}`,
    payment: { provider: "paypal", captureId: ev.resource.id },
  });
  assert.ok(!seen.some((q) => /site\.donations/.test(q.sql)), "a Qorm purchase must never touch site.donations");
  assert.equal(calls.length, 0, "a quiet purchase is never announced on stream");
  const upd = seen.find((q) => POINTS_UPDATE.test(q.sql))!;
  assert.deepEqual(upd.params, ["11111111-2222-3333-4444-555555555555", ev.resource.id]);
});

// A capture whose custom_id matches no order (here, one opened under a retired prefix) credits
// nobody and completes nothing — and says so loudly, because the money arrived and only a person
// can pay it out.
test("a capture that matches no order credits nothing and logs a pay-by-hand line", async () => {
  const credits = fakeCredits();
  const { pool, seen } = fakePool([]);
  const calls = stubFetch(ok200);
  const { onCaptureCompleted } = createPaypalWebhookHandlers({ pool, credits: credits as never });
  const ev = pointsCaptureFixture("99999999-8888-7777-6666-555555555555", "qorm:");
  const { errors } = await withCapturedConsole(() => onCaptureCompleted(ev));

  assert.equal(credits.recordTipCreditCalls.length, 0);
  assert.equal(credits.recordPurchaseCreditCalls.length, 0);
  assert.ok(!seen.some((q) => POINTS_SELECT.test(q.sql)), "a retired prefix is not a points purchase");
  assert.equal(seen.filter((q) => /UPDATE site\.donations/.test(q.sql)).length, 1, "the completing UPDATE runs and matches nothing");
  assert.equal(calls.length, 0, "never announced");
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]![0]), new RegExp(`capture ${ev.resource.id} matched no order .*pay by hand`));
});

test("points capture: credits min(captured, ordered) — never more than was asked for", async () => {
  const credits = fakeCredits();
  const { pool } = fakePool([
    [POINTS_SELECT, () => ({ rows: [{ matrix_id: "@buyer:x", amount_cents: FIX_CENTS - 1 }], rowCount: 1 })],
  ]);
  stubFetch(ok200);
  const { onCaptureCompleted } = createPaypalWebhookHandlers({ pool, credits: credits as never });
  const { warnings } = await withCapturedConsole(() => onCaptureCompleted(pointsCaptureFixture()));
  assert.equal((credits.recordPurchaseCreditCalls[0] as { cents: number }).cents, FIX_CENTS - 1);
  assert.ok(warnings.length >= 1, "a captured/ordered mismatch must be logged");
});

test("points capture with NO order row throws — money we cannot place must be retried, not swallowed", async () => {
  const credits = fakeCredits();
  const { pool, seen } = fakePool([]);
  const calls = stubFetch(ok200);
  const { onCaptureCompleted } = createPaypalWebhookHandlers({ pool, credits: credits as never });
  await withCapturedConsole(() =>
    assert.rejects(() => onCaptureCompleted(pointsCaptureFixture()), /no points order/),
  );
  assert.equal(credits.recordPurchaseCreditCalls.length, 0);
  assert.ok(!seen.some((q) => /site\.donations/.test(q.sql)));
  assert.equal(calls.length, 0);
});

test("points capture redelivered after the order completed: credit re-runs (idempotent on ref), nothing else happens", async () => {
  const credits = fakeCredits();
  const { pool } = fakePool([
    [POINTS_SELECT, () => ({ rows: [{ matrix_id: "@buyer:x", amount_cents: FIX_CENTS }], rowCount: 1 })],
    [POINTS_UPDATE, () => ({ rows: [], rowCount: 0 })],
  ]);
  const calls = stubFetch(ok200);
  const { onCaptureCompleted } = createPaypalWebhookHandlers({ pool, credits: credits as never });
  await onCaptureCompleted(pointsCaptureFixture());
  assert.equal(credits.recordPurchaseCreditCalls.length, 1);
  assert.equal(calls.length, 0);
});

test("a TIP capture (bare uuid) never reads paypal_coin_orders — the tip path is unchanged", async () => {
  const { pool, seen } = fakePool([[CAPTURE_UPDATE, () => ({ rows: [], rowCount: 0 })]]);
  stubFetch(ok200);
  const credits = fakeCredits();
  const { onCaptureCompleted } = createPaypalWebhookHandlers({ pool, credits: credits as never });
  await onCaptureCompleted(completedFixture);
  assert.ok(!seen.some((q) => /paypal_coin_orders/.test(q.sql)));
  assert.equal(credits.recordPurchaseCreditCalls.length, 0);
});

// ── refunds / disputes / reversals of a Qorm purchase name the buyer ───────

for (const [name, fx, call] of [
  ["refund", () => refundedFixture, "onCaptureRefunded"],
  ["reversal", () => reversedFixture, "onCaptureReversed"],
  ["buyer-won dispute", () => buyerWonDisputeFixture, "onDisputeResolved"],
] as const) {
  test(`${name} of a Qorm purchase: payment_events names the buyer and says coin_purchase, and the Qorm is clawed back`, async () => {
    const credits = fakeCredits();
    const { pool, seen } = fakePool([
      [PROVIDER_REF_SELECT, () => ({ rows: [], rowCount: 0 })],
      [POINTS_OWNER_SELECT, () => ({ rows: [{ matrix_id: "@buyer:x" }], rowCount: 1 })],
    ]);
    const handlers = createPaypalWebhookHandlers({ pool, credits: credits as never });
    await withCapturedConsole(() => handlers[call](fx()));
    const ev = seen.find((q) => EVENTS_INSERT.test(q.sql));
    assert.ok(ev, "no payment_events row recorded");
    assert.ok(ev!.params.includes("@buyer:x"), `matrix_id missing from ${JSON.stringify(ev!.params)}`);
    assert.ok(ev!.params.includes("coin_purchase"), `kind must be coin_purchase, got ${JSON.stringify(ev!.params)}`);
    assert.equal(credits.clawbackForPaymentCalls.length, 1);
  });
}

test("a refund of a TIP still records kind donation and never asks paypal_coin_orders", async () => {
  const { pool, seen } = fakePool([[PROVIDER_REF_SELECT, () => ({ rows: [{ matrix_id: "@tipper:x" }], rowCount: 1 })]]);
  const { onCaptureRefunded } = createPaypalWebhookHandlers({ pool, credits: fakeCredits() as never });
  await onCaptureRefunded(refundedFixture);
  const ev = seen.find((q) => EVENTS_INSERT.test(q.sql))!;
  assert.ok(ev.params.includes("donation"));
  assert.ok(!seen.some((q) => POINTS_OWNER_SELECT.test(q.sql)), "a found tip must not fall through to the Qorm table");
});
