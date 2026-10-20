import { getStripe, stripeConfigured, publicOrigin } from "@/app/lib/stripe";
import { requireUser } from "@/app/lib/authGuard";
import { supportBranding, SAVED_PM_OPTIONS, CUSTOMER_UPDATE } from "@/app/lib/billingServer";
import { ensureStripeCustomerOrBusy } from "@/app/lib/stripeCustomer";
import { resolveRecipient, isGiftableRecipient } from "@/app/lib/giftServer";
import { isGiftMonths, giftAmountCents, MAX_COMMUNITY } from "@/app/lib/giftPricing";
import type Stripe from "stripe";
import { NextRequest } from "next/server";
import { createSlidingWindowLimiter } from "@/app/lib/rateLimit";
import { statementSuffixFor, getStatementPrefixLength } from "@/app/lib/statementSuffix";

export const runtime = "nodejs";

// Ten checkout starts a minute per viewer. Starting one takes one call; the
// bound stops a single account from holding the checkout connection budget
// (billingConnections.ts) and minting Checkout Sessions without limit.
const isGiftLimited = createSlidingWindowLimiter(60_000, 10);

// POST /api/billing/gift → { clientSecret }
// Gift Supporter to a specific user ({ type: "direct", recipient, months }) or to
// N random recent chatters ({ type: "community", count, months }). One-time
// payment; the webhook grants the recipient(s). Requires a logged-in gifter.
export async function POST(req: NextRequest) {
  if (!stripeConfigured()) return new Response("Billing not configured", { status: 503 });

  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;
  const gifter = matrixId;

  const body = await req.json().catch(() => null);
  const months = Number(body?.months);
  if (!isGiftMonths(months)) return new Response("Bad months", { status: 400 });
  const type = body?.type === "community" ? "community" : "direct";
  const anonymous = body?.anonymous === true;

  const metadata: Stripe.MetadataParam = {
    kind: "gift",
    gift_type: type,
    gifter_matrix_id: gifter,
    months: String(months),
    anonymous: anonymous ? "1" : "0",
  };
  let count = 1;
  let productName: string;

  if (type === "direct") {
    const recipient = await resolveRecipient(typeof body?.recipient === "string" ? body.recipient : "");
    if (!recipient) return new Response("No such user", { status: 404 });
    if (recipient.matrixId === gifter) return new Response("You can’t gift yourself", { status: 400 });
    if (!isGiftableRecipient(recipient.matrixId)) return new Response("You can’t gift that user", { status: 400 });
    metadata.recipient_matrix_id = recipient.matrixId;
    metadata.recipient_name = recipient.displayName ?? "";
    productName = `Gift: ${months}-month Supporter for ${recipient.displayName ?? recipient.matrixId}`;
  } else {
    count = Math.trunc(Number(body?.count));
    if (!Number.isFinite(count) || count < 1 || count > MAX_COMMUNITY) {
      return new Response(`Count must be between 1 and ${MAX_COMMUNITY}`, { status: 400 });
    }
    metadata.count = String(count);
    productName = `Community gift: ${count} × ${months}-month Supporter`;
  }

  // Throttle AFTER every input refusal above (a typo is not a hit) and BEFORE
  // anything reaches Stripe — the customer lookup included.
  if (isGiftLimited(matrixId)) {
    return new Response("Too many checkout attempts — try again in a minute.", { status: 429, headers: { "Retry-After": "60" } });
  }

  const stripe = getStripe();
  const prefixLength = await getStatementPrefixLength(stripe);
  const suffix = statementSuffixFor("gift", prefixLength);
  const customerId = await ensureStripeCustomerOrBusy(gifter);
  if (typeof customerId !== "string") return customerId;
  const checkout = await stripe.checkout.sessions.create({
    ui_mode: "embedded_page",
    // "if_required" so redirect-based wallets are offered (see donate route).
    redirect_on_completion: "if_required",
    return_url: `${publicOrigin(req.nextUrl.origin)}/billing/return?session_id={CHECKOUT_SESSION_ID}`,
    mode: "payment",
    customer: customerId,
    customer_update: CUSTOMER_UPDATE,
    saved_payment_method_options: SAVED_PM_OPTIONS,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: giftAmountCents(months, count),
          product_data: { name: productName },
        },
      },
    ],
    metadata,
    payment_intent_data: {
      metadata: { kind: "gift", gifter_matrix_id: gifter },
      ...(suffix ? { statement_descriptor_suffix: suffix } : {}),
      // NOTE: intentionally NOT setting setup_future_usage — Stripe hides PayPal /
      // Venmo (non-reusable methods) whenever off_session reuse is requested. This
      // is a one-time gift, so let all Dashboard-enabled methods show. Gifters can
      // still opt to save a card via SAVED_PM_OPTIONS above.
    },
    branding_settings: supportBranding("#8b5cf6"), // violet-500
  });

  return Response.json({ clientSecret: checkout.client_secret, sessionId: checkout.id });
}
