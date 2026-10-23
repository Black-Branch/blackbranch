import { NextRequest } from "next/server";
import { paypalModuleOn, paypalWebhookConfigured, verifyPaypalWebhook } from "@/app/lib/paypalClient";
import { onCaptureCompleted, onCaptureRefunded, onDisputeResolved, onCaptureReversed } from "@/app/lib/paypalWebhookHandlers";
import { reversePaypalSupport } from "@/app/lib/paymentReversalsLedger";
import { plausiblePaypalDelivery } from "@/app/lib/paypalSubscriptions";
import {
  onPaypalSubscriptionEvent, onPaypalSaleCompleted, onPaypalSaleRefunded, onPaypalSaleReversed, onPaypalSaleDisputeResolved,
} from "@/app/lib/subscriptions/paypal";

export const runtime = "nodejs";

// POST /api/billing/paypal/webhook — PayPal webhook receiver, the ONLY writer
// of PayPal payment state, and — through the PayPal subscription adapter
// (subscriptions/paypal.ts → the one transition function), only after the
// signature check below — of PayPal subscription state. The PayPal app's
// webhook registration must subscribe to PAYMENT.CAPTURE.COMPLETED,
// PAYMENT.CAPTURE.REFUNDED, CUSTOMER.DISPUTE.RESOLVED and
// PAYMENT.CAPTURE.REVERSED (tips), and for subscriptions to
// BILLING.SUBSCRIPTION.* (CREATED, ACTIVATED, UPDATED, EXPIRED, CANCELLED,
// SUSPENDED, PAYMENT.FAILED), PAYMENT.SALE.COMPLETED, PAYMENT.SALE.REFUNDED and
// PAYMENT.SALE.REVERSED — a type that is handled below but not subscribed is
// never delivered (a lost-dispute reversal, for one). An unsubscribed type
// that does arrive falls to the `default: break;` below, so nothing breaks
// either way.
export async function POST(req: NextRequest) {
  // PayPal switched off (Payments → Connections): "not found" before anything is read; PayPal retries a
  // non-2xx delivery 25 times over about three days, so switching back on in time loses nothing.
  if (!paypalModuleOn()) return new Response("Not found", { status: 404 });
  if (!paypalWebhookConfigured()) {
    console.error("[paypal] webhook not configured — PAYPAL_WEBHOOK_ID missing");
    return new Response("Webhook not configured", { status: 503 });
  }

  // Cheap refusals first: PayPal's verify endpoint is a network call per request, so a POST that
  // cannot be a PayPal delivery — no transmission headers, or a certificate URL that is not
  // PayPal's — is answered 400 before PayPal is ever asked (security review, 2026-10-21).
  if (!plausiblePaypalDelivery(req.headers)) {
    console.warn("[paypal] webhook refused before verification: missing transmission headers or a cert_url outside paypal.com");
    return new Response("bad signature", { status: 400 });
  }

  const raw = await req.text(); // RAW body — verification needs the exact bytes, never logged

  // verifyPaypalWebhook THROWS on a PayPal-side outage (a non-200 from
  // PayPal's own verify endpoint) and RETURNS false on an unparseable body or
  // a status that isn't exactly "SUCCESS". Those are different failures and
  // must answer differently — a throw is PayPal's own outage and must 500 so
  // PayPal retries; `false` is a forged or malformed delivery and must 400 so
  // PayPal stops. Kept in this one try/catch, apart from the handler
  // dispatch's own try/catch below, so neither failure can be mistaken for
  // the other.
  let verified: boolean;
  try {
    verified = await verifyPaypalWebhook({ headers: req.headers, rawBody: raw });
  } catch (e) {
    console.error("[paypal] webhook verification errored (PayPal-side failure): %s", (e as Error).message);
    return new Response("verification error", { status: 500 });
  }
  if (!verified) {
    console.warn("[paypal] webhook signature verification failed");
    return new Response("bad signature", { status: 400 });
  }

  const event = JSON.parse(raw) as { id: string; event_type: string; create_time: string; resource: unknown };

  try {
    switch (event.event_type) {
      case "PAYMENT.CAPTURE.COMPLETED":
        await onCaptureCompleted(event);
        break;
      // Each reversal then reaches the support ledger too (stream-api /support/reverse): a
      // refunded tip stops counting toward lifetime support, tiers and sponsor weighting.
      case "PAYMENT.CAPTURE.REFUNDED":
        await onCaptureRefunded(event);
        await reversePaypalSupport(event);
        break;
      case "CUSTOMER.DISPUTE.RESOLVED":
        await onDisputeResolved(event);
        await reversePaypalSupport(event);
        // A dispute of a subscription SALE (not a tip capture): its reversal or restore.
        await onPaypalSaleDisputeResolved(event);
        break;
      case "PAYMENT.CAPTURE.REVERSED":
        await onCaptureReversed(event);
        await reversePaypalSupport(event);
        break;
      // Subscriptions (spec §5.2): the event names a subscription; its state is read from PayPal.
      case "BILLING.SUBSCRIPTION.CREATED":
      case "BILLING.SUBSCRIPTION.ACTIVATED":
      case "BILLING.SUBSCRIPTION.UPDATED":
      case "BILLING.SUBSCRIPTION.EXPIRED":
      case "BILLING.SUBSCRIPTION.CANCELLED":
      case "BILLING.SUBSCRIPTION.SUSPENDED":
      case "BILLING.SUBSCRIPTION.PAYMENT.FAILED":
        await onPaypalSubscriptionEvent(event);
        break;
      // A subscription payment: its row, its access, its card (§8.2).
      case "PAYMENT.SALE.COMPLETED":
        await onPaypalSaleCompleted(event);
        break;
      // A sale's refund or chargeback → the stream ledger, under the sale's stored spendId (§8.4).
      case "PAYMENT.SALE.REFUNDED":
        await onPaypalSaleRefunded(event);
        break;
      case "PAYMENT.SALE.REVERSED":
        await onPaypalSaleReversed(event);
        break;
      default:
        break; // subscribed-but-unhandled is not an error
    }
  } catch (e) {
    // 500 so PayPal retries — never silently drop a tip, the same rule the
    // Stripe webhook runs on (app/api/billing/webhook/route.ts:112-116).
    console.error("[paypal] handler failed for %s: %s", event.event_type, (e as Error).message);
    return new Response("handler error", { status: 500 });
  }

  return new Response("ok");
}
