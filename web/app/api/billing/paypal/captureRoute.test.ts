// PayPal capture route. route.ts imports `@/auth` and `@/app/lib/paypalClient`'s
// `capturePaypalOrder`, and (like every other route test in this repo)
// `node --test` cannot resolve the `@/auth` aliased import, so this is a
// SOURCE SCAN — same shape as orderRules.test.ts and webhook/route.test.ts.
//
// The headline invariant: this route writes NOTHING to the database. No
// status flip, no grant, no celebration, no payment_events row. The webhook
// (app/api/billing/paypal/webhook/route.ts) is the ONLY writer of PayPal
// payment state — this route's only job is telling PayPal to take the money
// createPaypalOrder already promised. The last assertion in this file pins
// that structurally.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "../../../lib/testSource.ts";

const raw = readFileSync(new URL("./capture/route.ts", import.meta.url), "utf8");
const src = stripComments(raw);

test("capture/route.ts is whole — vacuity anchor for the assertions below", () => {
  assert.ok(raw.trimEnd().endsWith("}"), "capture/route.ts truncated — pins below are vacuous");
  assert.match(src, /export async function POST\(/, "no POST handler found — wrong file or wrong shape");
});

test("runtime is nodejs", () => {
  assert.match(src, /export const runtime = "nodejs";/);
});

test("paypalConfigured() gates the route with a 503 before the body is even parsed", () => {
  const gate = src.indexOf("paypalConfigured()");
  const bodyParse = src.indexOf("req.json()");
  assert.ok(gate >= 0, "no paypalConfigured() gate found");
  assert.match(src.slice(gate, gate + 100), /status: 503/, "the gate must refuse with 503");
  assert.ok(gate < bodyParse, "the 503 gate must run before the body is parsed");
});

test("a malformed orderId is refused with 400 BEFORE the rate limiter", () => {
  const bodyParse = src.indexOf("req.json()");
  const refusal400 = src.indexOf("status: 400");
  const limiterCall = src.indexOf("isPaypalCaptureLimited(");
  assert.ok(refusal400 > bodyParse, "no 400 refusal after body parsing found");
  assert.ok(limiterCall > 0, "no rate-limiter call found — createSlidingWindowLimiter must actually be invoked");
  assert.ok(refusal400 < limiterCall, "the orderId shape refusal must run BEFORE the rate limiter — a malformed request must not consume budget");
});

test("orderId is validated against PayPal's actual id shape, not just 'is a string'", () => {
  // 17 uppercase-alnum characters, matching both a capture-completed webhook
  // fixture (8U481631H66031715) and a real sandbox order id (3C2039346F8524101).
  assert.match(src, /\[A-Z0-9\]\{17\}/, "expected an order-id shape regex matching PayPal's real id format");
});

test("the limiter keys on the signed-in user, else the client IP — same shape as the order route", () => {
  assert.match(src, /const isPaypalCaptureLimited = createSlidingWindowLimiter\(/);
  assert.match(src, /isPaypalCaptureLimited\(matrixId \?\? ipKey\(req\)\)/);
  const limiterCall = src.indexOf("isPaypalCaptureLimited(matrixId");
  assert.match(src.slice(limiterCall, limiterCall + 150), /status: 429/, "a limited caller must be refused with 429");
});

test("a guest (null matrixId) is accepted — auth() result is never required", () => {
  assert.match(src, /const matrixId = session\?\.user\?\.id \?\? null/);
  assert.doesNotMatch(src, /if \(!matrixId\)/);
});

test("capturePaypalOrder is called, and a throw answers 502 with one console.error naming the order id only", () => {
  const callAt = src.indexOf("capturePaypalOrder(");
  assert.ok(callAt > 0, "capturePaypalOrder must actually be called");
  const tryAt = src.lastIndexOf("try {", callAt);
  assert.ok(tryAt >= 0 && tryAt < callAt, "capturePaypalOrder must be called inside its own try");
  const catchAt = src.indexOf("catch", callAt);
  assert.ok(catchAt > callAt, "no catch found after the capturePaypalOrder call");
  const catchBlock = src.slice(catchAt, src.indexOf("}", src.indexOf("{", catchAt)) + 1);
  assert.match(catchBlock, /status: 502/, "a capture failure must answer 502");
  assert.match(catchBlock, /console\.error\(/, "a capture failure must be logged");
  assert.match(catchBlock, /orderId/, "the log must name the order id");
  // The response body PayPal sent back is never logged, per capturePaypalOrder's
  // own contract — the catch only ever sees the thrown Error, which carries a
  // status code, never the raw body.
  assert.doesNotMatch(catchBlock, /err\.message|\(e as Error\)\.message|error\.message/, "the catch must not log the caught error's message — capturePaypalOrder's throw carries only a status code today, but naming the order id (not the error) is the stable contract this pins");
});

test("success returns { ok: true }", () => {
  assert.match(src, /return Response\.json\(\{\s*ok:\s*true\s*\}\)/);
});

test("this route writes NOTHING to the database — no status flip, no grant, no celebration, no payment_events row", () => {
  assert.ok(src.length > 400, "vacuity anchor: the route source read implausibly short — the scan below would prove nothing");
  assert.doesNotMatch(src, /pool\.query/, "capture/route.ts must never call pool.query — the webhook is the only writer of PayPal payment state");
  assert.doesNotMatch(src, /\bINSERT\b/, "capture/route.ts must never INSERT");
  assert.doesNotMatch(src, /\bUPDATE\b/, "capture/route.ts must never UPDATE");
  assert.doesNotMatch(src, /broadcastChatEvent/, "capture/route.ts must never fire a chat/alert event — that's the webhook's job");
});

test("the invariant is stated in a comment at the top of the file", () => {
  assert.match(raw.slice(0, 1200), /writes NOTHING|writes nothing/i, "the file must say, near the top, that it writes nothing to the database — this is the whole design invariant the route is built on");
});
