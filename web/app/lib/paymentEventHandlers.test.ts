import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Stripe from "stripe";
import { createPaymentEventHandlers } from "./paymentEventHandlers.ts";

const FIXTURE_DIR = join(import.meta.dirname, "../api/billing/__fixtures__/stripe");
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), "utf8"));

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

/** A fake Stripe client exposing checkout.sessions.list, keyed by the
 *  payment_intent id it was asked for — a payment_intent with no entry
 *  resolves to no session found (`{ data: [] }`), not a throw — and
 *  paymentIntents.retrieve, keyed by payment_intent id to its metadata; a
 *  payment_intent with no entry in piMetadata throws, so an unexpected
 *  retrieve call is loud instead of silently returning something plausible. */
function fakeStripe(sessionsForPI: Record<string, string> = {}, piMetadata: Record<string, Record<string, string>> = {}): Stripe {
  return {
    checkout: {
      sessions: {
        list: async ({ payment_intent }: { payment_intent: string; limit: number }) => {
          const id = sessionsForPI[payment_intent];
          return { data: id ? [{ id }] : [] };
        },
      },
    },
    paymentIntents: {
      retrieve: async (id: string) => {
        const metadata = piMetadata[id];
        if (!metadata) throw new Error(`paymentIntents.retrieve not expected for ${id}`);
        return { metadata };
      },
    },
  } as unknown as Stripe;
}
// Handlers other than handlePaymentFailed never touch deps.stripe — this
// throwing stub makes an accidental call loud instead of silently passing.
const STRIPE_NOT_EXPECTED = () => {
  throw new Error("this handler must not call the stripe dep");
};

// A fake MoneyCredits recording every call — required dep, so every
// createPaymentEventHandlers({...}) below carries one, even the tests that
// never expect a clawback.
function fakeCredits() {
  const clawbackForPaymentCalls: unknown[] = [];
  const restoreClawbackCalls: unknown[] = [];
  return {
    recordTipCredit: async () => {},
    clawbackForPayment: async (a: unknown) => { clawbackForPaymentCalls.push(a); },
    restoreClawback: async (a: unknown) => { restoreClawbackCalls.push(a); },
    clawbackForPaymentCalls,
    restoreClawbackCalls,
  };
}

// Extend the refund.created / charge.dispute.created fixtures with the id,
// amount, currency or status a test needs, and (for refund) the type that
// selects refund.created vs refund.updated / dispute.created vs .closed.
function refundEvent(
  over: Partial<{ id: string; amount: number; payment_intent: string; currency: string; status: string }> = {},
  type: "refund.created" | "refund.updated" = "refund.created"
) {
  const base = fixture("refund.created");
  return { ...base, type, data: { object: { ...base.data.object, ...over } } };
}
function disputeEvent(
  over: Partial<{ id: string; amount: number; payment_intent: string; currency: string; status: string }> = {},
  type: "charge.dispute.created" | "charge.dispute.closed" = "charge.dispute.created"
) {
  const base = fixture("charge.dispute.created");
  return { ...base, type, data: { object: { ...base.data.object, ...over } } };
}

const INSERT = /INSERT INTO site\.payment_events/;

test("handlePaymentFailed: guest's empty matrix_id inserts NULL, kind from metadata, session_id resolved via checkout.sessions.list", async () => {
  const { pool, seen } = fakePool([[INSERT, () => ({ rows: [{ id: 1 }], rowCount: 1 })]]);
  const stripe = fakeStripe({ pi_3UITEsTestAcct000KfmG9lb: "cs_test_guestSession" });
  await createPaymentEventHandlers({ pool, stripe: () => stripe, credits: fakeCredits() as never }).handlePaymentFailed(fixture("payment_intent.payment_failed.guest"));
  const q = seen.find((s) => INSERT.test(s.sql))!;
  assert.equal(q.params[4], "cs_test_guestSession", "session_id must come from the checkout.sessions.list lookup, not be left unset");
  assert.equal(q.params[8], null, "matrix_id must be NULL, never ''");
  assert.equal(q.params[9], "donation");
  assert.equal(q.params[12], "failed");
  assert.equal(q.params[13], "payment_intent_payment_attempt_failed");
  assert.equal(q.params[14], "generic_decline");
  assert.match(String(q.params[15]), /Your bank declined this payment\. You were not charged\./);
});

test("handlePaymentFailed: no matching session -> session_id NULL, not a throw", async () => {
  const { pool, seen } = fakePool([[INSERT, () => ({ rows: [{ id: 1 }], rowCount: 1 })]]);
  await createPaymentEventHandlers({ pool, stripe: () => fakeStripe({}), credits: fakeCredits() as never }).handlePaymentFailed(fixture("payment_intent.payment_failed.guest"));
  assert.equal(seen.find((s) => INSERT.test(s.sql))!.params[4], null);
});

test("a checkout.sessions.list throw propagates — the webhook route needs it to 500, same as a recordPaymentEvent throw", async () => {
  const { pool } = fakePool([[INSERT, () => ({ rows: [{ id: 1 }], rowCount: 1 })]]);
  const stripe = { checkout: { sessions: { list: async () => { throw new Error("stripe API down"); } } } } as unknown as Stripe;
  await assert.rejects(
    () => createPaymentEventHandlers({ pool, stripe: () => stripe, credits: fakeCredits() as never }).handlePaymentFailed(fixture("payment_intent.payment_failed.guest")),
    /stripe API down/
  );
});

test("handlePaymentFailed: subscription-mode (only a customer) resolves via stripe_customer_id, kind sub", async () => {
  const { pool, seen } = fakePool([
    [/FROM site\.subscriptions/, () => ({ rows: [{ matrix_id: "@resolved:x" }], rowCount: 1 })],
    [INSERT, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
  ]);
  const stripe = fakeStripe({ pi_3UITAfTestAcct000P9SGrk8: "cs_test_subSession" });
  await createPaymentEventHandlers({ pool, stripe: () => stripe, credits: fakeCredits() as never }).handlePaymentFailed(fixture("payment_intent.payment_failed.customer"));
  assert.deepEqual(seen.find((s) => /FROM site\.subscriptions/.test(s.sql))!.params, ["cus_TestCust000001"]);
  const q = seen.find((s) => INSERT.test(s.sql))!;
  assert.equal(q.params[4], "cs_test_subSession");
  assert.equal(q.params[8], "@resolved:x");
  assert.equal(q.params[9], "sub", "no metadata.kind but a session was found: a subscription-mode Checkout's first invoice");
});

test("handlePaymentFailed: no metadata.kind and no session -> not recorded (invoice.payment_failed records this renewal instead)", async () => {
  const { pool, seen } = fakePool([
    [/FROM site\.subscriptions/, () => ({ rows: [{ matrix_id: "@resolved:x" }], rowCount: 1 })],
    [INSERT, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
  ]);
  await createPaymentEventHandlers({ pool, stripe: () => fakeStripe({}), credits: fakeCredits() as never }).handlePaymentFailed(fixture("payment_intent.payment_failed.customer"));
  assert.equal(seen.find((s) => INSERT.test(s.sql)), undefined, "no INSERT attempted — a second row would double-count the renewal");
});

test("handleRefund: sets refunded_at via the payment_intent join, and carries the tipper's identity", async () => {
  const { pool, seen } = fakePool([
    [/FROM site\.donations/, () => ({ rows: [{ matrix_id: "@refunder:x" }], rowCount: 1 })],
    [INSERT, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
    [/UPDATE site\.donations/, () => ({ rows: [], rowCount: 1 })],
  ]);
  await createPaymentEventHandlers({ pool, stripe: STRIPE_NOT_EXPECTED, credits: fakeCredits() as never }).handleRefund(fixture("refund.created"));
  const q = seen.find((s) => INSERT.test(s.sql))!;
  assert.equal(q.params[8], "@refunder:x");
  assert.equal(q.params[9], "donation");
  assert.equal(q.params[12], "refunded");
  assert.deepEqual(seen.find((s) => /UPDATE site\.donations/.test(s.sql))!.params, ["pi_3UIRIoTestAcct000DepJqGA"]);
});

test("handleDispute: created + closed each insert one row, resolved via site.donations", async () => {
  const { pool, seen } = fakePool([
    [/FROM site\.donations/, () => ({ rows: [{ matrix_id: "@disputer:x" }], rowCount: 1 })],
    [INSERT, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
  ]);
  // STRIPE_NOT_EXPECTED: site.donations resolves, so paymentIntents.retrieve must never be called.
  const { handleDispute } = createPaymentEventHandlers({ pool, stripe: STRIPE_NOT_EXPECTED, credits: fakeCredits() as never });
  await handleDispute(fixture("charge.dispute.created"));
  await handleDispute(fixture("charge.dispute.closed"));
  const inserts = seen.filter((s) => INSERT.test(s.sql));
  assert.equal(inserts.length, 2);
  assert.equal(inserts[0]!.params[12], "dispute_opened");
  assert.equal(inserts[1]!.params[12], "dispute_closed");
  for (const ins of inserts) {
    assert.equal(ins.params[8], "@disputer:x");
    assert.equal(ins.params[9], "donation");
  }
});

test("handleDispute: unresolved by site.donations falls back to the payment_intent's own metadata", async () => {
  const { pool, seen } = fakePool([
    [/FROM site\.donations/, () => ({ rows: [], rowCount: 0 })],
    [INSERT, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
  ]);
  const stripe = fakeStripe({}, { pi_3UITAcTestAcct0000Bhc0Qo: { kind: "coin_purchase", matrix_id: "@buyer:x" } });
  const { handleDispute } = createPaymentEventHandlers({ pool, stripe: () => stripe, credits: fakeCredits() as never });
  await handleDispute(fixture("charge.dispute.created"));
  const q = seen.find((s) => INSERT.test(s.sql))!;
  assert.equal(q.params[8], "@buyer:x");
  assert.equal(q.params[9], "coin_purchase");
});

test("handleInvoicePaymentFailed: renewal_failed, resolved via stripe_customer_id", async () => {
  const { pool, seen } = fakePool([
    [/FROM site\.subscriptions/, () => ({ rows: [{ matrix_id: "@renewer:x" }], rowCount: 1 })],
    [INSERT, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
  ]);
  await createPaymentEventHandlers({ pool, stripe: STRIPE_NOT_EXPECTED, credits: fakeCredits() as never }).handleInvoicePaymentFailed(fixture("invoice.payment_failed"));
  const q = seen.find((s) => INSERT.test(s.sql))!;
  assert.equal(q.params[7], "sub_1PLACEHOLDER");
  assert.equal(q.params[8], "@renewer:x");
  assert.equal(q.params[9], "sub");
  assert.equal(q.params[12], "renewal_failed");
});

test("a redelivered event does not throw or dedupe in the handler (DB-layer ON CONFLICT is tested separately)", async () => {
  let calls = 0;
  const { pool } = fakePool([[INSERT, () => { calls += 1; return calls === 1 ? { rows: [{ id: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 }; }]]);
  const { handlePaymentFailed } = createPaymentEventHandlers({ pool, stripe: () => fakeStripe({}), credits: fakeCredits() as never });
  const ev = fixture("payment_intent.payment_failed.guest");
  await handlePaymentFailed(ev);
  await handlePaymentFailed(ev);
  assert.equal(calls, 2, "both deliveries attempt the insert");
});

test("a recordPaymentEvent throw propagates — the webhook route needs it to 500", async () => {
  const { pool } = fakePool([[INSERT, () => { throw new Error("pool exhausted"); }]]);
  await assert.rejects(
    () => createPaymentEventHandlers({ pool, stripe: () => fakeStripe({}), credits: fakeCredits() as never }).handlePaymentFailed(fixture("payment_intent.payment_failed.guest")),
    /pool exhausted/
  );
});

// ── Qorm clawback / restore ─────────────────────────────────────────────────

test("refund.created claws back the refunded amount, keyed on the refund id", async () => {
  const { pool } = fakePool([
    [/FROM site\.donations/, () => ({ rows: [{ matrix_id: "@refunder:x" }], rowCount: 1 })],
    [INSERT, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
    [/UPDATE site\.donations/, () => ({ rows: [], rowCount: 1 })],
  ]);
  const credits = fakeCredits();
  await createPaymentEventHandlers({ pool, stripe: STRIPE_NOT_EXPECTED, credits: credits as never })
    .handleRefund(refundEvent({ id: "re_1", amount: 200, payment_intent: "pi_1" }) as never);
  assert.equal(credits.clawbackForPaymentCalls.length, 1);
  assert.deepEqual(credits.clawbackForPaymentCalls[0], {
    payment: { provider: "stripe", paymentIntent: "pi_1" },
    cents: 200, ref: "stripe:refund:re_1", reason: "refund",
  });
});

test("refund.updated records only — no second clawback", async () => {
  const { pool } = fakePool([
    [/FROM site\.donations/, () => ({ rows: [{ matrix_id: "@refunder:x" }], rowCount: 1 })],
    [INSERT, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
    [/UPDATE site\.donations/, () => ({ rows: [], rowCount: 1 })],
  ]);
  const credits = fakeCredits();
  await createPaymentEventHandlers({ pool, stripe: STRIPE_NOT_EXPECTED, credits: credits as never })
    .handleRefund(refundEvent({ id: "re_1", amount: 200, payment_intent: "pi_1" }, "refund.updated") as never);
  assert.equal(credits.clawbackForPaymentCalls.length, 0);
});

test("a non-USD refund never trusts refund.amount as cents — claws back everything held for that payment, and logs no payer field", async () => {
  const { pool } = fakePool([
    [/FROM site\.donations/, () => ({ rows: [{ matrix_id: "@refunder:x" }], rowCount: 1 })],
    [INSERT, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
    [/UPDATE site\.donations/, () => ({ rows: [], rowCount: 1 })],
  ]);
  const credits = fakeCredits();
  const warnings: unknown[][] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    await createPaymentEventHandlers({ pool, stripe: STRIPE_NOT_EXPECTED, credits: credits as never })
      .handleRefund(refundEvent({ id: "re_2", amount: 12345, payment_intent: "pi_1", currency: "jpy" }) as never);
  } finally {
    console.warn = origWarn;
  }
  assert.equal(credits.clawbackForPaymentCalls.length, 1);
  assert.deepEqual(credits.clawbackForPaymentCalls[0], {
    payment: { provider: "stripe", paymentIntent: "pi_1" },
    cents: Number.MAX_SAFE_INTEGER, ref: "stripe:refund:re_2", reason: "refund",
  });
  assert.equal(warnings.length, 1, "a non-USD settlement must warn once");
  assert.equal(warnings[0]!.includes("pi_1"), true, "the warning must name the payment intent");
  assert.equal(
    warnings[0]!.some((a) => typeof a === "string" && /refunder|matrix|@/i.test(a)),
    false,
    "the warning must never carry a payer field"
  );
});

test("charge.dispute.created claws back the disputed amount", async () => {
  const { pool } = fakePool([
    [/FROM site\.donations/, () => ({ rows: [{ matrix_id: "@disputer:x" }], rowCount: 1 })],
    [INSERT, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
  ]);
  const credits = fakeCredits();
  await createPaymentEventHandlers({ pool, stripe: STRIPE_NOT_EXPECTED, credits: credits as never })
    .handleDispute(disputeEvent({ id: "du_1", amount: 300, payment_intent: "pi_1" }) as never);
  assert.equal(credits.clawbackForPaymentCalls.length, 1);
  assert.deepEqual(credits.clawbackForPaymentCalls[0], {
    payment: { provider: "stripe", paymentIntent: "pi_1" },
    cents: 300, ref: "stripe:dispute:du_1", reason: "dispute",
  });
});

test("a non-USD dispute never trusts dispute.amount as cents — claws back everything held for that payment, and logs no payer field", async () => {
  const { pool } = fakePool([
    [/FROM site\.donations/, () => ({ rows: [{ matrix_id: "@disputer:x" }], rowCount: 1 })],
    [INSERT, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
  ]);
  const credits = fakeCredits();
  const warnings: unknown[][] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    await createPaymentEventHandlers({ pool, stripe: STRIPE_NOT_EXPECTED, credits: credits as never })
      .handleDispute(disputeEvent({ id: "du_2", amount: 5000, payment_intent: "pi_1", currency: "jpy" }) as never);
  } finally {
    console.warn = origWarn;
  }
  assert.equal(credits.clawbackForPaymentCalls.length, 1);
  assert.deepEqual(credits.clawbackForPaymentCalls[0], {
    payment: { provider: "stripe", paymentIntent: "pi_1" },
    cents: Number.MAX_SAFE_INTEGER, ref: "stripe:dispute:du_2", reason: "dispute",
  });
  assert.equal(warnings.length, 1, "a non-USD settlement must warn once");
  assert.equal(warnings[0]!.includes("pi_1"), true, "the warning must name the payment intent");
  assert.equal(
    warnings[0]!.some((a) => typeof a === "string" && /disputer|matrix|@/i.test(a)),
    false,
    "the warning must never carry a payer field"
  );
});

test("charge.dispute.closed with status won restores that dispute's clawback", async () => {
  const { pool } = fakePool([
    [/FROM site\.donations/, () => ({ rows: [{ matrix_id: "@disputer:x" }], rowCount: 1 })],
    [INSERT, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
  ]);
  const credits = fakeCredits();
  await createPaymentEventHandlers({ pool, stripe: STRIPE_NOT_EXPECTED, credits: credits as never })
    .handleDispute(disputeEvent({ id: "du_1", amount: 300, payment_intent: "pi_1", status: "won" }, "charge.dispute.closed") as never);
  assert.equal(credits.restoreClawbackCalls.length, 1);
  assert.deepEqual(credits.restoreClawbackCalls[0], {
    clawbackRef: "stripe:dispute:du_1", ref: "stripe:dispute-won:du_1",
  });
});

test("charge.dispute.closed with status warning_closed restores that dispute's clawback — an inquiry that closed without escalating", async () => {
  const { pool } = fakePool([
    [/FROM site\.donations/, () => ({ rows: [{ matrix_id: "@disputer:x" }], rowCount: 1 })],
    [INSERT, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
  ]);
  const credits = fakeCredits();
  await createPaymentEventHandlers({ pool, stripe: STRIPE_NOT_EXPECTED, credits: credits as never })
    .handleDispute(disputeEvent({ id: "du_1", amount: 300, payment_intent: "pi_1", status: "warning_closed" }, "charge.dispute.closed") as never);
  assert.equal(credits.restoreClawbackCalls.length, 1);
  assert.deepEqual(credits.restoreClawbackCalls[0], {
    clawbackRef: "stripe:dispute:du_1", ref: "stripe:dispute-won:du_1",
  });
});

test("charge.dispute.closed with status lost does nothing more", async () => {
  const { pool } = fakePool([
    [/FROM site\.donations/, () => ({ rows: [{ matrix_id: "@disputer:x" }], rowCount: 1 })],
    [INSERT, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
  ]);
  const credits = fakeCredits();
  await createPaymentEventHandlers({ pool, stripe: STRIPE_NOT_EXPECTED, credits: credits as never })
    .handleDispute(disputeEvent({ id: "du_1", amount: 300, payment_intent: "pi_1", status: "lost" }, "charge.dispute.closed") as never);
  assert.equal(credits.restoreClawbackCalls.length, 0);
  assert.equal(credits.clawbackForPaymentCalls.length, 0);
});

// ── refund.updated failed/canceled restores the clawback ───────────────────
//
// A refund that later fails or is canceled never actually moved money back
// to the buyer, but refund.created already ran the clawback — so the wallet
// must get its Qorm back, the same way a won dispute does.

test("refund.updated with status failed restores the clawback taken on refund.created", async () => {
  const { pool } = fakePool([
    [/FROM site\.donations/, () => ({ rows: [{ matrix_id: "@refunder:x" }], rowCount: 1 })],
    [INSERT, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
    [/UPDATE site\.donations/, () => ({ rows: [], rowCount: 1 })],
  ]);
  const credits = fakeCredits();
  await createPaymentEventHandlers({ pool, stripe: STRIPE_NOT_EXPECTED, credits: credits as never })
    .handleRefund(refundEvent({ id: "re_9", amount: 200, payment_intent: "pi_1", status: "failed" }, "refund.updated") as never);
  assert.equal(credits.clawbackForPaymentCalls.length, 0, "refund.updated never claws back — only refund.created does");
  assert.equal(credits.restoreClawbackCalls.length, 1);
  assert.deepEqual(credits.restoreClawbackCalls[0], {
    clawbackRef: "stripe:refund:re_9", ref: "stripe:refund-reversed:re_9",
  });
});

test("refund.updated with status canceled restores the clawback taken on refund.created", async () => {
  const { pool } = fakePool([
    [/FROM site\.donations/, () => ({ rows: [{ matrix_id: "@refunder:x" }], rowCount: 1 })],
    [INSERT, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
    [/UPDATE site\.donations/, () => ({ rows: [], rowCount: 1 })],
  ]);
  const credits = fakeCredits();
  await createPaymentEventHandlers({ pool, stripe: STRIPE_NOT_EXPECTED, credits: credits as never })
    .handleRefund(refundEvent({ id: "re_10", amount: 200, payment_intent: "pi_1", status: "canceled" }, "refund.updated") as never);
  assert.equal(credits.clawbackForPaymentCalls.length, 0);
  assert.equal(credits.restoreClawbackCalls.length, 1);
  assert.deepEqual(credits.restoreClawbackCalls[0], {
    clawbackRef: "stripe:refund:re_10", ref: "stripe:refund-reversed:re_10",
  });
});

test("refund.updated with status succeeded does nothing more — the refund completed normally", async () => {
  const { pool } = fakePool([
    [/FROM site\.donations/, () => ({ rows: [{ matrix_id: "@refunder:x" }], rowCount: 1 })],
    [INSERT, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
    [/UPDATE site\.donations/, () => ({ rows: [], rowCount: 1 })],
  ]);
  const credits = fakeCredits();
  await createPaymentEventHandlers({ pool, stripe: STRIPE_NOT_EXPECTED, credits: credits as never })
    .handleRefund(refundEvent({ id: "re_11", amount: 200, payment_intent: "pi_1", status: "succeeded" }, "refund.updated") as never);
  assert.equal(credits.clawbackForPaymentCalls.length, 0);
  assert.equal(credits.restoreClawbackCalls.length, 0);
});

test("refund.updated with status pending does nothing more — still in flight", async () => {
  const { pool } = fakePool([
    [/FROM site\.donations/, () => ({ rows: [{ matrix_id: "@refunder:x" }], rowCount: 1 })],
    [INSERT, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
    [/UPDATE site\.donations/, () => ({ rows: [], rowCount: 1 })],
  ]);
  const credits = fakeCredits();
  await createPaymentEventHandlers({ pool, stripe: STRIPE_NOT_EXPECTED, credits: credits as never })
    .handleRefund(refundEvent({ id: "re_12", amount: 200, payment_intent: "pi_1", status: "pending" }, "refund.updated") as never);
  assert.equal(credits.clawbackForPaymentCalls.length, 0);
  assert.equal(credits.restoreClawbackCalls.length, 0);
});
