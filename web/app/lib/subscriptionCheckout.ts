// One subscription checkout per viewer: the duplicate check and the Checkout Session's creation,
// under the viewer's billing lock.
//
// Stripe lets one customer hold several subscriptions, and a viewer can hold more than one customer
// (subscriptionSync.ts reconciles across them). So "already subscribed" is asked of EVERY customer
// the viewer has, of Stripe (not our mirror — the webhook is asynchronous), counting every status
// that still bills or can resume billing. And two starts at once (two tabs, a double click) would
// both pass that check while no subscription exists yet, so the check and the creation run under
// `billing:viewer:<id>`, and an older OPEN subscription session of the viewer is expired before a
// new one is made: at most one can be paid.
//
// Lock order: the viewer lock and nothing else, like ensureStripeCustomer (stripeCustomer.ts), which
// the route calls BEFORE this (it takes the same key in its own transaction; calling it inside this
// one would wait on itself).
//
// Injectable-pool factory, the same shape and reason as stripeCustomer.ts: the lock is SQL, so
// subscriptionCheckout.test.ts drives it against a real database.
import type { Pool, PoolClient } from "pg";
import type Stripe from "stripe";
import pool from "../../lib/db.ts";
import { getStripe } from "./stripe.ts";
import type { createConcurrencyGate } from "./concurrencyGate.ts";
import { checkoutConnections } from "./billingConnections.ts";
import { isMissingCustomer } from "./stripeCustomer.ts";

/** Every Stripe status of a subscription that bills, will bill, or can resume billing. */
const LIVE: readonly Stripe.Subscription.Status[] = ["active", "trialing", "past_due", "unpaid", "incomplete", "paused"];

type Outcome =
  | { kind: "session"; session: Stripe.Checkout.Session }
  | { kind: "live"; status: Stripe.Subscription.Status }
  | { kind: "busy" };

/** @parked consumed by the production binding below and by subscriptionCheckout.test.ts; exported
 *  so the test can drive a real throwaway pool and a fake Stripe getter. */
export function createSubscriptionCheckout(deps: {
  pool: Pool;
  stripe: () => Stripe;
  gate?: ReturnType<typeof createConcurrencyGate>;
}) {
  const gate = deps.gate ?? checkoutConnections;

  /** `customerId` is the one ensureStripeCustomer returned; `create` makes the session on it.
   *  A failed Stripe or database read throws (the route answers 503): never a guess either way. */
  async function openSubscriptionCheckout(
    matrixId: string,
    customerId: string,
    create: () => Promise<Stripe.Checkout.Session>
  ): Promise<Outcome> {
    const stripe = deps.stripe();
    const release = await gate.acquire();
    if (!release) return { kind: "busy" };
    let client: PoolClient | null = null;
    try {
      client = await deps.pool.connect();
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`billing:viewer:${matrixId}`]);
      const known = await client.query<{ id: string }>(
        `SELECT stripe_customer_id AS id FROM site.subscriptions WHERE matrix_id = $1 AND stripe_customer_id IS NOT NULL
         UNION
         SELECT stripe_customer_id FROM site.stripe_customers WHERE matrix_id = $1`,
        [matrixId]
      );
      const customers = [...new Set([customerId, ...known.rows.map((r) => r.id)])];
      for (const customer of customers) {
        let subs: Stripe.Subscription[];
        try {
          subs = (await stripe.subscriptions.list({ customer, status: "all", limit: 100 })).data;
        } catch (e) {
          if (isMissingCustomer(e)) continue; // a customer Stripe no longer holds has nothing live
          throw e;
        }
        const live = subs.find((s) => LIVE.includes(s.status));
        if (live) {
          await client.query("COMMIT");
          return { kind: "live", status: live.status };
        }
      }
      for (const customer of customers) {
        let open: Stripe.Checkout.Session[];
        try {
          open = (await stripe.checkout.sessions.list({ customer, status: "open", limit: 100 })).data;
        } catch (e) {
          if (isMissingCustomer(e)) continue;
          throw e;
        }
        // An expire that fails (the session was completed a moment ago) throws: the viewer retries
        // and the subscription it made is then found above.
        for (const s of open) if (s.mode === "subscription") await stripe.checkout.sessions.expire(s.id);
      }
      const session = await create();
      await client.query("COMMIT");
      return { kind: "session", session };
    } catch (e) {
      if (client) await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client?.release();
      release();
    }
  }

  return { openSubscriptionCheckout };
}

// `stripe: getStripe` passes the FUNCTION, never calls it — importing this module must never throw
// on a missing key (same rule as stripeCustomer.ts).
export const openSubscriptionCheckout = createSubscriptionCheckout({ pool, stripe: getStripe }).openSubscriptionCheckout;
