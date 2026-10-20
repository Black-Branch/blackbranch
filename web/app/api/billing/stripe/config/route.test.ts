// GET /api/billing/stripe/config — the ONE billing-availability answer the payment surfaces read
// (useBillingAvailability, app/lib/useStripe.ts): Stripe's publishable key and PayPal's client id,
// each null while that provider is off. A real call: the route has no Next-specific import.
//
// Run: systemd-run --user --scope -p MemoryMax=8G --quiet node --test app/api/billing/stripe/config/route.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import "../../../../lib/testTsx.ts"; // registers the "@/" resolver route.ts's imports need

const KEYS = ["STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY", "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_ENV"] as const;
const STRIPE = { STRIPE_SECRET_KEY: "sk_test_abc", STRIPE_PUBLISHABLE_KEY: "pk_test_abc" };
const PAYPAL = { PAYPAL_CLIENT_ID: "AeGadget123", PAYPAL_CLIENT_SECRET: "shh", PAYPAL_ENV: "sandbox" };

// Stripe's secret key is a 'restart' key (read once), so the process starts with it set; the
// Stripe-off cases switch the publishable key away instead, which is what the answer carries.
for (const k of KEYS) delete process.env[k];
Object.assign(process.env, { STRIPE_SECRET_KEY: STRIPE.STRIPE_SECRET_KEY });

const { GET } = await import("./route.ts");

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
  assert.deepEqual(await answer(), { publishableKey: "pk_test_abc", paypalClientId: "AeGadget123", paypalSandbox: true });
});

test("PayPal only: no publishable key, the client id", async () => {
  setEnv({ ...PAYPAL });
  assert.deepEqual(await answer(), { publishableKey: null, paypalClientId: "AeGadget123", paypalSandbox: true });
});

test("Stripe only: the key, no client id", async () => {
  setEnv({ ...STRIPE });
  assert.deepEqual(await answer(), { publishableKey: "pk_test_abc", paypalClientId: null, paypalSandbox: false });
});

test("PayPal partly configured (no env) reads as off — a client id alone cannot take a payment", async () => {
  setEnv({ ...STRIPE, PAYPAL_CLIENT_ID: "AeGadget123", PAYPAL_CLIENT_SECRET: "shh" });
  assert.deepEqual(await answer(), { publishableKey: "pk_test_abc", paypalClientId: null, paypalSandbox: false });
});

test("paypalSandbox is true only for a sandbox PayPal — a live one never gets the sandbox-only SDK parameter", async () => {
  setEnv({ ...PAYPAL, PAYPAL_ENV: "live" });
  assert.deepEqual(await answer(), { publishableKey: null, paypalClientId: "AeGadget123", paypalSandbox: false });
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
