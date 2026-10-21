import { requireUser } from "@/app/lib/authGuard";
import { createSlidingWindowLimiter } from "@/app/lib/rateLimit";
import { paypalModuleOn } from "@/app/lib/paypalClient";
import { cancelPaypalSubscriptions } from "@/app/lib/subscriptions/paypal";

export const runtime = "nodejs";

// POST /api/billing/paypal/subscription/cancel → { cancelled }
// The viewer's own PayPal subscription, cancelled with PayPal's documented merchant cancel
// (spec §5.2, §10.2) — the on-site Cancel, because PayPal's own "automatic payments" page has no
// address we could verify. Writes NOTHING: PayPal's CANCELLED webhook does, and access runs to
// the end of the period already paid for (D9).

const isCancelLimited = createSlidingWindowLimiter(60_000, 5);

export async function POST() {
  if (!paypalModuleOn()) return new Response("Not found", { status: 404 });
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;
  if (isCancelLimited(matrixId)) {
    return new Response("Too many attempts — try again in a minute.", { status: 429, headers: { "Retry-After": "60" } });
  }
  try {
    return Response.json(await cancelPaypalSubscriptions(matrixId));
  } catch (e) {
    console.error("[paypal] cancel failed: %s", e instanceof Error ? e.message : String(e));
    return new Response("Couldn’t reach PayPal. Try again.", { status: 502 });
  }
}
