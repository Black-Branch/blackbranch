// A refund or dispute of a payment that was SUPPORT (a donation, a gift, a sub) takes that support
// back out of stream-api's ledger: POST /support/reverse writes a reversing row keyed to the
// original event, so lifetime support, support tiers and sponsor weighting go down. The per-stream
// bar and the timer are not touched (stream-api's route says why). A points purchase is not support
// and is left alone — its clawback is coinsServer's.
//
// Called by the Stripe and PayPal webhooks AFTER their own handlers ran, so site.payment_reversals
// (v149) already says whether a reversal's outcome came first: a ref already `cancelled` (the
// refund failed, the dispute was won — before its opening event arrived) reverses nothing.
//
// Anything but a 2xx THROWS: the webhook answers 500 and the provider redelivers (Stripe retries
// for about three days, PayPal 25 times). Every step is idempotent — stream-api keys a reversal on
// its ref, the restore on the same ref.
//
// A payment the ledger does not hold YET (its ledger write failed and it waits for reconciliation,
// or its credit is still on its way) is HELD by stream-api (202 { held: 'pending' },
// stream.support_reversal_holds, v156) and taken back when the credit lands — durable there, so
// there is nothing for the provider to redeliver. Review round 5, PB2: this used to treat 404
// `unknown_event` as "nothing to reverse" and answer success, and a later reconcile then credited
// the refunded payment in full. A 404 now comes only from a stream-api older than v156, and it
// THROWS like any refusal, so the provider keeps the reversal alive until the new one is running.
//
// Server-only (rides streamApi.ts and its secret).

import type { Pool } from "pg";
import type Stripe from "stripe";
import pool from "../../lib/db.ts";
import { getStripe } from "./stripe.ts";
import { streamApiFetch } from "./streamApi.ts";
import { captureIdFromRefund, captureIdFromDispute, parsePositiveCents } from "./paypalWebhookHandlers.ts";

type Kind = "donation" | "gift" | "sub";
/** The /chat/event spendId the original credit carried, and the payment's gross in its own minor units. */
type Origin = { kind: Kind; spendId: string; gross: number | null };

function idOf(v: string | { id: string } | null | undefined): string | null {
  if (v == null) return null;
  return typeof v === "string" ? v : v.id;
}

/** @parked consumed by the production binding below and by paymentReversalsLedger.test.ts;
 *  exported so the test can drive a fake pool, Stripe and stream-api. */
export function createSupportReversals(deps: {
  pool: Pick<Pool, "query">;
  stripe: () => Stripe;
  post: (path: string, body: unknown) => Promise<Response>;
}) {
  /** Which support credit a Stripe payment intent paid for, or null (a points purchase, or unknown). */
  async function stripeOrigin(paymentIntent: string): Promise<Origin | null> {
    const sessions = await deps.stripe().checkout.sessions.list({ payment_intent: paymentIntent, limit: 1 });
    const cs = sessions.data[0];
    if (cs) {
      const gross = cs.amount_total ?? null;
      if (cs.mode === "subscription") {
        const sub = idOf(cs.subscription as string | { id: string } | null);
        return sub ? { kind: "sub", spendId: `sub:${sub}`, gross } : null;
      }
      if (cs.metadata?.kind === "coin_purchase") return null;
      if (cs.metadata?.kind === "gift") return { kind: "gift", spendId: `gift:${cs.id}`, gross };
      return { kind: "donation", spendId: `donation:${cs.id}`, gross };
    }
    // A renewal has no Checkout session: its invoice names the subscription.
    const payments = await deps.stripe().invoicePayments.list({ payment: { type: "payment_intent", payment_intent: paymentIntent }, limit: 1 });
    const invId = idOf(payments.data[0]?.invoice as string | { id: string } | null | undefined);
    if (!invId) return null;
    const inv = await deps.stripe().invoices.retrieve(invId);
    if (inv.billing_reason === "subscription_cycle") return { kind: "sub", spendId: `renewal:${inv.id}`, gross: inv.amount_paid ?? null };
    const sub = idOf(inv.parent?.subscription_details?.subscription as string | { id: string } | null | undefined);
    if (inv.billing_reason === "subscription_create" && sub) return { kind: "sub", spendId: `sub:${sub}`, gross: inv.amount_paid ?? null };
    return null;
  }

  async function settledAsCancelled(ref: string): Promise<boolean> {
    const r = await deps.pool.query(`SELECT status FROM site.payment_reversals WHERE ref = $1`, [ref]);
    return r.rows[0]?.status === "cancelled";
  }

  async function call(body: Record<string, unknown>): Promise<void> {
    const res = await deps.post("/support/reverse", body);
    if (res.ok) {
      if (res.status === 202) {
        // Held until the credit lands (stream-api logs which case it is, loudly when nothing holds it).
        console.warn("[support] %s %s — no ledger credit yet; stream-api holds the reversal for it", String(body.reason), String(body.ref));
      }
      return;
    }
    throw new Error(`stream-api /support/reverse answered ${res.status} for ${String(body.ref)}`);
  }

  /** A refund or dispute opened. `amount` and the origin's gross are in the payment's own minor units. */
  async function reverse(origin: Origin | null, a: { ref: string; reason: "refund" | "dispute"; amount: number | null }): Promise<void> {
    if (!origin) return;
    if (await settledAsCancelled(a.ref)) return; // its outcome (failed / won) came first
    await call({ kind: origin.kind, spendId: origin.spendId, ref: a.ref, reason: a.reason,
      ...(a.amount != null && origin.gross != null ? { refunded: a.amount, gross: origin.gross } : {}) });
  }

  /** The refund failed / was cancelled, or the dispute was won: the money stayed. */
  async function restore(origin: Origin | null, ref: string): Promise<void> {
    if (!origin) return;
    await call({ kind: origin.kind, spendId: origin.spendId, ref, reason: "restore" });
  }

  async function onStripeEvent(event: Stripe.Event): Promise<void> {
    if (event.type === "refund.created" || event.type === "refund.updated") {
      const refund = event.data.object as Stripe.Refund;
      const pi = idOf(refund.payment_intent as string | { id: string } | null);
      if (!pi) return;
      const ref = `stripe:refund:${refund.id}`;
      if (event.type === "refund.created" && refund.amount > 0) await reverse(await stripeOrigin(pi), { ref, reason: "refund", amount: refund.amount });
      else if (event.type === "refund.updated" && (refund.status === "failed" || refund.status === "canceled")) await restore(await stripeOrigin(pi), ref);
      return;
    }
    if (event.type === "charge.dispute.created" || event.type === "charge.dispute.closed") {
      const dispute = event.data.object as Stripe.Dispute;
      const pi = idOf(dispute.payment_intent as string | { id: string } | null);
      if (!pi) return;
      const ref = `stripe:dispute:${dispute.id}`;
      if (event.type === "charge.dispute.created") await reverse(await stripeOrigin(pi), { ref, reason: "dispute", amount: dispute.amount });
      else if (dispute.status === "won" || dispute.status === "warning_closed") await restore(await stripeOrigin(pi), ref);
    }
  }

  /** PayPal: only a tip is support (a quiet points purchase is not). */
  async function paypalOrigin(captureId: string): Promise<Origin | null> {
    const r = await deps.pool.query(
      `SELECT amount_cents FROM site.donations WHERE provider = 'paypal' AND provider_ref = $1`, [captureId]);
    if (!r.rows[0]) return null;
    return { kind: "donation", spendId: `donation:paypal:${captureId}`, gross: Number(r.rows[0].amount_cents) || null };
  }

  /** PAYMENT.CAPTURE.REFUNDED / REVERSED and a buyer-won CUSTOMER.DISPUTE.RESOLVED. The refs are the
   *  ones the points clawback uses (paypalWebhookHandlers.ts), so a buyer-won dispute and PayPal's
   *  reversal of the same capture are ONE reversal. */
  async function onPaypalEvent(event: { event_type: string; resource: unknown }): Promise<void> {
    const res = event.resource as { id?: unknown; amount?: { value?: unknown } | null; dispute_amount?: { value?: unknown } | null;
      dispute_outcome?: { outcome_code?: unknown } | null } | null;
    let captureId: string | null = null;
    let ref = "";
    let reason: "refund" | "dispute" = "refund";
    let cents: number | null = null;
    if (event.event_type === "PAYMENT.CAPTURE.REFUNDED") {
      captureId = captureIdFromRefund(event.resource);
      if (typeof res?.id !== "string" || !res.id) return;
      ref = `paypal:refund:${res.id}`;
      cents = parsePositiveCents(res?.amount?.value);
    } else if (event.event_type === "PAYMENT.CAPTURE.REVERSED") {
      captureId = captureIdFromRefund(event.resource);
      ref = `paypal:dispute-capture:${captureId}`;
      reason = "dispute";
      cents = parsePositiveCents(res?.amount?.value);
    } else if (event.event_type === "CUSTOMER.DISPUTE.RESOLVED" && res?.dispute_outcome?.outcome_code === "RESOLVED_BUYER_FAVOUR") {
      captureId = captureIdFromDispute(event.resource);
      ref = `paypal:dispute-capture:${captureId}`;
      reason = "dispute";
      cents = parsePositiveCents(res?.dispute_amount?.value);
    } else {
      return;
    }
    if (!captureId) return;
    await reverse(await paypalOrigin(captureId), { ref, reason, amount: cents });
  }

  return { onStripeEvent, onPaypalEvent };
}

const bound = createSupportReversals({
  pool,
  stripe: getStripe,
  post: (path, body) => streamApiFetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
});
/** Stripe webhook: refund.* / charge.dispute.* → the support ledger. */
export const reverseStripeSupport = bound.onStripeEvent;
/** PayPal webhook: a refund, reversal or buyer-won dispute → the support ledger. */
export const reversePaypalSupport = bound.onPaypalEvent;
