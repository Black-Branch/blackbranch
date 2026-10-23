// The Stripe adapter behind the billing webhook: it resolves the viewer, reads
// every Stripe subscription they hold under their lock, and hands them to the
// ONE writer of subscription state, subscriptions/state.ts writeTransition
// (subscription sources S1, decision D2), in the same transaction as the legacy
// one-row-per-viewer mirror below (site.subscriptions — kept, and written by the
// rule it was always written by, until S1b drops it).
//
// ONE caller: app/api/billing/webhook/route.ts, after Stripe's signature check —
// a provider-verified path. Pinned to that one importer by
// subStatusWiring.test.ts ("2b"); lifted out of the route so a test can drive it
// against a real database (subscriptionSync.test.ts). Injectable-pool factory,
// the same shape and reason as paymentEventHandlers.ts.
import type { Pool, PoolClient } from "pg";
import type Stripe from "stripe";
import pool from "../../lib/db.ts";
import { getStripe } from "./stripe.ts";
import { tierByPriceId, type Tier } from "./tiers.ts";
import { isMissingCustomer } from "./stripeCustomer.ts";
import type { createConcurrencyGate } from "./concurrencyGate.ts";
import { webhookConnections } from "./billingConnections.ts";
import { heldRecordIds, writeTransition } from "./subscriptions/state.ts";
import { missingStripeObservation, needsPaymentHistory, settleNeverPaid, stripeObservation, stripeRenewalOff } from "./subscriptions/stripeRecords.ts";

export type SubscriptionWrite = {
  matrixId: string;
  /** The subscription state that was written. */
  sub: Stripe.Subscription;
  tier: Tier | null;
  effectiveTier: Tier["slug"] | null;
};

const customerIdOf = (s: Stripe.Subscription) => (typeof s.customer === "string" ? s.customer : s.customer.id);

const ENTITLING = new Set<Stripe.Subscription.Status>(["active", "trialing", "past_due"]);

/** The subscription a viewer's row should show: an entitling one (newest wins),
 *  else the newest of the rest, so an all-cancelled customer reads cancelled. */
function countsForViewer(subs: Stripe.Subscription[]): Stripe.Subscription | null {
  const newest = (xs: Stripe.Subscription[]) =>
    xs.reduce<Stripe.Subscription | null>((best, x) => (!best || x.created > best.created ? x : best), null);
  return newest(subs.filter((x) => ENTITLING.has(x.status))) ?? newest(subs);
}

/** @parked consumed by the production binding below and by
 *  subscriptionSync.test.ts; exported so the test can drive a real throwaway
 *  pool and a fake Stripe getter. */
export function createSubscriptionSync(deps: {
  pool: Pool;
  stripe: () => Stripe;
  gate?: ReturnType<typeof createConcurrencyGate>;
}) {
  // The webhook's reserved connection budget (billingConnections.ts); a test
  // passes its own.
  const gate = deps.gate ?? webhookConnections;

  // Resolve our user for a subscription: subscription metadata → customer
  // metadata → the recorded customers → the stored mapping. Shared by the state
  // sync and the renewal path, and the moment a customer becomes known: the
  // customer is recorded in site.stripe_customers for the viewer it resolved
  // to, so an old duplicate customer is remembered as soon as any of its events
  // (a renewal, say) arrives. A failed read or write throws (the webhook answers
  // 500 and Stripe retries): reading it as "no viewer" would drop the event for good.
  async function resolveMatrixId(sub: Stripe.Subscription, customerId: string): Promise<string | null> {
    let matrixId = sub.metadata?.matrix_id ?? null;
    if (!matrixId) {
      const customer = await deps.stripe().customers.retrieve(customerId);
      if (!customer.deleted) matrixId = customer.metadata?.matrix_id ?? null;
    }
    if (!matrixId) {
      const r = await deps.pool.query<{ matrix_id: string }>(
        `SELECT matrix_id FROM site.stripe_customers WHERE stripe_customer_id = $1
         UNION ALL
         SELECT matrix_id FROM site.subscriptions WHERE stripe_customer_id = $1
         LIMIT 1`,
        [customerId]
      );
      matrixId = r.rows[0]?.matrix_id ?? null;
    }
    if (matrixId) {
      await deps.pool.query(
        `INSERT INTO site.stripe_customers (stripe_customer_id, matrix_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [customerId, matrixId]
      );
    }
    return matrixId;
  }

  /** Every subscription a viewer holds, across every customer they have had:
   *  the one the event names, the one stored on the viewer's row, and each one
   *  recorded in site.stripe_customers. A viewer given a second customer can
   *  hold live subscriptions on both, so the row cannot be decided from any one
   *  customer. A customer Stripe no longer holds has nothing to add and is
   *  dropped from the record; any other Stripe error throws. */
  async function viewerSubscriptions(client: PoolClient, matrixId: string, eventCustomer: string): Promise<Stripe.Subscription[]> {
    const known = await client.query<{ id: string }>(
      `SELECT stripe_customer_id AS id FROM site.subscriptions WHERE matrix_id = $1 AND stripe_customer_id IS NOT NULL
       UNION
       SELECT stripe_customer_id FROM site.stripe_customers WHERE matrix_id = $1`,
      [matrixId]
    );
    const customers = [...new Set([eventCustomer, ...known.rows.map((r) => r.id)])];
    const all: Stripe.Subscription[] = [];
    for (const customer of customers) {
      try {
        all.push(...(await deps.stripe().subscriptions.list({ customer, status: "all", limit: 100 })).data);
      } catch (e) {
        if (!isMissingCustomer(e)) throw e;
        await client.query(`DELETE FROM site.stripe_customers WHERE stripe_customer_id = $1`, [customer]);
      }
    }
    return all;
  }

  /** A subscription as it counts here: a past_due one that came out of a trial and was never paid
   *  reads as `incomplete` (stripeRecords.ts settleNeverPaid). Its paid invoices are asked of Stripe
   *  only in that case; a failed lookup throws, so the webhook answers 500 and Stripe redelivers —
   *  never a guess either way. */
  async function settle(sub: Stripe.Subscription): Promise<Stripe.Subscription> {
    if (!needsPaymentHistory(sub)) return sub;
    const paid = await deps.stripe().invoices.list({ subscription: sub.id, status: "paid", limit: 100 });
    return settleNeverPaid(sub, paid.data.map((i) => i.amount_paid));
  }

  /** Mirror a subscription's viewer into their row. `eventAt` is the Stripe
   *  Event's `created` (unix seconds). Returns what was written, or null when
   *  nothing was (no viewer for it, or a stale event).
   *
   *  The event's own snapshot is NOT what gets written (external review S3).
   *  Stripe does not deliver events in order and `created` has one-second
   *  resolution, so no comparison of stamps can tell which of two same-second
   *  events is newer. Instead, every event for a VIEWER is processed one at a
   *  time (a transaction-scoped advisory lock on the viewer) and writes the
   *  subscription that counts for the viewer as Stripe holds it NOW, read under
   *  that lock: whichever delivery runs last reads the latest state.
   *
   *  The lock and the read are per viewer because the row is per viewer: the
   *  lock's key is the key of the row being written. On a plan switch the old
   *  subscription's cancellation and the new one's creation share a second, and
   *  writing whichever event's own subscription ran last would let the old
   *  cancellation overwrite the new active one. The same holds across two
   *  customers of one viewer: a lock and a read per customer would let the old
   *  customer's cancellation, which lists only the old customer, overwrite the
   *  new customer's membership. Every event that writes this row takes this one
   *  lock, so it also serialises each customer's events.
   *
   *  Lock order: `billing:viewer:<matrixId>` is taken first; the transition
   *  function then takes each `billing:record:…` lock, in sorted order, AFTER
   *  it. ensureStripeCustomer (stripeCustomer.ts) takes the viewer lock and
   *  nothing else, so no holder waits on a viewer while holding a record and
   *  none of them can deadlock.
   *
   *  The viewer is resolved before the lock: it comes from the subscription's
   *  or customer's metadata, or the stored mapping, none of which an event
   *  being processed changes. A failed read throws, so the webhook answers 500
   *  and Stripe retries.
   *
   *  The connection is held from the lock to the write, with the Stripe reads
   *  in between: the first Stripe read and the viewer's resolution happen
   *  before any connection is taken. Holders are bounded by the webhook's own
   *  connection budget (billingConnections.ts), which no viewer-driven path
   *  draws on, taken BEFORE the pool is asked
   *  and given back in the same `finally`, so events piling up for one viewer
   *  (each waiting on the lock) or a Stripe stall cannot take the pool. A call
   *  the budget refuses throws, holding nothing; the webhook answers 500 and
   *  Stripe redelivers. */
  async function syncSubscription(ref: Pick<Stripe.Subscription, "id">, eventAt: number): Promise<SubscriptionWrite | null> {
    const named = await deps.stripe().subscriptions.retrieve(ref.id);
    const eventCustomer = customerIdOf(named);
    const matrixId = await resolveMatrixId(named, eventCustomer);
    if (!matrixId) {
      console.error("[billing] no matrix_id for subscription", named.id);
      return null;
    }
    const release = await gate.acquire();
    if (!release) throw new Error("billing connection budget full; Stripe will redeliver this event");
    let client: PoolClient | null = null;
    try {
      client = await deps.pool.connect();
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`billing:viewer:${matrixId}`]);
      const all = await Promise.all((await viewerSubscriptions(client, matrixId, eventCustomer)).map(settle));
      const sub = countsForViewer(all) ?? (await settle(await deps.stripe().subscriptions.retrieve(ref.id)));
      // Every subscription the viewer holds becomes its own record, each stamped with this
      // Event's `created` — the one writer, in this transaction, under this lock. Then the
      // legacy row, from the subscription that counts, exactly as before.
      const observed = all.some((x) => x.id === sub.id) ? all : [...all, sub];
      const stamp = new Date(eventAt * 1000);
      const observations = observed.map((x) => stripeObservation(x, stamp));
      // Fail closed: the subscription this event names, and every Stripe record the viewer already
      // holds, are observed too, read from Stripe under this lock — even when no listed customer
      // reaches them any more (a customer Stripe deleted is dropped from the listing above, and its
      // subscriptions with it). Left out, such a record would keep its last state, entitling, for
      // ever. One that Stripe no longer has at all ends.
      const seen = new Set(observed.map((x) => x.id));
      for (const id of new Set([ref.id, ...(await heldRecordIds(client, matrixId, "stripe"))])) {
        if (seen.has(id)) continue;
        try {
          observations.push(stripeObservation(await settle(await deps.stripe().subscriptions.retrieve(id)), stamp));
        } catch (e) {
          if (!isMissingCustomer(e)) throw e; // the same resource_missing test, for a subscription
          observations.push(missingStripeObservation(id, stamp));
        }
      }
      await writeTransition(client, { via: "webhook", viewer: matrixId, observations });
      const r = await writeState(client, matrixId, sub, eventAt);
      await client.query("COMMIT");
      return r;
    } catch (e) {
      if (client) await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client?.release();
      release();
    }
  }

  /** Write the subscription that counts. The row's customer becomes the one
   *  holding that subscription, so the next checkout reuses the customer the
   *  viewer's membership actually lives on. */
  async function writeState(client: PoolClient, matrixId: string, sub: Stripe.Subscription, eventAt: number): Promise<SubscriptionWrite | null> {
    const customerId = customerIdOf(sub);

    const priceId = sub.items.data[0]?.price?.id ?? null;
    const tier = tierByPriceId(priceId);
    const ended = sub.status === "canceled" || sub.status === "incomplete_expired";

    // current_period_end moved from the Subscription to its items across recent
    // API versions — read defensively so we work regardless of pinned version.
    const cpe =
      (sub.items.data[0] as { current_period_end?: number } | undefined)?.current_period_end ??
      (sub as unknown as { current_period_end?: number }).current_period_end;
    const periodEnd = cpe ? new Date(cpe * 1000) : null;

    const effectiveTier = ended ? null : tier?.slug ?? null;

    // The recency gate still drops a strictly OLDER event: the row is per viewer,
    // not per subscription, so an old subscription's late event must not
    // overwrite a newer subscription's state. An equal stamp passes — the state
    // being written was read from Stripe under the lock, so it is never older
    // than what the last writer wrote. `sub.created` cannot order events (it is
    // the same on all of them); the Event's `created` is threaded in. COALESCE
    // keeps rows written before this column existed upgradeable.
    const stamp = new Date(eventAt * 1000);

    const wrote = await client.query(
      `INSERT INTO site.subscriptions
         (matrix_id, stripe_customer_id, stripe_sub_id, tier, status, current_period_end, cancel_at_period_end, updated_at, stripe_event_at)
       VALUES ($1, $2, $3, $4, $5, $6, $8, NOW(), $7)
       ON CONFLICT (matrix_id) DO UPDATE SET
         stripe_customer_id = EXCLUDED.stripe_customer_id,
         stripe_sub_id      = EXCLUDED.stripe_sub_id,
         tier               = EXCLUDED.tier,
         status             = EXCLUDED.status,
         current_period_end = EXCLUDED.current_period_end,
         cancel_at_period_end = EXCLUDED.cancel_at_period_end,
         updated_at         = NOW(),
         stripe_event_at    = EXCLUDED.stripe_event_at
       WHERE COALESCE(site.subscriptions.stripe_event_at, 'epoch'::timestamptz) <= EXCLUDED.stripe_event_at
       RETURNING matrix_id`,
      // cancel_at_period_end: the viewer switched renewal off in the portal.
      // Stripe keeps status 'active' until the period ends, so this flag is the
      // only way the Support panel can say "renewal is off". Stripe's either
      // field (cancel_at_period_end, or the newer portal's cancel_at) — stripeRenewalOff.
      [matrixId, customerId, sub.id, effectiveTier, sub.status, periodEnd, stamp, stripeRenewalOff(sub)]
    );

    // Stale event — a newer one already wrote this row.
    if ((wrote.rowCount ?? 0) === 0) {
      console.warn(
        "[billing] dropped out-of-order subscription event for %s (sub=%s status=%s stamp=%s)",
        matrixId, sub.id, sub.status, stamp.toISOString()
      );
      return null;
    }
    return { matrixId, sub, tier, effectiveTier };
  }

  return { resolveMatrixId, syncSubscription };
}

// `stripe: getStripe` passes the FUNCTION, never calls it — importing this
// module must never throw on a missing key (same rule as paymentEventHandlers.ts).
const bound = createSubscriptionSync({ pool, stripe: getStripe });
export const resolveMatrixId = bound.resolveMatrixId;
export const syncSubscriptionState = bound.syncSubscription;
