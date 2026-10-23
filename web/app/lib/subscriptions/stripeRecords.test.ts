// The Stripe mapping's end of access (spec §3.4; security review 2026-10-21, finding 4), run.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Stripe from "stripe";
import { stripeObservation, stripeRenewalOff } from "./stripeRecords.ts";
import { GRACE_DAYS } from "./grace.ts";

const sub = (cpe: number | null, status = "active") => ({
  id: "sub_gadget", status, customer: "cus_gadget", cancel_at_period_end: false,
  items: { data: [{ price: { id: "price_x" }, ...(cpe ? { current_period_end: cpe } : {}) }] },
}) as unknown as Stripe.Subscription;

test("attack: a lost customer.subscription.deleted cannot leave access open for ever — a Stripe record ends at its period end + the grace days", () => {
  const end = Date.parse("2026-11-03T00:00:00Z");
  const o = stripeObservation(sub(end / 1000), new Date());
  assert.equal(o.accessUntil?.getTime(), end + GRACE_DAYS * 86_400_000);
  // Each renewal moves the period end, and with it the access.
  const next = Date.parse("2026-12-03T00:00:00Z");
  assert.equal(stripeObservation(sub(next / 1000), new Date()).accessUntil?.getTime(), next + GRACE_DAYS * 86_400_000);
  // No period end known: status alone decides, as before.
  assert.equal(stripeObservation(sub(null), new Date()).accessUntil, null);
});

test("migrate-v163 brings the records written before this to the same rule, with the same grace", () => {
  const sql = readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "migrations", "migrate-v163.sql"), "utf8");
  assert.match(sql, new RegExp(`SET access_until = period_end \\+ interval '${GRACE_DAYS} days'`));
  assert.match(sql, /WHERE provider = 'stripe' AND access_until IS NULL AND period_end IS NOT NULL;/);
});

// Stripe's newer customer portal "cancel at period end" sets `cancel_at` (+ `canceled_at`) and leaves
// `cancel_at_period_end` FALSE (2026-10-21: a viewer who had switched renewal off was told "Renews on
// Oct 26"). Either field means renewal is off.
const cancelAtFixture = () => JSON.parse(readFileSync(
  join(import.meta.dirname, "..", "..", "api", "billing", "__fixtures__", "stripe", "subscription.cancel_at.json"), "utf8",
)) as Stripe.Subscription;

test("a subscription with cancel_at set (cancel_at_period_end false) does not renew", () => {
  const s = cancelAtFixture();
  assert.equal(s.cancel_at_period_end, false, "the fixture is the portal's newer shape");
  assert.ok(s.cancel_at, "…which carries cancel_at");
  assert.equal(stripeRenewalOff(s), true);
  const o = stripeObservation(s, new Date());
  assert.equal(o.renews, false);
  assert.equal(o.status, "active", "access continues until the period ends");
});

test("renewal off by either field; on only when neither is set", () => {
  const base = sub(1_900_000_000);
  assert.equal(stripeRenewalOff(base), false);
  assert.equal(stripeObservation(base, new Date()).renews, true);
  const legacy = { ...base, cancel_at_period_end: true } as Stripe.Subscription;
  assert.equal(stripeRenewalOff(legacy), true);
  assert.equal(stripeObservation(legacy, new Date()).renews, false);
  const nulled = { ...base, cancel_at: null } as unknown as Stripe.Subscription;
  assert.equal(stripeRenewalOff(nulled), false, "an explicit null cancel_at is not a cancellation");
});

// Design review 2026-10-22: a cancel date BEYOND the current period end means the subscription still
// renews once first (a cancellation scheduled for a later period) — only a cancel date at or before
// the current period end means "this period is the last".
const fixture = (name: string) => JSON.parse(readFileSync(
  join(import.meta.dirname, "..", "..", "api", "billing", "__fixtures__", "stripe", name), "utf8",
)) as Stripe.Subscription;

test("a cancel_at beyond the current period end still renews once first", () => {
  const s = fixture("subscription.cancel_at_beyond_period.json");
  const cpe = (s.items.data[0] as unknown as { current_period_end: number }).current_period_end;
  assert.ok(s.cancel_at! > cpe, "the fixture cancels after the current period");
  assert.equal(stripeRenewalOff(s), false);
  assert.equal(stripeObservation(s, new Date()).renews, true);
});

test("a cancel_at at or before the current period end is renewal off; with no known period end, it counts", () => {
  const at = (cancelAt: number, cpe: number | null) => ({ ...sub(cpe), cancel_at: cancelAt }) as unknown as Stripe.Subscription;
  assert.equal(stripeRenewalOff(at(1_900_000_000, 1_900_000_000)), true, "equal = this period is the last");
  assert.equal(stripeRenewalOff(at(1_899_000_000, 1_900_000_000)), true, "before = ends mid-period");
  assert.equal(stripeRenewalOff(at(1_900_000_001, 1_900_000_000)), false, "after = renews once more");
  assert.equal(stripeRenewalOff(at(1_900_000_000, null)), true, "no period end to compare: a scheduled cancellation reads as renewal off");
});
