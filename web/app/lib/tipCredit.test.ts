import test from "node:test";
import assert from "node:assert/strict";
import { tipCreditFromSession } from "./tipCredit.ts";

const cs = (over: Record<string, unknown> = {}) => ({
  id: "cs_1", payment_status: "paid", amount_total: 500, currency: "usd",
  payment_intent: "pi_1", metadata: { kind: "donation", matrix_id: "@a:site.test", amount_cents: "500" },
  ...over,
}) as never;

test("a signed-in paid USD tip credits its cents, keyed on the session, found by its payment intent", () => {
  assert.deepEqual(tipCreditFromSession(cs()), {
    matrixId: "@a:site.test", cents: 500, ref: "stripe:cs_1",
    payment: { provider: "stripe", paymentIntent: "pi_1" },
  });
});
test("a guest tip credits nothing", () => {
  assert.equal(tipCreditFromSession(cs({ metadata: { kind: "donation", matrix_id: "" } })), null);
});
test("an anonymous tip still credits the payer", () => {
  assert.ok(tipCreditFromSession(cs({ metadata: { kind: "donation", matrix_id: "@a:site.test", anonymous: "1", amount_cents: "500" } })));
});
test("an unpaid session credits nothing", () => {
  assert.equal(tipCreditFromSession(cs({ payment_status: "unpaid" })), null);
});
test("a non-USD settlement never credits more than the USD cents chosen", () => {
  const r = tipCreditFromSession(cs({ currency: "jpy", amount_total: 75000 }));
  assert.equal(r?.cents, 500);
});
test("a non-USD settlement with no recorded USD intent credits nothing (never guess)", () => {
  assert.equal(tipCreditFromSession(cs({ currency: "jpy", amount_total: 75000, metadata: { kind: "donation", matrix_id: "@a:site.test" } })), null);
});
test("no payment intent → no credit (a refund could never find it)", () => {
  assert.equal(tipCreditFromSession(cs({ payment_intent: null })), null);
});
