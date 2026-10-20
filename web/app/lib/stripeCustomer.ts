// The viewer → Stripe customer mapping: ONE customer per viewer.
//
// The current mapping lives in site.subscriptions.stripe_customer_id (that table
// doubles as our customer table); every customer ever created for a viewer is
// also recorded in site.stripe_customers, so the webhook can reconcile across
// all of them. This module may write that column, updated_at, and the
// stripe_customers record, and nothing else: tier and status transitions belong
// to the billing webhook (subscriptionSync.ts), which also moves the column when
// a viewer's counting subscription sits on another customer.
//
// Injectable-pool factory, the same shape and reason as subscriptionSync.ts: the
// lock is SQL, so stripeCustomer.test.ts drives it against a real database.
import type { Pool, PoolClient } from "pg";
import type Stripe from "stripe";
import pool from "../../lib/db.ts";
import { getStripe } from "./stripe.ts";
import type { createConcurrencyGate } from "./concurrencyGate.ts";
import { checkoutConnections } from "./billingConnections.ts";

/** Refused by the gate: the caller answers 503, not 500. */
class StripeCustomerBusyError extends Error {
  constructor() {
    super("too many Stripe customer lookups in flight");
    this.name = "StripeCustomerBusyError";
  }
}

/** Stripe's answer for a customer id it does not hold. Every other error — a
 *  429, a dropped connection, a bad key — says nothing about whether the
 *  customer exists, so it must not be read as "gone". */
export function isMissingCustomer(e: unknown): boolean {
  const err = e as { type?: string; code?: string } | null;
  return err?.type === "StripeInvalidRequestError" && err.code === "resource_missing";
}

/** @parked consumed by the production binding below and by
 *  stripeCustomer.test.ts; exported so the test can drive a real throwaway pool
 *  and a fake Stripe getter. */
export function createStripeCustomers(deps: {
  pool: Pool;
  stripe: () => Stripe;
  gate?: ReturnType<typeof createConcurrencyGate>;
}) {
  // The viewer-driven connection budget (billingConnections.ts); a test
  // passes its own.
  const gate = deps.gate ?? checkoutConnections;

  /** Return the viewer's live Stripe customer, creating one only when the viewer
   *  has none or Stripe says the stored one is gone (resource_missing, or a
   *  deleted customer). Any other failure, from the database or from Stripe,
   *  throws: the caller answers 5xx and the viewer retries, instead of a second
   *  customer being minted and the first one's subscriptions orphaned.
   *
   *  Serialised per viewer by a transaction-scoped advisory lock, the row read
   *  and the mapping written under it, so two simultaneous first checkouts make
   *  one customer: the second waits, then reads the first one's row.
   *
   *  Lock order: this takes `billing:viewer:<matrixId>` and nothing else. The
   *  webhook's reconciler takes the same key and also nothing else, so no two
   *  holders can each wait on the other. Anything that ever needs a second
   *  billing lock takes the viewer lock FIRST.
   *
   *  The Stripe calls run while the lock is held, so the transaction is open
   *  across them; the client's own bound (15 s, one retry) bounds that, and
   *  the viewer-driven connection budget (billingConnections.ts) bounds how many
   *  connections are held so. Those calls keep
   *  the client's retry rather than passing a shorter per-request bound: the
   *  budget already caps the pool a stall can take, the retry turns a transient
   *  blip into a checkout that works instead of a 5xx, and on the create the
   *  SDK resends with its own idempotency key, so a retry cannot mint a second
   *  customer, where a viewer retrying the whole checkout would.
   *
   *  Throws StripeCustomerBusyError, holding nothing, when the gate refuses. */
  async function ensureStripeCustomer(matrixId: string): Promise<string> {
    const stripe = deps.stripe();
    // The gate is taken BEFORE the connection: a refused call never touches the pool.
    const release = await gate.acquire();
    if (!release) throw new StripeCustomerBusyError();
    let client: PoolClient | null = null;
    try {
      client = await deps.pool.connect();
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`billing:viewer:${matrixId}`]);
      const stored = await client.query<{ stripe_customer_id: string | null }>(
        `SELECT stripe_customer_id FROM site.subscriptions WHERE matrix_id = $1`,
        [matrixId]
      );
      const storedId = stored.rows[0]?.stripe_customer_id ?? null;

      if (storedId) {
        let gone = false;
        try {
          const existing = await stripe.customers.retrieve(storedId);
          gone = Boolean((existing as { deleted?: boolean }).deleted);
        } catch (e) {
          if (!isMissingCustomer(e)) throw e;
          gone = true;
        }
        if (!gone) {
          await client.query("COMMIT");
          return storedId;
        }
      }

      const user = await client.query<{ email: string | null; display_name: string | null }>(
        `SELECT email, display_name FROM site.users WHERE matrix_id = $1`,
        [matrixId]
      );
      const customer = await stripe.customers.create({
        email: user.rows[0]?.email ?? undefined,
        name: user.rows[0]?.display_name ?? undefined,
        metadata: { matrix_id: matrixId },
      });
      await client.query(
        `INSERT INTO site.subscriptions (matrix_id, stripe_customer_id, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (matrix_id) DO UPDATE
           SET stripe_customer_id = EXCLUDED.stripe_customer_id, updated_at = NOW()`,
        [matrixId, customer.id]
      );
      await client.query(
        `INSERT INTO site.stripe_customers (stripe_customer_id, matrix_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [customer.id, matrixId]
      );
      await client.query("COMMIT");
      return customer.id;
    } catch (e) {
      if (client) await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client?.release();
      release();
    }
  }

  /** The routes' form: the customer id, or a 503 to return as is when the gate
   *  is full. Every other failure still throws. */
  async function ensureStripeCustomerOrBusy(matrixId: string): Promise<string | Response> {
    try {
      return await ensureStripeCustomer(matrixId);
    } catch (e) {
      if (!(e instanceof StripeCustomerBusyError)) throw e;
      return new Response("Checkout is busy — try again in a few seconds.", { status: 503, headers: { "Retry-After": "5" } });
    }
  }

  return { ensureStripeCustomer, ensureStripeCustomerOrBusy };
}

// `stripe: getStripe` passes the FUNCTION, never calls it — importing this
// module must never throw on a missing key (same rule as subscriptionSync.ts).
export const ensureStripeCustomerOrBusy = createStripeCustomers({ pool, stripe: getStripe }).ensureStripeCustomerOrBusy;
