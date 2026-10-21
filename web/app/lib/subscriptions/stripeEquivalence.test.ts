// Stripe moved onto the transition function with ZERO behaviour change (subscription sources §5.1,
// §13.1) — proven by running the reconciler as it stood before S1 (legacyStripeSync.fixture.ts,
// quoted from f9740396) and the one the webhook uses now over the SAME recorded sequence of Stripe
// events, on a real database, and requiring deep-equal:
//   - the legacy row (site.subscriptions) after every event — what every unmoved reader reads;
//   - what the reconciler returns — the webhook route builds its badge call and its "subscribed"
//     card from that and from nothing else (route.ts syncSubscription, unchanged by S1);
//   - so the badge decision and each card's spendId, derived below by the route's own rule. The
//     refund path finds a subscription's ledger credit by recomputing exactly these spendIds
//     (paymentReversalsLedger.ts: `sub:<subscription id>`, `renewal:<invoice id>`), so a moved
//     spendId would make every later refund of it reverse nothing.
// Then the records the new reconciler wrote must say the same thing: the viewer is entitled by them
// exactly when the legacy row says so.
//
// The sequence covers what §13.1 names: a plan switch in one second, two customers for one viewer,
// cancel-at-period-end, past_due → canceled, an out-of-order delivery — plus a renewal and a
// redelivery.
// Locally: SQL_PARSE_DATABASE_URL=… node --test app/lib/subscriptions/stripeEquivalence.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import type Stripe from "stripe";

const PRICE = "price_test_supporter";
process.env.STRIPE_PRICE_SUPPORTER = PRICE; // tiers.ts reads it (the setting's env fallback)
const { createSubscriptionSync } = await import("../subscriptionSync.ts");
const { createLegacySubscriptionSync } = await import("./legacyStripeSync.fixture.ts");
const { isActiveStatus, TIERS } = await import("../tiers.ts");
const { entitlementOf } = await import("./entitlement.ts");

const DB_URL = process.env.SQL_PARSE_DATABASE_URL || "";
const unsafe = !DB_URL || DB_URL === process.env.DATABASE_URL || !/@(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(DB_URL);
const skip = unsafe ? (process.env.CI ? false : "SQL_PARSE_DATABASE_URL unset or unsafe") : false;

const RUN = `subeq${process.pid}x${Date.now().toString(36)}`;
const T = 1_800_000_000;

type Status = Stripe.Subscription.Status;
type Sub = { id: string; customer: string; status: Status; created: number; cancelAtPeriodEnd?: boolean; price?: string };
/** One step of the recorded sequence: Stripe's state changes, then one event is delivered. */
type Step =
  | { set?: Sub[]; deliver: "subscription"; subId: string; eventAt: number; created?: boolean; label: string }
  | { set?: Sub[]; deliver: "renewal"; subId: string; invoiceId: string; label: string };

/** The recorded sequence, for one viewer `p` (every id is prefixed so two runs never share one). */
function sequence(p: string): { customers: string[]; steps: Step[] } {
  const cA = `cus_${p}_a`, cB = `cus_${p}_b`;
  const s1 = `sub_${p}_1`, s2 = `sub_${p}_2`, s3 = `sub_${p}_3`;
  return {
    customers: [cA],
    steps: [
      { label: "subscribe", set: [{ id: s1, customer: cA, status: "active", created: T }], deliver: "subscription", subId: s1, eventAt: T, created: true },
      { label: "checkout overlap", deliver: "subscription", subId: s1, eventAt: T },
      { label: "renewal", deliver: "renewal", subId: s1, invoiceId: `in_${p}_1` },
      { label: "renewal off in the portal", set: [{ id: s1, customer: cA, status: "active", created: T, cancelAtPeriodEnd: true }], deliver: "subscription", subId: s1, eventAt: T + 10 },
      { label: "renewal back on", set: [{ id: s1, customer: cA, status: "active", created: T }], deliver: "subscription", subId: s1, eventAt: T + 20 },
      // A plan switch in one second: s1 cancelled, s2 created — delivered old-first, then the reverse.
      { label: "plan switch: old cancelled", set: [{ id: s1, customer: cA, status: "canceled", created: T }, { id: s2, customer: cA, status: "active", created: T + 30 }], deliver: "subscription", subId: s1, eventAt: T + 30 },
      { label: "plan switch: new created", deliver: "subscription", subId: s2, eventAt: T + 30, created: true },
      { label: "plan switch: old cancellation redelivered", deliver: "subscription", subId: s1, eventAt: T + 30 },
      // An out-of-order delivery: an event older than what was written.
      { label: "out of order: stale event", deliver: "subscription", subId: s1, eventAt: T + 5 },
      // A second customer for the same viewer, with its own live subscription.
      { label: "second customer subscribes", set: [{ id: s3, customer: cB, status: "active", created: T + 40 }], deliver: "subscription", subId: s3, eventAt: T + 40, created: true },
      { label: "first customer's sub goes past_due", set: [{ id: s2, customer: cA, status: "past_due", created: T + 30 }], deliver: "subscription", subId: s2, eventAt: T + 50 },
      { label: "second customer's sub cancelled", set: [{ id: s3, customer: cB, status: "canceled", created: T + 40 }], deliver: "subscription", subId: s3, eventAt: T + 60 },
      { label: "past_due → canceled", set: [{ id: s2, customer: cA, status: "canceled", created: T + 30 }], deliver: "subscription", subId: s2, eventAt: T + 70 },
      { label: "a price the install does not sell", set: [{ id: s1, customer: cA, status: "active", created: T, price: "price_other" }], deliver: "subscription", subId: s1, eventAt: T + 80 },
      { label: "redelivery of the last event", deliver: "subscription", subId: s1, eventAt: T + 80 },
    ],
  };
}

function toStripe(s: Sub, who: string): Stripe.Subscription {
  return {
    id: s.id, object: "subscription", status: s.status, customer: s.customer, created: s.created,
    cancel_at_period_end: s.cancelAtPeriodEnd ?? false, metadata: { matrix_id: who },
    items: { data: [{ price: { id: s.price ?? PRICE, unit_amount: 500, currency: "usd" }, current_period_end: T + 30 * 86_400 }] },
  } as unknown as Stripe.Subscription;
}

function fakeStripe(current: Map<string, Stripe.Subscription>) {
  return {
    subscriptions: {
      retrieve: async (id: string) => {
        const s = current.get(id);
        if (!s) throw new Error(`no subscription ${id}`);
        return structuredClone(s);
      },
      list: async (q: { customer: string }) => ({
        object: "list", has_more: false,
        data: [...current.values()].filter((x) => x.customer === q.customer).map((x) => structuredClone(x)),
      }),
    },
    customers: { retrieve: async () => { throw new Error("customers.retrieve not expected"); } },
  } as unknown as Stripe;
}

type Sync = { syncSubscription: (ref: { id: string }, eventAt: number) => Promise<{ matrixId: string; sub: Stripe.Subscription; effectiveTier: string | null } | null>;
  resolveMatrixId: (sub: Stripe.Subscription, customerId: string) => Promise<string | null> };

test("the reconciler before S1 and after it: same legacy rows, same returns, same badge calls and spendIds", { skip }, async (t) => {
  assert.ok(!unsafe, "SQL_PARSE_DATABASE_URL must point at a local throwaway database in CI");
  const pool = new Pool({ connectionString: DB_URL, max: 4 });
  const clean = async () => {
    await pool.query(`DELETE FROM site.subscriptions WHERE matrix_id LIKE $1`, [`@${RUN}%`]);
    await pool.query(`DELETE FROM site.stripe_customers WHERE matrix_id LIKE $1`, [`@${RUN}%`]);
    await pool.query(`DELETE FROM site.users WHERE matrix_id LIKE $1`, [`@${RUN}%`]);
  };
  await clean();
  t.after(async () => { await clean(); await pool.end(); });

  /** Run the whole sequence through one reconciler; return what each step produced, with the
   *  run's own prefix replaced by "P" so the two runs compare. */
  async function run(label: "old" | "new", make: (stripe: () => Stripe) => Sync) {
    const p = `${RUN}${label}`;
    const who = `@${p}:site.test`;
    await pool.query(`INSERT INTO site.users (matrix_id) VALUES ($1)`, [who]);
    const { steps, customers } = sequence(p);
    // The viewer's first customer, recorded as checkout records it (ensureStripeCustomer).
    for (const c of customers) await pool.query(`INSERT INTO site.stripe_customers (stripe_customer_id, matrix_id) VALUES ($1, $2)`, [c, who]);
    const current = new Map<string, Stripe.Subscription>();
    const stripe = fakeStripe(current);
    const sync = make(() => stripe);
    const out: unknown[] = [];
    for (const step of steps) {
      for (const s of step.set ?? []) current.set(s.id, toStripe(s, who));
      if (step.deliver === "renewal") {
        // recordRenewal: resolve the viewer, then the card — spendId from the invoice id.
        const sub = current.get(step.subId)!;
        const viewer = await sync.resolveMatrixId(sub, sub.customer as string);
        out.push({ step: step.label, viewer, card: viewer ? `renewal:${step.invoiceId}` : null });
        continue;
      }
      const announceFrom = step.created ? current.get(step.subId)! : null;
      const wrote = await sync.syncSubscription({ id: step.subId }, step.eventAt);
      // The webhook route's effects, by its own rule (route.ts syncSubscription, unchanged in S1).
      const badge = wrote ? isActiveStatus(wrote.sub.status) && Boolean(wrote.effectiveTier && TIERS[wrote.effectiveTier as "supporter"].perks.badge) : null;
      const card = wrote && announceFrom && isActiveStatus(announceFrom.status) ? `sub:${announceFrom.id}` : null;
      const legacy = (await pool.query(
        `SELECT stripe_customer_id, stripe_sub_id, tier, status, current_period_end, cancel_at_period_end, stripe_event_at
           FROM site.subscriptions WHERE matrix_id = $1`, [who])).rows[0];
      out.push({
        step: step.label,
        returned: wrote && { matrixId: wrote.matrixId, subId: wrote.sub.id, status: wrote.sub.status, effectiveTier: wrote.effectiveTier },
        badge, card, legacy,
      });
    }
    const text = JSON.stringify(out).replaceAll(p, "P");
    return { who, steps: JSON.parse(text) as Record<string, unknown>[] };
  }

  const before = await run("old", (stripe) => createLegacySubscriptionSync({ pool, stripe }));
  const after = await run("new", (stripe) => createSubscriptionSync({ pool, stripe }));

  // Vacuity: the sequence ran in full and exercised what it claims to.
  assert.equal(after.steps.length, sequence("x").steps.length);
  const cards = after.steps.map((s) => s.card).filter(Boolean);
  assert.deepEqual(cards, ["sub:sub_P_1", "renewal:in_P_1", "sub:sub_P_2", "sub:sub_P_3"], "the cards and their spendIds");
  assert.ok(after.steps.some((s) => s.returned === null && s.step === "out of order: stale event"), "the stale event was dropped");

  for (let i = 0; i < before.steps.length; i++) {
    assert.deepEqual(after.steps[i], before.steps[i], `step ${i} (${String(before.steps[i]!.step)}) differs`);
  }

  // The records the new reconciler wrote agree with the legacy row on who is entitled, at the end
  // and with a source switched off.
  const rows = (await pool.query(`SELECT external_id, status, provider_status, tier, renews FROM site.subscription_records
    WHERE matrix_id = $1 ORDER BY external_id`, [after.who])).rows;
  assert.deepEqual(rows.map((r) => [String(r.external_id).replaceAll(`${RUN}new`, "P"), r.status, r.provider_status, r.tier]), [
    ["sub_P_1", "active", "active", null],
    ["sub_P_2", "ended", "canceled", "supporter"],
    ["sub_P_3", "ended", "canceled", "supporter"],
  ]);
  const legacyEntitled = isActiveStatus(String((before.steps.at(-1) as { legacy: { status: string } }).legacy.status))
    && (before.steps.at(-1) as { legacy: { tier: string | null } }).legacy.tier !== null;
  const e = await entitlementOf(pool, after.who, ["stripe", "paypal"]);
  assert.equal(e.supporter, legacyEntitled, "an active subscription at a price the install does not sell entitles neither way");
  t.diagnostic(`records: ${rows.length}, entitled: ${e.supporter}`);
});
