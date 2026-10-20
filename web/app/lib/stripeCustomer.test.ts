// One Stripe customer per viewer.
//
// ensureStripeCustomer used to treat every failure as "no customer": a database
// error read as "no row", and any Stripe error on the retrieve (a 429, a dropped
// connection, a bad key) read as "customer deleted". Either way it created a NEW
// customer and overwrote the stored mapping, so a viewer's next subscription
// landed on a second customer and the first customer's events could then write
// over it. Two simultaneous first checkouts also both saw no row and created two.
//
// The first half drives a mock pool and a fake Stripe (the decisions are code);
// the second half runs the lock against a replayed Postgres, because a mock pool
// cannot serialise anything. Runs in CI (web job sets SQL_PARSE_DATABASE_URL).
// Locally: donationsSchema.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import Stripe from "stripe";

const PRICE = "price_test_supporter";
process.env.STRIPE_PRICE_SUPPORTER = PRICE; // tiers.ts reads it at import
const { createStripeCustomers } = await import("./stripeCustomer.ts");
const { createSubscriptionSync } = await import("./subscriptionSync.ts");

// ── mock pool + fake Stripe ─────────────────────────────────────────────────

type Q = { sql: string; params: unknown[] };

/** A pool whose clients answer the stored mapping with `stored` (or throw
 *  `failOn` for the statement it matches), and record every statement. */
function mockPool(opts: { stored?: string | null; failOn?: RegExp } = {}) {
  const seen: Q[] = [];
  let released = 0;
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      seen.push({ sql, params });
      if (opts.failOn?.test(sql)) throw new Error("connection terminated unexpectedly");
      if (/SELECT stripe_customer_id FROM site\.subscriptions/.test(sql)) {
        return { rows: opts.stored ? [{ stripe_customer_id: opts.stored }] : [], rowCount: opts.stored ? 1 : 0 };
      }
      if (/SELECT email, display_name FROM site\.users/.test(sql)) {
        return { rows: [{ email: "casey@site.test", display_name: "casey" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
    release: () => { released++; },
  };
  const pool = { connect: async () => client, query: client.query };
  return {
    pool: pool as never,
    seen,
    released: () => released,
    wrote: () => seen.filter((q) => /INSERT INTO site\.subscriptions/.test(q.sql)),
    sqls: () => seen.map((q) => q.sql.trim().split(/\s+/).slice(0, 2).join(" ")),
  };
}

/** A fake Stripe: `retrieve` answers with `onRetrieve` (a customer or a throw),
 *  `create` mints cus_new_<n> after `createDelayMs`. */
function fakeStripe(onRetrieve: (id: string) => unknown = (id) => ({ id, object: "customer" }), createDelayMs = 0) {
  let created = 0;
  const retrieved: string[] = [];
  const stripe = {
    customers: {
      retrieve: async (id: string) => { retrieved.push(id); return onRetrieve(id); },
      create: async (p: { metadata: { matrix_id: string } }) => {
        await new Promise((r) => setTimeout(r, createDelayMs));
        created++;
        return { id: `cus_new_${created}`, object: "customer", metadata: p.metadata };
      },
    },
  } as unknown as Stripe;
  return { stripe, created: () => created, retrieved };
}

const WHO = "@casey:site.test";
const raise = (e: Error) => () => { throw e; };

test("a stored customer that is alive is returned as is: nothing created, nothing written", async () => {
  const db = mockPool({ stored: "cus_old" });
  const s = fakeStripe();
  const { ensureStripeCustomer } = createStripeCustomers({ pool: db.pool, stripe: () => s.stripe });
  assert.equal(await ensureStripeCustomer(WHO), "cus_old");
  assert.equal(s.created(), 0);
  assert.equal(db.wrote().length, 0);
  assert.equal(db.released(), 1);
});

test("the lookup runs under a per-viewer advisory lock, inside one transaction", async () => {
  const db = mockPool({ stored: null });
  const s = fakeStripe();
  const { ensureStripeCustomer } = createStripeCustomers({ pool: db.pool, stripe: () => s.stripe });
  assert.equal(await ensureStripeCustomer(WHO), "cus_new_1");
  const lock = db.seen.find((q) => /pg_advisory_xact_lock\(hashtextextended\(\$1, 0\)\)/.test(q.sql));
  assert.ok(lock, "no advisory lock taken");
  assert.deepEqual(lock.params, [`billing:viewer:${WHO}`]);
  const order = db.seen.map((q) => q.sql);
  const at = (re: RegExp) => order.findIndex((x) => re.test(x));
  assert.ok(at(/^BEGIN$/) < at(/pg_advisory_xact_lock/), "BEGIN before the lock (a transaction-scoped lock outside a transaction is released at once)");
  assert.ok(at(/pg_advisory_xact_lock/) < at(/SELECT stripe_customer_id/), "the row is read UNDER the lock");
  assert.ok(at(/INSERT INTO site\.subscriptions/) < at(/^COMMIT$/), "the mapping is written in the same transaction");
  assert.equal(db.released(), 1);
});

test("a database error on the lookup throws and creates nothing", async () => {
  const db = mockPool({ stored: "cus_old", failOn: /SELECT stripe_customer_id/ });
  const s = fakeStripe();
  const { ensureStripeCustomer } = createStripeCustomers({ pool: db.pool, stripe: () => s.stripe });
  await assert.rejects(ensureStripeCustomer(WHO), /connection terminated/);
  assert.equal(s.created(), 0, "a failed read is not 'no customer'");
  assert.equal(db.wrote().length, 0);
  assert.ok(db.seen.some((q) => q.sql === "ROLLBACK"));
  assert.equal(db.released(), 1);
});

test("a database error on the profile read throws too — no customer is created from a guess", async () => {
  const db = mockPool({ stored: null, failOn: /SELECT email, display_name/ });
  const s = fakeStripe();
  const { ensureStripeCustomer } = createStripeCustomers({ pool: db.pool, stripe: () => s.stripe });
  await assert.rejects(ensureStripeCustomer(WHO));
  assert.equal(s.created(), 0);
});

for (const [name, err] of [
  ["a rate limit (429)", new Stripe.errors.StripeRateLimitError({ message: "Too many requests", statusCode: 429 })],
  ["a dropped connection", new Stripe.errors.StripeConnectionError({ message: "socket hang up" })],
  ["a bad key", new Stripe.errors.StripeAuthenticationError({ message: "Invalid API Key", statusCode: 401 })],
  ["some other invalid request", new Stripe.errors.StripeInvalidRequestError({ message: "nope", code: "parameter_invalid_empty", statusCode: 400 })],
  ["a plain network error", new Error("ECONNRESET")],
] as const) {
  test(`${name} on the retrieve throws: nothing created, the mapping kept`, async () => {
    const db = mockPool({ stored: "cus_old" });
    const s = fakeStripe(raise(err));
    const { ensureStripeCustomer } = createStripeCustomers({ pool: db.pool, stripe: () => s.stripe });
    await assert.rejects(ensureStripeCustomer(WHO), (e) => e === err);
    assert.equal(s.created(), 0);
    assert.equal(db.wrote().length, 0, "the stored customer id must survive a Stripe error");
    assert.equal(db.released(), 1);
  });
}

test("resource_missing recreates the customer and replaces the mapping", async () => {
  const db = mockPool({ stored: "cus_ghost" });
  const missing = new Stripe.errors.StripeInvalidRequestError({ message: "No such customer: 'cus_ghost'", code: "resource_missing", statusCode: 404 });
  const s = fakeStripe(raise(missing));
  const { ensureStripeCustomer } = createStripeCustomers({ pool: db.pool, stripe: () => s.stripe });
  assert.equal(await ensureStripeCustomer(WHO), "cus_new_1");
  assert.equal(s.created(), 1);
  assert.deepEqual(db.wrote().map((q) => q.params), [[WHO, "cus_new_1"]]);
});

test("a deleted customer is recreated and the mapping replaced", async () => {
  const db = mockPool({ stored: "cus_gone" });
  const s = fakeStripe((id) => ({ id, object: "customer", deleted: true }));
  const { ensureStripeCustomer } = createStripeCustomers({ pool: db.pool, stripe: () => s.stripe });
  assert.equal(await ensureStripeCustomer(WHO), "cus_new_1");
  assert.deepEqual(db.wrote().map((q) => q.params), [[WHO, "cus_new_1"]]);
});

test("the mapping write touches only the customer id and updated_at — tier and status stay the webhook's", async () => {
  const db = mockPool({ stored: null });
  const s = fakeStripe();
  const { ensureStripeCustomer } = createStripeCustomers({ pool: db.pool, stripe: () => s.stripe });
  await ensureStripeCustomer(WHO);
  const w = db.wrote()[0];
  assert.ok(w, "no mapping written");
  assert.match(w.sql, /\(matrix_id, stripe_customer_id, updated_at\)/);
  assert.doesNotMatch(w.sql, /\b(tier|status|stripe_sub_id|cancel_at_period_end|current_period_end)\b/);
});

// ── the connection gate ─────────────────────────────────────────────────────
// Each call holds a pool connection across its Stripe calls, so during a Stripe
// stall the calls in flight hold that many connections. The gate caps them, and
// a refused call must not touch the pool at all.

/** A pool whose connect() hangs until the test lets it through, so a call
 *  holds its slot for as long as the test says. */
function hangingPool() {
  let connects = 0;
  const gates: Array<() => void> = [];
  const client = {
    query: async (sql: string) => {
      if (/SELECT stripe_customer_id/.test(sql)) return { rows: [{ stripe_customer_id: "cus_old" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  const pool = {
    connect: () => {
      connects++;
      return new Promise((resolve) => gates.push(() => resolve(client)));
    },
  };
  return { pool: pool as never, connects: () => connects, letThrough: () => { for (const g of gates.splice(0)) g(); } };
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test("the gate refuses beyond its bound, and a refused call takes no pool connection", async () => {
  const { createConcurrencyGate } = await import("./concurrencyGate.ts");
  const db = hangingPool();
  const s = fakeStripe();
  const gate = createConcurrencyGate({ maxConcurrent: 2, maxQueued: 1, maxWaitMs: 40 });
  const { ensureStripeCustomer } = createStripeCustomers({ pool: db.pool, stripe: () => s.stripe, gate });

  const held = [ensureStripeCustomer(WHO), ensureStripeCustomer(WHO)];
  await tick();
  assert.equal(db.connects(), 2, "two calls in, each holding a connection");

  const queued = ensureStripeCustomer(WHO);
  await assert.rejects(ensureStripeCustomer(WHO), { name: "StripeCustomerBusyError" }, "queue full: refused at once");
  await assert.rejects(queued, { name: "StripeCustomerBusyError" }, "a waiter not served in time is refused");
  assert.equal(db.connects(), 2, "neither refused call asked the pool for a connection");

  db.letThrough();
  assert.deepEqual(await Promise.all(held), ["cus_old", "cus_old"]);
  // Both slots are back: the next call is admitted and connects.
  const next = ensureStripeCustomer(WHO);
  await tick();
  assert.equal(db.connects(), 3);
  db.letThrough();
  assert.equal(await next, "cus_old");
});

test("a slot is given back when the call fails, so errors cannot leak the bound away", async () => {
  const { createConcurrencyGate } = await import("./concurrencyGate.ts");
  const gate = createConcurrencyGate({ maxConcurrent: 1, maxQueued: 0, maxWaitMs: 10 });
  const db = mockPool({ stored: "cus_old" });
  const s = fakeStripe(raise(new Error("ECONNRESET")));
  const { ensureStripeCustomer } = createStripeCustomers({ pool: db.pool, stripe: () => s.stripe, gate });
  for (let i = 0; i < 3; i++) await assert.rejects(ensureStripeCustomer(WHO), /ECONNRESET/);
  assert.equal(db.released(), 3);
});

test("the routes' form answers 503 with Retry-After when the gate is full, and still throws anything else", async () => {
  const { createConcurrencyGate } = await import("./concurrencyGate.ts");
  const db = hangingPool();
  const s = fakeStripe();
  const gate = createConcurrencyGate({ maxConcurrent: 1, maxQueued: 0, maxWaitMs: 10 });
  const { ensureStripeCustomerOrBusy } = createStripeCustomers({ pool: db.pool, stripe: () => s.stripe, gate });
  const held = ensureStripeCustomerOrBusy(WHO);
  await tick();
  const busy = await ensureStripeCustomerOrBusy(WHO);
  assert.ok(busy instanceof Response);
  assert.equal(busy.status, 503);
  assert.ok(Number(busy.headers.get("Retry-After")) > 0);
  db.letThrough();
  assert.equal(await held, "cus_old");

  const failing = createStripeCustomers({ pool: mockPool({ stored: "cus_old" }).pool, stripe: () => fakeStripe(raise(new Error("ECONNRESET"))).stripe });
  await assert.rejects(failing.ensureStripeCustomerOrBusy(WHO), /ECONNRESET/, "a Stripe failure is not 'busy'");
});

test("every route that needs a customer takes the gated form and returns its 503", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { stripComments } = await import("./testSource.ts");
  for (const r of ["checkout", "donate", "gift", "points"]) {
    const src = readFileSync(join(import.meta.dirname, `../api/billing/${r}/route.ts`), "utf8");
    assert.match(src, /\}\s*$/, `END of the ${r} route not read`);
    const s = stripComments(src);
    assert.match(s, /= await ensureStripeCustomerOrBusy\(\w+\);\s*if \(typeof (\w+) !== "string"\) return \1;/, `${r} must return the 503`);
    assert.doesNotMatch(s, /ensureStripeCustomer\(/, `${r} must not call the ungated name`);
  }
});

// ── against a real Postgres ─────────────────────────────────────────────────

const DB_URL = process.env.SQL_PARSE_DATABASE_URL || "";
// Never production: only a throwaway on this machine (a shell may carry DATABASE_URL = prod).
const unsafe = !DB_URL || DB_URL === process.env.DATABASE_URL || !/@(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(DB_URL);
const skip = unsafe ? "SQL_PARSE_DATABASE_URL unset or unsafe" : false;
const RUN = `stripecus${process.pid}x${Date.now().toString(36)}`;

test("one customer per viewer, on the real schema", { skip }, async (t) => {
  const pool = new Pool({ connectionString: DB_URL, max: 6 });
  const clean = async () => {
    await pool.query(`DELETE FROM site.subscriptions WHERE matrix_id LIKE $1`, [`@${RUN}%`]);
    await pool.query(`DELETE FROM site.stripe_customers WHERE matrix_id LIKE $1`, [`@${RUN}%`]);
    await pool.query(`DELETE FROM site.users WHERE matrix_id LIKE $1`, [`@${RUN}%`]);
  };
  await clean();
  t.after(async () => { await clean(); await pool.end(); });
  let seq = 0;
  const fresh = async () => {
    const who = `@${RUN}-${++seq}:site.test`;
    await pool.query(`INSERT INTO site.users (matrix_id) VALUES ($1)`, [who]);
    return who;
  };
  const row = async (who: string) =>
    (await pool.query<{ stripe_customer_id: string | null; status: string | null; tier: string | null }>(
      `SELECT stripe_customer_id, status, tier FROM site.subscriptions WHERE matrix_id = $1`, [who])).rows[0];

  await t.test("two simultaneous first checkouts create ONE customer", async () => {
    const who = await fresh();
    // The create is slow, so without the lock both calls see no row before either writes.
    const s = fakeStripe(undefined, 80);
    const { ensureStripeCustomer } = createStripeCustomers({ pool, stripe: () => s.stripe });
    const [a, b] = await Promise.all([ensureStripeCustomer(who), ensureStripeCustomer(who)]);
    assert.equal(s.created(), 1, "a second customer was created for the same viewer");
    assert.equal(a, b);
    assert.equal((await row(who))?.stripe_customer_id, a);
    const recorded = await pool.query(`SELECT stripe_customer_id FROM site.stripe_customers WHERE matrix_id = $1`, [who]);
    assert.deepEqual(recorded.rows, [{ stripe_customer_id: a }], "every created customer is recorded, in the same transaction");
  });

  await t.test("five at once still create one", async () => {
    const who = await fresh();
    const s = fakeStripe(undefined, 30);
    const { ensureStripeCustomer } = createStripeCustomers({ pool, stripe: () => s.stripe });
    const ids = await Promise.all(Array.from({ length: 5 }, () => ensureStripeCustomer(who)));
    assert.equal(s.created(), 1);
    assert.equal(new Set(ids).size, 1);
  });

  await t.test("a Stripe error keeps the stored mapping on the real row", async () => {
    const who = await fresh();
    await pool.query(
      `INSERT INTO site.subscriptions (matrix_id, stripe_customer_id, status, tier, updated_at) VALUES ($1, 'cus_keep', 'active', 'supporter', NOW())`, [who]);
    const s = fakeStripe(raise(new Stripe.errors.StripeRateLimitError({ message: "slow down", statusCode: 429 })));
    const { ensureStripeCustomer } = createStripeCustomers({ pool, stripe: () => s.stripe });
    await assert.rejects(ensureStripeCustomer(who));
    assert.deepEqual(await row(who), { stripe_customer_id: "cus_keep", status: "active", tier: "supporter" });
  });

  await t.test("a recreated customer replaces only the customer id — tier and status are untouched", async () => {
    const who = await fresh();
    await pool.query(
      `INSERT INTO site.subscriptions (matrix_id, stripe_customer_id, status, tier, updated_at) VALUES ($1, 'cus_ghost', 'active', 'supporter', NOW())`, [who]);
    const s = fakeStripe(raise(new Stripe.errors.StripeInvalidRequestError({ message: "No such customer", code: "resource_missing", statusCode: 404 })));
    const { ensureStripeCustomer } = createStripeCustomers({ pool, stripe: () => s.stripe });
    assert.equal(await ensureStripeCustomer(who), "cus_new_1");
    assert.deepEqual(await row(who), { stripe_customer_id: "cus_new_1", status: "active", tier: "supporter" });
  });

  await t.test("checkout then webhook: the customer made at checkout ends in an active row", async () => {
    const who = await fresh();
    // One fake Stripe for both halves: the customer checkout creates is the one
    // the subscription is created on, and the webhook reads it back.
    const subs = new Map<string, Stripe.Subscription>();
    const customers = new Map<string, { id: string; metadata: Record<string, string> }>();
    let n = 0;
    const stripe = {
      customers: {
        retrieve: async (id: string) => {
          const c = customers.get(id);
          if (!c) throw new Stripe.errors.StripeInvalidRequestError({ message: "No such customer", code: "resource_missing", statusCode: 404 });
          return { object: "customer", ...c };
        },
        create: async (p: { metadata: Record<string, string> }) => {
          const c = { id: `cus_${RUN}_${++n}`, metadata: p.metadata };
          customers.set(c.id, c);
          return { object: "customer", ...c };
        },
      },
      subscriptions: {
        retrieve: async (id: string) => structuredClone(subs.get(id)!),
        list: async (q: { customer: string }) => ({ object: "list", has_more: false,
          data: [...subs.values()].filter((x) => x.customer === q.customer).map((x) => structuredClone(x)) }),
      },
    } as unknown as Stripe;

    const { ensureStripeCustomer } = createStripeCustomers({ pool, stripe: () => stripe });
    const customerId = await ensureStripeCustomer(who);
    // Checkout completes: Stripe creates the subscription on that customer. The
    // subscription carries no matrix_id of its own, so the webhook must find the
    // viewer through the customer checkout made.
    const subId = `sub_${RUN}_checkout`;
    subs.set(subId, {
      id: subId, object: "subscription", status: "active", customer: customerId, created: 1_800_000_000,
      cancel_at_period_end: false, metadata: {},
      items: { data: [{ price: { id: PRICE }, current_period_end: 1_900_000_000 }] },
    } as unknown as Stripe.Subscription);

    const { syncSubscription } = createSubscriptionSync({ pool, stripe: () => stripe });
    const wrote = await syncSubscription({ id: subId }, 1_800_000_000);
    assert.equal(wrote?.matrixId, who);
    assert.equal(wrote?.effectiveTier, "supporter");
    assert.deepEqual(await row(who), { stripe_customer_id: customerId, status: "active", tier: "supporter" });
    // A second checkout reuses the customer: nothing new is created.
    assert.equal(await ensureStripeCustomer(who), customerId);
    assert.equal(n, 1);
  });
});
