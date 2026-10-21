// The Stripe page's price check (contract 6), against RECORDED Stripe answers. Nothing here
// touches a network; the check is one GET and nothing else.
// Run: node --test app/lib/setup/setupChecks.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkStripePrice } from "./setupChecks.ts";

type Call = { url: string; method: string; auth: string | null };
function stripe(status: number, body?: unknown) {
  const calls: Call[] = [];
  const f = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: (init.method ?? "GET").toUpperCase(), auth: new Headers(init.headers).get("authorization") });
    return new Response(body === undefined ? "" : JSON.stringify(body), { status });
  };
  return Object.assign(f, { calls });
}
const PRICE = { id: "price_1Abc", object: "price", active: true, type: "recurring", currency: "usd", unit_amount: 500, recurring: { interval: "month", interval_count: 1 } };
const run = (f: ReturnType<typeof stripe>, key = "rk_test_FAKEKEY1", id: string | null = "price_1Abc") => checkStripePrice(id, key, f as unknown as typeof fetch);

test("an active monthly price passes, with its amount in its own currency — one GET with the saved key", async () => {
  const f = stripe(200, PRICE);
  assert.deepEqual(await run(f), { ok: true, detail: "found: $5.00 a month (test)" });
  assert.deepEqual(f.calls, [{ url: "https://api.stripe.com/v1/prices/price_1Abc", method: "GET", auth: "Bearer rk_test_FAKEKEY1" }]);
  assert.match((await run(stripe(200, { ...PRICE, currency: "jpy", unit_amount: 600 }), "rk_live_FAKEKEY1")).detail, /found: ¥600 a month \(live\)/, "a zero-decimal currency");
  assert.match((await run(stripe(200, { ...PRICE, currency: "eur", unit_amount: 450 }))).detail, /€4\.50/);
});

test("each wrong price says what is wrong", async () => {
  for (const [body, says] of [
    [{ ...PRICE, active: false }, /archived/],
    [{ ...PRICE, type: "one_time", recurring: null }, /one-time price.*Recurring/],
    [{ ...PRICE, recurring: { interval: "year", interval_count: 1 } }, /bills every year.*Monthly/],
    [{ ...PRICE, recurring: { interval: "month", interval_count: 3 } }, /bills every 3 month/],
  ] as const) {
    const r = await run(stripe(200, body));
    assert.equal(r.ok, false);
    assert.match(r.detail, says);
  }
});

test("Stripe's refusals name the cause: wrong mode, a refused key, a key without Read on Prices", async () => {
  assert.match((await run(stripe(404, { error: { message: "No such price" } }))).detail, /no price with this id in test mode/);
  assert.match((await run(stripe(404, {}), "rk_live_FAKEKEY1")).detail, /in live mode — a live key sees only live prices/);
  assert.match((await run(stripe(401, {}))).detail, /refused the secret key/);
  assert.match((await run(stripe(403, { error: { message: "The provided key does not have the required permissions" } }))).detail, /Read on Prices/);
  assert.match((await run(stripe(500, {}))).detail, /HTTP 500/);
});

test("nothing is fetched without a price id, a price-shaped id or a key", async () => {
  for (const [id, key, says] of [[null, "rk_test_x", /no price id/], ["prod_1Abc", "rk_test_x", /price_/], ["price_1Abc", null, /secret key first/]] as const) {
    const f = stripe(200, PRICE);
    const r = await checkStripePrice(id, key, f as unknown as typeof fetch);
    assert.equal(r.ok, false); assert.match(r.detail, says);
    assert.equal(f.calls.length, 0);
  }
});

test("a network failure is a plain sentence, never a thrown error", async () => {
  const r = await checkStripePrice("price_1Abc", "rk_test_x", (async () => { throw new TypeError("fetch failed"); }) as typeof fetch);
  assert.deepEqual(r, { ok: false, detail: "could not reach Stripe — try again" });
});

test("retry: the same check twice gives the same answer (it keeps nothing between runs)", async () => {
  const f = stripe(200, PRICE);
  assert.deepEqual(await run(f), await run(f));
  assert.equal(f.calls.length, 2);
});
