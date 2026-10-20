import pool from "@/lib/db";
import { requireUser } from "@/app/lib/authGuard";
import { getStripe, stripeConfigured, publicOrigin } from "@/app/lib/stripe";
import { NextRequest } from "next/server";

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

  const portal = await getStripe().billingPortal.sessions.create({
    customer: customerId,
    return_url: `${publicOrigin(req.nextUrl.origin)}/`,
  });
  return Response.json({ url: portal.url });
}
