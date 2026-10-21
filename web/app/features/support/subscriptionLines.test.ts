// The Support panel's subscription words (spec §10.1, §10.2), against fixed dates.
import test from "node:test";
import assert from "node:assert/strict";
import { recordLine, isLiveRecord, elsewhereWarning, type SubscriptionRecordView } from "./subscriptionLines.ts";

const NOW = new Date("2026-10-20T12:00:00Z");
const fmt = (d: Date) => d.toISOString().slice(0, 10);
const rec = (over: Partial<SubscriptionRecordView>): SubscriptionRecordView => ({
  provider: "paypal", tier: "supporter", status: "active", renews: true,
  periodEnd: "2026-11-03T00:00:00Z", accessUntil: "2026-11-10T00:00:00Z", ...over,
});
const line = (over: Partial<SubscriptionRecordView>) => recordLine(rec(over), NOW, fmt);

test("PayPal lines: renews / ends / retrying / paused / waiting", () => {
  assert.deepEqual(line({}), { service: "PayPal", text: "Active · renews 2026-11-03", ending: false });
  assert.deepEqual(line({ renews: false, accessUntil: "2026-11-03T00:00:00Z" }), { service: "PayPal", text: "Ends 2026-11-03", ending: true });
  assert.equal(line({ status: "past_due" })?.text, "PayPal is retrying a payment");
  assert.equal(line({ status: "paused" })?.text, "Paused by PayPal");
  assert.equal(line({ status: "pending" })?.text, "Waiting for PayPal to confirm the first payment");
});

test("Card lines use the card's own words", () => {
  assert.deepEqual(line({ provider: "stripe", accessUntil: null }), { service: "Card", text: "Active · renews 2026-11-03", ending: false });
  assert.equal(line({ provider: "stripe", status: "past_due", accessUntil: null })?.text, "Payment due");
});

test("what is not live is not listed: ended, access run out, an abandoned PayPal popup", () => {
  assert.equal(line({ status: "ended" }), null);
  assert.equal(line({ accessUntil: "2026-10-19T00:00:00Z" }), null);
  assert.equal(line({ status: "pending", renews: false }), null);
  assert.equal(isLiveRecord(rec({ status: "paused" }), NOW), true);
});

test("the paying-twice warning names the service and, when known, when it renews", () => {
  assert.equal(elsewhereWarning({ provider: "patreon", periodEnd: "2026-11-03T00:00:00Z" }, fmt),
    "You’re already a Supporter through Patreon (renews 2026-11-03). Subscribing here is a second, separate subscription — you’d be paying twice.");
  assert.match(elsewhereWarning({ provider: "stripe", periodEnd: null }, fmt), /^You’re already a Supporter through a card subscription\. /);
  assert.match(elsewhereWarning({ provider: "paypal", periodEnd: null }, fmt), /through PayPal\./);
});
