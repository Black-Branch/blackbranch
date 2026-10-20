// Per-event-family orchestration on top of paymentEventsServer.ts. Same
// injectable-pool factory shape and reason.
import type { Pool } from "pg";
import type Stripe from "stripe";
import pool from "../../lib/db.ts";
import { getStripe } from "./stripe.ts";
import { moneyCredits, type MoneyCredits } from "./coinsServer.ts";
import { createPaymentEventsServer, emptyToNull } from "./paymentEventsServer.ts";
import { declineCopy } from "./declineCopy.ts";

function idOf(v: string | { id: string } | null | undefined): string | null {
  if (v == null) return null;
  return typeof v === "string" ? v : v.id;
}

/** @parked consumed by the production binding below and by
 *  paymentEventHandlers.test.ts; exported so the test can drive a fake pool
 *  and a fake Stripe getter, the same shape as coinsServer.ts's createEarn. */
export function createPaymentEventHandlers(deps: { pool: Pool; stripe: () => Stripe; credits: MoneyCredits }) {
  const { recordPaymentEvent, markDonationRefunded, resolveMatrixIdByCustomer, resolveMatrixIdByPaymentIntent } =
    createPaymentEventsServer(deps);

  /** Payment-mode attempts (donation/gift/coin_purchase) carry
   *  { kind, matrix_id | gifter_matrix_id } on payment_intent_data.metadata
   *  (set by the donate, gift and coins routes) — resolve directly.
   *  Subscription-mode failures carry none; fall back to the customer.
   *
   *  session_id is required for /api/billing/result (keyed on session_id) to
   *  ever find this row — resolved via ONE Stripe read, checkout.sessions.list
   *  filtered by payment_intent (a documented List filter). A throw here is
   *  NOT caught — it propagates exactly like a recordPaymentEvent throw, up
   *  through the webhook's top-level catch to a 500, so Stripe retries rather
   *  than this handler silently recording a "failed" row with no session. */
  async function handlePaymentFailed(event: Stripe.Event): Promise<void> {
    const pi = event.data.object as Stripe.PaymentIntent;
    const metaKind = emptyToNull(pi.metadata?.kind);
    let matrixId: string | null;
    if (metaKind) {
      matrixId = emptyToNull(pi.metadata?.matrix_id) ?? emptyToNull(pi.metadata?.gifter_matrix_id);
    } else {
      const customerId = idOf(pi.customer as string | { id: string } | null);
      matrixId = customerId ? await resolveMatrixIdByCustomer(customerId) : null;
    }
    const sessionList = await deps.stripe().checkout.sessions.list({ payment_intent: pi.id, limit: 1 });
    const sessionId = sessionList.data[0]?.id ?? null;
    if (!metaKind && !sessionId) {
      // No metadata.kind and no Checkout session: this is a subscription
      // renewal's payment_intent.payment_failed. The invoice.payment_failed
      // handler records this attempt as renewal_failed; a second row here
      // would show every failed renewal twice.
      return;
    }
    if (metaKind && !sessionId) {
      console.warn("[billing] payment_failed with no checkout session — the buyer will see no banner", pi.id);
    }
    const kind = metaKind ?? "sub"; // metaKind null + a session found -> a subscription-mode Checkout's first invoice
    const code = pi.last_payment_error?.code ?? null;
    const declineCode = pi.last_payment_error?.decline_code ?? null;
    const { body } = declineCopy(code, declineCode);
    await recordPaymentEvent({
      eventId: event.id, eventType: event.type, occurredAt: new Date(event.created * 1000),
      sessionId, paymentIntentId: pi.id, chargeId: idOf(pi.latest_charge as string | { id: string } | null),
      matrixId, kind, amountCents: pi.amount, currency: pi.currency,
      outcome: "failed", reasonCode: code, declineCode, reasonText: body,
    });
  }

  /** Matches site.donations by payment_intent, stamps refunded_at
   *  idempotently. A refund of any money-bought Qorm (tip or coin purchase)
   *  claws it back — only on refund.created, since refund.updated is the same
   *  refund changing state and the clawback ref makes a redelivery a no-op
   *  anyway.
   *
   *  refund.updated can also carry the OPPOSITE news: the refund attempt
   *  itself failed or was canceled, so the money never actually left us —
   *  but the clawback already ran on refund.created. Give it back the same
   *  way a won dispute does (restoreClawback, idempotent on its own `ref`). */
  async function handleRefund(event: Stripe.Event): Promise<void> {
    const refund = event.data.object as Stripe.Refund;
    const paymentIntentId = idOf(refund.payment_intent as string | { id: string } | null);
    const matrixId = paymentIntentId ? await resolveMatrixIdByPaymentIntent(paymentIntentId) : null;
    await recordPaymentEvent({
      eventId: event.id, eventType: event.type, occurredAt: new Date(event.created * 1000),
      paymentIntentId, chargeId: idOf(refund.charge as string | { id: string } | null),
      matrixId, kind: matrixId ? "donation" : null, amountCents: refund.amount, currency: refund.currency,
      outcome: event.type === "refund.created" ? "refunded" : "refund_updated",
    });
    if (paymentIntentId) await markDonationRefunded(paymentIntentId);

    if (event.type === "refund.created" && paymentIntentId && refund.amount > 0) {
      // `refund.amount` is in the CHARGE's settlement minor units, not USD
      // cents — for a non-USD settlement it is not safe to pass through as
      // Qorm cents. Take back everything still held for this payment instead;
      // clawbackForPayment's own cap does the rest. Never log a payer field.
      const usd = (refund.currency ?? "usd").toLowerCase() === "usd";
      if (!usd) {
        console.warn("[billing] non-USD refund settlement — clawing back everything held for payment_intent", paymentIntentId);
      }
      await deps.credits.clawbackForPayment({
        payment: { provider: "stripe", paymentIntent: paymentIntentId },
        cents: usd ? refund.amount : Number.MAX_SAFE_INTEGER,
        ref: `stripe:refund:${refund.id}`, reason: "refund",
      });
    } else if (
      event.type === "refund.updated" &&
      (refund.status === "failed" || refund.status === "canceled")
    ) {
      await deps.credits.restoreClawback({
        clawbackRef: `stripe:refund:${refund.id}`, ref: `stripe:refund-reversed:${refund.id}`,
      });
    }
  }

  /** Dispute carries no customer field — resolve via site.donations first.
   *  A coin purchase or gift has no site.donations row, so when that lookup
   *  comes back empty (and there is a payment_intent to ask), fall back to
   *  the PI's own metadata — the same fields a payment-mode checkout stamps
   *  on payment_intent_data.metadata. A throw from that retrieve is NOT
   *  caught — same rule as the sessions.list lookup in handlePaymentFailed. */
  async function handleDispute(event: Stripe.Event): Promise<void> {
    const dispute = event.data.object as Stripe.Dispute;
    const paymentIntentId = idOf(dispute.payment_intent as string | { id: string } | null);
    let matrixId = paymentIntentId ? await resolveMatrixIdByPaymentIntent(paymentIntentId) : null;
    let kind: string;
    if (matrixId) {
      kind = "donation";
    } else if (paymentIntentId) {
      const pi = await deps.stripe().paymentIntents.retrieve(paymentIntentId);
      kind = emptyToNull(pi.metadata?.kind) ?? "unknown";
      matrixId = emptyToNull(pi.metadata?.matrix_id) ?? emptyToNull(pi.metadata?.gifter_matrix_id);
    } else {
      kind = "unknown";
    }
    await recordPaymentEvent({
      eventId: event.id, eventType: event.type, occurredAt: new Date(event.created * 1000),
      paymentIntentId, chargeId: idOf(dispute.charge as string | { id: string } | null),
      matrixId, kind,
      amountCents: dispute.amount, currency: dispute.currency,
      outcome: event.type === "charge.dispute.created" ? "dispute_opened" : "dispute_closed",
    });

    // Qorm clawback / restore. Nothing on stream is reversed by either — this
    // only moves the wallet.
    if (paymentIntentId && event.type === "charge.dispute.created") {
      // Same non-USD guard as handleRefund: `dispute.amount` is the charge's
      // settlement minor units, not USD cents. Never log a payer field.
      const usd = (dispute.currency ?? "usd").toLowerCase() === "usd";
      if (!usd) {
        console.warn("[billing] non-USD dispute settlement — clawing back everything held for payment_intent", paymentIntentId);
      }
      await deps.credits.clawbackForPayment({
        payment: { provider: "stripe", paymentIntent: paymentIntentId },
        cents: usd ? dispute.amount : Number.MAX_SAFE_INTEGER,
        ref: `stripe:dispute:${dispute.id}`, reason: "dispute",
      });
    } else if (
      event.type === "charge.dispute.closed" &&
      (dispute.status === "won" || dispute.status === "warning_closed")
    ) {
      // `charge.dispute.created` also fires for a card-network INQUIRY
      // (status starts `warning_needs_response`) and the clawback above
      // already ran for it — an inquiry that closes without escalating ends
      // as `warning_closed`, never `won`, so it must restore too or the
      // viewer loses the Qorm forever while we kept the money.
      await deps.credits.restoreClawback({
        clawbackRef: `stripe:dispute:${dispute.id}`, ref: `stripe:dispute-won:${dispute.id}`,
      });
    }
  }

  /** Recorded only — no buyer-facing notice. */
  async function handleInvoicePaymentFailed(event: Stripe.Event): Promise<void> {
    const inv = event.data.object as Stripe.Invoice;
    // R1: Stripe.Invoice has no top-level `subscription` in this SDK (basil
    // API) — the subscription id lives at parent.subscription_details.subscription,
    // same idiom as subRenewal.ts:17-44.
    const subscriptionId = idOf(
      inv.parent?.subscription_details?.subscription as string | { id: string } | null | undefined
    );
    const customerId = idOf(inv.customer as string | { id: string } | null);
    const matrixId = customerId ? await resolveMatrixIdByCustomer(customerId) : null;
    await recordPaymentEvent({
      eventId: event.id, eventType: event.type, occurredAt: new Date(event.created * 1000),
      subscriptionId, matrixId, kind: "sub",
      amountCents: inv.amount_due, currency: inv.currency,
      outcome: "renewal_failed",
    });
  }

  return { handlePaymentFailed, handleRefund, handleDispute, handleInvoicePaymentFailed };
}

// `stripe: getStripe` passes the FUNCTION, never calls it — getStripe() throws
// if STRIPE_SECRET_KEY is unset, and that must stay lazy (webhook/route.ts's
// own `const stripe = getStripe();` is likewise called inside POST, not at
// module scope). Importing this module must never throw on a missing key.
const bound = createPaymentEventHandlers({ pool, stripe: getStripe, credits: moneyCredits });
export const handlePaymentFailed = bound.handlePaymentFailed;
export const handleRefund = bound.handleRefund;
export const handleDispute = bound.handleDispute;
export const handleInvoicePaymentFailed = bound.handleInvoicePaymentFailed;
