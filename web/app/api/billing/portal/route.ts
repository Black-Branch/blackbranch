import pool from "@/lib/db";
import { requireUser } from "@/app/lib/authGuard";
import { getStripe, stripeConfigured, publicOrigin } from "@/app/lib/stripe";
import { NextRequest } from "next/server";
import { isPortalNotSetUp, PORTAL_NOT_SET_UP } from "@/app/lib/stripePortal";

export const runtime = "nodejs";

// POST /api/billing/portal → { url }
// Opens the Stripe Billing Portal so the user can update payment method, view
// invoices, or cancel. Requires an existing Stripe customer (from a prior
// checkout). Cancellations flow back to us via the subscription webhook.
export async function POST(req: NextRequest) {
  if (!stripeConfigured()) return new Response("Billing not configured", { status: 503 });

  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;

  const subRow = await pool
    .query(`SELECT stripe_customer_id FROM site.subscriptions WHERE matrix_id = $1`, [matrixId])
    .catch(() => ({ rows: [] as { stripe_customer_id: string | null }[] }));
  const customerId = subRow.rows[0]?.stripe_customer_id;
  if (!customerId) return new Response("No customer", { status: 404 });

  let portal: { url: string };
  try {
    portal = await getStripe().billingPortal.sessions.create({
      customer: customerId,
      return_url: `${publicOrigin(req.nextUrl.origin)}/`,
    });
  } catch (e) {
    // The streamer never saved Stripe's customer portal: the one in-site way to cancel is dead
    // until they do, so say exactly where, and tell the viewer it is the site's to fix.
    if (isPortalNotSetUp(e)) {
      console.error("[billing] portal: Stripe's customer portal was never saved — Stripe → Settings → Billing → Customer portal → Save (in the key's mode)");
      return Response.json({ error: PORTAL_NOT_SET_UP }, { status: 409 });
    }
    const err = e as { type?: string; code?: string } | null;
    console.error("[billing] portal: Stripe refused (%s %s)", err?.type ?? "error", err?.code ?? "");
    return new Response("Billing portal unavailable", { status: 502 });
  }
  return Response.json({ url: portal.url });
}
