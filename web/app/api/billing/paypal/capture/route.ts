import { NextRequest } from "next/server";
import { auth } from "@/auth";
import { paypalConfigured, capturePaypalOrder } from "@/app/lib/paypalClient";
import { createSlidingWindowLimiter, ipKey } from "@/app/lib/rateLimit";

export const runtime = "nodejs";

// Module scope, like isPaypalOrderLimited in ../order/route.ts — a limiter
// created per-request would start from an empty map every time and never
// actually limit anything.
const isPaypalCaptureLimited = createSlidingWindowLimiter(10 * 60_000, 10);

// POST /api/billing/paypal/capture { orderId } → { ok: true }
//
// createPaypalOrder mints an order with intent:"CAPTURE", but approving it in
// the browser does NOT capture it — PayPal requires a separate, credentialed
// call. `onApprove` on the client posts here, and this route makes that call
// server-side (the credentials stay on our side, so a failed capture is
// something we can see and log rather than something that dies in a tab).
//
// This route writes NOTHING to the database. No status flip, no grant, no
// celebration, no payment_events row. The webhook
// (app/api/billing/paypal/webhook/route.ts) is the ONLY writer of PayPal
// payment state — this route's only job is to tell PayPal to take the money
// the order route already promised; the webhook records the tip once PayPal
// confirms it. Pinned by captureRoute.test.ts's source scan (no pool.query,
// no INSERT, no UPDATE, no broadcastChatEvent).
export async function POST(req: NextRequest) {
  if (!paypalConfigured()) return new Response("Billing not configured", { status: 503 });

  const body = await req.json().catch(() => null);
  const orderId = typeof body?.orderId === "string" ? body.orderId : "";
  // 17 uppercase-alnum characters — the shape of real PayPal order ids.
  // Reject anything else before it costs rate-limit budget or a call to PayPal.
  if (!/^[A-Z0-9]{17}$/.test(orderId)) return new Response("Bad order id", { status: 400 });

  const session = await auth();
  const matrixId = session?.user?.id ?? null;

  // Same throttle shape as the order route: guests are accepted, keyed on
  // the signed-in user else the client IP.
  if (isPaypalCaptureLimited(matrixId ?? ipKey(req))) {
    return new Response("Too many attempts — try again in a few minutes.", { status: 429 });
  }

  try {
    await capturePaypalOrder(orderId);
  } catch {
    // Never the caught error's message, and never the response body
    // capturePaypalOrder read — both can carry payer fields. Only the order
    // id, which is ours.
    console.error("[paypal] capture failed for order %s", orderId);
    return new Response("Couldn't complete the tip.", { status: 502 });
  }

  return Response.json({ ok: true });
}
