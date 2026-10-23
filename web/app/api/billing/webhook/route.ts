import pool from "@/lib/db";
import { getChatIdentity } from "@/app/lib/chatIdentity";
import { getStripe, stripeModuleOn } from "@/app/lib/stripe";
import { tierByPriceId, isActiveStatus, TIERS } from "@/app/lib/tiers";
import { invalidateTier } from "@/app/lib/entitlements";
import { syncSubscriberBadge } from "@/app/lib/billingServer";
import { resolveMatrixId, syncSubscriptionState } from "@/app/lib/subscriptionSync";
import { recordGift } from "@/app/lib/giftServer";
import { recordCoinPurchase, moneyCredits } from "@/app/lib/coinsServer";
import { tipCreditFromSession } from "@/app/lib/tipCredit";
import { notifyBadgesChanged } from "@/app/lib/streamApi";
import { handlePaymentFailed, handleRefund, handleDispute, handleInvoicePaymentFailed } from "@/app/lib/paymentEventHandlers";
import { reverseStripeSupport } from "@/app/lib/paymentReversalsLedger";
// The retrying, loud-on-loss celebration delivery — NOT the old single-shot
// streamApiPost swallow. Every payload below carries a
// Stripe-derived spendId; /chat/event's outcome store dedups on it.
import { broadcastChatEvent } from "@/app/lib/chatEventDelivery";
import { renewalFromInvoice, tenureMonths } from "@/app/lib/subRenewal";
import { NextRequest } from "next/server";
import type Stripe from "stripe";
import { instanceString } from "@/app/lib/instanceConfigServer";

export const runtime = "nodejs";

// POST /api/billing/webhook — Stripe webhook receiver.
// Verifies the signature against STRIPE_WEBHOOK_SECRET, then hands Stripe's
// subscription state to the ONE transition function (subscriptions/state.ts
// writeTransition, through subscriptionSync.ts), the only writer of
// subscription tier/status, called only from provider-verified paths — this
// route, after the signature check, is Stripe's. The checkout redirect is never
// trusted to grant a sub.
export async function POST(req: NextRequest) {
  // Card payments switched off (Payments → Connections): "not found", before anything is read — Stripe
  // keeps a non-2xx event and retries it for about three days, so switching back on in time loses
  // nothing. On the owner's chain-built database an absent switch reads ON (instanceConfigServer).
  if (!stripeModuleOn()) return new Response("Not found", { status: 404 });
  const secret = instanceString("stripe.webhookSecret");
  if (!secret) return new Response("Webhook not configured", { status: 503 });
  const sig = req.headers.get("stripe-signature");
  if (!sig) return new Response("No signature", { status: 400 });

  const stripe = getStripe();
  const raw = await req.text(); // raw body required for signature verification
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(raw, sig, secret);
  } catch {
    return new Response("Bad signature", { status: 400 });
  }

  try {
    switch (event.type) {
      case "customer.subscription.created": {
        // The ONE event that fires the "X subscribed" card (third argument).
        const sub = event.data.object as Stripe.Subscription;
        await syncSubscription(sub, event.created, sub);
        break;
      }
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await syncSubscription(event.data.object as Stripe.Subscription, event.created);
        break;
      case "invoice.paid":
        // A RENEWAL (subscription_cycle only — renewalFromInvoice guards). The
        // first invoice is credited by customer.subscription.created above; a
        // renewal otherwise arrives only as subscription.updated with announce
        // off, so the site's own recurring income would never reach the bar or
        // stream.support_events.
        await recordRenewal(stripe, event.data.object as Stripe.Invoice);
        break;
      case "checkout.session.completed": {
        const cs = event.data.object as Stripe.Checkout.Session;
        if (cs.mode === "subscription" && cs.subscription) {
          // Don't announce here — a new sub also fires customer.subscription.created,
          // so announcing on both would double-card. That event owns the card.
          const id = typeof cs.subscription === "string" ? cs.subscription : cs.subscription.id;
          await syncSubscription({ id }, event.created);
        } else if (cs.mode === "payment") {
          await recordPaymentSession(cs);
        }
        break;
      }
      case "checkout.session.async_payment_succeeded": {
        // Redirect-based methods (Cash App, Amazon Pay, bank debits) settle AFTER
        // checkout.session.completed fires with payment_status='unpaid' — the paid
        // guard skipped them there, so credit on this event instead.
        // Idempotency (session-id refs + ON CONFLICT) makes any overlap harmless.
        //
        // This MUST mirror the .completed dispatch exactly. It previously handled
        // ONLY coin_purchase, so a gift or donation paid by a delayed method
        // charged the customer and granted nothing — no error, no alert, no
        // reconciliation path. Both events now route through one helper so the
        // two paths cannot drift apart again.
        const cs = event.data.object as Stripe.Checkout.Session;
        if (cs.mode === "payment") await recordPaymentSession(cs);
        break;
      }
      case "checkout.session.async_payment_failed": {
        // Nothing to unwind — every recorder credits only on payment_status
        // 'paid', so a failed delayed settlement never granted anything. Logged
        // so it is visible rather than silent.
        const cs = event.data.object as Stripe.Checkout.Session;
        console.error(
          "[billing] async payment FAILED — session=%s kind=%s matrix_id=%s",
          cs.id,
          cs.metadata?.kind ?? "donation",
          cs.metadata?.matrix_id ?? "(none)"
        );
        break;
      }
      case "payment_intent.payment_failed":
        await handlePaymentFailed(event);
        break;
      case "refund.created":
      case "refund.updated":
        await handleRefund(event);
        // Then the support ledger: a refunded donation/gift/sub stops counting toward lifetime
        // support, tiers and sponsor weighting (stream-api /support/reverse). A throw → 500 → retry.
        await reverseStripeSupport(event);
        break;
      case "charge.dispute.created":
      case "charge.dispute.closed":
        await handleDispute(event);
        await reverseStripeSupport(event);
        break;
      case "invoice.payment_failed":
        await handleInvoicePaymentFailed(event);
        break;
    }
  } catch (e) {
    // 500 so Stripe retries — never silently drop a billing event.
    console.error("[billing webhook]", event.type, e);
    return new Response("Handler error", { status: 500 });
  }

  return Response.json({ received: true });
}

// Dispatch a payment-mode Checkout session to the recorder its `kind` names.
//
// Shared deliberately by BOTH checkout.session.completed and
// checkout.session.async_payment_succeeded: a delayed-settlement method must
// grant exactly what an instant one grants. Every recorder below guards on
// payment_status === 'paid' and is idempotent on the session id, so calling
// this twice for the same session is harmless.
async function recordPaymentSession(cs: Stripe.Checkout.Session) {
  if (cs.metadata?.kind === "gift") await recordGift(cs);
  else if (cs.metadata?.kind === "coin_purchase") await recordCoinPurchase(cs);
  else await recordDonation(cs);
}

// Record a one-time donation from a completed payment-mode Checkout session.
// Idempotent on the session id so webhook retries never double-count.
async function recordDonation(cs: Stripe.Checkout.Session) {
  if (cs.payment_status !== "paid") return; // only count settled payments
  const amount = cs.amount_total ?? 0;
  if (amount <= 0) return;

  const matrixId = cs.metadata?.matrix_id || null;
  const anonymous = cs.metadata?.anonymous === "1";
  // Anonymous donors keep their ledger row (matrix_id intact for refunds) but carry
  // no public label — the highlighted-chat work renders them as "Anonymous".
  const displayName = anonymous ? null : cs.metadata?.display_name || null;
  const message = cs.metadata?.message || null;
  const paymentIntent =
    typeof cs.payment_intent === "string" ? cs.payment_intent : cs.payment_intent?.id ?? null;

  // Qorm for the tip. BEFORE the donations INSERT and its replay guard, on
  // purpose: recordTipCredit is idempotent on its own ref (`stripe:<session id>`)
  // and does not depend on the donations row existing. After it would be
  // wrong — a transient throw here would 500 the webhook, Stripe would retry,
  // the INSERT would then hit its ON CONFLICT (rowCount 0), and the
  // credit-then-early-return would skip broadcastChatEvent below entirely,
  // which is what announces the tip on stream AND credits the support bar.
  // Crediting first means whatever failed on a prior attempt, a retry always
  // still reaches the announce path.
  const tipCredit = tipCreditFromSession(cs);
  if (tipCredit) await moneyCredits.recordTipCredit(tipCredit);

  // `external_id` carries the SAME value as stripe_session_id, and writing it is
  // not optional (v124): the table's new UNIQUE (provider, external_id) is what
  // stops a second provider double-recording a tip, and Postgres permits
  // unlimited NULLs in a unique index — so a Stripe path that left it null would
  // make the constraint true only of back-filled history and silently protect
  // nothing going forward. `provider` takes its 'stripe' default.
  // ON CONFLICT stays on (stripe_session_id): that is still what makes THIS
  // path idempotent under a webhook retry, and it is the older, narrower key.
  const ins = await pool.query(
    `INSERT INTO site.donations
       (stripe_session_id, external_id, stripe_payment_intent, matrix_id, display_name, message, amount_cents, currency, anonymous)
     VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (stripe_session_id) DO NOTHING
     RETURNING id`,
    [cs.id, paymentIntent, matrixId, displayName, message, amount, cs.currency ?? "usd", anonymous]
  );

  // Only announce on a fresh insert — a webhook retry (rowCount 0) must not
  // re-highlight the donation in chat.
  if ((ins.rowCount ?? 0) === 0) return;

  // #6: highlight the donation as a chat message from the donor. Resolve the
  // donor's display name + chat color (unless anonymous) so the highlight matches
  // how they appear in chat. Best-effort: the donation is already recorded above.
  let donor = displayName;
  let usernameColor: string | null = null;
  let usernameStyle: object | null = null;
  if (!anonymous && matrixId) {
    const identity = await getChatIdentity(matrixId);
    donor = donor || identity.username;
    usernameColor = identity.usernameColor;
    usernameStyle = identity.usernameStyle;
  }
  await broadcastChatEvent({
    kind: "donation",
    // Session-derived idempotency key: this celebration is what credits the
    // support bar + support_events for a native donation, and the retry that
    // protects it from a restart window is only legal because /chat/event
    // dedups on this id (mirroring announceGift).
    spendId: `donation:${cs.id}`,
    donor: anonymous ? "Anonymous" : donor || "Anonymous",
    donorMatrixId: anonymous ? null : matrixId,
    anonymous,
    amount,
    currency: cs.currency ?? "usd",
    message,
    usernameColor,
    usernameStyle,
  });
}

// Celebrate + credit a subscription renewal. Writes NOTHING to
// site.subscriptions — syncSubscription (from the subscription.updated that
// accompanies every cycle) stays the only writer of tier/status. This path
// only sends the card that makes stream-api credit the bar + support_events,
// exactly as the first month's card does.
async function recordRenewal(stripe: Stripe, inv: Stripe.Invoice) {
  const renewal = renewalFromInvoice(inv);
  if (!renewal) return;
  const sub = await stripe.subscriptions.retrieve(renewal.subscriptionId);
  const customerId = renewal.customerId ?? (typeof sub.customer === "string" ? sub.customer : sub.customer.id);
  const matrixId = await resolveMatrixId(sub, customerId);
  if (!matrixId) {
    console.error("[billing] no matrix_id for renewal", inv.id, sub.id);
    return;
  }
  // Tenure = paid invoices on this subscription. Best-effort: a listing
  // failure still announces the renewal, floored at two months.
  const paid = await stripe.invoices
    .list({ subscription: sub.id, status: "paid", limit: 100 })
    .then((r) => r.data.length)
    .catch(() => 0);
  const identity = await getChatIdentity(matrixId);
  const tier = tierByPriceId(sub.items.data[0]?.price?.id ?? null);
  await broadcastChatEvent({
    kind: "sub",
    // The invoice id is constant across every delivery of the same
    // invoice.paid, so a retry dedups to ONE bar credit — and it is distinct
    // from the first month's `sub:<subscription id>`.
    spendId: `renewal:${inv.id}`,
    subscriber: identity.username,
    subscriberMatrixId: matrixId,
    usernameColor: identity.usernameColor,
    usernameStyle: identity.usernameStyle,
    tier: tier?.name ?? "Supporter",
    months: tenureMonths(paid, sub.trial_end != null),
    amount: renewal.amount, // cents
    currency: renewal.currency,
  });
}

// Mirror a subscription into site.subscriptions (subscriptionSync.ts holds the
// upsert, called from nowhere else), then everything that follows a written
// state change. Only the subscription's id is read from the event: the state
// written is Stripe's current one (see subscriptionSync.ts). `announceFrom` is
// the customer.subscription.created snapshot — the ONE event that fires the
// "X subscribed" card, so it happens exactly once per new sub (not on
// renewals/updates or the overlapping checkout); the card is about that event,
// so it is built from it. `eventAt` is the Stripe Event's `created` (unix seconds).
async function syncSubscription(
  ref: Pick<Stripe.Subscription, "id">,
  eventAt: number,
  announceFrom: Stripe.Subscription | null = null
) {
  const wrote = await syncSubscriptionState(ref, eventAt);
  // Nothing written (no viewer for it, or a stale event): do NOT touch the
  // badge, cache or announcement, or we would undo newer state.
  if (!wrote) return;
  const { matrixId, effectiveTier } = wrote;
  const state = wrote.sub; // the state that was WRITTEN, which may be newer than the event's

  // Perk: keep the Subscriber badge in lockstep with entitlement. Active +
  // tier grants badge → ensure assignment; otherwise revoke it.
  const entitled = isActiveStatus(state.status) && Boolean(effectiveTier && TIERS[effectiveTier].perks.badge);
  await syncSubscriberBadge(matrixId, entitled);
  void notifyBadgesChanged();

  // Drop the cached tier so chat perks reflect the change without TTL lag.
  invalidateTier(matrixId);

  // Celebrate a brand-new subscription in chat (mirrors donation/gift cards).
  // Resolve the subscriber's display name + color so the card matches how they
  // appear in chat; pass the price so stream-api credits the support bar +
  // support_events (subs are income). Best-effort — broadcastChatEvent never throws.
  // A TRIALING sub (a card bought during a gift — checkout's trial_end) has paid nothing yet: its
  // first charge comes at the trial's end as a subscription_cycle invoice, which recordRenewal
  // celebrates and credits. Crediting the price here too would count income that never arrived.
  const sub = announceFrom;
  if (sub && isActiveStatus(sub.status) && sub.status !== "trialing") {
    const identity = await getChatIdentity(matrixId);
    const price = sub.items.data[0]?.price;
    const tier = tierByPriceId(price?.id ?? null);
    await broadcastChatEvent({
      kind: "sub",
      // The subscription id is constant across every delivery of the same
      // `customer.subscription.created`, so a redelivered or retried announce
      // dedups to one bar credit.
      spendId: `sub:${sub.id}`,
      subscriber: identity.username,
      subscriberMatrixId: matrixId,
      usernameColor: identity.usernameColor,
      usernameStyle: identity.usernameStyle,
      tier: tier?.name ?? "Supporter",
      months: 1,
      amount: price?.unit_amount ?? 0, // cents
      currency: price?.currency ?? "usd",
    });
  }
}
