// The PayPal subscription adapter on the REAL schema (subscription sources S3, spec §5.2, §8.2,
// §8.4, §13.2). PayPal and stream-api are fakes; the database is a replayed Postgres
// (SQL_PARSE_DATABASE_URL, the state.test.ts setup), because the stamp rule, the locks, the
// intents, the payment rows and the entitlement fragment are all SQL a mock pool could not check.
// Each case is named for what it proves, the restart and retry cases among them.
// Locally: SQL_PARSE_DATABASE_URL=… node --test app/lib/subscriptions/paypal.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createConcurrencyGate } from "../concurrencyGate.ts";
import type { ChatEventOutcome } from "../chatEventDelivery.ts";
import type { PaypalSale, PaypalSubscription } from "../paypalSubscriptions.ts";
import { createPaypalSubscriptions, newIntentId, type PaypalApi } from "./paypal.ts";
import { writeTransition } from "./state.ts";
import { stillBills } from "./entitlement.ts";
import type { Provider } from "./types.ts";

const DB_URL = process.env.SQL_PARSE_DATABASE_URL || "";
// Never production: only a throwaway on this machine (a shell may carry DATABASE_URL = prod).
const unsafe = !DB_URL || DB_URL === process.env.DATABASE_URL || !/@(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(DB_URL);
const skip = unsafe ? (process.env.CI ? false : "SQL_PARSE_DATABASE_URL unset or unsafe") : false;

const RUN = `pp${process.pid}x${Date.now().toString(36)}`;
const PLAN = "P-TESTPLANSUPPORTER01";
const OTHER_PLAN = "P-TESTPLANCHEAPER0001";
const SOURCES: Provider[] = ["stripe", "paypal"];
const DAY = 86_400_000;
const roomy = () => createConcurrencyGate({ maxConcurrent: 4, maxQueued: 10, maxWaitMs: 5000 });
let seq = 0;

type Card = Record<string, unknown>;

/** Every fake PayPal's subscriptions: a BILLING.SUBSCRIPTION.* event's resource IS the
 *  subscription, so `evt` gives it the custom_id PayPal holds, as a real delivery does. */
const ALL_FAKES: Map<string, PaypalSubscription>[] = [];
function billingResource(r: Record<string, unknown>): Record<string, unknown> {
  if ("custom_id" in r || typeof r.id !== "string") return r;
  const held = ALL_FAKES.map((m) => m.get(r.id as string)).find(Boolean);
  return held?.custom_id ? { ...r, custom_id: held.custom_id } : r;
}

/** A fake PayPal: subscriptions and sales by id, and what was asked of it. */
function fakePaypal() {
  const subs = new Map<string, PaypalSubscription>();
  const sales = new Map<string, PaypalSale>();
  ALL_FAKES.push(subs);
  const created: Array<{ planId: string; customId: string }> = [];
  const cancelled: string[] = [];
  let failCreate = false;
  const api: PaypalApi = {
    getSubscription: async (id) => (subs.has(id) ? structuredClone(subs.get(id)!) : null),
    createSubscription: async (a) => {
      if (failCreate) throw new Error("paypal create subscription: 500");
      const id = `I-${RUN}N${++seq}`;
      created.push(a);
      subs.set(id, { id, status: "APPROVAL_PENDING", plan_id: a.planId, custom_id: a.customId, billing_info: null });
      return { id, status: "APPROVAL_PENDING" };
    },
    cancelSubscription: async (id) => { cancelled.push(id); return { alreadyEnded: false }; },
    getSale: async (id) => (sales.has(id) ? structuredClone(sales.get(id)!) : null),
    plan: async (planId) => (planId === PLAN ? { planId, amount: 500, currency: "usd" } : "inactive"),
  };
  return { api, subs, sales, created, cancelled, failCreateOnce: (v: boolean) => { failCreate = v; } };
}

/** A fake stream-api: every card and every reversal, with a scripted answer. */
function fakeStreamApi() {
  const cards: Card[] = [];
  const reversals: Card[] = [];
  let next: ChatEventOutcome["outcome"] = "delivered";
  let refusedStatus = 400;
  return {
    cards, reversals,
    answerCardsWith: (o: ChatEventOutcome["outcome"], status = 400) => { next = o; refusedStatus = status; },
    deliver: async (p: Card): Promise<ChatEventOutcome> => {
      cards.push(p);
      if (next === "delivered") return { outcome: "delivered", body: {} };
      if (next === "refused") return { outcome: "refused", status: refusedStatus, body: refusedStatus >= 500 ? { error: "effects_failed" } : {} };
      if (next === "undelivered") return { outcome: "undelivered" };
      return { outcome: "unconfirmed" };
    },
    postReverse: async (b: Card) => { reversals.push(b); return new Response(JSON.stringify({ ok: true }), { status: 200 }); },
  };
}

const active = (id: string, custom: string | null, over: Partial<PaypalSubscription> = {}): PaypalSubscription => ({
  id, status: "ACTIVE", plan_id: PLAN, custom_id: custom, subscriber: { payer_id: "PAYERTEST01" },
  billing_info: { next_billing_time: new Date(Date.now() + 20 * DAY).toISOString(), failed_payments_count: 0, last_payment: { time: new Date(Date.now() - 10 * DAY).toISOString() } },
  ...over,
});

test("the PayPal subscription adapter, on a real database", { skip }, async (t) => {
  assert.ok(!unsafe, "SQL_PARSE_DATABASE_URL must point at a local throwaway database in CI");
  const pool = new Pool({ connectionString: DB_URL, max: 8 });
  const clean = async () => {
    await pool.query(`DELETE FROM site.payment_events WHERE event_id LIKE $1`, [`${RUN}%`]);
    await pool.query(`DELETE FROM site.subscription_events WHERE event_id LIKE $1`, [`${RUN}%`]);
    await pool.query(`DELETE FROM site.subscription_payments WHERE payment_id LIKE $1`, [`${RUN}%`]);
    await pool.query(`DELETE FROM site.subscription_records WHERE external_id LIKE $1`, [`I-${RUN}%`]);
    await pool.query(`DELETE FROM site.subscription_intents WHERE matrix_id LIKE $1`, [`@${RUN}%`]);
    await pool.query(`DELETE FROM site.users WHERE matrix_id LIKE $1`, [`@${RUN}%`]);
  };
  await clean();
  t.after(async () => { await clean(); await pool.end(); });

  const viewer = async () => {
    const who = `@${RUN}-${++seq}:site.test`;
    await pool.query(`INSERT INTO site.users (matrix_id) VALUES ($1)`, [who]);
    return who;
  };
  const evt = (type: string, resource: unknown, at: number) => ({
    id: `${RUN}WH${++seq}`, event_type: type, create_time: new Date(at).toISOString(),
    resource: type.startsWith("BILLING.SUBSCRIPTION.") ? billingResource(resource as Record<string, unknown>) : resource,
  });
  const record = async (id: string) =>
    (await pool.query(`SELECT matrix_id, tier, status, provider_status, renews, period_end, access_until, source_event_at, account_ref
      FROM site.subscription_records WHERE provider = 'paypal' AND external_id = $1`, [id])).rows[0];
  const payments = async (subId: string) =>
    (await pool.query(`SELECT p.payment_id, p.spend_id, p.credit, p.amount_cents, p.net_cents, p.refunded_at, p.reversed_at
      FROM site.subscription_payments p JOIN site.subscription_records r ON r.id = p.record_id
      WHERE r.external_id = $1 ORDER BY p.paid_at`, [subId])).rows;
  const entitled = async (who: string) =>
    (await pool.query(`SELECT EXISTS (SELECT 1 FROM site.subscription_records r WHERE r.matrix_id = $1 AND r.status IN ('active','past_due')
      AND r.tier IS NOT NULL AND (r.access_until IS NULL OR r.access_until > now())) AS e`, [who])).rows[0].e as boolean;

  /** One adapter instance — a "process". `restart()` in a case = a fresh one over a fresh pool. */
  function adapter(pp = fakePaypal(), sa = fakeStreamApi(), over: { plans?: Record<string, string>; checkoutBudget?: ReturnType<typeof roomy>; db?: Pool } = {}) {
    const effects: Array<{ viewer: string; supporter: boolean }> = [];
    const a = createPaypalSubscriptions({
      pool: over.db ?? pool, api: pp.api, plans: () => over.plans ?? { supporter: PLAN },
      deliver: sa.deliver, postReverse: sa.postReverse,
      identity: async (m) => ({ username: m.slice(1, 8), usernameColor: null, usernameStyle: null }),
      effects: async (v, r) => { effects.push({ viewer: v, supporter: r.after.supporter }); },
      recordPaymentEvent: async (row) => {
        await pool.query(`INSERT INTO site.payment_events (provider, event_id, event_type, occurred_at, charge_id, subscription_id, matrix_id, kind, amount_cents, currency, outcome)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (event_id) DO NOTHING`,
          [row.provider, row.eventId, row.eventType, row.occurredAt, row.chargeId, row.subscriptionId, row.matrixId, row.kind, row.amountCents, row.currency, row.outcome]);
      },
      webhookBudget: roomy(), checkoutBudget: over.checkoutBudget ?? roomy(), sources: () => SOURCES,
    });
    return { a, pp, sa, effects };
  }

  /** A viewer who started a PayPal subscribe: the intent, and the subscription PayPal created. */
  async function subscribed() {
    const who = await viewer();
    const h = adapter();
    const r = await h.a.startSubscribe(who, { tier: "supporter", alsoElsewhere: false });
    assert.ok(r.ok);
    return { who, subId: (r as { subscriptionId: string }).subscriptionId, ...h };
  }

  const sale = (subId: string, over: Partial<PaypalSale> = {}): PaypalSale => ({
    id: `${RUN}S${++seq}`, state: "completed", amount: { total: "5.00", currency: "USD" },
    transaction_fee: { value: "0.67", currency: "USD" }, billing_agreement_id: subId, create_time: new Date().toISOString(), ...over,
  });

  await t.test("subscribe start writes an intent bound to the subscription PayPal created, and grants nothing", async () => {
    const { who, subId, pp, effects } = await subscribed();
    const intent = (await pool.query(`SELECT id, tier, plan_id, external_id FROM site.subscription_intents WHERE matrix_id = $1`, [who])).rows;
    assert.equal(intent.length, 1);
    assert.match(intent[0].id, /^si_[0-9A-Za-z]{22}$/);
    assert.deepEqual([intent[0].plan_id, intent[0].external_id], [PLAN, subId]);
    assert.deepEqual(pp.created, [{ planId: PLAN, customId: intent[0].id }], "custom_id is the server-minted intent id");
    assert.equal(await record(subId), undefined, "no record until PayPal's webhook");
    assert.equal(effects.length, 0);
  });

  await t.test("a PayPal create that fails leaves no intent behind", async () => {
    const who = await viewer();
    const h = adapter();
    h.pp.failCreateOnce(true);
    await assert.rejects(h.a.startSubscribe(who, { tier: "supporter", alsoElsewhere: false }), /500/);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM site.subscription_intents WHERE matrix_id = $1`, [who])).rows[0].n, 0);
  });

  await t.test("ACTIVATED writes the viewer's record from PayPal's state, entitles, and runs the effects", async () => {
    const { who, subId, pp, a, effects } = await subscribed();
    const custom = pp.subs.get(subId)!.custom_id!;
    pp.subs.set(subId, active(subId, custom));
    await a.onSubscriptionEvent(evt("BILLING.SUBSCRIPTION.ACTIVATED", { id: subId, status: "APPROVAL_PENDING" }, Date.now()));
    const r = await record(subId);
    assert.deepEqual([r.matrix_id, r.tier, r.status, r.renews, r.account_ref], [who, "supporter", "active", true, "PAYERTEST01"]);
    const want = new Date(pp.subs.get(subId)!.billing_info!.next_billing_time!).getTime() + 7 * DAY;
    assert.equal(new Date(r.access_until).getTime(), want, "access = next billing time + the grace days");
    assert.equal(await entitled(who), true);
    assert.deepEqual(effects, [{ viewer: who, supporter: true }]);
    const audit = (await pool.query(`SELECT outcome FROM site.subscription_events WHERE provider = 'paypal' AND external_id = $1`, [subId])).rows;
    assert.deepEqual(audit.map((x) => x.outcome), ["applied"]);
  });

  await t.test("CANCELLED arriving BEFORE ACTIVATED: the final state is cancelled-until-the-paid-period-ends", async () => {
    const { who, subId, pp, a } = await subscribed();
    const custom = pp.subs.get(subId)!.custom_id!;
    const lastPaid = new Date(Date.now() - 5 * DAY);
    // PayPal now says CANCELLED, with no next billing time (it never bills again).
    pp.subs.set(subId, active(subId, custom, { status: "CANCELLED", billing_info: { next_billing_time: null, failed_payments_count: 0, last_payment: { time: lastPaid.toISOString() } } }));
    const t0 = Date.now();
    await a.onSubscriptionEvent(evt("BILLING.SUBSCRIPTION.CANCELLED", { id: subId }, t0 + 1000));
    await a.onSubscriptionEvent(evt("BILLING.SUBSCRIPTION.ACTIVATED", { id: subId }, t0)); // older: dropped
    const r = await record(subId);
    assert.deepEqual([r.status, r.provider_status, r.renews], ["active", "CANCELLED", false]);
    const monthOn = new Date(lastPaid); monthOn.setUTCMonth(monthOn.getUTCMonth() + 1);
    assert.ok(Math.abs(new Date(r.access_until).getTime() - monthOn.getTime()) < 3 * DAY, "access runs to a month after the last payment");
    assert.equal(new Date(r.source_event_at).getTime(), t0 + 1000, "the CANCELLED stamp stands");
    assert.equal(await entitled(who), true, "D9: a cancel keeps what was paid for");
    assert.equal(await stillBills(pool, who), false, "a cancelled PayPal subscription no longer blocks account deletion");
  });

  await t.test("F7: ACTIVATED then CANCELLED with next_billing_time GONE (as the sandbox showed): access runs to the record's own end", async () => {
    const { subId, pp, a } = await subscribed();
    const custom = pp.subs.get(subId)!.custom_id!;
    pp.subs.set(subId, active(subId, custom));
    const next = pp.subs.get(subId)!.billing_info!.next_billing_time!;
    const t0 = Date.now();
    await a.onSubscriptionEvent(evt("BILLING.SUBSCRIPTION.ACTIVATED", { id: subId }, t0));
    pp.subs.set(subId, active(subId, custom, { status: "CANCELLED", billing_info: { next_billing_time: null, failed_payments_count: 0, last_payment: { time: new Date(Date.now() - 10 * DAY).toISOString() } } }));
    await a.onSubscriptionEvent(evt("BILLING.SUBSCRIPTION.CANCELLED", { id: subId }, t0 + 1000));
    const r = await record(subId);
    assert.deepEqual([r.status, r.renews], ["active", false]);
    assert.equal(new Date(r.access_until).getTime(), new Date(next).getTime(), "no grace on a seen cancel");
  });

  await t.test("SUSPENDED → paused: no perks; a failed payment on ACTIVE → past_due, still entitled", async () => {
    const { who, subId, pp, a } = await subscribed();
    const custom = pp.subs.get(subId)!.custom_id!;
    const lastPaid = new Date(Date.now() - 20 * DAY);
    pp.subs.set(subId, active(subId, custom, { billing_info: { next_billing_time: new Date(Date.now() + 90 * DAY).toISOString(), failed_payments_count: 1, last_payment: { time: lastPaid.toISOString() } } }));
    await a.onSubscriptionEvent(evt("BILLING.SUBSCRIPTION.PAYMENT.FAILED", { id: subId }, Date.now()));
    assert.equal((await record(subId)).status, "past_due");
    assert.equal(await entitled(who), true, "D8: PayPal is retrying");
    const monthOn = new Date(lastPaid); monthOn.setUTCMonth(monthOn.getUTCMonth() + 1);
    assert.ok(Math.abs(new Date((await record(subId)).access_until).getTime() - (monthOn.getTime() + 7 * DAY)) < 3 * DAY,
      "past_due access ends a month after the last completed payment + grace, not at the far next billing time");
    pp.subs.set(subId, active(subId, custom, { status: "SUSPENDED" }));
    await a.onSubscriptionEvent(evt("BILLING.SUBSCRIPTION.SUSPENDED", { id: subId }, Date.now() + 1000));
    assert.equal((await record(subId)).status, "paused");
    assert.equal(await entitled(who), false);
  });

  await t.test("attack: a subscription made from the public client id with no intent writes NOTHING — no row, no card, no credit — and a foreign custom_id is not even read from PayPal", async () => {
    const h = adapter();
    let reads = 0;
    const get = h.pp.api.getSubscription;
    h.pp.api.getSubscription = async (id) => { reads++; return get(id); };
    for (const custom of [null, "anything-at-all"]) {
      const subId = `I-${RUN}U${++seq}`;
      h.pp.subs.set(subId, active(subId, custom));
      await h.a.onSubscriptionEvent(evt("BILLING.SUBSCRIPTION.CREATED", { id: subId, ...(custom ? { custom_id: custom } : {}) }, Date.now()));
      assert.equal(await record(subId), undefined, `custom_id ${custom}`);
    }
    assert.equal(reads, 0, "dropped before a connection or a PayPal read");
    // An intent-SHAPED custom_id naming no intent: still nothing written; its sale sends no card.
    const subId = `I-${RUN}U${++seq}`;
    h.pp.subs.set(subId, active(subId, newIntentId()));
    await h.a.onSubscriptionEvent(evt("BILLING.SUBSCRIPTION.ACTIVATED", { id: subId }, Date.now()));
    await h.a.onSaleCompleted(evt("PAYMENT.SALE.COMPLETED", sale(subId), Date.now()));
    assert.equal(await record(subId), undefined);
    assert.equal(h.sa.cards.length, 0, "no card, no bar credit");
    assert.equal(h.effects.length, 0);
  });

  await t.test("attack: a payment no viewer of ours holds never sends a card (an unclaimed record's sale is refused credit)", async () => {
    const h = adapter();
    const subId = `I-${RUN}N${++seq}`;
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await writeTransition(c, { via: "webhook", viewer: null, sources: SOURCES, observations: [{
        provider: "paypal", externalId: subId, tier: "supporter", status: "active", providerStatus: "ACTIVE",
        renews: true, periodEnd: null, accessUntil: null, observedAt: new Date(Date.now() - 60_000) }] });
      await c.query("COMMIT");
    } finally { c.release(); }
    h.pp.subs.set(subId, active(subId, null));
    await h.a.onSaleCompleted(evt("PAYMENT.SALE.COMPLETED", sale(subId), Date.now()));
    assert.equal(h.sa.cards.length, 0);
    assert.equal((await payments(subId))[0].credit, "refused");
  });

  await t.test("attack: a sale below the price it was SOLD at (an inline price override, sandbox F9) gets no card and no credit — on the original path, a retry and a restart", async () => {
    const { who, subId, pp, sa, a } = await subscribed();
    assert.deepEqual((await pool.query(`SELECT price_cents, currency FROM site.subscription_intents WHERE matrix_id = $1`, [who])).rows,
      [{ price_cents: 500, currency: "usd" }], "the subscribe stored the price it sold at");
    pp.subs.set(subId, active(subId, pp.subs.get(subId)!.custom_id!));
    const e = evt("PAYMENT.SALE.COMPLETED", sale(subId, { amount: { total: "0.01", currency: "USD" }, transaction_fee: null }), Date.now());
    await a.onSaleCompleted(e);
    await a.onSaleCompleted(e); // PayPal's retry
    const fresh = new Pool({ connectionString: DB_URL, max: 2 });
    try { await adapter(pp, sa, { db: fresh }).a.onSaleCompleted(e); } finally { await fresh.end(); } // after a restart
    assert.equal(sa.cards.length, 0, "a $0.01 subscription is not celebrated as a $5 one");
    assert.equal((await payments(subId))[0].credit, "refused");
  });

  await t.test("the owner RAISES the price: an existing subscriber's renewal at the price they were sold is still credited and carded", async () => {
    const { subId, pp, sa } = await subscribed();
    pp.subs.set(subId, active(subId, pp.subs.get(subId)!.custom_id!));
    const raised = adapter(pp, sa);
    raised.pp.api.plan = async (planId) => ({ planId, amount: 800, currency: "usd" });
    await raised.a.onSaleCompleted(evt("PAYMENT.SALE.COMPLETED", sale(subId), Date.now()));
    assert.equal(sa.cards.length, 1);
    assert.equal((await payments(subId))[0].credit, "landed");
  });

  await t.test("the owner DEACTIVATES the old plan: renewals on it are credited, never thrown until PayPal gives up", async () => {
    const { subId, pp, sa } = await subscribed();
    pp.subs.set(subId, active(subId, pp.subs.get(subId)!.custom_id!));
    const gone = adapter(pp, sa);
    gone.pp.api.plan = async () => "inactive";
    await gone.a.onSaleCompleted(evt("PAYMENT.SALE.COMPLETED", sale(subId), Date.now()));
    assert.equal((await payments(subId))[0].credit, "landed");
    assert.equal(sa.cards.length, 1);
  });

  await t.test("an intent from before v164 (no stored price) falls back to the plan's current price, and still refuses $0.01", async () => {
    const { who, subId, pp, sa, a } = await subscribed();
    await pool.query(`UPDATE site.subscription_intents SET price_cents = NULL, currency = NULL WHERE matrix_id = $1`, [who]);
    pp.subs.set(subId, active(subId, pp.subs.get(subId)!.custom_id!));
    await a.onSaleCompleted(evt("PAYMENT.SALE.COMPLETED", sale(subId, { amount: { total: "0.01", currency: "USD" }, transaction_fee: null }), Date.now()));
    assert.equal(sa.cards.length, 0);
    assert.equal((await payments(subId))[0].credit, "refused");
  });

  const oldIntent = async (who: string) =>
    pool.query(`UPDATE site.subscription_intents SET price_cents = NULL, currency = NULL WHERE matrix_id = $1`, [who]);

  await t.test("attack (fail closed): no stored price and the plan read FAILS → 500, nothing credited; the redelivery credits once PayPal answers — on a retry and after a restart", async () => {
    const { who, subId, pp, sa, a } = await subscribed();
    await oldIntent(who);
    pp.subs.set(subId, active(subId, pp.subs.get(subId)!.custom_id!));
    const working = pp.api.plan;
    pp.api.plan = async () => { throw new Error("paypal get plan: 503"); };
    const e = evt("PAYMENT.SALE.COMPLETED", sale(subId), Date.now());
    await assert.rejects(a.onSaleCompleted(e), /503/);
    await assert.rejects(a.onSaleCompleted(e), /503/, "PayPal's retry while PayPal is still down");
    assert.equal(sa.cards.length, 0, "no card without a floor");
    assert.equal((await payments(subId))[0].credit, "pending", "kept for the redelivery, not refused");
    pp.api.plan = working;
    const fresh = new Pool({ connectionString: DB_URL, max: 2 });
    try { await adapter(pp, sa, { db: fresh }).a.onSaleCompleted(e); } finally { await fresh.end(); } // after a restart
    await a.onSaleCompleted(e); // and one more redelivery
    assert.equal(sa.cards.length, 1, "credited once");
    assert.equal((await payments(subId))[0].credit, "landed");
  });

  await t.test("attack (fail closed): no stored price and the plan INACTIVE → refused credit with a CHECK BY HAND note, no card — on a retry too", async () => {
    const { who, subId, pp, sa, a } = await subscribed();
    await oldIntent(who);
    pp.subs.set(subId, active(subId, pp.subs.get(subId)!.custom_id!));
    pp.api.plan = async () => "inactive";
    const errors: string[] = [];
    const log = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
    try {
      const e = evt("PAYMENT.SALE.COMPLETED", sale(subId), Date.now());
      await a.onSaleCompleted(e);
      await a.onSaleCompleted(e);
    } finally { console.error = log; }
    assert.equal(sa.cards.length, 0);
    assert.equal((await payments(subId))[0].credit, "refused");
    assert.ok(errors.some((l) => /no price to hold it to[\s\S]*inactive or gone[\s\S]*CHECK BY HAND/.test(l)), errors.join("\n"));
  });

  await t.test("an older intent given its price (as a back-fill would) is credited at it, with the plan gone", async () => {
    const { who, subId, pp, sa, a } = await subscribed();
    await pool.query(`UPDATE site.subscription_intents SET price_cents = 500, currency = 'usd' WHERE matrix_id = $1`, [who]);
    pp.subs.set(subId, active(subId, pp.subs.get(subId)!.custom_id!));
    pp.api.plan = async () => "inactive";
    await a.onSaleCompleted(evt("PAYMENT.SALE.COMPLETED", sale(subId), Date.now()));
    assert.equal(sa.cards.length, 1);
    assert.equal((await payments(subId))[0].credit, "landed");
  });

  await t.test("attack: never paid, then cancelled, gives no access — on the original path, a retry and a restart", async () => {
    const { who, subId, pp, a } = await subscribed();
    pp.subs.set(subId, active(subId, pp.subs.get(subId)!.custom_id!, { status: "CANCELLED",
      billing_info: { next_billing_time: new Date(Date.now() + 30 * DAY).toISOString(), failed_payments_count: 0, last_payment: null } }));
    const e = evt("BILLING.SUBSCRIPTION.CANCELLED", { id: subId }, Date.now());
    await a.onSubscriptionEvent(e);
    await a.onSubscriptionEvent(e);
    const fresh = new Pool({ connectionString: DB_URL, max: 2 });
    try { await adapter(pp, undefined, { db: fresh }).a.onSubscriptionEvent(e); } finally { await fresh.end(); }
    assert.equal((await record(subId)).status, "ended");
    assert.equal(await entitled(who), false);
  });

  await t.test("attack: the owner moves the tier to a new plan between subscribe and webhook — the intent's tier stands, so a paying viewer is credited and entitled", async () => {
    const { who, subId, pp, sa } = await subscribed();
    pp.subs.set(subId, active(subId, pp.subs.get(subId)!.custom_id!));
    const moved = adapter(pp, sa, { plans: { supporter: OTHER_PLAN } });
    await moved.a.onSaleCompleted(evt("PAYMENT.SALE.COMPLETED", sale(subId), Date.now()));
    assert.deepEqual([(await record(subId)).tier, (await record(subId)).status], ["supporter", "active"]);
    assert.equal(await entitled(who), true);
    assert.equal(sa.cards.length, 1, "the payment is credited, not silently dropped");
  });

  await t.test("attack: a subscription of a DELETED account is cancelled at PayPal — its record's account, or an intent deletion erased", async () => {
    const { who, subId, pp, a } = await subscribed();
    await a.onSubscriptionEvent(evt("BILLING.SUBSCRIPTION.CREATED", { id: subId }, Date.now()));
    await pool.query(`UPDATE site.users SET deleted_at = now() WHERE matrix_id = $1`, [who]);
    pp.subs.set(subId, active(subId, pp.subs.get(subId)!.custom_id!)); // approved after the deletion
    await a.onSubscriptionEvent(evt("BILLING.SUBSCRIPTION.ACTIVATED", { id: subId }, Date.now() + 1000));
    assert.deepEqual(pp.cancelled, [subId]);
    // The intent erased with the account, the popup approved afterwards: no record, still cancelled.
    const second = await subscribed();
    await pool.query(`DELETE FROM site.subscription_intents WHERE matrix_id = $1`, [second.who]);
    second.pp.subs.set(second.subId, active(second.subId, second.pp.subs.get(second.subId)!.custom_id!));
    await second.a.onSubscriptionEvent(evt("BILLING.SUBSCRIPTION.ACTIVATED", { id: second.subId }, Date.now()));
    assert.equal(await record(second.subId), undefined);
    assert.deepEqual(second.pp.cancelled, [second.subId]);
    // Deleted mid-approval: the popup still open (APPROVAL_PENDING) — cancelled before it can charge.
    const third = await subscribed();
    await third.a.onSubscriptionEvent(evt("BILLING.SUBSCRIPTION.CREATED", { id: third.subId }, Date.now()));
    await pool.query(`UPDATE site.users SET deleted_at = now() WHERE matrix_id = $1`, [third.who]);
    await third.a.onSubscriptionEvent(evt("BILLING.SUBSCRIPTION.UPDATED", { id: third.subId }, Date.now() + 1000));
    assert.deepEqual(third.pp.cancelled, [third.subId], "APPROVAL_PENDING of a deleted account is cancelled too");
  });

  await t.test("attack: deletion mid-approval — the deletion step cancels the popup's subscription (no record yet) and every live one, writing nothing", async () => {
    const { who, subId, pp, a } = await subscribed(); // a popup open: an intent, no record
    const live = `I-${RUN}L${++seq}`;
    const ended = `I-${RUN}E${++seq}`;
    for (const [id, st] of [[live, "ACTIVE"], [ended, "EXPIRED"]] as const) {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await writeTransition(c, { via: "webhook", viewer: who, sources: SOURCES, observations: [{ provider: "paypal", externalId: id, tier: "supporter",
          status: st === "ACTIVE" ? "active" : "ended", providerStatus: st, renews: st === "ACTIVE", periodEnd: null, accessUntil: null, observedAt: new Date() }] });
        await c.query("COMMIT");
      } finally { c.release(); }
      pp.subs.set(id, active(id, null, { status: st }));
    }
    // Run on the caller's transaction client, as accountDeletion.ts does.
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      assert.deepEqual(await a.cancelForDeletion(who, tx), { cancelled: 2 });
      await tx.query("ROLLBACK");
    } finally { tx.release(); }
    assert.deepEqual(pp.cancelled.sort(), [live, subId].sort(), "the popup's and the live one; the ended one is left");
  });

  await t.test("a deletion never depends on PayPal for what cannot charge (an expired intent, an ended or cancelled-in-period record); when it must, a failure names PayPal", async () => {
    const { who, subId, pp, a } = await subscribed();
    await pool.query(`UPDATE site.subscription_intents SET expires_at = now() - interval '1 second' WHERE matrix_id = $1`, [who]);
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      for (const [id, status, renews] of [[`I-${RUN}X${++seq}`, "ended", false], [`I-${RUN}X${++seq}`, "active", false]] as const) {
        await writeTransition(c, { via: "webhook", viewer: who, sources: SOURCES, observations: [{ provider: "paypal", externalId: id, tier: "supporter",
          status, providerStatus: status === "ended" ? "EXPIRED" : "CANCELLED", renews, periodEnd: null, accessUntil: null, observedAt: new Date() }] });
      }
      await c.query("COMMIT");
    } finally { c.release(); }
    // PayPal's keys removed: any call would throw. None is made.
    pp.api.getSubscription = async () => { throw new Error("paypal token: 401"); };
    assert.deepEqual(await a.cancelForDeletion(who), { cancelled: 0 });
    // A subscription that CAN still charge, PayPal unreachable: PaypalCancelError, so the deletion
    // is refused with PayPal named and retried whole.
    await pool.query(`UPDATE site.subscription_intents SET expires_at = now() + interval '1 day' WHERE matrix_id = $1`, [who]);
    await assert.rejects(a.cancelForDeletion(who), (e: Error) => e.name === "PaypalCancelError" && e.message.includes(subId));
    const del = readFileSync(join(import.meta.dirname, "..", "accountDeletion.ts"), "utf8");
    assert.match(del, /cancelPaypalForDeletion\(matrixId, client\)/, "deletion passes its transaction client");
    assert.match(del, /if \(e instanceof PaypalCancelError\) \{\s*return \{ ok: false, status: 502, error: "PayPal could not be reached/);
  });

  await t.test("attack: two subscribe presses make ONE billed subscription — the open one is handed back, and once approved a third press is refused", async () => {
    const { who, subId, pp } = await subscribed();
    const h = adapter(pp);
    assert.deepEqual(await h.a.startSubscribe(who, { tier: "supporter", alsoElsewhere: false }), { ok: true, subscriptionId: subId });
    assert.equal(pp.created.length, 1, "PayPal was asked once");
    pp.subs.set(subId, { ...pp.subs.get(subId)!, status: "APPROVED" });
    assert.deepEqual(await h.a.startSubscribe(who, { tier: "supporter", alsoElsewhere: false }), { ok: false, status: 409, error: "subscribe_in_progress" });
    // Past the window, a new subscribe is a new one (the old one was abandoned or became a record).
    await pool.query(`UPDATE site.subscription_intents SET created_at = now() - interval '11 minutes' WHERE matrix_id = $1`, [who]);
    assert.ok((await h.a.startSubscribe(who, { tier: "supporter", alsoElsewhere: false })).ok);
    assert.equal(pp.created.length, 2);
  });

  await t.test("attack: tier 'toString' (an inherited property) offers no plan", async () => {
    const who = await viewer();
    assert.deepEqual(await adapter().a.startSubscribe(who, { tier: "toString" as never, alsoElsewhere: false }), { ok: false, status: 404, error: "not_offered" });
  });

  await t.test("a plan that is not one of paypal.plans is refused on first sight and nothing is written", async () => {
    const h = adapter();
    const subId = `I-${RUN}F${++seq}`;
    h.pp.subs.set(subId, active(subId, null, { plan_id: "P-FOREIGNPLAN000001" }));
    await h.a.onSubscriptionEvent(evt("BILLING.SUBSCRIPTION.ACTIVATED", { id: subId }, Date.now()));
    assert.equal(await record(subId), undefined);
  });

  await t.test("a plan different from the intent's is refused, even when the install sells it", async () => {
    const { who, subId, pp } = await subscribed();
    const h = adapter(pp, undefined, { plans: { supporter: OTHER_PLAN } });
    pp.subs.set(subId, active(subId, pp.subs.get(subId)!.custom_id!, { plan_id: OTHER_PLAN }));
    await h.a.onSubscriptionEvent(evt("BILLING.SUBSCRIPTION.ACTIVATED", { id: subId }, Date.now()));
    assert.equal(await record(subId), undefined);
    assert.equal(await entitled(who), false);
  });

  await t.test("a held record keeps its tier when the owner moves the tier to a new plan: a paying subscriber is never cut off", async () => {
    const { who, subId, pp, a } = await subscribed();
    pp.subs.set(subId, active(subId, pp.subs.get(subId)!.custom_id!));
    const t0 = Date.now();
    await a.onSubscriptionEvent(evt("BILLING.SUBSCRIPTION.ACTIVATED", { id: subId }, t0));
    const moved = adapter(pp, undefined, { plans: { supporter: OTHER_PLAN } });
    await moved.a.onSubscriptionEvent(evt("BILLING.SUBSCRIPTION.UPDATED", { id: subId }, t0 + 1000));
    const r = await record(subId);
    assert.deepEqual([r.tier, r.status], ["supporter", "active"]);
    assert.equal(new Date(r.source_event_at).getTime(), t0 + 1000, "the UPDATED read was written, not refused");
    assert.equal(await entitled(who), true);
  });

  await t.test("an intent never claims a second subscription", async () => {
    const { subId, pp, a } = await subscribed();
    const custom = pp.subs.get(subId)!.custom_id!;
    const second = `I-${RUN}T${++seq}`;
    pp.subs.set(second, active(second, custom));
    await a.onSubscriptionEvent(evt("BILLING.SUBSCRIPTION.ACTIVATED", { id: second }, Date.now()));
    assert.equal(await record(second), undefined, "the intent is bound to the first subscription; the second is nobody's and is not written");
  });

  await t.test("the first sale: one payment row, one paypal-sub card with PayPal's own net, access extended", async () => {
    const { who, subId, pp, sa, a } = await subscribed();
    pp.subs.set(subId, active(subId, pp.subs.get(subId)!.custom_id!));
    const s = sale(subId);
    await a.onSaleCompleted(evt("PAYMENT.SALE.COMPLETED", s, Date.now()));
    assert.equal(sa.cards.length, 1);
    const c = sa.cards[0]!;
    assert.deepEqual([c.kind, c.spendId, c.months, c.amount, c.currency, c.netUsd, c.subscriberMatrixId], ["sub", `paypal-sub:${subId}`, 1, 500, "usd", 4.33, who]);
    assert.deepEqual((await payments(subId)).map((p) => [p.spend_id, p.credit, p.net_cents]), [[`paypal-sub:${subId}`, "landed", 433]]);
    assert.equal(await entitled(who), true, "a sale reads the subscription and writes it, so access needs no ACTIVATED");
  });

  await t.test("a duplicate sale (a RETRY of the same delivery) → one payment row and one card", async () => {
    const { subId, pp, sa, a } = await subscribed();
    pp.subs.set(subId, active(subId, pp.subs.get(subId)!.custom_id!));
    const e = evt("PAYMENT.SALE.COMPLETED", sale(subId), Date.now());
    await a.onSaleCompleted(e);
    await a.onSaleCompleted(e);
    assert.equal((await payments(subId)).length, 1);
    assert.equal(sa.cards.length, 1);
  });

  await t.test("after a RESTART (a new process, a new pool) a redelivered sale writes nothing new and sends no second card", async () => {
    const { subId, pp, sa, a } = await subscribed();
    pp.subs.set(subId, active(subId, pp.subs.get(subId)!.custom_id!));
    const e = evt("PAYMENT.SALE.COMPLETED", sale(subId), Date.now());
    await a.onSaleCompleted(e);
    const fresh = new Pool({ connectionString: DB_URL, max: 2 });
    try {
      const again = adapter(pp, sa, { db: fresh });
      await again.a.onSaleCompleted(e);
    } finally { await fresh.end(); }
    assert.equal((await payments(subId)).length, 1);
    assert.equal(sa.cards.length, 1);
  });

  await t.test("a second sale is a paypal-renewal card with months = payments so far; no fee → PayPal's published rate", async () => {
    const { subId, pp, sa, a } = await subscribed();
    pp.subs.set(subId, active(subId, pp.subs.get(subId)!.custom_id!));
    await a.onSaleCompleted(evt("PAYMENT.SALE.COMPLETED", sale(subId, { create_time: new Date(Date.now() - 31 * DAY).toISOString() }), Date.now() - 31 * DAY));
    const s2 = sale(subId, { transaction_fee: null });
    await a.onSaleCompleted(evt("PAYMENT.SALE.COMPLETED", s2, Date.now()));
    const c = sa.cards[1]!;
    assert.deepEqual([c.spendId, c.months], [`paypal-renewal:${s2.id}`, 2]);
    assert.equal(c.netUsd, (500 - Math.round(500 * 0.0349 + 49)) / 100, "3.49% + $0.49");
  });

  await t.test("attack (availability): a stream-api briefly down — effects_failed, or 401/403 mid-restart — never strands a sale uncredited: 500, then one card and one credit on the redelivery", async () => {
    for (const status of [500, 401, 403]) {
      const { subId, pp, sa, a } = await subscribed();
      pp.subs.set(subId, active(subId, pp.subs.get(subId)!.custom_id!));
      const s = sale(subId);
      const e = evt("PAYMENT.SALE.COMPLETED", s, Date.now());
      sa.answerCardsWith("refused", status);
      await assert.rejects(a.onSaleCompleted(e), /did not take/, `${status} must be redelivered`);
      assert.equal((await payments(subId))[0].credit, "pending", `${status}: not stored as refused`);
      sa.answerCardsWith("delivered");
      await a.onSaleCompleted(e);
      assert.equal((await payments(subId))[0].credit, "landed");
      assert.equal(new Set(sa.cards.map((c) => c.spendId)).size, 1, "one spendId — one credit");
      // …and its refund now reverses it.
      await a.onSaleRefunded(evt("PAYMENT.SALE.REFUNDED", { id: `${RUN}RB${status}`, sale_id: s.id, amount: { total: "5.00" } }, Date.now()));
      assert.equal(sa.reversals.length, 1);
    }
  });

  await t.test("a genuine validation refusal (400) is final: refused, no retry, its refund reverses nothing", async () => {
    const { subId, pp, sa, a } = await subscribed();
    pp.subs.set(subId, active(subId, pp.subs.get(subId)!.custom_id!));
    const s = sale(subId);
    const e = evt("PAYMENT.SALE.COMPLETED", s, Date.now());
    sa.answerCardsWith("refused", 400);
    await a.onSaleCompleted(e);
    assert.equal((await payments(subId))[0].credit, "refused");
    await a.onSaleCompleted(e);
    assert.equal(sa.cards.length, 1, "a refused card is not sent again");
  });

  await t.test("a card stream-api did not confirm throws (500 → PayPal redelivers), and the redelivery sends it again", async () => {
    const { subId, pp, sa, a } = await subscribed();
    pp.subs.set(subId, active(subId, pp.subs.get(subId)!.custom_id!));
    const e = evt("PAYMENT.SALE.COMPLETED", sale(subId), Date.now());
    sa.answerCardsWith("unconfirmed");
    await assert.rejects(a.onSaleCompleted(e), /did not take/);
    assert.equal((await payments(subId))[0].credit, "pending");
    sa.answerCardsWith("delivered");
    await a.onSaleCompleted(e);
    assert.equal(sa.cards.length, 2);
    assert.equal(sa.cards[0]!.spendId, sa.cards[1]!.spendId, "the same spendId — /chat/event dedups it");
    assert.equal((await payments(subId))[0].credit, "landed");
  });

  await t.test("SALE.REFUNDED of a landed sale reverses it under its STORED spendId, its refund ref and its share", async () => {
    const { subId, pp, sa, a } = await subscribed();
    pp.subs.set(subId, active(subId, pp.subs.get(subId)!.custom_id!));
    const first = sale(subId, { create_time: new Date(Date.now() - 31 * DAY).toISOString() });
    const second = sale(subId);
    await a.onSaleCompleted(evt("PAYMENT.SALE.COMPLETED", first, Date.now() - 31 * DAY));
    await a.onSaleCompleted(evt("PAYMENT.SALE.COMPLETED", second, Date.now()));
    await a.onSaleRefunded(evt("PAYMENT.SALE.REFUNDED", { id: `${RUN}R1`, sale_id: first.id, amount: { total: "2.50", currency: "USD" } }, Date.now()));
    await a.onSaleRefunded(evt("PAYMENT.SALE.REFUNDED", { id: `${RUN}R2`, sale_id: second.id, amount: { total: "5.00", currency: "USD" } }, Date.now()));
    assert.deepEqual(sa.reversals, [
      { kind: "sub", spendId: `paypal-sub:${subId}`, ref: `paypal:sale-refund:${RUN}R1`, reason: "refund", refunded: 250, gross: 500 },
      { kind: "sub", spendId: `paypal-renewal:${second.id}`, ref: `paypal:sale-refund:${RUN}R2`, reason: "refund", refunded: 500, gross: 500 },
    ]);
    assert.ok((await payments(subId)).every((p) => p.refunded_at), "both rows stamped");
    const pe = (await pool.query(`SELECT kind, outcome FROM site.payment_events WHERE charge_id = $1`, [first.id])).rows;
    assert.deepEqual(pe, [{ kind: "sub", outcome: "refunded" }]);
  });

  await t.test("SALE.REVERSED and a buyer-won dispute of the same sale send ONE ref", async () => {
    const { subId, pp, sa, a } = await subscribed();
    pp.subs.set(subId, active(subId, pp.subs.get(subId)!.custom_id!));
    const s = sale(subId);
    await a.onSaleCompleted(evt("PAYMENT.SALE.COMPLETED", s, Date.now()));
    await a.onSaleReversed(evt("PAYMENT.SALE.REVERSED", { id: `${RUN}V1`, sale_id: s.id, amount: { total: "5.00", currency: "USD" } }, Date.now()));
    await a.onDisputeResolved(evt("CUSTOMER.DISPUTE.RESOLVED", {
      dispute_outcome: { outcome_code: "RESOLVED_BUYER_FAVOUR" }, dispute_amount: { value: "5.00" },
      disputed_transactions: [{ seller_transaction_id: s.id }] }, Date.now()));
    assert.equal(sa.reversals.length, 2);
    assert.equal(new Set(sa.reversals.map((r) => r.ref)).size, 1, "one ref → stream-api reverses once");
    assert.equal(sa.reversals[0]!.ref, `paypal:dispute-sale:${s.id}`);
    // Won later by the site: the restore goes under that same ref.
    await a.onDisputeResolved(evt("CUSTOMER.DISPUTE.RESOLVED", {
      dispute_outcome: { outcome_code: "RESOLVED_SELLER_FAVOUR" }, disputed_transactions: [{ seller_transaction_id: s.id }] }, Date.now()));
    assert.deepEqual(sa.reversals[2], { kind: "sub", spendId: `paypal-sub:${subId}`, ref: `paypal:dispute-sale:${s.id}`, reason: "restore" });
  });

  await t.test("PB2: a refund BEFORE its sale is never acked as nothing — the sale is read and credited, then reversed", async () => {
    const { subId, pp, sa, a } = await subscribed();
    pp.subs.set(subId, active(subId, pp.subs.get(subId)!.custom_id!));
    const s = sale(subId);
    pp.sales.set(s.id, s); // PayPal has the sale; this site has not heard of it yet
    const refund = evt("PAYMENT.SALE.REFUNDED", { id: `${RUN}R9`, sale_id: s.id, amount: { total: "5.00", currency: "USD" } }, Date.now());
    sa.answerCardsWith("unconfirmed");
    await assert.rejects(a.onSaleRefunded(refund), /did not take/, "the card is not confirmed: 500, PayPal redelivers");
    assert.equal(sa.reversals.length, 0, "nothing reversed against a credit that may not exist");
    sa.answerCardsWith("delivered");
    await a.onSaleRefunded(refund); // PayPal's redelivery
    assert.equal(sa.cards.filter((c) => c.spendId === `paypal-sub:${subId}`).length, 2, "the card, sent again under its one spendId");
    assert.deepEqual(sa.reversals.map((r) => [r.spendId, r.ref]), [[`paypal-sub:${subId}`, `paypal:sale-refund:${RUN}R9`]]);
    // …and the sale's own late delivery adds nothing.
    await a.onSaleCompleted(evt("PAYMENT.SALE.COMPLETED", s, Date.now() - 1000));
    assert.equal((await payments(subId)).length, 1);
    assert.equal(sa.cards.length, 2);
  });

  await t.test("a refund of a sale the ledger REFUSED reverses nothing; any other refund is sent (mutation guard)", async () => {
    const { subId, pp, sa, a } = await subscribed();
    pp.subs.set(subId, active(subId, pp.subs.get(subId)!.custom_id!));
    const s = sale(subId, { amount: { total: "5.00", currency: "EUR" }, transaction_fee: null });
    await a.onSaleCompleted(evt("PAYMENT.SALE.COMPLETED", s, Date.now()));
    assert.equal((await payments(subId))[0].credit, "refused", "a non-USD charge is a card, not a credit");
    await a.onSaleRefunded(evt("PAYMENT.SALE.REFUNDED", { id: `${RUN}R7`, sale_id: s.id, amount: { total: "5.00", currency: "EUR" } }, Date.now()));
    assert.equal(sa.reversals.length, 0);
    assert.ok((await payments(subId))[0].refunded_at, "still stamped");
  });

  await t.test("a stream-api refusal of the reversal throws (500), never acked", async () => {
    const { subId, pp, a } = await subscribed();
    pp.subs.set(subId, active(subId, pp.subs.get(subId)!.custom_id!));
    const s = sale(subId);
    await a.onSaleCompleted(evt("PAYMENT.SALE.COMPLETED", s, Date.now()));
    const failing = adapter(pp, { ...fakeStreamApi(), postReverse: async () => new Response("{}", { status: 404 }) } as never);
    await assert.rejects(failing.a.onSaleRefunded(evt("PAYMENT.SALE.REFUNDED", { id: `${RUN}R8`, sale_id: s.id, amount: { total: "5.00" } }, Date.now())), /answered 404/);
  });

  await t.test("same service twice is refused; an abandoned popup (APPROVAL_PENDING) is not a subscription", async () => {
    const { who, subId, pp, a } = await subscribed();
    await a.onSubscriptionEvent(evt("BILLING.SUBSCRIPTION.CREATED", { id: subId }, Date.now()));
    assert.deepEqual([(await record(subId)).status, (await record(subId)).renews], ["pending", false]);
    assert.equal(await stillBills(pool, who), false, "an unapproved subscription never charges");
    assert.ok((await a.startSubscribe(who, { tier: "supporter", alsoElsewhere: false })).ok, "a new subscribe is allowed");
    pp.subs.set(subId, active(subId, pp.subs.get(subId)!.custom_id!));
    await a.onSubscriptionEvent(evt("BILLING.SUBSCRIPTION.ACTIVATED", { id: subId }, Date.now() + 1000));
    assert.deepEqual(await a.startSubscribe(who, { tier: "supporter", alsoElsewhere: false }), { ok: false, status: 409, error: "already_subscribed" });
  });

  await t.test("a Supporter through another service gets 409 subscribed_elsewhere unless alsoElsewhere is sent (D24)", async () => {
    const who = await viewer();
    const c = await pool.connect();
    const card = `I-${RUN}card${++seq}`; // a Stripe record (the external id only has to be unique)
    const end = new Date(Date.now() + 9 * DAY);
    try {
      await c.query("BEGIN");
      await writeTransition(c, { via: "webhook", viewer: who, sources: SOURCES, observations: [{
        provider: "stripe", externalId: card, tier: "supporter", status: "active", providerStatus: "active",
        renews: true, periodEnd: end, accessUntil: null, observedAt: new Date() }] });
      await c.query("COMMIT");
    } finally { c.release(); }
    const h = adapter();
    const r = await h.a.startSubscribe(who, { tier: "supporter", alsoElsewhere: false });
    assert.deepEqual(r, { ok: false, status: 409, error: "subscribed_elsewhere", provider: "stripe", periodEnd: end.toISOString() });
    assert.equal(h.pp.created.length, 0, "nothing created at PayPal");
    assert.ok((await h.a.startSubscribe(who, { tier: "supporter", alsoElsewhere: true })).ok);
    const offer = await h.a.offer(who, true);
    assert.deepEqual(offer, { offered: true, price: { amount: 500, currency: "usd" }, elsewhere: { provider: "stripe", periodEnd: end.toISOString() } });
    await pool.query(`DELETE FROM site.subscription_records WHERE provider = 'stripe' AND external_id = $1`, [card]);
  });

  await t.test("a full checkout budget answers 503 holding no connection; an unconfigured install is not offered", async () => {
    const who = await viewer();
    const full = createConcurrencyGate({ maxConcurrent: 1, maxQueued: 0, maxWaitMs: 10 });
    const hold = await full.acquire();
    const h = adapter(undefined, undefined, { checkoutBudget: full });
    assert.deepEqual(await h.a.startSubscribe(who, { tier: "supporter", alsoElsewhere: false }), { ok: false, status: 503, error: "busy" });
    hold?.();
    assert.deepEqual(await adapter(undefined, undefined, { plans: {} }).a.startSubscribe(who, { tier: "supporter", alsoElsewhere: false }),
      { ok: false, status: 404, error: "not_offered" });
    assert.deepEqual(await h.a.offer(null, false), { offered: false, price: null, elsewhere: null });
  });

  await t.test("cancel asks PayPal to cancel the viewer's renewing subscription and writes nothing", async () => {
    const { who, subId, pp, a } = await subscribed();
    pp.subs.set(subId, active(subId, pp.subs.get(subId)!.custom_id!));
    await a.onSubscriptionEvent(evt("BILLING.SUBSCRIPTION.ACTIVATED", { id: subId }, Date.now()));
    const before = await record(subId);
    assert.deepEqual(await a.cancel(who), { cancelled: 1 });
    assert.deepEqual(pp.cancelled, [subId]);
    assert.deepEqual(await record(subId), before, "the CANCELLED webhook is the writer");
  });

  await t.test("the re-check ends a subscription whose EXPIRED webhook was lost, and refreshes a live one", async () => {
    const { who, subId, pp, a } = await subscribed();
    pp.subs.set(subId, active(subId, pp.subs.get(subId)!.custom_id!, { billing_info: { next_billing_time: new Date(Date.now() + DAY).toISOString(), failed_payments_count: 0, last_payment: { time: new Date(Date.now() - 29 * DAY).toISOString() } } }));
    await a.onSubscriptionEvent(evt("BILLING.SUBSCRIPTION.ACTIVATED", { id: subId }, Date.now() - 5000));
    pp.subs.set(subId, { ...pp.subs.get(subId)!, status: "EXPIRED" });
    const n = await a.recheck(roomy());
    assert.ok(n >= 1);
    assert.equal((await record(subId)).status, "ended");
    assert.equal(await entitled(who), false);
    assert.ok((await pool.query(`SELECT last_checked_at FROM site.subscription_records WHERE external_id = $1`, [subId])).rows[0].last_checked_at);
  });
});
