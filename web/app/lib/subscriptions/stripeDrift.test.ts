// A Stripe record must never keep entitling because the reconciler's listing stopped reaching it
// (security review of S1, "fail-open entitlement state drift"; spec §4.3, §6).
//
// The reconciler lists every subscription of every customer it knows for the viewer. A customer
// Stripe has DELETED answers resource_missing to that listing and is dropped from it, and its
// subscriptions with it. Before the fix, a record of such a subscription was then never observed
// again: it stayed `active` and the fragment kept the viewer a Supporter, while the legacy row (from
// the subscriptions still listed) correctly said cancelled. Now the subscription the event names and
// every Stripe record the viewer holds are re-read from Stripe under the lock; one Stripe no longer
// has at all ends. Named for the restart and retry cases too.
// Locally: SQL_PARSE_DATABASE_URL=… node --test app/lib/subscriptions/stripeDrift.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import Stripe from "stripe";

const PRICE = "price_test_supporter";
process.env.STRIPE_PRICE_SUPPORTER = PRICE;
const { createSubscriptionSync } = await import("../subscriptionSync.ts");
const { entitlementOf } = await import("./entitlement.ts");

const DB_URL = process.env.SQL_PARSE_DATABASE_URL || "";
const unsafe = !DB_URL || DB_URL === process.env.DATABASE_URL || !/@(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(DB_URL);
const skip = unsafe ? (process.env.CI ? false : "SQL_PARSE_DATABASE_URL unset or unsafe") : false;

const RUN = `subdrift${process.pid}x${Date.now().toString(36)}`;
const T = 1_800_000_000;
let seq = 0;

const missing = (what: string) => new Stripe.errors.StripeInvalidRequestError({ message: `No such ${what}`, code: "resource_missing", statusCode: 404 });

function snapshot(id: string, who: string, customer: string, status: Stripe.Subscription.Status, created: number): Stripe.Subscription {
  return {
    id, object: "subscription", status, customer, created, cancel_at_period_end: false, metadata: { matrix_id: who },
    items: { data: [{ price: { id: PRICE }, current_period_end: T + 86_400 }] },
  } as unknown as Stripe.Subscription;
}

/** Stripe as it stands: `subs` by id, `deletedCustomers` answer resource_missing to a listing,
 *  `goneSubs` answer resource_missing to a retrieve, `failing` throws any other error. */
function fakeStripe(subs: Map<string, Stripe.Subscription>, deletedCustomers: Set<string>, goneSubs = new Set<string>(), failing = new Set<string>()) {
  return {
    subscriptions: {
      retrieve: async (id: string) => {
        if (failing.has(id)) throw new Stripe.errors.StripeAPIError({ message: "stripe is down", statusCode: 500 });
        if (goneSubs.has(id) || !subs.has(id)) throw missing("subscription");
        return structuredClone(subs.get(id)!);
      },
      list: async (q: { customer: string }) => {
        if (deletedCustomers.has(q.customer)) throw missing("customer");
        return { object: "list", has_more: false, data: [...subs.values()].filter((x) => x.customer === q.customer).map((x) => structuredClone(x)) };
      },
    },
    customers: { retrieve: async () => { throw new Error("customers.retrieve not expected"); } },
  } as unknown as Stripe;
}

test("a Stripe record its listing no longer reaches is re-read and goes inactive — never fails open", { skip }, async (t) => {
  assert.ok(!unsafe, "SQL_PARSE_DATABASE_URL must point at a local throwaway database in CI");
  const pool = new Pool({ connectionString: DB_URL, max: 4 });
  const clean = async () => {
    await pool.query(`DELETE FROM site.subscriptions WHERE matrix_id LIKE $1`, [`@${RUN}%`]);
    await pool.query(`DELETE FROM site.stripe_customers WHERE matrix_id LIKE $1`, [`@${RUN}%`]);
    await pool.query(`DELETE FROM site.users WHERE matrix_id LIKE $1`, [`@${RUN}%`]);
  };
  await clean();
  t.after(async () => { await clean(); await pool.end(); });

  /** A viewer with A (live, on customer cA) and B (cancelled, on customer cB), both recorded. Then
   *  Stripe deletes cA, which cancels A — and cA's listing now answers resource_missing. */
  const setup = async () => {
    const who = `@${RUN}-${++seq}:site.test`;
    const cA = `cus_${RUN}_${seq}_a`, cB = `cus_${RUN}_${seq}_b`, a = `sub_${RUN}_${seq}_a`, b = `sub_${RUN}_${seq}_b`;
    await pool.query(`INSERT INTO site.users (matrix_id) VALUES ($1)`, [who]);
    await pool.query(`INSERT INTO site.stripe_customers (stripe_customer_id, matrix_id) VALUES ($1, $3), ($2, $3)`, [cA, cB, who]);
    const subs = new Map([[a, snapshot(a, who, cA, "active", T - 100)], [b, snapshot(b, who, cB, "canceled", T - 50)]]);
    const deleted = new Set<string>();
    const sync = createSubscriptionSync({ pool, stripe: () => fakeStripe(subs, deleted) });
    await sync.syncSubscription({ id: a }, T);
    assert.equal((await status(a)), "active", "setup: A recorded active");
    assert.equal((await entitlementOf(pool, who, ["stripe"])).supporter, true);
    // Stripe deletes customer cA: A is cancelled with it, and the listing no longer reaches it.
    subs.set(a, snapshot(a, who, cA, "canceled", T - 100));
    deleted.add(cA);
    return { who, a, b, cA, subs, deleted };
  };
  const status = async (id: string) =>
    (await pool.query(`SELECT status FROM site.subscription_records WHERE provider = 'stripe' AND external_id = $1`, [id])).rows[0]?.status;
  const legacyStatus = async (who: string) =>
    (await pool.query(`SELECT status FROM site.subscriptions WHERE matrix_id = $1`, [who])).rows[0]?.status;

  await t.test("the event names the unreachable subscription: its record ends", async () => {
    const { who, a, subs, deleted } = await setup();
    await createSubscriptionSync({ pool, stripe: () => fakeStripe(subs, deleted) }).syncSubscription({ id: a }, T + 10);
    assert.equal(await status(a), "ended");
    assert.equal(await legacyStatus(who), "canceled");
    assert.equal((await entitlementOf(pool, who, ["stripe"])).supporter, false, "records and legacy row agree: not a Supporter");
  });

  await t.test("the event names ANOTHER subscription: the held record is still re-read and ends", async () => {
    const { who, a, b, subs, deleted } = await setup();
    await createSubscriptionSync({ pool, stripe: () => fakeStripe(subs, deleted) }).syncSubscription({ id: b }, T + 10);
    assert.equal(await status(a), "ended", "a record left out of the observation would have stayed active");
    assert.equal((await entitlementOf(pool, who, ["stripe"])).supporter, false);
  });

  await t.test("a subscription Stripe no longer has at all ends as 'missing'", async () => {
    const { who, a, b, subs, deleted } = await setup();
    await createSubscriptionSync({ pool, stripe: () => fakeStripe(subs, deleted, new Set([a])) }).syncSubscription({ id: b }, T + 10);
    const r = (await pool.query(`SELECT status, provider_status FROM site.subscription_records WHERE external_id = $1`, [a])).rows[0];
    assert.deepEqual(r, { status: "ended", provider_status: "missing" });
    assert.equal((await entitlementOf(pool, who, ["stripe"])).supporter, false);
  });

  await t.test("any other Stripe error on the re-read throws and writes nothing (Stripe redelivers)", async () => {
    const { a, b, subs, deleted } = await setup();
    const sync = createSubscriptionSync({ pool, stripe: () => fakeStripe(subs, deleted, new Set(), new Set([a])) });
    await assert.rejects(sync.syncSubscription({ id: b }, T + 10), { type: "StripeAPIError" });
    assert.equal(await status(a), "active", "rolled back, not half-written — the retry will end it");
    // The retry, once Stripe answers, ends it.
    await createSubscriptionSync({ pool, stripe: () => fakeStripe(subs, deleted) }).syncSubscription({ id: b }, T + 10);
    assert.equal(await status(a), "ended");
  });

  await t.test("retry: the same event twice leaves it ended, one record each", async () => {
    const { who, a, b, subs, deleted } = await setup();
    const sync = createSubscriptionSync({ pool, stripe: () => fakeStripe(subs, deleted) });
    await sync.syncSubscription({ id: a }, T + 10);
    await sync.syncSubscription({ id: a }, T + 10);
    assert.equal(await status(a), "ended");
    const n = (await pool.query(`SELECT count(*)::int AS n FROM site.subscription_records WHERE matrix_id = $1`, [who])).rows[0].n;
    assert.equal(n, 2, `records: ${a}, ${b}`);
  });

  await t.test("restart: a new process (new pool, new reconciler) replaying the event keeps it ended", async () => {
    const { who, a, subs, deleted } = await setup();
    await createSubscriptionSync({ pool, stripe: () => fakeStripe(subs, deleted) }).syncSubscription({ id: a }, T + 10);
    const pool2 = new Pool({ connectionString: DB_URL, max: 2 });
    try {
      await createSubscriptionSync({ pool: pool2, stripe: () => fakeStripe(subs, deleted) }).syncSubscription({ id: a }, T + 10);
    } finally {
      await pool2.end();
    }
    assert.equal(await status(a), "ended");
    assert.equal((await entitlementOf(pool, who, ["stripe"])).supporter, false);
  });
});
