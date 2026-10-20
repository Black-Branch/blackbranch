// checkoutRequestFor — the ONE place a TipDraft becomes a card-checkout
// request (Qorm-for-all-income piece 3). Every host posts through it, so the
// tip/quiet routing and the "a quiet buy sends only the amount" rule live in
// one function.
//
// Run: node --test app/features/support/tipCheckout.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { checkoutRequestFor } from "./tipCheckout.ts";

test("announce on → the tip route, with message/name/anonymous", () => {
  assert.deepEqual(
    checkoutRequestFor({ amount: 5, message: " hi ", displayName: "Kay", anonymous: false, announce: true }),
    { endpoint: "/api/billing/donate", body: { amount: 5, message: "hi", displayName: "Kay", anonymous: false } },
  );
});

test("announce on with a blank message sends message: undefined (today's donate body)", () => {
  assert.equal(
    checkoutRequestFor({ amount: 5, message: "   ", displayName: "", anonymous: true, announce: true }).body.message,
    undefined,
  );
});

test("announce off → the coins route, and the body is EXACTLY { amount } — no name or message leaks", () => {
  assert.deepEqual(
    checkoutRequestFor({ amount: 12.5, message: "should not travel", displayName: "Real Name", anonymous: false, announce: false }),
    { endpoint: "/api/billing/points", body: { amount: 12.5 } },
  );
});
