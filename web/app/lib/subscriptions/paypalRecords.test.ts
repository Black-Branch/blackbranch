// The PayPal mapping (spec §3.3, §3.4, D9) and the PayPal subscription API client (§5.2), run —
// pure functions, and the client over a stubbed fetch.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { paypalObservation, tierForPlan, estimatePaypalNet, saleMoney, saleIdOf } from "./paypalRecords.ts";
import { GRACE_DAYS as PAYPAL_GRACE_DAYS } from "./grace.ts";
import type { PaypalSubscription } from "../paypalSubscriptions.ts";
import { stripComments } from "../testSource.ts";

process.env.PAYPAL_CLIENT_ID = "test-client-id";
process.env.PAYPAL_CLIENT_SECRET = "test-client-secret";
process.env.PAYPAL_ENV = "sandbox";
const { createPaypalSubscription, getPaypalSubscription, cancelPaypalSubscription, getPaypalSale, parsePaypalPlans, paypalPlans } =
  await import("../paypalSubscriptions.ts");
const { _resetPaypalAccessTokenCache } = await import("../paypalClient.ts");

const DAY = 86_400_000;
const NOW = new Date("2026-10-20T12:00:00Z");
const sub = (over: Partial<PaypalSubscription>): PaypalSubscription => ({
  id: "I-TEST0001", status: "ACTIVE", plan_id: "P-TESTPLAN0001", custom_id: null, subscriber: { payer_id: "PAYER1" },
  billing_info: { next_billing_time: "2026-11-03T10:00:00Z", failed_payments_count: 0, last_payment: { time: "2026-10-03T10:00:00Z" } },
  ...over,
});
const map = (s: PaypalSubscription, lastKnownEnd: Date | null = null) =>
  paypalObservation(s, { tier: "supporter", observedAt: NOW, now: NOW, lastKnownEnd });

test("ACTIVE: active, renews, access = next billing time + the grace days", () => {
  const o = map(sub({}));
  assert.deepEqual([o.status, o.renews, o.providerStatus, o.accountRef], ["active", true, "ACTIVE", "PAYER1"]);
  assert.equal(o.accessUntil!.getTime(), Date.parse("2026-11-03T10:00:00Z") + PAYPAL_GRACE_DAYS * DAY);
  assert.equal(o.periodEnd!.toISOString(), "2026-11-03T10:00:00.000Z");
});

test("attack: ACTIVE with failed payments never buys open-ended access — past_due ends a month after the last COMPLETED payment + grace, whenever it is re-read", () => {
  const failing = { next_billing_time: "2026-12-01T00:00:00Z", failed_payments_count: 2, last_payment: { time: "2026-09-25T00:00:00Z" } };
  const o = map(sub({ billing_info: failing }));
  assert.equal(o.status, "past_due");
  assert.equal(o.accessUntil!.toISOString(), new Date(Date.parse("2026-10-25T00:00:00Z") + PAYPAL_GRACE_DAYS * DAY).toISOString());
  // A re-check months later reads the same end: nothing moves it forward.
  const later = paypalObservation(sub({ billing_info: failing }), { tier: "supporter", observedAt: NOW, now: new Date("2027-02-01T00:00:00Z"), lastKnownEnd: null });
  assert.equal(later.accessUntil!.getTime(), o.accessUntil!.getTime());
});

test("attack: ACTIVE with no completed payment at all is pending — no access without money moving", () => {
  for (const failed of [0, 3]) {
    const o = map(sub({ billing_info: { next_billing_time: "2026-11-03T00:00:00Z", failed_payments_count: failed, last_payment: null } }));
    assert.deepEqual([o.status, o.accessUntil], ["pending", null], `failed=${failed}`);
  }
});

test("APPROVAL_PENDING never renews (nothing can charge); APPROVED does", () => {
  assert.deepEqual([map(sub({ status: "APPROVAL_PENDING" })).status, map(sub({ status: "APPROVAL_PENDING" })).renews], ["pending", false]);
  assert.deepEqual([map(sub({ status: "APPROVED" })).status, map(sub({ status: "APPROVED" })).renews], ["pending", true]);
});

test("CANCELLED keeps access to the paid period's end with no grace, then ends (D9)", () => {
  const live = map(sub({ status: "CANCELLED" }));
  assert.deepEqual([live.status, live.renews, live.accessUntil?.toISOString()], ["active", false, "2026-11-03T10:00:00.000Z"]);
  const past = map(sub({ status: "CANCELLED", billing_info: { next_billing_time: "2026-10-01T00:00:00Z", failed_payments_count: 0, last_payment: null } }));
  assert.equal(past.status, "ended");
});

test("attack: never paid, then cancelled → ended at once — a scheduled next billing time is not a paid month", () => {
  const o = map(sub({ status: "CANCELLED", billing_info: { next_billing_time: "2026-11-19T00:00:00Z", failed_payments_count: 0, last_payment: null } }));
  assert.deepEqual([o.status, o.accessUntil], ["ended", null]);
  // …whatever end the record held.
  assert.equal(map(sub({ status: "CANCELLED", billing_info: { next_billing_time: null, failed_payments_count: 0, last_payment: null } }), new Date("2026-12-01T00:00:00Z")).status, "ended");
});

test("attack: a failed payment, then cancelled → access ends a month after the last COMPLETED payment + grace, not at a far scheduled time", () => {
  const failing = { next_billing_time: "2026-12-20T00:00:00Z", failed_payments_count: 2, last_payment: { time: "2026-09-25T00:00:00Z" } };
  const want = Date.parse("2026-10-25T00:00:00Z") + PAYPAL_GRACE_DAYS * DAY;
  assert.equal(map(sub({ status: "CANCELLED", billing_info: failing })).accessUntil!.getTime(), want);
  // A stale record end cannot stretch it either.
  assert.equal(map(sub({ status: "CANCELLED", billing_info: { ...failing, next_billing_time: null } }), new Date("2027-01-01T00:00:00Z")).accessUntil!.getTime(), want);
});

// F7 (sandbox, 2026-10-21): next_billing_time is set before a cancel and GONE after it, so this
// fallback is the path every real cancel takes.
test("F7: a cancelled subscription without next_billing_time keeps access until the record's own end, else last payment + 1 month", () => {
  const known = new Date("2026-11-10T00:00:00Z");
  const noNext = { next_billing_time: null, failed_payments_count: 0, last_payment: { time: "2026-10-31T09:00:00Z" } };
  assert.equal(map(sub({ status: "CANCELLED", billing_info: noNext }), known).accessUntil!.toISOString(), known.toISOString());
  // Oct 31 + 1 month = Nov 30 (the Postgres way), not Dec 1.
  assert.equal(map(sub({ status: "CANCELLED", billing_info: noNext })).accessUntil!.toISOString(), "2026-11-30T09:00:00.000Z");
});

test("SUSPENDED → paused; EXPIRED and any unknown word → ended, never renewing", () => {
  assert.equal(map(sub({ status: "SUSPENDED" })).status, "paused");
  for (const s of ["EXPIRED", "SOMETHING_NEW"]) {
    const o = map(sub({ status: s }));
    assert.deepEqual([o.status, o.renews], ["ended", false]);
  }
});

test("a plan maps to the tier that sells it, and to nothing otherwise", () => {
  assert.equal(tierForPlan({ supporter: "P-A" }, "P-A"), "supporter");
  assert.equal(tierForPlan({ supporter: "P-A" }, "P-B"), null);
  assert.equal(tierForPlan({}, null), null);
});

test("a sale's net: PayPal's own fee when reported in the sale's currency, else the published 3.49% + $0.49", () => {
  assert.deepEqual(saleMoney({ id: "S1", amount: { total: "5.00", currency: "USD" }, transaction_fee: { value: "0.67", currency: "USD" } }),
    { grossCents: 500, netCents: 433, currency: "usd", feeReported: true });
  assert.deepEqual(saleMoney({ id: "S1", amount: { total: "5.00", currency: "USD" } }),
    { grossCents: 500, netCents: estimatePaypalNet(500), currency: "usd", feeReported: false });
  assert.equal(estimatePaypalNet(500), 500 - 66);
  assert.equal(estimatePaypalNet(10), 0, "never below zero");
  assert.equal(saleMoney({ id: "S1", amount: { total: "nope", currency: "USD" } }), null);
});

test("a refund or reversal names its sale by sale_id, else its up link, else (a sale-shaped reversal) its own id", () => {
  assert.equal(saleIdOf({ id: "R1", sale_id: "S1" }), "S1");
  assert.equal(saleIdOf({ id: "R1", links: [{ rel: "up", href: "https://api.sandbox.paypal.com/v1/payments/sale/S2" }] }), "S2");
  assert.equal(saleIdOf({ id: "S3", billing_agreement_id: "I-X", state: "reversed" }), "S3");
  assert.equal(saleIdOf({ id: "R4" }), null);
});

test("attack: a forged webhook without PayPal's transmission headers, or with a cert_url off paypal.com, is refused without a call to PayPal", async () => {
  const { plausiblePaypalDelivery } = await import("../paypalSubscriptions.ts");
  const ok = {
    "paypal-transmission-id": "t1", "paypal-transmission-time": "2026-10-21T00:00:00Z", "paypal-transmission-sig": "sig",
    "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
  };
  assert.equal(plausiblePaypalDelivery(new Headers(ok)), true);
  assert.equal(plausiblePaypalDelivery(new Headers({ ...ok, "paypal-cert-url": "https://api.paypal.com/certs/x" })), true);
  for (const [k, v] of [["paypal-transmission-sig", ""], ["paypal-cert-url", "https://paypal.com.evil.test/c"], ["paypal-cert-url", "https://evilpaypal.com/c"],
    ["paypal-cert-url", "http://api.paypal.com/c"], ["paypal-cert-url", "not a url"]] as const) {
    assert.equal(plausiblePaypalDelivery(new Headers({ ...ok, [k]: v })), false, `${k}=${v}`);
  }
  assert.equal(plausiblePaypalDelivery(new Headers({})), false);
});

test("paypal.plans: only known tiers and plan-shaped ids; JSON text accepted; anything else is no plan", () => {
  assert.deepEqual(parsePaypalPlans({ supporter: " P-ABCDEF123 ", patron: "P-ZZZZZZ999" }), { supporter: "P-ABCDEF123" });
  // attack: an inherited name is not a tier (`"toString" in TIERS` is true; Object.hasOwn is not).
  assert.deepEqual(parsePaypalPlans('{"toString":"P-ABCDEF123","constructor":"P-ABCDEF124"}'), {});
  assert.deepEqual(parsePaypalPlans('{"supporter":"P-ABCDEF123"}'), { supporter: "P-ABCDEF123" });
  for (const bad of [null, "", "{", [], { supporter: "not-a-plan" }, { supporter: 7 }]) assert.deepEqual(parsePaypalPlans(bad), {});
  // Unset (this test sets no PAYPAL_PLANS): no plans, so PayPal subscriptions are not offered.
  assert.deepEqual(paypalPlans(), {});
});

// ── The API client over a stubbed fetch ─────────────────────────────────────────────────────

type Call = { url: string; init?: RequestInit };
function stub(answer: (url: string) => Response): { f: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/v1/oauth2/token")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
    return answer(String(url));
  }) as typeof fetch;
  return { f, calls };
}

test("create sends plan_id, custom_id and NO_SHIPPING (a subscription ships nothing; no address is asked for) and returns PayPal's id", async () => {
  _resetPaypalAccessTokenCache();
  const s = stub(() => new Response(JSON.stringify({ id: "I-NEW", status: "APPROVAL_PENDING" }), { status: 201 }));
  assert.deepEqual(await createPaypalSubscription({ planId: "P-1", customId: "si_x" }, s.f), { id: "I-NEW", status: "APPROVAL_PENDING" });
  const call = s.calls.find((c) => c.url.endsWith("/v1/billing/subscriptions"))!;
  assert.equal(call.url, "https://api-m.sandbox.paypal.com/v1/billing/subscriptions");
  assert.deepEqual(JSON.parse(String(call.init?.body)), { plan_id: "P-1", custom_id: "si_x", application_context: { shipping_preference: "NO_SHIPPING" } });
  assert.ok(call.init?.signal, "every call carries a timeout");
});

test("a GET of a subscription: 404 → null, a PayPal outage throws (the webhook answers 500), and no payer field is kept", async () => {
  _resetPaypalAccessTokenCache();
  const body = { id: "I-1", status: "ACTIVE", plan_id: "P-1", custom_id: "si_x",
    subscriber: { payer_id: "PAYER", name: { given_name: "Real" }, email_address: "x@site.test" }, billing_info: { failed_payments_count: 0 } };
  const ok = stub(() => new Response(JSON.stringify(body), { status: 200 }));
  const got = await getPaypalSubscription("I-1", ok.f);
  assert.deepEqual(got?.subscriber, { payer_id: "PAYER" }, "only the payer id survives");
  assert.equal(JSON.stringify(got).includes("Real"), false);
  assert.equal(await getPaypalSubscription("I-1", stub(() => new Response("{}", { status: 404 })).f), null);
  await assert.rejects(getPaypalSubscription("I-1", stub(() => new Response("{}", { status: 503 })).f), /503/);
  assert.equal(await getPaypalSale("S-1", stub(() => new Response("{}", { status: 404 })).f), null);
});

test("a plan read has TWO failure outcomes, never one null: inactive/gone → 'inactive'; a failed read throws (and keeps throwing for its minute)", async () => {
  const { paypalPlanState, _resetPaypalPlanCacheForTests } = await import("../paypalSubscriptions.ts");
  _resetPaypalAccessTokenCache();
  _resetPaypalPlanCacheForTests();
  const plan = (status: string) => ({ status, billing_cycles: [{ tenure_type: "REGULAR", frequency: { interval_unit: "MONTH", interval_count: 1 },
    pricing_scheme: { fixed_price: { value: "5.00", currency_code: "USD" } } }] });
  assert.deepEqual(await paypalPlanState("P-OK", stub(() => new Response(JSON.stringify(plan("ACTIVE")), { status: 200 })).f), { planId: "P-OK", amount: 500, currency: "usd" });
  assert.equal(await paypalPlanState("P-OFF", stub(() => new Response(JSON.stringify(plan("INACTIVE")), { status: 200 })).f), "inactive");
  assert.equal(await paypalPlanState("P-GONE", stub(() => new Response("{}", { status: 404 })).f), "inactive");
  const down = stub(() => new Response("{}", { status: 503 }));
  await assert.rejects(paypalPlanState("P-DOWN", down.f), /503/);
  const calls = down.calls.length;
  await assert.rejects(paypalPlanState("P-DOWN", down.f), /503/, "the failure is remembered, still a failure — never 'inactive'");
  assert.equal(down.calls.length, calls, "…for its minute, with no new request");
  _resetPaypalPlanCacheForTests();
  assert.deepEqual(await paypalPlanState("P-DOWN", stub(() => new Response(JSON.stringify(plan("ACTIVE")), { status: 200 })).f), { planId: "P-DOWN", amount: 500, currency: "usd" });
});

test("cancel: 204 is done, 422 is already ended, anything else throws", async () => {
  _resetPaypalAccessTokenCache();
  assert.deepEqual(await cancelPaypalSubscription("I-1", stub(() => new Response(null, { status: 204 })).f), { alreadyEnded: false });
  assert.deepEqual(await cancelPaypalSubscription("I-1", stub(() => new Response("{}", { status: 422 })).f), { alreadyEnded: true });
  await assert.rejects(cancelPaypalSubscription("I-1", stub(() => new Response("{}", { status: 500 })).f), /500/);
});

test("the client logs no PayPal body (anchored on the file's end)", () => {
  const raw = readFileSync(join(import.meta.dirname, "..", "paypalSubscriptions.ts"), "utf8");
  assert.match(raw, /return paypalConfigured\(\) && Boolean\(paypalPlans\(\)\.supporter\);\s*\}\s*$/, "END of paypalSubscriptions.ts not read");
  assert.doesNotMatch(stripComments(raw), /console\.\w+\([^)]*\b(j|json|body|res)\b\s*\)/);
});
