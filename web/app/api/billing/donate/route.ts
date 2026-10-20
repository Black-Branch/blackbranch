import { auth } from "@/auth";
import { siteName } from "@/app/lib/siteName";
import { getStripe, stripeConfigured, publicOrigin } from "@/app/lib/stripe";
import { resolveTipDisplayName } from "@/app/lib/tipDisplayNameServer";
import { supportBranding, SAVED_PM_OPTIONS, CUSTOMER_UPDATE } from "@/app/lib/billingServer";
import { ensureStripeCustomerOrBusy } from "@/app/lib/stripeCustomer";
import type Stripe from "stripe";
import { NextRequest } from "next/server";
import { sanitizeDisplayName, sanitizeChatMessage } from "@/app/lib/sanitize";
import { donationTtsChars } from "@/app/lib/donationTts";
import { createSlidingWindowLimiter, ipKey } from "@/app/lib/rateLimit";
import { statementSuffixFor, getStatementPrefixLength } from "@/app/lib/statementSuffix";
import { PAY_MIN_CENTS, PAY_MAX_CENTS } from "@/app/lib/coins";

export const runtime = "nodejs";

// Guests can call this, and every accepted call creates a Stripe Checkout
// Session — so it is throttled. Generous for a person (reopening the form,
// changing the amount, retrying a card), tight for a script.
const isDonateLimited = createSlidingWindowLimiter(10 * 60_000, 10);

// POST /api/billing/donate { amount, message?, displayName? } → { url }
// Opens a one-time Stripe Checkout (mode=payment). Works for guests and logged-in
// users alike; the donation row is written by the webhook, never the redirect.
export async function POST(req: NextRequest) {
  if (!stripeConfigured()) return new Response("Billing not configured", { status: 503 });

  const body = await req.json().catch(() => null);

  // amount arrives as dollars (number or numeric string); coerce to integer cents.
  const dollars = Number(body?.amount);
  if (!Number.isFinite(dollars)) return new Response("Bad amount", { status: 400 });
  const cents = Math.round(dollars * 100);
  if (cents < PAY_MIN_CENTS || cents > PAY_MAX_CENTS) {
    return new Response(`Amount must be between $${PAY_MIN_CENTS / 100} and $${PAY_MAX_CENTS / 100}`, { status: 400 });
  }

  const session = await auth();
  const matrixId = session?.user?.id ?? null;
  const anonymous = body?.anonymous === true;

  // Optional donor-supplied label/message. Both land on the on-stream overlay,
  // so they get the SAME invisible/bidi-control stripping every other display
  // name and chat line gets — trim+slice alone would let an RTL override or
  // zero-width chars through to the overlay and the donation card.
  // The message's own cap is the tier for the amount (below), not a flat 500.
  const rawName = typeof body?.displayName === "string" ? sanitizeDisplayName(body.displayName) : "";

  // The message may be at most what the voice will read for this amount —
  // the form already caps the box at the tier, so a longer one here is a
  // stale draft. Reject with the number rather than silently cutting it
  // (donationTts.ts; the tier is enforced again by stream-api at read time).
  //
  // Sanitize at `maxMessage + 1`, not the default 500: the top tier IS 500, so
  // sanitizing at the flat default first would cut a top-tier overflow to
  // exactly 500 and `rawMsg.length > maxMessage` could then never see it as
  // over — the same reason the chat route sanitizes at `charLimit + 1`. +1
  // makes every tier's overflow detectable; an accepted message is always
  // ≤ maxMessage.
  const maxMessage = donationTtsChars(cents / 100);
  const rawMsg = typeof body?.message === "string" ? sanitizeChatMessage(body.message, maxMessage + 1) : "";
  if (rawMsg.length > maxMessage) {
    return new Response(
      `A $${(cents / 100).toFixed(2)} donation carries a message of up to ${maxMessage} characters.`,
      { status: 400 }
    );
  }

  // Throttle AFTER every input refusal above (a typo or a stale over-length
  // draft is not a hit) and BEFORE anything reaches Stripe — the customer
  // upsert below included.
  if (isDonateLimited(matrixId ?? ipKey(req))) {
    return new Response("Too many donation attempts — try again in a few minutes.", { status: 429, headers: { "Retry-After": "600" } });
  }

  // The donor label the webhook stamps. This rule lives in one place, not
  // inline here and again in the PayPal order route — two copies of
  // one decision, which is the shape that drifts (the PayPal route shipped
  // WITHOUT the backfill for a round, so a signed-in tipper who left the box
  // blank would have been told on the page that their site name would be
  // used, and then appeared with none). Both routes now call the one
  // implementation; changing the rule in one place changes it everywhere.
  const displayName = await resolveTipDisplayName({ matrixId, anonymous, rawName });

  // Logged-in donors get a persistent customer (so their card + details are
  // saved and prefilled next time); guests stay guests (Stripe Link still
  // remembers them by email). Stripe-only — deliberately NOT part of the
  // shared name rule above, which the PayPal path also uses.
  let customerId: string | null = null;
  if (matrixId) {
    const customer = await ensureStripeCustomerOrBusy(matrixId);
    if (typeof customer !== "string") return customer;
    customerId = customer;
  }

  const stripe = getStripe();
  const prefixLength = await getStatementPrefixLength(stripe);
  const suffix = statementSuffixFor("donation", prefixLength);
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
          currency: "usd",
          unit_amount: cents,
          product_data: { name: `Tip to ${siteName()}` },
        },
      },
    ],
    // Stamp identity + donor label on the session so the webhook can record it.
    // amount_cents is the authoritative USD intent — same trick coins/route.ts
    // uses with metadata.coins — so tipCreditFromSession never over-credits
    // Qorm on a non-USD Adaptive Pricing settlement.
    metadata: {
      kind: "donation",
      matrix_id: matrixId ?? "",
      display_name: displayName,
      message: rawMsg,
      anonymous: anonymous ? "1" : "0",
      amount_cents: String(cents),
    },
    payment_intent_data: {
      metadata: { kind: "donation", matrix_id: matrixId ?? "" },
      ...(suffix ? { statement_descriptor_suffix: suffix } : {}),
      // NOTE: intentionally NOT setting setup_future_usage. Stripe hides PayPal
      // (and other non-reusable methods) whenever off_session reuse is requested,
      // so for a one-time donation we let all Dashboard-enabled methods show.
      // Logged-in donors can still opt to save a card via SAVED_PM_OPTIONS below.
    },
    branding_settings: supportBranding("#10b981"), // emerald-500
  };

  if (customerId) {
    params.customer = customerId;
    params.customer_update = CUSTOMER_UPDATE;
    params.saved_payment_method_options = SAVED_PM_OPTIONS;
  }

  const checkout = await stripe.checkout.sessions.create(params);

  return Response.json({ clientSecret: checkout.client_secret, sessionId: checkout.id });
}
