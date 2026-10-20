import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyToNull, createPaymentEventsServer } from "./paymentEventsServer.ts";

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

test("emptyToNull: trims, then '' -> null; real strings pass through", () => {
  assert.equal(emptyToNull(""), null);
  assert.equal(emptyToNull("  "), null);
  assert.equal(emptyToNull(null), null);
  assert.equal(emptyToNull(undefined), null);
  assert.equal(emptyToNull("@a:x"), "@a:x");
  assert.equal(emptyToNull("  @a:x  "), "@a:x");
});

const BASE_ROW = {
  eventId: "evt_1", eventType: "payment_intent.payment_failed",
  occurredAt: new Date("2026-09-22T00:00:00Z"),
  sessionId: null, paymentIntentId: "pi_1", chargeId: null, subscriptionId: null,
  matrixId: null, kind: "donation", amountCents: 500, currency: "usd",
  outcome: "failed", reasonCode: "insufficient_funds", declineCode: null,
  reasonText: "Insufficient funds. You were not charged. Try another payment method or card.",
};

test("recordPaymentEvent: 16 positional params, ON CONFLICT DO NOTHING RETURNING id", async () => {
  const { pool, seen } = fakePool([[/INSERT INTO site\.payment_events/, () => ({ rows: [{ id: 1 }], rowCount: 1 })]]);
  const { recordPaymentEvent } = createPaymentEventsServer({ pool });
  assert.deepEqual(await recordPaymentEvent(BASE_ROW), { inserted: true });
  const q = seen[0]!;
  assert.match(q.sql, /ON CONFLICT \(event_id\) DO NOTHING/);
  assert.match(q.sql, /RETURNING id/);
  assert.equal(q.params.length, 16);
  assert.equal(q.params[0], "stripe"); // provider defaults when omitted
  assert.equal(q.params[1], "evt_1"); // event_id
});

test("recordPaymentEvent: a duplicate event_id inserts nothing", async () => {
  const { pool } = fakePool([[/INSERT INTO site\.payment_events/, () => ({ rows: [], rowCount: 0 })]]);
  assert.deepEqual(await createPaymentEventsServer({ pool }).recordPaymentEvent(BASE_ROW), { inserted: false });
});

test("markDonationRefunded: idempotent UPDATE guarded by refunded_at IS NULL", async () => {
  const { pool, seen } = fakePool([[/UPDATE site\.donations/, () => ({ rows: [], rowCount: 1 })]]);
  await createPaymentEventsServer({ pool }).markDonationRefunded("pi_1");
  assert.match(seen[0]!.sql, /SET refunded_at = NOW\(\)/);
  assert.match(seen[0]!.sql, /WHERE stripe_payment_intent = \$1 AND refunded_at IS NULL/);
  assert.deepEqual(seen[0]!.params, ["pi_1"]);
});

test("resolveMatrixIdByCustomer: found and not-found", async () => {
  const found = fakePool([[/FROM site\.subscriptions/, () => ({ rows: [{ matrix_id: "@a:x" }], rowCount: 1 })]]);
  assert.equal(await createPaymentEventsServer({ pool: found.pool }).resolveMatrixIdByCustomer("cus_1"), "@a:x");
  assert.match(found.seen[0]!.sql, /WHERE stripe_customer_id = \$1\s*\n\s*ORDER BY updated_at DESC NULLS LAST LIMIT 1/);
  const missing = fakePool([[/FROM site\.subscriptions/, () => ({ rows: [], rowCount: 0 })]]);
  assert.equal(await createPaymentEventsServer({ pool: missing.pool }).resolveMatrixIdByCustomer("cus_2"), null);
});

test("resolveMatrixIdByPaymentIntent: found, via site.donations", async () => {
  const found = fakePool([[/FROM site\.donations/, () => ({ rows: [{ matrix_id: "@b:x" }], rowCount: 1 })]]);
  assert.equal(await createPaymentEventsServer({ pool: found.pool }).resolveMatrixIdByPaymentIntent("pi_9"), "@b:x");
  assert.match(found.seen[0]!.sql, /WHERE stripe_payment_intent = \$1/);
});
