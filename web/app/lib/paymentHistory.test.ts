// Run: node --test app/lib/paymentHistory.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { receivedRow, problemRow, mergePayments, paymentSource } from "./paymentHistory.ts";

const r = (id: number, at: string, extra = {}) => receivedRow({ id, created_at: at, username: `p${id}`, event_type: "donation", amount_usd: "5.25", platform: "native", ...extra });
const p = (id: number, at: string) => problemRow({ id, occurred_at: at, matrix_id: null, display_name: null, kind: "donation", amount_cents: 500, currency: "eur", outcome: "failed", reason_text: "card declined", payment_intent_id: "pi_1", subscription_id: null });

test("a received payment: amount in cents, the site's own platform reads as 'site'", () => {
  const row = r(1, "2026-10-01T00:00:00Z");
  assert.equal(row.amount, 525);
  assert.equal(row.outcome, "received");
  assert.equal(row.source, "site");
  assert.equal(row.points, false);
});

test("points spends are marked, so they are not read as card payments", () => {
  assert.equal(r(1, "2026-10-01T00:00:00Z", { event_type: "sticker" }).points, true);
  assert.equal(r(1, "2026-10-01T00:00:00Z", { event_type: "cheer", platform: "twitch" }).points, false, "a platform's cheer is money");
});

test("a problem keeps its outcome, its currency and its Stripe link; no payer → guest", () => {
  const row = p(9, "2026-10-01T00:00:00Z");
  assert.equal(row.outcome, "failed");
  assert.equal(row.currency, "eur");
  assert.equal(row.who, "guest");
  assert.equal(row.link, "https://dashboard.stripe.com/payments/pi_1");
});

test("merged newest first, cut to the limit, with a cursor when more remain", () => {
  const out = mergePayments([r(1, "2026-10-03T00:00:00Z"), r(2, "2026-10-01T00:00:00Z")], [p(1, "2026-10-02T00:00:00Z")], 2, { received: false, problems: false });
  assert.deepEqual(out.rows.map((x) => x.key), ["r:1", "p:1"]);
  assert.equal(out.nextBefore, "2026-10-02T00:00:00.000Z");
  const all = mergePayments([r(1, "2026-10-03T00:00:00Z")], [], 5, { received: false, problems: false });
  assert.equal(all.nextBefore, null);
});

test("sources: platforms keep their name", () => {
  assert.equal(paymentSource("kofi"), "kofi");
  assert.equal(paymentSource("native"), "site");
});
