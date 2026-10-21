import { getStripe, stripeConfigured, publicOrigin } from "@/app/lib/stripe";
import { requireUser } from "@/app/lib/authGuard";
import { supportBranding, SAVED_PM_OPTIONS, CUSTOMER_UPDATE } from "@/app/lib/billingServer";
import { ensureStripeCustomerOrBusy } from "@/app/lib/stripeCustomer";
import { TIERS, type TierSlug } from "@/app/lib/tiers";
import { supporterPrice } from "@/app/lib/supporterPrice";
import { NextRequest } from "next/server";
import { createSlidingWindowLimiter } from "@/app/lib/rateLimit";
import pool from "@/lib/db";
import { entitledElsewhere, subscriptionSources } from "@/app/lib/subscriptions/entitlement";

export const runtime = "nodejs";

// Ten checkout starts a minute per viewer. Starting one takes one call; the
// bound stops a single account from holding the checkout connection budget
// (billingConnections.ts) and minting Checkout Sessions without limit.
const isCheckoutLimited = createSlidingWindowLimiter(60_000, 10);

// POST /api/billing/checkout { tier } → { url }
// Creates (or reuses) the user's Stripe customer, then opens a hosted Checkout
// session for the chosen tier. The actual subscription row is written by the
// webhook once payment completes — never trust the redirect to mutate state.
export async function POST(req: NextRequest) {
  if (!stripeConfigured()) return new Response("Billing not configured", { status: 503 });

  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;

  const body = await req.json().catch(() => null);
  const slug = body?.tier as TierSlug | undefined;
  // Own properties only: `tier: "toString"` must not find Object.prototype's.
  const tier = slug && Object.hasOwn(TIERS, slug) ? TIERS[slug] : undefined;
  if (!tier) return new Response("Bad tier", { status: 400 });
  // No usable price (unset, archived, not monthly) = this site does not offer subscriptions: the
  // panel hides the button, and a stale tab that still posts gets words, not a 503 (R1.10).
  const price = await supporterPrice();
  if (!price) return new Response("Subscriptions aren’t offered on this site.", { status: 404 });

  // Throttle AFTER every input refusal above (a typo is not a hit) and BEFORE
  // anything reaches Stripe — the customer lookup included.
  if (isCheckoutLimited(matrixId)) {
    return new Response("Too many checkout attempts — try again in a minute.", { status: 429, headers: { "Retry-After": "60" } });
  }

  // Already a Supporter through another service (PayPal, later Patreon/Ko-fi): a second, separate
  // subscription — paying twice. Refused unless the viewer saw the warning and chose it
  // (`alsoElsewhere: true`), so a stale page cannot skip it (subscription sources D24, §10.1).
  if (body?.alsoElsewhere !== true) {
    const other = await entitledElsewhere(pool, matrixId, "stripe", subscriptionSources());
    if (other) return Response.json({ error: "subscribed_elsewhere", provider: other.provider, periodEnd: other.periodEnd }, { status: 409 });
  }

  const stripe = getStripe();
  const customerId = await ensureStripeCustomerOrBusy(matrixId);
  if (typeof customerId !== "string") return customerId;

  // Stripe happily lets one customer hold several concurrent subscriptions, and
  // site.subscriptions is keyed on matrix_id — ONE row per user. So a second
  // checkout silently overwrites the first: the user is billed twice, only the
  // newer sub is tracked, and canceling it clears the row while the orphaned
  // first subscription keeps charging with nothing pointing at it.
  //
  // Ask Stripe (not our mirror) so a sub that exists upstream but hasn't been
  // mirrored yet — the webhook is asynchronous — still blocks a duplicate.
  const existing = await stripe.subscriptions
    .list({ customer: customerId, status: "all", limit: 100 })
    .catch(() => null);
  if (!existing) return new Response("Could not verify subscription state", { status: 503 });
  const live = existing.data.find((s) =>
    ["active", "trialing", "past_due", "unpaid", "incomplete"].includes(s.status)
  );
  if (live) {
    // 409 so the client can route to the billing portal to change or cancel,
    // rather than stacking a second subscription.
    return Response.json(
      { error: "already_subscribed", status: live.status, manage: "/billing" },
      { status: 409 }
    );
  }

  const checkout = await stripe.checkout.sessions.create({
    ui_mode: "embedded_page",
    // "if_required": card payments stay in the modal, but redirect-based methods
    // (Cash App Pay, Amazon Pay) are only OFFERED when Stripe knows it can send
    // the customer somewhere afterwards — "never" silently hid them all. The
    // return page is display-only; the webhook remains the sole state writer.
    redirect_on_completion: "if_required",
    return_url: `${publicOrigin(req.nextUrl.origin)}/billing/return?session_id={CHECKOUT_SESSION_ID}`,
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: price.id, quantity: 1 }],
    // Stamp our identity on both the session and the subscription so the webhook
    // can resolve the user even if the customer record ever drifts.
    metadata: { matrix_id: matrixId, tier: tier.slug },
    subscription_data: { metadata: { matrix_id: matrixId, tier: tier.slug } },
    // Remember the customer's details + show saved cards next time.
    customer_update: CUSTOMER_UPDATE,
    saved_payment_method_options: SAVED_PM_OPTIONS,
    branding_settings: supportBranding("#f59e0b"), // amber-500
  });

  return Response.json({ clientSecret: checkout.client_secret });
}
