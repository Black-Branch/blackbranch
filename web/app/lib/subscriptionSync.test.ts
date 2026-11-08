// Subscription state against delivery order, on the REAL schema.
//
// Stripe does not deliver events in order (docs.stripe.com/webhooks#event-ordering),
// and `event.created` has one-second resolution. A cancellation and an older
// "active" snapshot stamped in the same second must not be ordered by arrival:
// the later delivery would win, so a stale active would restore access and the subscriber
// badge. Runs through the runtime driver against a replayed Postgres, because the
// recency gate and the serialisation are SQL — a mock pool cannot test either.
// Runs in CI (web job sets SQL_PARSE_DATABASE_URL). Locally: donationsSchema.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import Stripe from "stripe";
import { readFileSync } from "node:fs";

const PRICE = "price_test_supporter";
process.env.STRIPE_PRICE_SUPPORTER = PRICE; // tiers.ts reads it at import
const { createSubscriptionSync } = await import("./subscriptionSync.ts");
const { entitlementOf } = await import("./subscriptions/entitlement.ts");

const DB_URL = process.env.SQL_PARSE_DATABASE_URL || "";
// Never production: only a throwaway on this machine (a shell may carry DATABASE_URL = prod).
const unsafe = !DB_URL || DB_URL === process.env.DATABASE_URL || !/@(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(DB_URL);
const skip = unsafe ? "SQL_PARSE_DATABASE_URL unset or unsafe" : false;

const RUN = `subsync${process.pid}x${Date.now().toString(36)}`;
let seq = 0;

function snapshot(id: string, who: string, status: Stripe.Subscription.Status, created = 1_700_000_000): Stripe.Subscription {
  return {
    id, object: "subscription", status, customer: `cus_${who}`, created, cancel_at_period_end: false,
    metadata: { matrix_id: who },
    items: { data: [{ price: { id: PRICE }, current_period_end: 1_900_000_000 }] },
  } as unknown as Stripe.Subscription;
}

/** A fake Stripe whose subscriptions.retrieve and .list answer with Stripe's
 *  CURRENT state, read at call time, then resolve after `delays.shift()` ms —
 *  so a test can make one read land after a later one. */
function fakeStripe(current: Map<string, Stripe.Subscription>, delays: number[] = [], gone: Set<string> = new Set()) {
  const calls: string[] = [];
  const stripe = {
    subscriptions: {
      retrieve: async (id: string) => {
        calls.push(id);
        const s = current.get(id);
        if (!s) throw new Error(`no subscription ${id}`);
        const copy = structuredClone(s);
        await new Promise((r) => setTimeout(r, delays.shift() ?? 0));
        return copy;
      },
      list: async (q: { customer: string; status?: string }) => {
        calls.push(`list:${q.customer}`);
        assert.equal(q.status, "all", "a cancelled-only customer must still be listed");
        if (gone.has(q.customer)) {
          throw new Stripe.errors.StripeInvalidRequestError({ message: `No such customer: '${q.customer}'`, code: "resource_missing", statusCode: 404 });
        }
        const data = [...current.values()].filter((x) => x.customer === q.customer).map((x) => structuredClone(x));
        await new Promise((r) => setTimeout(r, delays.shift() ?? 0));
        return { object: "list", data, has_more: false };
      },
    },
    customers: { retrieve: async () => { throw new Error("customers.retrieve not expected"); } },
  } as unknown as Stripe;
  return { stripe, calls };
}

test("subscription state in any delivery order", { skip }, async (t) => {
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
    return { who, subId: `sub_${RUN}_${seq}` };
  };
  const row = async (who: string) =>
    (await pool.query<{ status: string; tier: string | null }>(
      `SELECT status, tier FROM site.subscriptions WHERE matrix_id = $1`, [who])).rows[0];
  const subIdOf = async (who: string) =>
    (await pool.query<{ stripe_sub_id: string }>(
      `SELECT stripe_sub_id FROM site.subscriptions WHERE matrix_id = $1`, [who])).rows[0]?.stripe_sub_id;
  const T = 1_800_000_000;

  await t.test("cancelled, then an older active snapshot stamped the SAME second: stays cancelled", async () => {
    const { who, subId } = await fresh();
    const current = new Map([[subId, snapshot(subId, who, "canceled")]]);
    const { syncSubscription } = createSubscriptionSync({ pool, stripe: () => fakeStripe(current).stripe });
    await syncSubscription(snapshot(subId, who, "canceled"), T);
    const late = await syncSubscription(snapshot(subId, who, "active"), T);
    assert.deepEqual(await row(who), { status: "canceled", tier: null });
    assert.ok(!late || late.sub.status === "canceled", "the caller must never be handed an entitled state to grant a badge from");
  });

  await t.test("the same pair in the other order ends cancelled too", async () => {
    const { who, subId } = await fresh();
    const current = new Map([[subId, snapshot(subId, who, "canceled")]]);
    const { syncSubscription } = createSubscriptionSync({ pool, stripe: () => fakeStripe(current).stripe });
    await syncSubscription(snapshot(subId, who, "active"), T);
    await syncSubscription(snapshot(subId, who, "canceled"), T);
    assert.deepEqual(await row(who), { status: "canceled", tier: null });
  });

  await t.test("retries of either event change nothing", async () => {
    const { who, subId } = await fresh();
    const current = new Map([[subId, snapshot(subId, who, "canceled")]]);
    const { syncSubscription } = createSubscriptionSync({ pool, stripe: () => fakeStripe(current).stripe });
    for (const s of ["canceled", "active", "canceled", "active"] as const) await syncSubscription(snapshot(subId, who, s), T);
    assert.deepEqual(await row(who), { status: "canceled", tier: null });
  });

  await t.test("a strictly older event is still dropped", async () => {
    const { who, subId } = await fresh();
    const current = new Map([[subId, snapshot(subId, who, "canceled")]]);
    const { syncSubscription } = createSubscriptionSync({ pool, stripe: () => fakeStripe(current).stripe });
    await syncSubscription(snapshot(subId, who, "canceled"), T);
    assert.equal(await syncSubscription(snapshot(subId, who, "active"), T - 5), null);
    assert.deepEqual(await row(who), { status: "canceled", tier: null });
  });

  await t.test("an active subscription is written active with its tier", async () => {
    const { who, subId } = await fresh();
    const current = new Map([[subId, snapshot(subId, who, "active")]]);
    const { syncSubscription } = createSubscriptionSync({ pool, stripe: () => fakeStripe(current).stripe });
    const w = await syncSubscription(snapshot(subId, who, "active"), T);
    assert.equal(w?.effectiveTier, "supporter");
    assert.deepEqual(await row(who), { status: "active", tier: "supporter" });
  });

  // A plan switch: the viewer's old subscription A is cancelled and a new one B
  // created in the same second. The row is per viewer, so A's event must not
  // write A's cancellation over B.
  for (const order of [["a", "b"], ["b", "a"]] as const) {
    await t.test(`plan switch in one second, ${order.join(" then ")}: the viewer ends active on B`, async () => {
      const { who, subId } = await fresh();
      const a = `${subId}_a`, b = `${subId}_b`;
      const current = new Map([
        [a, snapshot(a, who, "canceled", T - 86_400)],
        [b, snapshot(b, who, "active", T)],
      ]);
      const { syncSubscription } = createSubscriptionSync({ pool, stripe: () => fakeStripe(current).stripe });
      for (const id of order) await syncSubscription({ id: id === "a" ? a : b }, T);
      assert.deepEqual(await row(who), { status: "active", tier: "supporter" });
      assert.equal(await subIdOf(who), b);
    });
  }

  await t.test("plan switch processed concurrently: the viewer ends active on B", async () => {
    const { who, subId } = await fresh();
    const a = `${subId}_a`, b = `${subId}_b`;
    const current = new Map([
      [a, snapshot(a, who, "canceled", T - 86_400)],
      [b, snapshot(b, who, "active", T)],
    ]);
    const { stripe } = fakeStripe(current, [0, 60]);
    const { syncSubscription } = createSubscriptionSync({ pool, stripe: () => stripe });
    await Promise.all([syncSubscription({ id: b }, T), syncSubscription({ id: a }, T)]);
    assert.deepEqual(await row(who), { status: "active", tier: "supporter" });
    assert.equal(await subIdOf(who), b);
  });

  // A viewer with TWO Stripe customers (an old one, and a second one created
  // while a lookup failed — duplicates of that kind can already exist). The old
  // customer's subscription A is cancelled and the new customer's B created in
  // the same second. The row is per viewer, so A's event, which names only the
  // old customer, must not write A's cancellation over B — whichever runs last.
  const twoCustomers = async () => {
    const { who, subId } = await fresh();
    const a = `${subId}_a`, b = `${subId}_b`;
    const oldCus = `cus_${RUN}_${seq}_old`, newCus = `cus_${RUN}_${seq}_new`;
    const onCustomer = (s: Stripe.Subscription, c: string) => ({ ...s, customer: c }) as Stripe.Subscription;
    const current = new Map([
      [a, onCustomer(snapshot(a, who, "canceled", T - 86_400), oldCus)],
      [b, onCustomer(snapshot(b, who, "active", T), newCus)],
    ]);
    // What the duplicate-creating lookup left behind: the row already names the
    // new customer while still showing the old membership.
    await pool.query(
      `INSERT INTO site.subscriptions (matrix_id, stripe_customer_id, stripe_sub_id, tier, status, updated_at)
       VALUES ($1, $2, $3, 'supporter', 'active', NOW())`, [who, newCus, a]);
    return { who, a, b, newCus, current };
  };
  const customerOf = async (who: string) =>
    (await pool.query<{ stripe_customer_id: string }>(
      `SELECT stripe_customer_id FROM site.subscriptions WHERE matrix_id = $1`, [who])).rows[0]?.stripe_customer_id;

  for (const order of [["new", "old"], ["old", "new"]] as const) {
    await t.test(`two customers, one second, ${order.join(" then ")}: the viewer ends active on the new customer`, async () => {
      const { who, a, b, newCus, current } = await twoCustomers();
      const { syncSubscription } = createSubscriptionSync({ pool, stripe: () => fakeStripe(current).stripe });
      for (const which of order) await syncSubscription({ id: which === "old" ? a : b }, T);
      assert.deepEqual(await row(who), { status: "active", tier: "supporter" });
      assert.equal(await subIdOf(who), b);
      assert.equal(await customerOf(who), newCus, "the row points at the customer whose subscription counts");
    });
  }

  await t.test("two customers, processed concurrently: the viewer ends active on the new customer", async () => {
    const { who, a, b, newCus, current } = await twoCustomers();
    const { stripe } = fakeStripe(current, [0, 60]);
    const { syncSubscription } = createSubscriptionSync({ pool, stripe: () => stripe });
    await Promise.all([syncSubscription({ id: b }, T), syncSubscription({ id: a }, T)]);
    assert.deepEqual(await row(who), { status: "active", tier: "supporter" });
    assert.equal(await subIdOf(who), b);
    assert.equal(await customerOf(who), newCus);
  });

  await t.test("the old customer still holds the live subscription: the row moves back to it", async () => {
    const { who, subId } = await fresh();
    const a = `${subId}_a`;
    const oldCus = `cus_${RUN}_${seq}_old`, newCus = `cus_${RUN}_${seq}_new`;
    const current = new Map([[a, { ...snapshot(a, who, "active", T - 86_400), customer: oldCus } as Stripe.Subscription]]);
    await pool.query(
      `INSERT INTO site.subscriptions (matrix_id, stripe_customer_id, updated_at) VALUES ($1, $2, NOW())`, [who, newCus]);
    const { syncSubscription } = createSubscriptionSync({ pool, stripe: () => fakeStripe(current).stripe });
    await syncSubscription({ id: a }, T);
    assert.deepEqual(await row(who), { status: "active", tier: "supporter" });
    assert.equal(await customerOf(who), oldCus);
  });

  // Two customers A and B, BOTH with a live subscription; B is the one stored
  // on the row. B's subscription is cancelled. The row must stay active on A
  // (A is still charging), and it must whichever customer's event arrives —
  // B's cancellation names only B, and B plus the stored B is not the viewer.
  const bothLive = async () => {
    const { who, subId } = await fresh();
    const a = `${subId}_a`, b = `${subId}_b`;
    const cusA = `cus_${RUN}_${seq}_a`, cusB = `cus_${RUN}_${seq}_b`;
    const current = new Map([
      [a, { ...snapshot(a, who, "active", T - 86_400 * 30), customer: cusA } as Stripe.Subscription],
      [b, { ...snapshot(b, who, "canceled", T - 86_400), customer: cusB } as Stripe.Subscription],
    ]);
    await pool.query(
      `INSERT INTO site.subscriptions (matrix_id, stripe_customer_id, stripe_sub_id, tier, status, updated_at)
       VALUES ($1, $2, $3, 'supporter', 'active', NOW())`, [who, cusB, b]);
    // A was recorded when it was created (ensureStripeCustomer) or when an
    // event of its arrived; B by the migration's back-fill.
    await pool.query(
      `INSERT INTO site.stripe_customers (stripe_customer_id, matrix_id) VALUES ($1, $3), ($2, $3)`, [cusA, cusB, who]);
    return { who, a, b, cusA, current };
  };
  for (const [label, event] of [["B's cancellation", "b"], ["an event of A's", "a"]] as const) {
    await t.test(`two live customers, B cancels, ${label} arrives: the row stays active on A`, async () => {
      const { who, a, b, cusA, current } = await bothLive();
      const { syncSubscription } = createSubscriptionSync({ pool, stripe: () => fakeStripe(current).stripe });
      await syncSubscription({ id: event === "a" ? a : b }, T);
      assert.deepEqual(await row(who), { status: "active", tier: "supporter" });
      assert.equal(await subIdOf(who), a);
      assert.equal(await customerOf(who), cusA);
    });
  }

  await t.test("an event from a customer not yet recorded records it for the viewer it resolves to", async () => {
    const { who, subId } = await fresh();
    const cusOld = `cus_${RUN}_${seq}_unrecorded`;
    const sub = { ...snapshot(subId, who, "active"), customer: cusOld } as Stripe.Subscription;
    const { resolveMatrixId, syncSubscription } = createSubscriptionSync({ pool, stripe: () => fakeStripe(new Map([[subId, sub]])).stripe });
    const recorded = async () =>
      (await pool.query(`SELECT matrix_id FROM site.stripe_customers WHERE stripe_customer_id = $1`, [cusOld])).rows;
    // The renewal path (invoice.paid) resolves the viewer and nothing more.
    assert.equal(await resolveMatrixId(sub, cusOld), who);
    assert.deepEqual(await recorded(), [{ matrix_id: who }]);
    // …and the state sync keeps it recorded (idempotent).
    await syncSubscription({ id: subId }, T);
    assert.deepEqual(await recorded(), [{ matrix_id: who }]);
  });

  await t.test("a recorded customer Stripe no longer holds is tolerated and dropped from the record", async () => {
    const { who, subId } = await fresh();
    const cusLive = `cus_${RUN}_${seq}_live`, cusGone = `cus_${RUN}_${seq}_gone`;
    const current = new Map([[subId, { ...snapshot(subId, who, "active"), customer: cusLive } as Stripe.Subscription]]);
    await pool.query(
      `INSERT INTO site.subscriptions (matrix_id, stripe_customer_id, updated_at) VALUES ($1, $2, NOW())`, [who, cusGone]);
    await pool.query(`INSERT INTO site.stripe_customers (stripe_customer_id, matrix_id) VALUES ($1, $2)`, [cusGone, who]);
    const { syncSubscription } = createSubscriptionSync({ pool, stripe: () => fakeStripe(current, [], new Set([cusGone])).stripe });
    await syncSubscription({ id: subId }, T);
    assert.deepEqual(await row(who), { status: "active", tier: "supporter" });
    assert.equal(await customerOf(who), cusLive);
    const left = (await pool.query(`SELECT stripe_customer_id FROM site.stripe_customers WHERE matrix_id = $1 ORDER BY 1`, [who])).rows;
    assert.deepEqual(left, [{ stripe_customer_id: cusLive }]);
  });

  await t.test("a Stripe error other than resource_missing on a recorded customer still throws", async () => {
    const { who, subId } = await fresh();
    const cusLive = `cus_${RUN}_${seq}_live`, cusOther = `cus_${RUN}_${seq}_other`;
    const current = new Map([[subId, { ...snapshot(subId, who, "active"), customer: cusLive } as Stripe.Subscription]]);
    await pool.query(`INSERT INTO site.stripe_customers (stripe_customer_id, matrix_id) VALUES ($1, $2)`, [cusOther, who]);
    const { stripe } = fakeStripe(current);
    const realList = stripe.subscriptions.list.bind(stripe.subscriptions);
    (stripe.subscriptions as unknown as { list: unknown }).list = async (q: { customer: string; status?: string }) => {
      if (q.customer === cusOther) throw new Stripe.errors.StripeRateLimitError({ message: "slow down", statusCode: 429 });
      return realList(q as never);
    };
    const { syncSubscription } = createSubscriptionSync({ pool, stripe: () => stripe });
    await assert.rejects(syncSubscription({ id: subId }, T), { type: "StripeRateLimitError" });
    assert.equal(await row(who), undefined, "nothing written from a partial view");
    const kept = (await pool.query(`SELECT 1 FROM site.stripe_customers WHERE stripe_customer_id = $1`, [cusOther])).rowCount;
    assert.equal(kept, 1, "a customer is dropped only on resource_missing");
  });

  await t.test("a customer whose subscriptions are all ended is written as the newest one, cancelled", async () => {
    const { who, subId } = await fresh();
    const a = `${subId}_a`, b = `${subId}_b`;
    const current = new Map([
      [a, snapshot(a, who, "canceled", T - 86_400)],
      [b, snapshot(b, who, "canceled", T)],
    ]);
    const { syncSubscription } = createSubscriptionSync({ pool, stripe: () => fakeStripe(current).stripe });
    await syncSubscription({ id: a }, T);
    assert.deepEqual(await row(who), { status: "canceled", tier: null });
    assert.equal(await subIdOf(who), b);
  });

  await t.test("overlapping processing: a slow stale delivery cannot land after the cancellation", async () => {
    const { who, subId } = await fresh();
    const current = new Map([[subId, snapshot(subId, who, "active")]]);
    // The first retrieve reads "active" and returns slowly; the second reads the
    // cancellation and returns fast.
    const { stripe } = fakeStripe(current, [120, 5]);
    const { syncSubscription } = createSubscriptionSync({ pool, stripe: () => stripe });
    const first = syncSubscription(snapshot(subId, who, "active"), T);
    await new Promise((r) => setTimeout(r, 20));
    current.set(subId, snapshot(subId, who, "canceled"));
    const second = syncSubscription(snapshot(subId, who, "canceled"), T);
    await Promise.all([first, second]);
    assert.deepEqual(await row(who), { status: "canceled", tier: null });
  });

  // ── Month one is credited from its invoice, not from the subscription's state (A1-01) ──
  //
  // Stripe does not order deliveries. When checkout.session.completed is stamped a second after
  // customer.subscription.created and processed first, the recency gate drops .created; while the
  // "X subscribed" card hung off .created's write, that lost month one (no card, no bar credit, no
  // support_events row). The card now comes from `invoice.paid` with billing_reason =
  // subscription_create, spendId `sub:<subscription id>` (stream-api's ledger dedups on it), so no
  // ordering of the state events can lose it.
  const invoice = (subId: string, reason: string, paid: number, id = `in_${subId}_${reason}`) => ({
    id, billing_reason: reason, amount_paid: paid, currency: "usd", customer: null,
    parent: { subscription_details: { subscription: subId } },
  });
  const withInvoices = (stripe: Stripe, paidCount: number) => {
    (stripe as unknown as { invoices: unknown }).invoices = {
      list: async () => ({ object: "list", has_more: false, data: Array.from({ length: paidCount }, () => ({ amount_paid: 500 })) }),
    };
    return stripe;
  };

  await t.test("a customer.subscription.created delivered after its checkout.session.completed still credits month one once", async () => {
    const { who, subId } = await fresh();
    const current = new Map([[subId, snapshot(subId, who, "active")]]);
    const { syncSubscription, paidInvoiceCard } = createSubscriptionSync({ pool, stripe: () => fakeStripe(current).stripe });
    // checkout.session.completed, stamped one second later, processed first…
    assert.ok(await syncSubscription({ id: subId }, T + 1));
    // …then customer.subscription.created: dropped by the recency gate, exactly as before.
    assert.equal(await syncSubscription({ id: subId }, T), null, "the out-of-order gate is unchanged");
    assert.deepEqual(await row(who), { status: "active", tier: "supporter" });
    // The first invoice still credits month one, with the subscription-derived spendId.
    const card = await paidInvoiceCard(invoice(subId, "subscription_create", 500));
    assert.deepEqual(card, { matrixId: who, spendId: `sub:${subId}`, months: 1, amount: 500, currency: "usd", priceId: PRICE });
  });

  await t.test("an incomplete subscription that later goes active still credits month one once", async () => {
    const { who, subId } = await fresh();
    const current = new Map([[subId, snapshot(subId, who, "incomplete")]]);
    const { syncSubscription, paidInvoiceCard } = createSubscriptionSync({ pool, stripe: () => fakeStripe(current).stripe });
    await syncSubscription({ id: subId }, T); // .created, snapshot incomplete (a delayed method)
    current.set(subId, snapshot(subId, who, "active"));
    await syncSubscription({ id: subId }, T + 30); // .updated → active
    const card = await paidInvoiceCard(invoice(subId, "subscription_create", 500));
    assert.equal(card?.spendId, `sub:${subId}`);
    assert.equal(card?.months, 1);
  });

  await t.test("retry: a redelivered invoice.paid yields the same card, so stream-api credits it once", async () => {
    const { who, subId } = await fresh();
    const current = new Map([[subId, snapshot(subId, who, "active")]]);
    const { paidInvoiceCard } = createSubscriptionSync({ pool, stripe: () => fakeStripe(current).stripe });
    const inv = invoice(subId, "subscription_create", 500);
    assert.deepEqual(await paidInvoiceCard(inv), await paidInvoiceCard(inv));
  });

  await t.test("restart: a new process given the same invoice derives the same spendId", async () => {
    const { who, subId } = await fresh();
    const current = new Map([[subId, snapshot(subId, who, "active")]]);
    const before = await createSubscriptionSync({ pool, stripe: () => fakeStripe(current).stripe }).paidInvoiceCard(invoice(subId, "subscription_create", 500));
    const after = await createSubscriptionSync({ pool, stripe: () => fakeStripe(current).stripe }).paidInvoiceCard(invoice(subId, "subscription_create", 500));
    assert.equal(after?.spendId, before?.spendId);
    assert.equal(after?.spendId, `sub:${subId}`);
  });

  await t.test("a trial's $0 first invoice credits nothing; its first charge is the cycle invoice, month one", async () => {
    const { who, subId } = await fresh();
    const trial = { ...snapshot(subId, who, "active"), trial_end: T } as Stripe.Subscription;
    const current = new Map([[subId, trial]]);
    const { paidInvoiceCard } = createSubscriptionSync({ pool, stripe: () => withInvoices(fakeStripe(current).stripe, 2) });
    assert.equal(await paidInvoiceCard(invoice(subId, "subscription_create", 0)), null, "a trial is not a payment");
    const cycle = await paidInvoiceCard(invoice(subId, "subscription_cycle", 500, `in_${subId}_c1`));
    assert.deepEqual(cycle, { matrixId: who, spendId: `renewal:in_${subId}_c1`, months: 1, amount: 500, currency: "usd", priceId: PRICE });
  });

  await t.test("a renewal keeps its invoice-derived spendId and its tenure", async () => {
    const { who, subId } = await fresh();
    const current = new Map([[subId, snapshot(subId, who, "active")]]);
    const { paidInvoiceCard } = createSubscriptionSync({ pool, stripe: () => withInvoices(fakeStripe(current).stripe, 3) });
    const r = await paidInvoiceCard(invoice(subId, "subscription_cycle", 500, `in_${subId}_c2`));
    assert.equal(r?.spendId, `renewal:in_${subId}_c2`);
    assert.equal(r?.months, 3);
    assert.equal(await paidInvoiceCard(invoice(subId, "subscription_update", 120)), null, "a proration is not a month");
  });

  // ── Stripe's final retry (area-1 round 2, A1-08 / P07; k 2026-10-25) ──
  //
  // past_due entitles with grace on the period end, and Stripe moves the period end on every
  // unpaid cycle, so with the Dashboard's last-retry action set to "leave past_due" a subscriber who
  // stopped paying kept Supporter for ever. When Stripe has given up (the latest invoice is unpaid
  // and has no next attempt), the subscription reads as cancelled, written by the one transition
  // function; Stripe's "cancel" and "mark unpaid" endings already end access. The replayed sequence:
  const recordOf = async (subId: string) => (await pool.query<{ status: string; provider_status: string }>(
    `SELECT status, provider_status FROM site.subscription_records WHERE external_id = $1`, [subId])).rows[0];
  const pastDue = (subId: string, who: string, latest: string) =>
    ({ ...snapshot(subId, who, "past_due"), latest_invoice: latest }) as Stripe.Subscription;
  const withLatest = (stripe: Stripe, invoices: Map<string, { status: string; next_payment_attempt: number | null }>) => {
    (stripe as unknown as { invoices: unknown }).invoices = {
      retrieve: async (id: string) => ({ id, object: "invoice", ...invoices.get(id)! }),
      list: async () => ({ object: "list", has_more: false, data: [] }),
    };
    return stripe;
  };

  await t.test("final retry: renewal fails, Stripe retries, gives up — access ends; a later redelivery keeps it ended", async () => {
    const { who, subId } = await fresh();
    const inv = `in_${subId}_r1`;
    const invoices = new Map<string, { status: string; next_payment_attempt: number | null }>([[inv, { status: "open", next_payment_attempt: 1_800_100_000 }]]);
    const current = new Map([[subId, snapshot(subId, who, "active")]]);
    const { syncSubscription } = createSubscriptionSync({ pool, stripe: () => withLatest(fakeStripe(current).stripe, invoices) });
    await syncSubscription({ id: subId }, T);
    // The renewal charge fails; Stripe will retry (invoice.payment_failed, next attempt set).
    current.set(subId, pastDue(subId, who, inv));
    await syncSubscription({ id: subId }, T + 10);
    assert.deepEqual(await recordOf(subId), { status: "past_due", provider_status: "past_due" }, "still retrying: past_due, entitled with grace");
    // The last retry fails: no next attempt. Stripe leaves the subscription past_due.
    invoices.set(inv, { status: "open", next_payment_attempt: null });
    await syncSubscription({ id: subId }, T + 20);
    assert.equal((await recordOf(subId))!.status, "ended", "Stripe gave up: the subscription is cancelled here");
    assert.deepEqual(await row(who), { status: "canceled", tier: null });
    // retry/restart: a later customer.subscription.updated (Stripe still says past_due) changes nothing.
    await syncSubscription({ id: subId }, T + 30);
    await createSubscriptionSync({ pool, stripe: () => withLatest(fakeStripe(current).stripe, invoices) }).syncSubscription({ id: subId }, T + 30);
    assert.equal((await recordOf(subId))!.status, "ended");
    // The subscriber pays the open invoice after all: Stripe makes it active again, and so do we.
    invoices.set(inv, { status: "paid", next_payment_attempt: null });
    current.set(subId, snapshot(subId, who, "active"));
    await syncSubscription({ id: subId }, T + 40);
    assert.equal((await recordOf(subId))!.status, "active");
  });

  await t.test("Stripe's own endings: cancel ends access, mark-unpaid ends access", async () => {
    for (const ending of ["canceled", "unpaid"] as const) {
      const { who, subId } = await fresh();
      const current = new Map([[subId, snapshot(subId, who, "active")]]);
      const { syncSubscription } = createSubscriptionSync({ pool, stripe: () => fakeStripe(current).stripe });
      await syncSubscription({ id: subId }, T);
      current.set(subId, snapshot(subId, who, ending));
      await syncSubscription({ id: subId }, T + 10);
      const e = await entitlementOf(pool, who, ["stripe", "paypal"]);
      assert.equal(e.supporter, false, `${ending}: no access`);
    }
  });
});

// The webhook re-reads the subscription on invoice.payment_failed, so Stripe's last retry ends it
// even when the Dashboard's last-retry action sends no status change (A1-08). The route imports pg
// and Stripe at load, so this is a scan; the decision itself runs above.
test("wiring: invoice.payment_failed re-syncs the invoice's subscription", () => {
  const src = readFileSync(new URL("../api/billing/webhook/route.ts", import.meta.url), "utf8");
  assert.match(src.trimEnd().slice(-120), /invalidateTier\(matrixId\);\s*\}$/, "vacuity anchor: the route was read to its end");
  assert.match(src, /case "invoice\.payment_failed": \{\s*await handleInvoicePaymentFailed\(event\);[\s\S]{0,600}if \(subId\) await syncSubscription\(\{ id: subId \}, event\.created\);/);
});
