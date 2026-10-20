import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "./testSource.ts";

// /api/billing/donate works for guests, and every accepted call creates a
// Stripe Checkout Session. With no throttle, one script could mint sessions
// without bound against the Stripe account. The limit sits AFTER the cheap
// input checks (a typo is not a hit) and BEFORE anything reaches Stripe.
const src = stripComments(readFileSync(new URL("../api/billing/donate/route.ts", import.meta.url), "utf8"));

test("donate is throttled per signed-in user, else per client IP, before Stripe is touched", () => {
  assert.match(src, /const isDonateLimited = createSlidingWindowLimiter\(/);
  const limited = src.indexOf("isDonateLimited(matrixId ?? ipKey(req))");
  const refusal = src.indexOf("status: 429");
  const customer = src.indexOf("ensureStripeCustomerOrBusy(");
  const stripe = src.indexOf("getStripe()");
  const create = src.indexOf("checkout.sessions.create(");
  assert.ok(limited > 0, "keys on the user id when signed in, the Cloudflare client IP otherwise");
  assert.ok(limited > src.lastIndexOf("status: 400"), "every input refusal comes first — a mistake is not a hit");
  assert.ok(refusal > limited, "a limited caller is refused with 429");
  assert.ok(stripe > refusal && create > refusal, "the refusal comes before any Stripe call");
  assert.ok(customer === -1 || customer > refusal, "…including the customer upsert");
  // vacuity anchor: the scan reached the end of the handler
  assert.match(src, /return Response\.json\(\{ clientSecret: checkout\.client_secret, sessionId: checkout\.id \}\);\s*\}\s*$/);
});
