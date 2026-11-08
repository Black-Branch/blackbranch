// A refund or dispute of SUPPORT reaches stream-api's ledger as a reversal keyed to the original
// credit's spendId; a points purchase never does; a reversal whose outcome came first (cancelled in
// site.payment_reversals) reverses nothing; a failed refund or a won dispute restores; a 202 (held by
// stream-api until the credit lands) is success; anything else — a 404 unknown_event included —
// throws so the provider redelivers.
// Run: node --test app/lib/paymentReversalsLedger.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type Stripe from "stripe";
process.env.STREAM_API_URL ??= "http://stream-api.test"; // no default (streamApi.ts); nothing is fetched here
const { createSupportReversals } = await import("./paymentReversalsLedger.ts");

type Session = { id: string; mode: string; amount_total: number; metadata?: Record<string, string>; subscription?: string | null };

function rig(opts: { session?: Session | null; invoice?: { id: string; billing_reason: string; amount_paid: number; parent?: unknown } | null;
  cancelled?: string[]; donationCents?: number | null; answer?: { status: number; body: unknown } } = {}) {
  const posts: Record<string, unknown>[] = [];
  const ended: string[] = [];
  const restored: string[] = [];
  const stripe = {
    checkout: { sessions: { list: async () => ({ data: opts.session ? [opts.session] : [] }) } },
    invoicePayments: { list: async () => ({ data: opts.invoice ? [{ invoice: opts.invoice.id }] : [] }) },
    invoices: { retrieve: async () => opts.invoice },
  } as unknown as Stripe;
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      if (/payment_reversals/.test(sql)) return { rows: (opts.cancelled ?? []).includes(String(params[0])) ? [{ status: "cancelled" }] : [] };
      if (/site\.donations/.test(sql)) return { rows: opts.donationCents != null ? [{ amount_cents: opts.donationCents }] : [] };
      throw new Error(`unexpected query ${sql}`);
    },
  };
  const answer = opts.answer ?? { status: 200, body: { ok: true } };
  const r = createSupportReversals({
    pool: pool as never,
    stripe: () => stripe,
    post: async (_path, body) => { posts.push(body as Record<string, unknown>); return new Response(JSON.stringify(answer.body), { status: answer.status }); },
    endGift: async (g) => { ended.push(g.sessionId); },
    restoreGift: async (ref) => { restored.push(ref); },
  });
  return { ...r, posts, ended, restored };
}
const ev = (type: string, object: Record<string, unknown>) => ({ type, data: { object } }) as unknown as Stripe.Event;
const DONATION: Session = { id: "cs_1", mode: "payment", amount_total: 1000, metadata: { kind: "donation" } };

test("a partial Stripe refund of a donation reverses its share, keyed to the original spendId", async () => {
  const h = rig({ session: DONATION });
  await h.onStripeEvent(ev("refund.created", { id: "re_1", payment_intent: "pi_1", amount: 400, status: "succeeded" }));
  assert.deepEqual(h.posts, [{ kind: "donation", spendId: "donation:cs_1", ref: "stripe:refund:re_1", reason: "refund", refunded: 400, gross: 1000 }]);
});

test("gifts, first subscriptions and renewals map to their own spendIds", async () => {
  const g = rig({ session: { id: "cs_g", mode: "payment", amount_total: 500, metadata: { kind: "gift" } } });
  await g.onStripeEvent(ev("charge.dispute.created", { id: "dp_1", payment_intent: "pi_g", amount: 500 }));
  assert.equal(g.posts[0]!.spendId, "gift:cs_g");
  assert.equal(g.posts[0]!.reason, "dispute");
  const s = rig({ session: { id: "cs_s", mode: "subscription", amount_total: 499, subscription: "sub_1" } });
  await s.onStripeEvent(ev("refund.created", { id: "re_s", payment_intent: "pi_s", amount: 499 }));
  assert.equal(s.posts[0]!.spendId, "sub:sub_1");
  const r = rig({ session: null, invoice: { id: "in_9", billing_reason: "subscription_cycle", amount_paid: 499 } });
  await r.onStripeEvent(ev("refund.created", { id: "re_r", payment_intent: "pi_r", amount: 499 }));
  assert.equal(r.posts[0]!.spendId, "renewal:in_9");
  assert.equal(r.posts[0]!.kind, "sub");
});

test("a points purchase is never support: nothing reaches the ledger", async () => {
  const h = rig({ session: { id: "cs_q", mode: "payment", amount_total: 500, metadata: { kind: "coin_purchase" } } });
  await h.onStripeEvent(ev("refund.created", { id: "re_q", payment_intent: "pi_q", amount: 500 }));
  assert.equal(h.posts.length, 0);
});

test("an outcome that came first (cancelled) reverses nothing; a failed refund / won dispute restores", async () => {
  const h = rig({ session: DONATION, cancelled: ["stripe:refund:re_2"] });
  await h.onStripeEvent(ev("refund.created", { id: "re_2", payment_intent: "pi_1", amount: 1000 }));
  assert.equal(h.posts.length, 0, "a reversal whose refund already failed took support back");
  await h.onStripeEvent(ev("refund.updated", { id: "re_3", payment_intent: "pi_1", amount: 1000, status: "failed" }));
  await h.onStripeEvent(ev("charge.dispute.closed", { id: "dp_2", payment_intent: "pi_1", amount: 1000, status: "won" }));
  assert.deepEqual(h.posts.map((p) => [p.reason, p.ref]), [["restore", "stripe:refund:re_3"], ["restore", "stripe:dispute:dp_2"]]);
});

test("PayPal: a refunded tip reverses; a reversal and a buyer-won dispute of one capture share ONE ref", async () => {
  const h = rig({ donationCents: 2000 });
  const links = [{ rel: "up", href: "https://api.paypal.test/v2/payments/captures/CAP1" }];
  await h.onPaypalEvent({ event_type: "PAYMENT.CAPTURE.REFUNDED", resource: { id: "RF1", amount: { value: "5.00" }, links } });
  await h.onPaypalEvent({ event_type: "PAYMENT.CAPTURE.REVERSED", resource: { id: "RV1", amount: { value: "20.00" }, links } });
  await h.onPaypalEvent({ event_type: "CUSTOMER.DISPUTE.RESOLVED", resource: { dispute_amount: { value: "20.00" },
    dispute_outcome: { outcome_code: "RESOLVED_BUYER_FAVOUR" }, disputed_transactions: [{ seller_transaction_id: "CAP1" }] } });
  await h.onPaypalEvent({ event_type: "CUSTOMER.DISPUTE.RESOLVED", resource: { dispute_amount: { value: "20.00" },
    dispute_outcome: { outcome_code: "RESOLVED_SELLER_FAVOUR" }, disputed_transactions: [{ seller_transaction_id: "CAP1" }] } });
  assert.deepEqual(h.posts.map((p) => [p.spendId, p.ref, p.reason, p.refunded, p.gross]), [
    ["donation:paypal:CAP1", "paypal:refund:RF1", "refund", 500, 2000],
    ["donation:paypal:CAP1", "paypal:dispute-capture:CAP1", "dispute", 2000, 2000],
    ["donation:paypal:CAP1", "paypal:dispute-capture:CAP1", "dispute", 2000, 2000],
  ]);
});

test("PayPal: a capture that is no tip (a points purchase) reaches nothing", async () => {
  const h = rig({ donationCents: null });
  await h.onPaypalEvent({ event_type: "PAYMENT.CAPTURE.REFUNDED", resource: { id: "RF2", amount: { value: "5.00" },
    links: [{ rel: "up", href: "https://api.paypal.test/v2/payments/captures/CAP2" }] } });
  assert.equal(h.posts.length, 0);
});

test("a held reversal (202) is success; 404 unknown_event and any other refusal throw so the provider redelivers", async () => {
  const quiet = console.warn;
  const warned: string[] = [];
  console.warn = (...a: unknown[]) => { warned.push(a.join(" ")); };
  try {
    const held = rig({ session: DONATION, answer: { status: 202, body: { ok: true, held: "pending" } } });
    await held.onStripeEvent(ev("refund.created", { id: "re_h", payment_intent: "pi_1", amount: 100 }));
  } finally { console.warn = quiet; }
  assert.equal(warned.length, 1, "a held reversal must say so");
  // Answering success here would drop the refund, and a later reconcile would credit it in full.
  const lost = rig({ session: DONATION, answer: { status: 404, body: { error: "unknown_event" } } });
  await assert.rejects(lost.onStripeEvent(ev("refund.created", { id: "re_x", payment_intent: "pi_1", amount: 100 })), /answered 404/);
  const bad = rig({ session: DONATION, answer: { status: 503, body: { error: "x" } } });
  await assert.rejects(bad.onStripeEvent(ev("refund.created", { id: "re_y", payment_intent: "pi_1", amount: 100 })), /answered 503/);
});

// Area-1 round 2, A1-09 / P10 (k 2026-10-25): a refunded or disputed gift kept entitling its
// recipient for its whole term while the money was gone. A refund or a dispute of a gift now ends
// the gift at once, beside the ledger reversal it already wrote.
test("a refunded gift and a disputed gift each end that gift, and still reverse its money", async () => {
  const GIFT: Session = { id: "cs_g9", mode: "payment", amount_total: 500, metadata: { kind: "gift" } };
  const refunded = rig({ session: GIFT });
  await refunded.onStripeEvent(ev("refund.created", { id: "re_g9", payment_intent: "pi_g9", amount: 500 }));
  assert.deepEqual(refunded.ended, ["cs_g9"]);
  assert.equal(refunded.posts[0]!.spendId, "gift:cs_g9", "the ledger reversal is written as before");
  const disputed = rig({ session: GIFT });
  await disputed.onStripeEvent(ev("charge.dispute.created", { id: "dp_g9", payment_intent: "pi_g9", amount: 500 }));
  assert.deepEqual(disputed.ended, ["cs_g9"]);
  assert.equal(disputed.posts[0]!.reason, "dispute");
  // Not a gift: nothing ended. An outcome that came first (the refund failed): nothing ended either.
  const tip = rig({ session: DONATION });
  await tip.onStripeEvent(ev("refund.created", { id: "re_t", payment_intent: "pi_1", amount: 100 }));
  assert.deepEqual(tip.ended, []);
  const first = rig({ session: GIFT, cancelled: ["stripe:refund:re_g9"] });
  await first.onStripeEvent(ev("refund.created", { id: "re_g9", payment_intent: "pi_g9", amount: 500 }));
  assert.deepEqual(first.ended, []);
});

// Review R3 (round 2): a refund that fails, a dispute the streamer wins, or a card-network inquiry
// that closes harmlessly gave the MONEY back (restore) but not the gift. The gift comes back with it.
test("a failed refund, a won dispute and a harmlessly closed inquiry restore the gift with the money", async () => {
  const GIFT: Session = { id: "cs_g10", mode: "payment", amount_total: 500, metadata: { kind: "gift" } };
  const failed = rig({ session: GIFT });
  await failed.onStripeEvent(ev("refund.updated", { id: "re_g10", payment_intent: "pi_g10", amount: 500, status: "failed" }));
  assert.deepEqual(failed.restored, ["stripe:refund:re_g10"]);
  assert.equal(failed.posts[0]!.reason, "restore", "the money is restored as before");
  for (const status of ["won", "warning_closed"]) {
    const closed = rig({ session: GIFT });
    await closed.onStripeEvent(ev("charge.dispute.closed", { id: "dp_g10", payment_intent: "pi_g10", amount: 500, status }));
    assert.deepEqual(closed.restored, ["stripe:dispute:dp_g10"], status);
  }
  const lost = rig({ session: GIFT });
  await lost.onStripeEvent(ev("charge.dispute.closed", { id: "dp_g11", payment_intent: "pi_g10", amount: 500, status: "lost" }));
  assert.deepEqual(lost.restored, [], "a lost dispute restores nothing");
  const tip = rig({ session: DONATION });
  await tip.onStripeEvent(ev("refund.updated", { id: "re_t2", payment_intent: "pi_1", amount: 100, status: "failed" }));
  assert.deepEqual(tip.restored, [], "only a gift has a gift to restore");
});

test("the gift's end carries the reversal's ref, reason, amount and the payment's gross", async () => {
  const GIFT: Session = { id: "cs_g12", mode: "payment", amount_total: 1500, metadata: { kind: "gift" } };
  const seen: unknown[] = [];
  const h = rig({ session: GIFT });
  const r = createSupportReversals({
    pool: { query: async () => ({ rows: [] }) } as never,
    stripe: () => ({ checkout: { sessions: { list: async () => ({ data: [GIFT] }) } } }) as never,
    post: async () => new Response("{}", { status: 200 }),
    endGift: async (g) => { seen.push(g); },
  });
  await r.onStripeEvent(ev("refund.created", { id: "re_g12", payment_intent: "pi_g12", amount: 500 }));
  assert.deepEqual(seen, [{ sessionId: "cs_g12", ref: "stripe:refund:re_g12", reason: "refund", amount: 500, gross: 1500, slots: 1 }]);
  // A community gift's slot count is the purchase's own (its Checkout session's metadata), never the live rows.
  const COMM: Session = { id: "cs_g13", mode: "payment", amount_total: 1500, metadata: { kind: "gift", gift_type: "community", count: "3" } };
  const seen2: unknown[] = [];
  await createSupportReversals({
    pool: { query: async () => ({ rows: [] }) } as never,
    stripe: () => ({ checkout: { sessions: { list: async () => ({ data: [COMM] }) } } }) as never,
    post: async () => new Response("{}", { status: 200 }),
    endGift: async (g) => { seen2.push(g); },
  }).onStripeEvent(ev("refund.created", { id: "re_g13", payment_intent: "pi_g13", amount: 500 }));
  assert.equal((seen2[0] as { slots: number }).slots, 3);
  assert.ok(h);
});
