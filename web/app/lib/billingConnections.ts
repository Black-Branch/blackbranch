// The database connections the billing paths may hold across Stripe calls.
//
// Two paths take a connection, wait for the viewer's advisory lock and call
// Stripe while holding it: ensureStripeCustomer (stripeCustomer.ts, from the
// checkout routes) and the webhook's subscription reconciler
// (subscriptionSync.ts). During a Stripe stall each one in flight sits on a
// connection for as long as Stripe takes, and the pool (lib/db.ts) has 10. Each
// path takes a slot here BEFORE asking the pool for a connection and gives it
// back in the same `finally`.
//
// TWO budgets, not one, because the two paths sit on opposite sides of a trust
// boundary. Anyone signed in can drive the checkout routes, so the viewer-facing
// budget can be filled by one account pressing checkout. Only Stripe drives the
// webhook. Were they one budget, that account could keep the webhook refused,
// and every refusal is a 500 that Stripe redelivers only after its growing
// backoff: every member's status change delayed for minutes to hours. Separate,
// neither can take the other's slots. Together they hold at most five of the
// pool's ten, leaving the rest to every other page.
//
// They bound that and nothing else: they are per process, they do not shorten a
// hold, and they rate-limit no one (the routes do that themselves).
import { createConcurrencyGate } from "./concurrencyGate.ts";

/** Viewer-driven: a viewer is waiting on the answer, and a refusal is a 503
 *  that tells them to try again, so the queue is short and the wait 3 s. */
export const checkoutConnections = createConcurrencyGate({ maxConcurrent: 3, maxQueued: 10, maxWaitMs: 3000 });

/** Reserved for Stripe's webhook. A refusal is a 500 that Stripe redelivers
 *  only after its retry backoff (minutes, growing), which delays a membership
 *  change far longer than a few more seconds in the queue, so the queue is long
 *  and the wait 8 s. Queued calls hold no connection, only a place in line. */
export const webhookConnections = createConcurrencyGate({ maxConcurrent: 2, maxQueued: 50, maxWaitMs: 8000 });
