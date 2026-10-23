// The renewal guards are RUN here — the webhook route cannot be loaded under
// node --test (pg + Stripe at import), so the decision lives in subRenewal.ts.
//
// Run: node --test app/lib/subRenewal.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { renewalFromInvoice, tenureMonths } from "./subRenewal.ts";

type RenewalInvoiceLike = Parameters<typeof renewalFromInvoice>[0];

const cycle: RenewalInvoiceLike = {
  id: "in_1",
  billing_reason: "subscription_cycle",
  amount_paid: 500,
  currency: "usd",
  customer: "cus_1",
  parent: { subscription_details: { subscription: "sub_1" } },
};

test("a subscription_cycle invoice with money paid is a renewal", () => {
  assert.deepEqual(renewalFromInvoice(cycle), {
    invoiceId: "in_1", subscriptionId: "sub_1", customerId: "cus_1", amount: 500, currency: "usd",
  });
});

test("the FIRST invoice is not a renewal — customer.subscription.created already credits it", () => {
  assert.equal(renewalFromInvoice({ ...cycle, billing_reason: "subscription_create" }), null,
    "taking subscription_create here would credit the bar twice for one payment");
  assert.equal(renewalFromInvoice({ ...cycle, billing_reason: "subscription_update" }), null, "a proration is not a renewal");
  assert.equal(renewalFromInvoice({ ...cycle, billing_reason: "manual" }), null);
  assert.equal(renewalFromInvoice({ ...cycle, billing_reason: null }), null);
});

test("a $0 cycle funds nothing", () => {
  assert.equal(renewalFromInvoice({ ...cycle, amount_paid: 0 }), null);
  assert.equal(renewalFromInvoice({ ...cycle, amount_paid: -1 }), null);
});

test("the subscription id is read from parent.subscription_details, expanded or not", () => {
  assert.equal(renewalFromInvoice({ ...cycle, parent: { subscription_details: { subscription: { id: "sub_x" } } } })?.subscriptionId, "sub_x");
  assert.equal(renewalFromInvoice({ ...cycle, parent: null }), null, "no subscription → not a renewal we can attribute");
  assert.equal(renewalFromInvoice({ ...cycle, parent: { subscription_details: null } }), null);
  assert.equal(renewalFromInvoice({ ...cycle, customer: { id: "cus_o" } })?.customerId, "cus_o");
  assert.equal(renewalFromInvoice({ ...cycle, customer: null })?.customerId, null);
});

test("tenure floors at two — a cycle invoice means the first AND this one were paid", () => {
  assert.equal(tenureMonths(0), 2, "a failed listing must not announce a renewal as '1 month'");
  assert.equal(tenureMonths(1), 2);
  assert.equal(tenureMonths(2), 2);
  assert.equal(tenureMonths(7), 7);
  assert.equal(tenureMonths(NaN), 2);
});

// A subscription that started with a trial (a card bought during a gift: checkout's trial_end) has a
// $0 "paid" trial invoice first, and its first REAL charge is a subscription_cycle invoice — so a
// cycle invoice means only that this one was paid, and the trial invoice is not a month.
test("tenure after a trial: the $0 trial invoice is not a month, and the first charge is month one", () => {
  assert.equal(tenureMonths(2, true), 1, "trial invoice + first charge = 1 month");
  assert.equal(tenureMonths(3, true), 2);
  assert.equal(tenureMonths(0, true), 1, "a failed listing still announces month one, never 0");
  assert.equal(tenureMonths(NaN, true), 1);
  assert.equal(tenureMonths(2, false), 2, "no trial: unchanged");
});
