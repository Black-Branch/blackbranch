// PayPal API client tests — no real network call, ever. `fetch` is injected
// into every function under test; nothing here talks to api-m.paypal.com.
//
// Run: systemd-run --user --scope -p MemoryMax=8G --quiet node --test app/lib/paypalClient.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";

const {
  paypalConfigured,
  paypalWebhookConfigured,
  paypalApiBase,
  paypalAccessToken,
  createPaypalOrder,
  orderFundingSource,
  capturePaypalOrder,
  verifyPaypalWebhook,
  _resetPaypalAccessTokenCache,
} = await import("./paypalClient.ts");

// ─── env + fetch-stub plumbing ──────────────────────────────────────────────

const ENV_KEYS = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_ENV", "PAYPAL_WEBHOOK_ID"] as const;
type EnvKey = (typeof ENV_KEYS)[number];
type EnvOverrides = Partial<Record<EnvKey, string | undefined>>;

const FULL_ENV: Record<EnvKey, string> = {
  PAYPAL_CLIENT_ID: "test-client-id",
  PAYPAL_CLIENT_SECRET: "test-client-secret",
  PAYPAL_ENV: "sandbox",
  PAYPAL_WEBHOOK_ID: "WH-TEST-1",
};

// Only touches keys explicitly present in `overrides` — an omitted key is
// left as `fresh()` set it. `{ K: undefined }` deletes K; that is the one
// case that needs `in`, not a truthiness check, or it is indistinguishable
// from K being absent altogether.
function setEnv(overrides: EnvOverrides): void {
  for (const k of ENV_KEYS) {
    if (!(k in overrides)) continue;
    const v = overrides[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

let calls: Array<{ url: string; init?: RequestInit }>;

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): typeof fetch {
  return (((url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return impl(String(url), init);
  }) as unknown) as typeof fetch;
}

const json = (body: unknown, status = 200): Promise<Response> =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

/** Every test starts from the same clean slate: a fresh call log, a fresh
 *  token cache (module state — see paypalClient.ts's own docblock on why a
 *  test-only reset exists), and every env var set to a known-good value. */
function fresh(): void {
  calls = [];
  _resetPaypalAccessTokenCache();
  setEnv(FULL_ENV);
}

function paypalHeaders(overrides: Record<string, string> = {}): Headers {
  return new Headers({
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": "https://api.sandbox.paypal.com/cert",
    "paypal-transmission-id": "tid-1",
    "paypal-transmission-sig": "sig-1",
    "paypal-transmission-time": "2026-09-22T00:00:00Z",
    ...overrides,
  });
}

const header = (init: RequestInit | undefined, name: string): string | undefined =>
  (init?.headers as Record<string, string> | undefined)?.[name];

// ─── paypalConfigured / paypalWebhookConfigured ─────────────────────────────

test("paypalConfigured() is true once client id, secret and env are all set", () => {
  fresh();
  assert.equal(paypalConfigured(), true);
});

test("paypalConfigured() is false when any of the three required vars is missing", () => {
  fresh();
  setEnv({ PAYPAL_CLIENT_ID: undefined });
  assert.equal(paypalConfigured(), false, "missing client id");
  fresh();
  setEnv({ PAYPAL_CLIENT_SECRET: undefined });
  assert.equal(paypalConfigured(), false, "missing client secret");
  fresh();
  setEnv({ PAYPAL_ENV: undefined });
  assert.equal(paypalConfigured(), false, "missing env");
});

test("paypalConfigured() does NOT require PAYPAL_WEBHOOK_ID — it cannot exist until the webhook route is registered with PayPal, and the order path must work before then", () => {
  fresh();
  setEnv({ PAYPAL_WEBHOOK_ID: undefined });
  assert.equal(paypalConfigured(), true);
});

test("paypalWebhookConfigured() additionally requires PAYPAL_WEBHOOK_ID", () => {
  fresh();
  setEnv({ PAYPAL_WEBHOOK_ID: undefined });
  assert.equal(paypalWebhookConfigured(), false);
  fresh();
  assert.equal(paypalWebhookConfigured(), true);
});

test("paypalWebhookConfigured() is false if the base creds are missing even when a webhook id is present", () => {
  fresh();
  setEnv({ PAYPAL_CLIENT_ID: undefined });
  assert.equal(paypalWebhookConfigured(), false);
});

// ─── paypalApiBase ───────────────────────────────────────────────────────────

test("paypalApiBase() switches on PAYPAL_ENV", () => {
  fresh();
  setEnv({ PAYPAL_ENV: "live" });
  assert.equal(paypalApiBase(), "https://api-m.paypal.com");
  setEnv({ PAYPAL_ENV: "sandbox" });
  assert.equal(paypalApiBase(), "https://api-m.sandbox.paypal.com");
});

test("paypalApiBase() defaults to the SAFE side (sandbox) when PAYPAL_ENV is unset or unrecognized", () => {
  fresh();
  setEnv({ PAYPAL_ENV: undefined });
  assert.equal(paypalApiBase(), "https://api-m.sandbox.paypal.com");
  setEnv({ PAYPAL_ENV: "production" }); // not the literal PayPal expects
  assert.equal(paypalApiBase(), "https://api-m.sandbox.paypal.com");
});

// ─── paypalAccessToken ───────────────────────────────────────────────────────

test("fetches a token with client-credentials + basic auth, and returns it", async () => {
  fresh();
  const f = stubFetch(() => json({ access_token: "tok-1", expires_in: 3600 }));
  const token = await paypalAccessToken(f);
  assert.equal(token, "tok-1");
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /^https:\/\/api-m\.sandbox\.paypal\.com\/v1\/oauth2\/token$/);
  assert.equal(calls[0]!.init?.method, "POST");
  assert.equal(
    header(calls[0]!.init, "Authorization"),
    `Basic ${Buffer.from("test-client-id:test-client-secret").toString("base64")}`,
  );
  assert.equal(header(calls[0]!.init, "Content-Type"), "application/x-www-form-urlencoded");
  assert.equal(calls[0]!.init?.body, "grant_type=client_credentials");
  assert.ok(calls[0]!.init?.signal instanceof AbortSignal, "the token call must carry a deadline");
});

test("a cached token is reused within its lifetime — no second fetch", async (t) => {
  fresh();
  t.mock.timers.enable({ apis: ["Date"] });
  const f = stubFetch(() => json({ access_token: "tok-1", expires_in: 3600 }));
  await paypalAccessToken(f);
  assert.equal(calls.length, 1);
  // expires_in(3600) - 60s safety margin = 3540s; one millisecond short of
  // that must still serve the cached token.
  t.mock.timers.tick(3540 * 1000 - 1);
  const token = await paypalAccessToken(f);
  assert.equal(token, "tok-1");
  assert.equal(calls.length, 1, "must be served from cache, not refetched");
});

test("the cached token is refetched once its lifetime has elapsed", async (t) => {
  fresh();
  t.mock.timers.enable({ apis: ["Date"] });
  let n = 0;
  const f = stubFetch(() => {
    n += 1;
    return json({ access_token: `tok-${n}`, expires_in: 3600 });
  });
  await paypalAccessToken(f);
  assert.equal(calls.length, 1);
  t.mock.timers.tick(3540 * 1000);
  const token = await paypalAccessToken(f);
  assert.equal(token, "tok-2");
  assert.equal(calls.length, 2, "past the cached lifetime, a fresh token must be fetched");
});

test("a non-200 from the token endpoint throws — never a falsy success", async () => {
  fresh();
  const f = stubFetch(() => json({ error: "invalid_client" }, 401));
  await assert.rejects(() => paypalAccessToken(f), /401/);
});

test("concurrent callers on a cold cache share ONE in-flight token fetch, not one each", async () => {
  fresh();
  let n = 0;
  const f = stubFetch(() => {
    n += 1;
    return json({ access_token: `tok-${n}`, expires_in: 3600 });
  });
  const [a, b] = await Promise.all([paypalAccessToken(f), paypalAccessToken(f)]);
  assert.equal(a, b, "both concurrent callers must resolve to the SAME token");
  assert.equal(calls.length, 1, "two callers arriving together must cost one fetch, not two");
});

test("a failed token fetch does not poison the cache — a later caller can still retry and succeed", async () => {
  fresh();
  const failing = stubFetch(() => json({ error: "invalid_client" }, 401));
  await assert.rejects(() => paypalAccessToken(failing), /401/);
  const working = stubFetch(() => json({ access_token: "tok-ok", expires_in: 3600 }));
  const token = await paypalAccessToken(working);
  assert.equal(token, "tok-ok", "the earlier failure must not stick around and fail every later call too");
});

// ─── createPaypalOrder ───────────────────────────────────────────────────────

function stubOrderFlow(orderRes: () => Promise<Response>) {
  return stubFetch((url) => (url.endsWith("/v1/oauth2/token") ? json({ access_token: "tok-x", expires_in: 3600 }) : orderRes()));
}

test("creates an order carrying the amount (2dp), the custom id, and a bearer token", async () => {
  fresh();
  const f = stubOrderFlow(() => json({ id: "ORDER-1", status: "CREATED" }));
  const { orderId } = await createPaypalOrder({ amountUsd: 12.5, customId: "abc-123" }, f);
  assert.equal(orderId, "ORDER-1");
  assert.equal(calls.length, 2, "token fetch, then the order call");
  const orderCall = calls[1]!;
  assert.match(orderCall.url, /^https:\/\/api-m\.sandbox\.paypal\.com\/v2\/checkout\/orders$/);
  assert.equal(header(orderCall.init, "Authorization"), "Bearer tok-x");
  const body = JSON.parse(orderCall.init!.body as string);
  assert.equal(body.intent, "CAPTURE");
  assert.equal(body.purchase_units[0].amount.currency_code, "USD");
  assert.equal(body.purchase_units[0].amount.value, "12.50");
  assert.equal(body.purchase_units[0].custom_id, "abc-123");
  assert.ok(orderCall.init?.signal instanceof AbortSignal, "the order call must carry a deadline");
});

// ─── NO_SHIPPING (k 2026-10-19) ─────────────────────────────────────────────
// A tip or a points purchase ships nothing, and PayPal's default
// (GET_FROM_FILE) asks the buyer for a shipping address and returns it in the
// order — an address this site has no use for and must not collect. The
// preference lives in the v2 `payment_source.<source>.experience_context`, and
// the source is the button the buyer pressed: PayPal and Venmo each have their own.

function orderBody(): {
  intent: string;
  payment_source: Record<string, { experience_context: Record<string, string> }>;
  application_context?: unknown;
} {
  const orderCall = calls.find((c) => c.url.endsWith("/v2/checkout/orders"));
  assert.ok(orderCall, "no order call was made");
  return JSON.parse(orderCall.init!.body as string);
}

test("a PayPal order asks for NO shipping address, and pays now (the button captures on approve)", async () => {
  fresh();
  const f = stubOrderFlow(() => json({ id: "ORDER-NS", status: "CREATED" }));
  await createPaypalOrder({ amountUsd: 5, customId: "ns-1" }, f);
  const body = orderBody();
  assert.deepEqual(Object.keys(body.payment_source), ["paypal"], "an order with no funding source named is a PayPal order");
  assert.equal(body.payment_source.paypal!.experience_context.shipping_preference, "NO_SHIPPING");
  assert.equal(body.payment_source.paypal!.experience_context.user_action, "PAY_NOW");
  assert.equal(body.application_context, undefined, "the deprecated application_context must not carry a second, conflicting preference");
});

// A Venmo press must NOT name payment_source.venmo: PayPal answers such an order
// PAYER_ACTION_REQUIRED with no approval link at all (sandbox, 2026-10-19), and the
// SDK's Venmo popup failed on it ("check info and try again") before onApprove.
// A plain order is CREATED with an `approve` link, the shape the SDK's Venmo flow
// approves; its NO_SHIPPING rides in application_context, which applies to whichever
// funding source approves it (PayPal refuses a bogus value there, so it is read).
test("a Venmo order is a plain order (no payment_source) with NO_SHIPPING in application_context", async () => {
  fresh();
  const f = stubOrderFlow(() => json({ id: "ORDER-V", status: "CREATED" }));
  await createPaypalOrder({ amountUsd: 5, customId: "ns-2", fundingSource: "venmo" }, f);
  const body = orderBody() as unknown as { payment_source?: unknown; application_context?: Record<string, string> };
  assert.equal(body.payment_source, undefined, "payment_source.venmo makes an order the SDK popup cannot approve");
  assert.deepEqual(body.application_context, { shipping_preference: "NO_SHIPPING", user_action: "PAY_NOW" });
});

test("retry: a Venmo press after a PayPal press (same process, cached token) still gets the plain body, and back again", async () => {
  fresh();
  const f = stubOrderFlow(() => json({ id: "ORDER-X", status: "CREATED" }));
  for (const source of ["paypal", "venmo", "paypal"] as const) {
    calls = [];
    await createPaypalOrder({ amountUsd: 5, customId: `x-${source}`, fundingSource: source }, f);
    const body = orderBody() as unknown as { payment_source?: Record<string, unknown>; application_context?: unknown };
    if (source === "venmo") assert.equal(body.payment_source, undefined);
    else assert.deepEqual(Object.keys(body.payment_source ?? {}), ["paypal"]);
    assert.equal(body.application_context === undefined, source === "paypal", "exactly one place carries the preference");
  }
});

test("the order carries no brand_name — the site never passed one, and PayPal then shows the account's own", async () => {
  fresh();
  const f = stubOrderFlow(() => json({ id: "ORDER-B", status: "CREATED" }));
  await createPaypalOrder({ amountUsd: 5, customId: "ns-3" }, f);
  assert.equal(orderBody().payment_source.paypal!.experience_context.brand_name, undefined);
});

test("retry: a second order after a failed first still asks for NO_SHIPPING (the cached-token path builds the same body)", async () => {
  fresh();
  let n = 0;
  const f = stubOrderFlow(() => (++n === 1 ? json({ error: "internal" }, 500) : json({ id: "ORDER-R", status: "CREATED" })));
  await assert.rejects(() => createPaypalOrder({ amountUsd: 7, customId: "r-1" }, f), /500/);
  calls = [];
  const { orderId } = await createPaypalOrder({ amountUsd: 7, customId: "r-1" }, f);
  assert.equal(orderId, "ORDER-R");
  assert.equal(calls.length, 1, "the retry reuses the cached token: only the order call");
  assert.equal(orderBody().payment_source.paypal!.experience_context.shipping_preference, "NO_SHIPPING");
});

test("orderFundingSource: absent or 'paypal' = paypal, 'venmo' = venmo, anything else refused", () => {
  assert.equal(orderFundingSource(undefined), "paypal");
  assert.equal(orderFundingSource(null), "paypal");
  assert.equal(orderFundingSource("paypal"), "paypal");
  assert.equal(orderFundingSource("venmo"), "venmo");
  for (const bad of ["card", "VENMO", "", 1, {}]) assert.equal(orderFundingSource(bad), null, `${JSON.stringify(bad)} must be refused`);
});

test("a non-2xx from order creation throws — never a falsy success", async () => {
  fresh();
  const f = stubOrderFlow(() => json({ error: "bad_request" }, 400));
  await assert.rejects(() => createPaypalOrder({ amountUsd: 5, customId: "x" }, f), /400/);
});

// ─── capturePaypalOrder ──────────────────────────────────────────────────────
// createPaypalOrder mints an order with
// intent:"CAPTURE", but PayPal does NOT capture an approved order on its own —
// something must call POST /v2/checkout/orders/{id}/capture. This is that call.

function stubCaptureFlow(captureRes: () => Promise<Response>) {
  return stubFetch((url) => (url.endsWith("/v1/oauth2/token") ? json({ access_token: "tok-cap", expires_in: 3600 }) : captureRes()));
}

// ── real 422 envelopes ──────────────────────────────────────────────────────
//
// A REAL 422 from PayPal's sandbox (an unapproved order), not a hand-typed
// guess:
//
//   {"name":"UNPROCESSABLE_ENTITY",
//    "details":[{"issue":"ORDER_NOT_APPROVED","description":"…"}],
//    "links":[{"href":"https://developer.paypal.com/api/…#ORDER_NOT_APPROVED",…}]}
//
// PayPal echoes the issue code into `links[].href` (its own docs URL) — a
// substring match over the WHOLE body reads that URL as data. A 422 whose
// `details[].issue` is really ORDER_NOT_APPROVED but whose doc link happens
// to mention ORDER_ALREADY_CAPTURED (a plausible future PayPal copy change,
// or literally this fixture with the issue and href swapped) would then be
// misread as "already captured" — telling a tipper the money went through
// when it did not. capturePaypalOrder must check `details[].issue`
// structurally, falling back to the substring match ONLY when the body
// doesn't parse as JSON at all.
const CAPTURE_FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "paypal");
const alreadyCapturedFixtureText = readFileSync(join(CAPTURE_FIXTURE_DIR, "capture-422-order-already-captured.json"), "utf8");
const notApprovedFixtureText = readFileSync(join(CAPTURE_FIXTURE_DIR, "capture-422-order-not-approved.json"), "utf8");

function json422(bodyText: string): Promise<Response> {
  return Promise.resolve(new Response(bodyText, { status: 422, headers: { "content-type": "application/json" } }));
}

test("captures an order with a bearer token, the right URL, and a 10s deadline", async () => {
  fresh();
  const f = stubCaptureFlow(() => json({ id: "ORDER-1", status: "COMPLETED" }));
  const result = await capturePaypalOrder("ORDER-1", f);
  assert.deepEqual(result, { captured: true, alreadyCaptured: false });
  assert.equal(calls.length, 2, "token fetch, then the capture call");
  const captureCall = calls[1]!;
  assert.match(captureCall.url, /^https:\/\/api-m\.sandbox\.paypal\.com\/v2\/checkout\/orders\/ORDER-1\/capture$/);
  assert.equal(captureCall.init?.method, "POST");
  assert.equal(header(captureCall.init, "Authorization"), "Bearer tok-cap");
  assert.ok(captureCall.init?.signal instanceof AbortSignal, "the capture call must carry a deadline");
});

test("the real ORDER_ALREADY_CAPTURED 422 fixture reads as already-captured, not a failure — a double-submit or retry must not look like an error", async () => {
  fresh();
  const f = stubCaptureFlow(() => json422(alreadyCapturedFixtureText));
  const result = await capturePaypalOrder("ORDER-1", f);
  assert.deepEqual(result, { captured: true, alreadyCaptured: true });
});

test("the real ORDER_NOT_APPROVED 422 fixture still throws — the order was never paid, this is a real failure", async () => {
  fresh();
  const f = stubCaptureFlow(() => json422(notApprovedFixtureText));
  await assert.rejects(() => capturePaypalOrder("ORDER-1", f), /422/);
});

test("the regression this exists to catch: details[].issue is ORDER_NOT_APPROVED but links[].href happens to contain the literal string ORDER_ALREADY_CAPTURED — must still throw, not read as success", async () => {
  fresh();
  // Built BY HAND from the real not-approved envelope: same issue, same
  // description, only the doc link's href is swapped to the already-captured
  // one — proving the structural check reads `details[].issue`, not
  // whatever text happens to appear anywhere in the body.
  const real = JSON.parse(notApprovedFixtureText) as {
    details: Array<{ issue: string }>;
    links: Array<{ href: string }>;
  };
  assert.equal(real.details[0]?.issue, "ORDER_NOT_APPROVED", "vacuity anchor: the fixture's issue code is not what this test assumes");
  assert.ok(!real.links[0]?.href.includes("ORDER_ALREADY_CAPTURED"), "vacuity anchor: the real fixture's href already contains the literal string this test swaps in — the mutation below would be a no-op");
  const poisoned = { ...real, links: [{ ...real.links[0], href: "https://developer.paypal.com/api/rest/reference/orders/v2/errors/#ORDER_ALREADY_CAPTURED" }] };
  const f = stubCaptureFlow(() => json422(JSON.stringify(poisoned)));
  await assert.rejects(
    () => capturePaypalOrder("ORDER-1", f),
    /422/,
    "a substring match over the whole body would misread this doc-link text as ORDER_ALREADY_CAPTURED and report success on an order that was never paid",
  );
});

test("any other non-2xx throws — never a falsy success", async () => {
  fresh();
  const f = stubCaptureFlow(() => json({ error: "server_error" }, 500));
  await assert.rejects(() => capturePaypalOrder("ORDER-1", f), /500/);
});

test("a body that does not parse as JSON falls back to the substring match rather than throwing on the parse failure itself — a 422 we cannot read structurally is still a 422", async () => {
  fresh();
  let textCalls = 0;
  const fakeRes = {
    ok: false,
    status: 422,
    text: async () => {
      textCalls += 1;
      return "not json at all, but it does say ORDER_ALREADY_CAPTURED somewhere in it";
    },
  } as unknown as Response;
  const f = stubFetch((url) =>
    url.endsWith("/v1/oauth2/token") ? json({ access_token: "tok-once", expires_in: 3600 }) : Promise.resolve(fakeRes),
  );
  const result = await capturePaypalOrder("ORDER-1", f);
  assert.deepEqual(result, { captured: true, alreadyCaptured: true }, "the fallback substring match must still run when JSON.parse fails");
  // Read at most once — it can carry payer fields and must never be logged —
  // and in particular the fallback must reuse the SAME text already read,
  // not call res.text() a second time.
  assert.equal(textCalls, 1, "the capture response body must be read at most once");
});

test("a body that does not parse as JSON AND does not contain the substring still throws — the fallback is a floor, not a second way to succeed", async () => {
  fresh();
  const f = stubCaptureFlow(() => Promise.resolve(new Response("also not json, and no relevant text either", { status: 422 })));
  await assert.rejects(() => capturePaypalOrder("ORDER-1", f), /422/);
});

// ─── verifyPaypalWebhook ─────────────────────────────────────────────────────

function stubVerifyFlow(verifyRes: () => Promise<Response>) {
  return stubFetch((url) =>
    url.endsWith("/v1/oauth2/token") ? json({ access_token: "tok-y", expires_in: 3600 }) : verifyRes(),
  );
}

test("verifies against PayPal, forwarding the PAYPAL-* headers, the webhook id, and the PARSED raw body — true only on an exact SUCCESS status", async () => {
  fresh();
  const rawBody = JSON.stringify({ id: "WH-EVT-1", event_type: "PAYMENT.CAPTURE.COMPLETED" });
  const f = stubVerifyFlow(() => json({ verification_status: "SUCCESS" }));
  const ok = await verifyPaypalWebhook({ headers: paypalHeaders(), rawBody }, f);
  assert.equal(ok, true);
  assert.equal(calls.length, 2, "token fetch, then the verify call");
  const verifyCall = calls[1]!;
  assert.match(verifyCall.url, /^https:\/\/api-m\.sandbox\.paypal\.com\/v1\/notifications\/verify-webhook-signature$/);
  assert.equal(header(verifyCall.init, "Authorization"), "Bearer tok-y");
  const body = JSON.parse(verifyCall.init!.body as string);
  assert.equal(body.auth_algo, "SHA256withRSA");
  assert.equal(body.cert_url, "https://api.sandbox.paypal.com/cert");
  assert.equal(body.transmission_id, "tid-1");
  assert.equal(body.transmission_sig, "sig-1");
  assert.equal(body.transmission_time, "2026-09-22T00:00:00Z");
  assert.equal(body.webhook_id, "WH-TEST-1");
  assert.deepEqual(body.webhook_event, { id: "WH-EVT-1", event_type: "PAYMENT.CAPTURE.COMPLETED" });
  assert.ok(verifyCall.init?.signal instanceof AbortSignal, "the verify call must carry a deadline");
});

test("returns false for a 200 whose body explicitly reports FAILURE", async () => {
  fresh();
  const f = stubVerifyFlow(() => json({ verification_status: "FAILURE" }));
  const ok = await verifyPaypalWebhook({ headers: paypalHeaders(), rawBody: "{}" }, f);
  assert.equal(ok, false);
});

test("returns false for a 200 whose body has NO verification_status field at all — a different bug from an explicit FAILURE, so it gets its own case", async () => {
  fresh();
  const f = stubVerifyFlow(() => json({ some_unrelated_field: true }));
  const ok = await verifyPaypalWebhook({ headers: paypalHeaders(), rawBody: "{}" }, f);
  assert.equal(ok, false);
});

test("a non-200 from the verify endpoint THROWS — a PayPal outage must not be mistaken for a forged webhook and silently drop a real tip", async () => {
  fresh();
  const f = stubVerifyFlow(() => json({ error: "server_error" }, 500));
  await assert.rejects(() => verifyPaypalWebhook({ headers: paypalHeaders(), rawBody: "{}" }, f), /500/);
});

test("a rawBody that is NOT valid JSON returns false, not a throw — unlike a PayPal outage, a malformed body can never become verifiable, so it must be rejected rather than retried", async () => {
  fresh();
  const f = stubFetch(() => {
    throw new Error("must not reach PayPal at all — an unparseable body is known-bad before any network call");
  });
  const ok = await verifyPaypalWebhook({ headers: paypalHeaders(), rawBody: "not json{" }, f);
  assert.equal(ok, false);
  assert.equal(calls.length, 0, "a malformed body must not cost a token fetch or a verify call");
});

// ─── payer PII: never read ───────────────────────────────────────────────────
//
// A source scan, not a runtime one: this module never receives a PayPal
// response body that WOULD carry payer.name/email_address (order-create's
// response is {id, status, ...}; the webhook verify response is
// {verification_status}), but the rule is absolute enough to pin directly
// against drift, same spirit as payerName.scan.test.ts.
//
// Vacuity anchor: read() below asserts the file ends where expected, so a
// truncated read cannot make this pass by proving nothing.

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readOwnSource(tail: RegExp): string {
  const src = readFileSync(join(webRoot, "app/lib/paypalClient.ts"), "utf8");
  assert.match(src.slice(-300), tail, "paypalClient.ts did not end as expected — the read is truncated");
  return stripComments(src);
}

// isOrderAlreadyCaptured (capturePaypalOrder's own helper) is the last
// thing in the file.
const ENDS_WITH_CAPTURE = /return Array\.isArray\(parsed\?\.details\) && parsed\.details\.some\(\(d\) => d\?\.issue === "ORDER_ALREADY_CAPTURED"\);\s*}\s*$/;

test("paypalClient.ts never reads payer.name or the payer's email address", () => {
  const src = readOwnSource(ENDS_WITH_CAPTURE);
  assert.ok(!/payer\s*[.?]\s*name/.test(src), "reads payer.name");
  assert.ok(!/email_address/.test(src), "reads the payer's email address");
});

test("every outbound call in paypalClient.ts carries the same 10s AbortSignal.timeout, matching the platform-link callback's shape", () => {
  const src = readOwnSource(ENDS_WITH_CAPTURE);
  const found = src.match(/signal:\s*AbortSignal\.timeout\(10_000\)/g) ?? [];
  assert.equal(found.length, 4, `expected the token, order, verify AND capture calls to each carry it, found ${found.length}`);
});

test("capturePaypalOrder never logs the response body it reads (it can carry payer fields)", () => {
  const src = readOwnSource(ENDS_WITH_CAPTURE);
  const fnAt = src.indexOf("export async function capturePaypalOrder(");
  assert.ok(fnAt !== -1, "vacuity anchor: capturePaypalOrder is gone or renamed");
  const fnBody = src.slice(fnAt);
  assert.ok(fnBody.length > 200, "vacuity anchor: capturePaypalOrder's body reads implausibly short");
  assert.doesNotMatch(fnBody, /console\.(log|error|warn)\([^)]*(bodyText|await res\.text)/, "the capture response body must never be logged — it can carry payer fields");
});
