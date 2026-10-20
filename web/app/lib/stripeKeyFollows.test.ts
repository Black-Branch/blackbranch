// The website applies a saved Stripe key at once: the client is made again when the key it was
// made with is no longer the key. (It was made once and kept, so a new key waited for a restart
// that nothing on the page asked for.)
// Run: env -u DATABASE_URL node --test app/lib/stripeKeyFollows.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

test("a new key gets a new client; the same key keeps its client", async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_first_key_000000000000";
  const { getStripe } = await import("./stripe.ts");
  const a = getStripe();
  assert.equal(getStripe(), a, "same key, same client");
  process.env.STRIPE_SECRET_KEY = "sk_test_second_key_00000000000";
  const b = getStripe();
  assert.notEqual(b, a, "a changed key is used at the next call");
  assert.equal(getStripe(), b);
  delete process.env.STRIPE_SECRET_KEY;
  assert.throws(() => getStripe(), /STRIPE_SECRET_KEY is not set/);
});
