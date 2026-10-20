import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "./testSource.ts";

// Every Stripe checkout route is throttled per viewer. Each accepted call can
// hold one of the checkout connection budget's slots (billingConnections.ts)
// while Stripe answers, and every one opens a Checkout Session, so without a
// per-viewer throttle one signed-in account could keep that budget full and
// mint sessions without bound. Starting a checkout takes one call; ten a minute
// is generous. The limit sits AFTER the cheap input checks (a typo is not a
// hit) and BEFORE anything reaches Stripe, the customer lookup included.
// donate has its own (per viewer when signed in, per IP otherwise):
// donateRateLimit.test.ts.

const read = (route: string) =>
  stripComments(readFileSync(new URL(`../api/billing/${route}/route.ts`, import.meta.url), "utf8"));

for (const [route, limiter] of [
  ["checkout", "isCheckoutLimited"],
  ["gift", "isGiftLimited"],
  ["points", "isPointsLimited"],
] as const) {
  test(`${route} is throttled per viewer, 10 a minute, after the input checks and before Stripe`, () => {
    const src = read(route);
    // vacuity anchor: the scan reached the end of the handler
    assert.match(src, /\}\s*$/, `END of the ${route} route not read`);
    assert.match(src, new RegExp(`const ${limiter} = createSlidingWindowLimiter\\(60_000, 10\\);`), "ten per rolling minute");
    const limited = src.indexOf(`${limiter}(matrixId)`);
    assert.ok(limited > 0, "keyed on the signed-in viewer");
    assert.ok(limited > src.indexOf("requireUser()"), "after sign-in: the key is the viewer");
    assert.ok(limited > src.lastIndexOf("status: 400"), "every input refusal comes first — a mistake is not a hit");
    const refusal = src.indexOf("status: 429", limited);
    assert.ok(refusal > limited, "a limited caller is refused with 429");
    assert.match(src.slice(limited, refusal + 60), /"Retry-After": "60"/, "and told when to come back");
    const firstStripe = Math.min(
      ...["getStripe()", "ensureStripeCustomerOrBusy(", "getStatementPrefixLength(", "checkout.sessions.create("]
        .map((s) => src.indexOf(s))
        .filter((i) => i >= 0)
    );
    assert.ok(firstStripe > refusal, "the refusal comes before any Stripe call, the customer lookup included");
  });
}

test("donate's 429 says when to come back too", () => {
  const src = read("donate");
  assert.match(src, /return Response\.json\(\{ clientSecret: checkout\.client_secret, sessionId: checkout\.id \}\);\s*\}\s*$/);
  assert.match(src, /status: 429, headers: \{ "Retry-After": "600" \}/, "its window is ten minutes");
});
