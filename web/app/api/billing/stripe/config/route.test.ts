// GET /api/billing/stripe/config — the ONE billing-availability answer the payment surfaces read
// (useBillingAvailability, app/lib/useStripe.ts): Stripe's publishable key and PayPal's client id,
// each null while that provider is off. A real call: the route has no Next-specific import.
//
// Run: systemd-run --user --scope -p MemoryMax=8G --quiet node --test app/api/billing/stripe/config/route.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import "../../../../lib/testTsx.ts"; // registers the "@/" resolver route.ts's imports need

const KEYS = ["STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY", "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_ENV", "PAYPAL_PLANS"] as const;
const STRIPE = { STRIPE_SECRET_KEY: "sk_test_abc", STRIPE_PUBLISHABLE_KEY: "pk_test_abc" };
const PAYPAL = { PAYPAL_CLIENT_ID: "AeGadget123", PAYPAL_CLIENT_SECRET: "shh", PAYPAL_ENV: "sandbox" };

// Stripe's secret key is a 'restart' key (read once), so the process starts with it set; the
// Stripe-off cases switch the publishable key away instead, which is what the answer carries.
for (const k of KEYS) delete process.env[k];
Object.assign(process.env, { STRIPE_SECRET_KEY: STRIPE.STRIPE_SECRET_KEY });

// PayPal, as far as this route reaches it: a token, then the Supporter plan. `plan` is what the
// plan read answers (a test changes it); every other address fails, so nothing else is reached.
let plan: { status: number; body?: unknown } = { status: 404 };
const paypalCalls: string[] = [];
(globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown) => {
  const u = String(url);
  paypalCalls.push(u);
  if (u.endsWith("/v1/oauth2/token")) return Response.json({ access_token: "tok", expires_in: 3600 });
  if (u.includes("/v1/billing/plans/")) return new Response(JSON.stringify(plan.body ?? {}), { status: plan.status, headers: { "content-type": "application/json" } });
  return new Response("not here", { status: 500 });
};
const MONTHLY_PLAN = { status: 200, body: { status: "ACTIVE", billing_cycles: [{ tenure_type: "REGULAR", frequency: { interval_unit: "MONTH", interval_count: 1 }, pricing_scheme: { fixed_price: { value: "5.00", currency_code: "USD" } } }] } };
const PLANS = JSON.stringify({ supporter: "P-CASEY123" });

const { GET } = await import("./route.ts");
const { _resetPaypalPlanCacheForTests } = await import("../../../../lib/paypalSubscriptions.ts");

function setEnv(vars: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) if (k !== "STRIPE_SECRET_KEY") delete process.env[k];
  Object.assign(process.env, vars);
}
const answer = async () => {
  const res = await GET();
  assert.equal(res.headers.get("Cache-Control"), "no-store", "it changes with a switch: never cached");
  return res.json();
};

test("both on: the publishable key AND the PayPal client id", async () => {
  setEnv({ ...STRIPE, ...PAYPAL });
  assert.deepEqual(await answer(), { publishableKey: "pk_test_abc", paypalClientId: "AeGadget123", paypalSandbox: true, supporter: null, subscribe: null });
});

test("PayPal only: no publishable key, the client id", async () => {
  setEnv({ ...PAYPAL });
  assert.deepEqual(await answer(), { publishableKey: null, paypalClientId: "AeGadget123", paypalSandbox: true, supporter: null, subscribe: null });
});

test("Stripe only: the key, no client id", async () => {
  setEnv({ ...STRIPE });
  assert.deepEqual(await answer(), { publishableKey: "pk_test_abc", paypalClientId: null, paypalSandbox: false, supporter: null, subscribe: null });
});

test("PayPal partly configured (no env) reads as off — a client id alone cannot take a payment", async () => {
  setEnv({ ...STRIPE, PAYPAL_CLIENT_ID: "AeGadget123", PAYPAL_CLIENT_SECRET: "shh" });
  assert.deepEqual(await answer(), { publishableKey: "pk_test_abc", paypalClientId: null, paypalSandbox: false, supporter: null, subscribe: null });
});

test("paypalSandbox is true only for a sandbox PayPal — a live one never gets the sandbox-only SDK parameter", async () => {
  setEnv({ ...PAYPAL, PAYPAL_ENV: "live" });
  assert.deepEqual(await answer(), { publishableKey: null, paypalClientId: "AeGadget123", paypalSandbox: false, supporter: null, subscribe: null });
  setEnv({ ...PAYPAL });
  assert.equal((await answer()).paypalSandbox, true);
});

test("restart: the answer is read at call time — a settings change shows on the next request, no reload", async () => {
  setEnv({ ...STRIPE });
  assert.equal((await answer()).paypalClientId, null);
  setEnv({ ...STRIPE, ...PAYPAL });
  assert.equal((await answer()).paypalClientId, "AeGadget123");
  setEnv({ ...PAYPAL });
  assert.equal((await answer()).publishableKey, null);
});

// -- Subscriptions through PayPal alone (k, 2026-10-21) --
// `subscribe` is the one answer to "is a subscription for sale, at what price": Stripe's Supporter
// price, else the PayPal plan's. `supporter` stays Stripe's alone, because gifts are card checkouts.

test("PayPal only with a Supporter plan: a subscription is for sale at the plan's price; gifts (supporter) stay off", async () => {
  _resetPaypalPlanCacheForTests();
  plan = MONTHLY_PLAN;
  setEnv({ ...PAYPAL, PAYPAL_PLANS: PLANS });
  assert.deepEqual(await answer(), { publishableKey: null, paypalClientId: "AeGadget123", paypalSandbox: true, supporter: null, subscribe: { amount: 500, currency: "usd" } });
});

test("PayPal only with a plan PayPal will not sell (not active): no subscription, no invented price", async () => {
  _resetPaypalPlanCacheForTests();
  plan = { status: 200, body: { ...MONTHLY_PLAN.body, status: "INACTIVE" } };
  setEnv({ ...PAYPAL, PAYPAL_PLANS: PLANS });
  assert.equal((await answer()).subscribe, null);
});

test("retry: PayPal failing to answer for the plan hides the subscription; once the failure minute passes it shows", async () => {
  _resetPaypalPlanCacheForTests();
  plan = { status: 503 };
  setEnv({ ...PAYPAL, PAYPAL_PLANS: PLANS });
  assert.equal((await answer()).subscribe, null);
  plan = MONTHLY_PLAN;
  _resetPaypalPlanCacheForTests(); // the minute PayPal's failure is held for, passed
  assert.deepEqual((await answer()).subscribe, { amount: 500, currency: "usd" });
});

test("restart: a plan set or cleared shows on the next request; PayPal off is never asked about its plan", async () => {
  _resetPaypalPlanCacheForTests();
  plan = MONTHLY_PLAN;
  setEnv({ ...PAYPAL });
  assert.equal((await answer()).subscribe, null);
  setEnv({ ...PAYPAL, PAYPAL_PLANS: PLANS });
  assert.deepEqual((await answer()).subscribe, { amount: 500, currency: "usd" });
  paypalCalls.length = 0;
  setEnv({ ...STRIPE, PAYPAL_PLANS: PLANS });
  assert.equal((await answer()).subscribe, null);
  assert.deepEqual(paypalCalls, [], "PayPal switched off: no request to PayPal at all");
});
