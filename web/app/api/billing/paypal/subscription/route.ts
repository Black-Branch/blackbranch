import { NextRequest } from "next/server";
import { auth } from "@/auth";
import { requireUser } from "@/app/lib/authGuard";
import { createSlidingWindowLimiter } from "@/app/lib/rateLimit";
import { TIERS, type TierSlug } from "@/app/lib/tiers";
import { paypalSubscriptionsConfigured } from "@/app/lib/paypalSubscriptions";
import { paypalSubscriptionOffer, startPaypalSubscription } from "@/app/lib/subscriptions/paypal";

export const runtime = "nodejs";

// PayPal subscriptions (subscription sources S3, spec §5.2, §10.1).
//
// GET  → { offered, price, elsewhere } — whether the subscribe sheet shows the PayPal button: the
//        PayPal module on with its keys, a plan set for the tier, and that plan an active monthly
//        price at PayPal. `elsewhere` (signed in only): the viewer is already a Supporter through
//        another service, for the "you'd be paying twice" warning.
// POST { tier, alsoElsewhere? } → { subscriptionId } — writes an intent and creates the PayPal
//        subscription with it as `custom_id`; the browser's PayPal button opens THAT subscription
//        for approval. Grants NOTHING: the PayPal webhook does, once PayPal says it is paid. The
//        popup's onApprove is display-only, like Stripe's return page.
//        409 already_subscribed — a PayPal subscription is already live (same service twice);
//        409 subscribed_elsewhere — a Supporter through another service, unless alsoElsewhere is
//        set (D24: a stale page cannot skip the warning).

// Ten starts a minute per viewer — checkout/route.ts's bound: each start creates a PayPal
// subscription and holds a checkout-budget connection while PayPal answers.
const isSubscribeLimited = createSlidingWindowLimiter(60_000, 10);

export async function GET() {
  const session = await auth();
  const offer = await paypalSubscriptionOffer(session?.user?.id ?? null, paypalSubscriptionsConfigured()).catch((e: unknown) => {
    console.error("[paypal] subscription offer failed: %s", e instanceof Error ? e.message : String(e));
    return { offered: false, price: null, elsewhere: null };
  });
  return Response.json(offer, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  if (!paypalSubscriptionsConfigured()) return new Response("PayPal subscriptions aren’t offered on this site.", { status: 404 });

  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;

  const body = await req.json().catch(() => null);
  const slug = body?.tier as TierSlug | undefined;
  if (!slug || !Object.hasOwn(TIERS, slug)) return new Response("Bad tier", { status: 400 });
  const alsoElsewhere = body?.alsoElsewhere === true;

  // After every input refusal (a typo is not a hit), before anything reaches PayPal.
  if (isSubscribeLimited(matrixId)) {
    return new Response("Too many attempts — try again in a minute.", { status: 429, headers: { "Retry-After": "60" } });
  }

  let r: Awaited<ReturnType<typeof startPaypalSubscription>>;
  try {
    r = await startPaypalSubscription(matrixId, { tier: slug, alsoElsewhere });
  } catch (e) {
    console.error("[paypal] subscribe start failed: %s", e instanceof Error ? e.message : String(e));
    return new Response("Couldn’t reach PayPal. Try again.", { status: 502 });
  }
  if (r.ok) return Response.json({ subscriptionId: r.subscriptionId });
  if (r.error === "busy") return new Response("Busy — try again in a moment.", { status: 503, headers: { "Retry-After": "3" } });
  if (r.error === "not_offered") return new Response("PayPal subscriptions aren’t offered on this site.", { status: 404 });
  if (r.error === "subscribed_elsewhere") {
    return Response.json({ error: r.error, provider: r.provider, periodEnd: r.periodEnd }, { status: 409 });
  }
  return Response.json({ error: r.error }, { status: 409 });
}
