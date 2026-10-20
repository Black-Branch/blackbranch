import type Stripe from "stripe";
import type { PaymentRef } from "./coinsServer.ts";

// What a completed Stripe tip session is worth in Qorm (1 Qorm per USD cent),
// or null when it pays none. Pure, so the rules are tested without a webhook:
// signed-in only (anonymous still pays — it only hides the name on stream);
// paid only; and never more than the USD cents the tipper chose — Adaptive
// Pricing can settle in another currency, where amount_total is not cents
// (same guard as recordCoinPurchase).
export function tipCreditFromSession(cs: Stripe.Checkout.Session):
  { matrixId: string; cents: number; ref: string; payment: PaymentRef } | null {
  if (cs.payment_status !== "paid") return null;
  const matrixId = cs.metadata?.matrix_id || null;
  if (!matrixId) return null;
  const paymentIntent = typeof cs.payment_intent === "string" ? cs.payment_intent : cs.payment_intent?.id ?? null;
  if (!paymentIntent) return null;
  const intended = Number(cs.metadata?.amount_cents ?? 0);
  const settled = cs.amount_total ?? 0;
  const usd = (cs.currency ?? "usd").toLowerCase() === "usd";
  const cents = usd ? (intended > 0 ? Math.min(settled, intended) : settled) : intended > 0 ? intended : 0;
  if (!(cents > 0)) return null;
  return { matrixId, cents, ref: `stripe:${cs.id}`, payment: { provider: "stripe", paymentIntent } };
}
