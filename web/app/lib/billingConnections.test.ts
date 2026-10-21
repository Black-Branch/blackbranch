// The connection budgets of the two billing paths that hold a database
// connection while Stripe answers: ensureStripeCustomer (checkout, driven by
// any signed-in viewer) and the webhook's subscription reconciler (driven by
// Stripe). TWO budgets: when they were one, an account spamming checkout filled
// it and the webhook was refused, so every member's status change waited on
// Stripe's redelivery backoff.
//
// A reconciler that takes a pool connection first and then waits for the
// viewer's lock and for Stripe lets ten events for one viewer hold ten
// connections — the whole pool — while one waited on Stripe and nine on the
// lock. Mock pool and fake Stripe: the property is how many connections are
// asked for, which needs no database.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Stripe from "stripe";
import { stripComments } from "./testSource.ts";

process.env.STRIPE_PRICE_SUPPORTER = "price_test_supporter"; // tiers.ts reads it at import
const { checkoutConnections, webhookConnections } = await import("./billingConnections.ts");
const { createStripeCustomers } = await import("./stripeCustomer.ts");
const { createSubscriptionSync } = await import("./subscriptionSync.ts");

const WHO = "@casey:site.test";
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

/** A pool that counts connections asked for. A client answers every
 *  statement with an empty result, except the reconciler's upsert (one row). */
function countingPool(opts: { connectHangs?: boolean } = {}) {
  let connects = 0;
  const waiting: Array<() => void> = [];
  const client = {
    query: async (sql: string) =>
      /INSERT INTO site\.subscriptions[\s\S]*RETURNING/.test(sql)
        ? { rows: [{ matrix_id: WHO }], rowCount: 1 }
        : /SELECT stripe_customer_id FROM site\.subscriptions WHERE matrix_id/.test(sql)
          ? { rows: [{ stripe_customer_id: "cus_casey" }], rowCount: 1 }
          : { rows: [], rowCount: 0 },
    release: () => {},
  };
  const pool = {
    connect: () => {
      connects++;
      if (!opts.connectHangs) return Promise.resolve(client);
      return new Promise((resolve) => waiting.push(() => resolve(client)));
    },
    query: client.query,
  };
  return { pool: pool as never, connects: () => connects, letThrough: () => { for (const w of waiting.splice(0)) w(); } };
}

const SUB = {
  id: "sub_casey", object: "subscription", status: "active", customer: "cus_casey", created: 1_700_000_000,
  cancel_at_period_end: false, metadata: { matrix_id: WHO },
  items: { data: [{ price: { id: "price_test_supporter" }, current_period_end: 1_900_000_000 }] },
};

/** Stripe whose subscription LIST hangs until released: a stall in the middle
 *  of the reconciler's hold. The first read (retrieve) answers at once. */
function stallingStripe() {
  const stalled: Array<() => void> = [];
  const stripe = {
    subscriptions: {
      retrieve: async () => structuredClone(SUB),
      list: () => new Promise((resolve) => stalled.push(() => resolve({ object: "list", has_more: false, data: [structuredClone(SUB)] }))),
    },
    customers: { retrieve: async (id: string) => ({ id, object: "customer" }) },
  } as unknown as Stripe;
  return { stripe, stalled: () => stalled.length, unstall: () => { for (const s of stalled.splice(0)) s(); } };
}

test("ten webhook events for one viewer during a Stripe stall take at most the webhook's two connections", async () => {
  const db = countingPool();
  const s = stallingStripe();
  const { syncSubscription } = createSubscriptionSync({ pool: db.pool, stripe: () => s.stripe });
  const runs = Array.from({ length: 10 }, (_, i) => syncSubscription({ id: "sub_casey" }, 1_800_000_000 + i));
  await tick(30);
  assert.equal(db.connects(), 2, "the webhook budget's two, and no more, hold a connection");
  assert.equal(s.stalled(), 2, "the two holders are the ones waiting on Stripe");
  // Stripe recovers: the queue drains through the same three slots.
  while (s.stalled() > 0) { s.unstall(); await tick(10); }
  const done = await Promise.all(runs);
  assert.equal(done.length, 10);
  assert.equal(db.connects(), 10, "every event was processed once a slot was free");
});

test("a full checkout budget, queue included, does not hold the webhook back: it connects at once", async () => {
  const hanging = countingPool({ connectHangs: true });
  const checkout = createStripeCustomers({
    pool: hanging.pool,
    stripe: () => ({ customers: { retrieve: async (id: string) => ({ id, object: "customer" }) } }) as unknown as Stripe,
  });
  // One account spamming checkout: three holding, ten queued, the rest refused.
  const spam = Array.from({ length: 20 }, () => checkout.ensureStripeCustomerOrBusy(WHO));
  await tick();
  assert.equal(hanging.connects(), 3);

  const db = countingPool();
  const s = stallingStripe();
  const { syncSubscription } = createSubscriptionSync({ pool: db.pool, stripe: () => s.stripe });
  const webhook = syncSubscription({ id: "sub_casey" }, 1_800_000_000);
  await tick(30);
  assert.equal(db.connects(), 1, "the webhook draws on its own budget, which no viewer can fill");
  s.unstall();
  assert.ok(await webhook);

  // Drain: each round lets the current holders finish and hands their slots on.
  for (let round = 0; round < 6; round++) { hanging.letThrough(); await tick(20); }
  const answers = await Promise.all(spam);
  assert.equal(hanging.connects(), 13, "the three holding plus the ten queued, never more");
  assert.equal(answers.filter((r) => r instanceof Response && r.status === 503).length, 7, "beyond 3 + 10 the spam is refused");
});

test("webhook events in flight do not take checkout's slots either", async () => {
  const db = countingPool();
  const s = stallingStripe();
  const { syncSubscription } = createSubscriptionSync({ pool: db.pool, stripe: () => s.stripe });
  const events = [1, 2, 3, 4].map((i) => syncSubscription({ id: "sub_casey" }, 1_800_000_000 + i));
  await tick(30);
  assert.equal(db.connects(), 2);

  const checkoutDb = countingPool();
  const checkout = createStripeCustomers({
    pool: checkoutDb.pool,
    stripe: () => ({ customers: { retrieve: async (id: string) => ({ id, object: "customer" }) } }) as unknown as Stripe,
  });
  assert.equal(await checkout.ensureStripeCustomer(WHO), "cus_casey");
  assert.equal(checkoutDb.connects(), 1);

  while (s.stalled() > 0) { s.unstall(); await tick(10); }
  await Promise.all(events);
});

test("a webhook call the budget refuses throws, holding nothing", async () => {
  const { createConcurrencyGate } = await import("./concurrencyGate.ts");
  const gate = createConcurrencyGate({ maxConcurrent: 1, maxQueued: 0, maxWaitMs: 10 });
  const db = countingPool();
  const s = stallingStripe();
  const { syncSubscription } = createSubscriptionSync({ pool: db.pool, stripe: () => s.stripe, gate });
  const first = syncSubscription({ id: "sub_casey" }, 1_800_000_000);
  await tick();
  await assert.rejects(syncSubscription({ id: "sub_casey" }, 1_800_000_001), /budget full/);
  assert.equal(db.connects(), 1);
  s.unstall();
  await first;
});

test("two budgets: checkout's and the webhook's reserved one, each path on its own, five of ten connections at most", () => {
  const read = (f: string) => readFileSync(join(import.meta.dirname, f), "utf8");
  for (const [f, budget, other] of [
    ["stripeCustomer.ts", "checkoutConnections", "webhookConnections"],
    ["subscriptionSync.ts", "webhookConnections", "checkoutConnections"],
  ] as const) {
    const src = read(f);
    assert.match(src, /export const \w+ = [^\n]*;\s*$/, `END of ${f} not read`);
    const s = stripComments(src);
    assert.match(s, new RegExp(`import \\{ ${budget} \\} from "\\./billingConnections\\.ts";`), `${f} imports its own budget`);
    assert.match(s, new RegExp(`const gate = deps\\.gate \\?\\? ${budget};`), `${f} uses it unless a test passes its own`);
    assert.doesNotMatch(s, new RegExp(other), `${f} must never draw on the other path's budget`);
    assert.doesNotMatch(s, /createConcurrencyGate\(/, `${f} must not make a budget of its own`);
    // The slot is taken before the pool is asked, and given back in the same finally.
    const fn = s.slice(s.indexOf("await gate.acquire("));
    assert.ok(fn.indexOf("await gate.acquire(") < fn.indexOf("deps.pool.connect()"), `${f}: slot before connection`);
    assert.match(fn, /finally \{\s*client\?\.release\(\);\s*release\(\);/, `${f}: released together`);
  }
  assert.notEqual(checkoutConnections, webhookConnections, "two objects, two counts");
  const budgets = stripComments(read("billingConnections.ts"));
  assert.match(budgets, /export const checkoutConnections = createConcurrencyGate\(\{ maxConcurrent: 3,/);
  assert.match(budgets, /export const webhookConnections = createConcurrencyGate\(\{ maxConcurrent: 2,/);
  const total = [...budgets.matchAll(/maxConcurrent: (\d+)/g)].reduce((n, m) => n + Number(m[1]), 0);
  assert.ok(total <= 5, `the billing budgets together may hold ${total} of the pool's 10 connections; keep it to 5`);
});

test("the webhook route answers 500 on a reconciler throw — a refused event is redelivered, never acknowledged", () => {
  const src = stripComments(readFileSync(join(import.meta.dirname, "../api/billing/webhook/route.ts"), "utf8"));
  const tryAt = src.indexOf("try {");
  const catchAt = src.indexOf("} catch (e) {", tryAt);
  for (const c of ["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "invoice.paid", "checkout.session.completed"]) {
    const at = src.indexOf(`case "${c}":`);
    assert.ok(at > tryAt && at < catchAt, `${c} is handled inside the try`);
  }
  assert.match(src.slice(catchAt, src.indexOf("}", catchAt + 15) + 1), /status: 500/);
  const wrapper = src.slice(src.indexOf("async function syncSubscription("));
  assert.match(wrapper, /const wrote = await syncSubscriptionState\(ref, eventAt\);/, "awaited, not caught");
  assert.doesNotMatch(wrapper.slice(0, wrapper.indexOf("if (!wrote) return;")), /\.catch\(/);
});
