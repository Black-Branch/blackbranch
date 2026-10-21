import { getStripe, stripeConfigured, publicOrigin } from "@/app/lib/stripe";
import { requireUser } from "@/app/lib/authGuard";
import { supportBranding, SAVED_PM_OPTIONS, CUSTOMER_UPDATE } from "@/app/lib/billingServer";
import { ensureStripeCustomerOrBusy } from "@/app/lib/stripeCustomer";
import { PAY_MIN_CENTS, PAY_MAX_CENTS } from "@/app/lib/coins";
import { SITE_CURRENCY } from "@/app/lib/moneyFormat";
import { currencyLabel, currencyName } from "@/app/lib/currency";
import { instanceBool } from "@/app/lib/instanceConfigServer";
import { siteName } from "@/app/lib/siteName";
import type Stripe from "stripe";
import { NextRequest } from "next/server";
import { createSlidingWindowLimiter } from "@/app/lib/rateLimit";
import { statementSuffixFor, getStatementPrefixLength } from "@/app/lib/statementSuffix";

export const runtime = "nodejs";

// Ten checkout starts a minute per viewer. Starting one takes one call; the
// bound stops a single account from holding the checkout connection budget
// (billingConnections.ts) and minting Checkout Sessions without limit.
const isPointsLimited = createSlidingWindowLimiter(60_000, 10);

// POST /api/billing/points { amount } → { clientSecret }
// Coin top-up: a one-time payment Checkout at the transparent 1:1 peg — the
// user picks ANY dollar amount (no bundles, no markup) and receives exactly
// amount×100 coins. Sign-in required: guests cannot hold a wallet (closed-loop
// custody). The wallet is credited by the webhook, never the redirect.
export async function POST(req: NextRequest) {
  if (!stripeConfigured()) return new Response("Billing not configured", { status: 503 });
  // The buy switch (`currency.purchasable`): off = points are only earned here.
  if (!instanceBool("currency.purchasable")) return new Response(`Buying ${currencyName()} is switched off on this site`, { status: 403 });

  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;

  const body = await req.json().catch(() => null);
  const dollars = Number(body?.amount);
  if (!Number.isFinite(dollars)) return new Response("Bad amount", { status: 400 });
  const cents = Math.round(dollars * 100);
  if (cents < PAY_MIN_CENTS || cents > PAY_MAX_CENTS) {
    return new Response(
      `Amount must be between $${PAY_MIN_CENTS / 100} and $${PAY_MAX_CENTS / 100}`,
      { status: 400 }
    );
  }

  // Throttle AFTER every input refusal above (a typo is not a hit) and BEFORE
  // anything reaches Stripe — the customer lookup included.
  if (isPointsLimited(matrixId)) {
    return new Response("Too many checkout attempts — try again in a minute.", { status: 429, headers: { "Retry-After": "60" } });
  }

  const customerId = await ensureStripeCustomerOrBusy(matrixId);
  if (typeof customerId !== "string") return customerId;

  const stripe = getStripe();
  const prefixLength = await getStatementPrefixLength(stripe);
  const suffix = statementSuffixFor("coin_purchase", prefixLength);
  const params: Stripe.Checkout.SessionCreateParams = {
    ui_mode: "embedded_page",
    // "if_required" so redirect-based wallets (Cash App, Amazon Pay) are offered;
    // cards still complete in the modal. Webhook stays the sole state writer.
    redirect_on_completion: "if_required",
    return_url: `${publicOrigin(req.nextUrl.origin)}/billing/return?session_id={CHECKOUT_SESSION_ID}`,
    mode: "payment",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: SITE_CURRENCY,
          unit_amount: cents,
          product_data: { name: `${currencyLabel(cents)} — ${siteName()}` },
        },
      },
    ],
    // The webhook credits the wallet from this: kind routes the payment-mode
    // switch, coins = the credited amount (== cents, 1:1 peg).
    metadata: {
      kind: "coin_purchase",
      matrix_id: matrixId,
      coins: String(cents),
    },
    payment_intent_data: {
      metadata: { kind: "coin_purchase", matrix_id: matrixId },
      ...(suffix ? { statement_descriptor_suffix: suffix } : {}),
      // No setup_future_usage — same reasoning as donations (PayPal/wallet
      // visibility); saved cards still offered via SAVED_PM_OPTIONS below.
    },
    branding_settings: supportBranding("#eab308"), // gold — the coin accent
    customer: customerId,
    customer_update: CUSTOMER_UPDATE,
    saved_payment_method_options: SAVED_PM_OPTIONS,
  };

  const checkout = await stripe.checkout.sessions.create(params);
  return Response.json({ clientSecret: checkout.client_secret, sessionId: checkout.id });
}
