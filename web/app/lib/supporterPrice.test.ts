// The Supporter price comes from Stripe, not from code (contract 6): no price →
// subscriptions are not offered; a price that cannot be the monthly subscription reads as none;
// the answer is cached for 10 minutes and a failure for one.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSupporterPrice, createSubscriptionOffer, type PriceLike, type SupporterPrice } from "./supporterPrice.ts";
import type { PaypalPlanState } from "./paypalSubscriptions.ts";

const MONTHLY: PriceLike = { id: "price_a", active: true, type: "recurring", currency: "eur", unit_amount: 700, recurring: { interval: "month", interval_count: 1 } };

function harness(over: Partial<{ configured: boolean; id: string | null; answer: () => Promise<PriceLike> }> = {}) {
  let now = 1_000_000;
  const calls: string[] = [];
  const warns: string[] = [];
  const state = { configured: over.configured ?? true, id: over.id === undefined ? "price_a" : over.id, answer: over.answer ?? (async () => MONTHLY) };
  const read = createSupporterPrice({
    configured: () => state.configured,
    priceId: () => state.id,
    retrieve: async (id) => { calls.push(id); return state.answer(); },
    now: () => now,
    log: { warn: (l: string) => warns.push(l) },
  });
  return { read, calls, warns, state, tick: (ms: number) => { now += ms; } };
}

test("the amount and currency shown are Stripe's, not a number in the code", async () => {
  const h = harness();
  assert.deepEqual(await h.read(), { id: "price_a", amount: 700, currency: "eur" });
});

test("no price id, or Stripe switched off, offers no subscription — null, and Stripe is never asked", async () => {
  const none = harness({ id: null });
  assert.equal(await none.read(), null);
  const off = harness({ configured: false });
  assert.equal(await off.read(), null);
  assert.deepEqual([...none.calls, ...off.calls], []);
});

test("a price that is not a monthly, active, fixed-amount recurring price reads as no price, with one log line naming why", async () => {
  for (const [bad, why] of [
    [{ ...MONTHLY, active: false }, "not active"],
    [{ ...MONTHLY, type: "one_time", recurring: null }, "one-time"],
    [{ ...MONTHLY, recurring: { interval: "year", interval_count: 1 } }, "every month"],
    [{ ...MONTHLY, recurring: { interval: "month", interval_count: 3 } }, "every month"],
    [{ ...MONTHLY, unit_amount: null }, "fixed amount"],
  ] as const) {
    const h = harness({ answer: async () => bad });
    assert.equal(await h.read(), null, why);
    await h.read();
    assert.equal(h.warns.length, 1, `one line, not one per read (${why})`);
    assert.match(h.warns[0]!, new RegExp(why));
  }
});

test("cached ten minutes: the second read inside the window does not call Stripe; after it, it does", async () => {
  const h = harness();
  await h.read();
  h.tick(9 * 60_000);
  await h.read();
  assert.equal(h.calls.length, 1);
  h.tick(2 * 60_000);
  await h.read();
  assert.equal(h.calls.length, 2);
});

test("a changed price id misses the cache at once", async () => {
  const h = harness();
  await h.read();
  h.state.id = "price_b";
  await h.read();
  assert.deepEqual(h.calls, ["price_a", "price_b"]);
});

test("retry: a Stripe failure hides the subscription for one minute, then the next read asks again and recovers", async () => {
  let fail = true;
  const h = harness({ answer: async () => { if (fail) throw new Error("No such price: 'price_a'"); return MONTHLY; } });
  assert.equal(await h.read(), null);
  h.tick(30_000);
  assert.equal(await h.read(), null);
  assert.equal(h.calls.length, 1, "inside the failure minute Stripe is not asked again");
  fail = false;
  h.tick(31_000);
  assert.deepEqual(await h.read(), { id: "price_a", amount: 700, currency: "eur" });
  assert.equal(h.warns.length, 1);
});

test("concurrent first reads share one Stripe request", async () => {
  const h = harness();
  const [a, b] = await Promise.all([h.read(), h.read()]);
  assert.deepEqual(a, b);
  assert.equal(h.calls.length, 1);
});


// ── Subscriptions exist when EITHER provider sells them (k, 2026-10-21) ──────────────────────
// The one server answer for "is a subscription for sale here, and at what price": a usable Stripe
// Supporter price, or a PayPal plan for the Supporter tier that PayPal prices as an active monthly
// plan. The price shown is Stripe's when there is one (nothing changes for a Stripe-only or a
// both-providers site), else the PayPal plan's as PayPal stores it.

const STRIPE_PRICE: SupporterPrice = { id: "price_a", amount: 700, currency: "eur" };
const PLAN_PRICE: PaypalPlanState = { planId: "P-CASEY123", amount: 500, currency: "usd" };

function offerHarness(over: Partial<{ stripe: SupporterPrice | null; paypalOn: boolean; plan: string | undefined; state: () => Promise<PaypalPlanState> }> = {}) {
  const asked: string[] = [];
  const s = {
    stripe: over.stripe === undefined ? null : over.stripe,
    paypalOn: over.paypalOn ?? true,
    plan: "plan" in over ? over.plan : "P-CASEY123",
    state: over.state ?? (async () => PLAN_PRICE),
  };
  const read = createSubscriptionOffer({
    stripe: async () => s.stripe,
    paypalOn: () => s.paypalOn,
    paypalPlanId: () => s.plan,
    planState: async (id) => { asked.push(id); return s.state(); },
  });
  return { read, asked, s };
}

test("a site that sells subscriptions through PayPal only offers them, at the PayPal plan's price", async () => {
  const h = offerHarness();
  assert.deepEqual(await h.read(), { amount: 500, currency: "usd", stripe: false, paypal: true });
});

test("Stripe only: unchanged, Stripe's price, and PayPal is never asked", async () => {
  const h = offerHarness({ stripe: STRIPE_PRICE, paypalOn: false });
  assert.deepEqual(await h.read(), { amount: 700, currency: "eur", stripe: true, paypal: false });
  assert.deepEqual(h.asked, []);
});

test("both providers: Stripe's price is the one shown, and both are offered", async () => {
  const h = offerHarness({ stripe: STRIPE_PRICE });
  assert.deepEqual(await h.read(), { amount: 700, currency: "eur", stripe: true, paypal: true });
});

test("no Stripe price and no PayPal plan (or PayPal off, or a plan PayPal will not sell): no subscription", async () => {
  assert.equal(await offerHarness({ plan: undefined }).read(), null);
  const off = offerHarness({ paypalOn: false });
  assert.equal(await off.read(), null);
  assert.deepEqual(off.asked, [], "PayPal switched off is never asked about its plan");
  assert.equal(await offerHarness({ state: async () => "inactive" }).read(), null);
});

test("retry: a PayPal read that fails hides the PayPal subscription (never invents a price); the next read recovers", async () => {
  let fail = true;
  const h = offerHarness({ state: async () => { if (fail) throw new Error("paypal get plan: 503"); return PLAN_PRICE; } });
  assert.equal(await h.read(), null);
  fail = false;
  assert.deepEqual(await h.read(), { amount: 500, currency: "usd", stripe: false, paypal: true });
  const both = offerHarness({ stripe: STRIPE_PRICE, state: async () => { throw new Error("down"); } });
  assert.deepEqual(await both.read(), { amount: 700, currency: "eur", stripe: true, paypal: false }, "a PayPal outage leaves the card subscription alone");
});

test("restart: the settings are read on every call, so a plan set or cleared shows on the next read", async () => {
  const h = offerHarness({ plan: undefined });
  assert.equal(await h.read(), null);
  h.s.plan = "P-CASEY123";
  assert.equal((await h.read())?.paypal, true);
  h.s.paypalOn = false;
  assert.equal(await h.read(), null);
});

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

test("wiring: every Gift entry point is gated on Stripe's Supporter price, not on Stripe alone", () => {
  assert.match(read("app/components/SupportContent.tsx"), /const subsOn = stripeOn && supporter !== null;/);
  // The player's Subscribe button reads the either-provider answer (subscribeButton.test.ts pins it);
  // its Gift side still needs Stripe's price.
  assert.match(read("app/features/support/subscribeButton.ts"), /const giftsOn = a\.billing\.stripe && a\.billing\.supporter !== null;/);
  const card = read("app/components/UserCard.tsx");
  assert.match(card, /const giftsOn = billing\.stripe && billing\.supporter !== null;/);
  assert.match(card, /\{giftsOn && <button/);
  for (const route of ["app/api/billing/checkout/route.ts", "app/api/billing/gift/route.ts"]) {
    assert.match(read(route), /const price = await supporterPrice\(\);\n\s+if \(!price\) return new Response\("Subscriptions aren’t offered on this site\.", \{ status: 404 \}\);/, route);
  }
  // Vacuity anchor at the END of the card: the scan read the whole file.
  assert.match(card.trimEnd(), /\}$/);
});
