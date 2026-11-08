// One subscription checkout per viewer (A1-02, P09).
//
// The checkout route used to ask Stripe about ONE customer, with a status list that left out
// `paused`, and nothing serialised two starts. A viewer with Subscribe open in two tabs (or a
// double click after a slow load) got two Checkout Sessions while no subscription existed yet; both
// passed the "already subscribed" check, and paying in both billed them twice. So does a viewer
// whose live subscription sits on an older Stripe customer (the reconciler knows viewers can hold
// two). Now the check reads every customer the viewer has, counts `paused`, and runs with the
// session's creation under the viewer's lock; an older OPEN subscription session is expired before
// a new one is made, so at most one can be paid.
//
// The lock is SQL, so this runs against a replayed Postgres (CI sets SQL_PARSE_DATABASE_URL).
import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import Stripe from "stripe";
import { createConcurrencyGate } from "./concurrencyGate.ts";

const { createSubscriptionCheckout } = await import("./subscriptionCheckout.ts");

const DB_URL = process.env.SQL_PARSE_DATABASE_URL || "";
const unsafe = !DB_URL || DB_URL === process.env.DATABASE_URL || !/@(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(DB_URL);
const skip = unsafe ? (process.env.CI ? false : "SQL_PARSE_DATABASE_URL unset or unsafe") : false;

const RUN = `subco${process.pid}x${Date.now().toString(36)}`;
let seq = 0;

type Sess = { id: string; customer: string; mode: "subscription" | "payment"; status: "open" | "expired" | "complete" };

/** A fake Stripe holding subscriptions per customer and Checkout Sessions; `create` mints a session
 *  after `delayMs`, so two concurrent starts overlap unless something serialises them. */
function fakeStripe(subs: { customer: string; status: Stripe.Subscription.Status }[], delayMs = 40) {
  const sessions: Sess[] = [];
  let n = 0;
  const stripe = {
    subscriptions: {
      list: async (q: { customer: string; status?: string }) => {
        assert.equal(q.status, "all");
        return { object: "list", has_more: false, data: subs.filter((s) => s.customer === q.customer).map((s, i) => ({ id: `sub_${i}`, ...s })) };
      },
    },
    checkout: {
      sessions: {
        list: async (q: { customer: string; status?: string }) => ({
          object: "list", has_more: false,
          data: sessions.filter((s) => s.customer === q.customer && (!q.status || s.status === q.status)).map((s) => ({ ...s })),
        }),
        expire: async (id: string) => {
          const s = sessions.find((x) => x.id === id);
          if (!s || s.status !== "open") throw new Stripe.errors.StripeInvalidRequestError({ message: "not open", statusCode: 400 });
          s.status = "expired";
          return { ...s };
        },
      },
    },
  } as unknown as Stripe;
  const create = async (customer: string) => {
    await new Promise((r) => setTimeout(r, delayMs));
    const s: Sess = { id: `cs_${++n}`, customer, mode: "subscription", status: "open" };
    sessions.push(s);
    return { ...s, client_secret: `secret_${s.id}` } as unknown as Stripe.Checkout.Session;
  };
  return { stripe, sessions, create };
}

test("one subscription checkout per viewer", { skip }, async (t) => {
  assert.ok(!unsafe, "SQL_PARSE_DATABASE_URL must point at a local throwaway database in CI");
  const pool = new Pool({ connectionString: DB_URL, max: 6 });
  const clean = async () => {
    await pool.query(`DELETE FROM site.subscriptions WHERE matrix_id LIKE $1`, [`@${RUN}%`]);
    await pool.query(`DELETE FROM site.stripe_customers WHERE matrix_id LIKE $1`, [`@${RUN}%`]);
    await pool.query(`DELETE FROM site.users WHERE matrix_id LIKE $1`, [`@${RUN}%`]);
  };
  await clean();
  t.after(async () => { await clean(); await pool.end(); });
  const fresh = async () => {
    const who = `@${RUN}-${++seq}:site.test`;
    await pool.query(`INSERT INTO site.users (matrix_id) VALUES ($1)`, [who]);
    const cus = `cus_${RUN}_${seq}`;
    await pool.query(`INSERT INTO site.subscriptions (matrix_id, stripe_customer_id, updated_at) VALUES ($1, $2, NOW())`, [who, cus]);
    await pool.query(`INSERT INTO site.stripe_customers (stripe_customer_id, matrix_id) VALUES ($1, $2)`, [cus, who]);
    return { who, cus };
  };
  const gate = () => createConcurrencyGate({ maxConcurrent: 3, maxQueued: 10, maxWaitMs: 3000 });

  await t.test("two concurrent checkouts → one session that can be paid", async () => {
    const { who, cus } = await fresh();
    const f = fakeStripe([]);
    const { openSubscriptionCheckout } = createSubscriptionCheckout({ pool, stripe: () => f.stripe, gate: gate() });
    const [a, b] = await Promise.all([
      openSubscriptionCheckout(who, cus, () => f.create(cus)),
      openSubscriptionCheckout(who, cus, () => f.create(cus)),
    ]);
    assert.equal(a.kind, "session");
    assert.equal(b.kind, "session");
    assert.equal(f.sessions.filter((s) => s.status === "open").length, 1, "only the newest session can still be paid");
    assert.equal(f.sessions.length, 2);
  });

  await t.test("retry: a second press after the first session was made expires the first", async () => {
    const { who, cus } = await fresh();
    const f = fakeStripe([]);
    const { openSubscriptionCheckout } = createSubscriptionCheckout({ pool, stripe: () => f.stripe, gate: gate() });
    await openSubscriptionCheckout(who, cus, () => f.create(cus));
    await openSubscriptionCheckout(who, cus, () => f.create(cus));
    assert.deepEqual(f.sessions.map((s) => s.status), ["expired", "open"]);
  });

  await t.test("restart: an open session left by an earlier process is expired too", async () => {
    const { who, cus } = await fresh();
    const f = fakeStripe([]);
    await createSubscriptionCheckout({ pool, stripe: () => f.stripe, gate: gate() }).openSubscriptionCheckout(who, cus, () => f.create(cus));
    await createSubscriptionCheckout({ pool, stripe: () => f.stripe, gate: gate() }).openSubscriptionCheckout(who, cus, () => f.create(cus));
    assert.equal(f.sessions.filter((s) => s.status === "open").length, 1);
  });

  await t.test("a live subscription on an OLDER customer of the viewer refuses a new checkout", async () => {
    const { who, cus } = await fresh();
    const old = `${cus}_old`;
    await pool.query(`INSERT INTO site.stripe_customers (stripe_customer_id, matrix_id) VALUES ($1, $2)`, [old, who]);
    const f = fakeStripe([{ customer: old, status: "active" }]);
    const { openSubscriptionCheckout } = createSubscriptionCheckout({ pool, stripe: () => f.stripe, gate: gate() });
    const r = await openSubscriptionCheckout(who, cus, () => f.create(cus));
    assert.deepEqual(r, { kind: "live", status: "active" });
    assert.equal(f.sessions.length, 0, "no session was made");
  });

  await t.test("a paused subscription is still a subscription", async () => {
    const { who, cus } = await fresh();
    const f = fakeStripe([{ customer: cus, status: "paused" }]);
    const { openSubscriptionCheckout } = createSubscriptionCheckout({ pool, stripe: () => f.stripe, gate: gate() });
    assert.deepEqual(await openSubscriptionCheckout(who, cus, () => f.create(cus)), { kind: "live", status: "paused" });
  });

  await t.test("an ended subscription does not block; a payment-mode session (a tip) is left alone", async () => {
    const { who, cus } = await fresh();
    const f = fakeStripe([{ customer: cus, status: "canceled" }]);
    f.sessions.push({ id: "cs_tip", customer: cus, mode: "payment", status: "open" });
    const { openSubscriptionCheckout } = createSubscriptionCheckout({ pool, stripe: () => f.stripe, gate: gate() });
    const r = await openSubscriptionCheckout(who, cus, () => f.create(cus));
    assert.equal(r.kind, "session");
    assert.equal(f.sessions.find((s) => s.id === "cs_tip")?.status, "open", "a tip's checkout is not a subscription's");
  });

  await t.test("a full budget answers busy, holding nothing", async () => {
    const { who, cus } = await fresh();
    const f = fakeStripe([]);
    const full = createConcurrencyGate({ maxConcurrent: 0, maxQueued: 0, maxWaitMs: 1 });
    const r = await createSubscriptionCheckout({ pool, stripe: () => f.stripe, gate: full }).openSubscriptionCheckout(who, cus, () => f.create(cus));
    assert.deepEqual(r, { kind: "busy" });
  });
});
