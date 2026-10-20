// Delivery ORDER of money events on the REAL schema (external review S2 + S4).
//
// Stripe and PayPal do not promise to deliver events in the order they happened.
// Two orders used to lose money:
//   S2  a refund/dispute that arrives BEFORE the credit it reverses found nothing to
//       take back, was forgotten, and the late credit then paid the full amount.
//   S4  a failed/cancelled refund or a won dispute that arrives BEFORE the event that
//       opened it found no clawback to give back, was forgotten, and the late opening
//       event then took the viewer's Qorm although the money stayed with us.
// Every property is SQL (locks, unique keys, a jsonb lookup), so this runs against a
// replayed Postgres through the runtime driver — a mock pool cannot reject any of it.
// Runs in CI (web job sets SQL_PARSE_DATABASE_URL). Locally: donationsSchema.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import type Stripe from "stripe";
import { createMoneyCredits, type PaymentRef } from "./coinsServer.ts";
import { createPaymentEventHandlers } from "./paymentEventHandlers.ts";
import { createPaypalWebhookHandlers } from "./paypalWebhookHandlers.ts";

const DB_URL = process.env.SQL_PARSE_DATABASE_URL || "";
// Never production: only a throwaway on this machine (a shell may carry DATABASE_URL = prod).
const unsafe = !DB_URL || DB_URL === process.env.DATABASE_URL || !/@(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(DB_URL);
const skip = unsafe ? "SQL_PARSE_DATABASE_URL unset or unsafe" : false;

const RUN = `ord${process.pid}x${Date.now().toString(36)}`;
let seq = 0;
const fresh = (p: string) => `${p}_${RUN}_${++seq}`;
const WHO = `@${RUN}:site.test`;

test("money events in any delivery order", { skip }, async (t) => {
  const pool = new Pool({ connectionString: DB_URL, max: 12 });
  const credits = createMoneyCredits({ pool });

  const balance = async (who = WHO) =>
    Number((await pool.query(`SELECT balance FROM site.coin_wallets WHERE matrix_id = $1`, [who])).rows[0]?.balance ?? 0);
  const ledgerSum = async (who = WHO) =>
    Number((await pool.query(`SELECT COALESCE(SUM(delta), 0) AS s FROM site.coin_ledger WHERE matrix_id = $1`, [who])).rows[0].s);
  const reset = async (who = WHO) => {
    await pool.query(`DELETE FROM site.coin_ledger WHERE matrix_id = $1`, [who]);
    await pool.query(`DELETE FROM site.coin_wallets WHERE matrix_id = $1`, [who]);
  };
  const clean = async () => {
    await pool.query(`DELETE FROM site.coin_ledger WHERE matrix_id LIKE $1`, [`@${RUN}%`]);
    await pool.query(`DELETE FROM site.coin_wallets WHERE matrix_id LIKE $1`, [`@${RUN}%`]);
    await pool.query(`DELETE FROM site.payment_events WHERE event_id LIKE $1`, [`%${RUN}%`]);
    await pool.query(`DELETE FROM site.paypal_coin_orders WHERE external_id LIKE $1`, [`%${RUN}%`]);
    await pool.query(`DELETE FROM site.payment_reversals WHERE ref LIKE $1`, [`%${RUN}%`]).catch(() => {});
  };
  await clean();
  t.after(async () => { await clean(); await pool.end(); });

  const stripePay = (): PaymentRef => ({ provider: "stripe", paymentIntent: fresh("pi") });
  const paypalPay = (): PaymentRef => ({ provider: "paypal", captureId: fresh("CAP") });
  const settle = async (who = WHO) => assert.equal(await ledgerSum(who), await balance(who), "ledger must reconcile to the wallet");

  // ── S2: the reversal arrives first ────────────────────────────────────────

  await t.test("a Stripe refund before its purchase credit is held, and the late credit nets to zero", async () => {
    await reset();
    const payment = stripePay();
    const ref = fresh("stripe:refund:re");
    await credits.clawbackForPayment({ payment, cents: 1000, ref, reason: "refund" });
    await credits.recordPurchaseCredit({ matrixId: WHO, cents: 1000, ref: fresh("cs"), payment });
    assert.equal(await balance(), 0);
    await settle();
  });

  await t.test("a Stripe dispute before its tip credit is held the same way", async () => {
    await reset();
    const payment = stripePay();
    await credits.clawbackForPayment({ payment, cents: 500, ref: fresh("stripe:dispute:dp"), reason: "dispute" });
    await credits.recordTipCredit({ matrixId: WHO, cents: 500, ref: fresh("stripe:cs"), payment });
    assert.equal(await balance(), 0);
    await settle();
  });

  await t.test("a partial early refund takes back only its own amount", async () => {
    await reset();
    const payment = stripePay();
    await credits.clawbackForPayment({ payment, cents: 300, ref: fresh("stripe:refund:re"), reason: "refund" });
    await credits.recordPurchaseCredit({ matrixId: WHO, cents: 1000, ref: fresh("cs"), payment });
    assert.equal(await balance(), 700);
    await settle();
  });

  await t.test("two early reversals never take back more than was credited", async () => {
    await reset();
    const payment = stripePay();
    await credits.clawbackForPayment({ payment, cents: 300, ref: fresh("stripe:refund:re"), reason: "refund" });
    await credits.clawbackForPayment({ payment, cents: 1000, ref: fresh("stripe:dispute:dp"), reason: "dispute" });
    await credits.recordPurchaseCredit({ matrixId: WHO, cents: 1000, ref: fresh("cs"), payment });
    assert.equal(await balance(), 0);
    await settle();
  });

  await t.test("duplicates of both events on either side change nothing", async () => {
    await reset();
    const payment = stripePay();
    const refund = fresh("stripe:refund:re");
    const credit = fresh("cs");
    await credits.clawbackForPayment({ payment, cents: 400, ref: refund, reason: "refund" });
    await credits.clawbackForPayment({ payment, cents: 400, ref: refund, reason: "refund" });
    await credits.recordPurchaseCredit({ matrixId: WHO, cents: 1000, ref: credit, payment });
    await credits.recordPurchaseCredit({ matrixId: WHO, cents: 1000, ref: credit, payment });
    await credits.clawbackForPayment({ payment, cents: 400, ref: refund, reason: "refund" });
    assert.equal(await balance(), 600);
    await settle();
  });

  await t.test("a PayPal refund before its purchase credit is held too", async () => {
    await reset();
    const payment = paypalPay();
    await credits.clawbackForPayment({ payment, cents: 800, ref: fresh("paypal:refund:R"), reason: "refund" });
    await credits.recordPurchaseCredit({ matrixId: WHO, cents: 800, ref: fresh("paypal:"), payment });
    assert.equal(await balance(), 0);
    await settle();
  });

  await t.test("a reversal of a payment that never credits Qorm writes no ledger row", async () => {
    await reset();
    await credits.clawbackForPayment({ payment: stripePay(), cents: 500, ref: fresh("stripe:refund:re"), reason: "refund" });
    assert.equal(await ledgerSum(), 0);
    assert.equal(await balance(), 0);
  });

  // ── S4: the terminal outcome arrives first ────────────────────────────────

  await t.test("a failed refund before refund.created: the late refund.created takes nothing", async () => {
    await reset();
    const payment = stripePay();
    await credits.recordPurchaseCredit({ matrixId: WHO, cents: 1000, ref: fresh("cs"), payment });
    const id = fresh("re");
    await credits.restoreClawback({ clawbackRef: `stripe:refund:${id}`, ref: `stripe:refund-reversed:${id}` });
    await credits.clawbackForPayment({ payment, cents: 1000, ref: `stripe:refund:${id}`, reason: "refund" });
    assert.equal(await balance(), 1000);
    await settle();
  });

  await t.test("a won dispute before dispute.created, duplicated on both sides, leaves the Qorm", async () => {
    await reset();
    const payment = stripePay();
    await credits.recordTipCredit({ matrixId: WHO, cents: 1000, ref: fresh("stripe:cs"), payment });
    const id = fresh("dp");
    for (let i = 0; i < 2; i++) await credits.restoreClawback({ clawbackRef: `stripe:dispute:${id}`, ref: `stripe:dispute-won:${id}` });
    for (let i = 0; i < 2; i++) await credits.clawbackForPayment({ payment, cents: 1000, ref: `stripe:dispute:${id}`, reason: "dispute" });
    assert.equal(await balance(), 1000);
    await settle();
  });

  await t.test("a won dispute, then dispute.created, then the credit — all late — leaves the full credit", async () => {
    await reset();
    const payment = stripePay();
    const id = fresh("dp");
    await credits.restoreClawback({ clawbackRef: `stripe:dispute:${id}`, ref: `stripe:dispute-won:${id}` });
    await credits.clawbackForPayment({ payment, cents: 1000, ref: `stripe:dispute:${id}`, reason: "dispute" });
    await credits.recordPurchaseCredit({ matrixId: WHO, cents: 1000, ref: fresh("cs"), payment });
    assert.equal(await balance(), 1000);
    await settle();
  });

  await t.test("refund.created, then refund failed, then the credit: the held refund is cancelled", async () => {
    await reset();
    const payment = stripePay();
    const id = fresh("re");
    await credits.clawbackForPayment({ payment, cents: 1000, ref: `stripe:refund:${id}`, reason: "refund" });
    await credits.restoreClawback({ clawbackRef: `stripe:refund:${id}`, ref: `stripe:refund-reversed:${id}` });
    await credits.recordPurchaseCredit({ matrixId: WHO, cents: 1000, ref: fresh("cs"), payment });
    assert.equal(await balance(), 1000);
    await settle();
  });

  await t.test("the in-order lifecycle is unchanged: credit, clawback, restore, redelivered clawback", async () => {
    await reset();
    const payment = stripePay();
    const id = fresh("dp");
    await credits.recordPurchaseCredit({ matrixId: WHO, cents: 1000, ref: fresh("cs"), payment });
    await credits.clawbackForPayment({ payment, cents: 1000, ref: `stripe:dispute:${id}`, reason: "dispute" });
    assert.equal(await balance(), 0);
    await credits.restoreClawback({ clawbackRef: `stripe:dispute:${id}`, ref: `stripe:dispute-won:${id}` });
    assert.equal(await balance(), 1000);
    await credits.clawbackForPayment({ payment, cents: 1000, ref: `stripe:dispute:${id}`, reason: "dispute" });
    assert.equal(await balance(), 1000);
    await settle();
  });

  // ── A failed refund and its successful replacement ─────────────────────────
  // Refund A fails and a replacement refund B succeeds. Whichever of them took
  // the credit, A's restore must leave the payment reversed once, by B.

  await t.test("refund A and B held, the credit, then A failed: B still takes the credit back", async () => {
    await reset();
    const payment = stripePay();
    const a = fresh("re"), b = fresh("re");
    await credits.clawbackForPayment({ payment, cents: 1000, ref: `stripe:refund:${a}`, reason: "refund" });
    await credits.clawbackForPayment({ payment, cents: 1000, ref: `stripe:refund:${b}`, reason: "refund" });
    await credits.recordPurchaseCredit({ matrixId: WHO, cents: 1000, ref: fresh("cs"), payment });
    assert.equal(await balance(), 0);
    await credits.restoreClawback({ clawbackRef: `stripe:refund:${a}`, ref: `stripe:refund-reversed:${a}`, payment });
    assert.equal(await balance(), 0, "the money was refunded by B");
    await credits.restoreClawback({ clawbackRef: `stripe:refund:${a}`, ref: `stripe:refund-reversed:${a}`, payment });
    await credits.clawbackForPayment({ payment, cents: 1000, ref: `stripe:refund:${b}`, reason: "refund" });
    assert.equal(await balance(), 0, "redeliveries change nothing");
    await settle();
  });

  await t.test("credit, refund A takes it all, refund B finds nothing, A failed: B takes it back", async () => {
    await reset();
    const payment = stripePay();
    const a = fresh("re"), b = fresh("re");
    await credits.recordPurchaseCredit({ matrixId: WHO, cents: 1000, ref: fresh("cs"), payment });
    await credits.clawbackForPayment({ payment, cents: 1000, ref: `stripe:refund:${a}`, reason: "refund" });
    await credits.clawbackForPayment({ payment, cents: 1000, ref: `stripe:refund:${b}`, reason: "refund" });
    await credits.restoreClawback({ clawbackRef: `stripe:refund:${a}`, ref: `stripe:refund-reversed:${a}`, payment });
    assert.equal(await balance(), 0);
    await settle();
  });

  await t.test("a restore that names no payment still finds it from the reversal it cancels", async () => {
    await reset();
    const payment = stripePay();
    const a = fresh("re"), b = fresh("re");
    await credits.recordPurchaseCredit({ matrixId: WHO, cents: 1000, ref: fresh("cs"), payment });
    await credits.clawbackForPayment({ payment, cents: 1000, ref: `stripe:refund:${a}`, reason: "refund" });
    await credits.clawbackForPayment({ payment, cents: 1000, ref: `stripe:refund:${b}`, reason: "refund" });
    await credits.restoreClawback({ clawbackRef: `stripe:refund:${a}`, ref: `stripe:refund-reversed:${a}` });
    assert.equal(await balance(), 0);
    await settle();
  });

  await t.test("a partial replacement takes back only its own amount after the restore", async () => {
    await reset();
    const payment = stripePay();
    const a = fresh("re"), b = fresh("re");
    await credits.recordPurchaseCredit({ matrixId: WHO, cents: 1000, ref: fresh("cs"), payment });
    await credits.clawbackForPayment({ payment, cents: 800, ref: `stripe:refund:${a}`, reason: "refund" });
    await credits.clawbackForPayment({ payment, cents: 300, ref: `stripe:refund:${b}`, reason: "refund" });
    assert.equal(await balance(), 0);
    await credits.restoreClawback({ clawbackRef: `stripe:refund:${a}`, ref: `stripe:refund-reversed:${a}`, payment });
    assert.equal(await balance(), 700);
    await settle();
  });

  await t.test("both refunds fail: the second restore gives back what the first one re-took", async () => {
    await reset();
    const payment = stripePay();
    const a = fresh("re"), b = fresh("re");
    await credits.recordPurchaseCredit({ matrixId: WHO, cents: 1000, ref: fresh("cs"), payment });
    await credits.clawbackForPayment({ payment, cents: 1000, ref: `stripe:refund:${a}`, reason: "refund" });
    await credits.clawbackForPayment({ payment, cents: 1000, ref: `stripe:refund:${b}`, reason: "refund" });
    await credits.restoreClawback({ clawbackRef: `stripe:refund:${a}`, ref: `stripe:refund-reversed:${a}`, payment });
    await credits.restoreClawback({ clawbackRef: `stripe:refund:${b}`, ref: `stripe:refund-reversed:${b}`, payment });
    assert.equal(await balance(), 1000);
    await credits.restoreClawback({ clawbackRef: `stripe:refund:${b}`, ref: `stripe:refund-reversed:${b}`, payment });
    assert.equal(await balance(), 1000);
    await settle();
  });

  await t.test("concurrent restores of A against B's redelivery always end reversed once", async () => {
    for (let i = 0; i < 15; i++) {
      const who = `@${RUN}ab${i}:site.test`;
      const payment = stripePay();
      const a = fresh("re"), b = fresh("re");
      await credits.recordPurchaseCredit({ matrixId: who, cents: 1000, ref: fresh("cs"), payment });
      await credits.clawbackForPayment({ payment, cents: 1000, ref: `stripe:refund:${a}`, reason: "refund" });
      await credits.clawbackForPayment({ payment, cents: 1000, ref: `stripe:refund:${b}`, reason: "refund" });
      const ops = [
        () => credits.restoreClawback({ clawbackRef: `stripe:refund:${a}`, ref: `stripe:refund-reversed:${a}`, payment }),
        () => credits.restoreClawback({ clawbackRef: `stripe:refund:${a}`, ref: `stripe:refund-reversed:${a}` }),
        () => credits.clawbackForPayment({ payment, cents: 1000, ref: `stripe:refund:${b}`, reason: "refund" }),
      ];
      if (i % 2) ops.reverse();
      await Promise.all(ops.map((f) => f()));
      assert.equal(await balance(who), 0, `iteration ${i}`);
      await settle(who);
    }
  });

  // ── Concurrent delivery ───────────────────────────────────────────────────

  await t.test("concurrent refund and credit always net to zero", async () => {
    for (let i = 0; i < 15; i++) {
      const who = `@${RUN}c${i}:site.test`;
      const payment = stripePay();
      const ops = [
        () => credits.clawbackForPayment({ payment, cents: 1000, ref: fresh("stripe:refund:re"), reason: "refund" }),
        () => credits.recordPurchaseCredit({ matrixId: who, cents: 1000, ref: fresh("cs"), payment }),
      ];
      if (i % 2) ops.reverse();
      await Promise.all(ops.map((f) => f()));
      assert.equal(await balance(who), 0, `iteration ${i}`);
      await settle(who);
    }
  });

  await t.test("concurrent clawback and its own restore always leave the credit", async () => {
    for (let i = 0; i < 15; i++) {
      const who = `@${RUN}r${i}:site.test`;
      const payment = stripePay();
      await credits.recordPurchaseCredit({ matrixId: who, cents: 1000, ref: fresh("cs"), payment });
      const id = fresh("dp");
      const ops = [
        () => credits.clawbackForPayment({ payment, cents: 1000, ref: `stripe:dispute:${id}`, reason: "dispute" }),
        () => credits.restoreClawback({ clawbackRef: `stripe:dispute:${id}`, ref: `stripe:dispute-won:${id}` }),
      ];
      if (i % 2) ops.reverse();
      await Promise.all(ops.map((f) => f()));
      assert.equal(await balance(who), 1000, `iteration ${i}`);
      await settle(who);
    }
  });

  await t.test("a held reversal, its restore and the credit, all concurrent, always leave the credit", async () => {
    for (let i = 0; i < 15; i++) {
      const who = `@${RUN}h${i}:site.test`;
      const payment = stripePay();
      const id = fresh("re");
      await credits.clawbackForPayment({ payment, cents: 1000, ref: `stripe:refund:${id}`, reason: "refund" });
      const ops = [
        () => credits.restoreClawback({ clawbackRef: `stripe:refund:${id}`, ref: `stripe:refund-reversed:${id}` }),
        () => credits.recordPurchaseCredit({ matrixId: who, cents: 1000, ref: fresh("cs"), payment }),
      ];
      if (i % 2) ops.reverse();
      await Promise.all(ops.map((f) => f()));
      assert.equal(await balance(who), 1000, `iteration ${i}`);
      await settle(who);
    }
  });

  // ── Through the real handlers ─────────────────────────────────────────────

  const piMeta: Record<string, Record<string, string>> = {};
  const fakeStripe = (() => ({
    checkout: { sessions: { list: async () => ({ data: [] }) } },
    paymentIntents: {
      retrieve: async (id: string) => {
        const metadata = piMeta[id];
        if (!metadata) throw new Error(`unexpected retrieve ${id}`);
        return { metadata };
      },
    },
  })) as unknown as () => Stripe;
  const stripeH = createPaymentEventHandlers({ pool, stripe: fakeStripe, credits });
  const created = Math.floor(Date.now() / 1000);
  const refundEvent = (type: "refund.created" | "refund.updated", id: string, pi: string, status = "succeeded") => ({
    id: fresh(`evt_${RUN}`), type, created,
    data: { object: { id, object: "refund", payment_intent: pi, charge: null, amount: 1000, currency: "usd", status } },
  }) as unknown as Stripe.Event;
  const disputeEvent = (type: "charge.dispute.created" | "charge.dispute.closed", id: string, pi: string, status: string) => ({
    id: fresh(`evt_${RUN}`), type, created,
    data: { object: { id, object: "dispute", payment_intent: pi, charge: null, amount: 1000, currency: "usd", status } },
  }) as unknown as Stripe.Event;
  const checkoutSession = (pi: string) => ({
    id: fresh("cs"), payment_status: "paid", amount_total: 1000, currency: "usd", payment_intent: pi,
    metadata: { kind: "coin_purchase", matrix_id: WHO, coins: "1000" },
  }) as unknown as Stripe.Checkout.Session;

  await t.test("Stripe handlers: refund.created before the Checkout purchase credit", async () => {
    await reset();
    const pi = fresh("pi");
    await stripeH.handleRefund(refundEvent("refund.created", fresh("re"), pi));
    await credits.recordCheckoutPurchase(checkoutSession(pi));
    assert.equal(await balance(), 0);
    await settle();
  });

  await t.test("Stripe handlers: refund.updated(failed|canceled) before refund.created", async () => {
    for (const status of ["failed", "canceled"]) {
      await reset();
      const pi = fresh("pi");
      await credits.recordCheckoutPurchase(checkoutSession(pi));
      const re = fresh("re");
      await stripeH.handleRefund(refundEvent("refund.updated", re, pi, status));
      await stripeH.handleRefund(refundEvent("refund.created", re, pi));
      await stripeH.handleRefund(refundEvent("refund.created", re, pi));
      assert.equal(await balance(), 1000, status);
      await settle();
    }
  });

  await t.test("Stripe handlers: refund A and B created, the credit, then A failed", async () => {
    await reset();
    const pi = fresh("pi");
    const a = fresh("re"), b = fresh("re");
    await stripeH.handleRefund(refundEvent("refund.created", a, pi));
    await stripeH.handleRefund(refundEvent("refund.created", b, pi));
    await credits.recordCheckoutPurchase(checkoutSession(pi));
    await stripeH.handleRefund(refundEvent("refund.updated", a, pi, "failed"));
    assert.equal(await balance(), 0);
    await settle();
  });

  await t.test("Stripe handlers: dispute closed (won|warning_closed) before dispute created", async () => {
    for (const status of ["won", "warning_closed"]) {
      await reset();
      const pi = fresh("pi");
      piMeta[pi] = { kind: "coin_purchase" }; // no matrix_id: payment_events has an FK to site.users
      await credits.recordCheckoutPurchase(checkoutSession(pi));
      const dp = fresh("dp");
      await stripeH.handleDispute(disputeEvent("charge.dispute.closed", dp, pi, status));
      await stripeH.handleDispute(disputeEvent("charge.dispute.created", dp, pi, "needs_response"));
      assert.equal(await balance(), 1000, status);
      await settle();
    }
  });

  await t.test("Stripe handlers: a LOST dispute closing first does not stop the clawback", async () => {
    await reset();
    const pi = fresh("pi");
    piMeta[pi] = { kind: "coin_purchase" }; // no matrix_id: payment_events has an FK to site.users
    await credits.recordCheckoutPurchase(checkoutSession(pi));
    const dp = fresh("dp");
    await stripeH.handleDispute(disputeEvent("charge.dispute.closed", dp, pi, "lost"));
    await stripeH.handleDispute(disputeEvent("charge.dispute.created", dp, pi, "needs_response"));
    assert.equal(await balance(), 0);
    await settle();
  });

  // PayPal: a points purchase (no stream broadcast on that path).
  const ppDir = join(import.meta.dirname, "__fixtures__/paypal");
  const ppFixture = (n: string) => JSON.parse(readFileSync(join(ppDir, `${n}.json`), "utf8"));
  const paypalH = createPaypalWebhookHandlers({ pool, credits });
  const ppCase = async () => {
    const externalId = fresh(`ord_${RUN}`);
    const captureId = fresh("CAP");
    await pool.query(`INSERT INTO site.paypal_coin_orders (external_id, matrix_id, amount_cents) VALUES ($1, $2, 5700)`, [externalId, WHO]);
    const completed = ppFixture("payment.capture.completed");
    completed.id = fresh(`WH_${RUN}`);
    completed.resource.id = captureId;
    completed.resource.custom_id = `points:${externalId}`;
    const up = { rel: "up", method: "GET", href: `https://api.sandbox.paypal.com/v2/payments/captures/${captureId}` };
    const refunded = ppFixture("payment.capture.refunded");
    refunded.id = fresh(`WH_${RUN}`);
    refunded.resource.id = fresh("REF");
    refunded.resource.amount = { currency_code: "USD", value: "57.00" };
    refunded.resource.links = [up];
    const reversed = ppFixture("payment.capture.reversed");
    reversed.id = fresh(`WH_${RUN}`);
    reversed.resource.id = fresh("REV");
    reversed.resource.amount = { currency_code: "USD", value: "57.00" };
    reversed.resource.links = [up];
    const dispute = ppFixture("customer.dispute.resolved");
    dispute.id = fresh(`WH_${RUN}`);
    dispute.resource.dispute_outcome.outcome_code = "RESOLVED_BUYER_FAVOUR";
    dispute.resource.dispute_amount = { currency_code: "USD", value: "57.00" };
    dispute.resource.disputed_transactions[0].seller_transaction_id = captureId;
    return { completed, refunded, reversed, dispute };
  };

  await t.test("PayPal handlers: REFUNDED before COMPLETED", async () => {
    await reset();
    const c = await ppCase();
    await paypalH.onCaptureRefunded(c.refunded);
    await paypalH.onCaptureCompleted(c.completed);
    await paypalH.onCaptureCompleted(c.completed);
    assert.equal(await balance(), 0);
    await settle();
  });

  await t.test("PayPal handlers: REVERSED and buyer-won DISPUTE before COMPLETED take it back once", async () => {
    await reset();
    const c = await ppCase();
    await paypalH.onCaptureReversed(c.reversed);
    await paypalH.onDisputeResolved(c.dispute);
    await paypalH.onCaptureCompleted(c.completed);
    assert.equal(await balance(), 0);
    await settle();
  });
});
