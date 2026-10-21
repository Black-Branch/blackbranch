// Wiring guard — route.ts imports the @/app/lib/* aliases and cannot be
// executed under node --test (same reason as app/api/billing/webhook/route.test.ts).
// Pins verify-before-parse, the 500-vs-400 split (Ruling 7), the switch
// wiring, and that the raw body is never logged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "../../../../lib/testSource.ts";

const raw = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
const src = stripComments(raw);

test("route.ts is whole — vacuity anchor for the assertions below", () => {
  assert.ok(raw.trimEnd().endsWith("}"), "webhook/route.ts truncated — pins below are vacuous");
  assert.match(src, /export async function POST\(/, "no POST handler found — wrong file or wrong shape");
});

test("runtime is nodejs", () => {
  assert.match(src, /export const runtime = "nodejs";/);
});

test("paypalWebhookConfigured() gates the route with a 503 before the body is even read", () => {
  const gate = src.indexOf("paypalWebhookConfigured()");
  const bodyRead = src.indexOf("req.text()");
  assert.ok(gate >= 0, "no paypalWebhookConfigured() gate found");
  assert.match(src.slice(gate, gate + 250), /status: 503/, "the gate must refuse with 503");
  assert.ok(bodyRead > gate, "the 503 gate must run before the raw body is read");
});

test("verification receives the exact raw text, not a re-serialized body", () => {
  assert.match(src, /const raw = await req\.text\(\)/);
  assert.match(src, /verifyPaypalWebhook\(\{\s*headers:\s*req\.headers,\s*rawBody:\s*raw\s*\}\)/);
});

test("a verification THROW (PayPal-side outage) answers 500, kept apart from the false-signature 400", () => {
  const verifyCallAt = src.indexOf("verifyPaypalWebhook(");
  const tryAt = src.lastIndexOf("try {", verifyCallAt);
  assert.ok(tryAt >= 0 && tryAt < verifyCallAt, "verifyPaypalWebhook must sit inside its own try");
  const catchAt = src.indexOf("catch", verifyCallAt);
  assert.ok(catchAt > verifyCallAt);
  const falseCheckAt = src.indexOf("if (!verified)", catchAt);
  assert.ok(falseCheckAt > catchAt, "the false-signature check must be a separate branch, after the catch");
  assert.match(src.slice(catchAt, falseCheckAt), /status: 500/, "a verification throw (PayPal's own outage) must 500 so PayPal retries");
  assert.match(src.slice(falseCheckAt, falseCheckAt + 150), /status: 400/, "a false verification must 400, never retried");
});

test("JSON.parse happens only AFTER verification succeeds", () => {
  const verifyAt = src.indexOf("verifyPaypalWebhook(");
  const parseAt = src.indexOf("JSON.parse(raw)");
  assert.ok(parseAt > verifyAt, "parsing the body before verification would act on an unverified payload");
});

test("all four wired event types have one case each, and an unhandled type is a 200 not an error", () => {
  for (const t of ["PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.REFUNDED", "CUSTOMER.DISPUTE.RESOLVED", "PAYMENT.CAPTURE.REVERSED"]) {
    assert.match(src, new RegExp(`case "${t.replace(/\./g, "\\.")}":`), `missing case for ${t}`);
  }
  assert.match(src, /default:\s*break;/, "an unhandled-but-subscribed type must fall through to a 200, not throw");
});

test("each case calls its own handler, imported from paypalWebhookHandlers", () => {
  const wiring: Array<[string, string]> = [
    ["PAYMENT.CAPTURE.COMPLETED", "onCaptureCompleted"],
    ["PAYMENT.CAPTURE.REFUNDED", "onCaptureRefunded"],
    ["CUSTOMER.DISPUTE.RESOLVED", "onDisputeResolved"],
    ["PAYMENT.CAPTURE.REVERSED", "onCaptureReversed"],
  ];
  for (const [type, fn] of wiring) {
    const caseAt = src.indexOf(`case "${type}":`);
    assert.ok(caseAt >= 0, `case "${type}" not found`);
    const breakAt = src.indexOf("break;", caseAt);
    assert.ok(breakAt > caseAt, `no break; found after case "${type}"`);
    assert.ok(src.slice(caseAt, breakAt + 6).includes(`${fn}(event)`), `case "${type}" must call ${fn}(event)`);
  }
  assert.match(
    src,
    /import \{ onCaptureCompleted, onCaptureRefunded, onDisputeResolved, onCaptureReversed \} from "@\/app\/lib\/paypalWebhookHandlers"/,
  );
});

test("a handler throw inside the switch answers 500 — never a swallowed error", () => {
  const switchAt = src.indexOf("switch (event.event_type)");
  const catchAt = src.indexOf("catch", switchAt);
  assert.ok(catchAt > switchAt, "no try/catch found around the switch");
  assert.match(src.slice(catchAt, catchAt + 300), /status: 500/, "a handler throw must 500 so PayPal retries");
});

test("subscriptions (S3): every BILLING.SUBSCRIPTION.* type reads state through the adapter; each sale type has its own handler", () => {
  for (const t of ["CREATED", "ACTIVATED", "UPDATED", "EXPIRED", "CANCELLED", "SUSPENDED", "PAYMENT.FAILED"]) {
    const at = src.indexOf(`case "BILLING.SUBSCRIPTION.${t}":`);
    assert.ok(at > 0, `missing case for BILLING.SUBSCRIPTION.${t}`);
    assert.ok(src.slice(at, src.indexOf("break;", at)).includes("onPaypalSubscriptionEvent(event)"), `BILLING.SUBSCRIPTION.${t} must reach the adapter`);
  }
  for (const [type, fn] of [
    ["PAYMENT.SALE.COMPLETED", "onPaypalSaleCompleted"],
    ["PAYMENT.SALE.REFUNDED", "onPaypalSaleRefunded"],
    ["PAYMENT.SALE.REVERSED", "onPaypalSaleReversed"],
    ["CUSTOMER.DISPUTE.RESOLVED", "onPaypalSaleDisputeResolved"],
  ] as const) {
    const at = src.indexOf(`case "${type}":`);
    assert.ok(at > 0, `missing case for ${type}`);
    assert.ok(src.slice(at, src.indexOf("break;", at)).includes(`${fn}(event)`), `case "${type}" must call ${fn}(event)`);
  }
  // Inside the try whose catch answers 500: a subscription handler's throw is redelivered.
  const switchAt = src.indexOf("switch (event.event_type)");
  const call = src.indexOf("onPaypalSubscriptionEvent(event)");
  assert.ok(call > switchAt && call < src.indexOf("} catch (e) {", switchAt));
});

test("attack: an unauthenticated POST cannot make the site call PayPal — the cheap header/cert check answers 400 before the body is read or verify is asked", () => {
  const gate = src.indexOf("if (!plausiblePaypalDelivery(req.headers))");
  assert.ok(gate > src.indexOf("paypalWebhookConfigured()"), "after the configuration gate");
  assert.ok(gate < src.indexOf("req.text()") && gate < src.indexOf("verifyPaypalWebhook("), "before the body and the verify call");
  assert.match(src.slice(gate, gate + 300), /status: 400/);
});

test("the raw body is never logged", () => {
  assert.doesNotMatch(src, /console\.(?:error|warn|log)\([^)]*\braw\b/, "a log statement references the raw webhook body");
});
