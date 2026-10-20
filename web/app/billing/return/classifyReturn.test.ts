import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyReturn } from "./classifyReturn.ts";

test("complete + paid: received", () => { assert.match(classifyReturn("complete", "paid").heading, /Payment received/); });
test("complete + no_payment_required: received", () => { assert.match(classifyReturn("complete", "no_payment_required").heading, /Payment received/); });
test("complete + unpaid: processing, not received", () => {
  const r = classifyReturn("complete", "unpaid");
  assert.match(r.heading, /Processing/);
  assert.match(r.body, /still confirming/);
});
test("open: unchanged", () => {
  const r = classifyReturn("open", null);
  assert.match(r.heading, /not completed/);
  assert.match(r.body, /nothing was charged/);
});
test("expired: unchanged", () => { assert.match(classifyReturn("expired", null).heading, /expired/); });
test("unknown: no longer falsely reassures", () => {
  const r = classifyReturn("unknown", null);
  assert.ok(!r.body.includes("it will still be recorded"));
  assert.match(r.body, /couldn.t look this payment up/i);
  assert.match(r.body, /if it went through/i);
  assert.match(r.body, /if it didn.t, nothing was taken/i);
});
