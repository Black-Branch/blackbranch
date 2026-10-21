// Wiring guard for the PayPal subscribe and cancel routes (spec §5.2, §10.1). The routes import
// the `@/` aliases and cannot run under node --test (the webhook route's reason); what they DO is
// the adapter's, run against a real database in subscriptions/paypal.test.ts. This pins the order
// the route itself owns: sign-in, input refusals, then the rate limit, then the adapter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "../../../../lib/testSource.ts";

const raw = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
const src = stripComments(raw);
const cancelSrc = stripComments(readFileSync(new URL("./cancel/route.ts", import.meta.url), "utf8"));

test("route.ts is whole (vacuity anchor)", () => {
  assert.match(raw, /return Response\.json\(\{ error: r\.error \}, \{ status: 409 \}\);\s*\}\s*$/);
});

test("POST: not offered → 404 first; then sign-in; then input; then the rate limit; then the adapter", () => {
  const order = ["paypalSubscriptionsConfigured()", "await requireUser()", 'new Response("Bad tier"', "isSubscribeLimited(matrixId)", "startPaypalSubscription(matrixId"]
    .map((s) => src.indexOf(s, src.indexOf("export async function POST")));
  assert.ok(order.every((i) => i > 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "in that order");
  assert.match(src, /const isSubscribeLimited = createSlidingWindowLimiter\(60_000, 10\);/, "checkout's bound: ten a minute");
});

test("POST: alsoElsewhere is true only when sent as true; the 409 subscribed_elsewhere names the service", () => {
  assert.match(src, /const alsoElsewhere = body\?\.alsoElsewhere === true;/);
  assert.match(src, /\{ error: r\.error, provider: r\.provider, periodEnd: r\.periodEnd \}, \{ status: 409 \}/);
  assert.match(src, /r\.error === "busy"\) return new Response\([^)]*\{ status: 503/);
});

test("card checkout (D24): a Supporter elsewhere gets 409 subscribed_elsewhere unless alsoElsewhere is true — after the throttle, before Stripe", () => {
  const raw = readFileSync(new URL("../../checkout/route.ts", import.meta.url), "utf8");
  const s = stripComments(raw);
  const at = (x: string) => s.indexOf(x);
  const order = [at("isCheckoutLimited(matrixId)"), at('if (body?.alsoElsewhere !== true) {'), at('entitledElsewhere(pool, matrixId, "stripe", subscriptionSources())'),
    at('{ error: "subscribed_elsewhere", provider: other.provider, periodEnd: other.periodEnd }, { status: 409 }'), at("ensureStripeCustomerOrBusy(matrixId)")];
  assert.ok(order.every((i) => i > 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "in that order: nothing reaches Stripe for a refused checkout");
});

test("attack: tier 'toString' is a bad tier in both subscribe routes — own properties only, never `in`", () => {
  const checkout = stripComments(readFileSync(new URL("../../checkout/route.ts", import.meta.url), "utf8"));
  assert.match(src, /if \(!slug \|\| !Object\.hasOwn\(TIERS, slug\)\) return new Response\("Bad tier"/);
  assert.match(checkout, /const tier = slug && Object\.hasOwn\(TIERS, slug\) \? TIERS\[slug\] : undefined;/);
  assert.match(checkout, /if \(!tier\) return new Response\("Bad tier", \{ status: 400 \}\);/);
  // The behaviour the scan stands for:
  const TIERS = { supporter: {} };
  assert.equal("toString" in TIERS, true, "the bug: `in` finds Object.prototype");
  assert.equal(Object.hasOwn(TIERS, "toString"), false);
});

test("cancel: module switch, sign-in, its own rate limit, and nothing written by the route", () => {
  const p = ["paypalModuleOn()", "await requireUser()", "isCancelLimited(matrixId)", "cancelPaypalSubscriptions(matrixId)"].map((s) => cancelSrc.indexOf(s));
  assert.ok(p.every((i) => i > 0));
  assert.deepEqual([...p].sort((a, b) => a - b), p);
  assert.match(cancelSrc, /status: 502 \}\);\s*\}\s*\}\s*$/, "END of cancel/route.ts not read");
  assert.doesNotMatch(cancelSrc, /pool|INSERT|UPDATE/);
});
