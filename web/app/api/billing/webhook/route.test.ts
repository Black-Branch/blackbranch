// Wiring guard — route.ts cannot be executed under node --test (the @/lib/db
// alias). Pins that each new event type has a case calling the right
// handler, inside the existing try/catch that 500s on any throw.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "../../../lib/testSource.ts";

const raw = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
const src = stripComments(raw);

test("route.ts is whole — vacuity anchor for the positive assertions below", () => {
  assert.ok(raw.trimEnd().endsWith("}"), "webhook/route.ts truncated — pins below are vacuous");
});

test("the six new event types are handled, one case each", () => {
  for (const type of [
    "payment_intent.payment_failed", "refund.created", "refund.updated",
    "charge.dispute.created", "charge.dispute.closed", "invoice.payment_failed",
  ]) {
    assert.match(src, new RegExp(`case "${type.replace(/\./g, "\\.")}":`), `missing case for ${type}`);
  }
});

test("each new case calls its handler", () => {
  const wiring: Array<[string, string]> = [
    ["payment_intent.payment_failed", "handlePaymentFailed"], ["refund.created", "handleRefund"],
    ["refund.updated", "handleRefund"], ["charge.dispute.created", "handleDispute"],
    ["charge.dispute.closed", "handleDispute"], ["invoice.payment_failed", "handleInvoicePaymentFailed"],
  ];
  for (const [type, fn] of wiring) {
    const caseAt = src.indexOf(`case "${type}":`);
    assert.ok(caseAt >= 0, `case "${type}" not found`);
    // Bound the scope at the first `break;` after the case label, not the
    // next `case `: a case that falls through to a sibling (refund.created →
    // refund.updated, charge.dispute.created → charge.dispute.closed) has its
    // handler call AFTER that next case label, so bounding there would cut
    // the call out of scope and false-fail a correctly wired fallthrough.
    const breakAt = src.indexOf("break;", caseAt);
    assert.ok(breakAt > caseAt, `no break; found after case "${type}"`);
    const scope = src.slice(caseAt, breakAt + 6);
    assert.ok(scope.includes(`${fn}(event)`), `case "${type}" must call ${fn}(event)`);
  }
});

test("the four new handlers are imported from paymentEventHandlers", () => {
  assert.match(
    src,
    /import \{[^}]*handlePaymentFailed[^}]*handleRefund[^}]*handleDispute[^}]*handleInvoicePaymentFailed[^}]*\} from "@\/app\/lib\/paymentEventHandlers"/
  );
});

test("the new cases sit inside the try/catch that 500s on any handler throw", () => {
  const tryAt = src.indexOf("try {");
  const catchAt = src.indexOf("} catch (e) {");
  const lastCaseAt = src.lastIndexOf('case "invoice.payment_failed":');
  assert.ok(tryAt >= 0 && catchAt > tryAt);
  assert.ok(lastCaseAt > tryAt && lastCaseAt < catchAt, "the new cases must be inside the existing try");
  assert.match(src.slice(catchAt), /status: 500/, "handler errors must still 500 so Stripe retries");
});

test("recordDonation credits the tip BEFORE the donations INSERT: a retry must finish a missed credit and must never be stopped from reaching the announce path by the INSERT's replay guard", () => {
  const fnAt = src.indexOf("async function recordDonation(");
  assert.ok(fnAt >= 0, "recordDonation not found — the pins below are vacuous");
  const creditAt = src.indexOf("moneyCredits.recordTipCredit(", fnAt);
  const insertAt = src.indexOf("INSERT INTO site.donations", fnAt);
  assert.ok(creditAt >= 0, "recordDonation must call moneyCredits.recordTipCredit");
  assert.ok(insertAt >= 0, "recordDonation must still INSERT INTO site.donations");
  assert.ok(creditAt < insertAt, "the tip credit must be ordered before the donations INSERT, not after");
});
