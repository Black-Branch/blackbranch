// The invisible half of the webhook: what route.ts branches on, extractable
// as plain text so ops/stripe-webhook-events.mjs (dependency-free Node,
// cannot import TypeScript) can regex it and diff against the live Stripe
// endpoint. An endpoint subscribed to fewer events than the route branches on
// fails silently, and nothing else in the repo can catch it.

/** @test-only stripeWebhookEvents.test.ts pins this list against route.ts's
 *  case strings; ops/stripe-webhook-events.mjs reads this file as TEXT by
 *  regex (dependency-free Node cannot import TypeScript), so nothing imports
 *  it in production and nothing should. */
export const HANDLED_EVENTS = [
  "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted",
  "invoice.paid", "checkout.session.completed", "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "payment_intent.payment_failed", "refund.created", "refund.updated",
  "charge.dispute.created", "charge.dispute.closed", "invoice.payment_failed",
] as const;
